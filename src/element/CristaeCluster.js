import { CristaeLayerElement } from './base.js'
import { grammar } from './composite.js'
import { reduceModifier, validate } from '../grammar/index.js'

let clSeq = 0

// circle-threshold: un número (umbral círculo→espiral) o "auto"/vacío → null (el motor usa su default).
const parseCircleThreshold = (v) => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

// Botón central por DEFAULT (re-clusterizar): disco blanco con sombra suave + anillo índigo y una ✕
// de trazo redondeado (SVG) → look moderno. El consumidor lo reemplaza con un hijo `slot="center"`
// (HTML libre) o lo estiliza por la clase `.cristae-cluster-center`. Va sobre las líneas, anclado al
// centro del cluster abierto; click → colapsa todo (vuelve a clusterizar).
// El COLOR se modela en la CONSTRUCCIÓN del botón (no como prop claro/oscuro): lee CSS vars con el look
// claro por default. El consumidor las pisa por tema (ej. `.dark { --cristae-cluster-center-bg: … }`);
// como el botón vive en document.body, las vars van en :root / .dark (globales), no en el elemento.
const DEFAULT_CENTER_HTML =
  '<div style="width:30px;height:30px;border-radius:50%;' +
  'background:var(--cristae-cluster-center-bg,#fff);' +
  'box-shadow:0 3px 10px var(--cristae-cluster-center-shadow,rgba(15,23,42,.22)),' +
  '0 0 0 1px var(--cristae-cluster-center-ring,rgba(99,102,241,.35));' +
  'display:flex;align-items:center;justify-content:center">' +
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" ' +
  'stroke="var(--cristae-cluster-center-stroke,#6366f1)" stroke-width="2.6" ' +
  'stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></div>'

// Estilo (una vez) para el hover del botón central — el transform de centrado vive en el contenedor,
// así que el scale va en el hijo para no pisarlo.
const CENTER_CSS_ID = 'cristae-cluster-center-css'
function ensureCenterCss() {
  if (typeof document === 'undefined' || document.getElementById(CENTER_CSS_ID)) return
  const st = document.createElement('style')
  st.id = CENTER_CSS_ID
  st.textContent = '.cristae-cluster-center>*{transition:transform .12s ease}.cristae-cluster-center:hover>*{transform:scale(1.12)}'
  document.head.appendChild(st)
}

// <cristae-cluster> — MODIFICADOR de la gramática de composición (combine: 'fold').
// Clusteriza el/los hijo(s) de puntos: los agrupa en UN supercluster (si hay varios, sobre
// la unión) y los suprime, emitiendo burbujas. Como modificador, compone con `<cristae-overlay>`
// en CUALQUIER orden de anidación — el orden declarativo es la semántica, sin métodos de control:
//
//   <cristae-cluster radius="88" min-points="2">
//     <cristae-overlay><cristae-point-layer id="fleet"/></cristae-overlay>   <!-- badges se ocultan al clusterizar -->
//   </cristae-cluster>
//
// Hija opcional `slot="bubble"` (point o label) = cómo se ven las burbujas. Sin ella → default.
//
// expandable (default true): click en una burbuja la expande (los puntos del cluster aparecen
// individualmente); click fuera la colapsa. Desactivar con expandable="false" si el proyecto
// necesita manejar la interacción a mano.
export class CristaeCluster extends CristaeLayerElement {

  // Modificador `fold`: consume `point`, produce `point` (pass-through, suprimido) + `bubble`.
  static cristaeSignature = { consumes: ['point'], produces: ['point', 'bubble'], combine: 'fold', arity: 'wrapper' }

  // apply del reductor: fold → clusteriza TODOS los targets juntos; devuelve la unit de burbuja.
  static cristaeApply(engine, targets, cfg) {
    const bubble = engine.addClusterFold(targets, cfg)
    return bubble ? [bubble] : []
  }

  static properties = {
    radius:     { type: Number },
    maxZoom:    { type: Number, attribute: 'max-zoom' },
    minPoints:  { type: Number, attribute: 'min-points' },
    enabled:    { type: Boolean },    // toggle de clustering (default true); off → sin agrupar, sin desmontar
    expandable: { type: Boolean },    // toggle de expand/collapse al click (default true)
    dimRest:        { type: Boolean, attribute: 'dim-rest' },          // al expandir, atenúa el resto del mapa (default false)
    dimRestOpacity: { type: Number,  attribute: 'dim-rest-opacity' },  // opacidad del resto atenuado (default 0.3)
    dimMarked:      { type: Boolean, attribute: 'dim-marked' },        // con ids marcados, atenúa el resto del mapa (default false)
    dimRestExcept:  { attribute: false },                              // capas del consumidor que quedan brillantes al atenuar (por ref)
    circleThreshold: { attribute: 'circle-threshold' },                // nº o "auto" (default): umbral círculo→espiral del spider
    spiralGap:       { type: Number, attribute: 'spiral-gap' },        // radio interior de la espiral en px (default 42)
    accent:          { attribute: 'accent' },                          // fondo de sub-burbujas (+ traza si no hay line-color)
    lineColor:       { attribute: 'line-color' },                      // color de la TRAZA que une los elementos (el consumidor lo deriva del acento)
  }

  // ID de la capa de burbujas de este cluster (para detectar clicks propios vs. ajenos).
  #bubbleLayerId = null
  // Ids marcados: canal imperativo propio, NO config del fold (no viaja por cristaeConfig). Se
  // setea por PROPIEDAD (los frameworks asignan propiedades, no atributos) y se guarda siempre
  // para re-empujarlo al montar — un remount crea un fold nuevo con el set vacío.
  #markedIds = null
  // Referencia al <cristae-map> antecesor (necesaria para limpiar el listener al desmontar).
  #mapEl = null
  // Función de baja del listener de auto-collapse en click externo.
  #offOutsideClick = null

  // Botón central (re-clusterizar): nodo HTML flotante anclado al centro del cluster abierto.
  #centerEl     = null
  #centerAnchor = null            // { lat, lng } del centro abierto (re-proyecta en cada move)
  #onCenterMove = null
  #lmap         = null

  constructor() {
    super()
    this.enabled    = true
    this.expandable = true
    this.dimRest    = false
    this.dimMarked  = false
  }

  // Listo cuando todos los hijos de gramática (host(s), no la burbuja) tienen su config.
  mountReady() {
    return [...this.children]
      .filter(el => el.getAttribute?.('slot') !== 'bubble' && typeof el.cristaeMount === 'function')
      .every(el => el.mountReady())
  }

  mountLayer(engine) {
    if (!this._enclosingModifier())
      validate(this, { signatureFor: grammar.signatureFor, isRegistered: grammar.isRegistered, mode: grammar.mode })

    const ctx = { signatureFor: grammar.signatureFor, applyFor: grammar.applyFor, isRegistered: grammar.isRegistered }
    this._units = reduceModifier(this, engine, ctx)

    // El control del cluster viaja en el handle de la unit de burbuja (setConfig/dispose). El
    // teardown del clustering lo dispara el quitado de los hosts (cada host comparte un dispose
    // idempotente), así que el _handle del cluster es un marcador (no una capa) → removeLayer no-op.
    const bubble = this._units.find(u => u.kind === 'bubble')
    const control = bubble?.handle?.control ?? null

    if (control) {
      this.#bubbleLayerId = bubble.id

      // La SESIÓN de expansión se publica como eventos del BUS del motor —`map.on('cluster:expand'|
      // 'cluster:update'|'cluster:dismiss', cb)`, mismo estilo que hover:start/end e interactionstart/end
      // (ver MapEngine.apply → #emit). El elemento NO despacha su propio CustomEvent: aquí sólo consume la
      // transición interna (`_onInteraction`) para su BOTÓN CENTRAL de re-clusterizar:
      //   expand : nueva sesión (click en burbuja base)              → mostrar la X
      //   update : la sesión cambió (subburbuja drilleada, o poda/crecimiento del snapshot) → reposicionar
      //   dismiss: cerró (colapso/zoom/enabled=false) o el ancla desapareció por poda → ocultar la X
      // El payload rico (id, center, count, entities agrupados) viaja por `#emit('cluster:*')`, no por acá.
      control.onInteraction = ({ type, center }) => {
        if (type === 'dismiss') this.#hideCenter()
        else this.#showCenter(center, control)   // expand | update → (re)posiciona el botón central
      }

      if (this.expandable) this.#attachAutoCollapse(control)
      if (this.#markedIds?.length) control.setMarked(this.#markedIds)   // re-push: el fold nuevo arranca vacío
    }

    return { id: `cluster-marker-${++clSeq}`, units: this._units, control }
  }

  disconnectedCallback() {
    super.disconnectedCallback?.()
    this.#detachAutoCollapse()
    this.#detachCenter()
  }

  /* ── Botón central de re-clusterizar (HTML flotante anclado al centro del base abierto) ── */

  #showCenter(center, control) {
    if (!center) return
    this.#mapEl = this.#mapEl ?? this.closest('cristae-map')
    if (!this.#mapEl) return
    if (!this.#centerEl) {
      ensureCenterCss()
      const el = document.createElement('div')
      el.className = 'cristae-cluster-center'
      const custom = [...this.children].find(c => c.getAttribute?.('slot') === 'center')
      el.innerHTML = custom ? custom.innerHTML : DEFAULT_CENTER_HTML
      // z-index configurable: el botón vive en document.body (no lo clipea el mapa), así que su apilamiento
      // compite en el contexto raíz con el chrome de la app (modales, drawers). El default alto conserva el
      // comportamiento previo, pero el consumidor lo baja por `--cristae-cluster-center-z` para que quede
      // sobre el mapa y DEBAJO de sus overlays (tooltip, popup) y de su capa de modales.
      el.style.cssText = 'position:fixed; z-index:var(--cristae-cluster-center-z, 9000); cursor:pointer; transform:translate(-50%,-50%)'
      el.addEventListener('click', (e) => { e.stopPropagation(); control.collapseAll() })
      document.body.appendChild(el)
      this.#centerEl = el
      this.#onCenterMove = () => this.#positionCenter()
      this.#mapEl.addEventListener('cristae:viewportchange', this.#onCenterMove)
      addEventListener('scroll', this.#onCenterMove, true)
      addEventListener('resize', this.#onCenterMove)
      const lmap = this.#mapEl.engine?.getLeafletMap?.()
      if (lmap) { this.#lmap = lmap; lmap.on('move', this.#onCenterMove) }   // seguir paneo/inercia
    }
    this.#centerEl.style.display = ''
    this.#centerAnchor = center
    this.#positionCenter()
  }

  #positionCenter() {
    if (!this.#centerEl || !this.#centerAnchor || !this.#mapEl) return
    const cam = this.#mapEl.camera
    if (!cam) return
    const pt = cam.latLngToContainerPoint([this.#centerAnchor.lat, this.#centerAnchor.lng])
    const rect = this.#mapEl.getBoundingClientRect()
    // El botón es un overlay HTML en document.body — el contenedor del mapa NO lo clipea como a los
    // marcadores GL. Si el ancla cae fuera de la REGIÓN VISIBLE (el contenedor menos los
    // viewport-insets que ocluyen UI del consumidor — paneo, o un panel interno encima), ocultarlo
    // en vez de dejarlo flotar afuera. Misma región contra la que recorta el popup.
    const ins = cam.insets
    if (pt.x < ins.left || pt.y < ins.top || pt.x > rect.width - ins.right || pt.y > rect.height - ins.bottom) {
      this.#centerEl.style.display = 'none'
      return
    }
    this.#centerEl.style.display = ''
    this.#centerEl.style.left = `${rect.left + pt.x}px`
    this.#centerEl.style.top = `${rect.top + pt.y}px`
  }

  #hideCenter() {
    if (this.#centerEl) this.#centerEl.style.display = 'none'
    this.#centerAnchor = null
  }

  #detachCenter() {
    if (this.#onCenterMove) {
      this.#mapEl?.removeEventListener('cristae:viewportchange', this.#onCenterMove)
      removeEventListener('scroll', this.#onCenterMove, true)
      removeEventListener('resize', this.#onCenterMove)
      this.#lmap?.off('move', this.#onCenterMove)
      this.#onCenterMove = null; this.#lmap = null
    }
    this.#centerEl?.remove()
    this.#centerEl = null; this.#centerAnchor = null
  }

  cristaeUnits() { return this._units ?? [] }

  // Config del fold (sin la burbuja): ÚNICA fuente del objeto que consumen el montaje
  // (cristaeConfig) y el re-envío reactivo (syncLayer). Sus claves = las propiedades reactivas
  // del elemento — agregar una prop nueva es tocar `static properties` y este objeto, nada más.
  #foldConfig() {
    return {
      radius: this.radius,
      maxZoom: this.maxZoom,
      minPoints: this.minPoints,
      enabled: this.enabled,
      expandable: this.expandable,
      dimRest: this.dimRest,
      dimRestOpacity: this.dimRestOpacity,
      dimMarked: this.dimMarked,
      dimRestExcept: this.dimRestExcept,
      circleThreshold: parseCircleThreshold(this.circleThreshold),
      spiralGap: this.spiralGap,
      accent: this.accent ?? null,
      lineColor: this.lineColor ?? null,
    }
  }

  cristaeConfig() {
    return { ...this.#foldConfig(), bubble: this.#bubbleConfig() }
  }

  syncLayer(changed) {
    // Toda propiedad reactiva del elemento es config del fold: si cambió alguna (las claves del
    // objeto SON los nombres de las props), se reenvía la config completa por setConfig.
    const cfg = this.#foldConfig()
    if (Object.keys(cfg).some((k) => changed.has(k))) this._handle?.control?.setConfig(cfg)
    // Reconectar/desconectar el auto-collapse cuando expandable cambia en caliente.
    if (changed.has('expandable')) {
      const control = this._handle?.control
      if (!control) return
      this.expandable ? this.#attachAutoCollapse(control) : this.#detachAutoCollapse()
    }
  }

  /* ── API pública — usable desde código externo si hace falta control fino ──
   * `clusterId` es un id de Supercluster (efímero): pasar SÓLO uno recién obtenido del frame actual. El
   * estado queda anclado por hoja, así que la expansión sobrevive a reindex/zoom aunque ese id deje de
   * existir. expand() devuelve los `ids` desclusterizados (o null). Para reaccionar a la interacción del
   * usuario, preferir los eventos del bus `map.on('cluster:expand'|'cluster:update'|'cluster:dismiss', cb)`
   * en vez de llamar a estos métodos. */

  expand(clusterId)     { return this._handle?.control?.expand(clusterId) ?? null }
  collapse(clusterId)   { this._handle?.control?.collapse(clusterId) }
  collapseAll()         { this._handle?.control?.collapseAll() }
  isExpanded(clusterId) { return this._handle?.control?.isExpanded(clusterId) ?? false }
  // Estado actual de la sesión de expansión (o null): paridad con map.camera para lectura imperativa sin
  // esperar el próximo evento. Mismo payload que `map.on('cluster:expand', s => …)`.
  get session()         { return this._handle?.control?.getSession?.() ?? null }

  /* ── Eje "marked" + interacción genérica con burbujas ── */

  // Ids de dato marcados (Array o Set): las burbujas que contengan alguno se pintan con la
  // variante `marked` del icon-set y su colocación se publica por `map.on('cluster:marked', cb)`.
  // Property por referencia (no serializa a atributo); se re-empuja sola en cada montaje.
  set markedIds(ids) {
    this.#markedIds = ids ? [...ids] : []
    this._handle?.control?.setMarked?.(this.#markedIds)
  }
  get markedIds()       { return this.#markedIds ?? [] }
  // Lectura imperativa del eje marked (paridad con `session`): mismo payload que el evento.
  get marked()          { return this._handle?.control?.getMarked?.() ?? { hidden: [] } }
  // Id de la capa de burbujas: para suscribirse a sus hits por el bus del motor
  // (map.on('click' | 'hover', bubbleLayerId, cb)) y componer con contentsOf/expand.
  get bubbleLayerId()   { return this.#bubbleLayerId }
  // Id de la capa de SUB-burbujas de la espiral (jerarquía depth-2), o null. Mismo uso que
  // bubbleLayerId: suscribirse a sus hits por el bus; el hit.id es el ancla del grupo → componer
  // con la estructura de sesión (`session` / eventos cluster:*), que trae los miembros por grupo.
  get subBubbleLayerId() { return this._handle?.control?.subBubbleLayerId ?? null }
  // Contenido (ids de dato) de una burbuja BASE del frame actual — consulta pura (ver control).
  contentsOf(clusterId) { return this._handle?.control?.contentsOf?.(clusterId) ?? null }

  /* ── Internos ── */

  // Cualquier cristae:click que no sea en una capa PROPIA del fold (burbuja o marcadores de la
  // espiral) → colapsar todo. Así: click en la burbuja/spider lo maneja el fold (toggle / abrir popup
  // del marcador); click en otro punto, otra capa o el fondo (hits=[]) re-forma los clusters.
  #attachAutoCollapse(control) {
    this.#detachAutoCollapse()   // evitar doble-registro si se llama varias veces
    this.#mapEl = this.closest('cristae-map')
    if (!this.#mapEl) return
    this.#offOutsideClick = (e) => {
      const top = e.detail?.hits?.[0]
      // presentedFrom: un hit que el overlay del fold presentó como otra capa (hoja → vehículo) sigue
      // siendo propio → no colapsa.
      if (!top || !(control.ownsLayer(top.layerId) || control.ownsLayer(top.presentedFrom))) control.collapseAll()
    }
    this.#mapEl.addEventListener('cristae:click', this.#offOutsideClick)
  }

  #detachAutoCollapse() {
    if (!this.#offOutsideClick) return
    this.#mapEl?.removeEventListener('cristae:click', this.#offOutsideClick)
    this.#offOutsideClick = null
    this.#mapEl = null
  }

  #bubbleConfig() {
    const b = [...this.children].find(el => el.getAttribute?.('slot') === 'bubble')
    if (!b) return undefined
    if (b.tagName === 'CRISTAE-LABEL-LAYER') return { kind: 'label', textOf: b.textOf, paint: b.paint, style: b.style }
    return { kind: 'point', iconSet: b.iconSet, sizeOf: b.sizeOf }
  }
}
