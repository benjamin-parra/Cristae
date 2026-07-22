// Camera — la ÚNICA vía de movimiento del viewport tras el montaje (SPECS §9, MODELO §5.4).
// Todo es acción (imperativo), no estado: no hay prop reactiva de centro. Aplica viewport-insets
// (UI que ocluye) corriendo el centro para que el objetivo caiga en la región visible, no detrás
// del panel. followPoint: la cámara sigue la posición VIVA de un id leyéndola
// del Source en cada flush (ya coalescido a rAF), sin que el consumidor bombee.

const ZERO_INSETS = { top: 0, right: 0, bottom: 0, left: 0 }

export class Camera {

  #map
  #L
  #insets
  #resolveSource
  #declusterZoomOf            // (layerId, id) → zoom mínimo desclusterizado | null (inyectado por el motor)
  #follow = null              // { id, zoom, source, unsub, lastKey }

  constructor({ map, L, insets, resolveSource, declusterZoomOf } = {}) {
    this.#map             = map
    this.#L               = L
    this.#insets          = { ...ZERO_INSETS, ...insets }
    this.#resolveSource   = resolveSource ?? (() => null)
    this.#declusterZoomOf = declusterZoomOf ?? (() => null)
  }

  set insets(insets) { this.#insets = { ...ZERO_INSETS, ...insets } }
  get insets() { return this.#insets }

  /* ── Movimiento puntual (un gesto del consumidor cancela el follow) ── */

  setView(latlng, zoom) {
    this.stopFollow()
    this.#map.setView(this.#centeredFor(latlng, zoom ?? this.#map.getZoom()), zoom ?? this.#map.getZoom())
    return this
  }

  panTo(latlng) {
    this.stopFollow()
    this.#map.panTo(this.#centeredFor(latlng, this.#map.getZoom()))
    return this
  }

  flyTo(latlng, zoom, options) {
    this.stopFollow()
    const z = zoom ?? this.#map.getZoom()
    this.#map.flyTo(this.#centeredFor(latlng, z), z, options)
    return this
  }

  fitBounds(bounds, { insets } = {}) {
    this.stopFollow()
    this.#map.fitBounds(bounds, this.#paddingFor(insets))
    return this
  }

  // Encuadra una capa por los bounds de sus puntos finitos. O(n) sobre el snapshot del Source.
  fitToLayer(layerId, { insets, maxZoom } = {}) {
    const source = this.#resolveSource(layerId)
    if (!source) return this
    const positionOf = source.accessors.positionOf
    const bounds = this.#L.latLngBounds([])
    source.getSnapshot().forEach(item => {
      const p = positionOf(item)
      if (p && Number.isFinite(p.lat) && Number.isFinite(p.lng)) bounds.extend([p.lat, p.lng])
    })
    if (bounds.isValid()) this.fitBounds(bounds, { insets: insets ?? this.#insets })
    if (maxZoom != null && this.#map.getZoom() > maxZoom) this.#map.setZoom(maxZoom)
    return this
  }

  // Enfoca un punto (one-shot) dejándolo VISIBLE individualmente: si su capa clusteriza, sube el zoom
  // al mínimo que lo desclusteriza. Por id como followPoint, puntual como setView. Sin capa clusterizada
  // (o si ya está solo al zoom pedido) es un setView normal. El zoom mínimo lo resuelve el motor
  // (inyectado) — Camera no conoce el cluster, igual que con resolveSource.
  revealPoint(layerId, id, { zoom } = {}) {
    this.stopFollow()
    const source = this.#resolveSource(layerId)
    const item = source?.itemById?.(id)
    const p = item && source.accessors.positionOf(item)
    if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lng)) return this
    const want = zoom ?? this.#map.getZoom()
    const dz = this.#declusterZoomOf(layerId, id)
    const z = dz != null && dz > want ? dz : want
    this.#map.setView(this.#centeredFor([p.lat, p.lng], z), z)
    return this
  }

  /* ── Seguimiento de posición viva ── */

  // `reveal`: al iniciar el follow, garantiza el zoom mínimo que desclusteriza el punto (una vez, no
  // por recenter — el zoom del follow es fijo). Sin capa clusterizada, es un followPoint normal.
  followPoint(layerId, id, { zoom, reveal = false } = {}) {
    this.stopFollow()
    const source = this.#resolveSource(layerId)
    if (!source) return this

    let z = zoom
    if (reveal) {
      const dz = this.#declusterZoomOf(layerId, id)
      if (dz != null) z = Math.max(z ?? this.#map.getZoom(), dz)
    }
    const recenter = () => this.#recenterFollow()
    this.#follow = { id, zoom: z, source, unsub: source.subscribe(recenter), lastKey: null }
    recenter()                                  // encuadre inicial inmediato
    return this
  }

  stopFollow() {
    this.#follow?.unsub?.()
    this.#follow = null
    return this
  }

  getCenter() { return this.#map.getCenter() }
  getZoom() { return this.#map.getZoom() }
  getBounds() { return this.#map.getBounds() }

  /* ── Zoom (ortogonal al follow: cambiar de nivel NO cancela el seguimiento de un punto, a
       diferencia de un setView/panTo; un +/− es un ajuste de escala, no un reposicionamiento) ── */

  zoomIn(delta) { this.#map.zoomIn(delta); return this }
  zoomOut(delta) { this.#map.zoomOut(delta); return this }
  setZoom(zoom) { this.#map.setZoom(zoom); return this }

  // Desplaza la vista por un delta en PÍXELES de contenedor (no geográfico). Ortogonal al follow
  // igual que el zoom: es un ajuste fino, no un reposicionamiento, así que NO cancela followPoint.
  // Lo usa el auto-pan del popup para meter una tarjeta que se sale del recuadro (el delta ya viene
  // calculado en píxeles contra los viewport-insets, así que la cámara solo lo aplica tal cual).
  panBy(offset, options) { this.#map.panBy(offset, options); return this }

  /* ── Proyección píxel ↔ geográfica relativa al contenedor. Cierra el motivo más común para bajar
       a getLeafletMap(): posicionar overlays HTML (popups, tarjetas) en light DOM sobre el mapa. ── */

  latLngToContainerPoint(latlng) { return this.#map.latLngToContainerPoint(latlng) }
  containerPointToLatLng(point) { return this.#map.containerPointToLatLng(point) }

  destroy() { this.stopFollow() }

  /* ── Internos ── */

  // Re-centra solo si la posición del id seguido CAMBIÓ (un move de otro id no mueve la cámara).
  #recenterFollow() {
    const f = this.#follow
    if (!f) return
    const item = f.source.itemById?.(f.id)
    if (item == null) return
    const p = f.source.accessors.positionOf(item)
    if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lng)) return

    const key = `${p.lat},${p.lng}`
    if (key === f.lastKey) return               // sin cambio → no re-centrar (idempotente)
    f.lastKey = key

    const zoom = f.zoom ?? this.#map.getZoom()
    this.#map.setView(this.#centeredFor(this.#L.latLng(p.lat, p.lng), zoom), zoom, { animate: false })
  }

  // Corre el centro según los insets: el objetivo queda en el centro de la región VISIBLE.
  // Sin insets, es el latlng tal cual (offset 0 → sin proyección extra).
  #centeredFor(latlng, zoom) {
    const { top, right, bottom, left } = this.#insets
    if (!top && !right && !bottom && !left) return latlng
    const offset = this.#L.point((left - right) / 2, (top - bottom) / 2)
    return this.#map.unproject(this.#map.project(latlng, zoom).subtract(offset), zoom)
  }

  #paddingFor(insets) {
    const { top, right, bottom, left } = { ...this.#insets, ...insets }
    return {
      paddingTopLeft: this.#L.point(left, top),
      paddingBottomRight: this.#L.point(right, bottom),
    }
  }
}
