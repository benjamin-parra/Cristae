// Relleno de la geometría editable por STENCIL-THEN-COVER: cada arista aporta el triángulo
// (ancla, vᵢ, vᵢ₊₁) con `stencilOp INVERT` —regla par-impar, sin triangular— y una cobertura posterior
// pinta donde el bit quedó en uno. Los anillos de un contorno componen su paridad ANTES de la cobertura:
// el XOR entre ellos es lo que abre el agujero. Cada anillo usa el ancla de SU arena, que se cancela por
// anillo cerrado.
//
// La cobertura escribe con `stencilOp ZERO`, así que el stencil queda limpio sin un `clear`. El
// invariante es que su rectángulo contenga todo lo que la paridad pudo tocar: la caja de los chunks
// —que el arena sobredimensiona y nunca encoge— más el vértice vivo del arrastre.
//
// ARRASTRE: el vértice promovido no se escribe a GPU. Sus dos aristas salen del pase estático —que se
// parte en los tramos que quedan— y se dibujan aparte con la posición viva como uniform. La paridad
// telescopa, así que quitarlas y sumarlas por separado da el mismo relleno, exacto.

import { toRGBA } from './color.js'
import { blendOver } from './EditSurface.js'
import { sharedProgram } from './gl-programs.js'

const BIT = 0x01                       // el relleno vive en el bit 0 del stencil

const PRELUDE = `#version 300 es
precision highp float;
uniform sampler2D uPos;                // posiciones de los VÉRTICES, relativas al ancla del anillo
uniform mat4 uMatrix;                  // rel-ancla → clip
vec2 posAt(int ref) {
  ivec2 dims = textureSize(uPos, 0);
  return texelFetch(uPos, ivec2(ref % dims.x, ref / dims.x), 0).xy;
}
`

// Abanico attributeless: 3 vértices por arista, esquina 0 = el ancla. `step` es cada cuántas entradas
// viene el vértice siguiente (2 con midpoints intercalados, 1 sin ellos) y la última arista cierra
// contra `uTail`, que vive en otro rango.
const VS_PARITY = step => `${PRELUDE}
uniform int uFirst;
uniform int uEdges;
uniform int uTail;
void main() {
  int edge   = gl_VertexID / 3;
  int corner = gl_VertexID % 3;
  int end    = edge + 1 < uEdges ? uFirst + ${step} * (edge + 1) : uTail;
  vec2 p = corner == 0 ? vec2(0.0) : posAt(corner == 1 ? uFirst + ${step} * edge : end);
  gl_Position = uMatrix * vec4(p, 0.0, 1.0);
}`

// Las dos aristas del vértice promovido: (ancla, prev, vivo) y (ancla, vivo, next). `uLive` es la
// esquina 2 del primer triángulo y la 1 del segundo — de ahí el `tri + corner == 2`.
const VS_LIVE = `${PRELUDE}
uniform int  uPrev;
uniform int  uNext;
uniform vec2 uLive;
void main() {
  int tri    = gl_VertexID / 3;
  int corner = gl_VertexID % 3;
  vec2 p = corner == 0 ? vec2(0.0) : tri + corner == 2 ? uLive : posAt(tri == 0 ? uPrev : uNext);
  gl_Position = uMatrix * vec4(p, 0.0, 1.0);
}`

const VS_COVER = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`

const FS_PARITY = `#version 300 es
precision highp float;
out vec4 color;
void main() { color = vec4(1.0); }`    // la máscara de color está apagada: sólo cuenta el stencilOp

const FS_COLOR = `#version 300 es
precision highp float;
uniform vec4 uColor;
out vec4 color;
void main() { color = uColor; }`

const compile = (gl, type, source) => {
  const shader = gl.createShader(type)
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader))
  return shader
}

const buildProgram = (gl, vs, fs, names) => {
  const program = gl.createProgram()
  const shaders = [compile(gl, gl.VERTEX_SHADER, vs), compile(gl, gl.FRAGMENT_SHADER, fs)]
  shaders.forEach(shader => gl.attachShader(program, shader))
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program))
  shaders.forEach(shader => gl.deleteShader(shader))     // ya viven dentro del programa enlazado
  const u = { program }
  names.forEach(name => (u[name] = gl.getUniformLocation(program, name)))
  return u
}

// Los tres programas del pase con las ubicaciones de sus uniformes. `uPos` se fija acá porque el sampler
// es del PROGRAMA —queda con el enlace y ninguna instancia lo mueve—; color, matriz y rangos siguen
// viajando por draw, que sí son de la capa.
const passPrograms = (gl, step) => sharedProgram(gl, `fill:${step}`, () => {
  const pass = {
    parity : buildProgram(gl, VS_PARITY(step), FS_PARITY, ['uPos', 'uMatrix', 'uFirst', 'uEdges', 'uTail']),
    live   : buildProgram(gl, VS_LIVE,  FS_PARITY, ['uPos', 'uMatrix', 'uPrev', 'uNext', 'uLive']),
    cover  : buildProgram(gl, VS_COVER, FS_COLOR,  ['uColor']),
  }
  ;[pass.parity, pass.live].forEach(u => {
    gl.useProgram(u.program)
    gl.uniform1i(u.uPos, 0)             // las posiciones viajan siempre por la unidad 0
  })
  return pass
})

const grow = arr => {
  const bigger = new Int32Array(arr.length * 2)
  bigger.set(arr)
  return bigger
}

export class EditFillLayer {

  rings                                 // [{ path, arena }] — el XOR de sus paridades abre los agujeros

  #hex
  #opacity
  #rgba
  #step                                 // entradas entre dos vértices consecutivos del mismo rango
  #gl
  #parity
  #live
  #cover
  #vao
  #arena  = null                        // anillo en curso, para los callbacks estables de eachRange
  #matrix = null
  #box    = new Float64Array(4)         // scratch de boxOfChunk
  #clip   = new Float64Array(4)         // caja del contorno en clip, de donde sale el scissor
  #firsts = new Int32Array(16)          // rangos del anillo en orden de trazo: ref del primer vértice…
  #verts  = new Int32Array(16)          // … y cuántos vértices lleva
  #ranges = 0
  #promo  = { ring: -1, vertex: -1, prev: -1, next: -1, x: 0, y: 0 }

  constructor({ gl, rings = [], color = '#6366f1', opacity = 0.42, step = 2 }) {
    const pass = passPrograms(gl, step)
    this.rings   = rings
    this.#gl     = gl
    this.#step   = step
    this.#vao    = gl.createVertexArray()
    this.#parity = pass.parity
    this.#live   = pass.live
    this.#cover  = pass.cover
    this.style({ color, opacity })
  }

  // Un hex con alpha propio manda sobre `opacity`.
  style({ color = this.#hex, opacity = this.#opacity } = {}) {
    this.#hex     = color
    this.#opacity = opacity
    this.#rgba    = toRGBA(color, opacity)
    return this
  }

  // `drag` = { ring, vertex, x, y } con la posición viva en world0 px. Devuelve si dibujó: el contorno
  // puede quedar entero fuera de pantalla.
  draw({ zoom, center, size, drag = null }) {
    const gl = this.#gl
    if (!this.rings.length) return false

    const promo = drag ? this.#promote(drag) : null
    if (!this.#scissor(zoom, center, size, promo)) return false

    gl.bindVertexArray(this.#vao)       // contexto compartido: sin heredar los atributos de otra capa
    gl.activeTexture(gl.TEXTURE0)
    gl.enable(gl.STENCIL_TEST)
    gl.colorMask(false, false, false, false)
    gl.stencilMask(BIT)
    gl.stencilFunc(gl.ALWAYS, 0, BIT)
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.INVERT)            // par-impar: impar = adentro
    gl.useProgram(this.#parity.program)

    for (let i = 0; i < this.rings.length; i++) {
      const arena  = this.rings[i].arena
      this.#ranges = 0
      arena.eachRange(this.#noteRange)
      gl.uniformMatrix4fv(this.#parity.uMatrix, false, arena.matrixFor(zoom, center, size))
      gl.bindTexture(gl.TEXTURE_2D, arena.texture)
      const promoted = promo?.ring === i
      for (let j = 0; j < this.#ranges; j++) {
        // Las dos aristas promovidas parten el rango en 1, 2 o 3 tramos: la de `prev` arranca en él y
        // la de `vertex` en el suyo, y en un anillo de un solo rango pueden quedar en los extremos.
        const a  = promoted ? this.#edgeAt(j, promo.prev) : -1
        const b  = promoted ? this.#edgeAt(j, promo.vertex) : -1
        const lo = a < 0 ? b : b < 0 ? a : Math.min(a, b)
        const hi = a < 0 || b < 0 ? -1 : Math.max(a, b)
        this.#span(j, 0, lo < 0 ? this.#verts[j] : lo)
        lo >= 0 && this.#span(j, lo + 1, hi < 0 ? this.#verts[j] : hi)
        hi >= 0 && this.#span(j, hi + 1, this.#verts[j])
      }
    }

    if (promo) {
      const live  = this.#live
      const arena = this.rings[promo.ring].arena
      gl.useProgram(live.program)
      gl.uniformMatrix4fv(live.uMatrix, false, arena.matrixFor(zoom, center, size))
      gl.uniform1i(live.uPrev, promo.prev)
      gl.uniform1i(live.uNext, promo.next)
      gl.uniform2f(live.uLive, promo.x, promo.y)
      gl.bindTexture(gl.TEXTURE_2D, arena.texture)
      gl.drawArrays(gl.TRIANGLES, 0, 6)
    }

    const cover = this.#cover
    const rgba  = this.#rgba
    gl.useProgram(cover.program)
    gl.colorMask(true, true, true, true)
    blendOver(gl)
    gl.stencilFunc(gl.NOTEQUAL, 0, BIT)
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.ZERO)
    gl.uniform4f(cover.uColor, rgba[0], rgba[1], rgba[2], rgba[3])
    gl.drawArrays(gl.TRIANGLES, 0, 3)

    gl.disable(gl.STENCIL_TEST)         // el pase de picking hereda este contexto: se sale en neutro
    gl.disable(gl.SCISSOR_TEST)
    gl.stencilMask(0xff)
    gl.bindVertexArray(null)
    return true
  }

  // El VAO es de esta capa; los tres programas son del contexto y los comparten todas las geometrías.
  destroy() {
    this.#gl.deleteVertexArray(this.#vao)
    this.rings = []
  }

  // El vecino de un extremo es el otro extremo: la arista que cierra el anillo. Un trazo abierto se
  // rellena como su clausura, que es lo que el editor muestra mientras se dibuja.
  #promote({ ring, vertex, x, y }) {
    const { path, arena } = this.rings[ring]
    const prev  = path.prevVertex(vertex)
    const next  = path.nextVertex(vertex)
    const promo = this.#promo
    promo.ring   = ring
    promo.vertex = vertex
    promo.prev   = prev < 0 ? path.lastVertex : prev
    promo.next   = next < 0 ? path.firstVertex : next
    promo.x      = x - arena.anchor.x
    promo.y      = y - arena.anchor.y
    return promo
  }

  // La caja del contorno en clip llevada a píxeles del framebuffer, con un píxel de holgura para el
  // borde de rasterización. Falso = no queda nada que dibujar.
  #scissor(zoom, center, size, promo) {
    const gl = this.#gl, clip = this.#clip
    clip[0] = clip[1] = Infinity
    clip[2] = clip[3] = -Infinity
    for (let i = 0; i < this.rings.length; i++) {
      const arena  = this.rings[i].arena
      this.#arena  = arena
      this.#matrix = arena.matrixFor(zoom, center, size)
      arena.eachRange(this.#extendWithChunk)
      if (promo?.ring === i) this.#extendClip(promo.x, promo.y)
    }
    const w  = gl.drawingBufferWidth
    const h  = gl.drawingBufferHeight
    const x  = Math.max(0, Math.floor((clip[0] * 0.5 + 0.5) * w) - 1)
    const y  = Math.max(0, Math.floor((clip[1] * 0.5 + 0.5) * h) - 1)
    const cw = Math.min(w, Math.ceil((clip[2] * 0.5 + 0.5) * w) + 1) - x
    const ch = Math.min(h, Math.ceil((clip[3] * 0.5 + 0.5) * h) + 1) - y
    if (cw <= 0 || ch <= 0) return false
    gl.enable(gl.SCISSOR_TEST)
    gl.scissor(x, y, cw, ch)
    return true
  }

  #extendWithChunk = (_ordinal, _first, count, chunk) => {
    if (!count) return
    const box = this.#arena.boxOfChunk(chunk, this.#box)
    this.#extendClip(box[0], box[1])
    this.#extendClip(box[2], box[3])
  }

  // La matriz del arena es escala + traslación, así que cada eje del clip depende sólo de su
  // coordenada: dos esquinas opuestas fijan la caja.
  #extendClip(x, y) {
    const m = this.#matrix, clip = this.#clip
    const cx = m[0] * x + m[12]
    const cy = m[5] * y + m[13]
    if (cx < clip[0]) clip[0] = cx
    if (cy < clip[1]) clip[1] = cy
    if (cx > clip[2]) clip[2] = cx
    if (cy > clip[3]) clip[3] = cy
  }

  #noteRange = (_ordinal, first, count) => {
    if (!count) return
    if (this.#ranges === this.#firsts.length) {
      this.#firsts = grow(this.#firsts)
      this.#verts  = grow(this.#verts)
    }
    this.#firsts[this.#ranges] = first
    this.#verts[this.#ranges]  = Math.ceil(count / this.#step)
    this.#ranges++
  }

  // Índice de la arista que ARRANCA en `u` dentro del rango `j`, o -1 si `u` no vive ahí.
  #edgeAt(j, u) {
    const first = this.#firsts[j]
    const step  = this.#step
    return u >= first && u < first + step * this.#verts[j] ? (u - first) / step | 0 : -1
  }

  // Aristas [from, to) del rango `j`. La última cierra contra el vértice que sigue: el de al lado si el
  // tramo no agota el rango, si no el primero del rango siguiente —y el del último rango es el del
  // primero, que es el cierre del anillo—.
  #span(j, from, to) {
    if (to <= from) return
    const gl    = this.#gl
    const step  = this.#step
    const first = this.#firsts[j]
    const tail  = to < this.#verts[j] ? first + step * to : this.#firsts[(j + 1) % this.#ranges]
    gl.uniform1i(this.#parity.uFirst, first + step * from)
    gl.uniform1i(this.#parity.uEdges, to - from)
    gl.uniform1i(this.#parity.uTail, tail)
    gl.drawArrays(gl.TRIANGLES, 0, (to - from) * 3)
  }
}
