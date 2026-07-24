// Editor de geometría como un <input> CONTROLADO, nativo de Leaflet — 0 contextos WebGL. Hermano de
// HtmlLayer / LeafletLineLayer (todo con L.marker / L.divIcon; Leaflet reproyecta solo en pan/zoom).
//
// Contrato de "input controlado": el valor ENTRA por `value` (constructor / setValue) y las ediciones
// SALEN por `onChange` (live, cada cambio — incluye cada frame de drag) y `onCommit` (una vez, al asentar
// el gesto: dragend / edición discreta). La primitiva POSEE los handles (marcadores de vértice, puntos de
// arista para insertar, borrado por dblclick, y el trazado de uno nuevo en modo draw), pero NO dibuja la
// FORMA en sí: el display se ata afuera enlazando el mismo `value` a una capa de exhibición
// (addPolygonLayer / addLineLayer). Así el editor es puro estado→handles→cambio, sin duplicar el render.
//
// Sistema de coordenadas: pares [lat, lng] (se aceptan también {lat, lng} en la entrada; la salida SIEMPRE
// es [lat, lng]). Formas por `kind`:
//   · polygon   → rings: anillo simple [[lat,lng],…] o multi-anillo [[[lat,lng],…],…] (sin cerrar: el
//                 primer punto NO se repite al final). La salida conserva la forma de la entrada.
//   · polyline  → path: [[lat,lng],…]
//   · point     → [lat,lng]  (o null mientras no se dibujó)
//   · rectangle → bounds: [[sur,oeste],[norte,este]]  (o null mientras no se dibujó)

const MIN_VERTICES = { polygon: 3, polyline: 2 }   // mínimo bajo el cual el borrado por dblclick se ignora
const KINDS        = new Set(['polygon', 'rectangle', 'polyline', 'point'])

const toPair    = c => (Array.isArray(c) ? [c[0], c[1]] : [c.lat, c.lng])
const clonePair = p => [p[0], p[1]]
const midpoint  = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
const samePoint = (a, b) => !!a && !!b && a[0] === b[0] && a[1] === b[1]

// Un par [lat,lng] finito (rechaza NaN/Infinity/undefined). Garbage-in: se descarta, no se propaga.
const isFinitePair = p => Number.isFinite(p[0]) && Number.isFinite(p[1])
// Coacción tolerante de la ENTRADA a par finito, o null si no es una coordenada válida (null/undefined,
// componentes no numéricos, no-finitos). Distinta de `toPair`, que asume una latlng viva de Leaflet.
const toFinitePair = c => {
  if (c == null) return null
  const p = toPair(c)
  return isFinitePair(p) ? p : null
}

// ¿`value` es multi-anillo? Un anillo simple tiene COORDENADAS como elementos (pares [lat,lng] U objetos
// {lat,lng}); un multi-anillo tiene ANILLOS como elementos. Se discrimina por `value[0]`: si es un par de
// números (value[0][0] es número) → es una coordenada → anillo simple; si es un array cuyo primer elemento
// NO es número (otra coordenada anidada, sea par u objeto) → es un anillo → multi. Un objeto {lat,lng} como
// coordenada no es array, así que también cae en anillo simple. Esto soporta ambas formas de entrada.
const isMultiRing = value =>
  Array.isArray(value?.[0]) && value[0][0] != null && typeof value[0][0] !== 'number'

export class EditableGeometry {

  #L; #map; #pane; #kind; #onChange; #onCommit
  #group       = null
  #mode        = 'edit'
  #geom        = null                      // representación interna viva (mutada in place por los handles)
  #simpleRing  = true                      // polygon: recordar si la entrada era anillo simple (para la salida)
  #pathRecs    = []                        // por-anillo/path: { coords, closed, vMarkers, mMarkers }
  #rectMarkers = []                        // rectangle: 4 esquinas [SW, NW, NE, SE]
  #drawAnchor  = null                      // rectangle draw: primera esquina fijada por click
  #vertexIcon  = null
  #midIcon     = null

  constructor({ L, map, pane, kind = 'polygon', value = null, mode = 'edit', onChange, onCommit } = {}) {
    if (!KINDS.has(kind)) throw new Error(`EditableGeometry: kind inválido "${kind}"`)
    this.#L          = L
    this.#map        = map
    this.#pane       = pane
    this.#kind       = kind
    this.#onChange   = onChange
    this.#onCommit   = onCommit
    this.#group      = L.layerGroup([], pane ? { pane } : {}).addTo(map)
    this.#vertexIcon = L.divIcon({ className: 'cristae-edit-vertex', iconSize: [12, 12], iconAnchor: [6, 6] })
    this.#midIcon    = L.divIcon({ className: 'cristae-edit-midpoint', iconSize: [10, 10], iconAnchor: [5, 5] })
    this.#geom       = this.#ingest(value)
    this.#mode       = mode
    if (mode === 'draw') this.#attachMap()
    this.#rebuild()
  }

  /* ── API pública ──────────────────────────────────────────────────────────────────────── */

  // Nuevo valor externo (input controlado): NO emite onChange — es el mundo empujando estado, no una edición.
  setValue(value) {
    this.#geom = this.#ingest(value)
    this.#drawAnchor = null
    this.#rebuild()
  }

  setMode(mode) {
    if (mode === this.#mode) return
    this.#detachMap()
    this.#mode = mode
    this.#drawAnchor = null
    if (mode === 'draw') this.#attachMap()
    this.#rebuild()
  }

  getValue() { return this.#serialize() }

  // Sub-pieza "click en mapa vacío → latlng": expuesta para que el consumidor rutee su propia captura de
  // punto (además de la suscripción nativa a map.on('click') que hace el modo draw). En draw, agrega/coloca.
  handleMapClick(latlng) {
    if (this.#mode !== 'draw' || !latlng) return
    const p = toFinitePair(latlng)
    if (!p) return                                          // garbage-in en el trazado tampoco entra
    if (this.#kind === 'point') { this.#geom.pt = p; this.#emit(); this.#emitCommit(); this.#rebuild(); return }
    if (this.#kind === 'rectangle') return this.#drawRectClick(p)
    const coords = this.#kind === 'polygon' ? this.#geom.rings[0] : this.#geom.path
    // No agregar un vértice idéntico al último: Leaflet dispara un `click` en la MISMA posición junto al
    // `dblclick` de cierre; deduplicarlo acá neutraliza ese click (no se duplica el último punto ni se
    // emite una geometría con un punto repetido).
    if (samePoint(coords[coords.length - 1], p)) return
    coords.push(p)
    this.#emit()
    this.#emitCommit()
    this.#rebuild()
  }

  destroy() {
    this.#detachMap()
    this.#group?.clearLayers()
    this.#group?.remove()
    this.#group = null
    this.#pathRecs = []
    this.#rectMarkers = []
  }

  /* ── Ingesta / serialización (puras respecto a Leaflet) ─────────────────────────────────── */

  // Ingesta = coacción + saneo: cada coordenada pasa por `toFinitePair` y las inválidas se descartan
  // (garbage-in no corrompe el estado interno ni sale por onChange). point/rectangle degeneran a null si
  // les falta una coordenada finita.
  #ingest(value) {
    switch (this.#kind) {
      case 'polygon': {
        if (!value?.length) { this.#simpleRing = true; return { rings: [[]] } }
        this.#simpleRing = !isMultiRing(value)
        const rings = this.#simpleRing
          ? [value.map(toFinitePair).filter(Boolean)]
          : value.map(r => (r ?? []).map(toFinitePair).filter(Boolean))
        return { rings }
      }
      case 'polyline': return { path: (value ?? []).map(toFinitePair).filter(Boolean) }
      case 'point': return { pt: toFinitePair(value) }
      case 'rectangle': {
        const a = toFinitePair(value?.[0]), b = toFinitePair(value?.[1])
        return { bounds: a && b ? [a, b] : null }
      }
    }
  }

  #serialize() {
    const g = this.#geom
    switch (this.#kind) {
      case 'polygon': {
        const rings = g.rings.map(r => r.map(clonePair))
        return this.#simpleRing ? rings[0] : rings
      }
      case 'polyline': return g.path.map(clonePair)
      case 'point': return g.pt ? clonePair(g.pt) : null
      case 'rectangle': return g.bounds ? g.bounds.map(clonePair) : null
    }
  }

  #emit()       { this.#onChange?.(this.#serialize()) }   // live: cada cambio (incluye cada frame de drag)
  #emitCommit() { this.#onCommit?.(this.#serialize()) }   // settle: fin de gesto (dragend / edición discreta)

  /* ── Suscripción nativa al mapa (modo draw) ─────────────────────────────────────────────── */
  // map.on/off es API de Leaflet (NO sniffing del DOM). El dblclick CIERRA el trazo (polígono/polilínea):
  // Leaflet emite uno o dos `click` en la misma posición junto al `dblclick` — el dedup de handleMapClick ya
  // los neutraliza, así que acá sólo se colapsa cualquier duplicado final que se haya colado y se emite
  // SÓLO si de verdad cambió algo (nunca una re-emisión de una geometría idéntica).
  #onMapClick    = e => this.handleMapClick(e?.latlng)
  #onMapDblClick = e => {
    if (this.#mode !== 'draw') return
    if (this.#kind !== 'polygon' && this.#kind !== 'polyline') return
    const coords = this.#kind === 'polygon' ? this.#geom.rings[0] : this.#geom.path
    if (coords.length < 2) return
    const p = e?.latlng ? toFinitePair(e.latlng) : coords[coords.length - 1]
    if (!p) return
    const antes = coords.length
    while (coords.length > 1 && samePoint(coords[coords.length - 1], p) && samePoint(coords[coords.length - 2], p)) coords.pop()
    if (coords.length !== antes) { this.#emit(); this.#emitCommit(); this.#rebuild() }
  }
  #attachMap() { this.#map.on('click', this.#onMapClick); this.#map.on('dblclick', this.#onMapDblClick) }
  #detachMap() { this.#map.off('click', this.#onMapClick); this.#map.off('dblclick', this.#onMapDblClick) }

  /* ── Construcción de handles ────────────────────────────────────────────────────────────── */

  #rebuild() {
    this.#group.clearLayers()
    this.#pathRecs = []
    this.#rectMarkers = []
    if (this.#mode !== 'edit') return                       // en draw no hay handles: se colocan puntos
    if (this.#kind === 'rectangle') return this.#buildRectangle()
    if (this.#kind === 'point') return this.#buildPoint()
    const rings = this.#kind === 'polygon' ? this.#geom.rings : [this.#geom.path]
    rings.forEach(coords => this.#buildPath(coords, this.#kind === 'polygon'))
  }

  #marker(pos, icon, draggable) {
    return this.#L
      .marker(pos, { pane: this.#pane, icon, draggable, interactive: true })
      .addTo(this.#group)
  }

  // Un anillo/path editable: un marcador draggable por vértice + un marcador de arista (midpoint) por
  // segmento. `closed` cierra el último segmento contra el primero (polígono).
  #buildPath(coords, closed) {
    if (!coords.length) return
    const rec = { coords, closed, vMarkers: [], mMarkers: [] }
    coords.forEach((c, i) => {
      const m = this.#marker(c, this.#vertexIcon, true)
      m.on('drag', () => this.#onVertexDrag(rec, i, m.getLatLng()))
      m.on('dragend', () => this.#emitCommit())
      m.on('dblclick', () => this.#onVertexDelete(rec, i))
      rec.vMarkers.push(m)
    })
    const segCount = closed ? coords.length : coords.length - 1
    rec.mMarkers = Array.from({ length: segCount }, (_, s) => {
      const mm = this.#marker(midpoint(coords[s], coords[(s + 1) % coords.length]), this.#midIcon, false)
      mm.on('click', () => this.#onMidInsert(rec, s))
      return mm
    })
    this.#pathRecs.push(rec)
  }

  #buildPoint() {
    if (!this.#geom.pt) return
    const m = this.#marker(this.#geom.pt, this.#vertexIcon, true)
    m.on('drag', () => { this.#geom.pt = toPair(m.getLatLng()); this.#emit() })
    m.on('dragend', () => this.#emitCommit())
  }

  #buildRectangle() {
    const b = this.#geom.bounds
    if (!b) return
    this.#rectMarkers = this.#rectCorners(b).map((c, i) => {
      const m = this.#marker(c, this.#vertexIcon, true)
      m.on('drag', () => this.#onRectCornerDrag(i, m.getLatLng()))
      m.on('dragend', () => this.#emitCommit())
      return m
    })
  }

  // Esquinas en orden [SW, NW, NE, SE] a partir de bounds [[sur,oeste],[norte,este]]. La esquina opuesta a
  // `i` es (i+2)%4 — la que se mantiene fija al arrastrar `i`.
  #rectCorners([[s, w], [n, e]]) { return [[s, w], [n, w], [n, e], [s, e]] }

  /* ── Ediciones ──────────────────────────────────────────────────────────────────────────── */

  // Arrastre de vértice: muta la coord en su lugar (misma referencia que geom), reubica SOLO los dos
  // midpoints adyacentes (no un rebuild por frame → no se destruye el marcador en pleno drag) y emite.
  #onVertexDrag(rec, i, ll) {
    rec.coords[i] = toPair(ll)
    const len = rec.coords.length
    const segCount = rec.closed ? len : len - 1
    const setMid = s => {
      if (s < 0 || s >= segCount) return
      rec.mMarkers[s]?.setLatLng(midpoint(rec.coords[s], rec.coords[(s + 1) % len]))
    }
    if (rec.closed) { setMid((i - 1 + len) % len); setMid(i % len) }
    else { setMid(i - 1); setMid(i) }
    this.#emit()
  }

  #onVertexDelete(rec, i) {
    if (rec.coords.length <= (MIN_VERTICES[this.#kind] ?? 1)) return   // no bajar del mínimo topológico
    rec.coords.splice(i, 1)
    this.#emit()
    this.#emitCommit()
    this.#rebuild()                                                    // los índices corren → rehacer handles
  }

  // Insertar vértice en el midpoint del segmento `s` (promueve el punto de arista a vértice real).
  #onMidInsert(rec, s) {
    const len = rec.coords.length
    rec.coords.splice(s + 1, 0, midpoint(rec.coords[s], rec.coords[(s + 1) % len]))
    this.#emit()
    this.#emitCommit()
    this.#rebuild()
  }

  // Arrastre de esquina de rectángulo: la esquina opuesta queda fija; el bounds se recompone por min/max
  // (se mantiene alineado a ejes) y se reubican las esquinas no arrastradas.
  #onRectCornerDrag(i, ll) {
    const p = toPair(ll)
    const o = toPair(this.#rectMarkers[(i + 2) % 4].getLatLng())
    const s = Math.min(p[0], o[0]), n = Math.max(p[0], o[0])
    const w = Math.min(p[1], o[1]), e = Math.max(p[1], o[1])
    this.#geom.bounds = [[s, w], [n, e]]
    const pos = this.#rectCorners(this.#geom.bounds)
    this.#rectMarkers.forEach((m, k) => k !== i && m.setLatLng(pos[k]))
    this.#emit()
  }

  // Trazado de rectángulo: primer click fija una esquina; el segundo cierra el bounds contra ella.
  #drawRectClick(p) {
    if (!this.#drawAnchor) { this.#drawAnchor = p; return }
    const a = this.#drawAnchor
    this.#geom.bounds = [
      [Math.min(a[0], p[0]), Math.min(a[1], p[1])],
      [Math.max(a[0], p[0]), Math.max(a[1], p[1])],
    ]
    this.#drawAnchor = null
    this.#emit()
    this.#emitCommit()
    this.#rebuild()
  }
}
