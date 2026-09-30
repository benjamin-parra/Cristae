import { EVENT_HOVER, HANDLE_HELD, HANDLE_OVER, PICK_CHANNELS } from '../events/events.js'

// Interaction — traduce los eventos del puntero del L.map en hits ruteados por el EventBus.
// Cablea tres cosas y nada más: (1) pointer/click del DOM → registry.resolveHits → bus.dispatch;
// (2) la sesión de hover con picking GPU no bloqueante (request → poll rAF → collect); (3) la
// supresión de hover durante zoom/pan y el cursor del contenedor, del que es el ÚNICO escritor. No
// conoce capas ni dominio: pide los hits al registro y los puntos pickeables al motor.
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

export class Interaction {

  #map
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
  #pointer       = { inside: false, x: 0, y: 0 }
  #containerRect = null

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

  #domHandlers = new Map()
  #mapHandlers = new Map()

  constructor({ map, camera, registry, bus, container, pickLayers, hoverThrottleMs = 0, cursor, onInteractionStart, onInteractionEnd, onEmptyClick } = {}) {
    this.#map                = map
    this.#camera             = camera
    this.#registry           = registry
    this.#bus                = bus
    this.#container          = container ?? map.getContainer()
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

  // Devuelve el cursor que escribió: un motor nuevo sobre el mismo contenedor arranca de ''. Las
  // entradas quedan en cero para que el aviso tardío de un editor que se destruye después no lo repinte.
  destroy() {
    const c = this.#cursor
    this.#cancelRaf()
    this.#domHandlers.forEach((fn, type) => this.#container.removeEventListener(type, fn))
    this.#mapHandlers.forEach((fn, type) => this.#map.off(type, fn))
    this.#domHandlers.clear()
    this.#mapHandlers.clear()
    this.#hover.session = null
    c.held.clear()
    c.over.clear()
    c.consumer = ''
    c.dragging = c.hit = false
    this.#paintCursor()
  }

  /* ── Cableado ── */

  #wire() {
    this.#onDom('pointerenter', () => { this.#pointer.inside = true; this.#syncRect(); this.#syncDragging() })
    this.#onDom('pointermove', e => this.#onPointerMove(e))
    this.#onDom('pointerleave', () => this.#onPointerLeave())
    this.#onDom('pointerup', () => this.#syncDragging())

    this.#onMap('click', e => this.#onClick(e))
    // secondary-click va por listener DOM del CONTENEDOR, no por el evento 'contextmenu' de
    // Leaflet: con un listener Leaflet el mapa ejecuta preventDefault en TODO click derecho
    // (haya o no feature debajo), matando el menú nativo del browser incondicionalmente. Con el
    // listener DOM el default queda intacto y decide el consumidor. No-passive: el consumidor
    // puede llamar preventDefault() sobre el evento entregado.
    this.#onDom('contextmenu', e => this.#onSecondaryClick(e), { passive: false })
    this.#onMap('movestart', () => this.#beginInteraction())
    // El arrastre del USUARIO, no `movestart`: ése también lo dispara un flyTo, que no es un agarre.
    this.#onMap('dragstart', () => { this.#cursor.dragging = true; this.#paintCursor() })
    this.#onMap('dragend', () => this.#syncDragging())
    this.#onMap('zoomstart', () => this.#beginInteraction())
    this.#onMap('moveend', () => { this.#endInteraction(); this.#syncDragging() })
    this.#onMap('zoomend', () => { this.#pickLayers().forEach(({ layer }) => layer.syncPickingSize()); this.#endInteraction() })
  }

  #onDom(type, fn, options = { passive: true }) { this.#container.addEventListener(type, fn, options); this.#domHandlers.set(type, fn) }
  #onMap(type, fn) { this.#map.on(type, fn); this.#mapHandlers.set(type, fn) }

  /* ── Puntero ── */

  #syncRect() { this.#containerRect = this.#container.getBoundingClientRect() }

  #updatePointer(event) {
    const rect = this.#containerRect ??= this.#container.getBoundingClientRect()
    const p = this.#pointer
    p.inside = true
    p.x      = event.clientX - rect.left
    p.y      = event.clientY - rect.top
    return p
  }

  // La muestra del puntero, `{ lat, lng, x, y }`: un píxel del contenedor y su posición, que la cámara
  // proyecta si no llega. Es la misma que reciben los resolvers de cada capa, los canales `pointer:move`
  // y `hover*` del bus y el `cristae:pointermove` del elemento. Una por evento y congelada: la comparten
  // los handlers y el picking del mismo evento, y su identidad ata el pick de hover de una capa a la
  // muestra que lo pidió.
  #sampleOf(point, { lat, lng } = this.#camera.containerPointToLatLng(point)) {
    return Object.freeze({ lat, lng, x: point.x, y: point.y })
  }

  #onPointerMove(event) {
    const sample = this.#sampleOf(this.#updatePointer(event))
    this.#bus.dispatch('pointer:move', null, sample)            // crudo: coordenadas, sin picking

    const h = this.#hover
    if (!h.pickDemand || this.#interacting) return
    h.dirty = true
    if (h.session) return                                      // latest-only: la sesión activa relee al cerrar

    if (now() - h.lastAt < this.#throttleMs) return
    this.#startHover(sample)
  }

  #onPointerLeave() {
    this.#pointer.inside = false
    this.#endHover()
    this.#bus.dispatch('hover:out', null, null)
  }

  // El bus entrega el evento del DOM, nunca el de Leaflet: un click que no lo trae —uno disparado por
  // código— sale con `null`. La muestra toma la posición del click y su píxel; el que se dispara con sólo
  // `latlng` no trae píxel, y lo proyecta la cámara.
  #onClick(event) {
    const { latlng } = event
    const sample     = this.#sampleOf(event.containerPoint ?? this.#camera.latLngToContainerPoint(latlng), latlng)
    const hits       = this.#registry.resolveHits('click', sample)
    this.#bus.dispatch('click', hits, event.originalEvent ?? null)
    // Click en ESPACIO VACÍO (ningún hit en ninguna capa): entrega la coordenada cruda. Es la
    // captura de latlng para colocar un punto / editar geometría — el consumidor la cablea con el
    // callback inyectado. Cuando SÍ hay hit, el click ya se enrutó por el bus y esto no corre.
    hits.length || this.#onEmptyClick?.({ lat: sample.lat, lng: sample.lng })
  }

  // Click contextual (botón secundario / long-press / tecla Menú), desde el MouseEvent del DOM. El
  // pick es el MISMO camino síncrono que el click primario (`resolveHits('secondary-click')` →
  // `resolveClick`). El menú nativo del browser queda INTACTO por default: lo suprime el
  // consumidor con `event.preventDefault()` sólo cuando resolvió un hit propio.
  #onSecondaryClick(event) {
    const sample = this.#sampleOf(this.#map.mouseEventToContainerPoint(event))
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

  // El arrastre lo prende `dragstart`, cuando Leaflet todavía no lo marca en curso, y lo apaga releer ese
  // estado. Un segundo dedo o un segundo botón lo cortan sin `dragend`, así que se relee también en lo que
  // siempre les sigue: el `moveend` del pinch, y el `pointerup` del último botón o, si se soltó fuera del
  // mapa, el `pointerenter` de la vuelta.
  #syncDragging() {
    this.#cursor.dragging = !!this.#map.dragging?.moving()
    this.#paintCursor()
  }

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
