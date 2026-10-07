// Almacenamiento de una polilínea o anillo editable: un arena repartido en chunks de tamaño fijo, con
// el orden del trazo en una lista doblemente enlazada y disciplina de hoja B-tree. Mover un vértice es
// O(1) —ruta de arrastre, corre por frame— e insertar o borrar son O(C), nunca O(N).
//
// Dentro de un chunk la entrada de local PAR es un vértice y la IMPAR el midpoint del segmento que
// ARRANCA en él, así ningún segmento queda partido entre dos chunks. El midpoint del segmento que
// LLEGA a un vértice pertenece al vértice ANTERIOR, que puede vivir en otro chunk: mover escribe hasta
// en DOS chunks, y el vecindario se resuelve SIEMPRE por la lista, nunca por aritmética sobre el ref.
//
// El ref de una entrada es su POSICIÓN en el arena — `ref = chunk · LOCAL_CAP + local`, el mismo par
// (chunk, local) que decodifica el picking. Es posicional y no ordinal: un split o un merge migra refs
// ajenos, y por eso `structRev` sella los picks en vuelo.
import { LOCAL_BITS } from '../render/Picking.js'

// El packer del picking guarda `local + 1` en LOCAL_BITS bits, así que el local más alto direccionable
// es LOCAL_CAP - 1. Impar ⇒ la paridad del REF no es la del local (ver #isVertex).
export const LOCAL_CAP = (1 << LOCAL_BITS) - 1

// 0 vale para la entrada muerta y para el midpoint inactivo del último vértice de un trazo abierto:
// en ambos casos es lo mismo, no hay segmento que dibujar.
export const ROLE = { free: 0, vertex: 1, midpoint: 2 }

const MID = [0, 0]   // el midpoint que se escribe, reusado

const regrow = (Ctor, src, length) => {
  const out = new Ctor(length)
  out.set(src)
  return out
}

// Cursor perezoso en orden de trazo — materializar el trazo es O(N) y anula el premio del chunking.
// [0-alloc]: `next()` no asigna. Válido hasta la próxima edición estructural del path.
export class PathCursor {

  ref   = -1
  x     = 0
  y     = 0
  index = -1

  #path

  constructor(path) { this.#path = path }

  reset() {
    this.ref   = -1
    this.index = -1
    return this
  }

  // [0-alloc]
  next() {
    const path = this.#path
    if (this.index + 1 >= path.length) return false
    this.index++
    this.ref = this.index ? path.nextVertex(this.ref) : path.firstVertex
    this.x   = path.xAt(this.ref)
    this.y   = path.yAt(this.ref)
    return true
  }
}

export class ChunkedPath {

  #cap                       // entradas direccionables por chunk = stride del arena
  #runCap                    // tope de `used`: #cap redondeado a par
  #fill                      // entradas por chunk al ingerir, y mínimo antes de rebalancear
  #mid                       // reubica el midpoint de un segmento que no se dibuja recto

  #xy    = new Float64Array(0)   // [x,y] por entrada — vértices y midpoints entrelazados
  #role  = new Uint8Array(0)
  #first = new Uint16Array(0)    // offset del run vivo dentro del chunk, siempre PAR
  #used  = new Uint16Array(0)    // entradas vivas del run, siempre PAR
  #next  = new Int32Array(0)     // -1 = fin · también encadena la free-list
  #prev  = new Int32Array(0)
  #crev  = new Int32Array(0)     // revisión del contenido del chunk

  #chunks    = 0
  #head      = -1
  #tail      = -1
  #freeHead  = -1
  #freeCount = 0
  #length    = 0
  #closed    = false
  #rev       = 0
  #structRev = 0

  // `localBits` sólo baja: menos entradas por chunk = inserciones más baratas y más draw calls. El
  // techo lo fija el picking, que direcciona el local con LOCAL_BITS bits; el piso, el split, que
  // necesita dos parejas para partir en dos mitades no vacías. `mid(x1, y1, x2, y2, out)` recibe en `out`
  // el promedio de los extremos de un segmento y puede reemplazarlo: un segmento que se dibuja curvo pone
  // su midpoint sobre la curva, y el handle que lo inserta cae donde se ve el trazo.
  constructor({ points, closed = false, localBits = LOCAL_BITS, mid } = {}) {
    const cap    = (1 << Math.max(3, Math.min(localBits, LOCAL_BITS))) - 1
    this.#cap    = cap
    this.#runCap = cap & ~1
    this.#fill   = Math.max(2, (cap >> 2) << 1)
    this.#closed = !!closed
    this.#mid    = mid
    this.reset(points)
  }

  get length()    { return this.#length }
  get closed()    { return this.#closed }
  get rev()       { return this.#rev }         // sube con CUALQUIER escritura
  get structRev() { return this.#structRev }   // sube sólo con insert/remove/split/merge/grow

  get firstVertex() { return this.#length ? this.#runStart(this.#head) : -1 }
  get lastVertex()  { return this.#length ? this.#lastRef(this.#tail) : -1 }

  // Superficie del batching de dibujo y del picking: un draw por chunk, en orden de trazo.
  get firstChunk()      { return this.#head }
  get lastChunk()       { return this.#tail }
  get chunkCount()      { return this.#chunks }
  get freeChunks()      { return this.#freeCount }
  get entriesPerChunk() { return this.#cap }

  chunkFirst(k) { return this.#first[k] }
  chunkUsed(k)  { return this.#used[k] }
  chunkNext(k)  { return this.#next[k] }
  chunkPrev(k)  { return this.#prev[k] }

  // Único testigo de que el contenido del chunk se movió: la firma (first, used) no alcanza, porque
  // borrar el arranque del run corre el `first` y el borrow del chunk ANTERIOR lo devuelve, dejando el
  // par IDÉNTICO con otro contenido. Sólo sube, así que tampoco puede volver al valor con el que un
  // chunk se fue a la free-list.
  chunkRev(k) { return this.#crev[k] }

  chunkOf(ref)        { return (ref / this.#cap) | 0 }
  localOf(ref)        { return ref - this.chunkOf(ref) * this.#cap }
  refOf(chunk, local) { return chunk * this.#cap + local }
  midOf(ref)          { return ref + 1 }

  xAt(ref)    { return this.#xy[ref * 2] }
  yAt(ref)    { return this.#xy[ref * 2 + 1] }
  roleAt(ref) { return this.#isLive(ref) ? this.#role[ref] : ROLE.free }

  // Vecino en orden de TRAZO, O(1). Cruza chunks por la lista; en anillo cerrado el `prev` del primero
  // es el último, en el chunk más lejano del arena. El anillo sólo cierra con dos vértices o más.
  nextVertex(ref) {
    const k = this.chunkOf(ref)
    if (ref < this.#lastRef(k)) return ref + 2
    const j = this.#next[k]
    if (j >= 0) return this.#runStart(j)
    return this.#closed && this.#length > 1 ? this.firstVertex : -1
  }

  prevVertex(ref) {
    const k = this.chunkOf(ref)
    if (ref > this.#runStart(k)) return ref - 2
    const j = this.#prev[k]
    if (j >= 0) return this.#lastRef(j)
    return this.#closed && this.#length > 1 ? this.lastVertex : -1
  }

  // [0-alloc] — escribe el vértice, su midpoint y el del anterior: hasta DOS chunks, sin desplazar
  // nada, así los refs sobreviven al gesto y el nodo DOM bajo el dedo conserva su identidad.
  moveVertex(ref, x, y) {
    if (!this.#isVertex(ref)) return false
    this.#xy[ref * 2]     = x
    this.#xy[ref * 2 + 1] = y
    this.#refreshMid(ref)
    const p = this.prevVertex(ref)
    if (p >= 0) this.#refreshMid(p)
    this.#rev++
    return true
  }

  // O(C). Abre dos entradas detrás de `ref`; si el chunk está lleno, primero parte. Devuelve el ref del
  // vértice nuevo, o -1 si `ref` no es un vértice vivo.
  insertAfter(ref, x, y) {
    if (!this.#isVertex(ref)) return -1
    const k     = this.chunkOf(ref)
    const after = this.#used[k] + 2 > this.#runCap ? this.#split(k, ref) : ref
    const at    = this.#openHole(this.chunkOf(after), after + 2)
    this.#xy[at * 2]     = x
    this.#xy[at * 2 + 1] = y
    this.#role[at]       = ROLE.vertex
    this.#length++
    this.#refreshMid(at)
    this.#refreshMid(at - 2)       // el anterior, ya en su posición definitiva
    this.#bumpStruct()
    return at
  }

  // Única vía de alta con el trazo vacío; con vértices es el insert detrás del último. Estrena contenido
  // sin moverlo, así que el embudo no lo ve y el sello va acá.
  append(x, y) {
    if (this.#length) return this.insertAfter(this.lastVertex, x, y)
    const k   = this.#tail
    const ref = k * this.#cap
    this.#first[k]        = 0
    this.#used[k]         = 2
    this.#xy[ref * 2]     = x
    this.#xy[ref * 2 + 1] = y
    this.#role[ref]       = ROLE.vertex
    this.#role[ref + 1]   = ROLE.free
    this.#length          = 1
    this.#crev[k]++
    this.#bumpStruct()
    return ref
  }

  // O(C). El midpoint del anterior se re-enlaza ANTES de mover nada: después el ref de `ref` ya no
  // significa lo mismo.
  remove(ref) {
    if (!this.#isVertex(ref)) return false
    const k = this.chunkOf(ref)
    const p = this.prevVertex(ref)
    const n = this.nextVertex(ref)
    if (p >= 0) this.#linkMid(p, n === p ? -1 : n)
    this.#closeHole(k, ref)
    this.#length--
    this.#rebalance(k)
    this.#bumpStruct()
    return true
  }

  // O(1): sólo cambia si el midpoint del último vértice describe el cierre o queda inactivo.
  setClosed(flag) {
    const value = !!flag
    if (value === this.#closed) return false
    this.#closed = value
    if (this.#length) this.#refreshMid(this.lastVertex)
    this.#rev++
    return true
  }

  // Ingest O(N): cada chunk se llena a medio chunk para dejarle aire a las inserciones; el último se
  // queda con el resto. Reemplaza el arena entero — todo ref anterior queda sin sentido.
  reset(points) {
    const pts      = points ?? []
    const perChunk = this.#fill >> 1
    const chunks   = Math.max(1, Math.ceil(pts.length / perChunk))
    this.#allocArena(chunks)
    pts.forEach((p, i) => {
      const k   = (i / perChunk) | 0
      const ref = k * this.#cap + (i - k * perChunk) * 2
      this.#xy[ref * 2]     = p[0]
      this.#xy[ref * 2 + 1] = p[1]
      this.#role[ref]       = ROLE.vertex
    })
    const used = Array.from({ length: chunks }, (_, k) =>
      Math.min(perChunk, pts.length - k * perChunk) * 2)
    used.forEach((entries, k) => {
      this.#used[k] = entries
      this.#next[k] = k + 1 < chunks ? k + 1 : -1
      this.#prev[k] = k - 1
    })
    this.#head      = 0
    this.#tail      = chunks - 1
    this.#freeHead  = -1
    this.#freeCount = 0
    this.#length    = pts.length
    this.#refreshMids()
    this.#bumpStruct()
    return this
  }

  cursor() { return new PathCursor(this) }

  forEachVertex(fn) {
    const cur = this.cursor()
    while (cur.next()) fn(cur.x, cur.y, cur.ref, cur.index)
  }

  // O(N) con N pares asignados: es el precio de serializar, no el de editar.
  toPairs() {
    const cur = this.cursor()
    return Array.from({ length: this.#length }, () => {
      cur.next()
      return [cur.x, cur.y]
    })
  }

  #runStart(k) { return k * this.#cap + this.#first[k] }
  #runEnd(k)   { return k * this.#cap + this.#first[k] + this.#used[k] }
  #lastRef(k)  { return this.#runEnd(k) - 2 }

  #isLive(ref) {
    if (!(ref >= 0) || ref >= this.#chunks * this.#cap) return false
    const local = this.localOf(ref)
    const k     = this.chunkOf(ref)
    return local >= this.#first[k] && local < this.#first[k] + this.#used[k]
  }

  // La paridad del REF no sirve: `cap` es impar, así que k·cap alterna la paridad chunk a chunk. La
  // que manda es la del LOCAL.
  #isVertex(ref) { return this.#isLive(ref) && (this.localOf(ref) & 1) === 0 }

  #bumpStruct() {
    this.#rev++
    this.#structRev++
  }

  // Midpoint del segmento v→n en la entrada impar de `v`; con n < 0 queda inactivo. [0-alloc]
  #linkMid(v, n) {
    const m = v + 1
    if (n < 0) {
      this.#role[m] = ROLE.free
      return
    }
    const xy = this.#xy
    MID[0] = (xy[v * 2] + xy[n * 2]) * 0.5
    MID[1] = (xy[v * 2 + 1] + xy[n * 2 + 1]) * 0.5
    this.#mid?.(xy[v * 2], xy[v * 2 + 1], xy[n * 2], xy[n * 2 + 1], MID)
    xy[m * 2]     = MID[0]
    xy[m * 2 + 1] = MID[1]
    this.#role[m] = ROLE.midpoint
  }

  #refreshMid(v) { this.#linkMid(v, this.nextVertex(v)) }

  #refreshMids() {
    const cur = this.cursor()
    while (cur.next()) this.#refreshMid(cur.ref)
  }

  // Embudo de TODO movimiento de contenido —los dos huecos, el split, el borrow y el merge pasan por
  // acá—, así que sellar el origen y el destino alcanza para que `chunkRev` no se pierda un traslado.
  #copyEntries(from, to, n) {
    this.#xy.copyWithin(to * 2, from * 2, (from + n) * 2)
    this.#role.copyWithin(to, from, from + n)
    this.#crev[this.chunkOf(from)]++
    this.#crev[this.chunkOf(to)]++
  }

  // Abre dos entradas en `at` desplazando el lado MÁS CORTO; si ese lado no tiene aire, el otro siempre
  // lo tiene (el chunk entra con used+2 ≤ runCap). Devuelve el ref del hueco: al desplazar por
  // izquierda, todo lo anterior a `at` baja dos entradas.
  #openHole(k, at) {
    const from  = this.#runStart(k)
    const end   = this.#runEnd(k)
    const left  = this.#first[k] >= 2
    const right = this.#first[k] + this.#used[k] + 2 <= this.#runCap
    this.#used[k] += 2
    if (left && (!right || at - from <= end - at)) {
      this.#copyEntries(from, from - 2, at - from)
      this.#first[k] -= 2
      return at - 2
    }
    this.#copyEntries(at, at + 2, end - at)
    return at
  }

  // Quita las dos entradas de `at` desplazando el lado más corto.
  #closeHole(k, at) {
    const from = this.#runStart(k)
    const end  = this.#runEnd(k)
    this.#used[k] -= 2
    if (at - from <= end - at - 2) {
      this.#copyEntries(from, from + 2, at - from)
      this.#first[k] += 2
      return
    }
    this.#copyEntries(at + 2, at, end - at - 2)
  }

  // Parte el run a la mitad sobre un chunk de la free-list, enlazado detrás de k. Devuelve `ref` en su
  // nueva posición: la mitad alta migra de chunk.
  #split(k, ref) {
    const j     = this.#alloc()
    const keep  = (this.#used[k] >> 2) << 1        // corte en frontera PAR
    const cut   = this.#runStart(k) + keep
    const moved = this.#used[k] - keep
    this.#copyEntries(cut, j * this.#cap, moved)
    this.#used[k]  = keep
    this.#first[j] = 0
    this.#used[j]  = moved
    this.#linkAfter(k, j)
    this.#bumpStruct()
    return ref >= cut ? j * this.#cap + (ref - cut) : ref
  }

  // Disciplina de hoja: por debajo del mínimo se le pide una pareja al vecino más gordo y, si ninguno
  // puede prestar sin quedar corto, se fusiona. La lista nunca se queda sin chunks, así que el chunk
  // único puede quedar por debajo del mínimo.
  #rebalance(k) {
    const p = this.#prev[k]
    const n = this.#next[k]
    if (p < 0 && n < 0) return
    if (!this.#used[k]) return this.#release(k)
    if (this.#used[k] >= this.#fill) return
    const fat = this.#usedOr(p) >= this.#usedOr(n) ? p : n
    if (this.#used[fat] > this.#fill) return this.#borrow(k, fat)
    // Si los dos venían cortos el fusionado puede seguir estándolo; cada vuelta libera un chunk.
    return this.#rebalance(p >= 0 ? this.#merge(p, k) : this.#merge(k, n))
  }

  #usedOr(k) { return k >= 0 ? this.#used[k] : -1 }

  // Pasa UNA pareja del vecino `j` a `k`, por el extremo que los une en el trazo. El orden se conserva,
  // así que ningún midpoint cambia de valor.
  #borrow(k, j) {
    if (j === this.#next[k]) {
      this.#slideUnless(k, this.#first[k] + this.#used[k] + 2 <= this.#runCap, 0)
      this.#copyEntries(this.#runStart(j), this.#runEnd(k), 2)
      this.#first[j] += 2
      this.#used[j]  -= 2
      this.#used[k]  += 2
      return
    }
    this.#slideUnless(k, this.#first[k] >= 2, this.#runCap - this.#used[k])
    this.#copyEntries(this.#runEnd(j) - 2, this.#runStart(k) - 2, 2)
    this.#used[j]  -= 2
    this.#first[k] -= 2
    this.#used[k]  += 2
  }

  // Corre el run a `to` salvo que el extremo que se va a usar ya tenga aire.
  #slideUnless(k, ok, to) {
    if (ok) return
    this.#copyEntries(this.#runStart(k), k * this.#cap + to, this.#used[k])
    this.#first[k] = to
  }

  // Fusiona `b` —que sigue a `a` en el trazo— dentro de `a`, devuelve `b` a la free-list y entrega el
  // chunk que sobrevive.
  #merge(a, b) {
    const cabe = this.#first[a] + this.#used[a] + this.#used[b] <= this.#runCap
    this.#slideUnless(a, cabe, 0)
    this.#copyEntries(this.#runStart(b), this.#runEnd(a), this.#used[b])
    this.#used[a] += this.#used[b]
    this.#release(b)
    return a
  }

  #linkAfter(k, j) {
    const n = this.#next[k]
    this.#next[j] = n
    this.#prev[j] = k
    this.#next[k] = j
    if (n >= 0) this.#prev[n] = j
    else this.#tail = j
  }

  // Saca el chunk de la lista de trazo y lo devuelve a la free-list.
  #release(k) {
    const p   = this.#prev[k]
    const n   = this.#next[k]
    const cap = this.#cap
    if (p >= 0) this.#next[p] = n
    else this.#head = n
    if (n >= 0) this.#prev[n] = p
    else this.#tail = p
    this.#role.fill(ROLE.free, k * cap, k * cap + cap)
    this.#first[k] = 0
    this.#used[k]  = 0
    this.#prev[k]  = -1
    this.#next[k]  = this.#freeHead
    this.#freeHead = k
    this.#freeCount++
  }

  #alloc() {
    if (this.#freeHead < 0) this.#grow()
    const k = this.#freeHead
    this.#freeHead = this.#next[k]
    this.#freeCount--
    this.#first[k] = 0
    this.#used[k]  = 0
    this.#next[k]  = -1
    this.#prev[k]  = -1
    return k
  }

  #allocArena(chunks) {
    const cap = this.#cap
    this.#xy     = new Float64Array(chunks * cap * 2)
    this.#role   = new Uint8Array(chunks * cap)
    this.#first  = new Uint16Array(chunks)
    this.#used   = new Uint16Array(chunks)
    this.#next   = new Int32Array(chunks).fill(-1)
    this.#prev   = new Int32Array(chunks).fill(-1)
    this.#crev   = new Int32Array(chunks)
    this.#chunks = chunks
  }

  // Duplica el arena. Los refs vivos NO se mueven —el stride es fijo— pero los buffers son otros.
  #grow() {
    const cap    = this.#cap
    const before = this.#chunks
    const chunks = before * 2
    this.#xy     = regrow(Float64Array, this.#xy,    chunks * cap * 2)
    this.#role   = regrow(Uint8Array,   this.#role,  chunks * cap)
    this.#first  = regrow(Uint16Array,  this.#first, chunks)
    this.#used   = regrow(Uint16Array,  this.#used,  chunks)
    this.#next   = regrow(Int32Array,   this.#next,  chunks)
    this.#prev   = regrow(Int32Array,   this.#prev,  chunks)
    this.#crev   = regrow(Int32Array,   this.#crev,  chunks)
    this.#chunks = chunks
    Array.from({ length: chunks - before }, (_, i) => chunks - 1 - i).forEach(k => {
      this.#next[k]  = this.#freeHead
      this.#prev[k]  = -1
      this.#freeHead = k
    })
    this.#freeCount += chunks - before
    this.#bumpStruct()
  }
}
