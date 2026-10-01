import { GpuAtlasBinding } from '../atlas/GpuAtlasBinding.js'
import { anchorMatrix } from './anchor-matrix.js'
import { EditSurface, blendOver } from './EditSurface.js'
import { Picking, LOCAL_BITS, CHUNK_BITS } from './Picking.js'
import { pixelScaleOf } from './pixel-scale.js'
import { linkPointProgram, POINT_FLOATS } from './point-program.js'
import { projX0, projY0, readView } from './project.js'

// Capa de puntos GL sobre su propia superficie. Dos paths (MODELO §17):
//   rebuild     → reescribe el VBO entero (O(n); set/filtro/cluster/regrow) y lo sube de una vez.
//   incremental → escribe el slot por bufferSubData (O(1), [0-alloc]; move y patch sin cambio de
//                 membresía). (§17.5)
// El layout es el de los sprites (point-program.js): r=tile, g=ángulo, b,a=índice local de picking.
// Las posiciones van proyectadas a world0 y RELATIVAS AL ANCLA, que cada rebuild fija en el centro de la
// vista: float32 alcanza a z18 y la traslación absoluta vive en la matriz.

const DEFAULT_VARIANT = 'default'
const NORM            = 1 / 360
const angleNorm       = deg => (((deg % 360) + 360) % 360) * NORM
const SIZE            = 6     // canal del tamaño en el layout

// El índice local del picking ocupa los canales b,a del atributo `color` con la convención `local + 1`:
// el 0 significa «el objeto, pero no una entrada». Objeto y chunk son uniform del draw, y el `% LOCAL_CAP`
// mantiene b ≤ 15 para que el pase pueda sumarle el chunk al canal rojo sin desbordar el byte.
const LOCAL_CAP = (1 << LOCAL_BITS) - 1
const PICK_CAP  = (1 << CHUNK_BITS) * LOCAL_CAP

export class PointLayer {

  #camera; #surface; #gl; #source; #iconSet
  #accessors   = null   // accessors de RENDER (override de los de la Source: variantOf/sizeOf/headingOf)
  #where       = null   // predicado de membresía por-capa (overlay): omite ítems que no matchean
  #program     = null
  #vao         = null
  #vbo         = null
  #uMatrix     = null
  #uDim        = null
  #binding     = null
  #picking     = null
  #matrix      = new Float32Array(16)   // la del último draw: el pase de picking pica lo que se ve
  #view        = { zoom: 0, center: { x: 0, y: 0 }, size: { x: 0, y: 0 } }
  #injected    = false  // `#view` es un cuadro del zoom animado: rige hasta que el motor reasienta la capa
  #frame       = 0      // rAF del repintado agendado; 0 = ninguno
  #scale       = 1      // px del drawing buffer por px CSS: la unidad de `gl_PointSize`
  #scaledAt    = 0      // ancho del buffer con el que se midió `#scale`
  #hoverPick   = { hits: [], sample: null }   // cache del último pick de hover, atado a su muestra
  #pickObj     = 0      // identidad de objeto en el pase (la asigna el motor; 0 = el pase la saltea)
  // Partes de hit por canal: `out` (lo que se devuelve, truncado al nº de hits) referencia objetos de
  // `pool`, que sólo crece → en régimen permanente el hover no asigna nada por pick. Un pool por canal:
  // un click no puede pisar las partes que el cache de hover todavía tiene vigentes.
  #hoverParts  = { pool: [], out: [] }
  #clickParts  = { pool: [], out: [] }
  #draws       = []
  #batch       = { draws: this.#draws, length: 0, matrix: this.#matrix }

  // El VBO y su espejo CPU, que es la única copia de los datos: el rebuild lo reescribe y sube lo que
  // ocupa, y el path incremental le parcha el slot y sube ese rango.
  #verts      = new Float32Array(POINT_FLOATS)
  #ax         = 0; #ay = 0  // ancla en world0
  #idBySlot   = []          // slot → id (traduce hits de picking)
  #slot       = new Map()   // id → slot
  #count      = 0
  #snapLen    = -1          // tamaño del snapshot del último rebuild (detecta alta/baja)
  #suppressed = null        // ids a omitir del buffer (p. ej. clusterizados); null = ninguno
  // Deshabilitada como ENTIDAD (setLayerEnabled): la suscripción a la Source no procesa nada —
  // cero CPU/GPU por emit del WS mientras el pane está oculto (mismo patrón que LabelLayer).
  // refresh() sigue operativo (es el catch-up explícito al re-habilitar).
  #enabled = true

  // Eje focus: el alfa por ítem viaja en el SIGNO del `size` del vértice; `ids` null = sin foco.
  #focus      = { ids: null, dim: 0.3 }
  #focusSlots = []   // slots que cambiaron en el último applyFocus (reusado, sólo crece)

  #unsub = null

  // `accessors` override (default = los de la Source): permite que una capa LEA los
  // datos de una Source compartida (idOf/positionOf) pero RENDERICE con otros
  // variantOf/sizeOf/headingOf (caso overlay: misma flota, sprite de badge sin rotar).
  // `where` filtra qué ítems de la Source entran a ESTA capa (overlay: sólo los que
  // tienen badge), sin tocar la Source (que el mapa comparte).
  //
  // La superficie lleva profundidad para el orden por banda del foco, y no sigue la transición del zoom:
  // el motor reproyecta la capa por cuadro (`renderAtView`).
  constructor({ host, pane, source, iconSet, interactive = false, accessors = null, where = null }) {
    this.#camera    = host.camera
    this.#source    = source
    this.#accessors = accessors ?? source.accessors
    this.#where     = where
    this.#iconSet   = iconSet
    this.#surface   = new EditSurface({ host, pane, depth: true, cssZoom: false })
    const gl = this.#gl = this.#surface.attach()
    // La superficie ya tomó uno de los ~16 contextos: lo que siga puede tirar y nadie devuelve uno solo.
    try {
      this.#vbo = gl.createBuffer()
      ;({ program: this.#program, vao: this.#vao } = linkPointProgram(gl, this.#vbo))
      this.#uMatrix = gl.getUniformLocation(this.#program, 'matrix')
      this.#uDim    = gl.getUniformLocation(this.#program, 'uDim')
      this.#binding = new GpuAtlasBinding(gl).register(this.#program)
      gl.depthFunc(gl.LEQUAL)     // banda igual → gana el último: la precedencia de slot queda intacta
      if (interactive) {
        this.#picking = new Picking()
        this.#binding.register(this.#picking.attach(gl, this.#program, true))
      }
      this.#rescale()
      this.#unsub = source.subscribe(() => this.#onChange())
      this.#onChange()
    } catch (e) {
      this.destroy()
      throw e
    }
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

  // Encola un pick GPU para la muestra del puntero, en su píxel del contenedor.
  requestHoverHit(sample) {
    return !!this.#picking && this.#picking.request(sample.x, sample.y, this.#pickBatch(), sample)
  }

  // Recoge el pick encolado (no bloqueante). Cachea los hits + la muestra para resolveHover.
  collectHoverHit() {
    const pick = this.#picking?.collect()
    if (!pick) return null
    this.#hoverPick.hits   = this.#partsFrom(pick.hits, this.#hoverParts)
    this.#hoverPick.sample = pick.metadata
    return pick.metadata
  }

  // resolveHover devuelve el cache solo si es de la muestra vigente: cada muestra es un objeto nuevo.
  resolveHover(sample) {
    return this.#hoverPick.sample === sample ? this.#hoverPick.hits : []
  }

  // resolveClick hace un pick síncrono (un tiro) en el punto del evento, con el mismo batch.
  resolveClick(sample) {
    const pick = this.#picking?.pickSync(sample.x, sample.y, this.#pickBatch(), sample)
    return pick ? this.#partsFrom(pick.hits, this.#clickParts) : []
  }

  cancelHoverHit() { this.#picking?.abort() }

  // Un draw por chunk: el índice local direcciona LOCAL_CAP entradas, y más allá de PICK_CAP la capa se
  // degrada a «no pickeable», nunca a un hit ajeno. El pase toma los descriptores por REFERENCIA, así
  // que el pedido encolado dispara con el estado del último pick.
  #pickBatch() {
    const total  = Math.min(this.#count, PICK_CAP)
    const chunks = Math.ceil(total / LOCAL_CAP)
    const draws  = this.#draws
    for (let k = 0; k < chunks; k++) {
      const d = draws[k] ??= { bind: this.#bindVao, texture: this.#binding.texture, mode: this.#gl.POINTS, chunk: k, first: k * LOCAL_CAP, count: 0, obj: 0 }
      d.count = Math.min(LOCAL_CAP, total - d.first)
      d.obj   = this.#pickObj
    }
    this.#batch.length = chunks
    return this.#batch
  }

  #bindVao = () => this.#gl.bindVertexArray(this.#vao)

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

  // Repinta en el próximo cuadro; los pedidos del mismo cuadro son un solo dibujo.
  redraw() { this.#frame ||= requestAnimationFrame(this.#paint) }
  syncPickingSize() { this.#picking?.syncSize() }

  // Reasienta el canvas a la vista viva y la dibuja en el acto; el motor la invoca en move/moveend/zoomend.
  // Un cambio de escala (la ventana pasó a otro monitor) re-codifica los tamaños, que van en px del buffer.
  resetCanvasReference() {
    this.#injected = false
    this.#surface.resetCanvasReference()
    this.#rescale() && this.refresh()
    this.#draw(readView(this.#camera, this.#view))
  }

  // Reproyección por-frame a una vista (zoom, center) ARBITRARIA — el corazón del zoom ANIMADO. Los
  // vértices viven en world0 rel-ancla, así que reproyectar es sólo rehacer la matriz y re-emitir el
  // draw: O(1), **tamaño de sprite fijo** (no "gigante") y **sin corte** (redibuja al viewport cada
  // frame). La vista va INYECTADA en vez de la de la cámara, que durante la animación sigue en el zoom de
  // partida. El motor la llama por frame, interpolando (zoom, center) con el easing del tile.
  renderAtView(zoom, center) {
    const view = this.#view
    const size = this.#camera.size()
    view.zoom     = zoom
    view.center.x = projX0(center.lng)
    view.center.y = projY0(center.lat)
    view.size.x   = size.x
    view.size.y   = size.y

    this.#injected = true
    this.#draw(view)
  }

  // Un repintado agendado durante el zoom animado (un flush de la Source, un foco) dibuja el cuadro que
  // se ve, no la vista de partida que todavía tiene la cámara.
  #paint = () => {
    this.#frame = 0
    this.#draw(this.#injected ? this.#view : readView(this.#camera, this.#view))
  }

  // El orden por banda limpia y prueba profundidad en cada draw: el pase de picking la apaga al salir.
  #draw(view) {
    if (this.#surface.contextLost) return
    const gl = this.#gl
    this.#binding.sync(this.#iconSet.atlas)
    gl.useProgram(this.#program)
    gl.uniformMatrix4fv(this.#uMatrix, false, anchorMatrix(this.#matrix, this.#ax, this.#ay, view.zoom, view.center, view.size))
    gl.uniform1f(this.#uDim, this.#focus.dim)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
    blendOver(gl)
    gl.enable(gl.DEPTH_TEST)
    gl.bindVertexArray(this.#vao)
    gl.drawArrays(gl.POINTS, 0, this.#count)
    gl.bindVertexArray(null)
  }

  // Px del drawing buffer por px CSS. Se remide sólo si cambió el ancho del buffer: `clientWidth` fuerza
  // layout, y esto corre por cuadro de paneo. Devuelve si la escala cambió.
  #rescale() {
    const gl = this.#gl
    if (gl.drawingBufferWidth === this.#scaledAt) return false
    this.#scaledAt = gl.drawingBufferWidth
    const scale = pixelScaleOf(gl)
    if (scale === this.#scale) return false
    this.#scale = scale
    return true
  }

  // Re-encode total con los accessors actuales (recolor por antigüedad/latencia, SPECS §8.1)
  // o tras cambiar la supresión. Fuerza rebuild aunque el set no cambie de tamaño.
  refresh() { this.#rebuild(this.#source.getSnapshot()) }

  // ids a omitir del buffer (cluster). Cambiarla exige refresh() para reconstruir.
  set suppressed(ids) { this.#suppressed = ids }

  // Predicado de membresía por-capa (overlay). Cambiarlo exige refresh().
  set where(fn) { this.#where = fn ?? null }

  // Gate del pipeline (entidad deshabilitada): apaga la REACCIÓN a la Source, no el handle.
  // Re-habilitar exige refresh() para ponerse al día (lo hace setLayerEnabled).
  set enabled(v) { this.#enabled = v ?? true }

  // Soltar el contexto libera de una vez buffer, VAO, programas y textura.
  destroy() {
    this.#unsub?.()
    cancelAnimationFrame(this.#frame)
    this.#picking?.detach()
    this.#surface.destroy()
  }

  /* ── Eje focus ── */

  // Cuesta UN float por ítem que CAMBIÓ de estado; mover sólo `dim` no toca el buffer: es un uniform.
  applyFocus(ids, dim = this.#focus.dim) {
    const focus = this.#focus
    const antes = focus.ids
    const redim = !!ids && dim !== focus.dim
    focus.ids = ids
    focus.dim = dim
    const v     = this.#verts
    const slots = this.#focusSlots
    let n = 0, lo = 0, hi = 0
    const flip = s => {
      const i = s * POINT_FLOATS + SIZE
      v[i] = -v[i]
      lo = n && lo < s ? lo : s
      hi = n && hi > s ? hi : s
      slots[n++] = s
    }
    const flipId = id => { const s = this.#slot.get(id); s === undefined || flip(s) }
    if (antes && ids) {
      antes.forEach(id => ids.has(id) || flipId(id))
      ids.forEach(id => antes.has(id) || flipId(id))
    } else if (antes || ids) {
      const foco = ids ?? antes
      this.#slot.forEach((s, id) => foco.has(id) || flip(s))
    }
    const gl = this.#gl
    if (n) {
      const rango = hi - lo + 1
      const base  = lo * POINT_FLOATS
      gl.bindBuffer(gl.ARRAY_BUFFER, this.#vbo)
      // Un float suelto cuesta una llamada; el rango entero cuesta UNA: se sube el rango si la mayoría cambió.
      if (2 * n > rango) gl.bufferSubData(gl.ARRAY_BUFFER, base * 4, v, base, rango * POINT_FLOATS)
      else for (let k = 0; k < n; k++) {
        const i = slots[k] * POINT_FLOATS + SIZE
        gl.bufferSubData(gl.ARRAY_BUFFER, i * 4, v, i, 1)
      }
    }
    if (n || redim) this.redraw()
    return true
  }

  /* ── Reacción al Source (ya coalescida a rAF por el Emitter) ── */

  #onChange() {
    if (!this.#enabled) return   // deshabilitada: no reaccionar (el alta la construye habilitada)
    const snap = this.#source.getSnapshot()
    const byId = this.#source.itemById
    // Sin lookup O(1) no hay path incremental: rebuild seguro.
    if (snap.length !== this.#snapLen || !byId) return this.#rebuild(snap)

    const a      = this.#accessors
    const v      = this.#verts
    const gl     = this.#gl
    const atlas0 = this.#iconSet.atlas
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#vbo)

    const moves = this.#source.moveDirtyIds?.()        // solo posición → 2 floats
    if (moves?.size) {
      for (const id of moves) {
        const s = this.#slot.get(id)
        if (s === undefined) {
          if (this.#absentByPolicy(id, byId(id))) continue   // no está en el buffer a propósito
          return this.#rebuild(snap)                         // desconocido → el buffer no está al día
        }
        const pos  = a.positionOf(byId(id))
        const base = s * POINT_FLOATS
        v[base]     = projX0(pos.lng) - this.#ax
        v[base + 1] = projY0(pos.lat) - this.#ay
        gl.bufferSubData(gl.ARRAY_BUFFER, base * 4, v, base, 2)
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
        const item = byId(id)
        const { lat, lng } = a.positionOf(item)   // copia inmediata: los accessors de abajo pueden reusar el objeto
        this.#encode(s, item, id, lat, lng)
        if (this.#iconSet.atlas !== atlas0) return this.#rebuild(snap)   // regrow → re-encode todo
        gl.bufferSubData(gl.ARRAY_BUFFER, s * POINT_FLOATS * 4, v, s * POINT_FLOATS, POINT_FLOATS)
      }
    }

    this.redraw()
  }

  // Los 7 floats de un slot, punto único de los dos paths. El tamaño es `sizeOf` (o el default del
  // iconSet) × la escala de footprint de la variante (1 salvo que el descriptor pida `scale`) × la escala
  // del buffer, SIGNADO por el eje focus (negativo = atenuado): ni la escala ni el atenuado pueden
  // olvidarse en un path, y un rebuild por causa ajena (set / filtro / cluster / regrow) los repone. El
  // índice local (b,a) es función del slot, que es estable. [0-alloc]
  #encode(s, item, id, lat, lng) {
    const a       = this.#accessors
    const set     = this.#iconSet
    const tileIdx = set.resolve(a.variantOf ? a.variantOf(item) : DEFAULT_VARIANT)
    const px      = (a.sizeOf ? a.sizeOf(item) : set.defaultSize) * set.tileScale(tileIdx) * this.#scale
    const ids     = this.#focus.ids
    const v       = this.#verts
    const base    = s * POINT_FLOATS
    const local   = s % LOCAL_CAP + 1            // 1..4.095 dentro del chunk; el 0 es «objeto sin entrada»
    v[base]        = projX0(lng) - this.#ax
    v[base + 1]    = projY0(lat) - this.#ay
    v[base + 2]    = set.atlas.tileChannel(tileIdx)
    v[base + 3]    = set.rotates && a.headingOf ? angleNorm(a.headingOf(item)) : 0
    v[base + 4]    = (local >> 8) / 255          // 4 bits altos del local; el pase le suma el chunk arriba
    v[base + 5]    = (local & 255) / 255
    v[base + SIZE] = !ids || ids.has(id) ? px : -px
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

  /* ── Rebuild (O(n), reusa el espejo salvo crecimiento del set) ── */

  // El canal de tile se normaliza por la capacidad del atlas: un regrow a mitad del recorrido deja los
  // slots anteriores con la capacidad vieja, así que se recorre otra vez (ya sin regrow).
  #rebuild(snap) {
    const a      = this.#accessors
    const atlas0 = this.#iconSet.atlas
    const center = this.#camera.center()
    this.#ax = projX0(center.lng)
    this.#ay = projY0(center.lat)
    if (this.#verts.length < snap.length * POINT_FLOATS)
      this.#verts = new Float32Array(Math.max(snap.length, 2 * this.#verts.length / POINT_FLOATS) * POINT_FLOATS)
    this.#slot.clear()
    let n = 0
    for (let i = 0; i < snap.length; i++) {
      const item = snap[i]
      const id   = a.idOf(item)
      if (this.#slot.has(id)) continue                                 // §15.2 duplicado → gana el primero
      const pos = this.#renderablePos(item, id)
      if (!pos) continue
      const { lat, lng } = pos     // copia inmediata: el objeto de `positionOf` puede ser scratch reusado
      this.#encode(n, item, id, lat, lng)
      this.#idBySlot[n] = id
      this.#slot.set(id, n++)
    }
    if (this.#iconSet.atlas !== atlas0) return this.#rebuild(snap)

    this.#idBySlot.length = n
    this.#count           = n
    this.#snapLen         = snap.length
    const gl = this.#gl
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#vbo)
    gl.bufferData(gl.ARRAY_BUFFER, this.#verts.subarray(0, n * POINT_FLOATS), gl.DYNAMIC_DRAW)
    this.redraw()
  }
}
