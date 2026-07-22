import { safeDispatch } from './safe.js'

// Ref de módulo estable → safeDispatch no aloca por emit (solo se invoca si un listener tira).
function reportListenerError(e) {
  console.error('[Store] listener lanzó', e)
}

// Store reactivo componible. Mantiene dos capas de filtros (heredados del padre +
// propios) sobre el dato base, version-tracking opcional para patch O(k), y fan-out
// síncrono cero-alloc a los listeners.
export class Store {

  // Version-tracking (co-mutan: idOf/hashOf se fijan una vez; hashes/versions/dirtyIds
  // se crean juntos al recibir versionTracker). dirtyIds es un Set reusable — nunca se
  // reasigna (sólo .clear()/.add()), hay un test de identidad que lo verifica.
  #tracking = { idOf: null, hashOf: null, hashes: null, versions: null, dirtyIds: null }

  // Índices id → posición / membresía (Maps/Sets reusados: .clear() por rebuild, nunca reasignados).
  #index = { base: new Map(), parent: new Map(), parentMembers: new Set(), self: new Map(), selfMembers: new Set() }

  // Capas de dato + sus filtros: base → filtrado por el padre → filtrado propio.
  #layers = { base: [], parentFiltered: [], selfFiltered: [], parentFilters: [], selfFilters: [] }

  #listeners = []

  #instanceId  = Symbol('Store')
  #dataVersion = 0

  #parent = null

  constructor(items = [], { versionTracker } = {}) {
    if (!Array.isArray(items)) items = []
    const ly = this.#layers
    ly.base           = items
    ly.parentFiltered = items.slice()
    ly.selfFiltered   = items.slice()

    if (versionTracker) {
      const t = this.#tracking
      t.idOf     = versionTracker.idOf
      t.hashOf   = versionTracker.hashOf
      t.hashes   = new Map()
      t.versions = new Map()
      t.dirtyIds = new Set()
      this.#scan(items)
      this.#rebuildBaseIndex()
      this.#rebuildIndices()
    }
  }

  /* ── Mutación ── */

  update(items = []) {
    if (!Array.isArray(items)) return this
    this.#layers.base = items
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
    const t = this.#tracking
    if (!t.idOf || !dirtyIds?.size) return this.update(items)

    const ix = this.#index
    const ly = this.#layers
    ly.base = items
    let needsRegenerate = false

    for (const id of dirtyIds) {
      const baseIdx = ix.base.get(id)
      if (baseIdx == null) continue            // id ausente del snapshot → ignorar
      const item = items[baseIdx]
      this.#scanOne(item)

      // Con la vista ya condenada al regenerado, evaluar filtros y escribir slots es trabajo muerto.
      if (needsRegenerate) continue

      const passesParent = ly.parentFilters.every(F => F.f(item))
      const passesSelf = passesParent && ly.selfFilters.every(F => F.f(item))
      const wasParent = ix.parentMembers.has(id)
      const wasSelf = ix.selfMembers.has(id)

      if (passesParent !== wasParent || passesSelf !== wasSelf) {
        needsRegenerate = true
        continue
      }

      if (passesParent) {
        const pi = ix.parent.get(id)
        if (pi != null) ly.parentFiltered[pi] = item
      }
      if (passesSelf) {
        const si = ix.self.get(id)
        if (si != null) ly.selfFiltered[si] = item
      }
    }

    if (needsRegenerate) this.#hardRegenerate()

    this.#dataVersion++
    this.notifyChanges()
    return this
  }

  /* ── Filtros ── */

  addFilter(filter) {
    const ly = this.#layers
    ly.selfFilters.push(filter)
    ly.selfFiltered = ly.selfFiltered.filter(v => filter.f(v))
    this.#rebuildIndices()
    this.#dataVersion++
    return this
  }

  removeFilter(id) {
    const ly = this.#layers
    ly.selfFilters = ly.selfFilters.filter(F => F.id !== id)
    this.#softRegenerate()
    this.#dataVersion++
    return this
  }

  hasFilter(id) {
    return this.#layers.selfFilters.some(F => F.id === id)
  }

  clearFilters() {
    const ly = this.#layers
    if (ly.selfFilters.length === 0) return this
    ly.selfFilters = []
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
    safeDispatch(this.#listeners, this.#layers.selfFiltered, reportListenerError)
  }

  /* ── Composición ── */

  // El hijo hereda los filtros activos del padre y se re-genera ante cada cambio del padre.
  reactiveCompose(parent) {
    if (!(parent instanceof Store)) return this
    this.#parent = parent
    this.#layers.parentFilters = parent.activeFilters

    const self = this
    parent.addListener({
      id: this.#instanceId,
      callback: () => {
        self.#layers.parentFilters = parent.activeFilters
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
    // Sin esto, el listener que reactiveCompose registró en el padre quedaría vivo (leak).
    if (this.#parent) this.#parent.removeListener(this.#instanceId)
    this.#parent = null
    this.#listeners = []
    const ly = this.#layers
    ly.base = []
    ly.parentFiltered = []
    ly.selfFiltered = []
  }

  /* ── Lectura (refs estables entre flushes) ── */

  get filtered() { return this.#layers.selfFiltered }
  get activeFilters() { return [...this.#layers.parentFilters, ...this.#layers.selfFilters] }
  get dataVersion() { return this.#dataVersion }
  get elementVersions() { return this.#tracking.versions }
  get dirtyIds() { return this.#tracking.dirtyIds }

  version() { return this.#dataVersion }

  // item por id en O(1) (índice de selfFiltered). Requiere versionTracker. Habilita el
  // patch incremental O(k) de la capa (resolver el ítem fresco de un id sucio sin escanear).
  get(id) {
    return this.#layers.selfFiltered[this.#index.self.get(id)]   // id ausente → índice undefined → undefined
  }

  /* ── Internos ── */

  #softRegenerate() {
    const ly = this.#layers
    ly.selfFiltered = ly.parentFiltered.filter(v => ly.selfFilters.every(F => F.f(v)))
    this.#rebuildIndices()
  }

  #hardRegenerate() {
    const ly = this.#layers
    ly.parentFiltered = ly.base.filter(v => ly.parentFilters.every(F => F.f(v)))
    this.#softRegenerate()
  }

  // Recolecta los ids cuyo hash cambió en el Set reusable (no se reasigna → cero-alloc).
  #scan(items) {
    const t = this.#tracking
    if (!t.versions) return
    t.dirtyIds.clear()
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      const id = t.idOf(item)
      const hash = t.hashOf(item)
      if (t.hashes.get(id) !== hash) {
        t.hashes.set(id, hash)
        t.versions.set(id, (t.versions.get(id) || 0) + 1)
        t.dirtyIds.add(id)
      }
    }
  }

  #scanOne(item) {
    const t = this.#tracking
    if (!t.versions) return
    const id = t.idOf(item)
    const hash = t.hashOf(item)
    if (t.hashes.get(id) !== hash) {
      t.hashes.set(id, hash)
      t.versions.set(id, (t.versions.get(id) || 0) + 1)
    }
  }

  #rebuildBaseIndex() {
    const t = this.#tracking
    if (!t.idOf) return
    const ix = this.#index
    const ly = this.#layers
    ix.base.clear()
    for (let i = 0; i < ly.base.length; i++) {
      const id = t.idOf(ly.base[i])
      if (!ix.base.has(id)) ix.base.set(id, i)   // id duplicado → primero
    }
  }

  #rebuildIndices() {
    const t = this.#tracking
    if (!t.idOf) return
    const ix = this.#index
    const ly = this.#layers
    ix.parent.clear()
    ix.parentMembers.clear()
    ix.self.clear()
    ix.selfMembers.clear()
    for (let i = 0; i < ly.parentFiltered.length; i++) {
      const id = t.idOf(ly.parentFiltered[i])
      ix.parent.set(id, i)
      ix.parentMembers.add(id)
    }
    for (let i = 0; i < ly.selfFiltered.length; i++) {
      const id = t.idOf(ly.selfFiltered[i])
      ix.self.set(id, i)
      ix.selfMembers.add(id)
    }
  }
}
