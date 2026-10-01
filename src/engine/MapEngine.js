import { LayerRegistry } from '../interaction/LayerRegistry.js'
import { EventBus } from '../events/EventBus.js'
import { Interaction } from './Interaction.js'
import { Camera, limitsOf } from './Camera.js'
import { PointLayer } from '../render/PointLayer.js'
import { OBJ_BITS } from '../render/Picking.js'
import { LineGpuLayer } from '../render/LineGpuLayer.js'
import { PolygonGpuLayer } from '../render/PolygonGpuLayer.js'
import { CircleLayer } from '../render/CircleLayer.js'
import { HeatLayer } from '../render/HeatLayer.js'
import { EditableGeometry } from '../render/EditableGeometry.js'
import { HtmlLayer } from '../render/HtmlLayer.js'
import { LabelLayer } from '../render/LabelLayer.js'
import { createHighlightOverlay } from '../render/HighlightOverlay.js'
import { frameTransform } from '../render/frame.js'
import { createClusterFold } from '../cluster/ClusterFold.js'
import { defineClusterIconSet } from '../atlas/IconSet.js'
import { createSource } from '../data/index.js'
import { createLeafletHost } from '../host/LeafletHost.js'
import { iterable } from '../data/path.js'
import { foldRuns } from '../geometry/polyline.js'
import { emptyBounds, growBounds, growRun } from '../geometry/bounds.js'

// MapEngine — orquestador headless (SPECS §6). Framework-agnóstico, sin dominio. Monta sobre un
// anfitrión —el que recibe o el que crea sobre `container`—, deriva panes por orden de declaración (el
// consumidor no toca z-index) y cablea las piezas: registry + bus + Interaction (picking) + Camera. Los
// tiles son del anfitrión. Cada registro sostiene su pane en la superficie del anfitrión mientras vive.
// Cada capa de puntos posee un Source interno (ruta C) o adopta uno externo (ruta B).

const BASE_Z = 400
const Z_STEP = 10
// Techo de la identidad de OBJETO del pase de picking: el eje `obj` del píxel menos el 0, que significa
// «nada» y no se asigna nunca. Sale de los bits que declara el codec — nunca de un número repetido acá.
const PICK_OBJ_MAX = (1 << OBJ_BITS) - 1
const ITEM_DIM = 0.3            // opacidad del atenuado en el eje de foco por ÍTEM
// Offset de la capa de LABELS sobre su host. El fold de cluster (burbujas + spider) se cuelga por ENCIMA
// de esta banda para que las etiquetas de otros marcadores NO tapen los vehículos que el cluster superpone
// al expandirse (el spider es el contenido enfocado → va arriba de los labels). Ver addLabelLayer + fold.
const LABEL_Z_OFFSET = 200
const BUS_EVENTS = new Set(['click', 'secondary-click', 'hover', 'hover:start', 'hover:end', 'pointer:move'])
// El detail de `move`: uno compartido, porque sale en cada paso del movimiento.
const MOVE_DETAIL = Object.freeze({})

// Lado del sprite de la burbuja default (px). El radio es `size * 0.42` y el texto escala con `size`,
// así que esto fija el tamaño visible de toda la burbuja. El consumidor lo cambia con `bubble.sizes`.
const DEFAULT_CLUSTER_SIZE = 43

// Dibujo por defecto de la burbuja de cluster. `plus` (de defineClusterIconSet) marca el bucket que
// es piso de un rango → "+", sin afirmar un conteo exacto. El consumidor reemplaza esto con su `draw`.
// Color de acento de la jerarquía spiderfy (índigo) — se usa para sub-bubbles y patas del grupo.
const SUB_ACCENT = '#6366f1'

// Dibujo de SUB-CLUSTER (jerarquía spiderfy): DISTINTO a la burbuja base sólida y con acento del tema —
// halo suave (profundidad) + disco + anillo interior blanco + conteo bold. Se lee como "sub-grupo,
// click para abrir", no se confunde con un cluster base. `accent` (opcional) pisa el color por CONTEO
// con un color fijo (config `accent` del cluster); sin él, colorea por umbral rojo/ámbar/índigo.
const makeSubClusterDraw = (accent = null) => (ctx, size, count, plus) => {
  const cx = size / 2, cy = size / 2, r = size * 0.33
  const color = accent ?? (count >= 200 ? '#dc2626' : count >= 50 ? '#f59e0b' : SUB_ACCENT)
  // Halo glow en DOS anillos (suave→fuerte), dentro del radio dibujable (≤ size/2) → cada sub-cluster
  // "pop" y no se confunde con otros iconos.
  ctx.fillStyle = color
  ctx.beginPath(); ctx.arc(cx, cy, r + size * 0.14, 0, Math.PI * 2); ctx.globalAlpha = 0.15; ctx.fill()
  ctx.beginPath(); ctx.arc(cx, cy, r + size * 0.07, 0, Math.PI * 2); ctx.globalAlpha = 0.32; ctx.fill()
  ctx.globalAlpha = 1
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2)                   // disco
  ctx.fillStyle = color; ctx.fill()
  ctx.lineWidth = Math.max(1.5, size * 0.05)                            // anillo interior blanco
  ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.stroke()
  const label = plus ? `${count}+` : String(count)
  ctx.fillStyle = '#fff'
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
  ctx.font = `600 ${Math.round(size * (label.length > 4 ? 0.22 : 0.30))}px sans-serif`
  ctx.fillText(label, cx, cy)
}
const SUB_CLUSTER_DRAW = makeSubClusterDraw()   // default: color por conteo

const DEFAULT_CLUSTER_DRAW = (ctx, size, count, plus, dim = false) => {
  const r = size * 0.42
  const a = dim ? 0.4 : 1                          // expandido → burbuja semitransparente (spiderfy)
  ctx.fillStyle = count >= 200 ? '#dc2626' : count >= 50 ? '#f59e0b' : '#2563eb'
  ctx.globalAlpha = 0.9 * a
  ctx.beginPath(); ctx.arc(size / 2, size / 2, r, 0, Math.PI * 2); ctx.fill()
  ctx.globalAlpha = a
  const label = plus ? `${count}+` : String(count)
  ctx.fillStyle = '#fff'
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
  ctx.font = `${Math.round(size * (label.length > 4 ? 0.22 : 0.28))}px sans-serif`
  ctx.fillText(label, size / 2, size / 2)
}

export class MapEngine {

  #host
  #registry
  #bus
  #interaction
  #destroying = false             // teardown del engine en curso → no rebuildear capas ligadas ni emitir viewport

  #layers             = new Map()      // id → record { kind, source, layer, controls, paneName, order }
  #highlightOverlays  = new Set()      // overlays de interacción (canvas 2D fijo al contenedor) → dispose en destroy
  #fontHooked         = new WeakSet()  // iconSets ya cableados al font-gate (evita re-suscribir por cada capa)
  // Capas de puntos interactivas = las que entran al pase de picking. Sobre las MISMAS entradas vive
  // la identidad de OBJETO del pase (el primer eje del píxel): se asigna en el alta desde la free-list
  // y se devuelve en la baja, así que un ciclo de alta/baja no agota el rango. `byObj` es el mapa
  // inverso — el decodificador entrega (obj, chunk, local) y tiene que volver a la capa.
  #pick               = { entries: [], byObj: new Map(), free: [], next: 1 }
  #glLayers           = new Set()      // capas GL que el motor reproyecta en move/zoom/resize
  #pendingBinds       = []             // label-layers cuyo host aún no existía (resolución por nombre)
  #signals            = new Map()      // eventos del motor (ready/viewportchange/interaction*) → handlers
  #iconSets           = new Map()      // nombre → IconSet registrado (resolución por nombre)
  #defaultClusters    = null           // cluster icon-set por defecto (lazy)
  #defaultSubClusters = null           // icon-set de sub-clusters de la espiral (jerarquía, lazy)
  #order              = 0
  #focused            = null           // enfoque: Set(id) de capas a opacidad plena (resto atenuado), o null
  #dimOpacity         = 0.3            // opacidad del resto mientras hay enfoque POR CAPA
  #focusKinds         = null           // kinds de capa que el enfoque por capa atenúa (null = todas)
  #itemFocus          = new Map()      // enfoque por ÍTEM: layerId → Set(id) declarado (vacío = todo atenuado)
  #leafletWarned      = false          // getLeafletMap() ya avisó en este motor

  camera
  ready

  // Lo que queda en `limits` son los límites de la cámara. Como la vista inicial, son del mapa propio: uno
  // adoptado trae los de su dueño.
  constructor({ host, container, view, insets, hoverThrottleMs = 0, zoomAnimation, cursor, ...limits } = {}) {
    this.#host      = host ?? createLeafletHost({ container, view, limits: limitsOf(limits) })
    // Sin modo explícito queda el del anfitrión: no anima en un mapa propio, y en uno adoptado no se
    // interviene la política de su dueño.
    if (zoomAnimation) this.#host.camera.zoomPolicy = zoomAnimation

    // La vista que viaja en `viewportchange`, la de la cámara. Sale cuando un movimiento se asienta y
    // cuando cambian los insets, que corren la región visible sin mover la vista; por los insets, sólo
    // mientras haya una vista que leer: un mapa adoptado puede llegar sin ella, y tras el teardown ya no
    // está. Fuera de ese tramo los insets sólo se guardan.
    const emitViewport = () => this.#emit('viewportchange', {
      center: this.camera.getCenter(), zoom: this.camera.getZoom(), bounds: this.camera.getBounds(),
    })

    this.#registry    = new LayerRegistry()
    this.#bus         = new EventBus(layerId => this.#syncDemand(layerId))
    this.camera       = new Camera({
      host: this.#host,
      insets,
      resolveSource:   id => this.#layers.get(id)?.source ?? null,
      // Zoom mínimo de desclusterización por (capa, id): la cámara lo consulta para revealPoint /
      // followPoint({reveal}) sin conocer el cluster. El fold ata rec.cluster = control (ver addClusterFold).
      declusterZoomOf: (layerId, id) => this.#layers.get(layerId)?.cluster?.declusterZoomFor(id) ?? null,
      onInsetsChange:  () => this.#host.camera.hasView() && !this.#destroying && emitViewport(),
    })
    // La cámara va antes porque Interaction proyecta con ella la muestra del puntero.
    this.#interaction = new Interaction({
      host:       this.#host,
      camera:     this.camera,
      registry:   this.#registry,
      bus:        this.#bus,
      pickLayers: () => this.#pick.entries,
      hoverThrottleMs,
      cursor,
      onInteractionStart: () => this.#emit('interactionstart', {}),
      onInteractionEnd:   () => this.#emit('interactionend', {}),
      onEmptyClick:       latlng => this.#emit('map:click', { latlng }),   // click en espacio vacío → latlng
    })

    this.#host.camera.on('moveend zoomend', emitViewport)
    this.#host.camera.on('move', () => this.#emit('move', MOVE_DETAIL))
    // Los topes del zoom cambian sin que la vista se mueva cuando se abren: lo que los muestra no se
    // entera por `viewportchange`.
    this.#host.camera.on('zoomlevelschange', () => this.#emit('zoomlevelschange', {
      minZoom: this.camera.getMinZoom(), maxZoom: this.camera.getMaxZoom(),
    }))
    this.#wireRenderLifecycle()
    this.#wireZoomReproject()

    this.ready = this.#host.ready.then(() => {
      this.#emit('ready', {})
      return this
    })
  }

  /* ── Capas de puntos ── */

  addPointLayer(cfg) {
    const { id, data, accessors, iconSet, interactive = false, pane, z, visible = true, enabled = true, filters, where, cluster, capture, presentAs } = cfg
    const order    = this.#order++
    const paneName = pane ?? `cristae-point-${id}`
    const zIndex   = z ?? (BASE_Z + order * Z_STEP)

    const set = this.#resolveIconSet(iconSet)
    this.#hookFontGate(set)                      // re-encode al re-rasterizar el atlas (font-gate)
    // `controls` = la Source que posee el motor (ruta A/data); con `cfg.source` el dueño es el
    // consumidor → el motor solo lee, no escribe. El objeto ES el Source (handle colapsado).
    const controls = cfg.source ? null : createSource(accessors, set?.variants)
    const source   = cfg.source ?? controls
    // `where`: membresía por-capa (filtra qué ítems de la Source compartida entran a ESTA capa
    // sin mutar la Source). Otras vistas de la misma Source no se ven afectadas.
    const layer = this.#build(paneName, zIndex, () =>
      this.#trackGl(new PointLayer({ host: this.#host, pane: paneName, source, iconSet: set, interactive, where })))

    // `where`/`enabled` en el record: si esta capa está clusterizada, el cluster indexa `source ∧ where`
    // de los hosts HABILITADOS (no la Source cruda) → cuenta lo que la capa REALMENTE muestra.
    // setWhere/setLayerEnabled los actualizan y re-indexan el cluster. `visible` (pintado puro) se
    // persiste para componer la visibilidad EFECTIVA del pane (visible ∧ enabled).
    const record = { kind: 'point', source, layer, controls, paneName, zIndex, order, interactive, where: where ?? null, visible, enabled }
    this.#layers.set(id, record)
    if (!enabled) layer.enabled = false          // nace gateada: no reacciona a la Source hasta setLayerEnabled(true)

    if (interactive) {
      this.#addPickLayer(id, layer)
      // Los resolvers leen record.layer (no capturan): attachSource puede swapear la capa.
      this.#registerResolver(id, 'point', zIndex, order, sample => record.layer.resolveClick(sample), sample => record.layer.resolveHover(sample), { capture, presentAs })
    }
    this.#applyVisibility(id, paneName, visible && enabled)

    filters?.forEach(f => controls?.addFilter(f))
    if (data && controls) controls.set(data)
    if (cluster) this.addCluster({ hostId: id, ...cluster })   // azúcar: <cristae-cluster> usa addCluster directo

    this.#flushPendingBinds()
    return this.#pointHandle(id, record, set)
  }

  /* ── Capas de polígonos (relleno y contorno en GPU + hit-testing por índice geométrico) ── */

  // Polígonos, una sola puerta. El dibujo es siempre en GPU (stencil en una textura, UN contexto WebGL de
  // los ~16 del navegador); el eje que se elige es el DATO: `data`/`source` (entidades con accessors) o
  // `geometry` (las tablas del lector, sin materializar un array). La geometría tipada es inmutable: no
  // hay Source que mutar. Ninguna va a #glLayers: la capa se repinta con sus propios moveend/zoomend/resize.
  //
  // `idOf`/`styleOf` salen de `accessors` cuando lo hay, así que la ruta tipada los declara en el
  // MISMO lugar que la reactiva. No hay sustrato que elegir: un `backend` se rechaza en vez de caer al
  // estilo, donde se ignoraría y daría una capa GPU a quien pedía otra cosa.
  addPolygonLayer(cfg) {
    if (cfg.backend !== undefined)
      throw new Error('[cristae] los polígonos se dibujan siempre en GPU y no aceptan `backend`: quitalo (ver *Migración* en el CHANGELOG)')
    const { id, data, accessors, pane, z, source: dado, geometry,
            idOf = accessors?.idOf, styleOf = accessors?.styleOf,
            interactive = true, visible = true, ...style } = cfg
    const order    = this.#order++
    const paneName = pane ?? `cristae-polygon-${id}`
    const zIndex   = z ?? (BASE_Z + order * Z_STEP)

    // Sin `geometry`: dueño motor (data) vs consumidor (cfg.source). Con `geometry` no hay Source.
    const controls = geometry || dado ? null : createSource(accessors)
    const source   = geometry ? null : dado ?? controls
    const layer    = this.#build(paneName, zIndex,
      () => new PolygonGpuLayer({ host: this.#host, pane: paneName, source, geometry, idOf, styleOf, interactive, ...style }))

    const record = { kind: 'polygon', source, layer, controls, paneName, zIndex, order, interactive, visible, enabled: true }
    this.#layers.set(id, record)

    if (interactive)   // resolvers leen record.layer (no capturan). Síncrono, no va a #pickLayers (como línea).
      this.#registerResolver(id, 'polygon', zIndex, order, sample => record.layer.resolveClick(sample), sample => record.layer.resolveHover(sample))
    this.#applyVisibility(id, paneName, visible)

    if (data && controls) controls.set(data)
    this.#flushPendingBinds()
    return {
      id,
      source,
      set       : items => controls?.set(items),
      setVisible: v => this.setLayerVisibility(id, v),
      redraw    : () => record.layer.redraw(),
      style     : options => record.layer.style(options),
    }
  }

  /** @deprecated Una sola puerta: `addPolygonLayer({ geometry })`. Se retira en 1.0. */
  addPolygonGpuLayer({ id, pane, interactive = false, ...cfg }) {
    return this.addPolygonLayer({ ...cfg, id, interactive, pane: pane ?? `cristae-polygon-gpu-${id}` })
  }

  /* ── Capas de líneas (GL propio + hit-testing nearest-segment CPU) ── */

  // `vector` y `backend` eran los flags del sustrato: se rechazan nombrando la migración en vez de
  // ignorarse, que dibujaría distinto de lo que pedía quien los pasaba.
  addLineLayer(cfg) {
    if (cfg.vector !== undefined || cfg.backend !== undefined)
      throw new Error('[cristae] las líneas se dibujan siempre en GPU y no aceptan `vector` ni `backend`: quitalos (ver *Migración* en el CHANGELOG)')
    return this.#addLine(cfg, this.#order++)
  }

  // `order` llega de afuera para la capa que nace tarde —las patas del fold usan el de su host—: si
  // tomara uno del contador, correría el z por defecto de las capas que se agreguen después.
  #addLine(cfg, order) {
    const { id, data, accessors, interactive = false, pane, z, visible = true } = cfg
    const paneName = pane ?? `cristae-line-${id}`
    const zIndex   = z ?? (BASE_Z + order * Z_STEP)

    // `controls` = Source que posee el motor (ruta A/data); con `cfg.source` el dueño es el consumidor.
    const controls = cfg.source ? null : createSource(accessors)
    const source   = cfg.source ?? controls
    const layer = this.#build(paneName, zIndex, () => new LineGpuLayer({ host: this.#host, pane: paneName, source }))

    const record = { kind: 'line', source, layer, controls, paneName, zIndex, order, interactive, visible, enabled: true }
    this.#layers.set(id, record)

    if (interactive) {
      // Los resolvers leen record.layer (no capturan). Picking síncrono (no va a #pickLayers, como polígono).
      this.#registerResolver(id, 'line', zIndex, order, sample => record.layer.resolveClick(sample), sample => record.layer.resolveHover(sample))
    }
    this.#applyVisibility(id, paneName, visible)

    if (data && controls) controls.set(data)
    this.#flushPendingBinds()
    // Handle = SÓLO las ACCIONES de la capa (empujar datos / togglear visibilidad). El estilo NO es
    // una acción: es estado (accessor `styleOf`) — para recolorear una línea se muta su item y se
    // set/patch la Source; el motor reescribe su color (incremental o rebuild). No hay `setStyle`.
    // Con una Source del consumidor, `append` lanza en vez de perder los puntos: el que suma es su dueño.
    return {
      id,
      source,
      set:        items => controls?.set(items),
      append:     (itemId, ...points) => {
        if (!controls) throw new TypeError(`[cristae] la capa '${id}' lee una Source del consumidor: append va a esa Source`)
        return controls.append(itemId, ...points)
      },
      setVisible: v => this.setLayerVisibility(id, v),
    }
  }

  /* ── Capa de marcadores HTML (nodos DOM propios; GL-safe, complementa el point-layer GPU) ── */

  addHtmlLayer(cfg) {
    const { id, data, accessors, interactive = false, pane, z, visible = true } = cfg
    const order    = this.#order++
    const paneName = pane ?? `cristae-html-${id}`
    const zIndex   = z ?? (BASE_Z + order * Z_STEP + LABEL_Z_OFFSET)   // sobre líneas/puntos: los badges van arriba

    const controls = cfg.source ? null : createSource(accessors)
    const source   = cfg.source ?? controls
    const layer    = this.#build(paneName, zIndex, () => new HtmlLayer({ host: this.#host, pane: paneName, source, interactive }))

    const record = { kind: 'html', source, layer, controls, paneName, zIndex, order, interactive, visible, enabled: true }
    this.#layers.set(id, record)
    if (interactive) {
      this.#registerResolver(id, 'html', zIndex, order, sample => record.layer.resolveClick(sample), sample => record.layer.resolveHover(sample))
    }
    this.#applyVisibility(id, paneName, visible)

    if (data && controls) controls.set(data)
    return {
      id,
      source,
      set:        items => controls?.set(items),
      setVisible: v => this.setLayerVisibility(id, v),
    }
  }

  /* ── Círculos en METROS (dibujados en la GPU — escalan con el zoom, a diferencia del sprite px) ── */

  addCircleLayer(cfg) {
    const { id, data, accessors, interactive = true, pane, z, visible = true } = cfg
    const order    = this.#order++
    const paneName = pane ?? `cristae-circle-${id}`
    const zIndex   = z ?? (BASE_Z + order * Z_STEP)

    const controls = cfg.source ? null : createSource(accessors)
    const source   = cfg.source ?? controls
    // Se repinta con sus propios moveend/zoomend/resize, así que no va a #glLayers.
    const layer    = this.#build(paneName, zIndex, () => new CircleLayer({ host: this.#host, pane: paneName, source, interactive }))

    const record = { kind: 'circle', source, layer, controls, paneName, zIndex, order, interactive, visible, enabled: true }
    this.#layers.set(id, record)
    if (interactive)
      this.#registerResolver(id, 'circle', zIndex, order, sample => record.layer.resolveClick(sample), sample => record.layer.resolveHover(sample))
    this.#applyVisibility(id, paneName, visible)

    if (data && controls) controls.set(data)
    this.#flushPendingBinds()
    return { id, source, set: items => controls?.set(items), setVisible: v => this.setLayerVisibility(id, v) }
  }

  /* ── Heatmap (canvas 2D, densidad acumulada; NO GL — se auto-reproyecta por eventos del mapa) ── */

  addHeatLayer(cfg) {
    const { id, data, accessors, pane, z, visible = true, radius, blur, intensity, colorRamp } = cfg
    const order    = this.#order++
    const paneName = pane ?? `cristae-heat-${id}`
    const zIndex   = z ?? (BASE_Z + order * Z_STEP)

    const controls = cfg.source ? null : createSource(accessors)
    const source   = cfg.source ?? controls
    const layer    = this.#build(paneName, zIndex, () =>
      new HeatLayer({ host: this.#host, pane: paneName, source, radius, blur, intensity, colorRamp }))

    const record = { kind: 'heat', source, layer, controls, paneName, zIndex, order, interactive: false, visible, enabled: true }
    this.#layers.set(id, record)
    this.#applyVisibility(id, paneName, visible)

    if (data && controls) controls.set(data)
    return {
      id, source,
      set:          items => controls?.set(items),
      setVisible:   v => this.setLayerVisibility(id, v),
      setRadius:    r => layer.radius = r,
      setBlur:      b => layer.blur = b,
      setIntensity: i => layer.intensity = i,
      setColorRamp: fn => layer.colorRamp = fn,
    }
  }

  /* ── Edición de geometría como INPUT CONTROLADO: value entra, cambios salen por onChange. No es capa
       de Source, y DIBUJA la geometría entera —relleno, contorno y handles— en su propia superficie GL:
       no se le ata un display aparte, que se vería superpuesto. `style` toma las mismas claves que un
       `styleOf` de polígonos y líneas. ── */

  addEditableLayer(cfg) {
    const { id, kind = 'polygon', value = null, mode = 'edit', style, onChange, onCommit, pane, z } = cfg
    const order    = this.#order++
    const paneName = pane ?? `cristae-edit-${id}`
    const zIndex   = z ?? (BASE_Z + order * Z_STEP + LABEL_Z_OFFSET)   // handles por encima de las capas
    const editor = this.#build(paneName, zIndex, () => new EditableGeometry({
      host: this.#host, pane: paneName, kind, value, mode, style, onChange, onCommit,
      join: participant => this.#interaction.join(participant, zIndex, order),   // los handles, en su lugar del orden
      onHandleLevel: level => this.#interaction.setHandleLevel(id, level),   // el árbitro del cursor lo traduce
    }), true)
    const record = { kind: 'editable', editor, paneName, zIndex, order, visible: true, enabled: true }
    this.#layers.set(id, record)
    return {
      id,
      setValue:       v => editor.setValue(v),
      setMode:        m => editor.setMode(m),
      setStyle:       s => editor.setStyle(s),
      getValue:       () => editor.getValue(),
      handleMapClick: ll => editor.handleMapClick(ll),
      destroy:        () => this.removeLayer(id),
    }
  }

  /* ── Capas de labels (canvas; standalone o bind-to un host) ── */

  addLabelLayer(cfg) {
    const { id, bindTo, pane, z, paint, style, textOf, accessors } = cfg
    const order      = this.#order++
    const paneName   = pane ?? `cristae-label-${id}`
    const zIndex     = z ?? (BASE_Z + order * Z_STEP + LABEL_Z_OFFSET)        // labels por encima de las capas
    const labelLayer = this.#build(paneName, zIndex, () => new LabelLayer({ host: this.#host, pane: paneName, paint, style }))
    // `visible` en record: controla si sync() (la suscripción a la Source) corre el reduce O(n) +
    // setLabels. Con setVisible(false) el sync es no-op → cero CPU por cada emit del WS.
    const record = { kind: 'label', layer: labelLayer, paneName, zIndex, order, bindTo, visible: true, enabled: true }
    this.#layers.set(id, record)

    const bind = () => this.#bindLabels(id, record, { bindTo, textOf, accessors, source: cfg.source })
    if (!bind()) this.#pendingBinds.push({ id, bind })           // host no existe aún → reintentar al crearlo

    return {
      id,
      setLabels:  labels => labelLayer.setLabels(labels),
      setHovered: ids => labelLayer.setHovered(ids),
      setVisible: v => {
        const wasHidden = !record.visible
        record.visible = v
        // Al re-habilitar: refrescar los labels con el estado actual ANTES de que el overlay pinte
        // (setVisibility(true)→setEnabled(true)→requestRedraw). Así no hay flash de contenido viejo.
        if (v && wasHidden) record.resync?.()
        // Compone la membresía del host (bindTo): con el host deshabilitado como ENTIDAD, el toggle
        // del consumidor sólo registra su intención (record.visible) — el pane no se muestra hasta
        // que setLayerEnabled(true) lo restaure (y resyncee el contenido). Sin esto, prender labels
        // con el host deshabilitado re-mostraría el canvas con lo último pintado (labels fantasma).
        const host = record.bindTo ? this.#layers.get(record.bindTo) : null
        labelLayer.setVisibility(v && (!host || host.enabled))
      },
    }
  }

  /* ── Cluster (fold): agrupa N capas de puntos en UN clustering y comparte la supresión ── */

  // Clusteriza el conjunto UNIÓN de varios hosts en un solo supercluster y reparte el MISMO
  // set `suppressed` (ref estable, mutado in place) a TODOS los hosts y a sus ligados (labels +
  // overlays, que leen `host.suppressed`). El <cristae-cluster> declarativo entra por acá vía el
  // reductor de la gramática; `addCluster` (un host) es azúcar imperativa que delega.
  addClusterFold(targets, opts = {}) {
    return createClusterFold(this.#foldBridge(), targets, opts)
  }

  // Puente hacia los servicios del motor que necesita el fold (ClusterFold). El fold vive en su propio
  // módulo y NO accede a los privados del motor: pide sus capacidades por esta interfaz acotada.
  #foldBridge() {
    return {
      camera:            this.#host.camera,
      layerOf:           id => this.#layers.get(id),
      nextOrder:         () => this.#order++,
      overlayZ:          (order, extra) => BASE_Z + order * Z_STEP + LABEL_Z_OFFSET + extra,   // z de las capas del fold: sobre los labels (+200)
      subAccent:         SUB_ACCENT,                                                           // acento default de la traza spiderfy
      makeBubbleSink:    (bubble, pane, order, foldId, interactive) => this.#makeBubbleSink(bubble, pane, order, foldId, interactive),
      subClusterIconSet: accent => this.#subClusterIconSet(accent),
      addPointLayer:     cfg => this.addPointLayer(cfg),
      addLineLayer:      (cfg, order) => this.#addLine(cfg, order),
      removeLayer:       id => this.removeLayer(id),
      resyncBound:       id => this.#resyncBound(id),
      focus:             (ids, options) => this.focus(ids, options),
      unfocusAll:        () => this.unfocusAll(),
      emit:              (event, detail) => this.#emit(event, detail),
      busOn:             (type, layerId, handler) => this.#bus.on(type, layerId, handler),
      destroying:        () => this.#destroying,
    }
  }

  // Azúcar imperativa de un solo host (la usa addPointLayer({cluster}) y el path imperativo).
  addCluster({ hostId, radius, maxZoom, minPoints, bubble } = {}) {
    const r = this.addClusterFold([{ id: hostId }], { radius, maxZoom, minPoints, bubble })
    return r ? r.handle.control : null
  }

  /* ── Overlay: badge ligado a un host de puntos (sigue su data + su supresión de cluster) ── */

  addOverlay({ id, hostId, iconSet, variantOf, sizeOf, where, visible = true }) {
    const host = this.#layers.get(hostId)
    if (!host || host.kind !== 'point') return null

    const order    = this.#order++
    const paneName = `${host.paneName}-overlay-${order}`
    const zIndex   = BASE_Z + host.order * Z_STEP + 7        // sobre el host (y sobre la burbuja, +5)

    // Comparte la Source del host (mismo dato → move/patch en vivo) pero RENDERIZA con
    // accessors propios (badge, sin rotar) y filtra con `where` (sólo los que tienen badge).
    const accessors = { ...host.source.accessors }
    if (variantOf) accessors.variantOf = variantOf
    if (sizeOf) accessors.sizeOf = sizeOf
    accessors.headingOf = null                              // el overlay no rota (badge de esquina)

    // Membresía del overlay = la del HOST ∧ la propia. `host.where` se lee VIVO, así que un cambio de
    // membresía del host arrastra al badge sin que el consumidor lo espeje (su `resync` refresca).
    let propio = where ?? null
    const membresia = item => (!host.where || host.where(item)) && (!propio || propio(item))

    const set   = this.#resolveIconSet(iconSet)
    const layer = this.#build(paneName, zIndex, () => this.#trackGl(new PointLayer({
      host: this.#host, pane: paneName, source: host.source,
      accessors, iconSet: set, interactive: false, where: membresia,
    })))
    layer.suppressed = host.suppressed ?? null               // hereda la supresión del cluster (si la hay)
    layer.refresh()

    const record = {
      kind: 'overlay', source: host.source, layer, paneName, order, bindTo: hostId, visible, enabled: true,
      // el cluster reinvoca esto al re-suprimir (#resyncBound): re-apunta al ref vivo del host + reconstruye.
      resync: () => { layer.suppressed = this.#layers.get(hostId)?.suppressed ?? null; layer.refresh() },
    }
    this.#layers.set(id, record)
    this.#applyVisibility(id, paneName, visible && host.enabled)   // ligado: nace oculto si su host está deshabilitado
    if (!host.enabled) layer.enabled = false                       // y gateado (setLayerEnabled(true) lo revive con resync)

    return {
      id,
      get source() { return record.source },
      get layer() { return record.layer },
      refresh:    () => layer.refresh(),
      setWhere:   fn => { propio = fn ?? null; layer.refresh() },   // se compone con la del host, no la pisa
      setVisible: v => this.setLayerVisibility(id, v),
    }
  }

  /* ── Overlay de interacción: realce por-id como PASE DE COMPOSICIÓN SEPARADO ── */
  // El estado de interacción (selección/seguimiento) NO se hornea en la variante del sprite —eso
  // multiplica los tiles del atlas y ata el realce a la rotación del ícono—: se dibuja en un canvas 2D
  // propio anclado a la posición VIVA del host, O(K) sobre los pocos ids resaltados. Agnóstico: el
  // consumidor pasa `drawHighlight(ctx, size, key)` (su anillo/retículo) y `setHighlighted(Map<id,key>)`.
  // El canvas vive en un PANE bajo mapPane (no fijo al contenedor): así CABALGA el mismo transform CSS
  // que la capa de puntos durante pan/zoom → los retículos no se desfasan de los sprites. Un canvas fijo
  // al contenedor tenía que reproyectar por frame, y su redibujo (rAF) quedaba 1 frame detrás del
  // compositor que ya movió los puntos → esa era la "vibración". Ahora se reposiciona por `translate3d`
  // al origen del viewport (igual patrón que HeatLayer/LabelLayer) y sólo reasienta en moveend/zoomend/
  // resize; entre redibujos el pane lo lleva. pointer-events:none (el picking es del host GPU). El dato
  // entra por la Source del host (misma fuente → sin desincronía ni "fantasma").
  addHighlightOverlay({ id, layerId, drawHighlight, z } = {}) {
    const host = this.#layers.get(layerId)
    if (!host || host.kind !== 'point' || typeof drawHighlight !== 'function') return null

    const source  = host.source
    const iconSet = host.iconSet
    const sizeOf  = source.accessors.sizeOf
      ? item => source.accessors.sizeOf(item)
      : () => iconSet?.defaultSize ?? 32

    const hostCamera = this.#host.camera
    const surface    = this.#host.surface
    const paneName   = `cristae-highlight-${id ?? layerId}`
    const pane       = this.#mount(paneName, z ?? BASE_Z + 250)

    const canvas = document.createElement('canvas')
    canvas.style.position      = 'absolute'
    canvas.style.pointerEvents = 'none'
    pane.appendChild(canvas)
    const ctx = canvas.getContext('2d')

    const dpr = Math.min((typeof window !== 'undefined' && window.devicePixelRatio) || 1, 2)
    let cssW  = 0, cssH = 0
    // Reposiciona el canvas al top-left del viewport en coords de capa (el pane se traslada con el mapa en
    // pan → el canvas queda fijo al viewport) y lo redimensiona sólo si cambió (setear width lo limpia).
    // El buffer va en px de dispositivo y la CAJA en px CSS: sin caja el canvas MIDE su buffer, y el pase
    // entero sale a dpr× de su lugar —el realce deja de caer sobre su sprite— además de borroso.
    const reposition = () => {
      const r = surface.container.getBoundingClientRect()
      if (r.width !== cssW || r.height !== cssH) {
        cssW                = r.width
        cssH                = r.height
        canvas.width        = Math.round(cssW * dpr)
        canvas.height       = Math.round(cssH * dpr)
        canvas.style.width  = `${cssW}px`
        canvas.style.height = `${cssH}px`
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      }
      const origin = hostCamera.frameOrigin()
      canvas.style.transform = frameTransform(origin.x, origin.y)
    }
    reposition()

    const overlay = createHighlightOverlay({
      source,
      project: (lat, lng) => this.camera.latLngToContainerPoint([lat, lng]),
      ctx,
      clear: () => { reposition(); ctx.clearRect(0, 0, cssW, cssH) },   // reasienta el pane antes de dibujar
      drawHighlight,
      sizeOf,
      schedule: fn => requestAnimationFrame(fn),
    })

    // Pan y settle de zoom: reasienta a la vista viva.
    const offView = hostCamera.on('moveend zoomend resize', () => overlay.onViewportChange())

    const entry = {
      // Mismo cálculo que la matriz GL del sprite, para que el tratamiento caiga exacto sobre su punto.
      renderAtView: (z, c) => {
        const size     = hostCamera.size()
        const centerPx = hostCamera.project(c, z)
        overlay.renderAtView((lat, lng) => {
          const p = hostCamera.project([lat, lng], z)
          return { x: p.x - centerPx.x + size.x / 2, y: p.y - centerPx.y + size.y / 2 }
        })
      },
      dispose: () => {
        offView()
        overlay.destroy()
        canvas.remove()
        surface.unmount(paneName)
        this.#highlightOverlays.delete(entry)
      },
    }
    this.#highlightOverlays.add(entry)

    return {
      id,
      setHighlighted: highlighted => overlay.setHighlighted(highlighted),
      redraw:         () => overlay.redraw(),
      resize:         reposition,
      destroy:        entry.dispose,
    }
  }

  /* ── Fuentes externas (ruta B) ── */

  attachSource(id, source) {
    const record = this.#layers.get(id)
    if (!record || record.kind !== 'point') return this
    record.layer.destroy()
    record.source   = source
    record.controls = null
    record.layer    = this.#trackGl(new PointLayer({
      host: this.#host, pane: record.paneName, source, iconSet: record.iconSet, interactive: record.interactive, where: record.where,
    }))
    if (!record.enabled) record.layer.enabled = false   // el swap conserva el gate de la entidad deshabilitada
    if (record.interactive) {
      // La capa del pase es la MISMA entidad con otra fuente: conserva su id de objeto (no se recicla).
      const entry = this.#pick.entries.find(e => e.layerId === id)
      if (entry) { entry.layer = record.layer; record.layer.pickObject = entry.obj }
    }
    return this
  }

  /* ── Acceso y lifecycle ── */

  getLayer(id) { return this.#layers.get(id) ?? null }

  // Capa dueña de un objeto del pase de picking: el decodificador entrega (obj, chunk, local) y esto
  // resuelve el primer eje. Devuelve la entrada del pase ({ layerId, layer, obj }), o null si el id
  // no está asignado.
  pickLayerOf(obj) { return this.#pick.byObj.get(obj) ?? null }

  removeLayer(id) {
    const record = this.#layers.get(id)
    if (!record) return false
    record.unsub?.()                      // bind de labels / suscripción de la capa
    record.layer?.destroy?.()
    record.editor?.destroy?.()            // editor de geometría (input controlado, sin record.layer)
    record.controls?.destroy()
    record.cluster?.dispose()             // libera burbujas + sibling y su listener de zoom
    const declarabaFoco = this.#itemFocus.delete(id)
    this.#registry.removeByLayerId(id)
    this.#removePickLayer(id)
    this.#bus.clearLayer(id)
    this.#layers.delete(id)
    // La superficie cuenta quién sostiene cada pane: el propio de la capa se va con ella, y uno
    // compartido por varias con el mismo `cfg.pane`, con la última.
    record.paneName && this.#host.surface.unmount(record.paneName)
    declarabaFoco && this.#applyFocus()
    return true
  }

  setLayerVisibility(id, visible = true) {
    const record = this.#layers.get(id)
    if (!record) return false
    // `visible` (pintado) se persiste para componer con `enabled` (membresía de la entidad): la
    // visibilidad EFECTIVA del pane es visible ∧ enabled — el propio para hosts, el del host para
    // ligados (bindTo). Los labels mantienen su flag por su canal propio (gate del sync, #bindLabels).
    if (record.kind !== 'label') record.visible = visible
    const host      = record.bindTo ? this.#layers.get(record.bindTo) : null
    const effective = visible && record.enabled && (!host || host.enabled)
    this.#applyVisibility(id, record.paneName, effective)
    record.layer?.setVisible?.(effective)      // una capa que dibuja sola no se apaga ocultando el pane
    if (!effective) this.#bus.clearLayer(id)
    return true
  }

  // Habilita/deshabilita una capa de puntos como ENTIDAD de la composición — eje ortogonal a
  // `visible` (pintado puro): deshabilitada aporta ∅ a los modificadores que la consumen (un
  // cluster que la envuelva re-indexa sin sus puntos y recomputa las burbujas), su pane se
  // oculta, su picking se limpia y sus LIGADOS (labels/overlays bind-to) se ocultan con ella.
  // Habilitarla restaura todo (resync + reindex incluidos). Idempotente; NO toca la Source —
  // los datos siguen vivos (move/patch del WS) y al volver, la capa aparece al día.
  setLayerEnabled(id, enabled = true) {
    const record = this.#layers.get(id)
    if (!record || record.kind !== 'point') return false
    const next = enabled
    if (record.enabled === next) return true
    record.enabled = next
    // Gate del pipeline de render: deshabilitada, la capa NO reacciona a la Source (cero CPU/GPU
    // por emit del WS — el ahorro real de "deshabilitar", no sólo ocultar). refresh() abajo es el
    // catch-up al volver (la Source siguió viva mientras tanto).
    record.layer.enabled = next
    this.#applyVisibility(id, record.paneName, next && record.visible)
    if (!next) this.#bus.clearLayer(id)
    // Ligados: siguen la suerte de la ENTIDAD (un badge/label de un host deshabilitado no queda
    // flotando solo). Componen su propio `visible` — re-habilitar no revive lo que el consumidor
    // ocultó por su toggle. Los labels van por su canal nativo (setVisibility: pane + gate de
    // pintado JUNTOS — su canvas retiene lo último pintado, ocultar sólo el pane desalinearía el
    // gate al componer con su propio toggle); los overlays gatean su pipeline y ocultan su pane.
    this.#layers.forEach((r, rid) => {
      if (r.bindTo !== id) return
      const on = next && r.visible
      if (r.kind === 'label') r.layer.setVisibility(on)
      else {
        if (r.kind === 'overlay') r.layer.enabled = next
        this.#applyVisibility(rid, r.paneName, on)
      }
    })
    this.#resyncBound(id)               // labels re-filtran + overlays refrescan (gateados por enabled → al volver, frescos)
    if (next) record.layer.refresh()    // catch-up del host (para capas SIN cluster es LA vía; con cluster el apply() de abajo re-refresca — costo 1 rebuild por toggle)
    record.cluster?.reindex()           // el fold recomputa las burbujas con la unión de hosts habilitados
    return true
  }

  on(event, layerIdOrCb, maybeCb) {
    if (BUS_EVENTS.has(event)) return this.#bus.on(event, layerIdOrCb, maybeCb)
    const cb = typeof layerIdOrCb === 'function' ? layerIdOrCb : maybeCb
    let set  = this.#signals.get(event)
    if (!set) this.#signals.set(event, set = new Set())
    set.add(cb)
    return () => set.delete(cb)
  }

  registerIconSet(name, set) { this.#iconSets.set(name, set); return this }

  // Rasteriza un descriptor suelto a un canvas vía un `draw(ctx, size)` provisto. Genérico, sin dominio.
  createIcon({ size = 32, draw } = {}) {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = size
    if (draw) draw(canvas.getContext('2d'), size)
    return canvas
  }

  setTileProvider(tile) {
    this.#host.tiles.setProvider(tile)
    return this
  }

  // La atribución del proveedor vigente, tal como la dio —HTML, como en Leaflet—, o `null`. El mapa no la
  // dibuja: la dibuja quien lo usa (docs/tiles.md#la-atribución).
  getTileAttribution() { return this.#host.tiles.attribution() }

  // Política de animación del zoom, en vivo (SPECS §9). Aplica desde el zoom siguiente; no reconstruye
  // capas ni pierde su cableado.
  setZoomAnimation(mode) {
    this.#host.camera.zoomPolicy = mode
    return this
  }

  // Límites de la cámara, en vivo (SPECS §9): fija los cuatro, y el que no viene no limita.
  setLimits(limits) {
    this.#host.camera.setLimits(limitsOf(limits))
    return this
  }

  // Cursor del contenedor que pide el consumidor, en vivo. Interaction lo normaliza y lo arbitra: qué
  // cuenta como ninguno y su precedencia, en docs/interaction.md#el-cursor-del-contenedor.
  setCursor(cursor) {
    this.#interaction.cursor = cursor
    return this
  }

  // Fuera de contrato: el mapa de Leaflet es un detalle del anfitrión y lo que se haga con él no lo cubre
  // ninguna garantía. Devuelve el mapa y avisa una vez por motor; se retira en 1.0.
  getLeafletMap() {
    this.#leafletWarned || console.warn(
      '[cristae] getLeafletMap() está fuera de contrato y se retira en 1.0: el mapa de Leaflet es un ' +
      'detalle interno. La cámara, los tiles y el cursor se piden al motor (docs/elements.md).')
    this.#leafletWarned = true
    return this.#host.map
  }

  // Resize del contenedor: recalcula el tamaño con el ancla fija, reajusta el picking FBO y resetea las
  // capas GL (un resize simétrico no desplaza el centro, así que ninguna se redibuja sola).
  syncSize() {
    this.#host.camera.invalidateSize()
    this.#pick.entries.forEach(({ layer }) => layer.syncPickingSize())
    this.#resetCanvases()
  }

  // Reposiciona y redibuja todas las capas de puntos de este motor. Escape hatch manual: el
  // <cristae-map> ya se auto-cura en resize y en show tras display:none vía su ResizeObserver →
  // syncSize(). Útil en el path headless (MapEngine sin elemento, sin observer) o si el contenedor
  // vuelve a ser visible sin cambiar de tamaño (no dispara resize).
  invalidateCanvas() { this.#resetCanvases() }

  // Encuadra por los bounds de VARIAS capas a la vez (`ids`, o TODAS si se omite) — la contraparte
  // multi-capa de camera.fitToLayer (una sola). Une la geometría de cada Source según su tipo
  // (positionOf | pathOf | ringsOf), y la caja propia de la capa que no tenga Source. One-shot;
  // respeta insets/maxZoom, y sin ninguna posición no encuadra.
  fitToLayers(ids = null, { insets, maxZoom } = {}) {
    const box       = emptyBounds()
    const growTyped = v => {                     // tipado plano, intercalado [lat, lng, …]
      for (let i = 0; i + 1 < v.length; i += 2) growBounds(box, v[i], v[i + 1])
    }
    // Una coordenada de positionOf o ringsOf llega como `{lat,lng}`, `[lat,lng]`, un anidado, un
    // iterable o un tipado plano. Se recorre sin materializar pares.
    const walk = v =>
      ArrayBuffer.isView(v)        ? growTyped(v)
      : Array.isArray(v)           ? (typeof v[0] === 'number' ? growBounds(box, v[0], v[1]) : v.forEach(walk))
      : typeof v?.lat === 'number' ? growBounds(box, v.lat, v.lng)
      : iterable(v)                ? [...v].forEach(walk)
      : undefined
    const recs = ids ? [...ids].map(id => this.#layers.get(id)) : [...this.#layers.values()]
    recs.forEach(r => {
      const b = r?.layer?.bounds                 // capa sin Source: su geometría es fija y la informa ella
      if (b) { growBounds(box, b.south, b.west); growBounds(box, b.north, b.east); return }
      if (!r?.source) return

      const { accessors: a, getSnapshot } = r.source
      // pathOf se lee con el contrato de path de las líneas —sus formas de punto y su regla de corte—:
      // el encuadre cubre los tramos que la capa dibuja. Ahí una vista tipada es un vértice, no un plano.
      getSnapshot().forEach(it =>
        a.positionOf ? walk(a.positionOf(it))
        : a.pathOf   ? foldRuns(a.pathOf(it), growRun, box)
        : walk(a.ringsOf(it)))
    })
    this.camera.fitBounds(box, { insets, maxZoom })
    return this
  }

  destroy() {
    if (this.#destroying) return
    this.#destroying = true
    ;[...this.#highlightOverlays].forEach(e => e.dispose())
    this.#interaction.destroy()
    this.camera.destroy()
    this.#layers.forEach((_, id) => this.removeLayer(id))
    this.#signals.clear()
    this.#host.destroy()
  }

  /* ── Internos ── */

  // Reposiciona/redibuja las capas GL inscritas en paneo y zoom.
  // En `move` solo si el marco se desplazó de verdad; durante el zoom lo gobierna el cierre del gesto.
  #wireRenderLifecycle() {
    const hostCamera = this.#host.camera
    let zooming      = false
    let lastX        = NaN, lastY = NaN
    hostCamera.on('zoomstart', () => zooming = true)
    hostCamera.on('zoomend', () => {
      zooming = false; lastX = NaN; lastY = NaN
      this.#forEachGlLayer(layer => layer.resetCanvasReference())
    })
    hostCamera.on('move', () => {
      if (zooming) return
      const { x, y } = hostCamera.frameOrigin()
      if (x === lastX && y === lastY) return
      lastX = x; lastY = y
      this.#forEachGlLayer(layer => layer.resetCanvasReference())
    })
    hostCamera.on('moveend', () => {
      lastX = NaN; lastY = NaN
      this.#forEachGlLayer(layer => layer.resetCanvasReference())
    })
  }

  // Zoom animado: reproyecta POR FRAME a la vista interpolada (tamaño de sprite/retículo fijo, alineado
  // con los tiles), en vez de dejar que el canvas escale con la transición CSS de Leaflet. Alcanza a las
  // capas GL (cuya superficie no sigue esa transición) y a los overlays de interacción vía renderAtView.
  // Sincronizado al easing del tile (~cubic-bezier(0,0,.25,1), 250ms). `zoomanim` trae la vista destino
  // y sale antes de que la vista cambie: la de la cámara es todavía la de partida.
  #wireZoomReproject() {
    const hostCamera = this.#host.camera
    const ease       = t => 1 - (1 - t) ** 3          // aprox. del cubic-bezier(0,0,.25,1) del tile de Leaflet
    const DUR        = 250
    let raf          = 0
    hostCamera.on('zoomanim', ({ center: c1, zoom: z1 }) => {
      const z0 = hostCamera.zoom()
      const c0 = hostCamera.center()
      const t0 = performance.now()
      cancelAnimationFrame(raf)
      const step = () => {
        const k = ease(Math.min((performance.now() - t0) / DUR, 1))
        const z = z0 + (z1 - z0) * k
        const c = { lat: c0.lat + (c1.lat - c0.lat) * k, lng: c0.lng + (c1.lng - c0.lng) * k }
        this.#forEachGlLayer(l => l.renderAtView?.(z, c))
        this.#highlightOverlays.forEach(o => o.renderAtView?.(z, c))   // el realce sigue a su sprite por frame
        if (k < 1) raf = requestAnimationFrame(step)
      }
      raf = requestAnimationFrame(step)
    })
    // Al asentar: corta la interpolación y deja que cada capa se re-proyecte nítida a la vista final.
    hostCamera.on('zoomend', () => { cancelAnimationFrame(raf); this.#forEachGlLayer(l => l.resetCanvasReference()) })
  }

  // Inscribe una capa GL (un canvas propio que nadie más reproyecta) en el set que el ciclo de
  // render recorre en move/zoom/resize, y envuelve su destroy() para darla de baja sola. ÚNICO punto
  // de alta/baja: cualquier capa GL —PointLayer hoy (punto, overlay, burbuja de cluster); otra
  // entidad/modificador GL mañana— se inscribe pasando por acá al CREARSE, sin enumerar `kind`s ni
  // escanear todas las capas en el hot-path. Las que se reproyectan solas —etiquetas, calor y los
  // sustratos `gpu` de líneas y polígonos— no pasan por acá. (#2)
  #trackGl(layer) {
    this.#glLayers.add(layer)
    const destroy = layer.destroy.bind(layer)
    layer.destroy = () => { this.#glLayers.delete(layer); destroy() }
    return layer
  }

  // Recorre SÓLO las capas GL inscritas (sin escanear #layers): reproyección en move/zoom/resize.
  #forEachGlLayer(fn) { this.#glLayers.forEach(fn) }

  #resetCanvases() {
    this.#forEachGlLayer(layer => layer.resetCanvasReference())
  }

  /* ── Registro de capas de pick: la sesión de picking y la identidad de OBJETO del pase ── */

  // Alta en el pase: id de objeto de la free-list (o el siguiente sin estrenar) y entrada indexada por
  // él. Agotado el rango la capa entra con obj 0, que el pase saltea: degrada a «no pickeable», nunca
  // a un hit atribuido a otra capa.
  #addPickLayer(layerId, layer) {
    const p     = this.#pick
    const obj   = p.free.pop() ?? (p.next <= PICK_OBJ_MAX ? p.next++ : 0)
    const entry = { layerId, layer, obj }
    layer.pickObject = obj
    p.entries.push(entry)
    obj && p.byObj.set(obj, entry)
    return entry
  }

  // Baja: la entrada sale del pase y su id vuelve a la free-list.
  #removePickLayer(layerId) {
    const p = this.#pick
    const i = p.entries.findIndex(e => e.layerId === layerId)
    if (i < 0) return
    const [entry] = p.entries.splice(i, 1)
    p.byObj.delete(entry.obj)
    entry.obj && p.free.push(entry.obj)
  }

  #registerResolver(id, kind, zIndex, order, resolveClick, resolveHover, overlay) {
    this.#registry.upsertResolver({ layerId: id, kind, zIndex, declOrder: order, resolveClick, resolveHover, visible: true, capture: overlay?.capture, presentAs: overlay?.presentAs })
    this.#registry.setLayerDemandMask(id, this.#bus.demandMaskFor(id))
    this.#interaction.syncHoverDemand()
  }

  // IconSet por instancia o por nombre registrado. Un nombre no registrado es error de config.
  #resolveIconSet(iconSet) {
    if (typeof iconSet !== 'string') return iconSet
    const set = this.#iconSets.get(iconSet)
    if (!set) throw new Error(`[MapEngine] iconSet '${iconSet}' no registrado`)
    return set
  }

  #syncDemand(layerId) {
    const ids = layerId == null ? this.#registry.layerIds() : [layerId]
    ids.forEach(id => this.#registry.setLayerDemandMask(id, this.#bus.demandMaskFor(id)))
    this.#interaction.syncHoverDemand()
  }

  // Cablea UNA vez por iconSet: cuando el font-gate re-rasteriza el atlas (una fuente web terminó de
  // cargar) las capas GL re-encodan para subir la generación nueva a la GPU — sin esto la corrección del
  // atlas queda sólo en CPU. onAtlasRefresh sólo existe en iconSets con font-gate (guard por `?.`).
  #hookFontGate(set) {
    if (!set || this.#fontHooked.has(set)) return
    this.#fontHooked.add(set)
    set.onAtlasRefresh?.(() => this.#forEachGlLayer(l => l.refresh?.()))
  }

  // Sin puntero: el picking es propio, no del nodo que queda bajo el cursor.
  #mount(name, zIndex) {
    return this.#host.surface.mount(name, zIndex, { pointer: false })
  }

  // Una capa entra con su pane: se monta y la capa se construye colgada de él. Lo que valida la
  // configuración —la Source, el iconSet, el sustrato— va antes, y lanza sin haber montado nada. Lo que
  // lanza al construir —un sustrato GPU sin WebGL2, que el consumidor puede degradar a otro, o su propio
  // código— deja la capa sin registro ni `removeLayer` que suelte el pane: se suelta acá.
  #build(paneName, zIndex, create) {
    this.#mount(paneName, zIndex)
    try {
      return create()
    } catch (error) {
      this.#host.surface.unmount(paneName)
      throw error
    }
  }

  #applyVisibility(id, paneName, visible) {
    this.#host.surface.setVisible(paneName, visible)
    this.#registry.setLayerVisibility(id, visible)
  }

  /* ── Enfoque / atenuado de capas (primitivo general) ── */
  // `focus(ids)` deja esas capas a opacidad plena y ATENÚA el resto (opacidad `opacity`); sirve para
  // destacar un subconjunto (p. ej. el spider al expandir un cluster). `unfocus(ids)` las saca del
  // conjunto brillante (se re-atenúan); `unfocusAll()` restaura todo. La capa nombrada queda EXENTA
  // también del eje de foco por ítem.
  // Idempotente (recomputa desde cero). Cubre por id de capa, y las patas del spider son una capa de
  // líneas más: el foco del fold las deja plenas porque sólo atenúa marcadores, etiquetas y overlays,
  // pero uno sin `kinds` las atenúa junto con el resto. `kinds` acota QUÉ capas se atenúan (por kind:
  // 'point'/'label'/'polygon'…); null = todas. Ej: atenuar sólo marcadores dejando las geocercas de
  // contexto intactas → `focus(ids, { kinds: ['point', 'label'] })`.
  focus(ids, { opacity = 0.3, kinds = null } = {}) {
    this.#focused    = new Set(ids)
    this.#dimOpacity = opacity
    this.#focusKinds = kinds
    this.#applyFocus()
  }

  unfocus(ids) {
    if (!this.#focused) return
    ids.forEach(id => this.#focused.delete(id))
    // Vaciar el set de resaltados equivale a "sin foco": restaurar todo. Sin esto, un `#focused` vacío
    // (pero no null) dejaría a #applyFocus atenuando TODAS las capas (ninguna en el set brillante).
    if (this.#focused.size) this.#applyFocus()
    else this.unfocusAll()
  }

  unfocusAll() {
    if (!this.#focused) return
    this.#focused    = null
    this.#focusKinds = null      // el alcance muere con el foco que lo declaró
    this.#applyFocus()
  }

  setLayerOpacity(id, alpha) {
    const rec = this.#layers.get(id)
    if (rec?.paneName) this.#host.surface.setOpacity(rec.paneName, alpha)
  }

  // `z` nulo vuelve al derivado en el alta.
  setLayerZ(layerId, z) {
    const record = this.#layers.get(layerId)
    const zIndex = z ?? record?.zIndex
    record && zIndex != null && this.#host.surface.setZ(record.paneName, zIndex)
    return this
  }

  /* ── Enfoque por ÍTEM. `ids` iterable | falsy (ninguno) | undefined (se retira). ── */
  setLayerFocus(layerId, ids) {
    if (!this.#layers.has(layerId)) return this
    if (ids === undefined) this.#itemFocus.delete(layerId)
    else this.#itemFocus.set(layerId, new Set(ids || []))
    this.#applyFocus()
    return this
  }

  // Composición de los dos ejes de foco: el eje por CAPA EXIME (la capa que `focus()` nombra queda plena
  // y fuera del eje por ítem); brillantes son los ítems declarados más los que el cluster reveló; la capa
  // que no sabe atenuar por feature —o no tiene nada que salvar— atenúa su pane entero.
  #applyFocus() {
    const porItem    = this.#itemFocus.size > 0
    const brillantes = key => {
      const propios   = this.#itemFocus.get(key)
      const revelados = this.#layers.get(key)?.revealed
      return revelados?.size ? new Set([...(propios ?? []), ...revelados]) : propios
    }
    for (const [id, rec] of this.#layers) {
      if (!rec.paneName) continue
      // Las capas LIGADAS a un host (labels/overlays con bindTo) siguen su suerte de foco: un
      // badge no queda brillante sobre un marcador atenuado ni atenuado sobre uno enfocado.
      const key     = rec.bindTo ?? id
      const porCapa = !!this.#focused && (!this.#focusKinds || this.#focusKinds.includes(rec.kind))
      const exenta  = porCapa && this.#focused.has(key)
      const atenua  = !exenta && (porCapa || porItem)
      const dim     = porCapa ? this.#dimOpacity : ITEM_DIM
      const brillan = atenua ? brillantes(key) : null
      const exacto  = brillan?.size && rec.layer?.applyFocus?.(brillan, dim)
      if (!exacto) rec.layer?.applyFocus?.(null)
      this.#host.surface.setOpacity(rec.paneName, exacto || !atenua ? 1 : dim)
    }
  }

  #pointHandle(id, record, iconSet) {
    const { controls } = record
    record.iconSet = iconSet
    return {
      id,
      get source() { return record.source },
      get layer() { return record.layer },
      set:          items => controls?.set(items),
      patch:        (items, dirtyIds) => controls?.patch(items, dirtyIds),
      move:         (itemId, lat, lng) => controls?.move(itemId, lat, lng),
      remove:       itemId => controls?.remove(itemId),
      addFilter:    f => controls?.addFilter(f),
      removeFilter: fid => controls?.removeFilter(fid),
      // Membresía declarativa por-capa: cambia el predicado `where` y reconstruye SOLO esta
      // capa (no toca la Source compartida → otras vistas no se ven afectadas). Lee record.layer
      // (no captura) porque attachSource puede swapear la capa. Espejo del setWhere del overlay.
      // Además persiste el `where` en el record y RE-INDEXA el cluster que envuelve esta capa (si lo
      // hay): el cluster indexa `source ∧ where`, y un cambio de `where` no emite en la Source → sin
      // esto los conteos de burbuja quedarían obsoletos (mostrarían la flota completa, no la filtrada).
      // …y resincroniza los LIGADOS (labels/overlays): heredan la membresía del host, y un cambio de
      // `where` no emite en la Source, así que sin esto quedarían etiquetas de ítems ya no visibles.
      setWhere:     fn => { record.where = fn ?? null; record.layer.where = fn; record.layer.refresh(); record.cluster?.reindex(); this.#resyncBound(id) },
      preloadIcons: variants => iconSet?.seed(variants),
      setFocus:     ids => this.setLayerFocus(id, ids),
      refresh:      () => record.layer.refresh(),
      setVisible:   v => this.setLayerVisibility(id, v),
      // Membresía de la ENTIDAD en la composición (eje ortogonal a setVisible, que es pintado
      // puro): off → la capa aporta ∅ a sus modificadores (el cluster re-indexa sin ella), pane
      // oculto, picking limpio y ligados ocultos. Ver setLayerEnabled.
      setEnabled: v => this.setLayerEnabled(id, v),
    }
  }

  // Burbuja parametrizable: el consumidor define CÓMO se ven los clusters (capa de puntos con
  // icon-set de cluster, o capa de labels con el conteo), o usa el default. El sink expone
  // `feed(bubbles)` (la forma de alimentar varía por tipo) y `dispose`.
  // interactive: true cuando expandable está activo (las burbujas reciben clicks de expand/collapse).
  #makeBubbleSink(bubble, bubblePane, order, hostId, interactive = false) {
    const siblingId = `${hostId}:clusters`
    const zIndex    = BASE_Z + order * Z_STEP + LABEL_Z_OFFSET + 5   // burbujas sobre los labels (+200)
    const spec      = bubble ?? { kind: 'point' }

    if (spec.kind === 'label') {
      const layer  = this.#build(bubblePane, zIndex, () =>
        new LabelLayer({ host: this.#host, pane: bubblePane, paint: spec.paint, style: spec.style }))
      const textOf = spec.textOf ?? (count => String(count))
      this.#layers.set(siblingId, { kind: 'label', layer, paneName: bubblePane, order, visible: true, enabled: true })
      return {
        feed:    bubbles => layer.setLabels(bubbles.map(b => ({ id: b.id, lat: b.lat, lng: b.lng, text: textOf(b.count) }))),
        dispose: () => this.removeLayer(siblingId),
      }
    }

    const iconSet  = this.#resolveIconSet(spec.iconSet) ?? this.#clusterBubbleIconSet(spec)
    const controls = createSource({
      idOf:       b => b.id,
      positionOf: b => ({ lat: b.lat, lng: b.lng }),
      // Burbuja expandida (spiderfy) → variante atenuada; burbuja con ids marcados → variante
      // resaltada. SÓLO si el iconSet las soporta (default sí; custom sin `expandedVariant`/
      // `markedVariant` cae al sprite normal — no rompe). Expandida gana sobre marcada: sus hojas
      // ya están desplegadas a la vista, el resalte sería redundante.
      variantOf: b => (b.expanded && iconSet.expandedVariant)
        ? iconSet.expandedVariant(b.count)
        : (b.marked && iconSet.markedVariant)
          ? iconSet.markedVariant(b.count)
          : (iconSet.variantForCount?.(b.count) ?? String(b.count)),
      sizeOf: spec.sizeOf,
      // hashOf explícito: el default (=idOf) NO marcaría dirty al togglear `expanded`/`marked`
      // (mismo id, mismo count, misma pos) → el restyle no se re-renderizaría. Incluye count/
      // estado/pos para que cualquiera de esos cambios re-encode el sprite de la burbuja.
      hashOf: b => `${b.count}:${b.expanded ? 'd' : b.marked ? 'm' : ''}:${b.lat}:${b.lng}`,
    }, iconSet.variants)
    const layer = this.#build(bubblePane, zIndex, () =>
      this.#trackGl(new PointLayer({ host: this.#host, pane: bubblePane, source: controls, iconSet, interactive })))
    this.#layers.set(siblingId, {
      kind: 'point', source: controls, layer, controls, paneName: bubblePane, order, interactive,
      visible: true, enabled: true,
    })
    if (interactive) {
      this.#addPickLayer(siblingId, layer)
      // La burbuja ocluye lo que tiene debajo (capa overlay): su click no se filtra a geocercas/puntos.
      // Hover real (demand-gated: sólo computa si alguien se suscribe) → la burbuja es una entidad
      // consultable como cualquier otra: hits por el bus + contentsOf del control.
      this.#registerResolver(siblingId, 'point', zIndex, order, sample => layer.resolveClick(sample), sample => layer.resolveHover(sample), { capture: true })
    }
    return {
      // feed SINCRÓNICO con el recluster: set() deja el Store al día ya, y refresh() reconstruye
      // buffers + #idBySlot + picking EN EL MISMO TICK (la emisión del Source va a rAF, el rebuild
      // acá no espera). Sin el refresh, un cluster-id viejo que colisione numéricamente con uno nuevo
      // (los ids de Supercluster son densos) pasaría la guarda de itemById y getLeaves resolvería
      // OTRO cluster. El #onChange del rAF posterior re-camina los dirty ya escritos (idempotente,
      // n = nº de burbujas). Simétrico con los hosts (apply) y el spider (applySpider).
      feed: bubbles => { controls.set(bubbles); layer.refresh() },
      // removeLayer limpia registry, pickLayers y bus — más completo que el destroy manual anterior.
      dispose: () => this.removeLayer(siblingId),
    }
  }

  // IconSet de las burbujas default. Configurable por `bubble` sin escribir un IconSet entero:
  //   bubble: { buckets, draw, sizes }  — cualquiera de los tres ajusta el default.
  // Sin ninguno → el default cacheado (lazy, una sola instancia por motor).
  #clusterBubbleIconSet({ buckets, draw, sizes } = {}) {
    return buckets == null && draw == null && sizes == null
      ? this.#defaultClusters ??= defineClusterIconSet({ draw: DEFAULT_CLUSTER_DRAW, sizes: { default: DEFAULT_CLUSTER_SIZE } })
      : defineClusterIconSet({ buckets, draw: draw ?? DEFAULT_CLUSTER_DRAW, sizes })
  }

  // IconSet de los SUB-CLUSTERS de la espiral (jerarquía): estilo claro+anillo, distinto a la burbuja
  // base sólida; un poco más chico. Sin `accent` → color por conteo, cacheado (lazy, compartido). Con
  // `accent` → color fijo, icon-set propio (no cacheado: cada acento es distinto).
  #subClusterIconSet(accent = null) {
    return accent
      ? defineClusterIconSet({ draw: makeSubClusterDraw(accent), sizes: { default: DEFAULT_CLUSTER_SIZE - 6 } })
      : this.#defaultSubClusters ??= defineClusterIconSet({ draw: SUB_CLUSTER_DRAW, sizes: { default: DEFAULT_CLUSTER_SIZE - 6 } })
  }

  #bindLabels(id, record, { bindTo, textOf, accessors, source }) {
    const host = bindTo ? this.#layers.get(bindTo) : null
    if (bindTo && !host) return false                          // host aún no declarado → pendiente

    const src = host ? host.source : source
    if (!src) return true                                      // standalone sin fuente todavía: queda listo para setLabels manual
    const idOf  = (host ? host.source.accessors.idOf : accessors.idOf)
    const posOf = (host ? host.source.accessors.positionOf : accessors.positionOf)
    const text  = textOf ?? (item => String(idOf(item)))

    const sync = () => {
      // Guard de visibilidad: si la capa está oculta —o su host está deshabilitado como ENTIDAD
      // (setLayerEnabled ocultó este pane junto a él)— saltar el reduce O(n) + setLabels. Con WS
      // a alta frecuencia este sync se invoca en cada emit (~1/frame); sin el guard procesaría
      // 2000+ ítems y pintaría fillText en un canvas que el usuario no ve. `record.visible` lo
      // setea addLabelLayer.setVisible; los bubble-labels (#makeBubbleSink, sin addLabelLayer)
      // nacen explícitamente visibles. Al re-habilitar el host,
      // setLayerEnabled resyncea (este mismo sync) → labels frescos.
      if (!record.visible || (host && !host.enabled)) return
      record.layer.setLabels(
        src.getSnapshot().reduce((acc, item) => {
          const itemId = idOf(item)
          if (host?.suppressed?.has(itemId)) return acc        // clusterizado → sin label flotante
          if (host?.where && !host.where(item)) return acc      // fuera de la membresía del host → tampoco
          const p = posOf(item)
          if (p && Number.isFinite(p.lat) && Number.isFinite(p.lng)) acc.push({ id: itemId, lat: p.lat, lng: p.lng, text: text(item) })
          return acc
        }, []))
    }

    record.resync = sync                                     // el cluster lo reinvoca al re-suprimir
    record.unsub  = src.subscribe(sync)
    sync()
    return true
  }

  // Re-sincroniza los productores LIGADOS a un host (labels y overlays) cuando su
  // supresión (cluster) cambia sin cambiar los datos — p. ej. recluster por zoom. La
  // suscripción a la fuente no dispara en ese caso. Cada `resync` re-lee `host.suppressed`
  // (labels: re-filtra; overlays: re-apunta el ref vivo + refresh).
  #resyncBound(hostId) {
    if (this.#destroying) return                  // teardown: no rebuildear capas ligadas (se remueven igual)
    this.#layers.forEach(record => {
      if (record.bindTo !== hostId) return
      if (record.kind === 'label' || record.kind === 'overlay') record.resync?.()
    })
  }

  #flushPendingBinds() {
    if (!this.#pendingBinds.length) return
    this.#pendingBinds = this.#pendingBinds.filter(({ bind }) => !bind())
  }

  // Sin una clausura por aviso: `move` sale en cada paso del movimiento.
  #emit(event, detail) {
    const handlers = this.#signals.get(event)
    if (handlers) for (const cb of handlers) cb(detail)
  }
}
