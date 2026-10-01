import { anchorMatrix } from './anchor-matrix.js'

// Vértices de las PARTES de una capa de líneas, en texturas que el `StrokePass` lee por índice: las
// posiciones relativas al ancla de cada parte (RG32F), el largo acumulado por vértice (R32F, sólo si
// algo dibuja con dash) y el color por vértice (RGBA8, sólo con gradiente). Los tres comparten el
// índice, así que una parte es UN rango en cada uno.
//
// A diferencia del `RingStore`, que es inmutable, acá una parte se reescribe y CRECE. El espejo en CPU
// es lo que permite tanto subir sólo las filas tocadas como rehacer la textura entera cuando falta
// lugar. Cada parte tiene un hueco (`room`) de al menos sus vértices: reescribir sin crecer y agregar
// al final del hueco suben sólo lo escrito, y quien lo desborda se muda a un hueco nuevo, el doble de
// grande, así que agregar un vértice cuesta O(1) amortizado. El hueco que queda atrás es basura, y
// cuando ya es la mitad de lo usado se compacta el arreglo entero, que cuesta lo que se descartó.
//
// El ancla de una parte la fija su escritura entera (el centro de su caja) y no se mueve al agregar:
// un vértice lejano pierde algo de precisión float32 antes que reescribir todo el rango.

// Tope del ANCHO de la textura; las filas crecen debajo.
const MAX_WIDTH = 2048
const MIN_SIZE  = 256

const sizeFor = n => 2 ** Math.ceil(Math.log2(Math.max(MIN_SIZE, n)))

class LineView {

  #store; #slot

  constructor(store, slot) {
    this.#store = store
    this.#slot  = slot
  }

  get texture()      { return this.#store.texture }
  get textureWidth() { return this.#store.textureWidth }
  get arcTexture()   { return this.#store.arcTexture }
  get colorTexture() { return this.#store.colorTexture }
  get firstVertex()  { return this.#store.firstOf(this.#slot) }
  get lastVertex()   { return this.#store.firstOf(this.#slot) + this.#store.countOf(this.#slot) - 1 }

  matrixFor(zoom, center, size) { return this.#store.matrixOf(this.#slot, zoom, center, size) }
}

export class LineStore {

  #gl; #gradient
  #size         = 0                    // vértices que caben, potencia de 2
  #used         = 0                    // marca de agua del arreglo: lo que hay detrás está libre
  #garbage      = 0                    // huecos abandonados por las partes que se mudaron o se fueron
  #width        = 1
  #rel          = new Float32Array(0)  // [x, y] por vértice, relativo al ancla de su parte
  #arcs         = new Float32Array(0)
  #rgba         = new Uint8Array(0)    // sólo con gradiente: sin él queda vacío
  #texture      = null
  #arcTexture   = null
  #colorTexture = null

  #first  = []                         // por parte (slot): primer vértice, o -1 si el slot está libre
  #count  = []
  #room   = []
  #ax     = []
  #ay     = []
  #free   = []
  #views  = []
  #matrix = new Float32Array(16)

  constructor({ gl, gradient = false }) {
    this.#gl       = gl
    this.#gradient = gradient
  }

  get texture()      { return this.#texture }
  get textureWidth() { return this.#width }
  get colorTexture() { return this.#colorTexture }
  get slotCount()    { return this.#first.length }

  // Se arma al primer pedido y la textura nueva queda ligada a la unidad activa: quien dibuja la pide
  // ANTES de ligar las suyas.
  get arcTexture() {
    return this.#arcTexture ??= this.#texture && this.#image(this.#gl.createTexture(), this.#gl.R32F, this.#gl.RED, this.#arcs)
  }

  firstOf(slot) { return this.#first[slot] }
  countOf(slot) { return this.#count[slot] }
  viewOf(slot)  { return this.#views[slot] ??= new LineView(this, slot) }

  matrixOf(slot, zoom, center, size) {
    return anchorMatrix(this.#matrix, this.#ax[slot], this.#ay[slot], zoom, center, size)
  }

  // `xy` son `n` pares en world0 px y `rgba` sus `n` colores de 4 bytes, que sólo se leen con gradiente.
  add(xy, n, rgba) {
    const slot = this.#free.pop() ?? this.#first.length
    this.#first[slot] = this.#reserve(n)
    this.#room[slot]  = n
    this.#count[slot] = 0
    this.#anchor(slot, xy, n)
    this.#upload(this.#write(slot, xy, n, rgba), n)
    return slot
  }

  // Reemplaza la parte entera, con ancla nueva: en su hueco si entra y, si no, en uno mayor.
  rewrite(slot, xy, n, rgba) {
    if (n > this.#room[slot]) {
      const room = Math.max(n, this.#room[slot] * 2)
      const to = this.#reserve(room)
      this.#garbage += this.#room[slot]
      this.#first[slot] = to
      this.#room[slot]  = room
    }
    this.#count[slot] = 0
    this.#anchor(slot, xy, n)
    this.#upload(this.#write(slot, xy, n, rgba), n)
  }

  // Suma `n` vértices al final. Si el hueco no alcanza, la parte se muda a uno del doble.
  append(slot, xy, n, rgba) {
    const need = this.#count[slot] + n
    if (need > this.#room[slot]) {
      const room = Math.max(need, this.#room[slot] * 2)
      const to   = this.#reserve(room)          // puede compactar: el origen se lee DESPUÉS
      const from = this.#first[slot]
      const used = this.#count[slot]
      this.#rel.copyWithin(to * 2, from * 2, (from + used) * 2)
      this.#arcs.copyWithin(to, from, from + used)
      this.#rgba.copyWithin(to * 4, from * 4, (from + used) * 4)
      this.#garbage += this.#room[slot]
      this.#first[slot] = to
      this.#room[slot]  = room
      this.#write(slot, xy, n, rgba)
      this.#upload(to, used + n)
      return
    }
    this.#upload(this.#write(slot, xy, n, rgba), n)
  }

  remove(slot) {
    this.#garbage += this.#room[slot]
    this.#first[slot] = -1
    this.#room[slot]  = this.#count[slot] = 0
    this.#free.push(slot)
  }

  destroy() {
    ;[this.#texture, this.#arcTexture, this.#colorTexture].forEach(t => t && this.#gl.deleteTexture(t))
    this.#texture = this.#arcTexture = this.#colorTexture = null
    this.#first.length = 0
    this.#views.length = 0
    return this
  }

  #anchor(slot, xy, n) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (let i = 0; i < n; i++) {
      const x = xy[i * 2], y = xy[i * 2 + 1]
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
    this.#ax[slot] = (minX + maxX) / 2
    this.#ay[slot] = (minY + maxY) / 2
  }

  // `n` vértices a continuación de los que ya tiene la parte; devuelve el índice del primero.
  #write(slot, xy, n, rgba) {
    const first = this.#first[slot]
    const at    = first + this.#count[slot]
    const rel   = this.#rel
    const arcs  = this.#arcs
    for (let g = at; g < at + n; g++) {
      rel[g * 2]     = xy[(g - at) * 2]     - this.#ax[slot]
      rel[g * 2 + 1] = xy[(g - at) * 2 + 1] - this.#ay[slot]
      const dx = rel[g * 2] - rel[g * 2 - 2]
      const dy = rel[g * 2 + 1] - rel[g * 2 - 1]
      arcs[g] = g > first ? arcs[g - 1] + Math.sqrt(dx * dx + dy * dy) : 0
    }
    this.#gradient && this.#rgba.set(rgba.subarray(0, n * 4), at * 4)
    this.#count[slot] += n
    return at
  }

  #reserve(room) {
    if (this.#used + room > this.#size && this.#garbage * 2 >= this.#used) this.#compact()
    if (this.#used + room > this.#size) this.#grow(this.#used + room)
    this.#used += room
    return this.#used - room
  }

  // Las partes vivas, juntas y en orden de slot, con su hueco intacto.
  #compact() {
    const rel  = new Float32Array(this.#size * 2)
    const arcs = new Float32Array(this.#size)
    const rgba = this.#gradient ? new Uint8Array(this.#size * 4) : this.#rgba
    let at = 0
    for (let slot = 0; slot < this.#first.length; slot++) {
      const from = this.#first[slot]
      if (from < 0) continue
      const end = from + this.#count[slot]
      rel.set(this.#rel.subarray(from * 2, end * 2), at * 2)
      arcs.set(this.#arcs.subarray(from, end), at)
      this.#gradient && rgba.set(this.#rgba.subarray(from * 4, end * 4), at * 4)
      this.#first[slot] = at
      at += this.#room[slot]
    }
    this.#rel     = rel
    this.#arcs    = arcs
    this.#rgba    = rgba
    this.#used    = at
    this.#garbage = 0
    this.#uploadAll()
  }

  #grow(need) {
    this.#size = sizeFor(Math.max(need, this.#size * 2))
    const rel  = new Float32Array(this.#size * 2)
    const arcs = new Float32Array(this.#size)
    const rgba = this.#gradient ? new Uint8Array(this.#size * 4) : this.#rgba
    rel.set(this.#rel)
    arcs.set(this.#arcs)
    this.#gradient && rgba.set(this.#rgba)
    this.#rel   = rel
    this.#arcs  = arcs
    this.#rgba  = rgba
    this.#width = Math.min(MAX_WIDTH, this.#size)
    const limit = this.#gl.getParameter?.(this.#gl.MAX_TEXTURE_SIZE)
    if (Number.isFinite(limit) && this.#size / this.#width > limit)
      throw new Error(`[cristae] ${this.#size} vértices no entran en una textura de ${limit}×${limit}`)
    this.#uploadAll()
  }

  // Las texturas se rehacen con las dimensiones nuevas; el espejo ya es del tamaño exacto.
  #uploadAll() {
    const gl = this.#gl
    this.#texture ??= gl.createTexture()
    this.#image(this.#texture, gl.RG32F, gl.RG, this.#rel)
    this.#arcTexture && this.#image(this.#arcTexture, gl.R32F, gl.RED, this.#arcs)
    if (!this.#gradient) return
    this.#colorTexture ??= gl.createTexture()
    this.#image(this.#colorTexture, gl.RGBA8, gl.RGBA, this.#rgba, gl.UNSIGNED_BYTE)
  }

  #image(texture, internalFormat, format, data, type = this.#gl.FLOAT) {
    const gl = this.#gl
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, this.#width, this.#size / this.#width, 0, format, type, data)
    return texture
  }

  // Las filas que cubren los `n` vértices desde `lo`: una subida por textura, sin importar cuántos sean.
  #upload(lo, n) {
    const gl   = this.#gl
    const row  = lo >> Math.log2(this.#width)
    const rows = ((lo + n - 1) >> Math.log2(this.#width)) - row + 1
    const at   = row * this.#width
    const sub  = (texture, format, data, type, size) => {
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, row, this.#width, rows, format, type, data, at * size)
    }
    sub(this.#texture, gl.RG, this.#rel, gl.FLOAT, 2)
    this.#arcTexture && sub(this.#arcTexture, gl.RED, this.#arcs, gl.FLOAT, 1)
    this.#colorTexture && sub(this.#colorTexture, gl.RGBA, this.#rgba, gl.UNSIGNED_BYTE, 4)
  }
}
