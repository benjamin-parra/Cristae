// Los handles de la geometría editable como SPRITES: un draw POINTS por chunk sobre el VBO del arena,
// con los mismos shaders y el mismo pase jerárquico que la capa de puntos. Vértice y midpoint entran en
// el MISMO draw —el arena los entrelaza y la paridad del local es el kind—, así que un trazo de N
// vértices cuesta ceil(2N/cap) draws y CERO nodos DOM.
//
// El vecindario que el banco DOM promueve no se apaga escribiendo el VBO: se apaga abriendo AGUJEROS en
// el rango de cada draw VISUAL, derivados por frame de la promoción vigente. Que el apagado no sea estado
// residente vuelve irrepresentable el sprite «pegado» —un chunk culleado no dibuja, y al volver a la
// vista su rango se arma de cero, sin nada que restaurar—.
//
// El agujero es del VISUAL y sólo de él: el PASE recorre el run entero. El nodo del banco es afordancia
// —`pointer-events: none` y cero listeners, nunca pickea—, así que el pase es lo ÚNICO que sabe
// direccionar al promovido; sacarlo de ahí lo vuelve inagarrable y realimenta al hover, que lo despromueve
// para volver a encontrarlo en el frame siguiente.
import { GpuAtlasBinding } from '../atlas/GpuAtlasBinding.js'
import { defineIconSet } from '../atlas/IconSet.js'
import { ROLE } from '../geometry/ChunkedPath.js'
import { CHUNK_BITS } from './Picking.js'
import { POINT_FRAGMENT, POINT_VERTEX } from './shaders.js'

// El pase direcciona el chunk con 6 bits: de acá en adelante el ordinal no es representable.
const ORDINAL_CAP = 1 << CHUNK_BITS

// Layout de vértice de glify: [x, y, tile, angle, b, a, size].
const STRIDE = 28
const ATTRS  = [
  { name: 'vertex',    size: 2, offset: 0 },
  { name: 'color',     size: 4, offset: 8 },
  { name: 'pointSize', size: 1, offset: 24 },
]

// Variante y tamaño en pantalla por ROL. El rol `free` es el midpoint inactivo del último vértice de un
// trazo abierto: el tile TRANSPARENTE lo saca del visual y del picking a la vez, sin excepción en el batch.
const ROLE_VARIANT = ['off', 'vertex', 'midpoint']
const ROLE_SIZE    = [10, 12, 10]
const MAX_SIZE     = Math.max(...ROLE_SIZE)

// prev, v y next: tres vecinos que pueden vivir en tres chunks distintos.
const HOLES  = 3
const porRef = (a, b) => a.from - b.from
const vaciar = h => { h.chunk = -1; h.from = Infinity; h.to = Infinity }

const trazar = (ctx, size, d) => {
  ctx.fillStyle = d.fill
  ctx.fill()
  ctx.lineWidth = size * 0.08
  ctx.strokeStyle = d.line
  ctx.stroke()
}

const nodo = (ctx, size, d) => {
  const lado = size * d.radio
  ctx.beginPath()
  ctx.rect((size - lado) / 2, (size - lado) / 2, lado, lado)
  trazar(ctx, size, d)
}

const disco = (ctx, size, d) => {
  ctx.beginPath()
  ctx.arc(size / 2, size / 2, size * d.radio, 0, Math.PI * 2)
  trazar(ctx, size, d)
}

// IconSet de edición: chico, cerrado y propio de esta capa. `hover` y `grabbing` no los dibuja la GPU
// —el handle bajo el dedo ya está promovido a DOM—: el banco los reusa por `iconSet.sprite(variante)`,
// así el nodo promovido muestra los MISMOS píxeles que el sprite al que reemplaza.
const editIconSet = (color, accent) => {
  const descriptores = {
    off      : { shape: 'nada' },
    vertex   : { shape: 'nodo',  radio: 0.44, fill: '#ffffff', line: color },
    midpoint : { shape: 'disco', radio: 0.24, fill: '#ffffff', line: color },
    hover    : { shape: 'nodo',  radio: 0.52, fill: accent,    line: '#ffffff' },
    grabbing : { shape: 'nodo',  radio: 0.44, fill: color,     line: '#ffffff' },
  }
  return defineIconSet({
    variants  : Object.keys(descriptores),
    sizes     : { canvas: 32, default: MAX_SIZE },
    // TOTAL por construcción: lo que no está declarado no se pinta.
    describe  : variant => descriptores[variant] ?? descriptores.off,
    renderers : { nodo, disco, nada: () => {} },
  })
}

// UNO por configuración, memoizado por módulo: se instancia por EDITOR y sus cinco tiles viven tanto como
// el atlas que los guarda, así que montar y destruir editores los iría acumulando. Compartirlo es seguro
// —el atlas es de sólo lectura y cada contexto GL tiene su propio binding, que es el multi-mapa de siempre—.
const SETS = new Map()

export const defineEditIconSet = ({ color = '#2563eb', accent = '#f59e0b' } = {}) => {
  const clave = `${color} ${accent}`
  return SETS.get(clave) ?? SETS.set(clave, editIconSet(color, accent)).get(clave)
}

// Canales del arena por ROL: el tile ya normalizado por la capacidad del atlas, y el tamaño en pantalla.
// El set de edición es CERRADO (cinco variantes en una capacidad de dieciséis), así que nunca hay regrow
// y el canal de un rol no se mueve bajo los datos ya escritos.
//
// `scale` lleva el tamaño a píxeles del FRAMEBUFFER, que es la unidad de `gl_PointSize`: sobre una
// superficie a DPR el handle mediría la mitad de lo que declara —y el pase, que comparte el atributo, la
// misma mitad—, mientras el nodo que lo releva en el banco DOM sigue midiendo lo declarado.
export const editHandleChannels = (iconSet, scale = 1) => ({
  tiles : ROLE_VARIANT.map(v => iconSet.atlas.tileChannel(iconSet.resolve(v))),
  sizes : ROLE_SIZE.map(s => s * scale),
})

export class EditHandleLayer {

  #gl; #arena; #path; #picking; #iconSet; #binding
  #program = null
  #uMatrix = null
  #vao     = null
  #view    = null

  #promoted  = -1
  #rev       = -1
  #holes     = Array.from({ length: HOLES }, () => ({ chunk: -1, from: Infinity, to: Infinity }))
  #holeCount = 0

  #rect  = new Float64Array(4)             // viewport en rel-ancla, con margen de sprite
  #box   = new Float64Array(4)             // salida de boxOfChunk, reusada [0-alloc]
  #draws = []                              // pool de PickDraw; `#batch.length` dice cuántos valen
  #batch = { draws: this.#draws, length: 0, matrix: null }
  #hit   = { ref: -1, metadata: null }

  // La identidad que le asigna el motor. El pase descarta el objeto 0.
  pickObject = 0

  constructor({ gl, arena, path, picking, iconSet = defineEditIconSet() }) {
    this.#gl      = gl
    this.#arena   = arena
    this.#path    = path
    this.#picking = picking
    this.#iconSet = iconSet
    this.#binding = new GpuAtlasBinding(gl)
    this.#program = this.#link()
    this.#uMatrix = gl.getUniformLocation(this.#program, 'matrix')
    this.#vao     = this.#buildVao()
    this.#binding.register(this.#program)
    this.#binding.register(picking.attach(gl, this.#program, this.#binding.texture))
  }

  get iconSet()  { return this.#iconSet }
  get promoted() { return this.#promoted }

  // El vértice cuyo vecindario toma el banco DOM (-1 = ninguno). Sólo abre agujeros: no escribe un byte.
  promote(ref) {
    if (ref === this.#promoted) return this
    this.#promoted = ref
    this.#rehole()
    return this
  }

  draw(view) {
    const gl = this.#gl
    this.#setView(view)
    this.#syncHoles()
    this.#binding.sync(this.#iconSet.atlas)
    gl.useProgram(this.#program)
    gl.uniformMatrix4fv(this.#uMatrix, false, this.#matrix())
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    gl.bindVertexArray(this.#vao)
    this.#arena.eachRange(this.#visual)
    gl.bindVertexArray(null)
    return this
  }

  // Un PickDraw por chunk VISIBLE, con `bind` estable y el ORDINAL como chunk. Scratch reusado: vale
  // hasta el próximo pedido, como cualquier scratch del kit. Sin vista todavía no hay nada que pickear.
  pickBatch() {
    const batch = this.#batch
    batch.length = 0
    if (!this.#view) return batch
    batch.matrix = this.#matrix()
    this.#arena.eachRange(this.#pase)
    return batch
  }

  // Click: la respuesta tiene que llegar dentro del mismo gesto.
  pickRef(cx, cy) { return this.#refOf(this.#picking.pickSync(cx, cy, this.pickBatch(), null)) }

  // Hover: el pase no bloquea y `metadata` vuelve con el resultado para atarlo a su muestra.
  requestPick(cx, cy, metadata) { return this.#picking.request(cx, cy, this.pickBatch(), metadata) }

  // Scratch reusado, válido hasta el próximo collect.
  collectPick() {
    const got = this.#picking.collect()
    if (!got) return null
    this.#hit.ref      = this.#refOf(got)
    this.#hit.metadata = got.metadata
    return this.#hit
  }

  destroy() {
    const gl = this.#gl
    gl.deleteVertexArray(this.#vao)
    gl.deleteProgram(this.#program)
    this.#binding.destroy()
    this.#vao = this.#program = this.#view = null
    return this
  }

  /* ── Rangos de draw ─────────────────────────────────────────────────────────────────────── */

  // VISUAL: un draw por chunk visible, partido por los agujeros del vecindario promovido —esas entradas
  // las dibuja el banco DOM—. Los campos son de la instancia y las dos travesías son arrows estables: la
  // ruta queda [0-alloc].
  #visual = (_ordinal, first, count, chunk) => {
    if (count <= 0 || !this.#inView(chunk)) return
    const end = first + count
    let from  = first
    for (let i = 0; i < this.#holeCount; i++) {
      const h = this.#holes[i]
      if (h.chunk !== chunk) continue
      this.#span(from, h.from)
      from = Math.max(from, h.to)
    }
    this.#span(from, end)
  }

  #span(from, to) {
    if (to > from) this.#gl.drawArrays(this.#gl.POINTS, from, to - from)
  }

  // PASE: el run ENTERO, agujeros incluidos. Un ordinal ≥ 64 no entra: el pase lo atribuiría por módulo a
  // otro chunk y el hit volvería como un ref AJENO, sin ningún error a la vista. Fuera del batch degrada a
  // «no pickeable», que es recuperable.
  #pase = (ordinal, first, count, chunk) => {
    if (count <= 0 || ordinal >= ORDINAL_CAP || !this.#inView(chunk)) return
    const n = this.#batch.length
    const d = this.#draws[n] ??= this.#newDraw()
    d.first = first
    d.count = count
    d.chunk = ordinal
    d.obj   = this.pickObject
    this.#batch.length = n + 1
  }

  #bind = () => this.#gl.bindVertexArray(this.#vao)

  #newDraw() {
    return { bind: this.#bind, texture: this.#binding.texture, mode: this.#gl.POINTS,
      first: 0, count: 0, obj: 0, chunk: 0 }
  }

  /* ── El vecindario promovido ────────────────────────────────────────────────────────────── */

  // Cualquier escritura del trazo puede mover al vecino de chunk o cambiar quién es —`setClosed` le da
  // vecino al primer vértice sin tocar la estructura—, así que la revisión que manda es la de escritura.
  #syncHoles() {
    if (this.#rev === this.#path.rev) return
    this.#rev = this.#path.rev
    this.#rehole()
  }

  // prev, su midpoint, v, su midpoint y next: cinco entradas vivas que el banco DOM ya dibuja. El
  // vecindario sale de la LISTA, nunca de aritmética sobre el ref: en un anillo el vecino vive en el
  // chunk más lejano del arena, y un intervalo único taparía todo lo que hay en medio.
  #rehole() {
    const path = this.#path
    const v    = this.#promoted
    this.#holes.forEach(vaciar)
    this.#holeCount = 0
    if (path.roleAt(v) !== ROLE.vertex) return
    const prev = path.prevVertex(v)
    const next = path.nextVertex(v)
    prev >= 0 && this.#hole(prev, 2)
    this.#hole(v, 2)
    next >= 0 && this.#hole(next, 1)
    this.#holes.sort(porRef)                 // el anillo puede poner al vecino ANTES del promovido
  }

  #hole(ref, entradas) {
    const h = this.#holes[this.#holeCount++]
    h.chunk = this.#path.chunkOf(ref)
    h.from  = ref
    h.to    = ref + entradas
  }

  /* ── Vista ──────────────────────────────────────────────────────────────────────────────── */

  #matrix() { return this.#arena.matrixFor(this.#view.zoom, this.#view.center, this.#view.size) }

  // El viewport en rel-ancla, con el sprite más grande como margen: un handle centrado justo afuera del
  // recorte todavía asoma media silueta.
  #setView(view) {
    const scale  = 2 ** view.zoom
    const margen = MAX_SIZE / scale
    const anchor = this.#arena.anchor
    const x = view.center.x - anchor.x - view.size.x / (2 * scale)
    const y = view.center.y - anchor.y - view.size.y / (2 * scale)
    const r = this.#rect
    r[0] = x - margen
    r[1] = y - margen
    r[2] = x + view.size.x / scale + margen
    r[3] = y + view.size.y / scale + margen
    this.#view = view
  }

  #inView(chunk) {
    const b = this.#arena.boxOfChunk(chunk, this.#box)
    const r = this.#rect
    return b[0] <= r[2] && b[2] >= r[0] && b[1] <= r[3] && b[3] >= r[1]
  }

  /* ── Decode del pick ────────────────────────────────────────────────────────────────────── */

  // (ordinal, local) → el ref del `ChunkedPath`. Un impacto sin entrada (local 0 en el pase) es el cuerpo
  // del objeto, no un handle, y no tiene ref.
  #refOf(got) {
    if (!got) return -1
    const hits = got.hits
    const i    = hits.firstOf(this.pickObject)
    return i < 0 || hits.slots[i] < 0 ? -1 : this.#arena.refAt(hits.chunks[i], hits.slots[i])
  }

  /* ── GL ─────────────────────────────────────────────────────────────────────────────────── */

  #link() {
    const gl      = this.#gl
    const program = gl.createProgram()
    ;[[gl.VERTEX_SHADER, POINT_VERTEX], [gl.FRAGMENT_SHADER, POINT_FRAGMENT]].forEach(([type, source]) => {
      const shader = gl.createShader(type)
      gl.shaderSource(shader, source)
      gl.compileShader(shader)
      gl.attachShader(program, shader)
      gl.deleteShader(shader)                // el programa las retiene hasta el link
    })
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw new Error(`[cristae] el programa de los handles no linkea: ${gl.getProgramInfoLog(program)}`)
    return program
  }

  // El VBO del arena es un objeto ESTABLE —`grow` reasigna su almacenamiento, no el buffer—, así que el
  // VAO se arma una vez y sobrevive a la duplicación del arena.
  #buildVao() {
    const gl  = this.#gl
    const vao = gl.createVertexArray()
    gl.bindVertexArray(vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#arena.vbo)
    ATTRS.forEach(({ name, size, offset }) => {
      const loc = gl.getAttribLocation(this.#program, name)
      if (loc < 0) return
      gl.enableVertexAttribArray(loc)
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, STRIDE, offset)
    })
    gl.bindVertexArray(null)
    return vao
  }
}
