import { EVENT_CLICK, EVENT_HOVER, EVENT_SECONDARY } from '../events/events.js'

// Ruteo del tipo de evento a sus PARTES de hit: cada canal se gatea por su propio bit de demanda
// y se resuelve con su propio resolver. Los clicks discretos (primario y secundario) comparten el
// pick síncrono `resolveClick` —el botón no cambia dónde cae el hit, sólo cuál se apretó—; cada uno
// se gatea por su bit. Tabla CONSTANTE de módulo (no se reconstruye por llamada) con prototipo nulo:
// un tipo desconocido —incluido el nombre de un método heredado como 'toString'— no matchea y cae
// al default de hover. Sin demanda del canal, el resolver ni se llama → cero picking ocioso.
const resolveHoverParts = (entry, sample) =>
  (entry.activeMask & EVENT_HOVER) ? (entry.resolveHover?.(sample) ?? []) : []

const HIT_PART_ROUTE = {
  __proto__        : null,
  'click'          : (entry, sample) =>
    (entry.activeMask & EVENT_CLICK) ? (entry.resolveClick?.(sample) ?? []) : [],
  'secondary-click': (entry, sample) =>
    (entry.activeMask & EVENT_SECONDARY) ? (entry.resolveClick?.(sample) ?? []) : [],
}

// Registro de capas interactivas. Genérico sobre funciones resolver: no conoce capas de
// puntos ni de polígonos, solo entradas con un par de resolvers (click/hover), z-index,
// orden de declaración, visibilidad y máscara de canales activos.
//
// resolveHits(eventType) recorre las capas visibles, pide hits solo a los resolvers cuyo
// canal está activo, y los devuelve ordenados top-first (zIndex desc, order asc, distancePx asc)
// para que el consumidor desambigüe sin recalcular geometría.
export class LayerRegistry {

  // Índice de capas: la entrada por id (la fuente de verdad) y el subconjunto de ids overlay
  // (capture/presentAs, que ocluyen o proxan en resolveHits). Los dos comparten keyspace y ciclo de
  // vida: toda alta pasa por upsertResolver y toda baja por removeByLayerId, para que ninguna operación
  // deje un índice desincronizado.
  #layers = {
    entriesById : new Map(),
    overlays    : new Set(),
  }

  // Inserta o reemplaza la entrada de una capa. Preserva la máscara activa previa si la
  // nueva no la trae (la demanda la recalcula el motor aparte).
  upsertResolver(entry) {
    const { entriesById, overlays } = this.#layers
    const previous = entriesById.get(entry.layerId)
    entry.visible    ??= true
    entry.activeMask ??= previous?.activeMask ?? 0

    entriesById.set(entry.layerId, entry)
    if (entry.capture || entry.presentAs) overlays.add(entry.layerId)
    else overlays.delete(entry.layerId)
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
  resolveHits(eventType, sample) {
    const hits = []

    this.#layers.entriesById.forEach(entry => {
      if (!entry.visible) return
      this.#resolveParts(entry, eventType, sample).forEach(part =>
        // El detalle propio del resolver pasa (una línea aporta `partIndex`/`segmentIndex`); las
        // claves del registro van DESPUÉS del spread: la identidad de la capa no es negociable.
        hits.push({
          ...part,
          layerId:    entry.layerId,
          kind:       entry.kind,
          distancePx: part.distancePx ?? Number.POSITIVE_INFINITY,
          zIndex:     entry.zIndex,
          order:      entry.declOrder,
        }))
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

  // ¿El puntero (en `sample`) cae sobre una feature de ALGUNA capa visible cuya demanda
  // intersecta `channelMask`? Usa el resolver de hover (proximidad geométrica para polígonos; pick
  // GPU ya recogido por la sesión para puntos). Es la consulta del CURSOR de affordance: una capa
  // con demanda de CLICK debe marcar el puntero aunque nadie escuche el canal de hover (ver
  // Interaction). No ordena ni materializa hits: corta al primer acierto (O(L) en el peor caso).
  hasHitForChannels(channelMask, sample) {
    for (const entry of this.#layers.entriesById.values()) {
      if (!entry.visible) continue
      if (!(entry.activeMask & channelMask)) continue
      const parts = entry.resolveHover?.(sample)
      if (parts?.length) return true
    }
    return false
  }

  removeByLayerId(layerId) {
    const { entriesById, overlays } = this.#layers
    entriesById.delete(layerId)
    overlays.delete(layerId)
  }

  // Pide partes de hit al resolver del canal correspondiente, solo si ese canal tiene demanda
  // activa en la capa → sin demanda de hover, no se hace picking de hover. El ruteo (bit + resolver)
  // sale de HIT_PART_ROUTE; un tipo desconocido cae al canal de hover. Se llama una vez por capa
  // dentro del recorrido de resolveHits: queda como método para no recrear el closure por iteración.
  #resolveParts(entry, eventType, sample) {
    return (HIT_PART_ROUTE[eventType] ?? resolveHoverParts)(entry, sample)
  }
}
