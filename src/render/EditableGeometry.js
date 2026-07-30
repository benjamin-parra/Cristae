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
// Almacenamiento: polygon y polyline viven en un `ChunkedPath` —el arena—, donde mover un vértice es O(1)
// e insertar o borrar toca UN chunk, no el trazo entero. `point` y `rectangle` se quedan en pares sueltos.
//
// Sistema de coordenadas: pares [lat, lng] (se aceptan también {lat, lng} en la entrada; la salida SIEMPRE
// es [lat, lng]). Formas por `kind`:
//   · polygon   → rings: anillo simple [[lat,lng],…] o multi-anillo [[[lat,lng],…],…] (sin cerrar: el
//                 primer punto NO se repite al final). La salida conserva la forma de la entrada.
//   · polyline  → path: [[lat,lng],…]
//   · point     → [lat,lng]  (o null mientras no se dibujó)
//   · rectangle → bounds: [[sur,oeste],[norte,este]]  (o null mientras no se dibujó)
import { ChunkedPath, ROLE } from '../geometry/ChunkedPath.js'

const MIN_VERTICES = { polygon: 3, polyline: 2 }   // mínimo bajo el cual el borrado por dblclick se ignora
const KINDS        = new Set(['polygon', 'rectangle', 'polyline', 'point'])

const toPair    = c => (Array.isArray(c) ? [c[0], c[1]] : [c.lat, c.lng])
const clonePair = p => [p[0], p[1]]

// Un par [lat,lng] finito (rechaza NaN/Infinity/undefined). Garbage-in: se descarta, no se propaga.
const isFinitePair = p => Number.isFinite(p[0]) && Number.isFinite(p[1])
// Coacción tolerante de la ENTRADA a par finito, o null si no es una coordenada válida (null/undefined,
// componentes no numéricos, no-finitos). Distinta de `toPair`, que asume una latlng viva de Leaflet.
const toFinitePair = c => {
  if (c == null) return null
  const p = toPair(c)
  return isFinitePair(p) ? p : null
}

const trazo    = (coords, closed) => new ChunkedPath({ points: coords.map(toFinitePair).filter(Boolean), closed })
const vertexAt = (path, v, p) => v >= 0 && path.xAt(v) === p[0] && path.yAt(v) === p[1]

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
    mode === 'draw' && this.#attachMap()
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
    mode === 'draw' && this.#attachMap()
    this.#rebuild()
  }

  getValue() { return this.#serialize() }

  // Los trazos del arena en orden de dibujo: los anillos del polígono, o el path único de la polilínea.
  // Vacío para point y rectangle, que no entran al arena.
  get paths() {
    if (this.#kind === 'polygon') return [...this.#geom.rings]
    return this.#kind === 'polyline' ? [this.#geom.path] : []
  }

  // Sub-pieza "click en mapa vacío → latlng": expuesta para que el consumidor rutee su propia captura de
  // punto (además de la suscripción nativa a map.on('click') que hace el modo draw). En draw, agrega/coloca.
  handleMapClick(latlng) {
    if (this.#mode !== 'draw' || !latlng) return
    const p = toFinitePair(latlng)
    if (!p) return                                          // garbage-in en el trazado tampoco entra
    if (this.#kind === 'point') { this.#geom.pt = p; this.#settle(); return }
    if (this.#kind === 'rectangle') return this.#drawRectClick(p)
    const path = this.paths[0]
    // Leaflet dispara un `click` en la MISMA posición junto al `dblclick` de cierre: deduplicarlo acá
    // neutraliza ese click (no se duplica el último punto ni se emite una geometría con uno repetido).
    if (vertexAt(path, path.lastVertex, p)) return
    path.append(p[0], p[1])
    this.#settle()
  }

  destroy() {
    this.#detachMap()
    this.#group?.clearLayers()
    this.#group?.remove()
    this.#group = null
    this.#rectMarkers = []
  }

  /* ── Ingesta / serialización (puras respecto a Leaflet) ─────────────────────────────────── */

  // Ingesta = coacción + saneo: cada coordenada pasa por `toFinitePair` y las inválidas se descartan
  // (garbage-in no corrompe el estado interno ni sale por onChange). point/rectangle degeneran a null si
  // les falta una coordenada finita.
  #ingest(value) {
    switch (this.#kind) {
      case 'polygon': {
        if (!value?.length) { this.#simpleRing = true; return { rings: [trazo([], true)] } }
        this.#simpleRing = !isMultiRing(value)
        return { rings: this.#simpleRing ? [trazo(value, true)] : value.map(r => trazo(r ?? [], true)) }
      }
      case 'polyline': return { path: trazo(value ?? [], false) }
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
        const rings = g.rings.map(r => r.toPairs())
        return this.#simpleRing ? rings[0] : rings
      }
      case 'polyline': return g.path.toPairs()
      case 'point': return g.pt ? clonePair(g.pt) : null
      case 'rectangle': return g.bounds ? g.bounds.map(clonePair) : null
    }
  }

  #emit()   { this.#onChange?.(this.#serialize()) }
  #commit() { this.#onCommit?.(this.#serialize()) }
  // Edición DISCRETA (agregar / borrar / insertar / cerrar): cambia, asienta y rehace los handles,
  // cuyos refs corrieron. El drag no pasa por acá: emite live y sólo asienta al soltar.
  #settle() { this.#emit(); this.#commit(); this.#rebuild() }

  /* ── Suscripción nativa al mapa (modo draw) ─────────────────────────────────────────────── */
  // map.on/off es API de Leaflet (NO sniffing del DOM). El dblclick CIERRA el trazo (polígono/polilínea):
  // el dedup de handleMapClick ya neutraliza los `click` que Leaflet emite junto al `dblclick`, así que acá
  // sólo se colapsa el duplicado final que se haya colado y se emite SÓLO si de verdad cambió algo.
  #onMapClick    = e => this.handleMapClick(e?.latlng)
  #onMapDblClick = e => {
    if (this.#mode !== 'draw') return
    if (this.#kind !== 'polygon' && this.#kind !== 'polyline') return
    const path = this.paths[0]
    if (path.length < 2) return
    const fin = path.lastVertex
    const p   = e?.latlng ? toFinitePair(e.latlng) : [path.xAt(fin), path.yAt(fin)]
    if (!p) return
    const antes     = path.length
    const duplicado = v => vertexAt(path, v, p) && vertexAt(path, path.prevVertex(v), p)
    while (path.length > 1 && duplicado(path.lastVertex)) path.remove(path.lastVertex)
    path.length !== antes && this.#settle()
  }
  #attachMap() { this.#map.on('click', this.#onMapClick); this.#map.on('dblclick', this.#onMapDblClick) }
  #detachMap() { this.#map.off('click', this.#onMapClick); this.#map.off('dblclick', this.#onMapDblClick) }

  /* ── Construcción de handles ────────────────────────────────────────────────────────────── */

  #rebuild() {
    this.#group.clearLayers()
    this.#rectMarkers = []
    if (this.#mode !== 'edit') return                       // en draw no hay handles: se colocan puntos
    if (this.#kind === 'rectangle') return this.#buildRectangle()
    if (this.#kind === 'point') return this.#buildPoint()
    this.paths.forEach(path => this.#buildPath(path))
  }

  #marker(pos, icon, draggable) {
    return this.#L
      .marker(pos, { pane: this.#pane, icon, draggable, interactive: true })
      .addTo(this.#group)
  }

  // Un anillo/path editable: un marcador draggable por vértice más uno por midpoint ACTIVO (el del
  // segmento que arranca en ese vértice; en un trazo abierto el del último no lo está). Los vértices se
  // crean todos antes que los midpoints — ese orden es el que ve quien consume los handles.
  #buildPath(path) {
    if (!path.length) return
    const rec = { path, mids: new Map() }
    path.forEachVertex((x, y, ref) => {
      const m = this.#marker([x, y], this.#vertexIcon, true)
      m.on('drag', () => this.#onVertexDrag(rec, ref, m.getLatLng()))
      m.on('dragend', () => this.#commit())
      m.on('dblclick', () => this.#onVertexDelete(rec, ref))
    })
    path.forEachVertex((x, y, ref) => {
      const mid = path.midOf(ref)
      if (path.roleAt(mid) !== ROLE.midpoint) return
      const mm = this.#marker([path.xAt(mid), path.yAt(mid)], this.#midIcon, false)
      mm.on('click', () => this.#onMidInsert(rec, ref))
      rec.mids.set(ref, mm)
    })
  }

  #buildPoint() {
    if (!this.#geom.pt) return
    const m = this.#marker(this.#geom.pt, this.#vertexIcon, true)
    m.on('drag', () => { this.#geom.pt = toPair(m.getLatLng()); this.#emit() })
    m.on('dragend', () => this.#commit())
  }

  #buildRectangle() {
    const b = this.#geom.bounds
    if (!b) return
    this.#rectMarkers = this.#rectCorners(b).map((c, i) => {
      const m = this.#marker(c, this.#vertexIcon, true)
      m.on('drag', () => this.#onRectCornerDrag(i, m.getLatLng()))
      m.on('dragend', () => this.#commit())
      return m
    })
  }

  // Esquinas en orden [SW, NW, NE, SE] a partir de bounds [[sur,oeste],[norte,este]]. La esquina opuesta a
  // `i` es (i+2)%4 — la que se mantiene fija al arrastrar `i`.
  #rectCorners([[s, w], [n, e]]) { return [[s, w], [n, w], [n, e], [s, e]] }

  /* ── Ediciones ──────────────────────────────────────────────────────────────────────────── */

  // Arrastre de vértice: el arena reescribe el vértice y los DOS midpoints que lo tocan —el suyo y el del
  // anterior, que puede vivir en otro chunk— sin desplazar nada, así el ref del marcador bajo el dedo
  // sigue valiendo. Acá sólo se reubican esos dos marcadores (no un rebuild por frame).
  #onVertexDrag(rec, ref, ll) {
    const p = toPair(ll)
    if (!rec.path.moveVertex(ref, p[0], p[1])) return
    const prev = rec.path.prevVertex(ref)
    this.#placeMid(rec, ref)
    prev >= 0 && this.#placeMid(rec, prev)
    this.#emit()
  }

  #placeMid(rec, v) {
    const mid = rec.path.midOf(v)
    return rec.mids.get(v)?.setLatLng([rec.path.xAt(mid), rec.path.yAt(mid)])
  }

  #onVertexDelete(rec, ref) {
    if (rec.path.length <= (MIN_VERTICES[this.#kind] ?? 1)) return   // no bajar del mínimo topológico
    rec.path.remove(ref) && this.#settle()
  }

  // Insertar vértice en el midpoint del segmento que ARRANCA en `ref` (promueve el punto de arista a
  // vértice real).
  #onMidInsert(rec, ref) {
    const mid = rec.path.midOf(ref)
    rec.path.insertAfter(ref, rec.path.xAt(mid), rec.path.yAt(mid)) >= 0 && this.#settle()
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
    this.#settle()
  }
}
