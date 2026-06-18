import { EVENT_HOVER, PICK_CHANNELS } from '../events/events.js'

// Interaction — traduce los eventos del puntero del L.map en hits ruteados por el EventBus.
// Cablea tres cosas y nada más: (1) pointer/click del DOM → registry.resolveHits → bus.dispatch;
// (2) la sesión de hover con picking GPU no bloqueante (request → poll rAF → collect); (3) la
// supresión de hover durante zoom/pan y el cursor automático. No conoce capas ni dominio: pide
// los hits al registro y los puntos pickeables al motor.
//
// Picking dirigido por demanda, con DOS motivos para correr la sesión de hover (ver PICK_CHANNELS):
//   · entregar EVENTOS de hover  → demanda del canal HOVER  (`#hoverDemand`);
//   · CURSOR de affordance       → demanda de CLICK *o* HOVER (`#pickDemand`).
// El cursor `pointer` es una affordance de la INTERACTIVIDAD, no del canal de hover: una capa
// clickeable debe marcar el puntero al pasar sobre sus features —como `.leaflet-interactive` en
// Leaflet, y como promete SPECS §eventos ("cursor automático … capa interactive")— aunque el
// consumidor NO escuche `cristae:hover`. Por eso la sesión de hover (que es lo que sabe si el
// puntero cae sobre una feature) se corre también bajo demanda de CLICK, pero los EVENTOS de hover
// se emiten solo si hay demanda de HOVER. Si ningún canal interactivo tiene demanda, la sesión no
// se inicia (el picking correría en cada pointermove — lo más frecuente — y es caro). El cursor se
// restaura al salir del contenedor, durante zoom/pan, y al caer la demanda interactiva a cero.

const noRaf = (cb) => setTimeout(cb, 0)
const hasRaf = typeof requestAnimationFrame === 'function'
const raf = hasRaf ? requestAnimationFrame : noRaf
const cancelRaf = hasRaf ? cancelAnimationFrame : clearTimeout
const now = () => performance.now()

export class Interaction {

  #map
  #registry
  #bus
  #container
  #pickLayers
  #throttleMs
  #onInteractionStart
  #onInteractionEnd

  // Estado del puntero (muta-y-reusa salvo seq). seq distingue muestras para validar el cache.
  #pointer = { seq: 0, clientX: 0, clientY: 0, containerPoint: { x: 0, y: 0 } }
  #containerRect = null

  #hoverDemand = false          // demanda del canal HOVER → emitir eventos de hover
  #pickDemand = false           // demanda de CLICK u HOVER → correr el picking (para el cursor)
  #interacting = false
  #hoverDirty = false
  #hoverLastAt = -Infinity
  #session = null
  #generation = 0
  #rafId = null
  #cursorOn = false

  #domHandlers = new Map()
  #mapHandlers = new Map()

  constructor({ map, registry, bus, container, pickLayers, hoverThrottleMs = 0, onInteractionStart, onInteractionEnd } = {}) {
    this.#map = map
    this.#registry = registry
    this.#bus = bus
    this.#container = container ?? map.getContainer()
    this.#pickLayers = pickLayers ?? (() => [])
    this.#throttleMs = hoverThrottleMs
    this.#onInteractionStart = onInteractionStart
    this.#onInteractionEnd = onInteractionEnd
    this.#wire()
  }

  set hoverThrottleMs(ms) { this.#throttleMs = ms }

  // El motor la llama cuando cambia la demanda (alta/baja de un handler de click/hover). Recalcula
  // los dos gates: HOVER (emitir eventos) y CLICK|HOVER (correr el picking para el cursor).
  syncHoverDemand() {
    const ids = this.#registry.layerIds()
    this.#hoverDemand = ids.some(id => this.#registry.demandMaskOf(id) & EVENT_HOVER)
    this.#pickDemand = ids.some(id => this.#registry.demandMaskOf(id) & PICK_CHANNELS)
    if (!this.#pickDemand) this.#endHover()
  }

  destroy() {
    this.#cancelRaf()
    this.#domHandlers.forEach((fn, type) => this.#container.removeEventListener(type, fn))
    this.#mapHandlers.forEach((fn, type) => this.#map.off(type, fn))
    this.#domHandlers.clear()
    this.#mapHandlers.clear()
    this.#session = null
  }

  /* ── Cableado ── */

  #wire() {
    this.#onDom('pointerenter', () => this.#syncRect())
    this.#onDom('pointermove', (e) => this.#onPointerMove(e))
    this.#onDom('pointerleave', () => this.#onPointerLeave())

    this.#onMap('click', (e) => this.#onClick(e))
    this.#onMap('movestart', () => this.#beginInteraction())
    this.#onMap('zoomstart', () => this.#beginInteraction())
    this.#onMap('moveend', () => this.#endInteraction())
    this.#onMap('zoomend', () => { this.#pickLayers().forEach(({ layer }) => layer.syncPickingSize()); this.#endInteraction() })
  }

  #onDom(type, fn) { this.#container.addEventListener(type, fn, { passive: true }); this.#domHandlers.set(type, fn) }
  #onMap(type, fn) { this.#map.on(type, fn); this.#mapHandlers.set(type, fn) }

  /* ── Puntero ── */

  #syncRect() { this.#containerRect = this.#container.getBoundingClientRect() }

  #updatePointer(event) {
    const rect = this.#containerRect ?? (this.#containerRect = this.#container.getBoundingClientRect())
    const p = this.#pointer
    p.seq++
    p.clientX = event.clientX
    p.clientY = event.clientY
    p.containerPoint.x = event.clientX - rect.left
    p.containerPoint.y = event.clientY - rect.top
    return p
  }

  // La muestra para el picking/resolución: copia inmutable del puntero + latlng/layerPoint
  // (los necesita el HitResolver de capas Leaflet; el picking GPU solo usa containerPoint+seq).
  #sampleOf(p) {
    const cp = [p.containerPoint.x, p.containerPoint.y]
    return {
      seq: p.seq,
      containerPoint: { x: p.containerPoint.x, y: p.containerPoint.y },
      latlng: this.#map.containerPointToLatLng(cp),
      layerPoint: this.#map.containerPointToLayerPoint(cp),
    }
  }

  #onPointerMove(event) {
    const p = this.#updatePointer(event)
    const sample = this.#sampleOf(p)
    this.#bus.dispatch('pointer:move', null, sample)            // crudo: coordenadas, sin picking

    if (!this.#pickDemand || this.#interacting) return
    this.#hoverDirty = true
    if (this.#session) return                                  // latest-only: la sesión activa relee al cerrar

    if (now() - this.#hoverLastAt < this.#throttleMs) return
    this.#startHover(sample)
  }

  #onPointerLeave() {
    this.#endHover()
    this.#bus.dispatch('hover:out', null, null)
    this.#setCursor(false)
  }

  #onClick(event) {
    const hits = this.#registry.resolveHits('click', event)
    this.#bus.dispatch('click', hits, event.originalEvent ?? event)
  }

  /* ── Sesión de hover (picking GPU no bloqueante) ── */

  #startHover(sample) {
    this.#hoverDirty = false
    this.#hoverLastAt = now()

    // Se pickean las capas interactivas con demanda de CLICK u HOVER: las solo-click se pickean
    // para poder marcar el cursor (sus EVENTOS de hover no se emiten — ver #emitHover).
    const active = this.#pickLayers().filter(({ layerId }) =>
      this.#registry.isLayerVisible(layerId) && (this.#registry.demandMaskOf(layerId) & PICK_CHANNELS))

    const queued = active.filter(({ layer }) => layer.requestHoverHit(sample))
    if (!queued.length) return this.#emitHover(sample)         // nada que pickear → resolver inline

    this.#session = {
      sample,
      generation: ++this.#generation,
      layers: queued.map(({ layerId, layer }) => ({ layerId, layer, done: false })),
    }
    this.#scheduleTick()
  }

  #scheduleTick() {
    if (this.#rafId == null) this.#rafId = raf(() => { this.#rafId = null; this.#tick() })
  }

  #tick() {
    const session = this.#session
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

    this.#session = null
    this.#emitHover(session.sample)
    if (this.#hoverDirty) this.#startHover(this.#sampleOf(this.#pointer))   // relee la última muestra
  }

  #emitHover(sample) {
    // EVENTOS de hover: solo si hay demanda del canal HOVER (resolveHits('hover') ya filtra por él,
    // así que para una capa solo-click esto no dispara nada espurio).
    if (this.#hoverDemand) this.#bus.dispatch('hover', this.#registry.resolveHits('hover', sample), sample)
    // CURSOR de affordance: `pointer` si el puntero cae sobre una feature de una capa interactiva
    // con demanda de click u hover (no requiere escuchar 'hover'). Alinea la implementación con
    // SPECS §eventos: "cursor automático … capa interactive".
    this.#setCursor(this.#registry.hasHitForChannels(PICK_CHANNELS, sample))
  }

  #endHover() {
    this.#cancelRaf()
    this.#session = null
    this.#generation++
    this.#pickLayers().forEach(({ layer }) => layer.cancelHoverHit())
    this.#setCursor(false)   // cerrar la sesión (leave / zoom-pan / demanda a cero) restaura el cursor
  }

  /* ── Supresión durante zoom/pan ── */

  #beginInteraction() {
    if (this.#interacting) return
    this.#interacting = true
    this.#endHover()
    this.#bus.dispatch('hover:out', null, null)
    this.#setCursor(false)
    this.#onInteractionStart?.()
  }

  #endInteraction() {
    if (!this.#interacting) return
    this.#interacting = false
    this.#onInteractionEnd?.()
  }

  /* ── Cursor automático ── */

  #setCursor(on) {
    if (on === this.#cursorOn) return
    this.#cursorOn = on
    this.#container.style.cursor = on ? 'pointer' : ''
  }

  #cancelRaf() {
    if (this.#rafId != null) { cancelRaf(this.#rafId); this.#rafId = null }
  }
}
