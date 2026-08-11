import { ROLE } from '../geometry/ChunkedPath.js'
import { anchorMatrix } from './anchor-matrix.js'

// Espejo GPU de anillos ESTÁTICOS: posiciones en una textura RG32F, relativas a un ancla propia.
// Expone el contrato que consumen el relleno y el trazo (`texture`, `anchor`, `matrixFor`, `eachRange`,
// `boxOfChunk`, más la topología `rev`/`roleAt`/`nextVertex`) sin la disciplina de chunks del arena
// editable.
//
// Uno o muchos anillos comparten la MISMA textura. El pase de paridad del relleno encadena entre sí los
// rangos que recibe —el cierre de uno busca el primer vértice del siguiente—, así que con más de un
// anillo el relleno consume `viewOf(r)`: una vista emite un solo rango y cierra contra sí misma.

// Tope cuando el contexto no declara el suyo; todo WebGL2 real garantiza al menos 2048.
const MAX_TEXTURE = 2048

const widthFor = (n, max) => Math.min(max, 2 ** Math.ceil(Math.log2(Math.max(1, n))))

// Camino rápido: el intercalado [lat, lng, …] que la librería ya usa puertas adentro. Cualquier otra
// forma —incluido un tipado de enteros, que truncaría las coordenadas— cae al camino genérico.
const isFlat = points => points instanceof Float64Array || points instanceof Float32Array

// Vista de UN anillo del store con el contrato de arena: la textura es la del store; el ancla y la
// matriz son las del anillo.
class RingView {

  #store; #ring; #first; #count

  constructor(store, ring, first, count) {
    this.#store = store
    this.#ring  = ring
    this.#first = first
    this.#count = count
  }

  get texture()      { return this.#store.texture }
  get textureWidth() { return this.#store.textureWidth }
  get anchor()       { return this.#store.anchorOf(this.#ring) }
  get rev()          { return 0 }
  get firstVertex()  { return this.#first }
  get lastVertex()   { return this.#first + this.#count - 1 }

  relX(ref) { return this.#store.relX(ref) }
  relY(ref) { return this.#store.relY(ref) }

  roleAt(ref)     { return ref >= this.#first && ref < this.#first + this.#count ? ROLE.vertex : ROLE.free }
  nextVertex(ref) { return ref + 1 < this.#first + this.#count ? ref + 1 : this.#first }
  prevVertex(ref) { return ref > this.#first ? ref - 1 : this.#first + this.#count - 1 }

  eachRange(cb) { this.#count && cb(0, this.#first, this.#count, this.#ring) }

  boxOfChunk(chunk, out) { return this.#store.boxOfChunk(chunk, out) }

  matrixFor(zoom, center, size) { return this.#store.matrixOf(this.#ring, zoom, center, size) }
}

export class RingStore {

  #gl
  #rel     = new Float32Array(0)
  #texture = null
  #width   = 1
  #rows    = 1
  #count   = 0
  #anchorX = 0
  #anchorY = 0

  #anchors  = new Float64Array(2)    // [x, y] por anillo, en world0 px
  #vertexAt = new Uint32Array(2)     // CSR anillo → primer vértice, ya sin el vértice de cierre
  #boxes    = new Float64Array(4)    // caja por anillo, relativa al ancla DE ESE anillo; el `chunk` de
                                     // boxOfChunk es el anillo
  #views    = null

  #matrix = new Float32Array(16)
  #out    = new Float64Array(4)
  #xy     = new Float64Array(2)      // salida del proyector, reusada [0-alloc]

  // Un anillo suelto por `points`: pares [lat, lng], objetos {lat, lng}, o un Float64Array/Float32Array
  // plano con [lat, lng, …] intercalado. Muchos anillos por `rings`, la geometría tipada del lector:
  // `{ xy, vertexAt, ringCount, closed }` con `xy` en [lng, lat, …] —orden del RFC—, y `ringIds`
  // opcional para restringir la ingesta a esos anillos.
  // `project(lat, lng, out)` los baja a world0 px.
  constructor({ gl, points, rings, project, textureWidth }) {
    this.#gl  = gl
    this.#rel = rings ? this.#projectRings(rings, project) : this.#projectPoints(points, project)
    this.#upload(textureWidth)
  }

  get texture()      { return this.#texture }
  get textureWidth() { return this.#width }
  get anchor()       { return { x: this.#anchorX, y: this.#anchorY } }
  get rev()          { return 0 }              // inmutable: nada que resincronizar
  get ringCount()    { return this.#vertexAt.length - 1 }
  get vertexCount()  { return this.#count }

  anchorOf(ring) { return { x: this.#anchors[ring * 2], y: this.#anchors[ring * 2 + 1] } }

  matrixOf(ring, zoom, center, size) {
    return anchorMatrix(this.#matrix, this.#anchors[ring * 2], this.#anchors[ring * 2 + 1], zoom, center, size)
  }

  relX(ref) { return this.#rel[ref * 2] }
  relY(ref) { return this.#rel[ref * 2 + 1] }

  roleAt(ref)     { return ref >= 0 && ref < this.#count ? ROLE.vertex : ROLE.free }
  nextVertex(ref) { return ref + 1 < this.#count ? ref + 1 : 0 }

  // Un rango por anillo, en el orden de la textura.
  eachRange(cb) {
    for (let r = 0, n = this.ringCount; r < n; r++) {
      const first = this.#vertexAt[r]
      const count = this.#vertexAt[r + 1] - first
      count && cb(r, first, count, r)
    }
  }

  // Vista con el contrato de arena para UN anillo. Estable entre llamadas: el mismo `ring` devuelve
  // siempre la misma vista.
  viewOf(ring) {
    if (!this.#texture) return null
    this.#views ??= Array.from({ length: this.ringCount }, (_, r) =>
      new RingView(this, r, this.#vertexAt[r], this.#vertexAt[r + 1] - this.#vertexAt[r]))
    return this.#views[ring]
  }

  // Caja del anillo en world0 px, que es el espacio del viewport.
  worldBoxOf(ring, out) {
    const b  = ring * 4
    const ax = this.#anchors[ring * 2]
    const ay = this.#anchors[ring * 2 + 1]
    out[0] = this.#boxes[b] + ax
    out[1] = this.#boxes[b + 1] + ay
    out[2] = this.#boxes[b + 2] + ax
    out[3] = this.#boxes[b + 3] + ay
    return out
  }

  boxOfChunk(chunk, out = this.#out) {
    const b = chunk * 4
    out[0] = this.#boxes[b]
    out[1] = this.#boxes[b + 1]
    out[2] = this.#boxes[b + 2]
    out[3] = this.#boxes[b + 3]
    return out
  }

  matrixFor(zoom, center, size) {
    return anchorMatrix(this.#matrix, this.#anchorX, this.#anchorY, zoom, center, size)
  }

  destroy() {
    this.#texture && this.#gl.deleteTexture(this.#texture)
    this.#texture = null
    this.#views   = null
    return this
  }

  #projectPoints(points, project) {
    const flat = isFlat(points)
    const n    = flat ? points.length >> 1 : points.length
    const w0   = new Float64Array(n * 2)
    const box  = this.#boxes
    box[0] = box[1] = Infinity
    box[2] = box[3] = -Infinity
    flat ? this.#ingestFlat(points, project, w0, n) : this.#ingestPairs(points, project, w0, n)
    this.#vertexAt = Uint32Array.of(0, n)
    return this.#relativize(w0, n)
  }

  // Un solo bucle sobre `xy` para TODOS los anillos: la caja de cada uno se cierra al terminarlo y
  // estira la global. `closed[r]` descarta el vértice que repite al primero, que el abanico de paridad
  // cierra por su cuenta.
  #projectRings({ xy, vertexAt, ringCount, closed, ringIds }, project) {
    const total  = ringIds ? ringIds.length : ringCount
    const ringAt = k => ringIds ? ringIds[k] : k
    let vertices = 0
    for (let k = 0; k < total; k++) {
      const r = ringAt(k)
      vertices += vertexAt[r + 1] - vertexAt[r] - (closed?.[r] ? 1 : 0)
    }
    const w0     = new Float64Array(vertices * 2)
    const boxes  = new Float64Array(total * 4)
    const starts = new Uint32Array(total + 1)
    let n = 0
    for (let k = 0; k < total; k++) {
      const r   = ringAt(k)
      const end = vertexAt[r + 1] - (closed?.[r] ? 1 : 0)
      const b   = k * 4
      boxes[b] = boxes[b + 1] = Infinity
      boxes[b + 2] = boxes[b + 3] = -Infinity
      for (let i = vertexAt[r]; i < end; i++, n++) {
        project(xy[i * 2 + 1], xy[i * 2], this.#xy)
        const x = w0[n * 2]     = this.#xy[0]
        const y = w0[n * 2 + 1] = this.#xy[1]
        if (x < boxes[b])     boxes[b]     = x
        if (y < boxes[b + 1]) boxes[b + 1] = y
        if (x > boxes[b + 2]) boxes[b + 2] = x
        if (y > boxes[b + 3]) boxes[b + 3] = y
      }
      starts[k + 1] = n
    }
    this.#vertexAt = starts
    this.#boxes    = boxes
    return this.#relativize(w0, n)
  }

  // Un bucle por forma de entrada: un lector común volvería megamórfico ese call site, que es [0-alloc].
  #ingestFlat(points, project, w0, n) {
    const box = this.#boxes
    for (let i = 0; i < n; i++) {
      project(points[i * 2], points[i * 2 + 1], this.#xy)
      const x = w0[i * 2]     = this.#xy[0]
      const y = w0[i * 2 + 1] = this.#xy[1]
      if (x < box[0]) box[0] = x
      if (y < box[1]) box[1] = y
      if (x > box[2]) box[2] = x
      if (y > box[3]) box[3] = y
    }
  }

  #ingestPairs(points, project, w0, n) {
    const box = this.#boxes
    for (let i = 0; i < n; i++) {
      const p = points[i]
      project(Array.isArray(p) ? p[0] : p.lat, Array.isArray(p) ? p[1] : p.lng, this.#xy)
      const x = w0[i * 2]     = this.#xy[0]
      const y = w0[i * 2 + 1] = this.#xy[1]
      if (x < box[0]) box[0] = x
      if (y < box[1]) box[1] = y
      if (x > box[2]) box[2] = x
      if (y > box[3]) box[3] = y
    }
  }

  // Cada anillo se guarda relativo a SU ancla, el centro de su caja: así el rel queda en pocos píxeles
  // y a float32 le sobra mantisa. Un ancla común haría crecer el rel con la extensión del conjunto, y
  // el error de float32 con él. Las cajas quedan en ese mismo espacio, el que leen el relleno y el
  // trazo por `boxOfChunk`.
  #relativize(w0, n) {
    const rings   = this.ringCount
    const anchors = new Float64Array(rings * 2)
    const rel     = new Float32Array(n * 2)
    for (let r = 0; r < rings; r++) {
      const b     = r * 4
      const first = this.#vertexAt[r]
      const end   = this.#vertexAt[r + 1]
      const ax    = anchors[r * 2]     = first < end ? (this.#boxes[b] + this.#boxes[b + 2]) / 2 : 0
      const ay    = anchors[r * 2 + 1] = first < end ? (this.#boxes[b + 1] + this.#boxes[b + 3]) / 2 : 0
      for (let i = first; i < end; i++) {
        rel[i * 2]     = w0[i * 2] - ax
        rel[i * 2 + 1] = w0[i * 2 + 1] - ay
      }
      this.#boxes[b]     -= ax
      this.#boxes[b + 1] -= ay
      this.#boxes[b + 2] -= ax
      this.#boxes[b + 3] -= ay
    }
    this.#anchors = anchors
    this.#anchorX = rings ? anchors[0] : 0
    this.#anchorY = rings ? anchors[1] : 0
    this.#count   = n
    return rel
  }

  // El ancho sale del tope REAL del contexto, no de una constante: con el tope fijo en 2048 un conteo
  // grande pide más filas de las que la GPU acepta y la textura queda corta, que se ve como geometría
  // faltante y no como error.
  #upload(textureWidth) {
    const gl        = this.#gl
    const declarado = gl.MAX_TEXTURE_SIZE === undefined ? null : gl.getParameter?.(gl.MAX_TEXTURE_SIZE)
    const max       = Number.isFinite(declarado) && declarado >= 1 ? declarado : MAX_TEXTURE
    this.#width = textureWidth ?? widthFor(this.#count, max)
    this.#rows  = Math.max(1, Math.ceil(this.#count / this.#width))
    if (this.#rows > max)
      throw new Error(`[cristae] ${this.#count} vértices no entran en una textura de ${max}×${max}`)
    const data  = new Float32Array(this.#width * this.#rows * 2)
    data.set(this.#rel)
    this.#texture = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, this.#texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, this.#width, this.#rows, 0, gl.RG, gl.FLOAT, data)
  }
}
