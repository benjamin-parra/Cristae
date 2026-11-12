import { coordOf, isPlace } from '../data/path.js'
import { emptyBounds, growBounds, growItem, readBounds } from '../geometry/bounds.js'
import { byDefault } from '../geometry/geodesic.js'

// Camera — la ÚNICA vía de movimiento del viewport tras el montaje (SPECS §9, MODELO §5.4).
// Todo es acción (imperativo), no estado: no hay prop reactiva de centro. Aplica viewport-insets
// (UI que ocluye) corriendo el centro para que el objetivo caiga en la región visible, no detrás
// del panel. followPoint: la cámara sigue la posición VIVA de un id leyéndola
// del Source en cada flush (ya coalescido a rAF), sin que el consumidor bombee.
//
// Mueve y lee la vista por la cámara del anfitrión, que habla en los valores de la API (SPECS §0): un
// punto entra en cualquier forma de cristae/geometry y una caja por su lector.

const ZERO_INSETS = { top: 0, right: 0, bottom: 0, left: 0 }

// El zoom al que un ítem de un solo lugar queda a la vista con su entorno: a z16 un px CSS mide
// 156543,03·cos(lat)/2^16 ≈ 2,4 m en el ecuador y ≈ 1,9 m a 37°, así que una cuadra de 100 m ocupa unos 40 a
// 50 px y el ítem conserva su calle a la vista. Queda tres niveles bajo el techo de tilePresets.osm (19):
// todavía se puede acercar. El tope de la cámara (max-zoom) lo aplica el anfitrión.
export const FIT_POINT_MIN_ZOOM = 16

// Un zoom o una viscosidad que no es un número finito no limita: ni como límite de la cámara, ni como
// tope de un encuadre.
const finite = value => Number.isFinite(value) ? value : null

// Los límites de la cámara como los lee el anfitrión (SPECS §9); una caja que no lo es (SPECS §18) no
// limita. Los pone el motor, al crear su mapa y en `setLimits`.
export const limitsOf = ({ minZoom, maxZoom, maxBounds, maxBoundsViscosity } = {}) => ({
  minZoom   : finite(minZoom),
  maxZoom   : finite(maxZoom),
  maxBounds : readBounds(maxBounds),
  viscosity : finite(maxBoundsViscosity),
})

export class Camera {

  #hostCamera
  #insets
  #resolveSource
  #model                      // () → modelo de la Tierra con que se miden las distancias (inyectado por el motor)
  #screenCarrier = { x: 0, y: 0, visible: false, occluded: false }   // portadores de metersPerPixelAt, reusados
  #surfaceCarrier = { lat: 0, lng: 0, onSurface: false, incidence: 0, altitude: 0 }
  #boundsOf                   // layerId → caja en grados que la capa informa de su dibujo | null (inyectado)
  #declusterZoomOf            // (layerId, id) → zoom mínimo desclusterizado | null (inyectado por el motor)
  #onInsetsChange             // () → void: el motor re-emite su vista (inyectado)
  #follow = null              // { id, zoom, source, unsub, lastKey }

  constructor({ host, insets, resolveSource, model, boundsOf, declusterZoomOf, onInsetsChange } = {}) {
    this.#hostCamera      = host.camera
    this.#insets          = { ...ZERO_INSETS, ...insets }
    this.#resolveSource   = resolveSource ?? (() => null)
    this.#model           = model ?? (() => byDefault)
    this.#boundsOf        = boundsOf ?? (() => null)
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
    const z = zoom ?? this.#hostCamera.zoom()
    this.#hostCamera.setView(this.#centeredFor(latlng, z), z)
    return this
  }

  panTo(latlng) {
    this.stopFollow()
    this.#hostCamera.panTo(this.#centeredFor(latlng, this.#hostCamera.zoom()))
    return this
  }

  // Si vuela o salta lo decide la política de animación del zoom (SPECS §9).
  flyTo(latlng, zoom, options) {
    this.stopFollow()
    const z = zoom ?? this.#hostCamera.zoom()
    this.#hostCamera.flyTo(this.#centeredFor(latlng, z), z, options)
    return this
  }

  // Sin caja no hay encuadre: lo que no es una caja no mueve la cámara, ni corta el follow, ni aplica
  // `maxZoom`, que acotaría un zoom que nadie movió.
  fitBounds(bounds, { insets, maxZoom, animate } = {}) {
    const box = readBounds(bounds)
    if (!box) return this
    this.stopFollow()
    this.#hostCamera.fitBounds(box, { insets: { ...this.#insets, ...insets }, maxZoom: finite(maxZoom), animate })
    return this
  }

  // Encuadra una capa por la caja de lo que dibuja, si la informa —una forma es más que su centro—, o por la
  // de lo que dibuja cada ítem de su Source: O(n) sobre el snapshot. Con `ids` (iterable) encuadra sólo esos
  // ítems, por los lugares que dibuja cada uno (vértices de una línea o polígono; en las formas, su centro y
  // no su radio); si esa caja es un solo lugar acerca hasta FIT_POINT_MIN_ZOOM sin alejar nunca, y ids
  // vacíos o desconocidos no mueven la cámara. Sin `ids` el encuadre no cambia: la regla del punto no aplica.
  fitToLayer(layerId, { insets, maxZoom, ids } = {}) {
    if (ids != null) return this.#fitItems(layerId, ids, insets, maxZoom)
    const drawn = this.#boundsOf(layerId)
    if (drawn) return this.fitBounds(drawn, { insets, maxZoom })
    const source = this.#resolveSource(layerId)
    if (!source) return this
    const accessors = source.accessors
    const box       = emptyBounds()
    source.getSnapshot().forEach(item => growItem(box, accessors, item))
    return this.fitBounds(box, { insets, maxZoom })
  }

  #fitItems(layerId, ids, insets, maxZoom) {
    const source = this.#resolveSource(layerId)
    if (!source) return this
    const accessors = source.accessors
    const box       = emptyBounds()
    for (const id of ids) {
      const item = source.itemById?.(id)
      item && growItem(box, accessors, item)
    }
    if (!readBounds(box)) return this
    if (box.south !== box.north || box.west !== box.east) return this.fitBounds(box, { insets, maxZoom })
    const center = { lat: box.south, lng: box.west }
    const z0     = this.#hostCamera.zoom()
    if (z0 >= FIT_POINT_MIN_ZOOM) {
      this.stopFollow()
      this.#hostCamera.panTo(this.#centeredFor(center, z0, insets))
      return this
    }
    const cap = finite(maxZoom)
    return this.#flyCentered(center, Math.max(z0, cap === null ? FIT_POINT_MIN_ZOOM : Math.min(FIT_POINT_MIN_ZOOM, cap)), insets)
  }

  #flyCentered(center, z, insets) {
    this.stopFollow()
    this.#hostCamera.flyTo(this.#centeredFor(center, z, insets), z)
    return this
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
    return this.fitBounds(box, { insets, maxZoom })
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
    const want = zoom ?? this.#hostCamera.zoom()
    const dz = this.#declusterZoomOf(layerId, id)
    const z = dz != null && dz > want ? dz : want
    this.#hostCamera.setView(this.#centeredFor(p, z), z)
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
      if (dz != null) z = Math.max(z ?? this.#hostCamera.zoom(), dz)
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

  getCenter() { return this.#hostCamera.center() }
  getZoom() { return this.#hostCamera.zoom() }
  // La caja envolvente de lo visible; en Mercator sin inclinación, exactamente la de hoy.
  getBounds() { return this.#hostCamera.bounds() }
  // Zoom EFECTIVO en cada extremo: el límite `minZoom`/`maxZoom` si lo hay y, si no, lo que permiten las
  // capas (el máximo minZoom y el mínimo maxZoom entre ellas). Cierran el motivo de bajar a getLeafletMap()
  // para saber hasta dónde se puede alejar o acercar.
  getMinZoom() { return this.#hostCamera.minZoom() }
  getMaxZoom() { return this.#hostCamera.maxZoom() }

  /* ── Zoom (ortogonal al follow: cambiar de nivel NO cancela el seguimiento de un punto, a
       diferencia de un setView/panTo; un +/− es un ajuste de escala, no un reposicionamiento) ── */

  zoomIn(delta) { this.#hostCamera.zoomIn(delta); return this }
  zoomOut(delta) { this.#hostCamera.zoomOut(delta); return this }
  setZoom(zoom) { this.#hostCamera.setZoom(zoom); return this }

  // Desplaza la vista por un delta en PÍXELES de contenedor (no geográfico). Ortogonal al follow
  // igual que el zoom: es un ajuste fino, no un reposicionamiento, así que NO cancela followPoint.
  // Lo usa el auto-pan del popup para meter una tarjeta que se sale del recuadro (el delta ya viene
  // calculado en píxeles contra los viewport-insets, así que la cámara solo lo aplica tal cual).
  panBy(offset, options) { this.#hostCamera.panBy(offset, options); return this }

  /* ── Conversiones entre el píxel del contenedor y la superficie. Cierran el motivo más común para bajar
       a getLeafletMap(): posicionar overlays HTML (popups, tarjetas) en light DOM sobre el mapa. Dicen la
       verdad de la vista: si el punto cae en el contenedor (`visible`), si lo tapa el relieve (`occluded`) y
       si el píxel toca la superficie (`onSurface`). ── */

  // Con `out` reusado no asigna: es el camino de lo que se reubica en cada cuadro.
  latLngToContainerPoint(latlng, out = { x: 0, y: 0, visible: false, occluded: false }) {
    return this.#hostCamera.toScreen(latlng, out)
  }
  containerPointToLatLng(point) {
    return this.#hostCamera.surfaceAt(point, { lat: 0, lng: 0, onSurface: false, incidence: 0, altitude: 0 })
  }

  // Los metros que mide un píxel CSS hacia el este, con la distancia del modelo del mapa. Sin argumento,
  // en el centro del contenedor. NaN si el punto no toca la superficie o lo tapa el relieve.
  metersPerPixelAt(latlng) {
    if (latlng === undefined) {
      const size = this.#hostCamera.size()
      const at   = this.#surfaceCarrier
      this.#hostCamera.surfaceAt({ x: size.x / 2, y: size.y / 2 }, at)
      return at.onSurface ? this.#hostCamera.metersPerPixelAt(at.lat, at.lng, this.#model()) : NaN
    }
    if (this.#hostCamera.toScreen(latlng, this.#screenCarrier).occluded) return NaN
    return this.#hostCamera.metersPerPixelAt(+coordOf(latlng, 0), +coordOf(latlng, 1), this.#model())
  }

  destroy() { this.stopFollow() }

  /* ── Internos ── */

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

    const zoom = f.zoom ?? this.#hostCamera.zoom()
    this.#hostCamera.setView(this.#centeredFor(p, zoom), zoom, { animate: false })
  }

  // Corre el centro según los insets: el objetivo queda en el centro de la región VISIBLE.
  // Sin insets, es el punto tal cual (offset 0 → sin proyección extra); la forma la valida el anfitrión.
  // `extra` son los insets de una llamada, que se componen con los de la cámara como en fitBounds.
  #centeredFor(point, zoom, extra) {
    const { top, right, bottom, left } = extra ? { ...this.#insets, ...extra } : this.#insets
    if (!top && !right && !bottom && !left) return point
    const { x, y } = this.#hostCamera.project(point, zoom)
    return this.#hostCamera.unproject({ x: x - (left - right) / 2, y: y - (top - bottom) / 2 }, zoom)
  }
}
