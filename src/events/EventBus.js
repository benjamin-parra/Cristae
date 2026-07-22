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

  // Demanda de picking (subsistema FRÍO — sólo alta/baja de suscripción y registro de capa): dos
  // libros de conteo por canal + el notificador, que se leen y escriben juntos. `global` = handlers
  // que escuchan todas las capas; `layer` = layerId → (canal → conteo); `onChange` avisa al motor
  // cuándo recalcular la máscara activa de una capa (null = la demanda global).
  #demand = { global: new Map(), layer: new Map(), onChange: null }

  constructor(onDemandChange = null) {
    this.#demand.onChange = onDemandChange
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

  // Ruteo del kind de hit → acción (dispatch por tabla en vez de if/else, exhaustivo sobre los kinds
  // válidos). Tabla construida UNA vez por instancia —no por despacho— con prototipo nulo: un kind
  // desconocido no resuelve ningún método heredado, sólo el `?.()` no-op. Los arrows cierran sobre
  // `this` una sola vez; el lookup es 0-alloc, apto para el ritmo de pointermove (hover, pointer:move).
  #routes = {
    __proto__: null,
    'pointer:move': (hits, baseEvent) => this.#emitRaw('pointer:move', baseEvent),
    'click': (hits, baseEvent) => this.#emit('click', hits, baseEvent),
    'secondary-click': (hits, baseEvent) => this.#emit('secondary-click', hits, baseEvent),
    'hover': (hits, baseEvent) => this.#dispatchHover(hits, baseEvent),
    'hover:out': (hits, baseEvent) => this.#dispatchHoverOut(baseEvent),
  }

  dispatch(kind, hits, baseEvent) {
    return this.#routes[kind]?.(hits, baseEvent)
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
    const d = this.#demand
    return this.#maskFromCounts(d.global)
      | this.#maskFromCounts(d.layer.get(layerId))
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
    const d = this.#demand

    if (handler.all) {
      this.#applyCount(d.global, handler.mask, delta)
      d.onChange?.(null)
      return
    }

    handler.layers.forEach(layerId => {
      let counts = d.layer.get(layerId)
      if (!counts) d.layer.set(layerId, counts = new Map())
      this.#applyCount(counts, handler.mask, delta)
      if (!counts.size) d.layer.delete(layerId)
      d.onChange?.(layerId)
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
