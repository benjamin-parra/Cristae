import { prepareIndex, nearest, toParts } from '../geometry/polyline.js'

// Backend LEAFLET de la capa de líneas (`vector: true` en addLineLayer). Hermano de LineLayer (GL):
// misma interfaz de ciclo de vida y mismo contrato de hit (kind 'line', nearest-segment), pero dibuja
// con `L.polyline` en vez de glify. Elección de backend por el motor:
//   · GL (LineLayer)      → volumen / gradiente per-vértice / tiempo real; NO dibuja dash.
//   · Leaflet (este)      → pocas líneas, DASH real, reproyección nativa; sin gradiente ni volumen GL.
// Es el mismo patrón que polygon-layer (Leaflet-nativo) — Leaflet reproyecta solo en pan/zoom.

const DEFAULT_WEIGHT = 3
const DEFAULT_COLOR = '#666666'
const HIT_TOL_PX = 8

// styleOf.dash (número[] px) → cadena `stroke-dasharray`. Sin dash → undefined (sólido). Un solo eje
// cubre TODOS los patrones tradicionales (no hacen falta flags `dotted`/`dashDot`):
//   sólido    → (sin dash)        punteado  → [1, 6] + cap:'round'   (el cap redondo hace el punto)
//   guiones   → [8, 6]            raya-punto→ [12, 5, 1, 5] + cap:'round'   (línea de eje, «.-.-.-»)
const dashArrayOf = (dash) => (Array.isArray(dash) && dash.length ? dash.join(' ') : undefined)

export class LeafletLineLayer {

  #L; #map; #pane; #source; #interactive
  #accessors
  #group     = null
  #index     = { sorted: [] }   // índice espacial nearest-segment (picking, uniforme con el backend GL)
  #maxWeight = DEFAULT_WEIGHT
  #unsub     = null

  constructor({ L, map, pane, source, interactive = false }) {
    this.#L = L
    this.#map = map
    this.#pane = pane
    this.#source = source
    this.#accessors = source.accessors
    this.#interactive = interactive
    this.#group = L.layerGroup([], { pane }).addTo(map)
    this.#unsub = source.subscribe(() => this.#rebuild())
    this.#rebuild()
  }

  /* ── Lifecycle: NO es capa GL (Leaflet reproyecta solo) → el motor no la inscribe en #glLayers ── */
  destroy() {
    this.#unsub?.()
    this.#group?.remove()
    this.#group = null
  }

  /* ── Picking CPU nearest-segment (idéntico al backend GL): kind 'line', distancePx real ── */
  resolveClick(baseEvent) { return this.#hitsAt(baseEvent) }
  resolveHover(baseEvent) { return this.#hitsAt(baseEvent) }

  #hitsAt(baseEvent) {
    if (!this.#interactive || !baseEvent?.latlng || !this.#index.sorted.length) return []
    const scale = 2 ** this.#map.getZoom()
    const tolPx = HIT_TOL_PX + this.#maxWeight / 2
    const hits = nearest(baseEvent.latlng.lat, baseEvent.latlng.lng, this.#index, tolPx / scale)
    return hits.map(h => ({
      ref: h.id, id: h.id, distancePx: h.dist * scale,
      partIndex: h.partIndex, vertexIndex: h.vertexIndex,
    }))
  }

  /* ── Rebuild ante cualquier cambio del Source (coalescido a rAF por el Emitter) ── */
  // `L.polyline` acepta el multi-parte nativo (array de paths) → una sola capa por entidad.
  #rebuild() {
    const a = this.#accessors
    const built = this.#source.getSnapshot()
      .map((item) => ({ id: a.idOf(item), st: a.styleOf?.(item), parts: toParts(a.pathOf(item)) }))
      .filter(({ parts }) => parts.length)

    this.#group.clearLayers()
    built.forEach(({ parts, st }) => this.#L.polyline(parts.map(p => p.path), {
      pane: this.#pane,
      color: st?.color ?? DEFAULT_COLOR,
      weight: st?.weight ?? DEFAULT_WEIGHT,
      opacity: st?.opacity ?? 1,
      dashArray: dashArrayOf(st?.dash),
      lineCap: st?.cap,              // 'round' vuelve punto redondo cada tramo corto del dash
      interactive: false,            // picking propio por índice (uniforme con el backend GL)
    }).addTo(this.#group))

    this.#maxWeight = built.reduce((m, { st }) => Math.max(m, st?.weight ?? DEFAULT_WEIGHT), DEFAULT_WEIGHT)
    this.#index = prepareIndex(built)
  }
}
