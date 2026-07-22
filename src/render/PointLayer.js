import { POINT_VERTEX, POINT_FRAGMENT } from './shaders.js'
import { GpuAtlasBinding } from '../atlas/GpuAtlasBinding.js'
import { Picking } from './Picking.js'
import { projX0, projY0 } from './project.js'

// Capa de puntos GL sobre glify. Dos paths (MODELO §17):
//   rebuild   → glify.setData (O(n), aloca; set/filtro/cluster/regrow). Reusa arrays + trunca length.
//   incremental → escribe el slot del buffer interleaved por bufferSubData (O(1), [0-alloc];
//                 move y patch sin cambio de membresía). NO pasa por setData. (§17.5)
// El layout glify es [x, y, r, g, b, a, size] (bytes=7): r=tile, g=ángulo, b,a=id de picking.

const DEFAULT_VARIANT = 'default'
const NORM = 1 / 360
const angleNorm = (deg) => (((deg % 360) + 360) % 360) * NORM

export class PointLayer {

  #glify; #map; #pane; #source; #iconSet; #interactive
  #accessors = null               // accessors de RENDER (override de los de la Source: variantOf/sizeOf/headingOf)
  #where = null                   // predicado de membresía por-capa (overlay): omite ítems que no matchean
  #layer = null
  #binding = null
  #picking = null
  #hoverHits = []                 // hits del último pick de hover, cacheados para resolveHover
  #hoverSample = null             // muestra del puntero de ese pick (su seq valida el cache)

  // Reusados en rebuild — [0-alloc] entre rebuilds salvo crecimiento del set.
  #positions = []                 // [lat, lng] por slot (data de glify)
  #meta = []                      // { tileIdx, angleNorm, size } por slot
  #idBySlot = []                  // slot → id (traduce hits de picking)
  #scratchColor = { r: 0, g: 0, b: 0, a: 1 }

  // Espejo del buffer GL para el path incremental.
  #verts = null; #buf = null; #cx = 0; #cy = 0
  #slot = new Map()               // id → slot
  #count = 0
  #snapLen = -1                   // tamaño del snapshot del último rebuild (detecta alta/baja)
  #suppressed = null              // ids a omitir del buffer (p. ej. clusterizados); null = ninguno
  // Deshabilitada como ENTIDAD (setLayerEnabled): la suscripción a la Source no procesa nada —
  // cero CPU/GPU por emit del WS mientras el pane está oculto (mismo patrón que LabelLayer).
  // refresh() sigue operativo (es el catch-up explícito al re-habilitar).
  #enabled = true

  #unsub = null

  // `accessors` override (default = los de la Source): permite que una capa LEA los
  // datos de una Source compartida (idOf/positionOf) pero RENDERICE con otros
  // variantOf/sizeOf/headingOf (caso overlay: misma flota, sprite de badge sin rotar).
  // `where` filtra qué ítems de la Source entran a ESTA capa (overlay: sólo los que
  // tienen badge), sin tocar la Source (que el mapa comparte).
  constructor({ glify, map, pane, source, iconSet, interactive = false, accessors = null, where = null }) {
    this.#glify = glify
    this.#map = map
    this.#pane = pane
    this.#source = source
    this.#accessors = accessors ?? source.accessors
    this.#where = where
    this.#iconSet = iconSet
    this.#interactive = interactive
    this.#unsub = source.subscribe(() => this.#onChange())
    this.#onChange()
  }

  get count() { return this.#count }
  get picking() { return this.#picking }
  get hasPendingPick() { return this.#picking?.pending ?? false }

  idForSlot(slot) { return this.#idBySlot[slot] }

  /* ── Picking (la capa de interacción orquesta; la capa resuelve hits) ── */

  // Encola un pick GPU para la muestra del puntero. `sample` lleva containerPoint + seq.
  requestHoverHit(sample) {
    return this.#picking
      ? this.#picking.request(sample.containerPoint.x, sample.containerPoint.y, this.#count, this.#layer.mapMatrix.array, sample)
      : false
  }

  // Recoge el pick encolado (no bloqueante). Cachea los hits + la muestra para resolveHover.
  collectHoverHit() {
    const pick = this.#picking?.collect()
    if (!pick) return null
    this.#hoverHits = this.#hitsFromSlots(pick.slots)
    this.#hoverSample = pick.metadata
    return pick.metadata
  }

  // resolveHover devuelve el cache solo si corresponde a la muestra vigente (mismo seq).
  resolveHover(baseEvent) {
    return this.#hoverSample?.seq === baseEvent.seq ? this.#hoverHits : []
  }

  // resolveClick hace un pick síncrono (un tiro) en el punto del evento.
  resolveClick(baseEvent) {
    const cp = baseEvent.containerPoint ?? this.#map.latLngToContainerPoint(baseEvent.latlng)
    const pick = this.#picking?.pickSync(cp.x, cp.y, this.#count, this.#layer.mapMatrix.array, baseEvent)
    return pick ? this.#hitsFromSlots(pick.slots) : []
  }

  cancelHoverHit() { this.#picking?.abort() }

  // Slots del picking → partes de hit. El ref y el id del punto son su id de dato; el pick GPU
  // es exacto → distancePx 0. El registro envuelve estas partes con layerId/zIndex/order.
  #hitsFromSlots(slots) {
    const parts = []
    slots.forEach(slot => { const id = this.#idBySlot[slot]; parts.push({ ref: id, id, distancePx: 0 }) })
    return parts
  }

  /* ── Lifecycle ── */

  redraw() { this.#layer?.layer.redraw() }       // glify.points() → instancia; la L.Layer está en .layer
  syncPickingSize() { this.#picking?.syncSize() }

  // Reposiciona y redibuja el canvas de glify (síncrono); el motor la invoca en move/moveend/zoomend.
  resetCanvasReference() { this.#layer?.layer._reset() }

  // Re-encode total con los accessors actuales (recolor por antigüedad/latencia, SPECS §8.1)
  // o tras cambiar la supresión. Fuerza rebuild aunque el set no cambie de tamaño.
  refresh() { if (this.#layer) this.#rebuild(this.#source.getSnapshot()) }

  // ids a omitir del buffer (cluster). Cambiarla exige refresh() para reconstruir.
  set suppressed(ids) { this.#suppressed = ids }

  // Predicado de membresía por-capa (overlay). Cambiarlo exige refresh().
  set where(fn) { this.#where = fn ?? null }

  // Gate del pipeline (entidad deshabilitada): apaga la REACCIÓN a la Source, no el handle.
  // Re-habilitar exige refresh() para ponerse al día (lo hace setLayerEnabled).
  set enabled(v) { this.#enabled = v !== false }

  destroy() {
    this.#unsub?.()
    this.#picking?.detach()
    this.#binding?.destroy()
    this.#layer?.remove()
    this.#layer = null
  }

  /* ── Reacción al Source (ya coalescida a rAF por el Emitter) ── */

  #onChange() {
    if (!this.#enabled && this.#layer) return   // deshabilitada: no reaccionar (el 1er build sí corre — refresh() exige #layer)
    const snap = this.#source.getSnapshot()
    if (!this.#layer || snap.length !== this.#snapLen) return this.#rebuild(snap)

    const byId = this.#source.itemById
    if (!byId) return this.#rebuild(snap)              // sin lookup O(1) → rebuild seguro

    const a = this.#accessors
    const atlas0 = this.#iconSet.atlas
    const count0 = atlas0.count

    const moves = this.#source.moveDirtyIds?.()        // solo posición → 2 floats
    if (moves && moves.size) {
      for (const id of moves) {
        const s = this.#slot.get(id)
        if (s === undefined) {
          if (this.#absentByPolicy(id, byId(id))) continue   // no está en el buffer a propósito
          return this.#rebuild(snap)                         // desconocido → el buffer no está al día
        }
        this.#writePosition(s, a.positionOf(byId(id)))
      }
      // No se limpia acá: el Source acumula por ventana y limpia al abrir la siguiente
      // (así un 2º suscriptor —p.ej. una label-layer— ve el mismo set en este flush).
    }

    const dirty = this.#source.dirtyIds?.()            // posición + color + size → 7 floats
    if (dirty && dirty.size) {
      for (const id of dirty) {
        const s = this.#slot.get(id)
        if (s === undefined) {
          if (this.#absentByPolicy(id, byId(id))) continue
          return this.#rebuild(snap)
        }
        this.#writeSlot(s, byId(id))
        if (this.#iconSet.atlas !== atlas0) return this.#rebuild(snap)   // regrow → re-encode todo
      }
    }

    if (this.#iconSet.atlas.count > count0) this.#binding.sync(this.#iconSet.atlas)  // append
    this.#layer.layer.redraw()
  }

  // Tamaño en pantalla del sprite: `sizeOf` (o el default del iconSet) × la escala de footprint de
  // la variante (1 salvo que el descriptor pida `scale`). Punto único para los dos paths (rebuild e
  // incremental) → la escala no puede olvidarse en uno.
  #sizeFor(item, tileIdx) {
    const a = this.#accessors
    const base = a.sizeOf ? a.sizeOf(item) : this.#iconSet.defaultSize
    return base * this.#iconSet.tileScale(tileIdx)
  }

  /* ── Política de membresía del buffer (punto único: rebuild e incremental la comparten) ── */

  // Un ítem NO entra al buffer si es ajeno a esta capa (`where`), si el cluster lo suprime o si su
  // posición no es finita (§15.2). Devuelve la posición a renderizar, o null si se omite.
  // Se consulta en CADA lectura (nunca se cachea la decisión): el ítem que recupera posición o sale
  // del cluster vuelve solo, sin depender de qué clase de omisión lo dejó afuera.
  #renderablePos(item, id) {
    if (this.#where && !this.#where(item)) return null
    if (this.#suppressed?.has(id)) return null
    const pos = this.#accessors.positionOf(item)
    return pos && Number.isFinite(pos.lat) && Number.isFinite(pos.lng) ? pos : null
  }

  // Ausencia ESPERADA (el ítem existe pero la política lo deja fuera del buffer) vs. id desconocido
  // (el buffer no está al día → rebuild). Sin esta distinción, el path incremental muere en cuanto
  // el cluster suprime al set: cada move de un punto clusterizado dispararía un rebuild O(n).
  // El duplicado (§15.2) no es caso de ausencia: su id SÍ tiene slot, nunca llega hasta acá.
  #absentByPolicy(id, item) {
    return item != null && this.#renderablePos(item, id) === null
  }

  /* ── Rebuild (O(n), reusa arrays) ── */

  #rebuild(snap) {
    const a = this.#accessors
    let idx = 0
    this.#slot.clear()
    for (let i = 0; i < snap.length; i++) {
      const item = snap[i]
      const id = a.idOf(item)
      if (this.#slot.has(id)) continue                                 // §15.2 duplicado → gana el primero
      const pos = this.#renderablePos(item, id)
      if (!pos) continue
      const { lat, lng } = pos     // copia inmediata: el objeto de `positionOf` puede ser scratch reusado

      const tileIdx = this.#iconSet.resolve(a.variantOf ? a.variantOf(item) : DEFAULT_VARIANT)
      const an = (this.#iconSet.rotates && a.headingOf) ? angleNorm(a.headingOf(item)) : 0
      const sz = this.#sizeFor(item, tileIdx)

      const p = this.#positions[idx]
      if (p) { p[0] = lat; p[1] = lng } else this.#positions[idx] = [lat, lng]
      const m = this.#meta[idx]
      if (m) { m.tileIdx = tileIdx; m.angleNorm = an; m.size = sz }
      else this.#meta[idx] = { tileIdx, angleNorm: an, size: sz }

      this.#idBySlot[idx] = id
      this.#slot.set(id, idx)
      idx++
    }
    this.#positions.length = idx
    this.#meta.length = idx
    this.#idBySlot.length = idx
    this.#count = idx
    this.#snapLen = snap.length

    if (!this.#layer) this.#create()
    else this.#layer.setData(this.#positions)          // el atlas ya quedó settled tras el loop

    this.#bind()                                        // recapturar typedVertices (nuevo cada render)
    this.#binding.sync(this.#iconSet.atlas)
    this.#layer.layer.redraw()
  }

  // Primera vez: crea la capa glify con NUESTROS shaders; los callbacks leen meta por índice.
  #create() {
    this.#layer = this.#glify.points({
      map: this.#map,
      pane: this.#pane,
      data: this.#positions,
      latitudeKey: 0,
      longitudeKey: 1,
      sensitivity: 0,                                   // irrelevante: sin `click`/`hover` glify NO registra su handler
      sensitivityHover: 0,
      vertexShaderSource: POINT_VERTEX,
      fragmentShaderSource: POINT_FRAGMENT,
      color: (i) => this.#colorAt(i),
      size: (i) => this.#meta[i].size,
    })
    const gl = this.#layer.gl
    if (this.#layer.bytes !== 7)
      throw new Error('[cristae] glify layout != 7; abortar path incremental')
    this.#binding = new GpuAtlasBinding(gl)
    this.#binding.register(this.#layer.program)
    if (this.#interactive) {
      this.#picking = new Picking()
      const pickProgram = this.#picking.attach(gl, this.#layer.program, this.#binding.texture)
      this.#binding.register(pickProgram)
    }
  }

  // Color por punto (path de rebuild): scratch mutado-y-retornado — glify lo spreadea sincrónicamente.
  #colorAt(i) {
    const m = this.#meta[i]
    const c = this.#scratchColor
    c.r = this.#iconSet.atlas.tileChannel(m.tileIdx)
    c.g = m.angleNorm
    const id = i + 1
    c.b = ((id >> 8) & 0xff) / 255
    c.a = (id & 0xff) / 255
    return c
  }

  // Recaptura el espejo: el WebGLBuffer es estable, pero typedVertices se reemplaza en cada
  // render() de glify (points.ts:114). Re-emite DYNAMIC_DRAW (hint apto a updates puntuales).
  #bind() {
    const gl = this.#layer.gl
    this.#buf = this.#layer.getBuffer('vertices')
    this.#verts = this.#layer.typedVertices
    this.#cx = this.#layer.mapCenterPixels.x
    this.#cy = this.#layer.mapCenterPixels.y
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#buf)
    gl.bufferData(gl.ARRAY_BUFFER, this.#verts, gl.DYNAMIC_DRAW)
  }

  // Los writes incrementales actualizan TAMBIÉN el espejo CPU (#positions/#meta): glify regenera
  // typedVertices DESDE ellos en cada render (move/zoom) — sin el espejo al día, un re-render
  // revertiría los updates incrementales al estado del último rebuild.

  // move: 2 floats (posición). [0-alloc] en WebGL2 (forma de 5 args, sin subarray).
  #writePosition(s, pos) {
    const p = this.#positions[s]
    p[0] = pos.lat
    p[1] = pos.lng
    const base = s * 7
    this.#verts[base] = projX0(pos.lng) - this.#cx
    this.#verts[base + 1] = projY0(pos.lat) - this.#cy
    const gl = this.#layer.gl
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#buf)
    gl.bufferSubData(gl.ARRAY_BUFFER, base * 4, this.#verts, base, 2)
  }

  // patch de un ítem sucio: posición + color + size (7 floats). El id (b,a) es función del slot,
  // que es estable → se reescribe igual sin coste extra.
  #writeSlot(s, item) {
    const a = this.#accessors
    const { lat, lng } = a.positionOf(item)   // copia inmediata: los accessors de abajo pueden reusar el objeto
    const tileIdx = this.#iconSet.resolve(a.variantOf ? a.variantOf(item) : DEFAULT_VARIANT)
    const an = (this.#iconSet.rotates && a.headingOf) ? angleNorm(a.headingOf(item)) : 0
    const sz = this.#sizeFor(item, tileIdx)
    const p = this.#positions[s]
    p[0] = lat
    p[1] = lng
    const m = this.#meta[s]
    m.tileIdx = tileIdx
    m.angleNorm = an
    m.size = sz
    const v = this.#verts
    const base = s * 7
    v[base] = projX0(lng) - this.#cx
    v[base + 1] = projY0(lat) - this.#cy
    v[base + 2] = this.#iconSet.atlas.tileChannel(tileIdx)
    v[base + 3] = an
    const id = s + 1
    v[base + 4] = ((id >> 8) & 0xff) / 255
    v[base + 5] = (id & 0xff) / 255
    v[base + 6] = sz
    const gl = this.#layer.gl
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#buf)
    gl.bufferSubData(gl.ARRAY_BUFFER, base * 4, v, base, 7)
  }
}
