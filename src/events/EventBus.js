import { maskOfEventType } from './events.js'

// Bus de interacción del mapa. Enruta hits (ya resueltos por el registro) hacia los
// handlers suscritos por tipo de evento y por capa, y deriva los eventos de hover
// (start/end) diffeando el set actual contra el anterior por una clave estable de elemento.
//
// Demand-counting: cada suscripción incrementa un contador por canal; el registro
// consulta demandMaskFor(layerId) para resolver hits solo de los canales con demanda
// → sin handlers de hover, no se hace picking de hover. onDemandChange notifica al
// motor cuándo recalcular las máscaras activas de cada capa.
export class EventBus {

  #handlersByType = new Map()

  // Set de hover vigente: claveEstable → hit. Se reemplaza por uno nuevo en cada diffing.
  #activeHover = new Map()

  // Identidad estable por elemento (objeto/función) → entero. Sobrevive entre flushes
  // para que el diffing de hover reconozca el mismo elemento aunque cambie el hit.
  #elementIds = new WeakMap()
  #nextElementId = 1

  #globalDemand = new Map()           // canal → conteo de handlers que escuchan todas las capas
  #layerDemand = new Map()            // layerId → (canal → conteo)
  #onDemandChange

  constructor(onDemandChange = null) {
    this.#onDemandChange = onDemandChange
  }

  /* ── Suscripción ── */

  // on(type, callback) escucha todas las capas; on(type, layerIds, callback) filtra por capa.
  // Devuelve una función de baja idempotente.
  on(eventType, layerIdsOrCallback, maybeCallback) {
    const callback = typeof layerIdsOrCallback === 'function' ? layerIdsOrCallback : maybeCallback
    const layerIds = typeof layerIdsOrCallback === 'function' ? null : layerIdsOrCallback

    const all = layerIds == null
    const layers = all ? null : new Set(
      Array.isArray(layerIds) ? layerIds.filter(id => id != null) : [layerIds]
    )

    const handler = { all, layers, callback, mask: maskOfEventType(eventType), disposed: false }

    let handlers = this.#handlersByType.get(eventType)
    if (!handlers) this.#handlersByType.set(eventType, handlers = [])
    handlers.push(handler)
    this.#changeDemand(handler, 1)

    return () => {
      if (handler.disposed) return
      handler.disposed = true
      this.#changeDemand(handler, -1)
      const list = this.#handlersByType.get(eventType)
      const i = list ? list.indexOf(handler) : -1
      if (i >= 0) list.splice(i, 1)
    }
  }

  /* ── Despacho ── */

  dispatch(kind, hits, baseEvent) {
    if (kind === 'pointer:move') return this.#emitRaw('pointer:move', baseEvent)
    if (kind === 'click') return this.#emit('click', hits, baseEvent)
    if (kind === 'hover') return this.#dispatchHover(hits, baseEvent)
    if (kind === 'hover:out') return this.#dispatchHoverOut(baseEvent)
  }

  // Fuerza hover:end de los elementos de una capa que dejó de ser resoluble (oculta/removida).
  // Sin esto, el estado de hover externo sobreviviría a la capa que lo originó.
  clearLayer(layerId) {
    const endHits = []
    this.#activeHover.forEach((hit, key) => {
      if (hit.layerId !== layerId) return
      this.#activeHover.delete(key)
      endHits.push(hit)
    })
    if (endHits.length) this.#emit('hover:end', endHits, null)
  }

  demandMaskFor(layerId) {
    return this.#maskFromCounts(this.#globalDemand)
      | this.#maskFromCounts(this.#layerDemand.get(layerId))
  }

  /* ── Internos de hover ── */

  #dispatchHover(hits, baseEvent) {
    this.#emit('hover', hits, baseEvent)

    const next = new Map()
    hits.forEach(hit => next.set(this.#keyOf(hit), hit))

    const startHits = []
    next.forEach((hit, key) => { if (!this.#activeHover.has(key)) startHits.push(hit) })

    const endHits = []
    this.#activeHover.forEach((hit, key) => { if (!next.has(key)) endHits.push(hit) })

    this.#activeHover = next

    if (startHits.length) this.#emit('hover:start', startHits, baseEvent)
    if (endHits.length) this.#emit('hover:end', endHits, baseEvent)
  }

  #dispatchHoverOut(baseEvent) {
    if (!this.#activeHover.size) return
    const endHits = [...this.#activeHover.values()]
    this.#activeHover.clear()
    this.#emit('hover:end', endHits, baseEvent)
  }

  // Clave estable de un hit para diffing. Prefiere el id provisto por el resolver;
  // si no, deriva una a partir de layerId + identidad del ref (objeto → entero del WeakMap).
  #keyOf(hit) {
    if (hit.id != null) return `${hit.layerId}#${hit.id}`
    return `${hit.layerId}#${this.#refId(hit.ref)}`
  }

  #refId(ref) {
    if (ref && (typeof ref === 'object' || typeof ref === 'function')) {
      let id = this.#elementIds.get(ref)
      if (!id) this.#elementIds.set(ref, id = this.#nextElementId++)
      return id
    }
    return String(ref)
  }

  /* ── Emisión ── */

  // pointer:move no lleva hits: notifica el evento crudo (coordenadas) a sus handlers.
  #emitRaw(eventType, baseEvent) {
    const handlers = this.#handlersByType.get(eventType)
    if (!handlers?.length) return
    handlers.forEach(h => h.callback([], baseEvent))
  }

  #emit(eventType, hits, baseEvent) {
    const handlers = this.#handlersByType.get(eventType)
    if (!handlers?.length || !hits.length) return

    handlers.forEach(h => {
      if (h.all) return h.callback(hits, baseEvent)
      const matched = hits.filter(hit => h.layers.has(hit.layerId))
      if (matched.length) h.callback(matched, baseEvent)
    })
  }

  /* ── Conteo de demanda ── */

  #changeDemand(handler, delta) {
    if (!handler.mask) return

    if (handler.all) {
      this.#applyCount(this.#globalDemand, handler.mask, delta)
      this.#onDemandChange?.(null)
      return
    }

    handler.layers.forEach(layerId => {
      let counts = this.#layerDemand.get(layerId)
      if (!counts) this.#layerDemand.set(layerId, counts = new Map())
      this.#applyCount(counts, handler.mask, delta)
      if (!counts.size) this.#layerDemand.delete(layerId)
      this.#onDemandChange?.(layerId)
    })
  }

  #applyCount(counts, mask, delta) {
    const next = (counts.get(mask) ?? 0) + delta
    if (next > 0) counts.set(mask, next)
    else counts.delete(mask)
  }

  #maskFromCounts(counts) {
    let mask = 0
    counts?.forEach((_, channel) => { mask |= channel })
    return mask
  }
}
