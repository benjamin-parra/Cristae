import { safeDispatch } from './safe.js'

// Ref de módulo estable → safeDispatch no aloca por emit (solo se invoca si un listener tira).
function reportListenerError(e) {
  console.error('[Store] listener lanzó', e)
}

// Store reactivo componible. Mantiene dos capas de filtros (heredados del padre +
// propios) sobre el dato base, version-tracking opcional para patch O(k), y fan-out
// síncrono cero-alloc a los listeners.
export class Store {

  #baseData = []
  #parentFiltered = []
  #selfFiltered = []

  #parentFilters = []
  #selfFilters = []

  #listeners = []

  #instanceId = Symbol('Store')
  #dataVersion = 0

  #parent = null

  // Version-tracking
  #idOf = null
  #hashOf = null
  #hashes = null
  #versions = null
  #dirtyIds = null              // Set reusable — nunca se reasigna

  // Índices id → posición / membresía
  #baseIndex = new Map()
  #parentIndex = new Map()
  #parentMembers = new Set()
  #selfIndex = new Map()
  #selfMembers = new Set()

  constructor(items = [], { versionTracker } = {}) {
    if (!Array.isArray(items)) items = []
    this.#baseData = items
    this.#parentFiltered = items.slice()
    this.#selfFiltered = items.slice()

    if (versionTracker) {
      this.#idOf = versionTracker.idOf
      this.#hashOf = versionTracker.hashOf
      this.#hashes = new Map()
      this.#versions = new Map()
      this.#dirtyIds = new Set()
      this.#scan(items)
      this.#rebuildBaseIndex()
      this.#rebuildIndices()
    }
  }

  /* ── Mutación ── */

  update(items = []) {
    if (!Array.isArray(items)) return this
    this.#baseData = items
    this.#scan(items)
    this.#rebuildBaseIndex()
    this.#hardRegenerate()
    this.#dataVersion++
    this.notifyChanges()
    return this
  }

  // Patch O(k): solo re-evalúa los ítems sucios. Cae a regenerado completo únicamente
  // si un ítem sucio cambia de membresía (entra/sale de un filtro).
  // El recorrido de dirtyIds es TOTAL: todo id sucio pasa por el scan (hash + version-bump).
  // Un cambio de membresía sólo decide CÓMO queda la vista al final, nunca acorta el recorrido.
  patch(items, dirtyIds) {
    if (!this.#idOf || !dirtyIds?.size) return this.update(items)

    this.#baseData = items
    let needsRegenerate = false

    for (const id of dirtyIds) {
      const baseIdx = this.#baseIndex.get(id)
      if (baseIdx == null) continue            // id ausente del snapshot → ignorar
      const item = items[baseIdx]
      this.#scanOne(item)

      // Con la vista ya condenada al regenerado, evaluar filtros y escribir slots es trabajo muerto.
      if (needsRegenerate) continue

      const passesParent = this.#parentFilters.every(F => F.f(item))
      const passesSelf = passesParent && this.#selfFilters.every(F => F.f(item))
      const wasParent = this.#parentMembers.has(id)
      const wasSelf = this.#selfMembers.has(id)

      if (passesParent !== wasParent || passesSelf !== wasSelf) {
        needsRegenerate = true
        continue
      }

      if (passesParent) {
        const pi = this.#parentIndex.get(id)
        if (pi != null) this.#parentFiltered[pi] = item
      }
      if (passesSelf) {
        const si = this.#selfIndex.get(id)
        if (si != null) this.#selfFiltered[si] = item
      }
    }

    if (needsRegenerate) this.#hardRegenerate()

    this.#dataVersion++
    this.notifyChanges()
    return this
  }

  /* ── Filtros ── */

  addFilter(filter) {
    this.#selfFilters.push(filter)
    this.#selfFiltered = this.#selfFiltered.filter(v => filter.f(v))
    this.#rebuildIndices()
    this.#dataVersion++
    return this
  }

  removeFilter(id) {
    this.#selfFilters = this.#selfFilters.filter(F => F.id !== id)
    this.#softRegenerate()
    this.#dataVersion++
    return this
  }

  hasFilter(id) {
    return this.#selfFilters.some(F => F.id === id)
  }

  clearFilters() {
    if (this.#selfFilters.length === 0) return this
    this.#selfFilters = []
    this.#softRegenerate()
    this.#dataVersion++
    return this
  }

  /* ── Listeners ── */

  addListener(listener) {
    this.#listeners.push(listener)
    return this
  }

  removeListener(id) {
    this.#listeners = this.#listeners.filter(l => l.id !== id)
    return this
  }

  notifyChanges() {
    safeDispatch(this.#listeners, this.#selfFiltered, reportListenerError)
  }

  /* ── Composición ── */

  // El hijo hereda los filtros activos del padre y se re-genera ante cada cambio del padre.
  reactiveCompose(parent) {
    if (!(parent instanceof Store)) return this
    this.#parent = parent
    this.#parentFilters = parent.activeFilters

    const self = this
    parent.addListener({
      id: this.#instanceId,
      callback: () => {
        self.#parentFilters = parent.activeFilters
        self.#hardRegenerate()
        self.notifyChanges()
      },
    })

    this.#hardRegenerate()
    this.#dataVersion++
    this.notifyChanges()
    return this
  }

  destroy() {
    // Bug #3 del legado: reactiveCompose dejaba el listener vivo en el padre.
    if (this.#parent) this.#parent.removeListener(this.#instanceId)
    this.#parent = null
    this.#listeners = []
    this.#baseData = []
    this.#parentFiltered = []
    this.#selfFiltered = []
  }

  /* ── Lectura (refs estables entre flushes) ── */

  get filtered() { return this.#selfFiltered }
  get activeFilters() { return [...this.#parentFilters, ...this.#selfFilters] }
  get dataVersion() { return this.#dataVersion }
  get elementVersions() { return this.#versions }
  get dirtyIds() { return this.#dirtyIds }

  version() { return this.#dataVersion }

  // item por id en O(1) (índice de selfFiltered). Requiere versionTracker. Habilita el
  // patch incremental O(k) de la capa (resolver el ítem fresco de un id sucio sin escanear).
  get(id) {
    return this.#selfFiltered[this.#selfIndex.get(id)]   // id ausente → índice undefined → undefined
  }

  /* ── Internos ── */

  #softRegenerate() {
    this.#selfFiltered = this.#parentFiltered.filter(v => this.#selfFilters.every(F => F.f(v)))
    this.#rebuildIndices()
  }

  #hardRegenerate() {
    this.#parentFiltered = this.#baseData.filter(v => this.#parentFilters.every(F => F.f(v)))
    this.#softRegenerate()
  }

  // Recolecta los ids cuyo hash cambió en el Set reusable (no se reasigna → cero-alloc).
  #scan(items) {
    if (!this.#versions) return
    this.#dirtyIds.clear()
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      const id = this.#idOf(item)
      const hash = this.#hashOf(item)
      if (this.#hashes.get(id) !== hash) {
        this.#hashes.set(id, hash)
        this.#versions.set(id, (this.#versions.get(id) || 0) + 1)
        this.#dirtyIds.add(id)
      }
    }
  }

  #scanOne(item) {
    if (!this.#versions) return
    const id = this.#idOf(item)
    const hash = this.#hashOf(item)
    if (this.#hashes.get(id) !== hash) {
      this.#hashes.set(id, hash)
      this.#versions.set(id, (this.#versions.get(id) || 0) + 1)
    }
  }

  #rebuildBaseIndex() {
    if (!this.#idOf) return
    this.#baseIndex.clear()
    for (let i = 0; i < this.#baseData.length; i++) {
      const id = this.#idOf(this.#baseData[i])
      if (!this.#baseIndex.has(id)) this.#baseIndex.set(id, i)   // id duplicado → primero
    }
  }

  #rebuildIndices() {
    if (!this.#idOf) return
    this.#parentIndex.clear()
    this.#parentMembers.clear()
    this.#selfIndex.clear()
    this.#selfMembers.clear()
    for (let i = 0; i < this.#parentFiltered.length; i++) {
      const id = this.#idOf(this.#parentFiltered[i])
      this.#parentIndex.set(id, i)
      this.#parentMembers.add(id)
    }
    for (let i = 0; i < this.#selfFiltered.length; i++) {
      const id = this.#idOf(this.#selfFiltered[i])
      this.#selfIndex.set(id, i)
      this.#selfMembers.add(id)
    }
  }
}
