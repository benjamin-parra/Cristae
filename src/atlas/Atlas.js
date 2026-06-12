// Atlas — valor CPU inmutable-por-generación, append-only (SPECS §4.1, MODELO §7.2).
// Cero WebGL, cero DOM más allá de recibir un bitmap/canvas ya rasterizado.
// Espacio de direccionamiento FIJO por generación: la celda de un índice nunca se mueve.
// El encoding de tile (tileChannel) se normaliza por capacidad fija C, no por count
// → un punto ya emitido no cambia de significado al crecer dentro de la generación.

export default class Atlas {

  #variants = new Map()   // variante (string) → índice entero estable
  #tiles    = []          // índice → bitmap/canvas registrado

  // Scratch reusado por cellOf → [0-alloc]: se muta y se retorna, nunca se asigna por llamada.
  cell = { col: 0, row: 0 }

  // capacity fija C (con headroom, elegida por el caller). cols/rows dimensionan la grilla.
  constructor(capacity, tileSize, generation = 0) {
    const cols = Math.ceil(Math.sqrt(capacity))
    this.capacity   = capacity
    this.tileSize   = tileSize
    this.generation = generation
    this.cols       = cols
    this.rows       = Math.ceil(capacity / cols)
  }

  // Celdas ocupadas (≤ C). El binding usa `uploaded < count` como señal intrínseca.
  get count() { return this.#tiles.length }

  // variante → índice estable durante la generación, o -1 si ausente. O(1).
  indexOf(variant) {
    return this.#variants.get(variant) ?? -1
  }

  // Asigna la SIGUIENTE celda libre (índice = count++) y registra variante+bitmap.
  // Devuelve el índice. Lleno (count === capacity) → -1 sin mutar (el caller hará regrow).
  // La celda de un índice nunca se mueve mientras viva la generación. O(1) amort.
  append(variant, bitmap) {
    if (this.#tiles.length === this.capacity) return -1
    const index = this.#tiles.length
    this.#tiles.push(bitmap)
    this.#variants.set(variant, index)
    return index
  }

  // Escribe col/row en el scratch compartido y lo retorna. [0-alloc] O(1).
  // Usado por el binding GPU para ubicar texSubImage2D en (col*tileSize, row*tileSize).
  cellOf(index) {
    this.cell.col = index % this.cols
    this.cell.row = (index / this.cols) | 0
    return this.cell
  }

  // bitmap/canvas registrado para ese índice. O(1).
  tileAt(index) { return this.#tiles[index] }

  // Canal r del color de tile = index / (C-1), normalizado por capacidad FIJA.
  // El shader recupera floor(r*(C-1)+0.5). El ángulo (g) y el id de picking (b,a)
  // los compone la capa, no el atlas. [0-alloc] O(1).
  tileChannel(index) { return index / Math.max(this.capacity - 1, 1) }

  // Produce un Atlas NUEVO (generation+1) con mayor capacidad (doble), preservando
  // cada mapeo variante→índice y cada bitmap → los índices existentes siguen válidos.
  // Único repack del diseño. El caller cambia a este objeto al desbordar capacidad;
  // los bindings lo detectan por identidad y re-suben; la capa re-encoda con el nuevo C.
  static grow(previous) {
    const next = new Atlas(previous.capacity * 2, previous.tileSize, previous.generation + 1)
    // Re-append en orden de índice preserva la asignación (índice i → celda i).
    for (let i = 0; i < previous.count; i++) next.#tiles.push(previous.tileAt(i))
    for (const [variant, index] of previous.#variants) next.#variants.set(variant, index)
    return next
  }
}
