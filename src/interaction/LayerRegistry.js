import { EVENT_CLICK, EVENT_HOVER } from '../events/events.js'
import { HitResolver } from './HitResolver.js'

// Registro de capas interactivas. Genérico sobre funciones resolver: no conoce capas de
// puntos ni de polígonos, solo entradas con un par de resolvers (click/hover), z-index,
// orden de declaración, visibilidad y máscara de canales activos.
//
// resolveHits(eventType) recorre las capas visibles, pide hits solo a los resolvers cuyo
// canal está activo, y los devuelve ordenados top-first (zIndex desc, order asc, distancePx asc)
// para que el consumidor desambigüe sin recalcular geometría.
export class LayerRegistry {

  #hitResolver
  #entriesByLayerId = new Map()
  #objectsByLayerId = new Map()
  #overlayLayers = new Set()      // capas overlay (capture/presentAs): ocluyen/proxan en resolveHits
  #nextDeclOrder = 0

  // Acepta un HitResolver ya construido o un map para fabricar el por-defecto sobre Leaflet.
  constructor(hitResolverOrMap) {
    this.#hitResolver = hitResolverOrMap instanceof HitResolver
      ? hitResolverOrMap
      : new HitResolver(hitResolverOrMap)
  }

  getLayer(layerId) {
    return this.#objectsByLayerId.get(layerId) ?? null
  }

  // Vista ordenada (top-first) de las capas, para inspección/UI. No resuelve hits.
  getLayers() {
    return [...this.#entriesByLayerId.values()]
      .sort((a, b) => (b.zIndex - a.zIndex) || (a.declOrder - b.declOrder))
      .map(e => ({ layerId: e.layerId, kind: e.kind, zIndex: e.zIndex, active: e.visible }))
  }

  // Registra una capa Leaflet derivando z-index y resolver del HitResolver. Los resolvers
  // de click/hover comparten por defecto el resolver geométrico; se pueden sobreescribir.
  registerLeafletLayer(layerId, layer, {
    kind = 'leaflet',
    zIndex,
    resolveClick,
    resolveHover,
    ref,
    declOrder,
  } = {}) {
    const targetRef = ref ?? layer
    const resolver = this.#hitResolver.createResolver(layer, targetRef)

    this.upsertResolver({
      layerId,
      kind,
      zIndex: zIndex ?? this.#hitResolver.zIndexOf(layer),
      declOrder: declOrder ?? this.#nextDeclOrder,
      resolveClick: resolveClick ?? resolver,
      resolveHover: resolveHover ?? resolver,
      getLeafletLayer: () => layer,
      visible: true,
    }, targetRef)

    return targetRef
  }

  // Inserta o reemplaza la entrada de una capa. Preserva la máscara activa previa si la
  // nueva no la trae (la demanda la recalcula el motor aparte). Avanza el contador de orden.
  upsertResolver(entry, layerObject) {
    if (entry.declOrder >= this.#nextDeclOrder) this.#nextDeclOrder = entry.declOrder + 1

    const previous = this.#entriesByLayerId.get(entry.layerId)
    entry.visible = entry.visible ?? true
    entry.activeMask = entry.activeMask ?? previous?.activeMask ?? 0

    this.#entriesByLayerId.set(entry.layerId, entry)
    if (entry.capture || entry.presentAs) this.#overlayLayers.add(entry.layerId)
    else this.#overlayLayers.delete(entry.layerId)
    if (layerObject !== undefined) this.#objectsByLayerId.set(entry.layerId, layerObject)
  }

  setLayerVisibility(layerId, visible) {
    const entry = this.#entriesByLayerId.get(layerId)
    if (!entry) return false
    entry.visible = !!visible
    return true
  }

  isLayerVisible(layerId) {
    return this.#entriesByLayerId.get(layerId)?.visible ?? null
  }

  setLayerDemandMask(layerId, mask) {
    const entry = this.#entriesByLayerId.get(layerId)
    if (!entry) return false
    entry.activeMask = mask
    return true
  }

  demandMaskOf(layerId) {
    return this.#entriesByLayerId.get(layerId)?.activeMask ?? 0
  }

  layerIds() {
    return [...this.#entriesByLayerId.keys()]
  }

  // Recolecta los hits de todas las capas visibles para un tipo de evento, ya ordenados
  // top-first. distancePx ausente cuenta como infinito (queda al fondo del desempate).
  resolveHits(eventType, baseEvent) {
    const hits = []

    this.#entriesByLayerId.forEach(entry => {
      if (!entry.visible) return
      this.#resolveParts(entry, eventType, baseEvent).forEach(part => {
        hits.push({
          layerId: entry.layerId,
          kind: entry.kind,
          ref: part.ref,
          id: part.id,
          distancePx: part.distancePx ?? Number.POSITIVE_INFINITY,
          zIndex: entry.zIndex,
          order: entry.declOrder,
        })
      })
    })

    hits.sort((a, b) =>
      (b.zIndex - a.zIndex)
      || (a.order - b.order)
      || (a.distancePx - b.distancePx)
    )
    return this.#present(hits)
  }

  // Capas overlay sobre la lista ya ordenada, top-down: una capa `capture` ocluye lo que tiene debajo
  // (no se entrega); una `presentAs` además antepone su hit reetiquetado por la capa (proxy de
  // identidad). Resultado = lista canónica que ven TODOS los canales y consumidores. Sin overlays, igual.
  #present(hits) {
    if (!this.#overlayLayers.size) return hits
    for (let i = 0; i < hits.length; i++) {
      if (!this.#overlayLayers.has(hits[i].layerId)) continue
      const clipped = i + 1 < hits.length ? hits.slice(0, i + 1) : hits
      const proxied = this.#entriesByLayerId.get(hits[i].layerId).presentAs?.(hits[i])
      return proxied ? [proxied, ...clipped] : clipped
    }
    return hits
  }

  // ¿El puntero (en `baseEvent`) cae sobre una feature de ALGUNA capa visible cuya demanda
  // intersecta `channelMask`? Usa el resolver de hover (proximidad geométrica para polígonos; pick
  // GPU ya recogido por la sesión para puntos). Es la consulta del CURSOR de affordance: una capa
  // con demanda de CLICK debe marcar el puntero aunque nadie escuche el canal de hover (ver
  // Interaction). No ordena ni materializa hits: corta al primer acierto (O(L) en el peor caso).
  hasHitForChannels(channelMask, baseEvent) {
    for (const entry of this.#entriesByLayerId.values()) {
      if (!entry.visible) continue
      if (!(entry.activeMask & channelMask)) continue
      const parts = entry.resolveHover?.(baseEvent)
      if (parts && parts.length) return true
    }
    return false
  }

  // Quita todas las capas asociadas a un objeto Leaflet dado. Devuelve los layerIds removidos.
  removeByLeafletLayer(leafletLayer) {
    const removedIds = []
    this.#entriesByLayerId.forEach((entry, layerId) => {
      if (entry.getLeafletLayer?.() !== leafletLayer) return
      removedIds.push(layerId)
      this.#entriesByLayerId.delete(layerId)
      this.#objectsByLayerId.delete(layerId)
      this.#overlayLayers.delete(layerId)
    })
    return removedIds
  }

  removeByLayerId(layerId) {
    this.#entriesByLayerId.delete(layerId)
    this.#objectsByLayerId.delete(layerId)
    this.#overlayLayers.delete(layerId)
  }

  nextDeclOrder() {
    return this.#nextDeclOrder++
  }

  // Pide partes de hit al resolver del canal correspondiente, solo si ese canal tiene
  // demanda activa en la capa → sin demanda de hover, no se hace picking de hover.
  #resolveParts(entry, eventType, baseEvent) {
    if (eventType === 'click') {
      return (entry.activeMask & EVENT_CLICK) ? (entry.resolveClick?.(baseEvent) ?? []) : []
    }
    return (entry.activeMask & EVENT_HOVER) ? (entry.resolveHover?.(baseEvent) ?? []) : []
  }
}
