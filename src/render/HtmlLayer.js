// Capa de MARCADORES HTML (`L.divIcon`) sobre Leaflet — NO es GL, NO abre otro contexto WebGL. Su
// nicho: pocos/medianos marcadores con contenido HTML ARBITRARIO (un heroicon, un glifo de fuente, una
// letra) + popup/tooltip, que el iconset canvas del point-layer no rinde. Es el COMPLEMENTO del
// point-layer GPU (alta cardinalidad / tiempo real), no su competidor. Reproyecta nativo (Leaflet).
//
// accessors: { idOf, positionOf, htmlOf(item)->string, classNameOf?(item)->string, sizeOf?(item)->[w,h],
//              anchorOf?(item)->[x,y] }. Estado (position/html) → mutar item + set/patch la Source.

const HIT_TOL_PX = 16

export class HtmlLayer {

  #L; #map; #pane; #source; #interactive
  #accessors
  #group = null
  #byId = new Map()               // id → L.marker (para el hit por proximidad)
  #hitTol = HIT_TOL_PX            // tolerancia de hit vigente (deriva del sizeOf mayor)
  #unsub = null

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

  destroy() {
    this.#unsub?.()
    this.#group?.remove()
    this.#group = null
    this.#byId.clear()
  }

  /* ── Picking: marcadores dentro de tolerancia (kind 'html'); el registro los ordena por distancePx ── */
  resolveClick(baseEvent) { return this.#hitsAt(baseEvent) }
  resolveHover(baseEvent) { return this.#hitsAt(baseEvent) }

  #hitsAt(baseEvent) {
    if (!this.#interactive || !baseEvent?.latlng || !this.#byId.size) return []
    const cp = baseEvent.containerPoint ?? this.#map.latLngToContainerPoint(baseEvent.latlng)
    const tol = this.#hitTol                      // deriva del sizeOf mayor: un badge grande pica en toda su caja
    const out = []
    this.#byId.forEach((marker, id) => {
      const mp = this.#map.latLngToContainerPoint(marker.getLatLng())
      const d = Math.hypot(mp.x - cp.x, mp.y - cp.y)
      if (d <= tol) out.push({ ref: id, id, distancePx: d })
    })
    return out
  }

  /* ── Rebuild ante cambio del Source (coalescido a rAF) ── */
  #rebuild() {
    const a = this.#accessors
    const snap = this.#source.getSnapshot()
    this.#group.clearLayers()
    this.#byId.clear()
    let tol = HIT_TOL_PX
    for (let i = 0; i < snap.length; i++) {
      const item = snap[i]
      const pos = a.positionOf(item)
      if (!pos || !Number.isFinite(pos.lat) || !Number.isFinite(pos.lng)) continue
      const { lat, lng } = pos     // copia inmediata: el objeto de `positionOf` puede ser scratch reusado
      const id = a.idOf(item)
      const size = a.sizeOf ? a.sizeOf(item) : null           // [w,h] px, o null = tamaño por CSS
      const anchor = a.anchorOf ? a.anchorOf(item) : (size ? [size[0] / 2, size[1] / 2] : undefined)
      if (size) tol = Math.max(tol, size[0] / 2, size[1] / 2)
      // Sin `sizeOf` NI `anchorOf`, Leaflet deja la esquina superior-izquierda del div sobre el punto
      // (no aplica márgenes de centrado sin iconSize) → el ancla visual no coincidiría con getLatLng()
      // y el picking fallaría. Se centra el contenido por CSS para que el punto quede en su medio.
      const html = (!size && !anchor)
        ? `<div style="transform:translate(-50%,-50%);width:max-content">${a.htmlOf(item)}</div>`
        : a.htmlOf(item)
      const icon = this.#L.divIcon({
        html,
        className: a.classNameOf ? a.classNameOf(item) : 'cristae-html-marker',
        iconSize: size,
        iconAnchor: anchor,
      })
      const marker = this.#L.marker([lat, lng], { pane: this.#pane, icon, interactive: false })
      marker.addTo(this.#group)
      this.#byId.set(id, marker)
    }
    this.#hitTol = tol
  }
}
