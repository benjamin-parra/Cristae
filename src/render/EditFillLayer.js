// Relleno de la geometría editable por STENCIL-THEN-COVER: cada arista aporta el triángulo
// (ancla, vᵢ, vᵢ₊₁) con `stencilOp INVERT` —regla par-impar, sin triangular— y una cobertura posterior
// pinta donde el bit quedó en uno. Los anillos de un contorno componen su paridad ANTES de la
// cobertura: el XOR entre ellos es lo que abre el agujero. Cada anillo usa el ancla de SU arena (el
// rel = 0 de su textura); el ancla se cancela por anillo cerrado, así que no hay una que compartir.
//
// La cobertura escribe con `stencilOp ZERO` y devuelve el bit a cero donde pinta: el stencil queda
// limpio sin un `clear` —que no respetaría el scissor de nadie— y sin un pase por anillo. El único
// invariante es que el rectángulo de la cobertura contenga todo lo que la paridad pudo tocar: la caja
// de los chunks (el arena la sobredimensiona y nunca la encoge) más el vértice vivo del arrastre, que
// justamente sale de esa caja congelada.
//
// ARRASTRE: el vértice promovido no se escribe a GPU. Sus dos aristas salen del pase estático —que se
// parte en los tramos que quedan— y se dibujan aparte con la posición viva como uniform. La paridad
// telescopa, así que quitarlas y sumarlas por separado da el mismo relleno, exacto.

import { toRGBA } from './color.js'

const BIT = 0x01                       // el relleno vive en el bit 0 del stencil

const PRELUDIO = `#version 300 es
precision highp float;
uniform sampler2D uPos;                // posiciones de los VÉRTICES, relativas al ancla del anillo
uniform mat4 uMatrix;                  // rel-ancla → clip
vec2 posAt(int ref) {
  ivec2 tam = textureSize(uPos, 0);
  return texelFetch(uPos, ivec2(ref % tam.x, ref / tam.x), 0).xy;
}
`

// Abanico attributeless: 3 vértices por arista, esquina 0 = el ancla. Dentro de un chunk los vértices
// van de dos en dos (la impar es su midpoint), y la última arista cierra contra `uTail`, que vive en
// otro chunk.
const VS_PARIDAD = `${PRELUDIO}
uniform int uFirst;
uniform int uEdges;
uniform int uTail;
void main() {
  int arista  = gl_VertexID / 3;
  int esquina = gl_VertexID % 3;
  int fin     = arista + 1 < uEdges ? uFirst + 2 * (arista + 1) : uTail;
  vec2 p = esquina == 0 ? vec2(0.0) : posAt(esquina == 1 ? uFirst + 2 * arista : fin);
  gl_Position = uMatrix * vec4(p, 0.0, 1.0);
}`

// Las dos aristas del vértice promovido: (ancla, prev, vivo) y (ancla, vivo, next). `vivo` es la
// esquina 2 del primer triángulo y la 1 del segundo — de ahí el `tri + esquina == 2`.
const VS_VIVAS = `${PRELUDIO}
uniform int  uPrev;
uniform int  uNext;
uniform vec2 uVivo;
void main() {
  int tri     = gl_VertexID / 3;
  int esquina = gl_VertexID % 3;
  vec2 p = esquina == 0 ? vec2(0.0) : tri + esquina == 2 ? uVivo : posAt(tri == 0 ? uPrev : uNext);
  gl_Position = uMatrix * vec4(p, 0.0, 1.0);
}`

const VS_CUBRIR = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`

const FS_PARIDAD = `#version 300 es
precision highp float;
out vec4 color;
void main() { color = vec4(1.0); }`    // la máscara de color está apagada: sólo cuenta el stencilOp

const FS_COLOR = `#version 300 es
precision highp float;
uniform vec4 uColor;
out vec4 color;
void main() { color = uColor; }`

const compilar = (gl, tipo, fuente) => {
  const shader = gl.createShader(tipo)
  gl.shaderSource(shader, fuente)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader))
  return shader
}

const programa = (gl, vs, fs, uniformes) => {
  const program = gl.createProgram()
  const shaders = [compilar(gl, gl.VERTEX_SHADER, vs), compilar(gl, gl.FRAGMENT_SHADER, fs)]
  shaders.forEach(shader => gl.attachShader(program, shader))
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program))
  shaders.forEach(shader => gl.deleteShader(shader))     // ya viven dentro del programa enlazado
  const u = { program }
  uniformes.forEach(nombre => (u[nombre] = gl.getUniformLocation(program, nombre)))
  return u
}

const crecer = arr => {
  const mayor = new Int32Array(arr.length * 2)
  mayor.set(arr)
  return mayor
}

export class EditFillLayer {

  rings                                 // [{ path, arena }] — el XOR de sus paridades abre los agujeros

  #hex
  #opacity
  #rgba
  #gl
  #paridad
  #vivas
  #cubierta
  #vao
  #arena  = null                        // anillo en curso, para los callbacks estables de eachRange
  #matriz = null
  #caja   = new Float64Array(4)         // scratch de boxOfChunk
  #clip   = new Float64Array(4)         // caja del contorno en clip, de donde sale el scissor
  #firsts = new Int32Array(16)          // rangos del anillo en orden de trazo: ref del primer vértice…
  #verts  = new Int32Array(16)          // … y cuántos vértices lleva
  #rangos = 0
  #promo  = { ring: -1, vertex: -1, prev: -1, next: -1, x: 0, y: 0 }

  constructor({ gl, rings = [], color = '#6366f1', opacity = 0.42 }) {
    this.rings     = rings
    this.#gl       = gl
    this.#vao      = gl.createVertexArray()
    this.#paridad  = programa(gl, VS_PARIDAD, FS_PARIDAD, ['uPos', 'uMatrix', 'uFirst', 'uEdges', 'uTail'])
    this.#vivas    = programa(gl, VS_VIVAS,   FS_PARIDAD, ['uPos', 'uMatrix', 'uPrev', 'uNext', 'uVivo'])
    this.#cubierta = programa(gl, VS_CUBRIR,  FS_COLOR,   ['uColor'])
    ;[this.#paridad, this.#vivas].forEach(u => {
      gl.useProgram(u.program)
      gl.uniform1i(u.uPos, 0)           // las posiciones viajan siempre por la unidad 0
    })
    this.style({ color, opacity })
  }

  // El color vive en un uniform: restilar no toca la GPU. Un hex con alpha propio manda sobre `opacity`.
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

    const promo = drag ? this.#promover(drag) : null
    if (!this.#encuadrar(zoom, center, size, promo)) return false

    gl.bindVertexArray(this.#vao)       // contexto compartido: sin heredar los atributos de otra capa
    gl.activeTexture(gl.TEXTURE0)
    gl.enable(gl.STENCIL_TEST)
    gl.colorMask(false, false, false, false)
    gl.stencilMask(BIT)
    gl.stencilFunc(gl.ALWAYS, 0, BIT)
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.INVERT)            // par-impar: impar = adentro
    gl.useProgram(this.#paridad.program)

    for (let i = 0; i < this.rings.length; i++) {
      const arena  = this.rings[i].arena
      this.#rangos = 0
      arena.eachRange(this.#anotarRango)
      gl.uniformMatrix4fv(this.#paridad.uMatrix, false, arena.matrixFor(zoom, center, size))
      gl.bindTexture(gl.TEXTURE_2D, arena.texture)
      const promovido = promo?.ring === i
      for (let j = 0; j < this.#rangos; j++) {
        // Las dos aristas promovidas parten el rango en 1, 2 o 3 tramos: la de `prev` arranca en él y
        // la de `vertex` en el suyo, y en un anillo de un solo rango pueden quedar en los extremos.
        const corta = promovido ? this.#aristaEn(j, promo.prev) : -1
        const sigue = promovido ? this.#aristaEn(j, promo.vertex) : -1
        const lo    = corta < 0 ? sigue : sigue < 0 ? corta : Math.min(corta, sigue)
        const hi    = corta < 0 || sigue < 0 ? -1 : Math.max(corta, sigue)
        this.#tramo(j, 0, lo < 0 ? this.#verts[j] : lo)
        lo >= 0 && this.#tramo(j, lo + 1, hi < 0 ? this.#verts[j] : hi)
        hi >= 0 && this.#tramo(j, hi + 1, this.#verts[j])
      }
    }
    promo && this.#dibujarVivas(promo, zoom, center, size)
    this.#cubrir()

    gl.disable(gl.STENCIL_TEST)         // el pase de picking hereda este contexto: se sale en neutro
    gl.disable(gl.SCISSOR_TEST)
    gl.stencilMask(0xff)
    gl.bindVertexArray(null)
    return true
  }

  destroy() {
    const gl = this.#gl
    ;[this.#paridad, this.#vivas, this.#cubierta].forEach(u => gl.deleteProgram(u.program))
    gl.deleteVertexArray(this.#vao)
    this.rings = []
  }

  // El vecino de un extremo es el otro extremo: la arista que cierra el anillo. Un trazo abierto se
  // rellena como su clausura, que es lo que el editor muestra mientras se dibuja.
  #promover({ ring, vertex, x, y }) {
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

  // Scissor: la caja del contorno en clip llevada a píxeles del framebuffer, con un píxel de holgura
  // para el borde de rasterización.
  #encuadrar(zoom, center, size, promo) {
    const gl = this.#gl, clip = this.#clip
    clip[0] = clip[1] = Infinity
    clip[2] = clip[3] = -Infinity
    for (let i = 0; i < this.rings.length; i++) {
      const arena  = this.rings[i].arena
      this.#arena  = arena
      this.#matriz = arena.matrixFor(zoom, center, size)
      arena.eachRange(this.#extenderCaja)
      if (promo?.ring === i) this.#extenderClip(promo.x, promo.y)
    }
    const w     = gl.drawingBufferWidth
    const h     = gl.drawingBufferHeight
    const x     = Math.max(0, Math.floor((clip[0] * 0.5 + 0.5) * w) - 1)
    const y     = Math.max(0, Math.floor((clip[1] * 0.5 + 0.5) * h) - 1)
    const ancho = Math.min(w, Math.ceil((clip[2] * 0.5 + 0.5) * w) + 1) - x
    const alto  = Math.min(h, Math.ceil((clip[3] * 0.5 + 0.5) * h) + 1) - y
    if (ancho <= 0 || alto <= 0) return false
    gl.enable(gl.SCISSOR_TEST)
    gl.scissor(x, y, ancho, alto)
    return true
  }

  #extenderCaja = (_ordinal, _first, count, chunk) => {
    if (!count) return
    const caja = this.#arena.boxOfChunk(chunk, this.#caja)
    this.#extenderClip(caja[0], caja[1])
    this.#extenderClip(caja[2], caja[3])
  }

  // La matriz del arena es escala + traslación, así que cada eje del clip depende sólo de su
  // coordenada: dos esquinas opuestas fijan la caja.
  #extenderClip(x, y) {
    const m = this.#matriz, clip = this.#clip
    const cx = m[0] * x + m[12]
    const cy = m[5] * y + m[13]
    if (cx < clip[0]) clip[0] = cx
    if (cy < clip[1]) clip[1] = cy
    if (cx > clip[2]) clip[2] = cx
    if (cy > clip[3]) clip[3] = cy
  }

  // El run de un chunk son parejas (vértice, midpoint) desde un local par: la mitad son vértices y van
  // de dos en dos en ref.
  #anotarRango = (_ordinal, first, count) => {
    if (!count) return
    if (this.#rangos === this.#firsts.length) {
      this.#firsts = crecer(this.#firsts)
      this.#verts  = crecer(this.#verts)
    }
    this.#firsts[this.#rangos] = first
    this.#verts[this.#rangos]  = count >> 1
    this.#rangos++
  }

  // Índice de la arista que ARRANCA en `u` dentro del rango `j`, o -1 si `u` no vive ahí.
  #aristaEn(j, u) {
    const first = this.#firsts[j]
    return u >= first && u < first + 2 * this.#verts[j] ? (u - first) >> 1 : -1
  }

  // Aristas [desde, hasta) del rango `j`. La última cierra contra el vértice que sigue: el de al lado
  // si el tramo no agota el rango, si no el primero del rango siguiente —y el del último rango es el
  // del primero, que es el cierre del anillo—.
  #tramo(j, desde, hasta) {
    if (hasta <= desde) return
    const gl    = this.#gl
    const first = this.#firsts[j]
    const tail  = hasta < this.#verts[j] ? first + 2 * hasta : this.#firsts[(j + 1) % this.#rangos]
    gl.uniform1i(this.#paridad.uFirst, first + 2 * desde)
    gl.uniform1i(this.#paridad.uEdges, hasta - desde)
    gl.uniform1i(this.#paridad.uTail, tail)
    gl.drawArrays(gl.TRIANGLES, 0, (hasta - desde) * 3)
  }

  #dibujarVivas(promo, zoom, center, size) {
    const gl = this.#gl, u = this.#vivas
    const arena = this.rings[promo.ring].arena
    gl.useProgram(u.program)
    gl.uniformMatrix4fv(u.uMatrix, false, arena.matrixFor(zoom, center, size))
    gl.uniform1i(u.uPrev, promo.prev)
    gl.uniform1i(u.uNext, promo.next)
    gl.uniform2f(u.uVivo, promo.x, promo.y)
    gl.bindTexture(gl.TEXTURE_2D, arena.texture)
    gl.drawArrays(gl.TRIANGLES, 0, 6)
  }

  #cubrir() {
    const gl = this.#gl, u = this.#cubierta, color = this.#rgba
    gl.useProgram(u.program)
    gl.colorMask(true, true, true, true)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    gl.stencilFunc(gl.NOTEQUAL, 0, BIT)
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.ZERO)
    gl.uniform4f(u.uColor, color[0], color[1], color[2], color[3])
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }
}
