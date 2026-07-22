import { POINT_VERTEX, POINT_PICKING_FRAGMENT } from './shaders.js'

// Picking GPU no-bloqueante: micro-FBO + scissor + lectura diferida por PBO/fenceSync (WebGL2).
// Comparte el buffer de vértices de glify — el programa de picking se linkea con los MISMOS
// índices de atributo (bindAttribLocation) que el visual, así reusa el vertexAttribPointer que
// glify ya dejó montado: no re-bindea buffer ni vertexAttribPointer. Un bufferSubData al buffer
// actualiza visual y picking a la vez (§17.5). La textura del atlas es estable (un solo objeto
// reusado por el binding incluso en regrow) → capturarla una vez no produce staleness.

const PATCH = 6

export class Picking {

  #gl            = null
  #program       = null
  #fbo           = null
  #depth         = null
  #colorTex      = null
  #pbo           = null
  #buf           = new Uint8Array(PATCH * PATCH * 4)
  #atlasTexture  = null
  #attrLocs      = []
  #uMatrix       = null
  #inFlight      = null
  #visualProgram = null   // programa visual de glify → se restaura tras el pick (glify dibuja con él, sin re-useProgram)

  get ready() { return !!this.#gl }
  get program() { return this.#program }
  get pending() { return !!this.#inFlight }

  // Devuelve el programa de picking para que el binding del atlas le setee sus dims-uniforms.
  attach(gl, visualProgram, atlasTexture) {
    this.#gl = gl
    this.#atlasTexture = atlasTexture
    this.#visualProgram = visualProgram
    this.#createFbo()
    this.#compile(visualProgram)
    this.#pbo = gl.createBuffer()
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.#pbo)
    gl.bufferData(gl.PIXEL_PACK_BUFFER, this.#buf.byteLength, gl.STREAM_READ)
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
    return this.#program
  }

  // Pick asíncrono: dibuja el parche y agenda la lectura; collect() la recoge sin bloquear.
  request(cx, cy, count, matrix, metadata) {
    const gl = this.#gl
    if (!gl || !this.#program || this.#inFlight) return false
    const patch = this.#begin(cx, cy, count, matrix)
    if (!patch) return false
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.#pbo)
    gl.readPixels(patch.sx, patch.sy, patch.sw, patch.sh, gl.RGBA, gl.UNSIGNED_BYTE, 0)
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
    const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)
    gl.flush()
    this.#inFlight = { fence, sw: patch.sw, sh: patch.sh, metadata }
    this.#restore()
    return true
  }

  // Sondea la lectura en vuelo (timeout 0 → no bloquea). null si aún no está lista.
  collect() {
    const gl = this.#gl
    const e = this.#inFlight
    if (!gl || !e) return null
    const status = gl.clientWaitSync(e.fence, 0, 0)
    if (status === gl.TIMEOUT_EXPIRED) return null
    this.#inFlight = null
    gl.deleteSync(e.fence)
    if (status === gl.WAIT_FAILED) return null
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.#pbo)
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this.#buf, 0, e.sw * e.sh * 4)
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
    return { slots: this.#decode(e.sw * e.sh), metadata: e.metadata }
  }

  // Pick síncrono (click): lectura bloqueante directa.
  pickSync(cx, cy, count, matrix, metadata) {
    const gl = this.#gl
    if (!gl || !this.#program) return null
    const patch = this.#begin(cx, cy, count, matrix)
    if (!patch) return null
    gl.readPixels(patch.sx, patch.sy, patch.sw, patch.sh, gl.RGBA, gl.UNSIGNED_BYTE, this.#buf)
    this.#restore()
    return { slots: this.#decode(patch.sw * patch.sh), metadata }
  }

  abort() {
    if (this.#inFlight) { this.#gl.deleteSync(this.#inFlight.fence); this.#inFlight = null }
  }

  syncSize() {
    if (this.#gl) this.#createFbo()
  }

  detach() {
    const gl = this.#gl
    if (!gl) return
    this.abort()
    gl.deleteFramebuffer(this.#fbo)
    gl.deleteRenderbuffer(this.#depth)
    gl.deleteTexture(this.#colorTex)
    gl.deleteBuffer(this.#pbo)
    this.#gl = null
  }

  #begin(cx, cy, count, matrix) {
    const gl = this.#gl
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight
    const half = PATCH >> 1
    const sx = Math.max(0, Math.round(cx) - half)
    const sy = Math.max(0, h - Math.round(cy) - half)
    const sw = Math.min(PATCH, w - sx)
    const sh = Math.min(PATCH, h - sy)
    if (sw <= 0 || sh <= 0) return null
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.#fbo)
    gl.viewport(0, 0, w, h)
    gl.enable(gl.SCISSOR_TEST)
    gl.scissor(sx, sy, sw, sh)
    gl.disable(gl.BLEND)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.#atlasTexture)
    gl.useProgram(this.#program)
    if (this.#uMatrix) gl.uniformMatrix4fv(this.#uMatrix, false, matrix)
    for (let i = 0; i < this.#attrLocs.length; i++) gl.enableVertexAttribArray(this.#attrLocs[i])
    gl.drawArrays(gl.POINTS, 0, count)
    return { sx, sy, sw, sh }
  }

  #restore() {
    const gl = this.#gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.disable(gl.SCISSOR_TEST)
    gl.enable(gl.BLEND)
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight)
    gl.useProgram(this.#visualProgram)      // restaurar el programa visual de glify (dibuja sin re-useProgram)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.#atlasTexture)
  }

  // RGBA → set de slots. Vacío = alpha 0 (cleared); pintado = alpha 1, id en (r<<8)|g.
  #decode(pixels) {
    const buf = this.#buf
    const slots = new Set()
    for (let i = 0, n = pixels * 4; i < n; i += 4) {
      if (buf[i + 3] === 0) continue
      const id = (buf[i] << 8) | buf[i + 1]
      if (id > 0) slots.add(id - 1)
    }
    return slots
  }

  #createFbo() {
    const gl = this.#gl
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight
    // Guardar los bindings activos: glify muestrea el atlas desde TEXTURE0 sin rebindearlo por draw;
    // si dejáramos acá el texture del FBO, su próximo draw (p. ej. el redraw del zoom) saldría en blanco.
    const prevTex = gl.getParameter(gl.TEXTURE_BINDING_2D)
    const prevRbo = gl.getParameter(gl.RENDERBUFFER_BINDING)
    const prevFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING)
    if (this.#fbo) {
      gl.deleteFramebuffer(this.#fbo)
      gl.deleteTexture(this.#colorTex)
      gl.deleteRenderbuffer(this.#depth)
    }
    this.#colorTex = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, this.#colorTex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    this.#depth = gl.createRenderbuffer()
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.#depth)
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, w, h)
    this.#fbo = gl.createFramebuffer()
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.#fbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.#colorTex, 0)
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.#depth)
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo)
    gl.bindRenderbuffer(gl.RENDERBUFFER, prevRbo)
    gl.bindTexture(gl.TEXTURE_2D, prevTex)
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
    this.#program = program
    this.#uMatrix = gl.getUniformLocation(program, 'matrix')
  }
}
