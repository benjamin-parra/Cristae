import { EVENT_CLICK, EVENT_HOVER, EVENT_SECONDARY } from '../events/events.js'
import { HitResolver } from './HitResolver.js'

// Ruteo del tipo de evento a sus PARTES de hit: cada canal se gatea por su propio bit de demanda
// y se resuelve con su propio resolver. Los clicks discretos (primario y secundario) comparten el
// pick síncrono `resolveClick` —el botón no cambia dónde cae el hit, sólo cuál se apretó—; cada uno
// se gatea por su bit. Tabla CONSTANTE de módulo (no se reconstruye por llamada) con prototipo nulo:
// un tipo desconocido —incluido el nombre de un método heredado como 'toString'— no matchea y cae
// al default de hover. Sin demanda del canal, el resolver ni se llama → cero picking ocioso.
const resolveHoverParts = (entry, baseEvent) =>
  (entry.activeMask & EVENT_HOVER) ? (entry.resolveHover?.(baseEvent) ?? []) : []

const HIT_PART_ROUTE = {
  __proto__: null,
  'click': (entry, baseEvent) =>
    (entry.activeMask & EVENT_CLICK) ? (entry.resolveClick?.(baseEvent) ?? []) : [],
  'secondary-click': (entry, baseEvent) =>
    (entry.activeMask & EVENT_SECONDARY) ? (entry.resolveClick?.(baseEvent) ?? []) : [],
}

// Registro de capas interactivas. Genérico sobre funciones resolver: no conoce capas de
// puntos ni de polígonos, solo entradas con un par de resolvers (click/hover), z-index,
// orden de declaración, visibilidad y máscara de canales activos.
//
// resolveHits(eventType) recorre las capas visibles, pide hits solo a los resolvers cuyo
// canal está activo, y los devuelve ordenados top-first (zIndex desc, order asc, distancePx asc)
// para que el consumidor desambigüe sin recalcular geometría.
export class LayerRegistry {

  #hitResolver

  // Índice de capas: la entrada por id (la fuente de verdad), el objeto de dominio por id (para
  // getLayer) y el subconjunto de ids overlay (capture/presentAs, que ocluyen o proxan en
  // resolveHits). Los tres comparten keyspace y ciclo de vida: toda alta pasa por upsertResolver
  // y toda baja por #forget, para que ninguna operación deje un índice desincronizado.
  #layers = {
    entriesById: new Map(),
    objectsById: new Map(),
    overlays:    new Set(),
  }
  #nextDeclOrder = 0

  // Acepta un HitResolver ya construido o un map para fabricar el por-defecto sobre Leaflet.
  constructor(hitResolverOrMap) {
    this.#hitResolver = hitResolverOrMap instanceof HitResolver
      ? hitResolverOrMap
      : new HitResolver(hitResolverOrMap)
  }

  getLayer(layerId) {
    return this.#layers.objectsById.get(layerId) ?? null
  }

  // Vista ordenada (top-first) de las capas, para inspección/UI. No resuelve hits.
  getLayers() {
    return [...this.#layers.entriesById.values()]
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

    const { entriesById, objectsById, overlays } = this.#layers
    const previous = entriesById.get(entry.layerId)
    entry.visible = entry.visible ?? true
    entry.activeMask = entry.activeMask ?? previous?.activeMask ?? 0

    entriesById.set(entry.layerId, entry)
    if (entry.capture || entry.presentAs) overlays.add(entry.layerId)
    else overlays.delete(entry.layerId)
    if (layerObject !== undefined) objectsById.set(entry.layerId, layerObject)
  }

  setLayerVisibility(layerId, visible) {
    const entry = this.#layers.entriesById.get(layerId)
    if (!entry) return false
    entry.visible = !!visible
    return true
  }

  isLayerVisible(layerId) {
    return this.#layers.entriesById.get(layerId)?.visible ?? null
  }

  setLayerDemandMask(layerId, mask) {
    const entry = this.#layers.entriesById.get(layerId)
    if (!entry) return false
    entry.activeMask = mask
    return true
  }

  demandMaskOf(layerId) {
    return this.#layers.entriesById.get(layerId)?.activeMask ?? 0
  }

  layerIds() {
    return [...this.#layers.entriesById.keys()]
  }

  // Recolecta los hits de todas las capas visibles para un tipo de evento, ya ordenados
  // top-first. distancePx ausente cuenta como infinito (queda al fondo del desempate).
  resolveHits(eventType, baseEvent) {
    const hits = []

    this.#layers.entriesById.forEach(entry => {
      if (!entry.visible) return
      this.#resolveParts(entry, eventType, baseEvent).forEach(part => {
        // El detalle propio del resolver pasa (una línea aporta `partIndex`/`segmentIndex`); las
        // claves del registro van DESPUÉS del spread: la identidad de la capa no es negociable.
        hits.push({
          ...part,
          layerId: entry.layerId,
          kind: entry.kind,
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
    const { entriesById, overlays } = this.#layers
    if (!overlays.size) return hits
    for (let i = 0; i < hits.length; i++) {
      if (!overlays.has(hits[i].layerId)) continue
      const clipped = i + 1 < hits.length ? hits.slice(0, i + 1) : hits
      const proxied = entriesById.get(hits[i].layerId).presentAs?.(hits[i])
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
    for (const entry of this.#layers.entriesById.values()) {
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
    this.#layers.entriesById.forEach((entry, layerId) => {
      if (entry.getLeafletLayer?.() !== leafletLayer) return
      removedIds.push(layerId)
      this.#forget(layerId)
    })
    return removedIds
  }

  removeByLayerId(layerId) {
    this.#forget(layerId)
  }

  // Baja de una capa: la borra de los tres índices de una vez. Único punto de limpieza (lo
  // comparten removeByLayerId y removeByLeafletLayer) para que ninguna baja deje un índice colgado.
  #forget(layerId) {
    const { entriesById, objectsById, overlays } = this.#layers
    entriesById.delete(layerId)
    objectsById.delete(layerId)
    overlays.delete(layerId)
  }

  nextDeclOrder() {
    return this.#nextDeclOrder++
  }

  // Pide partes de hit al resolver del canal correspondiente, solo si ese canal tiene demanda
  // activa en la capa → sin demanda de hover, no se hace picking de hover. El ruteo (bit + resolver)
  // sale de HIT_PART_ROUTE; un tipo desconocido cae al canal de hover. Se llama una vez por capa
  // dentro del recorrido de resolveHits: queda como método para no recrear el closure por iteración.
  #resolveParts(entry, eventType, baseEvent) {
    return (HIT_PART_ROUTE[eventType] ?? resolveHoverParts)(entry, baseEvent)
  }
}
