import { coordOf, hasPointShape, isPlace } from '../geometry/polyline.js'
import { emptyBounds, growBounds, readBounds } from '../geometry/bounds.js'

// Camera — la ÚNICA vía de movimiento del viewport tras el montaje (SPECS §9, MODELO §5.4).
// Todo es acción (imperativo), no estado: no hay prop reactiva de centro. Aplica viewport-insets
// (UI que ocluye) corriendo el centro para que el objetivo caiga en la región visible, no detrás
// del panel. followPoint: la cámara sigue la posición VIVA de un id leyéndola
// del Source en cada flush (ya coalescido a rAF), sin que el consumidor bombee.
//
// Sus valores son los de la API, no los de Leaflet (SPECS §0): un punto entra en cualquier forma de
// cristae/geometry y una caja por su lector, y lo que Leaflet devuelve sale como objeto plano
// (`{ lat, lng }`, `{ x, y }`, `{ south, west, north, east }`).

const ZERO_INSETS = { top: 0, right: 0, bottom: 0, left: 0 }

const plainLatLng = ({ lat, lng }) => ({ lat, lng })

export class Camera {

  #map
  #L
  #insets
  #resolveSource
  #declusterZoomOf            // (layerId, id) → zoom mínimo desclusterizado | null (inyectado por el motor)
  #onInsetsChange             // () → void: el motor re-emite su vista (inyectado)
  #follow = null              // { id, zoom, source, unsub, lastKey }

  constructor({ map, L, insets, resolveSource, declusterZoomOf, onInsetsChange } = {}) {
    this.#map             = map
    this.#L               = L
    this.#insets          = { ...ZERO_INSETS, ...insets }
    this.#resolveSource   = resolveSource ?? (() => null)
    this.#declusterZoomOf = declusterZoomOf ?? (() => null)
    this.#onInsetsChange  = onInsetsChange ?? (() => {})
  }

  // Otros insets cambian la región visible aunque la vista no se mueva: se avisa como un movimiento más.
  set insets(insets) {
    this.#insets = { ...ZERO_INSETS, ...insets }
    this.#onInsetsChange()
  }
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

  // Sin caja no hay encuadre: lo que no es una caja no mueve la cámara ni corta el follow.
  fitBounds(bounds, { insets } = {}) {
    const box = readBounds(bounds)
    if (!box) return this
    this.stopFollow()
    const { top, right, bottom, left } = { ...this.#insets, ...insets }
    const padding = {
      paddingTopLeft: this.#L.point(left, top),
      paddingBottomRight: this.#L.point(right, bottom),
    }
    this.#map.fitBounds([[box.south, box.west], [box.north, box.east]], padding)
    return this
  }

  // Encuadra una capa por la caja de sus posiciones válidas. O(n) sobre el snapshot del Source.
  fitToLayer(layerId, { insets, maxZoom } = {}) {
    const source = this.#resolveSource(layerId)
    if (!source) return this
    const positionOf = source.accessors.positionOf
    const box        = emptyBounds()
    source.getSnapshot().forEach(item => {
      const p = positionOf(item)
      p && growBounds(box, p.lat, p.lng)
    })
    return this.#fitBox(box, insets, maxZoom)
  }

  // Encuadra (one-shot) el SUBCONJUNTO `ids` de una capa por la caja de sus posiciones válidas. Es a
  // fitToLayer lo que revealPoint es a fitBounds: acota a un set explícito en vez de toda la capa,
  // leyendo cada id por itemById. Cancela el follow (fitBounds ya lo hace) — es un reposicionamiento.
  // ids vacíos o sin ninguna posición válida → caja vacía → no-op (no rompe ni mueve la cámara).
  followBounds(layerId, ids, { insets, maxZoom } = {}) {
    const source = this.#resolveSource(layerId)
    if (!source) return this
    const positionOf = source.accessors.positionOf
    const box        = emptyBounds();
    (ids ?? []).forEach(id => {
      const item = source.itemById?.(id)
      const p = item && positionOf(item)
      p && growBounds(box, p.lat, p.lng)
    })
    return this.#fitBox(box, insets, maxZoom)
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
    if (!p || !isPlace(p.lat, p.lng)) return this
    const want = zoom ?? this.#map.getZoom()
    const dz = this.#declusterZoomOf(layerId, id)
    const z = dz != null && dz > want ? dz : want
    this.#map.setView(this.#centeredFor(p, z), z)
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

  // Navegación por CONJUNTO (la contraparte de followPoint, que es de un solo id): mode "fit" (default)
  // encuadra el set entero con followBounds (one-shot); mode "track" con UN único id delega en followPoint
  // (seguir la posición viva). Con "track" y varios ids no hay un objetivo vivo único que seguir → cae a
  // encuadrar el set. `rest` fluye al método delegado (fit → {insets,maxZoom}; track → {zoom,reveal}).
  followPoints(layerId, ids, { mode = 'fit', ...rest } = {}) {
    const list = ids ?? []
    return mode === 'track' && list.length === 1
      ? this.followPoint(layerId, list[0], rest)
      : this.followBounds(layerId, list, rest)
  }

  // Alias semántico: "enfocar" un conjunto = la misma acción (por default encuadrarlo).
  focusPoints(layerId, ids, options) { return this.followPoints(layerId, ids, options) }

  stopFollow() {
    this.#follow?.unsub?.()
    this.#follow = null
    return this
  }

  getCenter() { return plainLatLng(this.#map.getCenter()) }
  getZoom() { return this.#map.getZoom() }
  getBounds() {
    const b = this.#map.getBounds()
    return { south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() }
  }
  // Zoom máximo EFECTIVO (capacidad del tile: el mínimo maxZoom entre las capas). Cierra el motivo de
  // bajar a getLeafletMap() para saber hasta dónde se puede acercar (p. ej. limitar un fitToLayer).
  getMaxZoom() { return this.#map.getMaxZoom() }

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

  latLngToContainerPoint(latlng) {
    const { x, y } = this.#map.latLngToContainerPoint(this.#leafletLatLng(latlng))
    return { x, y }
  }
  containerPointToLatLng(point) { return plainLatLng(this.#map.containerPointToLatLng(point)) }

  destroy() { this.stopFollow() }

  /* ── Internos ── */

  // Encuadra la caja que acumuló un encuadre por capa. Sin caja no hay encuadre, y tampoco se aplica
  // `maxZoom`: acotaría un zoom que nadie movió.
  #fitBox(box, insets, maxZoom) {
    if (!readBounds(box)) return this
    this.fitBounds(box, { insets })
    maxZoom != null && this.#map.getZoom() > maxZoom && this.#map.setZoom(maxZoom)
    return this
  }

  // Re-centra solo si la posición del id seguido CAMBIÓ (un move de otro id no mueve la cámara).
  #recenterFollow() {
    const f = this.#follow
    if (!f) return
    const item = f.source.itemById?.(f.id)
    if (item == null) return
    const p = f.source.accessors.positionOf(item)
    if (!p || !isPlace(p.lat, p.lng)) return

    const key = `${p.lat},${p.lng}`
    if (key === f.lastKey) return               // sin cambio → no re-centrar (idempotente)
    f.lastKey = key

    const zoom = f.zoom ?? this.#map.getZoom()
    this.#map.setView(this.#centeredFor(p, zoom), zoom, { animate: false })
  }

  // Un punto en cualquier forma de cristae/geometry, como el LatLng que Leaflet recibe. Lo que no tiene la
  // forma de un punto lanza, y Leaflet rechaza lo que no trae dos números: no hay LatLng que construir.
  // La latitud no se acota acá: la proyección la lleva al rango del mapa.
  #leafletLatLng(point) {
    if (!hasPointShape(point)) throw new TypeError('[cristae] la cámara espera un punto')
    return this.#L.latLng(coordOf(point, 0), coordOf(point, 1))
  }

  // Corre el centro según los insets: el objetivo queda en el centro de la región VISIBLE.
  // Sin insets, es el punto tal cual (offset 0 → sin proyección extra).
  #centeredFor(point, zoom) {
    const latlng = this.#leafletLatLng(point)
    const { top, right, bottom, left } = this.#insets
    if (!top && !right && !bottom && !left) return latlng
    const offset = this.#L.point((left - right) / 2, (top - bottom) / 2)
    return this.#map.unproject(this.#map.project(latlng, zoom).subtract(offset), zoom)
  }
}
