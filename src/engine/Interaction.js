import { CLICK_TOLERANCE, EVENT_HOVER, HANDLE_HELD, HANDLE_OVER, PICK_CHANNELS, topFirst } from '../events/events.js'

// Interaction — la puerta del puntero: oye la entrada cruda del anfitrión, decide de quién es cada
// pulsación y traduce lo que queda en hits ruteados por el EventBus; el ciclo de vista lo oye por su
// cámara. Cablea cuatro cosas y nada más: (1) la pulsación —su dueño, el click que sintetiza y el doble
// click, en docs/interaction.md#la-puerta-del-puntero—; (2) pointer/click → registry.resolveHits →
// bus.dispatch; (3) la sesión de hover con picking GPU no bloqueante (request → poll rAF → collect); (4) la
// supresión de hover durante zoom/pan y el cursor del contenedor, del que es el ÚNICO escritor. No conoce
// capas ni dominio: pide los hits al registro, los puntos pickeables al motor y los handles a cada
// participante que se suma con `join`.
//
// Picking dirigido por demanda, con DOS motivos para correr la sesión de hover (ver PICK_CHANNELS):
//   · entregar EVENTOS de hover  → demanda del canal HOVER (`#hover.hoverDemand`);
//   · el `pointer` del cursor    → demanda de CLICK o HOVER (`#hover.pickDemand`), salvo con cursor
//                                  del consumidor.
// El cursor `pointer` es una affordance de la INTERACTIVIDAD, no del canal de hover: una capa
// clickeable debe marcar el puntero al pasar sobre sus features —como `.leaflet-interactive` en
// Leaflet, y como promete SPECS §eventos ("cursor automático … capa interactive")— aunque el
// consumidor NO escuche `cristae:hover`. Por eso la sesión de hover (que es lo que sabe si el
// puntero cae sobre una feature) se corre también bajo demanda de CLICK, pero los EVENTOS de hover
// se emiten solo si hay demanda de HOVER. Si ningún canal interactivo tiene demanda, la sesión no
// se inicia (el picking correría en cada pointermove — lo más frecuente — y es caro). Con un cursor
// del consumidor puesto el `pointer` no se vería, así que no se resuelve: `pickChannels` se reduce a
// HOVER, #emitHover no lo consulta y quitarlo lo resuelve en el acto.

const noRaf = cb => setTimeout(cb, 0)
const hasRaf = typeof requestAnimationFrame === 'function'
const raf = hasRaf ? requestAnimationFrame : noRaf
const cancelRaf = hasRaf ? cancelAnimationFrame : clearTimeout
const now = () => performance.now()

// El cursor del consumidor, normalizado en la frontera: ausente, vacío o rechazado por el CSS es
// ninguno. El estilo ignora un valor que no parsea, y el árbitro lo daría por escrito con el anterior
// todavía puesto. Sin `CSS` global —un DOM emulado— no hay con qué validar, y se acepta.
const consumerCursor = cursor => cursor && (globalThis.CSS?.supports('cursor', cursor) ?? true) ? cursor : ''

const PASSIVE = Object.freeze({ passive: true })
const CAPTURE = Object.freeze({ capture: true })

// La pulsación de un participante es suya: el anfitrión, que oye en burbuja, no la ve.
const consume = event => {
  event.preventDefault()
  event.stopPropagation()
}

const quiet = (point, from) => Math.abs(point.x - from.x) + Math.abs(point.y - from.y) < CLICK_TOLERANCE

export class Interaction {

  #input
  #hostCamera
  #camera
  #registry
  #bus
  #container
  #pickLayers
  #throttleMs
  #onInteractionStart
  #onInteractionEnd
  #onEmptyClick

  // Estado del puntero, en píxeles del contenedor (muta-y-reusa). `inside` lo prenden el `pointerenter` o
  // cualquier muestra —un motor montado con el puntero ya encima no recibe `pointerenter`— y lo apaga el
  // `pointerleave` del contenedor.
  #pointer = { inside: false, x: 0, y: 0 }

  // La caja del contenedor, con su escala CSS y su borde: el píxel de cada evento sale de acá. Se cachea
  // porque leerla fuerza un layout, y en `pointermove` es el costo que no se paga; `stale` la manda a
  // releer al entrar el puntero, en cada pulsación y cuando el mapa cambia de tamaño.
  #frame = { stale: true, left: 0, top: 0, scaleX: 1, scaleY: 1, borderX: 0, borderY: 0 }

  // La pulsación en curso: su puntero (-1 sin pulsación), el píxel donde se apretó, su dueño —el
  // participante que la tomó, o null si es del mapa— y si todavía puede ser un click. `down` cuenta los
  // punteros apoyados en el contenedor, con pulsación o sin ella. Muta-y-reusa.
  #press = { pointer: -1, x: 0, y: 0, owner: null, click: false, down: 0 }

  // Los participantes, top-first como los hits: `{ participant, zIndex, order }`.
  #participants = []

  #interacting = false          // gesto de zoom/pan en curso → suprime hover (ortogonal al subsistema)

  // Estado del subsistema de hover (picking GPU): demanda, sesión activa y bookkeeping de
  // throttle/latest-only. Se muta-y-reusa (nunca se reasigna) — los métodos calientes cachean la ref.
  #hover = {
    hoverDemand  : false,           // demanda del canal HOVER → emitir eventos de hover
    pickDemand   : false,           // demanda de algún canal de `pickChannels` → correr el picking
    pickChannels : PICK_CHANNELS,   // CLICK|HOVER, o sólo HOVER con cursor del consumidor
    dirty        : false,           // llegó un pointermove con la sesión abierta → relee al cerrar
    lastAt       : -Infinity,       // marca de tiempo del último inicio de sesión (throttle)
    session      : null,            // sesión de picking en curso | null
    generation   : 0,               // sella cada sesión (invalidación)
    rafId        : null,            // handle del rAF del tick | null
  }

  // Entradas del árbitro del cursor: cada una la mantiene su fuente y #paintCursor resuelve la
  // precedencia. Se muta-y-reusa, como #hover.
  #cursor = {
    consumer : '',          // el que pide el consumidor ('' = ninguno)
    dragging : false,       // el usuario arrastra el mapa
    held     : new Set(),   // editores con un handle tomado
    over     : new Set(),   // editores con un handle bajo el puntero
    hit      : false,       // feature interactiva bajo el puntero
    written  : '',          // lo último escrito: sólo se escribe al cambiar
  }

  #offs = []                    // bajas de lo que se oye de la entrada y de la cámara del anfitrión

  constructor({ host, camera, registry, bus, pickLayers, hoverThrottleMs = 0, cursor, onInteractionStart, onInteractionEnd, onEmptyClick } = {}) {
    this.#input              = host.input
    this.#hostCamera         = host.camera
    this.#camera             = camera
    this.#registry           = registry
    this.#bus                = bus
    this.#container          = host.surface.container
    this.#pickLayers         = pickLayers ?? (() => [])
    this.#throttleMs         = hoverThrottleMs
    this.#cursor.consumer    = consumerCursor(cursor)
    this.#onInteractionStart = onInteractionStart
    this.#onInteractionEnd   = onInteractionEnd
    this.#onEmptyClick       = onEmptyClick
    this.#wire()
    this.#paintCursor()
  }

  set hoverThrottleMs(ms) { this.#throttleMs = ms }

  // Cursor del consumidor, en vivo: mueve el gate del picking además de lo que se pinta. El vigente no
  // toca nada, así que reponerlo por evento no relanza el pase ni se salta el throttle. Quitarlo
  // resuelve el `pointer` donde quedó el puntero, sin esperar a que se mueva, y una sesión abierta lo
  // relee al cerrar.
  set cursor(cursor) {
    const c    = this.#cursor
    const h    = this.#hover
    const next = consumerCursor(cursor)
    if (next === c.consumer) return
    c.consumer = next
    this.syncHoverDemand()
    this.#paintCursor()
    if (c.consumer || !h.pickDemand || this.#interacting || !this.#pointer.inside) return
    h.dirty = true
    h.session || this.#startHover(this.#sampleOf(this.#pointer))
  }

  // Un editor informa su nivel de handle y queda en el conjunto de ese nivel: con varios, el más
  // fuerte lo da la precedencia de #paintCursor, sin recorrerlos.
  setHandleLevel(id, level) {
    const c = this.#cursor
    level === HANDLE_HELD ? c.held.add(id) : c.held.delete(id)
    level === HANDLE_OVER ? c.over.add(id) : c.over.delete(id)
    this.#paintCursor()
  }

  // Recalcula los dos gates del encabezado. La llaman el motor, cuando cambia la demanda (alta/baja de un
  // handler de click/hover), y el setter del cursor.
  syncHoverDemand() {
    const ids      = this.#registry.layerIds()
    const h        = this.#hover
    h.pickChannels = this.#cursor.consumer ? EVENT_HOVER : PICK_CHANNELS
    h.hoverDemand  = ids.some(id => this.#registry.demandMaskOf(id) & EVENT_HOVER)
    h.pickDemand   = ids.some(id => this.#registry.demandMaskOf(id) & h.pickChannels)
    if (!h.pickDemand) this.#endHover()
  }

  // Un participante de la pulsación, en su lugar del orden declarado. Devuelve con qué sacarlo: una
  // pulsación suya en curso se queda sin dueño, y sigue sin click.
  join(participant, zIndex, order) {
    const entry = { participant, zIndex, order }
    const list  = this.#participants
    const at    = list.findIndex(other => topFirst(entry, other) < 0)
    list.splice(at < 0 ? list.length : at, 0, entry)
    return () => {
      const i = list.indexOf(entry)
      i >= 0 && list.splice(i, 1)
      this.#press.owner === participant && (this.#press.owner = null)
    }
  }

  // Devuelve el cursor que escribió: un motor nuevo sobre el mismo contenedor arranca de ''. Las
  // entradas quedan en cero para que el aviso tardío de un editor que se destruye después no lo repinte.
  destroy() {
    const c = this.#cursor
    this.#cancelRaf()
    this.#offs.forEach(off => off())
    this.#offs = []
    this.#hover.session = null
    c.held.clear()
    c.over.clear()
    c.consumer = ''
    c.dragging = c.hit = false
    this.#paintCursor()
  }

  /* ── Cableado ── */

  // La pulsación y el doble click se oyen en captura, antes que el anfitrión: lo que toma un participante
  // se le saca a él. El resto, en burbuja y pasivo.
  #wire() {
    this.#onDom('pointerenter', () => { this.#pointer.inside = true; this.#frame.stale = true })
    this.#onDom('pointerdown', e => this.#onPointerDown(e), CAPTURE)
    this.#onDom('pointermove', e => this.#onPointerMove(e))
    this.#onDom('pointerup', e => this.#onPointerUp(e), CAPTURE)
    this.#onDom('pointercancel', e => this.#onPointerUp(e), CAPTURE)
    this.#onDom('pointerleave', () => this.#onPointerLeave())
    this.#onDom('dblclick', e => this.#onDblClick(e), CAPTURE)
    // secondary-click va por el evento crudo del contenedor, no por el 'contextmenu' que reconoce
    // Leaflet: con un listener Leaflet el mapa ejecuta preventDefault en TODO click derecho
    // (haya o no feature debajo), matando el menú nativo del browser incondicionalmente. Con el
    // evento crudo el default queda intacto y decide el consumidor. No-passive: el consumidor
    // puede llamar preventDefault() sobre el evento entregado.
    this.#onDom('contextmenu', e => this.#onSecondaryClick(e), { passive: false })
    this.#onView('movestart', () => this.#beginInteraction())
    // El arrastre del USUARIO, no `movestart`: ése también lo dispara un flyTo, que no es un agarre. La
    // pulsación que arrastra el mapa ya no es un click.
    this.#offs.push(this.#input.onDrag(dragging => {
      this.#press.click &&= !dragging
      this.#cursor.dragging = dragging
      this.#paintCursor()
    }))
    this.#onView('resize', () => { this.#frame.stale = true })
    this.#onView('zoomstart', () => this.#beginInteraction())
    this.#onView('moveend', () => this.#endInteraction())
    this.#onView('zoomend', () => { this.#pickLayers().forEach(({ layer }) => layer.syncPickingSize()); this.#endInteraction() })
  }

  #onDom(type, fn, options = PASSIVE) {
    this.#input.on(type, fn, options)
    this.#offs.push(() => this.#input.off(type, fn, options))
  }
  #onView(type, fn) { this.#offs.push(this.#hostCamera.on(type, fn)) }

  /* ── Puntero ── */

  // El píxel del contenedor donde cayó el evento, descontados la escala CSS y el borde: el mismo que
  // proyecta la cámara. La escala sale como la da Leaflet, 1 si el contenedor no mide.
  #updatePointer(event) {
    const f = this.#frame
    const c = this.#container
    if (f.stale) {
      const rect = c.getBoundingClientRect()
      f.stale   = false
      f.left    = rect.left
      f.top     = rect.top
      f.scaleX  = rect.width / c.offsetWidth || 1
      f.scaleY  = rect.height / c.offsetHeight || 1
      f.borderX = c.clientLeft
      f.borderY = c.clientTop
    }
    const p = this.#pointer
    p.inside = true
    p.x      = (event.clientX - f.left) / f.scaleX - f.borderX
    p.y      = (event.clientY - f.top) / f.scaleY - f.borderY
    return p
  }

  // La muestra del puntero, `{ lat, lng, x, y }`: un píxel del contenedor y la posición que la cámara le
  // da. Es la misma que reciben los resolvers de cada capa, los canales `pointer:move` y `hover*` del bus
  // y el `cristae:pointermove` del elemento. Una por evento y congelada: la comparten los handlers y el
  // picking del mismo evento, y su identidad ata el pick de hover de una capa a la muestra que lo pidió.
  #sampleOf(point) {
    const { lat, lng } = this.#camera.containerPointToLatLng(point)
    return Object.freeze({ lat, lng, x: point.x, y: point.y })
  }

  // El dueño de la pulsación en `sample`: el primer participante que reconoce el píxel, salvo que el hit
  // de click de una capa quede por encima de él. Los hits sólo se resuelven si alguno lo reconoció. `dedo` es
  // una pulsación de dedo o de lápiz, que no pasan por el píxel antes de apoyarse.
  #ownerAt(sample, dedo = false) {
    const entry = this.#participants.find(({ participant }) => participant.handleAt(sample.x, sample.y, dedo))
    const top   = entry && this.#registry.resolveHits('click', sample)[0]
    return !entry || top && topFirst(top, entry) < 0 ? null : entry.participant
  }

  // Sólo abre una pulsación el puntero que baja sin otro apoyado. El que se suma no toma un handle ni es un
  // click, aunque el que se sumó antes ya se haya levantado: la pulsación de un participante sigue con su
  // puntero, y la del mapa se vuelve un gesto de varios dedos y se suelta sin click. El primario
  // (`isPrimary`) baja sin otro de su tipo, así que la cuenta vuelve a uno: descuenta al que se soltó fuera
  // del contenedor sin avisar, y la pulsación que ése dejó abierta se reinicia. Lo que cae fuera de la
  // superficie —la UI del anfitrión— no es una pulsación del mapa. La del participante le toma el puntero
  // hasta que se levante.
  #onPointerDown(event) {
    const p = this.#press
    p.down = event.isPrimary ? 1 : p.down + 1
    if (p.down > 1) {
      p.owner || (p.pointer = -1)
      p.click = false
      return
    }
    p.pointer = -1
    p.owner   = null
    if (!this.#input.onSurface(event.target)) return

    this.#frame.stale = true
    const point = this.#updatePointer(event)
    p.pointer = event.pointerId
    p.x       = point.x
    p.y       = point.y
    const dedo = event.pointerType === 'touch' || event.pointerType === 'pen'
    p.owner   = event.button ? null : this.#ownerAt(this.#sampleOf(point), dedo)
    p.click   = !event.button && !p.owner
    if (!p.owner) return

    consume(event)
    this.#container.setPointerCapture(event.pointerId)
    p.owner.down(point.x, point.y, dedo)
  }

  // Sin pulsación de un participante, cada muestra es hover para todos.
  #onPointerMove(event) {
    const point = this.#updatePointer(event)
    const p     = this.#press
    const mine  = event.pointerId === p.pointer
    p.click &&= !mine || quiet(point, p)
    if (p.owner) mine && p.owner.move(point.x, point.y)
    else for (const { participant } of this.#participants) participant.move(point.x, point.y)

    const sample = this.#sampleOf(point)
    this.#bus.dispatch('pointer:move', null, sample)            // crudo: coordenadas, sin picking

    const h = this.#hover
    if (!h.pickDemand || this.#interacting) return
    h.dirty = true
    if (h.session) return                                      // latest-only: la sesión activa relee al cerrar

    if (now() - h.lastAt < this.#throttleMs) return
    this.#startHover(sample)
  }

  // La pulsación termina con el `pointerup` o el `pointercancel` de su puntero, y su dueño recibe cuál fue
  // en el tercer argumento de `up`. La del mapa que se suelta quieta es un click: sale con el `pointerup`,
  // que es su evento del DOM, a los hits del registro —o como click en el vacío— y a cada participante. El
  // `click` del DOM no se mira.
  #onPointerUp(event) {
    const p = this.#press
    p.down && p.down--
    if (event.pointerId !== p.pointer) return

    const point = this.#updatePointer(event)
    const owner = p.owner
    const click = p.click && event.type === 'pointerup' && quiet(point, p)
    p.pointer = -1
    p.owner   = null
    p.click   = false
    if (owner) {
      consume(event)
      return owner.up(point.x, point.y, event.type === 'pointercancel')
    }
    if (!click) return

    const sample = this.#sampleOf(point)
    const hits   = this.#registry.resolveHits('click', sample)
    this.#bus.dispatch('click', hits, event)
    // Click en ESPACIO VACÍO (ningún hit en ninguna capa): entrega la coordenada cruda. Es la
    // captura de latlng para colocar un punto / editar geometría — el consumidor la cablea con el
    // callback inyectado. Cuando SÍ hay hit, el click ya se enrutó por el bus y esto no corre.
    hits.length || this.#onEmptyClick?.({ lat: sample.lat, lng: sample.lng })
    for (const { participant } of this.#participants) participant.click(sample)
  }

  // El doble click es del dueño del píxel, por el mismo orden que la pulsación, y los demás lo reciben
  // como del mapa. El que algún participante consume no hace zoom.
  #onDblClick(event) {
    if (!this.#input.onSurface(event.target)) return
    const sample   = this.#sampleOf(this.#updatePointer(event))
    const owner    = this.#ownerAt(sample)
    const consumed = this.#participants.reduce(
      (done, { participant }) => participant.dblclick(sample, participant === owner) || done, false)
    consumed && this.#input.suppressDoubleClickZoom(event)
  }

  #onPointerLeave() {
    for (const { participant } of this.#participants) participant.leave()
    this.#pointer.inside = false
    this.#endHover()
    this.#bus.dispatch('hover:out', null, null)
  }

  // Click contextual (botón secundario / long-press / tecla Menú), desde el MouseEvent del DOM. El
  // pick es el MISMO camino síncrono que el click primario (`resolveHits('secondary-click')` →
  // `resolveClick`). El menú nativo del browser queda INTACTO por default: lo suprime el
  // consumidor con `event.preventDefault()` sólo cuando resolvió un hit propio.
  #onSecondaryClick(event) {
    const sample = this.#sampleOf(this.#updatePointer(event))
    this.#bus.dispatch('secondary-click', this.#registry.resolveHits('secondary-click', sample), event)
  }

  /* ── Sesión de hover (picking GPU no bloqueante) ── */

  #startHover(sample) {
    const h = this.#hover
    h.dirty  = false
    h.lastAt = now()

    // Se pickean las capas visibles con demanda de `pickChannels` (los EVENTOS de hover sólo salen con
    // demanda de HOVER — ver #emitHover).
    const active = this.#pickLayers().filter(({ layerId }) =>
      this.#registry.isLayerVisible(layerId) && (this.#registry.demandMaskOf(layerId) & h.pickChannels))

    const queued = active.filter(({ layer }) => layer.requestHoverHit(sample))
    if (!queued.length) return this.#emitHover(sample)         // nada que pickear → resolver inline

    h.session = {
      sample,
      generation: ++h.generation,
      layers    : queued.map(({ layerId, layer }) => ({ layerId, layer, done: false })),
    }
    this.#scheduleTick()
  }

  #scheduleTick() {
    const h = this.#hover
    h.rafId ??= raf(() => { h.rafId = null; this.#tick() })
  }

  #tick() {
    const h = this.#hover
    const session = h.session
    if (!session) return
    if (this.#interacting) return this.#scheduleTick()         // diferir hover mientras dura el gesto

    // Cada capa se recoge UNA vez (collect limpia el pending; recogerla de nuevo daría null).
    let allDone = true
    session.layers.forEach(entry => {
      if (entry.done) return
      if (entry.layer.collectHoverHit() != null) entry.done = true
      else allDone = false
    })
    if (!allDone) return this.#scheduleTick()                  // aún falta algún readback del GPU

    h.session = null
    this.#emitHover(session.sample)
    if (h.dirty) this.#startHover(this.#sampleOf(this.#pointer))   // relee la última muestra
  }

  #emitHover(sample) {
    const c = this.#cursor
    // EVENTOS de hover: solo si hay demanda del canal HOVER (resolveHits('hover') ya filtra por él,
    // así que para una capa solo-click esto no dispara nada espurio).
    if (this.#hover.hoverDemand) this.#bus.dispatch('hover', this.#registry.resolveHits('hover', sample), sample)
    // `hit` alimenta la fila `pointer` del árbitro: una feature de una capa con demanda de click u hover
    // (no hace falta escuchar 'hover'). Con cursor del consumidor no se consulta (ver encabezado).
    c.hit = !c.consumer && this.#registry.hasHitForChannels(PICK_CHANNELS, sample)
    this.#paintCursor()
  }

  // Cerrar la sesión (leave / zoom-pan / demanda a cero) suelta el `pointer`.
  #endHover() {
    const h = this.#hover
    this.#cancelRaf()
    h.session = null
    h.generation++
    this.#pickLayers().forEach(({ layer }) => layer.cancelHoverHit())
    this.#cursor.hit = false
    this.#paintCursor()
  }

  /* ── Supresión durante zoom/pan ── */

  #beginInteraction() {
    if (this.#interacting) return
    this.#interacting = true
    this.#endHover()
    this.#bus.dispatch('hover:out', null, null)
    this.#onInteractionStart?.()
  }

  #endInteraction() {
    if (!this.#interacting) return
    this.#interacting = false
    this.#onInteractionEnd?.()
  }

  /* ── Cursor del contenedor ── */

  // La precedencia es el orden de la expresión (la tabla, en docs/interaction.md). El arrastre se escribe
  // explícito porque Leaflet lo marca en `document.body`, fuera del alcance del CSS del shadow root.
  // [0-alloc]: corre por muestra resuelta del hover.
  #paintCursor() {
    const c     = this.#cursor
    const value = c.dragging || c.held.size ? 'grabbing'
      : c.over.size ? 'grab'
      : c.consumer || (c.hit ? 'pointer' : '')
    if (value === c.written) return
    c.written = this.#container.style.cursor = value
  }

  #cancelRaf() {
    const h = this.#hover
    if (h.rafId != null) { cancelRaf(h.rafId); h.rafId = null }
  }
}
