import { LitElement, html, css, unsafeCSS } from 'lit'
import L from 'leaflet'
import { leafletCss } from './leafletCss.js'
import { MapEngine } from '../engine/MapEngine.js'

// glify es un plugin que se registra sobre window.L → aseguramos la instancia y lo importamos
// por efecto (una sola vez). El motor recibe glify inyectado (sin global oculto en el core).
if (typeof window !== 'undefined' && !window.L) window.L = L
const glifyReady = (typeof window !== 'undefined')
  ? import('leaflet.glify').then(() => window.L.glify)
  : Promise.resolve(null)

// <cristae-map> — piel fina sobre MapEngine (SPECS §7). Monta el motor en el shadow DOM, expone
// la cámara y los métodos del motor, y reenvía los eventos del motor como CustomEvent `cristae:*`.
// Las capas hijas (light DOM) se montan top-down cuando el motor está listo.

// Eventos cristae:* puenteados BAJO DEMANDA: el canal del motor se suscribe solo mientras haya >=1
// listener DOM de ese tipo. Son los de alta frecuencia y/o con coste de picking — sobre todo `hover`,
// que de suscribirse siempre forzaría picking GPU en cada pointermove aunque nadie escuche hover
// (anulando el demand-counting del EventBus). El resto (ready/viewportchange/interaction*) son
// baratos y de baja frecuencia → se cablean siempre en #wireEvents.
const ON_DEMAND_EVENTS = new Set(['cristae:click', 'cristae:hover', 'cristae:pointermove'])

export class CristaeMap extends LitElement {

  static properties = {
    tile: { type: Object },
    worldCopies: { type: Boolean, attribute: 'world-copies' },
    noZoomControl: { type: Boolean, attribute: 'no-zoom-control' },
    viewportInsets: { type: Object, attribute: 'viewport-insets' },
    hoverThrottle: { type: Number, attribute: 'hover-throttle' },
    initialCenter: { attribute: 'initial-center' },
    initialZoom: { type: Number, attribute: 'initial-zoom' },
    zoomAnimation: { type: String, attribute: 'zoom-animation' },
  }

  // Leaflet posiciona tiles/panes con su CSS (.leaflet-tile{position:absolute}, z-index de panes,
  // clases de zoom-anim). En shadow DOM el CSS global NO cruza el borde → hay que inyectarlo acá,
  // o los tiles caen a flujo normal (sueltos/apilados) y los transforms inline los mandan fuera.
  static styles = [
    unsafeCSS(leafletCss),
    css`
      /* isolation:isolate crea un stacking context en el host: confina el z-index interno
         (panes de Leaflet 200-700, controles 800-1000, overlays) para que el mapa NO se
         pinte por encima de modales/drawers de la página. Sin esto, esos z-index compiten
         en el contexto raíz y tapan UI superpuesta. position:relative solo no alcanza. */
      :host { display: block; position: relative; isolation: isolate; width: 100%; height: 100%; }
      #map { width: 100%; height: 100%; }
      /* Overlay de 9 zonas (4 esquinas + 4 lados + centro) como grilla 3×3 sobre el mapa. Cada
         zona es un slot nombrado que apila (flex) uno o más hijos alineados a su anclaje. El
         contenedor no captura el puntero (deja pasar drag/zoom); cada hijo sloteado lo reactiva.
         La orientación de cada overlay la decide el componente que se coloca, no su zona. */
      .overlays {
        position: absolute; inset: 0; pointer-events: none; z-index: 1000;
        display: grid;
        grid-template-columns: 1fr 1fr 1fr;
        grid-template-rows: 1fr 1fr 1fr;
        padding: 12px; gap: 8px;
      }
      .zone { display: flex; flex-direction: column; gap: 12px; min-width: 0; min-height: 0; }
      .tl { align-items: flex-start; justify-content: flex-start; }
      .tc { align-items: center;     justify-content: flex-start; }
      .tr { align-items: flex-end;   justify-content: flex-start; }
      .cl { align-items: flex-start; justify-content: center; }
      .cc { align-items: center;     justify-content: center; }
      .cr { align-items: flex-end;   justify-content: center; }
      .bl { align-items: flex-start; justify-content: flex-end; }
      .bc { align-items: center;     justify-content: flex-end; }
      .br { align-items: flex-end;   justify-content: flex-end; }
      ::slotted(*) { pointer-events: auto; }
      /* Leaflet solo aplica user-select:none a tiles/markers, no a los controles → el +/− del
         zoom queda seleccionable como texto. Lo evitamos en la barra de controles. */
      .leaflet-bar a { user-select: none; -webkit-user-select: none; }
    `,
  ]

  #engine = null
  #pending = []
  #mounted = false
  #everMounted = false
  #resizeObserver = null
  #resolveReady
  // Puenteo bajo demanda: nro de listeners DOM por tipo cristae:* (persiste entre reconexiones, porque
  // las registraciones de addEventListener sobreviven al detach) y el unsub del motor activo por tipo
  // (presente solo si hay listeners Y el motor está montado; se descarta al desmontar y se re-cabla).
  #demandCount = new Map()
  #demandUnsub = new Map()
  // Creada en construcción → `map.ready` está disponible SÍNCRONO apenas existe el elemento (antes
  // se asignaba dentro de #mount tras un await, así que era undefined al instante). Se resuelve una
  // sola vez, cuando el motor queda listo.
  ready = new Promise(resolve => { this.#resolveReady = resolve })

  render() {
    return html`
      <div id="map"></div>
      <div class="overlays">
        <div class="zone tl"><slot name="top-left"></slot></div>
        <div class="zone tc"><slot name="top-center"></slot></div>
        <div class="zone tr"><slot name="top-right"></slot></div>
        <div class="zone cl"><slot name="center-left"></slot></div>
        <div class="zone cc"><slot name="center"></slot></div>
        <div class="zone cr"><slot name="center-right"></slot></div>
        <div class="zone bl"><slot name="bottom-left"></slot></div>
        <div class="zone bc"><slot name="bottom-center"></slot></div>
        <div class="zone br"><slot name="bottom-right"></slot></div>
      </div>
    `
  }

  // Reconexión tras un disconnect: el renderRoot ya existe (Lit lo conserva) y firstUpdated NO vuelve
  // a dispararse → re-montamos el motor acá. En la PRIMERA conexión no hacemos nada (aún no hay div
  // #map en el shadow → monta firstUpdated). Las capas hijas se re-encolan solas: su connectedCallback
  // vuelve a llamar requestMount y, como #mount es async, llegan a #pending antes de que exista el motor.
  // Por esto el consumidor NO debe cachear engine/camera: tras un reattach son OTRA instancia → usar
  // siempre los getters vivos `map.engine`/`map.camera`.
  connectedCallback() {
    super.connectedCallback()
    if (this.#everMounted && !this.#engine) this.#mount()
  }

  firstUpdated() { this.#mount() }

  disconnectedCallback() {
    super.disconnectedCallback()
    this.#resizeObserver?.disconnect()
    this.#engine?.destroy()
    this.#engine = null
    this.#mounted = false
    this.#demandUnsub.clear()   // los unsub apuntan al bus del motor destruido; los counts DOM persisten para re-cablear
  }

  // Puenteo bajo demanda (ver ON_DEMAND_EVENTS): suscribimos el canal del motor recién cuando aparece
  // el primer listener DOM y lo damos de baja al irse el último. Así `addEventListener('cristae:hover')`
  // es lo único que enciende el picking de hover; sin oyentes, el motor no resuelve hover por move.
  // (Conteo simple: asume listeners distintos — un doble-add idéntico solo mantiene la suscripción de
  // más, nunca de menos, así que es seguro.)
  addEventListener(type, listener, options) {
    super.addEventListener(type, listener, options)
    if (!ON_DEMAND_EVENTS.has(type)) return
    const next = (this.#demandCount.get(type) ?? 0) + 1
    this.#demandCount.set(type, next)
    if (next === 1 && this.#engine && !this.#demandUnsub.has(type))
      this.#demandUnsub.set(type, this.#subscribeEngine(type))
  }

  removeEventListener(type, listener, options) {
    super.removeEventListener(type, listener, options)
    if (!ON_DEMAND_EVENTS.has(type)) return
    const next = (this.#demandCount.get(type) ?? 0) - 1
    if (next > 0) { this.#demandCount.set(type, next); return }
    this.#demandCount.delete(type)
    this.#demandUnsub.get(type)?.()
    this.#demandUnsub.delete(type)
  }

  get engine() { return this.#engine }
  get camera() { return this.#engine?.camera }
  on(...args) { return this.#engine.on(...args) }
  getLayer(id) { return this.#engine?.getLayer(id) }
  invalidateCanvas() { this.#engine?.invalidateCanvas() }

  // Las capas hijas piden montaje al conectarse; si el motor aún no existe, se encola.
  requestMount(el) {
    if (this.#engine) el.cristaeMount(this.#engine)
    else this.#pending.push(el)
  }

  async #mount() {
    if (this.#mounted) return
    this.#mounted = true
    this.#everMounted = true
    const glify = await glifyReady
    const container = this.renderRoot.querySelector('#map')

    this.#engine = new MapEngine({
      leaflet: L,
      glify,
      container,
      mapOptions: { center: this.#center(), zoom: this.initialZoom ?? 2 },
      insets: this.viewportInsets,
      hoverThrottleMs: this.hoverThrottle ?? 0,
      zoomAnimation: this.zoomAnimation ?? 'none',
      zoomControl: !this.noZoomControl,
    })
    if (this.tile) this.#engine.setTileProvider({ noWrap: !this.worldCopies, ...this.tile })

    this.#wireEvents()
    this.#pending.forEach(el => el.cristaeMount(this.#engine))
    this.#pending = []

    // Por la promesa, no por el signal: el motor emite 'ready' síncrono al construir (mapa con
    // center+zoom queda _loaded), antes de que #wireEvents suscriba. Un .then siempre llega.
    // Resuelve `this.ready` (creada en construcción) una sola vez; en re-montajes ya está resuelta.
    this.#engine.ready.then(() => {
      this.#emit('ready', {})
      this.#resolveReady?.(this.#engine)
      this.#resolveReady = null
    })

    this.#resizeObserver = new ResizeObserver(() => this.#engine?.syncSize())
    this.#resizeObserver.observe(this)
  }

  #wireEvents() {
    const e = this.#engine
    // Siempre activos: baja frecuencia, sin coste de picking.
    e.on('viewportchange', (d) => this.#emit('viewportchange', d))
    e.on('interactionstart', () => this.#emit('interactionstart', {}))
    e.on('interactionend', () => this.#emit('interactionend', {}))
    // Bajo demanda: re-cablear los tipos que ya tienen listeners DOM (agregados antes de montar, o
    // tras un re-mount). Los listeners futuros los cabla addEventListener.
    this.#demandCount.forEach((count, type) => {
      if (count > 0 && !this.#demandUnsub.has(type)) this.#demandUnsub.set(type, this.#subscribeEngine(type))
    })
    // 'ready' se entrega por la promesa en #mount (el signal del motor ya se disparó al construir).
  }

  // Suscribe el canal del motor para un tipo cristae:* bajo demanda y devuelve su unsub. Llamado solo
  // con el motor montado (desde addEventListener o #wireEvents). Suscribir `hover` acá —y no en el
  // montaje— es lo que mantiene el demand-counting del EventBus efectivo: sin listener, sin picking.
  #subscribeEngine(type) {
    const e = this.#engine
    if (type === 'cristae:click')       return e.on('click', (hits, ev) => this.#emit('click', { hits, originalEvent: ev }))
    if (type === 'cristae:hover')       return e.on('hover', (hits) => this.#emit('hover', { hits }))
    if (type === 'cristae:pointermove') return e.on('pointer:move', (_, s) => this.#emit('pointermove', s && { lat: s.latlng?.lat, lng: s.latlng?.lng, x: s.containerPoint?.x, y: s.containerPoint?.y }))
    return null
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(`cristae:${type}`, { detail, bubbles: true, composed: true }))
  }

  #center() {
    const c = this.initialCenter
    if (Array.isArray(c)) return c
    if (typeof c === 'string' && c.includes(',')) return c.split(',').map(Number)
    return [0, 0]
  }
}
