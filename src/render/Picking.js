import { POINT_VERTEX, POINT_PICKING_FRAGMENT } from './shaders.js'

// Picking GPU no-bloqueante: micro-FBO + lectura diferida por PBO/fenceSync (WebGL2).
// Comparte el buffer de vértices de glify — el programa de picking se linkea con los MISMOS
// índices de atributo (bindAttribLocation) que el visual, así reusa el vertexAttribPointer que
// glify ya dejó montado: no re-bindea buffer ni vertexAttribPointer. Un bufferSubData al buffer
// actualiza visual y picking a la vez (§17.5). Cada draw declara su textura; la que se captura en
// attach es la que hay que dejar bindeada al salir, y es estable (un solo objeto reusado por el
// binding incluso en regrow) → capturarla una vez no produce staleness.
//
// El id que devuelve el pase es JERÁRQUICO y entra en los 32 bits del píxel: objeto (14) y chunk (6)
// por draw, índice local (12) por vértice. El local lleva un +1 en el packer, así que el valor 0
// significa «toqué el objeto, pero no una entrada» y el objeto 0 significa «nada».
//
// El pase recibe un BATCH de draws —un clear, N draws, un readPixels— porque el chunk es uniform y
// exige un draw por chunk. Sin DEPTH_TEST gana el píxel el ÚLTIMO draw emitido: el orden del batch
// ES el orden de precedencia.
//
// @typedef {{ bind: () => void, texture: WebGLTexture|null, mode: GLenum, first: number,
//             count: number, obj: number, chunk: number }} PickDraw
// @typedef {{ draws: PickDraw[], length: number, matrix: Float32Array }} PickBatch

const PATCH = 6
const HALF  = PATCH >> 1

export const OBJ_BITS   = 14
export const CHUNK_BITS = 6
export const LOCAL_BITS = 12

// Índices del parche ordenados por distancia al texel del cursor —que con el viewport trasladado es
// SIEMPRE (HALF, HALF), incluso pegado al borde del canvas—: así el primer impacto del barrido es el
// más cercano al puntero y la ambigüedad entre vecinos se resuelve sin comparar nada.
const ORDER = (() => {
  const idx = new Uint8Array(PATCH * PATCH)
  for (let i = 0; i < idx.length; i++) idx[i] = i
  const dist = i => {
    const col = (i % PATCH) - HALF
    const row = ((i / PATCH) | 0) - HALF
    return col * col + row * row
  }
  return idx.sort((a, b) => dist(a) - dist(b))
})()

const TAG = new Float32Array(3)

// Tag del draw ya normalizado a bytes: R += x, B = y, A = z. Devuelve un scratch REUSADO — se llama
// por draw, en ruta caliente.
export const packTag = (obj, chunk) => {
  TAG[0] = ((chunk & 15) << 4) / 255
  TAG[1] = ((chunk >> 4) | ((obj & 63) << 2)) / 255
  TAG[2] = (obj >> 6) / 255
  return TAG
}

// Impactos de un pick, del texel más cercano al cursor hacia afuera. Instancia REUSADA: válida hasta
// el próximo collect()/pickSync(). Sin dedup: el consumidor corta en la primera entrada que le sirve
// y dedupear destruiría el orden, que es justamente la desambiguación entre vecinos.
export class PickHits {

  objects = new Uint16Array(PATCH * PATCH)   // 1..16383
  chunks  = new Uint8Array(PATCH * PATCH)    // 0..63
  slots   = new Int32Array(PATCH * PATCH)    // índice local de la entrada; -1 = objeto sin entrada
  count   = 0

  // Índice de la primera entrada del objeto (acotada al chunk si se pasa), o -1. Barrido lineal
  // sobre ≤36: más barato que cualquier estructura que hubiera que armar por pick.
  firstOf(obj, chunk) {
    for (let i = 0; i < this.count; i++)
      if (this.objects[i] === obj && (chunk === undefined || this.chunks[i] === chunk)) return i
    return -1
  }
}

export class Picking {

  #gl            = null
  #program       = null
  #target        = null   // destino de picking — { framebuffer, color }, de PATCH×PATCH y sin depth
  #pbo           = null
  #buf           = new Uint8Array(PATCH * PATCH * 4)
  #hits          = new PickHits()
  #atlasTexture  = null
  #attrLocs      = []
  #uMatrix       = null
  #uPickTag      = null
  #blend         = false
  #flight        = { active: false, fence: null, metadata: null }
  #queued        = { active: false, cx: 0, cy: 0, batch: null, metadata: null }
  #result        = { hits: null, metadata: null }   // reusado por pick, como los hits que envuelve
  #visualProgram = null   // programa visual de glify → se restaura tras el pick (glify dibuja con él, sin re-useProgram)

  get ready() { return !!this.#gl }
  get program() { return this.#program }
  get pending() { return this.#flight.active }
  get busy() { return this.#flight.active || this.#queued.active }

  // Devuelve el programa de picking para que el binding del atlas le setee sus dims-uniforms.
  attach(gl, visualProgram, atlasTexture) {
    this.#gl            = gl
    this.#atlasTexture  = atlasTexture
    this.#visualProgram = visualProgram
    this.#createTarget()
    this.#compile(visualProgram)
    this.#pbo = gl.createBuffer()
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.#pbo)
    gl.bufferData(gl.PIXEL_PACK_BUFFER, this.#buf.byteLength, gl.STREAM_READ)
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
    return this.#program
  }

  // Pick asíncrono: dibuja el parche y agenda la lectura; collect() la recoge sin bloquear. Con un
  // pick en vuelo el pedido nuevo PISA al pendiente (mailbox de un slot) y se dispara al liberarse
  // el vuelo: con el cursor en movimiento sólo la última muestra tiene valor, y descartarla dejaría
  // el hover clavado en la posición vieja hasta que el usuario frene. El batch se guarda por
  // REFERENCIA: la capa lo mantiene vigente hasta el disparo, o llama abort() si lo reconstruye.
  request(cx, cy, batch, metadata) {
    if (!this.#gl || !this.#program) return false
    if (!this.#flight.active) return this.#issue(cx, cy, batch, metadata)
    const q = this.#queued
    q.active   = true
    q.cx       = cx
    q.cy       = cy
    q.batch    = batch
    q.metadata = metadata
    return true
  }

  // Sondea la lectura en vuelo (timeout 0 → no bloquea). null si aún no está lista.
  collect() {
    const gl = this.#gl
    const f  = this.#flight
    if (!gl || !f.active) return null
    const status = gl.clientWaitSync(f.fence, 0, 0)
    if (status === gl.TIMEOUT_EXPIRED) return null
    gl.deleteSync(f.fence)
    f.active = false
    f.fence  = null
    // Vaciar el mailbox también acá: un fence perdido lo dejaría trabado para siempre.
    if (status === gl.WAIT_FAILED) { this.#flush(); return null }
    // La copia va ANTES del flush: el pedido encolado hace readPixels sobre EL MISMO PBO.
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.#pbo)
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this.#buf, 0, this.#buf.length)
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
    const result = this.#deliver(f.metadata)
    this.#flush()
    return result
  }

  // Pick síncrono (click): lectura bloqueante directa.
  pickSync(cx, cy, batch, metadata) {
    const gl = this.#gl
    if (!gl || !this.#program) return null
    this.#begin(cx, cy, batch)
    gl.readPixels(0, 0, PATCH, PATCH, gl.RGBA, gl.UNSIGNED_BYTE, this.#buf)
    this.#restore()
    return this.#deliver(metadata)
  }

  // Invalidación completa: cancela el vuelo y vacía el mailbox.
  abort() {
    const f = this.#flight
    if (f.active) { this.#gl.deleteSync(f.fence); f.active = false; f.fence = null }
    this.#queued.active = false
  }

  // El destino mide PATCH×PATCH: no depende del tamaño del drawing buffer.
  syncSize() {}

  detach() {
    const gl = this.#gl
    if (!gl) return
    this.abort()
    const t = this.#target
    if (t) {
      gl.deleteFramebuffer(t.framebuffer)
      gl.deleteRenderbuffer(t.color)
    }
    gl.deleteBuffer(this.#pbo)
    this.#gl = null
  }

  #issue(cx, cy, batch, metadata) {
    const gl = this.#gl
    this.#begin(cx, cy, batch)
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.#pbo)
    gl.readPixels(0, 0, PATCH, PATCH, gl.RGBA, gl.UNSIGNED_BYTE, 0)
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
    const f = this.#flight
    f.fence    = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)
    f.metadata = metadata
    f.active   = true
    gl.flush()
    this.#restore()
    return true
  }

  #flush() {
    const q = this.#queued
    if (!q.active) return
    q.active = false
    this.#issue(q.cx, q.cy, q.batch, q.metadata)
  }

  #deliver(metadata) {
    const result = this.#result
    result.hits     = this.#decode()
    result.metadata = metadata
    return result
  }

  // El parche se centra en el cursor TRASLADANDO el viewport, no la proyección: escalar la matriz al
  // recuadro achicaría el volumen de clip, y GL descarta el punto entero si su CENTRO cae afuera —
  // un sprite grande centrado fuera del parche, que hoy sí cubre el píxel del cursor, dejaría de
  // pickearse. La traslación conserva el clip y la escala NDC→píxel (y con ella gl_PointSize), y lo
  // que antes recortaba el scissor ahora lo recorta el borde del framebuffer.
  #begin(cx, cy, batch) {
    const gl = this.#gl
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight
    const ox = Math.round(cx) - HALF
    const oy = h - Math.round(cy) - HALF
    this.#blend = gl.getParameter(gl.BLEND)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.#target.framebuffer)
    gl.viewport(-ox, -oy, w, h)
    gl.disable(gl.BLEND)                    // los 4 canales se escriben literales: el word 0 es exacto
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.useProgram(this.#program)
    gl.activeTexture(gl.TEXTURE0)
    if (this.#uMatrix) gl.uniformMatrix4fv(this.#uMatrix, false, batch.matrix)
    for (let i = 0; i < this.#attrLocs.length; i++) gl.enableVertexAttribArray(this.#attrLocs[i])
    const uTag  = this.#uPickTag
    const draws = batch.draws
    let tex = null
    for (let k = 0; k < batch.length; k++) {
      const d = draws[k]
      if (!d.obj) continue                  // objeto 0 = «nada»: emitirlo haría ilegible todo el pase
      d.bind()
      if (d.texture && d.texture !== tex) { tex = d.texture; gl.bindTexture(gl.TEXTURE_2D, tex) }
      if (uTag) gl.uniform3fv(uTag, packTag(d.obj, d.chunk))
      gl.drawArrays(d.mode, d.first, d.count)
    }
  }

  #restore() {
    const gl = this.#gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    this.#blend ? gl.enable(gl.BLEND) : gl.disable(gl.BLEND)
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight)
    gl.useProgram(this.#visualProgram)      // restaurar el programa visual de glify (dibuja sin re-useProgram)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.#atlasTexture)
  }

  // RGBA → PickHits. Vacío = las cuatro componentes en 0 (el clear); el alpha por sí solo ya no
  // alcanza, porque el objeto va repartido entre B y A y todo objeto < 64 deja el alpha en 0.
  #decode() {
    const buf  = this.#buf
    const hits = this.#hits
    hits.count = 0
    for (let k = 0; k < ORDER.length; k++) {
      const i = ORDER[k] << 2
      const r = buf[i], g = buf[i + 1], b = buf[i + 2], a = buf[i + 3]
      if ((r | g | b | a) === 0) continue
      const n = hits.count++
      hits.objects[n] = (b >> 2) | (a << 6)
      hits.chunks[n]  = (r >> 4) | ((b & 3) << 4)
      hits.slots[n]   = (((r & 15) << 8) | g) - 1
    }
    return hits
  }

  // Renderbuffer y no textura: un renderbuffer no se puede bindear a una unidad de textura, así que
  // desaparece el riesgo de dejarlo colgado en TEXTURE0 y que el próximo draw de glify (p. ej. el
  // redraw del zoom) salga en blanco. Sin depth: el pase nunca habilita DEPTH_TEST y sólo dibuja
  // POINTS — nadie escribe ni lee profundidad.
  #createTarget() {
    const gl = this.#gl
    const prevRbo = gl.getParameter(gl.RENDERBUFFER_BINDING)
    const prevFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING)
    const color = gl.createRenderbuffer()
    gl.bindRenderbuffer(gl.RENDERBUFFER, color)
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, PATCH, PATCH)
    const framebuffer = gl.createFramebuffer()
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, color)
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo)
    gl.bindRenderbuffer(gl.RENDERBUFFER, prevRbo)
    this.#target = { framebuffer, color }
  }

  #compile(visualProgram) {
    const gl = this.#gl
    const vs = gl.createShader(gl.VERTEX_SHADER)
    gl.shaderSource(vs, POINT_VERTEX); gl.compileShader(vs)
    const fs = gl.createShader(gl.FRAGMENT_SHADER)
    gl.shaderSource(fs, POINT_PICKING_FRAGMENT); gl.compileShader(fs)
    const program = gl.createProgram()
    gl.attachShader(program, vs)
    gl.attachShader(program, fs)
    // Mismos índices de atributo que el visual → reusa el vertexAttribPointer montado por glify.
    this.#attrLocs = []
    for (const name of ['vertex', 'color', 'pointSize']) {
      const loc = gl.getAttribLocation(visualProgram, name)
      if (loc >= 0) { gl.bindAttribLocation(program, loc, name); this.#attrLocs.push(loc) }
    }
    gl.linkProgram(program)
    this.#program  = program
    this.#uMatrix  = gl.getUniformLocation(program, 'matrix')
    this.#uPickTag = gl.getUniformLocation(program, 'uPickTag')
  }
}
