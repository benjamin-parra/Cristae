import { LitElement, html, css, unsafeCSS, nothing } from 'lit'
import { unsafeHTML } from 'lit/directives/unsafe-html.js'
import L from 'leaflet'
import { surfaceCss } from '../host/styles.js'
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

// Los límites de la cámara, que viajan juntos al motor (SPECS §9).
const LIMITS = ['minZoom', 'maxZoom', 'maxBounds', 'maxBoundsViscosity']

// ¿Todas las capas de datos vacías? (predicado del estado "sin datos" del mapa). Vacío ⇔ hay al menos
// una capa de datos observable y NINGUNA tiene features. Sin capas de datos no hay estado vacío que
// anunciar (un mapa de sólo tiles no está "vacío de datos", y evita el flash mientras aún no montó
// ninguna capa). Puro y sin dominio: sólo lee el snapshot de cada Source. Exportado para test unitario.
export const dataLayersEmpty = layers =>
  layers.length > 0 && layers.every(el => !el.controls?.source?.getSnapshot()?.length)

// Agendador del resize del contenedor: coalesce (debounce trailing) la ráfaga del ResizeObserver a UN
// solo `sync` ~110ms tras asentarse el tamaño. El observer dispara por frame mientras el contenedor se
// anima (p.ej. abrir/cerrar un panel hermano que empuja el mapa), y cada syncSize() reproyecta TODAS las
// capas de puntos (invalidateSize + resetCanvases) — reproyectar por frame es caro con muchos puntos/
// polígonos. Re-agendar en cada notificación colapsa la ráfaga a una sola corrida ~110ms después; un
// resize aislado se aplica ~110ms más tarde (imperceptible, sin reflows intermedios). `dispose()` corta
// observer + timer juntos (eje 7: el estado del resize vive en el closure, no en campos sueltos del host).
function createResizeSync(target, sync) {
  let timer = null
  const observer = new ResizeObserver(() => {
    if (timer != null) clearTimeout(timer)
    timer = setTimeout(() => { timer = null; sync() }, 110)
  })
  observer.observe(target)
  return {
    dispose() {
      observer.disconnect()
      if (timer != null) { clearTimeout(timer); timer = null }
    },
  }
}

export class CristaeMap extends LitElement {

  static properties = {
    tile               : { type: Object },
    worldCopies        : { type: Boolean, attribute: 'world-copies' },
    noZoomControl      : { type: Boolean, attribute: 'no-zoom-control' },
    viewportInsets     : { type: Object, attribute: 'viewport-insets' },
    hoverThrottle      : { type: Number, attribute: 'hover-throttle' },
    initialCenter      : { attribute: 'initial-center' },
    initialZoom        : { type: Number, attribute: 'initial-zoom' },
    zoomAnimation      : { type: String, attribute: 'zoom-animation' },
    minZoom            : { type: Number, attribute: 'min-zoom' },
    maxZoom            : { type: Number, attribute: 'max-zoom' },
    maxBounds          : { type: Object, attribute: 'max-bounds' },
    maxBoundsViscosity : { type: Number, attribute: 'max-bounds-viscosity' },
    // Cursor del contenedor: cualquier valor CSS; vacío o inválido = ninguno
    // (docs/interaction.md#el-cursor-del-contenedor).
    cursor             : { type: String },
    // Mensaje del estado "sin datos": se muestra cuando todas las capas de datos están vacías (0
    // features) y se oculta al llegar datos. Alternativa: un hijo `slot="empty"` con contenido libre.
    emptyMessage       : { attribute: 'empty-message' },
    // Estado reactivo interno (no atributo): ¿mostrar el estado vacío? Lo computa el mapa desde sus
    // capas de datos; dispara re-render del overlay del mensaje.
    _empty             : { state: true },
    // Lo que dibujan el zoom y la atribución: el zoom de la vista asentada y la atribución del proveedor.
    _zoom              : { state: true },
    _attribution       : { state: true },
  }

  // La superficie del mapa se posiciona con la hoja del anfitrión (tiles absolutos, z de los panes,
  // transición del zoom). En shadow DOM el CSS global NO cruza el borde → hay que adoptarla acá, o los
  // tiles caen a flujo normal (sueltos/apilados) y los transforms inline los mandan fuera.
  static styles = [
    unsafeCSS(surfaceCss),
    css`
      /* isolation:isolate crea un stacking context en el host: confina el z-index interno
         (panes de Leaflet 200-700, overlays 1000) para que el mapa NO se
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
      /* El zoom y la atribución son del elemento: viven en las zonas, fuera del contenedor del mapa, así
         que su puntero nunca llega a la superficie. Toman el aspecto de los controles de Leaflet y se
         estilan desde afuera por sus parts: zoom, zoom-in, zoom-out y attribution. */
      .zoom, .attribution { pointer-events: auto; font: 12px/1.4 "Helvetica Neue", Arial, Helvetica, sans-serif; }
      .zoom {
        display: flex; flex-direction: column;
        border: 2px solid rgba(0, 0, 0, 0.2); border-radius: 4px; background-clip: padding-box;
      }
      .zoom button {
        width: 30px; height: 30px; padding: 0; border: 0; border-bottom: 1px solid #ccc;
        background: #fff; color: #000; font: bold 22px/30px "Lucida Console", Monaco, monospace;
        cursor: pointer; user-select: none;
      }
      .zoom button:first-child { border-radius: 2px 2px 0 0; }
      .zoom button:last-child { border-bottom: none; border-radius: 0 0 2px 2px; }
      .zoom button:hover, .zoom button:focus-visible { background: #f4f4f4; }
      .zoom button:disabled { cursor: default; background: #f4f4f4; color: #bbb; }
      .attribution { padding: 0 5px; background: rgba(255, 255, 255, 0.8); color: #333; }
      .attribution a { color: #0078a8; text-decoration: none; }
      .attribution a:hover, .attribution a:focus { text-decoration: underline; }
      /* Estado "sin datos": mensaje centrado sobre el mapa, POR DEBAJO de los overlays de control
         (z-index 900 < 1000) y sin capturar el puntero (no bloquea drag/zoom del mapa vacío). El
         contenido sloteado sí reactiva el puntero (un CTA clickeable). Oculto salvo estado vacio. */
      .empty-state {
        position: absolute; inset: 0; z-index: 900;
        display: flex; align-items: center; justify-content: center;
        padding: 24px; text-align: center; pointer-events: none;
      }
      .empty-state[hidden] { display: none; }
      .empty-state ::slotted(*) { pointer-events: auto; }
    `,
  ]

  #engine         = null
  #pending        = []
  #mounted        = false
  #everMounted    = false
  #resize         = null          // agendador del resize (observer + debounce trailing); dispose() al desmontar
  #resolveReady
  // Puenteo bajo demanda: nro de listeners DOM por tipo cristae:* (persiste entre reconexiones, porque
  // las registraciones de addEventListener sobreviven al detach) y el unsub del motor activo por tipo
  // (presente solo si hay listeners Y el motor está montado; se descarta al desmontar y se re-cabla).
  #demandCount = new Map()
  #demandUnsub = new Map()
  // Estado "sin datos": capas de datos rastreadas (elemento → unsub de su Source) y el rAF que coalesce
  // el recómputo. Las capas se dan de alta/baja solas por `cristaeLayerMounted`/`cristaeLayerUnmounted`
  // (las llama cada capa al montar/desmontar); el recómputo lee el snapshot de cada Source.
  #dataLayers = new Map()
  #emptyRaf   = 0
  // Creada en construcción → `map.ready` está disponible SÍNCRONO apenas existe el elemento. Se
  // resuelve una sola vez, cuando el motor queda listo.
  ready = new Promise(resolve => this.#resolveReady = resolve)

  // El zoom abre su zona y la atribución la cierra, como los controles de Leaflet en sus esquinas. Los
  // botones le piden el zoom al motor vigente al pulsarlos: tras un re-montaje es otro, y el render no se
  // repite si nada cambió. La atribución va como HTML (docs/tiles.md#la-atribución).
  render() {
    const camera = this.#engine?.camera
    return html`
      <div id="map"></div>
      <div class="overlays">
        <div class="zone tl">${this.noZoomControl ? nothing : html`
          <div class="zoom" part="zoom">
            <button type="button" part="zoom-in" title="Zoom in" aria-label="Zoom in"
              ?disabled=${this._zoom >= camera?.getMaxZoom()} @click=${() => this.#engine?.camera.zoomIn()}>+</button>
            <button type="button" part="zoom-out" title="Zoom out" aria-label="Zoom out"
              ?disabled=${this._zoom <= camera?.getMinZoom()} @click=${() => this.#engine?.camera.zoomOut()}>&minus;</button>
          </div>`}<slot name="top-left"></slot></div>
        <div class="zone tc"><slot name="top-center"></slot></div>
        <div class="zone tr"><slot name="top-right"></slot></div>
        <div class="zone cl"><slot name="center-left"></slot></div>
        <div class="zone cc"><slot name="center"></slot></div>
        <div class="zone cr"><slot name="center-right"></slot></div>
        <div class="zone bl"><slot name="bottom-left"></slot></div>
        <div class="zone bc"><slot name="bottom-center"></slot></div>
        <div class="zone br"><slot name="bottom-right"></slot>${this._attribution ? html`
          <div class="attribution" part="attribution">${unsafeHTML(this._attribution)}</div>` : nothing}</div>
      </div>
      <div class="empty-state" part="empty" ?hidden=${!this._empty}>
        <slot name="empty">${this.emptyMessage ?? ''}</slot>
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
    this.#resize?.dispose()
    this.#resize = null
    this.#engine?.destroy()
    this.#engine = null
    this.#mounted = false
    this.#demandUnsub.clear()   // los unsub apuntan al bus del motor destruido; los counts DOM persisten para re-cablear
    if (this.#emptyRaf) { cancelAnimationFrame(this.#emptyRaf); this.#emptyRaf = 0 }
    this.#dataLayers.forEach(unsub => unsub?.())   // cortar suscripciones a las Sources
    this.#dataLayers.clear()
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

  // Alta de una capa en el estado "sin datos": la llama la capa al montar (base._announce). Sólo cuenta
  // las capas con Source observable (las de dato: point/line/html/polygon/…); una label —sin `source` en
  // su handle— no aporta y se ignora sola. Se suscribe a la Source para recomputar al cambiar los datos.
  cristaeLayerMounted(el) {
    if (this.#dataLayers.has(el)) return
    const src = el.controls?.source
    if (!src) return
    this.#dataLayers.set(el, src.subscribe(() => this.#scheduleEmpty()))
    this.#scheduleEmpty()
  }

  // Baja de una capa: corta su suscripción y recomputa (una capa quitada ya no cuenta para "vacío").
  // Sentinela por PRESENCIA (`has`), no por valor: una Source cuyo `subscribe` devuelve `undefined`
  // igual quedó registrada, y un `=== undefined` la dejaría colgada en el Map (empty-state pegado).
  cristaeLayerUnmounted(el) {
    if (!this.#dataLayers.has(el)) return
    this.#dataLayers.get(el)?.()
    this.#dataLayers.delete(el)
    this.#scheduleEmpty()
  }

  // Coalesce el recómputo a un rAF: la Source notifica por cada commit (alta frecuencia bajo streaming),
  // pero el estado vacío sólo transiciona de tanto en tanto — recomputar una vez por frame basta.
  #scheduleEmpty() {
    if (this.#emptyRaf) return
    this.#emptyRaf = requestAnimationFrame(() => {
      this.#emptyRaf = 0
      this._empty    = dataLayersEmpty([...this.#dataLayers.keys()])   // Lit deduplica: sin cambio de valor, sin re-render
    })
  }

  // `viewport-insets` es reactivo: las franjas del contenedor ocluidas por UI del consumidor
  // (paneles/sidebars internos) cambian en runtime al abrir/cerrar un panel. Se re-aplican a la
  // cámara y el motor emite `viewportchange` — la región visible cambió aunque la cámara no se movió —
  // para que los overlays anclados (popup, botón central del cluster) se re-encuadren al instante.
  // `zoom-animation`, `cursor` y los límites también son reactivos: se cambian en vivo sin remontar el
  // mapa. Los límites van juntos, así que cambiar uno los vuelve a fijar todos. Todo llega al motor antes
  // del render, que lee de la cámara los topes con que habilita el zoom.
  willUpdate(changed) {
    if (!this.#engine) return
    if (changed.has('zoomAnimation')) this.#engine.setZoomAnimation(this.zoomAnimation ?? 'none')
    if (changed.has('cursor')) this.#engine.setCursor(this.cursor)
    if (changed.has('viewportInsets')) this.#engine.camera.insets = this.viewportInsets
    if (LIMITS.some(key => changed.has(key))) this.#engine.setLimits(this.#limits())
  }

  #limits() { return Object.fromEntries(LIMITS.map(key => [key, this[key]])) }

  async #mount() {
    if (this.#mounted) return
    this.#mounted = true
    this.#everMounted = true
    const glify = await glifyReady
    const container = this.renderRoot.querySelector('#map')

    // `initial-center` admite [lat,lng], la cadena "lat,lng" o vacío → [0,0].
    const resolveCenter = () => {
      const c = this.initialCenter
      return Array.isArray(c)
        ? c
        : typeof c === 'string' && c.includes(',')
          ? c.split(',').map(Number)
          : [0, 0]
    }

    this.#engine = new MapEngine({
      glify,
      container,
      view: { center: resolveCenter(), zoom: this.initialZoom ?? 2 },
      insets: this.viewportInsets,
      hoverThrottleMs: this.hoverThrottle ?? 0,
      zoomAnimation: this.zoomAnimation ?? 'none',
      cursor: this.cursor,
      ...this.#limits(),
    })
    if (this.tile) this.#engine.setTileProvider({ noWrap: !this.worldCopies, ...this.tile })
    this._zoom        = this.#engine.camera.getZoom()
    this._attribution = this.#engine.getTileAttribution()

    this.#wireEvents()
    this.#pending.forEach(el => el.cristaeMount(this.#engine))
    this.#pending = []

    // Por la promesa, no por el signal: un .then llega aunque el motor ya esté listo.
    // Resuelve `this.ready` (creada en construcción) una sola vez; en re-montajes ya está resuelta.
    this.#engine.ready.then(() => {
      this.#emit('ready', {})
      this.#resolveReady?.(this.#engine)
      this.#resolveReady = null
    })

    this.#resize = createResizeSync(this, () => this.#engine?.syncSize())
  }

  #wireEvents() {
    const e = this.#engine
    // Siempre activos: baja frecuencia, sin coste de picking.
    e.on('viewportchange', d => {
      this._zoom = d.zoom
      this.#emit('viewportchange', d)
    })
    // Un tope que se abre no mueve la vista: el render vuelve a leer los topes para habilitar el zoom.
    e.on('zoomlevelschange', () => this.requestUpdate())
    e.on('interactionstart', () => this.#emit('interactionstart', {}))
    e.on('interactionend', () => this.#emit('interactionend', {}))
    // Click en el MAPA (área libre, con latlng) → CustomEvent DOM `cristae:mapclick`. Mismo patrón
    // que viewportchange: siempre activo, baja frecuencia y sin coste de picking (es el click crudo del
    // mapa, no los hits de features de `cristae:click`). El motor emite `map:click` con `{ latlng }`.
    e.on('map:click', d => this.#emit('mapclick', d))
    // Bajo demanda: re-cablear los tipos que ya tienen listeners DOM (agregados antes de montar, o
    // tras un re-mount). Los listeners futuros los cabla addEventListener.
    this.#demandCount.forEach((count, type) =>
      count > 0 && !this.#demandUnsub.has(type) && this.#demandUnsub.set(type, this.#subscribeEngine(type)))
    // 'ready' se entrega por la promesa en #mount.
  }

  // Puenteo de un tipo cristae:* al canal del motor, como tabla const (eje 11) en vez de if-chain: cada
  // entrada abre su canal en el motor del elemento recibido y devuelve el unsub. Es `static #private`
  // (no const de módulo) para poder tocar #engine/#emit; los closures por-evento se crean recién al
  // suscribir, uno por suscripción, igual que antes.
  static #ENGINE_BRIDGE = {
    'cristae:click':       el => el.#engine.on('click', (hits, ev) => el.#emit('click', { hits, originalEvent: ev })),
    'cristae:hover':       el => el.#engine.on('hover', hits => el.#emit('hover', { hits })),
    'cristae:pointermove': el => el.#engine.on('pointer:move', (_, sample) => el.#emit('pointermove', sample)),
  }

  // Suscribe el canal del motor para un tipo cristae:* bajo demanda y devuelve su unsub (o null si el
  // tipo no se puentea). Llamado solo con el motor montado (desde addEventListener o #wireEvents).
  // Suscribir `hover` acá —y no en el montaje— es lo que mantiene el demand-counting del EventBus
  // efectivo: sin listener, sin picking.
  #subscribeEngine(type) {
    return CristaeMap.#ENGINE_BRIDGE[type]?.(this) ?? null
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(`cristae:${type}`, { detail, bubbles: true, composed: true }))
  }
}
