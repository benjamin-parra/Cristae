// Espejo GPU del arena editable, indexado por REF 1:1 con el `ChunkedPath`: una textura RG32F de
// posiciones —la que leen relleno y trazo por `texelFetch`— y un VBO interleaved de 7 floats por entrada
// en el layout de glify, del que salen los handles y el pase de picking.
//
// Las posiciones van PROYECTADAS a world0 y RELATIVAS AL ANCLA, el centro del bbox congelado en `reset`:
// float32 alcanza a z18 y el desplazamiento absoluto vive en la matriz, así que el pan y el zoom no
// reescriben un byte. El batching se numera por el ORDINAL del chunk en el orden del TRAZO, no por su
// índice en el arena —que duplica al crecer—, porque el pase de picking lo direcciona con 6 bits.
import { ROLE } from '../geometry/ChunkedPath.js'
import { anchorMatrix } from './anchor-matrix.js'

const FLOATS_PER_ENTRY = 7                       // [x, y, tile, angle, b, a, size]
const BYTES_PER_ENTRY  = FLOATS_PER_ENTRY * 4

// Tile y tamaño por ROL. El midpoint inactivo (`ROLE.free`, y vive DENTRO del run) sale con el tile
// transparente: una escritura, sin excepción en el batch.
const TILES = [2, 0, 1]
const SIZES = [10, 12, 10]

const EMPTY = [Infinity, Infinity, -Infinity, -Infinity]

const resize = (Ctor, src, length) => {
  if (src.length === length) return src
  const out = new Ctor(length)
  out.set(length < src.length ? src.subarray(0, length) : src)
  return out
}

const clear = (box, o) => box.set(EMPTY, o)

const union = (box, o, x, y) => {
  box[o]     = Math.min(box[o],     x)
  box[o + 1] = Math.min(box[o + 1], y)
  box[o + 2] = Math.max(box[o + 2], x)
  box[o + 3] = Math.max(box[o + 3], y)
}

export class EditArena {

  #gl; #path; #project; #width; #shift; #tiles; #sizes

  #pos       = new Float32Array(0)   // espejo de la textura: [x,y] por ref, con las filas completas
  #vert      = new Float32Array(0)   // espejo del VBO
  #box       = new Float64Array(0)   // [minX,minY,maxX,maxY] por chunk, en rel-ancla
  #rev       = new Int32Array(0)     // `chunkRev` del último sync
  #seen      = new Int32Array(0)     // generación de sync en la que el chunk estaba en la lista
  #ordinalOf = new Int32Array(0)
  #chunkOf   = new Int32Array(0)

  #texture  = null
  #vbo      = null
  #chunks   = 0
  #rows     = 0
  #ordinals = 0
  #gen      = 0
  #anchorX  = 0
  #anchorY  = 0

  #matrix  = new Float32Array(16)
  #xy      = new Float64Array(2)     // salida del proyector, reusada [0-alloc]
  #hull    = new Float64Array(4)
  #out     = new Float64Array(4)

  // `project(x, y, out)` lleva el par que guarda el trazo a world0 px en float64 y escribe en `out`.
  constructor({ gl, path, project, textureWidth = 2048, tiles = TILES, sizes = SIZES }) {
    if (textureWidth & (textureWidth - 1))
      throw new Error('[cristae] el ancho de la textura de posiciones tiene que ser potencia de dos: '
        + 'el índice→texel es una máscara')
    this.#gl      = gl
    this.#path    = path
    this.#project = project
    this.#width   = textureWidth
    this.#shift   = Math.log2(textureWidth)
    this.#tiles   = tiles
    this.#sizes   = sizes
    this.reset()
  }

  get texture()       { return this.#texture }
  get vbo()           { return this.#vbo }
  get textureWidth()  { return this.#width }
  get textureHeight() { return this.#rows }
  get capacity()      { return this.#chunks * this.#path.entriesPerChunk }
  get ordinalCount()  { return this.#ordinals }
  get anchor()        { return { x: this.#anchorX, y: this.#anchorY } }

  relX(ref) { return this.#pos[ref * 2] }
  relY(ref) { return this.#pos[ref * 2 + 1] }

  // Re-ingesta completa, y ÚNICO punto donde el ancla se congela. El ancla es el centro del bbox
  // proyectado, y el abanico del relleno la exige MISMA para todos los chunks y anillos del objeto.
  reset() {
    const path = this.#path
    const box  = this.#hull
    const xy   = this.#xy
    this.#allocate()
    this.#rev.fill(-1)                           // nada del sync anterior sobrevive a una re-ingesta
    clear(box, 0)
    path.forEachVertex((x, y) => {
      this.#project(x, y, xy)
      union(box, 0, xy[0], xy[1])
    })
    this.#anchorX = path.length ? (box[0] + box[2]) / 2 : 0
    this.#anchorY = path.length ? (box[1] + box[3]) / 2 : 0
    return this.#reload()
  }

  // El arena duplicó. Los refs vivos NO se mueven —el stride es fijo—, así que el espejo se copia tal
  // cual y lo único que se rehace son la textura y el VBO.
  grow() {
    this.#allocate()
    return this.#reload()
  }

  // Tras la edición estructural, sin decirle qué se editó: renumera los ordinales y sube los chunks cuya
  // revisión de contenido no es la del último sync. O(chunks), no O(N). `setClosed` no es estructural: se
  // refleja con `writeEntry(lastVertex)`.
  syncStructure() {
    if (this.#path.chunkCount !== this.#chunks) return this.grow()
    const path = this.#path
    // El run del chunk, y además el midpoint que CRUZA hacia él: ése lo posee el vértice anterior, que
    // vive en el chunk previo del trazo —o en el último, si el anillo cierra—. Va sin texel: la textura
    // sólo lleva vértices.
    this.#relist(k => {
      const first = path.chunkFirst(k)
      this.writeRange(k, first, first + path.chunkUsed(k))
      const prev = path.prevVertex(k * path.entriesPerChunk + first)
      if (prev < 0 || path.chunkOf(prev) === k) return
      this.#mirror(prev + 1)
      this.#stretch(path.chunkOf(prev), prev + 1)
      this.#uploadVerts(prev + 1, prev + 1)
    })
    return this
  }

  // Commit de un vértice movido: toca el vértice, su midpoint y el del anterior, y ese último puede vivir
  // en otro chunk y partir la escritura del VBO en dos. En la textura sólo entra el vértice: el midpoint
  // es afordancia del VBO.
  writeEntry(ref) {
    const path = this.#path
    if (path.roleAt(ref) !== ROLE.vertex) return false
    const prev = path.prevVertex(ref)
    const mid  = prev >= 0 ? prev + 1 : -1

    this.#mirror(ref)
    this.#mirror(ref + 1)
    this.#stretch(path.chunkOf(ref), ref)
    this.#stretch(path.chunkOf(ref), ref + 1)
    if (mid >= 0) {
      this.#mirror(mid)
      this.#stretch(path.chunkOf(mid), mid)
    }

    this.#uploadTexels(ref, ref)
    if (prev < 0)              this.#uploadVerts(ref, ref + 1)
    else if (prev === ref - 2) this.#uploadVerts(mid, ref + 1)       // el anterior es contiguo en el arena
    else {
      this.#uploadVerts(ref, ref + 1)
      this.#uploadVerts(mid, mid)
    }
    return true
  }

  // El run se desplazó: el tramo se reescribe entero y el bbox del chunk vuelve a ser EXACTO —el único
  // momento en que puede encoger—. El tramo se acota al chunk: un `hi` de más sería contenido ajeno.
  writeRange(chunk, lo, hi) {
    const cap  = this.#path.entriesPerChunk
    const from = chunk * cap + Math.max(0, lo)
    const to   = chunk * cap + Math.min(cap, hi)
    if (to <= from) return false
    this.#mirrorRun(from, to)
    this.#exactBox(chunk)
    this.#uploadTexels(from, to - 1)
    this.#uploadVerts(from, to - 1)
    return true
  }

  // Rangos de dibujo en orden de TRAZO —un draw por chunk— sobre la tabla de ordinales, que es la misma
  // numeración que decodifica el pick. [0-alloc]: `cb(ordinal, first, count, chunk)`.
  eachRange(cb) {
    const path = this.#path
    const cap  = path.entriesPerChunk
    for (let o = 0; o < this.#ordinals; o++) {
      const k = this.#chunkOf[o]
      cb(o, k * cap + path.chunkFirst(k), path.chunkUsed(k), k)
    }
  }

  chunkOfOrdinal(ordinal) { return ordinal >= 0 && ordinal < this.#ordinals ? this.#chunkOf[ordinal] : -1 }
  ordinalOfChunk(chunk)   { return this.#seen[chunk] === this.#gen ? this.#ordinalOf[chunk] : -1 }

  // Decode del pick: el ordinal viaja en 6 bits, el ref vive en el arena.
  refAt(ordinal, local) {
    const k = this.chunkOfOrdinal(ordinal)
    return k < 0 ? -1 : k * this.#path.entriesPerChunk + local
  }

  // `out` es un cuádruple reusado, válido hasta la próxima llamada. [0-alloc]
  boxOfChunk(chunk, out = this.#out) {
    const o = chunk * 4
    out[0] = this.#box[o]
    out[1] = this.#box[o + 1]
    out[2] = this.#box[o + 2]
    out[3] = this.#box[o + 3]
    return out
  }

  matrixFor(zoom, center, size) {
    return anchorMatrix(this.#matrix, this.#anchorX, this.#anchorY, zoom, center, size)
  }

  destroy() {
    if (!this.#texture) return this
    this.#gl.deleteTexture(this.#texture)
    this.#gl.deleteBuffer(this.#vbo)
    this.#texture = this.#vbo = null
    return this
  }

  // Espejo del run vivo de cada chunk, y una sola subida entera.
  #reload() {
    const gl   = this.#gl
    const path = this.#path
    this.#relist(k => {
      const from = k * path.entriesPerChunk + path.chunkFirst(k)
      this.#mirrorRun(from, from + path.chunkUsed(k))
      this.#exactBox(k)
    })
    gl.bindTexture(gl.TEXTURE_2D, this.#texture)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, this.#width, this.#rows, 0, gl.RG, gl.FLOAT, this.#pos)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#vbo)
    gl.bufferData(gl.ARRAY_BUFFER, this.#vert, gl.DYNAMIC_DRAW)
    return this
  }

  // Renumera los ordinales del trazo y entrega a `write` los chunks cuyo contenido se movió desde el
  // último sync. La revisión es el único testigo que sirve: la firma (first, used) vuelve INTACTA cuando
  // se borra el arranque del run y el borrow sale del chunk anterior.
  #relist(write) {
    const path = this.#path
    const gen  = ++this.#gen
    let ordinal = 0
    for (let k = path.firstChunk; k >= 0; k = path.chunkNext(k), ordinal++) {
      const rev   = path.chunkRev(k)
      const stale = this.#rev[k] !== rev
      this.#seen[k]          = gen
      this.#ordinalOf[k]     = ordinal
      this.#chunkOf[ordinal] = k
      this.#rev[k]           = rev
      if (stale) write(k)
    }
    this.#ordinals = ordinal
  }

  // [0-alloc]
  #mirrorRun(from, to) {
    for (let ref = from; ref < to; ref++) this.#mirror(ref)
  }

  // Una entrada en las dos copias: la posición proyectada rel-ancla, y los 7 floats del layout de glify
  // con el id del picking (`local + 1`) repartido en los canales b,a. La paridad del local es el kind, así
  // que el rol elige tile y tamaño sin bit extra. [0-alloc]
  #mirror(ref) {
    const path = this.#path
    const id   = path.localOf(ref) + 1
    const role = path.roleAt(ref)
    this.#project(path.xAt(ref), path.yAt(ref), this.#xy)
    const x = this.#xy[0] - this.#anchorX
    const y = this.#xy[1] - this.#anchorY
    const p = ref * 2
    const v = ref * FLOATS_PER_ENTRY
    this.#pos[p]      = x
    this.#pos[p + 1]  = y
    this.#vert[v]     = x
    this.#vert[v + 1] = y
    this.#vert[v + 2] = this.#tiles[role]
    this.#vert[v + 3] = 0                        // ángulo: los handles no rotan
    this.#vert[v + 4] = (id >> 8) / 255
    this.#vert[v + 5] = (id & 255) / 255
    this.#vert[v + 6] = this.#sizes[role]
  }

  // El bbox de chunk crece por unión y NUNCA encoge al mover: encogerlo dejaría al abanico fuera del rect
  // que se auto-limpia.
  #stretch(k, ref) {
    union(this.#box, k * 4, this.#pos[ref * 2], this.#pos[ref * 2 + 1])
  }

  #exactBox(k) {
    const path = this.#path
    const o    = k * 4
    const from = k * path.entriesPerChunk + path.chunkFirst(k)
    const to   = from + path.chunkUsed(k)
    clear(this.#box, o)
    for (let ref = from; ref < to; ref++) union(this.#box, o, this.#pos[ref * 2], this.#pos[ref * 2 + 1])
  }

  #allocate() {
    const gl      = this.#gl
    const path    = this.#path
    const entries = path.chunkCount * path.entriesPerChunk
    this.#rows      = Math.max(1, Math.ceil(entries / this.#width))
    this.#pos       = resize(Float32Array, this.#pos,       this.#width * this.#rows * 2)
    this.#vert      = resize(Float32Array, this.#vert,      entries * FLOATS_PER_ENTRY)
    this.#box       = resize(Float64Array, this.#box,       path.chunkCount * 4)
    this.#rev       = resize(Int32Array,   this.#rev,       path.chunkCount)
    this.#seen      = resize(Int32Array,   this.#seen,      path.chunkCount)
    this.#ordinalOf = resize(Int32Array,   this.#ordinalOf, path.chunkCount)
    this.#chunkOf   = resize(Int32Array,   this.#chunkOf,   path.chunkCount)
    this.#chunks    = path.chunkCount
    if (!this.#texture) {
      // NEAREST y CLAMP porque no es una imagen: es un array de posiciones direccionado por
      // `texelFetch`, y filtrar o repetir sería interpolar coordenadas.
      this.#texture = gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D, this.#texture)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    }
    this.#vbo ??= gl.createBuffer()
  }

  // Filas ENTERAS cuando el tramo cruza la frontera de fila: la fuente es el espejo, así que rescribir los
  // texels vecinos con su valor actual es inocuo y deja la subida en UNA llamada, sin `UNPACK_ROW_LENGTH`.
  #uploadTexels(from, to) {
    const gl     = this.#gl
    const row    = from >> this.#shift
    const last   = to >> this.#shift
    const oneRow = row === last
    const start  = oneRow ? from : row << this.#shift
    gl.bindTexture(gl.TEXTURE_2D, this.#texture)
    gl.texSubImage2D(gl.TEXTURE_2D, 0, start - (row << this.#shift), row,
      oneRow ? to - from + 1 : this.#width, last - row + 1, gl.RG, gl.FLOAT, this.#pos, start * 2)
  }

  #uploadVerts(from, to) {
    const gl = this.#gl
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#vbo)
    gl.bufferSubData(gl.ARRAY_BUFFER, from * BYTES_PER_ENTRY, this.#vert,
      from * FLOATS_PER_ENTRY, (to - from + 1) * FLOATS_PER_ENTRY)
  }
}
