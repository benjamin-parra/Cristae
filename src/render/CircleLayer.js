// Capa de CÍRCULOS en METROS (`L.circle`) sobre Leaflet — NO es GL, NO abre otro contexto WebGL. El
// radio se declara en METROS y Leaflet lo reproyecta a píxeles en cada pan/zoom: el círculo CRECE al
// acercar y ENCOGE al alejar (a diferencia de un sprite de tamaño fijo en px, que es el nicho del
// point-layer GPU). Su uso: coberturas, radios de acción, tolerancias geográficas — cosas cuyo tamaño
// es una MAGNITUD del mundo, no un adorno de pantalla. Hermana Leaflet-nativa de polygon/line-vector.
//
// accessors: { idOf, positionOf(item)->{lat,lng}, radiusMetersOf(item)->number, styleOf?(item)->opts }.
// `styleOf` devuelve opciones de path de Leaflet (color, fillColor, weight, opacity, fillOpacity, …).
// Estado (posición/radio/estilo) → mutar el item + set/patch la Source; NO hay API imperativa de restyle.
//
// Picking: CPU point-in-circle. El punto está DENTRO si su distancia geográfica al centro ≤ radio en
// metros; se aproxima con proyección equirectangular local (dx = Δlng·cos(lat̄), dy = Δlat), suficiente
// a las escalas de un radio de cobertura. kind 'circle', hit de ÁREA (distancePx 0, como polygon).

const R_TIERRA = 6378137          // radio terrestre WGS84 (m) — factor para pasar radianes a metros
const RAD = Math.PI / 180

export class CircleLayer {

  #L; #pane; #source; #interactive
  #accessors
  #group = null
  #byId  = new Map()    // id → { circle, lat, lng, radius } (centro/radio cacheados para el hit CPU)
  #unsub = null

  // `map` sólo ancla el layerGroup en el constructor (el picking es en espacio latlng, sin escala de
  // zoom); no se retiene como campo — como PolygonLayer.
  constructor({ L, map, pane, source, interactive = false }) {
    this.#L           = L
    this.#pane        = pane
    this.#source      = source
    this.#accessors   = source.accessors
    this.#interactive = interactive
    this.#group       = L.layerGroup([], { pane }).addTo(map)
    this.#unsub       = source.subscribe(() => this.#onChange())
    this.#onChange()
  }

  /* ── Lifecycle: Leaflet reproyecta solo (no es capa GL → el motor no la inscribe en #glLayers) ── */
  redraw() {}                                                     // Leaflet re-dibuja en pan/zoom sin ayuda
  refresh() { if (this.#group) this.#rebuild(this.#source.getSnapshot()) }   // no-op tras destroy (group null)
  destroy() {
    this.#unsub?.()
    this.#group?.remove()
    this.#group = null
    this.#byId.clear()
  }

  /* ── Picking CPU point-in-circle (kind 'circle'); el registro ordena y envuelve con layerId/z/order ── */
  resolveClick(baseEvent) { return this.#hitsAt(baseEvent) }
  resolveHover(baseEvent) { return this.#hitsAt(baseEvent) }

  #hitsAt(baseEvent) {
    if (!this.#interactive || !baseEvent?.latlng || !this.#byId.size) return []
    const { lat, lng } = baseEvent.latlng
    return [...this.#byId]
      .filter(([, rec]) => this.#contiene(lat, lng, rec))
      .map(([id]) => ({ ref: id, id, distancePx: 0 }))
  }

  // Distancia geográfica centro→punto por equirectangular local: los grados de longitud se acortan por
  // cos(lat̄), los de latitud son constantes; ‖(dx, dy)‖·R = metros. Barato y exacto a escala de radio.
  #contiene(lat, lng, { lat: clat, lng: clng, radius }) {
    const dx = (lng - clng) * RAD * Math.cos(((lat + clat) / 2) * RAD)
    const dy = (lat - clat) * RAD
    return Math.hypot(dx, dy) * R_TIERRA <= radius
  }

  /* ── Reacción al Source (coalescida a rAF por el Emitter) ── */
  // Fast-path como point-layer: la Source separa dos clases de suciedad y la capa consume AMBAS —
  //   · dirtyIds()     → cambios estructurales (posición/radio/estilo por `set`/`patch`)
  //   · moveDirtyIds() → reubicaciones O(1) por `source.move()` (override de centro, sin re-struct)
  // Un `move` NO aparece en dirtyIds, así que ignorarlo dejaba el círculo clavado en su centro viejo.
  // Se recorre SÓLO el set sucio vía itemById (O(k), no O(n) sobre el snapshot), y se guarda por
  // `?.size` para no tocar nada en un flush vacío. Si el set cambió (altas/bajas) o falta itemById,
  // rebuild O(n). En ambas suciedades `positionOf` ya resuelve el override del move.
  #onChange() {
    const snap     = this.#source.getSnapshot()
    const itemById = this.#source.itemById
    const dirty    = this.#source.dirtyIds?.()
    const moves    = this.#source.moveDirtyIds?.()
    if (this.#group && itemById && (dirty?.size || moves?.size) && this.#mismoSet(snap)) {
      if (dirty?.size) this.#patchStructs(dirty, itemById)
      if (moves?.size) this.#patchMoves(moves, itemById)
      return
    }
    this.#rebuild(snap)
  }

  #mismoSet(snap) {
    if (snap.length !== this.#byId.size) return false
    const idOf = this.#accessors.idOf
    return snap.every(item => this.#byId.has(idOf(item)))
  }

  // Cambios estructurales: re-aplica centro + radio + estilo del ítem sucio sobre su L.circle vivo.
  #patchStructs(dirty, itemById) {
    const a = this.#accessors
    dirty.forEach(id => {
      const rec  = this.#byId.get(id)
      const item = itemById(id)
      if (!rec || item == null) return
      const pos = a.positionOf(item)
      if (!pos || !Number.isFinite(pos.lat) || !Number.isFinite(pos.lng)) return
      const radius = a.radiusMetersOf(item)
      if (!Number.isFinite(radius) || radius <= 0) return
      rec.lat = pos.lat; rec.lng = pos.lng; rec.radius = radius
      rec.circle.setLatLng([pos.lat, pos.lng])
      rec.circle.setRadius(radius)
      const st = a.styleOf?.(item)
      if (st) rec.circle.setStyle(st)
    })
  }

  // Reubicaciones O(1): sólo el centro cambia (el override lo trae `positionOf`); radio/estilo intactos.
  #patchMoves(moves, itemById) {
    const a = this.#accessors
    moves.forEach(id => {
      const rec  = this.#byId.get(id)
      const item = itemById(id)
      if (!rec || item == null) return
      const pos = a.positionOf(item)
      if (!pos || !Number.isFinite(pos.lat) || !Number.isFinite(pos.lng)) return
      rec.lat = pos.lat; rec.lng = pos.lng
      rec.circle.setLatLng([pos.lat, pos.lng])
    })
  }

  #rebuild(snap) {
    const a = this.#accessors
    this.#group.clearLayers()
    this.#byId.clear()
    snap
      // Se leen lat/lng como escalares acá mismo: `positionOf` puede devolver un objeto scratch reusado,
      // así que retenerlo a través del pipeline apuntaría todas las filas al mismo objeto mutado.
      .map(item => {
        const pos = a.positionOf(item)
        return { id: a.idOf(item), lat: pos?.lat, lng: pos?.lng, radius: a.radiusMetersOf(item), st: a.styleOf?.(item) }
      })
      .filter(({ lat, lng, radius }) =>
        Number.isFinite(lat) && Number.isFinite(lng) && Number.isFinite(radius) && radius > 0)
      .forEach(({ id, lat, lng, radius, st }) => {
        const circle = this.#L
          .circle([lat, lng], { pane: this.#pane, radius, interactive: false, ...st })
          .addTo(this.#group)
        this.#byId.set(id, { circle, lat, lng, radius })
      })
  }
}
