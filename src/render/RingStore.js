import { ROLE } from '../geometry/ChunkedPath.js'
import { anchorMatrix } from './anchor-matrix.js'

// Espejo GPU de UN anillo estático: posiciones en una textura RG32F, relativas a un ancla propia.
// Expone el contrato que consumen el relleno y el trazo (`texture`, `anchor`, `matrixFor`, `eachRange`,
// `boxOfChunk`, más la topología `rev`/`roleAt`/`nextVertex`) con un único rango contiguo,
// sin la disciplina de chunks del arena editable.

const anchoDe = n => Math.min(2048, Math.max(1, 2 ** Math.ceil(Math.log2(Math.max(1, n)))))

// Camino rápido: el intercalado [lat, lng, …] que la librería ya usa puertas adentro. Cualquier otra
// forma —incluido un tipado de enteros, que truncaría las coordenadas— cae al camino genérico.
const esPlano = points => points instanceof Float64Array || points instanceof Float32Array

export class RingStore {

  #gl
  #rel     = new Float32Array(0)
  #texture = null
  #width   = 1
  #rows    = 1
  #count   = 0
  #anchorX = 0
  #anchorY = 0

  #matrix = new Float32Array(16)
  #box    = new Float64Array(4)      // caja del anillo en rel-ancla; la salida de boxOfChunk
  #out    = new Float64Array(4)
  #xy     = new Float64Array(2)      // salida del proyector, reusada [0-alloc]

  // `points` son pares [lat, lng], objetos {lat, lng}, o un Float64Array/Float32Array plano con
  // [lat, lng, …] intercalado; `project(lat, lng, out)` los baja a world0 px.
  constructor({ gl, points, project, textureWidth }) {
    this.#gl  = gl
    this.#rel = this.#proyectar(points, project)
    this.#subir(textureWidth)
  }

  get texture()      { return this.#texture }
  get textureWidth() { return this.#width }
  get anchor()       { return { x: this.#anchorX, y: this.#anchorY } }
  get rev()          { return 0 }              // inmutable: nada que resincronizar

  relX(ref) { return this.#rel[ref * 2] }
  relY(ref) { return this.#rel[ref * 2 + 1] }

  roleAt(ref)     { return ref >= 0 && ref < this.#count ? ROLE.vertex : ROLE.free }
  nextVertex(ref) { return ref + 1 < this.#count ? ref + 1 : 0 }

  eachRange(cb) { this.#count && cb(0, 0, this.#count, 0) }

  boxOfChunk(_chunk, out = this.#out) {
    out.set(this.#box)
    return out
  }

  matrixFor(zoom, center, size) {
    return anchorMatrix(this.#matrix, this.#anchorX, this.#anchorY, zoom, center, size)
  }

  destroy() {
    this.#texture && this.#gl.deleteTexture(this.#texture)
    this.#texture = null
    return this
  }

  // El ancla va al centro de la caja: mantiene los rel en pocos píxeles y a float32 le sobra mantisa.
  #proyectar(points, project) {
    const plano = esPlano(points)
    const n     = plano ? points.length >> 1 : points.length
    const w0    = new Float64Array(n * 2)
    const caja  = this.#box
    caja[0] = caja[1] = Infinity
    caja[2] = caja[3] = -Infinity
    plano ? this.#ingerirPlano(points, project, w0, n) : this.#ingerirPares(points, project, w0, n)
    this.#anchorX = n ? (caja[0] + caja[2]) / 2 : 0
    this.#anchorY = n ? (caja[1] + caja[3]) / 2 : 0
    const rel = new Float32Array(n * 2)
    for (let i = 0; i < n; i++) {
      rel[i * 2]     = w0[i * 2] - this.#anchorX
      rel[i * 2 + 1] = w0[i * 2 + 1] - this.#anchorY
    }
    caja[0] -= this.#anchorX
    caja[1] -= this.#anchorY
    caja[2] -= this.#anchorX
    caja[3] -= this.#anchorY
    this.#count = n
    return rel
  }

  // Las dos formas de entrada llevan bucle propio [0-alloc]: leer el vértice tras un lector común
  // vuelve megamórfico ese único call site y le cobraría el peaje también al camino rápido. Lo demás
  // —proyectar y estirar la caja— es idéntico a propósito.
  #ingerirPlano(points, project, w0, n) {
    const caja = this.#box
    for (let i = 0; i < n; i++) {
      project(points[i * 2], points[i * 2 + 1], this.#xy)
      const x = w0[i * 2]     = this.#xy[0]
      const y = w0[i * 2 + 1] = this.#xy[1]
      if (x < caja[0]) caja[0] = x
      if (y < caja[1]) caja[1] = y
      if (x > caja[2]) caja[2] = x
      if (y > caja[3]) caja[3] = y
    }
  }

  #ingerirPares(points, project, w0, n) {
    const caja = this.#box
    for (let i = 0; i < n; i++) {
      const p = points[i]
      project(Array.isArray(p) ? p[0] : p.lat, Array.isArray(p) ? p[1] : p.lng, this.#xy)
      const x = w0[i * 2]     = this.#xy[0]
      const y = w0[i * 2 + 1] = this.#xy[1]
      if (x < caja[0]) caja[0] = x
      if (y < caja[1]) caja[1] = y
      if (x > caja[2]) caja[2] = x
      if (y > caja[3]) caja[3] = y
    }
  }

  #subir(textureWidth) {
    const gl = this.#gl
    this.#width = textureWidth ?? anchoDe(this.#count)
    this.#rows  = Math.max(1, Math.ceil(this.#count / this.#width))
    const datos = new Float32Array(this.#width * this.#rows * 2)
    datos.set(this.#rel)
    this.#texture = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, this.#texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, this.#width, this.#rows, 0, gl.RG, gl.FLOAT, datos)
  }
}
