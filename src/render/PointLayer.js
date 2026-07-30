import { POINT_VERTEX, POINT_FRAGMENT } from './shaders.js'
import { GpuAtlasBinding } from '../atlas/GpuAtlasBinding.js'
import { Picking, LOCAL_BITS, CHUNK_BITS } from './Picking.js'
import { projX0, projY0 } from './project.js'
import { loseGlContext, cancelPendingRedraw } from './gl-teardown.js'

// Capa de puntos GL sobre glify. Dos paths (MODELO §17):
//   rebuild   → glify.setData (O(n), aloca; set/filtro/cluster/regrow). Reusa arrays + trunca length.
//   incremental → escribe el slot del buffer interleaved por bufferSubData (O(1), [0-alloc];
//                 move y patch sin cambio de membresía). NO pasa por setData. (§17.5)
// El layout glify es [x, y, r, g, b, a, size] (bytes=7): r=tile, g=ángulo, b,a=índice local de picking.

const DEFAULT_VARIANT = 'default'
const NORM = 1 / 360
const angleNorm = deg => (((deg % 360) + 360) % 360) * NORM

// Picking jerárquico (objeto / chunk / local): el índice LOCAL del vértice ocupa 12 bits en los canales
// b,a del atributo `color`, con la convención `local + 1` — el valor 0 significa «el objeto, pero no una
// entrada». De ahí las 4.095 entradas por chunk. El objeto y el chunk NO viajan por vértice: son uniform
// del DRAW, así que el buffer se recorre en un draw por chunk y el eje `chunk` completa la dirección.
// El `% LOCAL_CAP` del packer sostiene el invariante del que depende el pase para sumarle el chunk al
// canal rojo sin desbordar el byte (b ≤ 15).
const LOCAL_CAP = (1 << LOCAL_BITS) - 1
const PICK_CAP  = (1 << CHUNK_BITS) * LOCAL_CAP
const NOOP      = () => {}

export class PointLayer {

  #glify; #map; #pane; #source; #iconSet; #interactive
  #accessors   = null   // accessors de RENDER (override de los de la Source: variantOf/sizeOf/headingOf)
  #where       = null   // predicado de membresía por-capa (overlay): omite ítems que no matchean
  #layer       = null
  #binding     = null
  #picking     = null
  #hoverPick   = { hits: [], sample: null }   // cache del último pick de hover; sample.seq valida hits
  #pickObj     = 0      // identidad de objeto en el pase (la asigna el motor; 0 = el pase la saltea)
  // Partes de hit por canal: `out` (lo que se devuelve, truncado al nº de hits) referencia objetos de
  // `pool`, que sólo crece → en régimen permanente el hover no asigna nada por pick. Un pool por canal:
  // un click no puede pisar las partes que el cache de hover todavía tiene vigentes.
  #hoverParts  = { pool: [], out: [] }
  #clickParts  = { pool: [], out: [] }
  // Descriptores del pase, uno por chunk, reusados entre picks ([0-alloc] en ruta caliente salvo cuando
  // el set cruza un múltiplo de LOCAL_CAP). `bind` es no-op: el pase hereda el vertexAttribPointer que
  // dejó montado glify (§17.5) — la capa no tiene nada que bindear.
  #draws       = []
  #batch       = { draws: this.#draws, length: 0, matrix: null }
  #pickMode    = 0
  #pickTexture = null

  // Reusados en rebuild — [0-alloc] entre rebuilds salvo crecimiento del set.
  #positions    = []   // [lat, lng] por slot (data de glify)
  #meta         = []   // { tileIdx, angleNorm, size } por slot
  #idBySlot     = []   // slot → id (traduce hits de picking)
  #scratchColor = { r: 0, g: 0, b: 0, a: 1 }

  // Espejo del buffer GL para el path incremental.
  #verts = null; #buf = null; #cx = 0; #cy = 0
  #slot       = new Map()   // id → slot
  #count      = 0
  #snapLen    = -1          // tamaño del snapshot del último rebuild (detecta alta/baja)
  #suppressed = null        // ids a omitir del buffer (p. ej. clusterizados); null = ninguno
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
    this.#glify       = glify
    this.#map         = map
    this.#pane        = pane
    this.#source      = source
    this.#accessors   = accessors ?? source.accessors
    this.#where       = where
    this.#iconSet     = iconSet
    this.#interactive = interactive
    this.#unsub       = source.subscribe(() => this.#onChange())
    this.#onChange()
  }

  get count() { return this.#count }
  get picking() { return this.#picking }
  get hasPendingPick() { return this.#picking?.pending ?? false }

  idForSlot(slot) { return this.#idBySlot[slot] }

  /* ── Picking (la capa de interacción orquesta; la capa resuelve hits) ── */

  // Identidad de OBJETO de la capa dentro del pase de picking: la asigna el motor al darla de alta y la
  // capa se la pasa al pase, que la emite como uniform del draw (no viaja por vértice).
  set pickObject(obj) { this.#pickObj = obj ?? 0 }
  get pickObject() { return this.#pickObj }

  // Encola un pick GPU para la muestra del puntero. `sample` lleva containerPoint + seq.
  requestHoverHit(sample) {
    if (!this.#picking) return false
    const cp = sample.containerPoint
    return this.#picking.request(cp.x, cp.y, this.#pickBatch(), sample)
  }

  // Recoge el pick encolado (no bloqueante). Cachea los hits + la muestra para resolveHover.
  collectHoverHit() {
    const pick = this.#picking?.collect()
    if (!pick) return null
    this.#hoverPick.hits   = this.#partsFrom(pick.hits, this.#hoverParts)
    this.#hoverPick.sample = pick.metadata
    return pick.metadata
  }

  // resolveHover devuelve el cache solo si corresponde a la muestra vigente (mismo seq).
  resolveHover(baseEvent) {
    return this.#hoverPick.sample?.seq === baseEvent.seq ? this.#hoverPick.hits : []
  }

  // resolveClick hace un pick síncrono (un tiro) en el punto del evento, con el mismo batch.
  resolveClick(baseEvent) {
    const cp   = baseEvent.containerPoint ?? this.#map.latLngToContainerPoint(baseEvent.latlng)
    const pick = this.#picking?.pickSync(cp.x, cp.y, this.#pickBatch(), baseEvent)
    return pick ? this.#partsFrom(pick.hits, this.#clickParts) : []
  }

  cancelHoverHit() { this.#picking?.abort() }

  // Batch del pase: un draw por chunk de LOCAL_CAP entradas, con el objeto que asignó el motor. El
  // índice local sólo tiene 12 bits, así que un draw único cortaría el pase en 4.095 puntos y el resto
  // quedaría mudo al picking; repartirlo lleva el techo a PICK_CAP. Más allá de eso se degrada a «no
  // pickeable», nunca a un hit de otro punto.
  // Los descriptores se reusan y se ponen al día acá —el pick corre por mousemove—, y el pase los
  // guarda por REFERENCIA: el pedido que quedó encolado dispara con el estado del último pick, que es
  // el único que vale con el cursor en movimiento.
  #pickBatch() {
    const total  = Math.min(this.#count, PICK_CAP)
    const chunks = Math.ceil(total / LOCAL_CAP)
    const draws  = this.#draws
    while (draws.length < chunks)
      draws.push({ bind: NOOP, texture: this.#pickTexture, mode: this.#pickMode, first: 0, count: 0, obj: 0, chunk: draws.length })
    for (let k = 0; k < chunks; k++) {
      const d = draws[k]
      d.first = k * LOCAL_CAP
      d.count = Math.min(LOCAL_CAP, total - d.first)
      d.obj   = this.#pickObj
    }
    this.#batch.length = chunks
    this.#batch.matrix = this.#layer.mapMatrix.array
    return this.#batch
  }

  // PickHits → partes de hit, en el orden en que vienen: centro-hacia-afuera, así que la primera es la
  // más cercana al cursor. El pick GPU es exacto → distancePx 0 en todas, y ese orden ES la
  // desambiguación (el registro lo conserva: sort estable con la misma distancia). El repetido se
  // descarta —el parche cubre un mismo sprite en varios texeles— para entregar lo mismo que el `Set` de
  // antes, pero ordenado. El ref y el id del punto son su id de dato. No se filtra por objeto: la capa
  // tiene su PROPIO pase, así que todo impacto del parche es suyo — el eje `obj` discrimina recién
  // cuando varias entidades comparten un pase. El chunk sí entra en la cuenta del slot global, aunque
  // con un solo draw valga siempre 0.
  #partsFrom(hits, dest) {
    const { pool, out } = dest
    let n = 0
    for (let i = 0; i < hits.count; i++) {
      const local = hits.slots[i]
      const id    = local < 0 ? undefined : this.#idBySlot[hits.chunks[i] * LOCAL_CAP + local]
      if (id === undefined) continue                    // objeto sin entrada, o fuera del buffer vigente
      let repetido = false
      for (let k = 0; k < n; k++) if (out[k].id === id) { repetido = true; break }
      if (repetido) continue
      const part = pool[n] ??= { ref: null, id: null, distancePx: 0 }
      part.ref   = id
      part.id    = id
      out[n++]   = part
    }
    out.length = n
    return out
  }

  /* ── Lifecycle ── */

  redraw() { this.#layer?.layer.redraw() }       // glify.points() → instancia; la L.Layer está en .layer
  syncPickingSize() { this.#picking?.syncSize() }

  // Reposiciona y redibuja el canvas de glify (síncrono); el motor la invoca en move/moveend/zoomend.
  resetCanvasReference() { this.#layer?.layer._reset() }

  // Reproyección por-frame a una vista (zoom, center) ARBITRARIA — el corazón del zoom ANIMADO. Los
  // vértices viven en espacio de zoom-0, así que reproyectar es sólo recomputar la matriz (scale=2^zoom
  // + translate al NW de la vista destino) y re-emitir el draw: O(1), **tamaño de sprite fijo** (no
  // "gigante") y **sin corte** (redibuja al viewport cada frame). Replica glify.drawOnCanvas pero con la
  // vista INYECTADA en vez de la del mapa vivo (que durante la animación sigue en el zoom de partida).
  // El motor la llama por frame desde el ViewAnimator, interpolando (zoom, center) con el easing del tile.
  renderAtView(zoom, center) {
    const l = this.#layer
    if (!l?.gl || !l.matrix) return
    const map  = this.#map
    const size = map.getSize()
    const nw   = map.unproject(map.project(center, zoom).subtract(size.divideBy(2)), zoom)
    const off  = map.project(nw, 0)                     // NW en píxeles de zoom-0 (== glify `e.offset`)
    const gl   = l.gl
    l.mapMatrix
      .setSize(l.canvas.width, l.canvas.height)
      .scaleTo(2 ** zoom)
      .translateTo(-off.x + l.mapCenterPixels.x, -off.y + l.mapCenterPixels.y)
    gl.viewport(0, 0, l.canvas.width, l.canvas.height)
    gl.uniformMatrix4fv(l.matrix, false, l.mapMatrix.array)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.drawArrays(gl.POINTS, 0, l.allLatLngLookup.length)
  }

  // Apaga la animación de zoom PROPIA de glify: su `_animateZoom` hace `setTransform` (escala el raster
  // → sprites gigantes + salto, porque no lleva la transición CSS del tile). El ViewAnimator del motor
  // reproyecta por frame en su lugar. Idempotente; no-op si el mapa/overlay no exponen el handler.
  #suppressGlifyZoom() {
    const ov = this.#layer?.layer
    ov?._animateZoom && this.#map.off?.('zoomanim', ov._animateZoom, ov)
  }

  // Re-encode total con los accessors actuales (recolor por antigüedad/latencia, SPECS §8.1)
  // o tras cambiar la supresión. Fuerza rebuild aunque el set no cambie de tamaño.
  refresh() { if (this.#layer) this.#rebuild(this.#source.getSnapshot()) }

  // ids a omitir del buffer (cluster). Cambiarla exige refresh() para reconstruir.
  set suppressed(ids) { this.#suppressed = ids }

  // Predicado de membresía por-capa (overlay). Cambiarlo exige refresh().
  set where(fn) { this.#where = fn ?? null }

  // Gate del pipeline (entidad deshabilitada): apaga la REACCIÓN a la Source, no el handle.
  // Re-habilitar exige refresh() para ponerse al día (lo hace setLayerEnabled).
  set enabled(v) { this.#enabled = v ?? true }

  destroy() {
    this.#unsub?.()
    this.#picking?.detach()
    this.#binding?.destroy()
    cancelPendingRedraw(this.#layer)  // un redraw en vuelo correría con el mapa ya desprendido
    this.#layer?.remove()
    loseGlContext(this.#layer)        // libera el contexto WebGL (glify.remove no lo hace → leak acumulativo)
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
    if (moves?.size) {
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
    if (dirty?.size) {
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
    this.#meta.length      = idx
    this.#idBySlot.length  = idx
    this.#count            = idx
    this.#snapLen          = snap.length

    if (!this.#layer) this.#create()
    else this.#layer.setData(this.#positions)          // el atlas ya quedó settled tras el loop

    this.#bind()                                        // recapturar typedVertices (nuevo cada render)
    this.#binding.sync(this.#iconSet.atlas)
    this.#layer.layer.redraw()
  }

  // Primera vez: crea la capa glify con NUESTROS shaders; los callbacks leen meta por índice.
  #create() {
    this.#layer = this.#glify.points({
      map:                  this.#map,
      pane:                 this.#pane,
      data:                 this.#positions,
      latitudeKey:          0,
      longitudeKey:         1,
      sensitivity:          0, // irrelevante: sin `click`/`hover` glify NO registra su handler
      sensitivityHover:     0,
      vertexShaderSource:   POINT_VERTEX,
      fragmentShaderSource: POINT_FRAGMENT,
      color:                i => this.#colorAt(i),
      size:                 i => this.#meta[i].size,
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
      this.#pickMode    = gl.POINTS
      this.#pickTexture = this.#binding.texture
    }
    this.#suppressGlifyZoom()     // el ViewAnimator del motor reproyecta el zoom por frame (no glify)
  }

  // Color por punto (path de rebuild): scratch mutado-y-retornado — glify lo spreadea sincrónicamente.
  #colorAt(i) {
    const m     = this.#meta[i]
    const c     = this.#scratchColor
    const local = i % LOCAL_CAP + 1              // 1..4.095 dentro del chunk; el 0 es «objeto sin entrada»
    c.r = this.#iconSet.atlas.tileChannel(m.tileIdx)
    c.g = m.angleNorm
    c.b = (local >> 8) / 255                     // 4 bits altos del local; el pase le suma el chunk arriba
    c.a = (local & 255) / 255
    return c
  }

  // Recaptura el espejo: el WebGLBuffer es estable, pero typedVertices se reemplaza en cada
  // render() de glify (points.ts:114). Re-emite DYNAMIC_DRAW (hint apto a updates puntuales).
  #bind() {
    const gl = this.#layer.gl
    this.#buf   = this.#layer.getBuffer('vertices')
    this.#verts = this.#layer.typedVertices
    this.#cx    = this.#layer.mapCenterPixels.x
    this.#cy    = this.#layer.mapCenterPixels.y
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

  // patch de un ítem sucio: posición + color + size (7 floats). El índice local (b,a) es función del
  // slot, que es estable → se reescribe igual sin coste extra.
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
    m.tileIdx   = tileIdx
    m.angleNorm = an
    m.size      = sz
    const v     = this.#verts
    const base  = s * 7
    const local = s % LOCAL_CAP + 1
    v[base]     = projX0(lng) - this.#cx
    v[base + 1] = projY0(lat) - this.#cy
    v[base + 2] = this.#iconSet.atlas.tileChannel(tileIdx)
    v[base + 3] = an
    v[base + 4] = (local >> 8) / 255             // 4 bits altos del local; el pase le suma el chunk arriba
    v[base + 5] = (local & 255) / 255
    v[base + 6] = sz
    const gl = this.#layer.gl
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#buf)
    gl.bufferSubData(gl.ARRAY_BUFFER, base * 4, v, base, 7)
  }
}
