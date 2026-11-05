import { safe } from '../data/safe.js'
import { EditSurface, nuevoCanvas } from './EditSurface.js'
import { GlCompositor } from './gl-compositor.js'
import { projX0, projY0, readView } from './project.js'
import { RebuildQueue } from './tramo-rebuild.js'

// Un tramo: una corrida de capas GL contiguas en el apilado que comparte UN contexto. Cada miembro dibuja en su propia
// textura (un FBO que le enlaza `begin()`), en los mismos eventos que hoy, y avisa con `end(view)` la vista con que
// pintó; el tramo sólo compone esas texturas sobre su canvas, en orden K, en la microtarea de la tarea en que algo
// cambió. Un miembro que no pintó no se redibuja: su textura se vuelve a componer. Visibilidad y opacidad se resuelven
// al componer, sin hacer dibujar a nadie.
//
// El contexto es el de una `EditSurface` sin cambios cuyo dueño es el tramo: de ella salen la adquisición A2 (canvas
// nuevo, sin `restoreContext`), el marcador perezoso, `reconcile`, `release`, `onState` y el registro en `gl-budget`.
// La política ve una superficie por tramo; los miembros (`TramoSlot`) nunca se registran.
//
// Recuperación: al perder el contexto todos los miembros olvidan su parte GL y sus texturas. Al volver a tenerlo, los
// que tenían contenido se rearman con su `buildGl` de mayor a menor K, en tandas acotadas (`RebuildQueue`), y se
// compone tras cada tanda.

const report = error => console.error('[cristae] una capa del tramo falló al armar o soltar su parte GL', error)

// Si un miembro cuenta para que el tramo tenga algo que dibujar. De módulo: `some` no crea una clausura por lectura.
const withContent = slot => slot.visible && (slot.wanted || !!slot.owner?.hasContent)

// La vista con que se pinta o se compone, en la forma de `readView`.
const newView = () => ({ zoom: 0, center: { x: 0, y: 0 }, size: { x: 0, y: 0 } })

export class GlTramo {

  #camera; #surface; #solo; #onForeign; #compositorFactory; #queue; #offZoom
  #compositor = null
  #members    = []                  // en orden K ascendente
  #spare      = []                  // el arreglo de la lista anterior: se alternan en `setMembers`
  #order      = []                  // los que se rearman, de mayor a menor K
  #entries    = []                  // entradas de composición preasignadas: { target, painted, opacity }
  #watched    = []                  // panes vacíos ajenos dentro del rango
  #foreign    = new WeakSet()       // los que ya avisaron: una vez por nodo
  #now        = newView()           // la vista viva, leída al componer
  #view       = newView()           // la vista inyectada por el zoom animado
  #injected   = false
  #anchored   = false               // un `sync` ya reasentó el canvas en esta tarea: la composición no lo repite
  #scheduled  = false
  #building   = false               // la primera tanda corre dentro de `acquire`, que avisa a todos al terminar

  // Lo que la superficie avisa —tomar el contexto, perderlo, soltarlo— cambia el estado de cada miembro.
  #relay = () => {
    const list = this.#members
    for (let i = 0; i < list.length; i++) list[i].onState?.(list[i])
  }

  #onZoomEnd = () => {
    this.#injected = false
    this.#schedule()
  }

  // Un miembro de la cola de recuperación: puede haber salido, haberse soltado o armado entre tandas.
  #buildMember = slot =>
    slot.tramo === this && slot.wanted && !slot.released && !slot.built && !!this.#compositor && this.#arm(slot, !this.#building)

  #schedule = () => {
    if (this.#scheduled) return
    this.#scheduled = true
    queueMicrotask(this.#compose)
  }

  // [0-alloc] Primero los panes vigilados: uno que recibió hijos deja de ser vacío y avisa una vez. Después reasienta el
  // canvas (tamaño y ancla a la vista viva), salvo que un `sync` ya lo hiciera en esta tarea, y compone en orden K lo
  // visible, armado, pintado y con opacidad. El tramo solo compone con opacidad 1: la del miembro la pone el CSS de su
  // pane, que es también el del canvas. Lo oculto no se compone tampoco ahí: ocultarlo dos veces no cambia nada.
  #compose = () => {
    const anchored  = this.#anchored
    this.#scheduled = false
    this.#anchored  = false
    const watched = this.#watched
    for (let i = 0; i < watched.length; i++) {
      const node = watched[i]
      if (!node.firstChild || this.#foreign.has(node)) continue
      this.#foreign.add(node)
      this.#onForeign?.(node)
    }
    if (!this.#compositor || this.#surface.state !== 'live') return 0

    anchored || this.#surface.resetCanvasReference()
    const view    = this.#injected ? this.#view : readView(this.#camera, this.#now)
    const list    = this.#members
    const entries = this.#entries
    let n = 0
    for (let i = 0; i < list.length; i++) {
      const m     = list[i]
      const alpha = !m.visible ? 0 : this.#solo ? 1 : m.opacity
      if (!m.built || !m.hasPainted || m.destroyed || alpha <= 0) continue
      const e   = entries[n++]
      e.target  = m.target
      e.painted = m.painted
      e.opacity = alpha
    }
    return this.#compositor.compose(entries, n, view, globalThis.devicePixelRatio || 1)
  }

  // `pane` es el del tramo (uno propio) o, en un tramo solo, el de su único miembro. `compositor` y `queue` se inyectan
  // en los tests.
  constructor({ host, pane, solo = false, onForeign = null, compositor = gl => new GlCompositor(gl), queue = new RebuildQueue() }) {
    this.#camera            = host.camera
    this.#solo              = solo
    this.#onForeign         = onForeign
    this.#compositorFactory = compositor
    this.#queue             = queue
    this.#surface           = new EditSurface({ host, pane, antialias: false, depth: false, cssZoom: false, owner: this })
    this.#surface.onState   = this.#relay
    this.#offZoom           = host.camera.on('zoomend', this.#onZoomEnd)
  }

  get surface()    { return this.#surface }
  get gl()         { return this.#surface.gl }
  get members()    { return this.#members }
  get solo()       { return this.#solo }
  // Lo lee `EditSurface.needed`: algún miembro visible con algo que dibujar.
  get hasContent() { return this.#members.some(withContent) }

  // Los miembros en orden K ascendente; el diff es por identidad. El que sale suelta lo suyo si sigue siendo de acá; el
  // que entra se arma ya si el tramo vive y tiene contenido, o abre la superficie si todavía no se abrió. Un miembro que
  // llega armado en otro tramo lo suelta allá primero.
  setMembers(list, count) {
    const old = this.#members
    for (let i = 0; i < old.length; i++) {
      const m = old[i]
      const k = list.indexOf(m)
      if ((k >= 0 && k < count) || m.tramo !== this) continue
      this.#unbuild(m)
      m.tramo = null
    }

    const next = this.#spare
    next.length = 0
    for (let i = 0; i < count; i++) next.push(list[i])
    old.length    = 0
    this.#spare   = old
    this.#members = next
    while (this.#entries.length < count) this.#entries.push({ target: null, painted: null, opacity: 1 })

    const surface = this.#surface
    const live    = surface.state === 'live'
    let wanted    = false
    for (let i = 0; i < count; i++) {
      const m = next[i]
      if (m.tramo === this) continue
      m.tramo && m.tramo.#unbuild(m) && m.tramo.#schedule()
      m.tramo = this
      if (!m.wanted || m.released) continue
      if (live) m.built || this.#arm(m, true)
      else wanted = true
    }
    !surface.canvas && wanted && surface.open(true)
    this.#solo && this.#place()
    this.#schedule()
  }

  watch(nodes, count) {
    const w = this.#watched
    w.length = 0
    for (let i = 0; i < count; i++) w.push(nodes[i])
  }

  // El gestor movió el pane del tramo, o el marcador del miembro de un tramo solo: el canvas lo sigue y se compone.
  touch() {
    this.#solo && this.#place()
    this.#schedule()
  }

  // [0-alloc] La vista de un cuadro del zoom animado, con `center` en grados: se compone con ella hasta `zoomend` o el
  // siguiente `sync`.
  renderAtView(zoom, center) {
    const view = this.#view
    const size = this.#camera.size()
    view.zoom     = zoom
    view.center.x = projX0(center.lng)
    view.center.y = projY0(center.lat)
    view.size.x   = size.x
    view.size.y   = size.y

    this.#injected = true
    this.#schedule()
  }

  // Dueño de la superficie: el contexto es nuevo (A2). Compositor nuevo y los miembros con contenido, de mayor a menor K.
  buildGl(gl) {
    this.#compositor = this.#compositorFactory(gl)
    this.#solo && this.#place()
    const order = this.#order
    const list  = this.#members
    order.length = 0
    for (let i = list.length - 1; i >= 0; i--) list[i].wanted && !list[i].released && !list[i].built && order.push(list[i])
    this.#building = true
    try {
      this.#queue.start(order, order.length, this.#buildMember, this.#schedule)
    } finally {
      this.#building = false
    }
  }

  // El contexto se perdió, o la superficie lo va a soltar con `loseContext`, que libera todo de una vez: los miembros
  // olvidan su parte GL y las texturas se olvidan sin borrarlas.
  dropGl() {
    this.#queue.cancel()
    const list = this.#members
    for (let i = 0; i < list.length; i++) {
      const m = list[i]
      m.hasPainted = false
      m.target.fbo = m.target.texture = null
      m.target.width = m.target.height = 0
      if (!m.built) continue
      m.built = false
      safe(m.dropGl, undefined, report)
    }
    this.#compositor = null
  }

  destroy() {
    this.#queue.cancel()
    this.#offZoom()
    const list = this.#members
    for (let i = 0; i < list.length; i++) {
      const m = list[i]
      m.built && safe(m.dropGl, undefined, report)
      m.built      = false
      m.hasPainted = false
      m.tramo === this && (m.tramo = null)
    }
    list.length = 0
    this.#watched.length = 0
    this.#compositor = null
    this.#surface.destroy()
  }

  /* ── Lo que usa TramoSlot ── */

  // Alta perezosa de un miembro. La primera abre la superficie (sin WebGL2 lanza, como siempre); con el tramo vivo y
  // contenido se arma ya. Devuelve el contexto si quedó armado.
  open(slot, content) {
    const surface = this.#surface
    surface.canvas || surface.open(content)
    content && !slot.built && !slot.released && surface.state === 'live' && this.#arm(slot, true)
    this.#solo && this.#place()
    return slot.built ? surface.gl : null
  }

  // El miembro recibió contenido o se volvió a ver. Vivo, se arma en el acto; sin contexto, la política decide, y si lo
  // toma ya `buildGl` lo arma. Uno vacío que se vuelve a ver no pide nada: el contenido lo decide su dueño, como en
  // `EditSurface.needed`. Devuelve si quedó armado por este aviso.
  need(slot) {
    if (!(slot.wanted ||= !slot.lazy || !!slot.owner?.hasContent)) return false
    slot.released = false
    const surface = this.#surface
    if (surface.state !== 'live') {
      surface.need()
      return slot.built
    }
    const armed = !slot.built && this.#arm(slot, true)
    surface.need()
    return armed
  }

  // Síncrono: el contexto del tramo, tomado si hace falta, y el miembro armado sobre él.
  acquire(slot) {
    slot.wanted   = true
    slot.released = false
    const gl = this.#surface.acquire()
    slot.built || this.#arm(slot, true)
    this.#solo && this.#place()
    return gl
  }

  release(slot) {
    if (slot.released) return false
    this.#unbuild(slot)
    slot.released = true
    this.#schedule()
    slot.onState?.(slot)
    return true
  }

  // Sin el tramo vivo, el del tramo; vivo: armado, soltado, a la espera de la cola (`lost`) o sin pedir contexto.
  stateOf(slot) {
    const state = this.#surface.state
    return state !== 'live' ? state
      : slot.built ? 'live'
      : slot.released ? 'released'
      : slot.wanted ? 'lost'
      : 'none'
  }

  // [0-alloc] El `resetCanvasReference` de un miembro. La vista inyectada la sueltan `zoomend` y los miembros que el motor
  // reproyecta por cuadro (`cssZoom: false`, los puntos); una línea que redibuja en pleno zoom animado no. Un miembro
  // oculto o sin armar no reasienta ni compone: el canvas viaja con el pane. El que se ve reasienta el canvas antes de
  // dibujar, porque su FBO toma el tamaño del drawing buffer, y la composición de esta tarea ya no lo repite.
  sync(slot) {
    slot.cssZoom || (this.#injected = false)
    if (!slot.visible || !slot.built) return
    this.#surface.resetCanvasReference()
    this.#anchored = true
    this.#schedule()
  }

  // [0-alloc] Antes de cada dibujo del miembro: su FBO enlazado, del tamaño del drawing buffer, y el estado base.
  begin(slot) {
    const gl = this.#surface.gl
    return this.#compositor && gl ? this.#compositor.bind(slot.target, gl.drawingBufferWidth, gl.drawingBufferHeight) : null
  }

  // [0-alloc] Al terminar el dibujo, aunque no haya pintado nada: la vista con que pintó, copiada campo a campo.
  end(slot, view) {
    const p = slot.painted
    p.zoom     = view.zoom
    p.center.x = view.center.x
    p.center.y = view.center.y
    p.size.x   = view.size.x
    p.size.y   = view.size.y

    slot.hasPainted = true
    this.#schedule()
  }

  // [0-alloc] Visibilidad y opacidad son de la composición: no hacen dibujar a nadie, y repetir el valor no compone.
  setVisible(slot, visible) {
    if (slot.visible === visible) return false
    slot.visible = visible
    this.#schedule()
    return true
  }

  setOpacity(slot, alpha) {
    if (slot.opacity === alpha) return false
    slot.opacity = alpha
    this.#schedule()
    return true
  }

  /* ── Internos ── */

  // `built` va antes de `buildGl`: la capa que en él avisa contenido (`need`) no se arma dos veces.
  #arm(slot, notify) {
    slot.built     = true
    slot.released  = false
    slot.everBuilt = true
    safe(slot.buildGl, this.#surface.gl, report)
    notify && slot.onState?.(slot)
    return true
  }

  // Suelta lo GL de un miembro armado con el contexto vivo: su capa lo olvida y el compositor borra su FBO y su textura.
  #unbuild(slot) {
    if (!slot.built) return false
    slot.built      = false
    slot.hasPainted = false
    safe(slot.dropGl, undefined, report)
    this.#compositor?.drop(slot.target)
    return true
  }

  // Tramo solo: el canvas va justo después del marcador de su miembro. `acquire` reemplaza al canvas en su lugar, así
  // que la posición se conserva entre contextos.
  #place() {
    const marker = this.#members[0]?.marker
    const canvas = this.#surface.canvas
    marker && canvas && marker.parentNode && marker.nextSibling !== canvas && marker.after(canvas)
  }

}

// Un miembro de un tramo, con la forma de `EditSurface` que usan las capas. El contexto es el del tramo; el slot guarda
// lo que es del miembro. Los campos públicos sin getter son INTERNOS: los lee y escribe `GlTramo` (mismo archivo) y no
// son contrato de las capas.
export class TramoSlot {

  #surface; #pane; #cssZoom; #owner; #hooks
  #marker = null

  onState = null                                                          // como `EditSurface.onState`
  tramo   = null                                                          // lo escribe `GlTramo.setMembers`

  // Internos, del tramo.
  target     = { fbo: null, texture: null, width: 0, height: 0 }          // la textura del miembro y su FBO
  painted    = { zoom: 0, center: { x: 0, y: 0 }, size: { x: 0, y: 0 } }  // la vista con que pintó por última vez
  hasPainted = false
  built      = false                                                      // su `buildGl` corrió sobre el contexto vivo
  everBuilt  = false
  wanted     = false                                                      // tiene contenido: el tramo le debe un contexto
  released   = false
  visible    = true
  opacity    = 1
  lazy       = false
  destroyed  = false
  buildGl; dropGl                                                         // los del dueño, ligados una vez

  // `opts` son los de `EditSurface`; `antialias` y `depth` los decide el tramo. `hooks` son los del gestor: `place` lo
  // ubica en un tramo al crear el marcador y `remove` lo saca al destruirse.
  constructor({ host, pane, cssZoom = true, owner = null }, hooks) {
    this.#surface = host.surface
    this.#pane    = pane
    this.#cssZoom = cssZoom
    this.#owner   = owner
    this.#hooks   = hooks
    this.buildGl  = gl => owner?.buildGl(gl)
    this.dropGl   = () => owner?.dropGl()
  }

  get gl()          { return this.built ? this.tramo?.gl ?? null : null }
  get canvas()      { return this.#marker }
  get attached()    { return this.everBuilt && !this.destroyed }
  // Como `EditSurface.contextLost`: la pérdida del tramo se sabe con el evento, no al leer el contexto; con el tramo vivo,
  // el miembro que espera su tanda de la cola.
  get contextLost() { return !!this.tramo && (this.tramo.surface.contextLost || this.tramo.surface.state === 'live' && this.state === 'lost') }
  get cssZoom()     { return this.#cssZoom }
  get z()           { return this.#surface.zOf(this.#pane) ?? 0 }
  get needed()      { return withContent(this) && !!this.#marker && this.#marker.ownerDocument?.defaultView !== null }
  get state()       { return this.tramo?.stateOf(this) ?? 'none' }
  get pane()        { return this.#pane }
  get marker()      { return this.#marker }
  get owner()       { return this.#owner }

  open(content) {
    this.lazy     = true
    this.wanted ||= !!content
    this.#mark()
    return this.tramo?.open(this, content) ?? null
  }

  need() { return !!this.tramo && this.tramo.need(this) }

  acquire() {
    if (this.destroyed) throw new Error('[cristae] superficie destruida: no se re-adquiere')
    this.wanted = true
    this.#mark()
    return this.tramo?.acquire(this) ?? null
  }

  release()              { return !!this.tramo && this.tramo.release(this) }
  reconcile()            { return !!this.tramo && this.tramo.surface.reconcile() }
  resetCanvasReference() { this.tramo?.sync(this) }
  begin()                { return this.tramo?.begin(this) ?? null }
  end(view)              { this.tramo?.end(this, view) }

  setVisible(visible = true) {
    if (this.tramo) return this.tramo.setVisible(this, visible)
    this.visible = visible
    return false
  }

  setOpacity(alpha = 1) {
    if (this.tramo) return this.tramo.setOpacity(this, alpha)
    this.opacity = alpha
    return false
  }

  // El gestor lo saca de su tramo (que suelta lo suyo: el `dropGl` doble es inocuo) y el marcador sale del pane.
  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    this.onState   = null
    this.#hooks.remove(this)
    if (this.#marker) {
      this.#marker.remove()
      this.#surface.unmount(this.#pane)
    }
    this.#marker = null
  }

  // El primer `open` o `acquire` deja el marcador en el pane y pide un tramo.
  #mark() {
    if (this.#marker) return
    const marker = nuevoCanvas()                                         // guarda su K y es el `canvas` que ve el motor
    this.#surface.mount(this.#pane).appendChild(marker)
    this.#marker = marker
    this.#hooks.place(this)
  }

}
