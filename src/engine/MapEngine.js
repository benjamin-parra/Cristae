import { LayerRegistry } from '../interaction/LayerRegistry.js'
import { EventBus } from '../events/EventBus.js'
import { Interaction } from './Interaction.js'
import { Camera } from './Camera.js'
import { PointLayer } from '../render/PointLayer.js'
import { OBJ_BITS } from '../render/Picking.js'
import { LineLayer } from '../render/LineLayer.js'
import { LeafletLineLayer } from '../render/LeafletLineLayer.js'
import { PolygonLayer } from '../render/PolygonLayer.js'
import { PolygonGpuLayer } from '../render/PolygonGpuLayer.js'
import { CircleLayer } from '../render/CircleLayer.js'
import { HeatLayer } from '../render/HeatLayer.js'
import { EditableGeometry } from '../render/EditableGeometry.js'
import { HtmlLayer } from '../render/HtmlLayer.js'
import { LabelLayer } from '../render/LabelLayer.js'
import { createHighlightOverlay } from '../render/HighlightOverlay.js'
import { createClusterFold } from '../cluster/ClusterFold.js'
import { defineClusterIconSet } from '../atlas/IconSet.js'
import { createSource } from '../data/index.js'
import { createTileSnapshotRetention } from '../tiles/TileSnapshotRetention.js'

// MapEngine — orquestador headless (SPECS §6). Framework-agnóstico, sin dominio. Crea el L.map,
// deriva panes por orden de declaración (el consumidor no toca z-index),
// y cablea las piezas: registry + bus + Interaction (picking) + Camera + retención de tiles.
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

// Registro estático de engines vivos: al destruirse uno, sus hermanos reciben resetCanvasReference()
// porque el teardown de glify (compartido) deja las referencias de canvas de los vecinos obsoletas.
const _liveEngines = new Set()

export class MapEngine {

  #L
  #glify
  #map
  #ownsMap
  #registry
  #bus
  #interaction
  #tiles      = null
  #tileLayer  = null
  #destroying = false             // teardown del engine en curso → no rebuildear glify (canvas muriendo)

  #layers             = new Map()      // id → record { kind, source, layer, controls, paneName, order }
  #highlightOverlays  = new Set()      // overlays de interacción (canvas 2D fijo al contenedor) → dispose en destroy
  #fontHooked         = new WeakSet()  // iconSets ya cableados al font-gate (evita re-suscribir por cada capa)
  // Capas de puntos interactivas = las que entran al pase de picking. Sobre las MISMAS entradas vive
  // la identidad de OBJETO del pase (el primer eje del píxel): se asigna en el alta desde la free-list
  // y se devuelve en la baja, así que un ciclo de alta/baja no agota el rango. `byObj` es el mapa
  // inverso — el decodificador entrega (obj, chunk, local) y tiene que volver a la capa.
  #pick               = { entries: [], byObj: new Map(), free: [], next: 1 }
  #glLayers           = new Set()      // capas GL (canvas glify propio) a reproyectar en move/zoom/resize
  #pendingBinds       = []             // label-layers cuyo host aún no existía (resolución por nombre)
  #signals            = new Map()      // eventos del motor (ready/viewportchange/interaction*) → handlers
  #iconSets           = new Map()      // nombre → IconSet registrado (resolución por nombre)
  #defaultClusters    = null           // cluster icon-set por defecto (lazy)
  #defaultSubClusters = null           // icon-set de sub-clusters de la espiral (jerarquía, lazy)
  #order              = 0
  #zoomAnimation      = 'none'         // politica de animacion del zoom: 'none' | 'in-only' | 'on'
  #focused            = null           // enfoque: Set(id) de capas a opacidad plena (resto atenuado), o null
  #dimOpacity         = 0.3            // opacidad del resto mientras hay enfoque POR CAPA
  #focusKinds         = null           // kinds de capa que el enfoque por capa atenúa (null = todas)
  #itemFocus          = new Map()      // enfoque por ÍTEM: layerId → Set(id) declarado (vacío = todo atenuado)

  camera
  ready

  constructor({ leaflet, glify, container, mapOptions, insets, hoverThrottleMs = 0, map, zoomAnimation, zoomControl = true } = {}) {
    this.#L       = leaflet
    this.#glify   = glify
    this.#ownsMap = !map
    // `zoomAnimation` de Leaflet queda en su default (on) a propósito: es lo que cablea el proxy de
    // animación y los `zoomanim` de tiles y glify en su onAdd. La política del motor NO se expresa
    // apagando ese latch — ver #installZoomGate.
    this.#map = map ?? leaflet.map(container, {
      preferCanvas:        true,
      fadeAnimation:       false,
      markerZoomAnimation: false,
      zoomControl,
      center: [0, 0], zoom: 2,
      ...mapOptions,
    })

    // Con mapa PRESTADO la política es del consumidor: sin modo explícito, no se interviene.
    this.#zoomAnimation = zoomAnimation ?? (this.#ownsMap ? 'none' : 'on')
    this.#installZoomGate()

    this.#registry    = new LayerRegistry(this.#map)
    this.#bus         = new EventBus(layerId => this.#syncDemand(layerId))
    this.#interaction = new Interaction({
      map:        this.#map,
      registry:   this.#registry,
      bus:        this.#bus,
      pickLayers: () => this.#pick.entries,
      hoverThrottleMs,
      onInteractionStart: () => this.#emit('interactionstart', {}),
      onInteractionEnd:   () => this.#emit('interactionend', {}),
      onEmptyClick:       latlng => this.#emit('map:click', { latlng }),   // click en espacio vacío → latlng
    })
    this.camera       = new Camera({
      map: this.#map,
      L:   leaflet,
      insets,
      resolveSource: id => this.#layers.get(id)?.source ?? null,
      // Zoom mínimo de desclusterización por (capa, id): la cámara lo consulta para revealPoint /
      // followPoint({reveal}) sin conocer el cluster. El fold ata rec.cluster = control (ver addClusterFold).
      declusterZoomOf: (layerId, id) => this.#layers.get(layerId)?.cluster?.declusterZoomFor(id) ?? null,
    })

    this.#map.on('moveend zoomend', () => this.#emit('viewportchange', {
      center: this.#map.getCenter(), zoom: this.#map.getZoom(), bounds: this.#map.getBounds(),
    }))
    this.#wireRenderLifecycle()
    this.#wireZoomReproject()

    this.ready = new Promise(resolve => this.#map.whenReady(() => { this.#emit('ready', {}); resolve(this) }))
    _liveEngines.add(this)
  }

  /* ── Capas de puntos ── */

  addPointLayer(cfg) {
    const { id, data, accessors, iconSet, interactive = false, pane, z, visible = true, enabled = true, filters, where, cluster, capture, presentAs } = cfg
    const order    = this.#order++
    const paneName = pane ?? `cristae-point-${id}`
    const zIndex   = z ?? (BASE_Z + order * Z_STEP)
    this.#ensurePane(paneName, zIndex)

    const set = this.#resolveIconSet(iconSet)
    this.#hookFontGate(set)                      // re-encode al re-rasterizar el atlas (font-gate)
    // `controls` = la Source que posee el motor (ruta A/data); con `cfg.source` el dueño es el
    // consumidor → el motor solo lee, no escribe. El objeto ES el Source (handle colapsado).
    const controls = cfg.source ? null : createSource(accessors, set?.variants)
    const source   = cfg.source ?? controls
    // `where`: membresía por-capa (filtra qué ítems de la Source compartida entran a ESTA capa
    // sin mutar la Source). Otras vistas de la misma Source no se ven afectadas.
    const layer = this.#trackGl(new PointLayer({ glify: this.#glify, map: this.#map, pane: paneName, source, iconSet: set, interactive, where }))

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
      this.#registerResolver(id, 'point', zIndex, order, e => record.layer.resolveClick(e), e => record.layer.resolveHover(e), { capture, presentAs })
    }
    this.#applyVisibility(id, paneName, visible && enabled)

    filters?.forEach(f => controls?.addFilter(f))
    if (data && controls) controls.set(data)
    if (cluster) this.addCluster({ hostId: id, ...cluster })   // azúcar: <cristae-cluster> usa addCluster directo

    this.#flushPendingBinds()
    return this.#pointHandle(id, record, set)
  }

  /* ── Capas de polígonos (display Leaflet + hit-testing por índice geométrico) ── */

  // Polígonos, una sola puerta. Dos ejes independientes:
  //
  //   · el SUSTRATO — `backend`: 'gpu' (default; stencil en una textura, UN contexto WebGL de los ~16
  //     del navegador) o 'leaflet' (un path por figura, sin contexto). Mismo contrato de picking y de
  //     foco. Ninguno va a #glLayers: el de Leaflet reproyecta solo y el de GPU con sus propios
  //     moveend/zoomend/resize. Con decenas de figuras y varias capas en la página, 'leaflet' evita
  //     gastar contextos; el default favorece el volumen, que es el perfil habitual.
  //   · el DATO — `data`/`source` (entidades con accessors) o `geometry` (las tablas del lector, sin
  //     materializar un array). La geometría tipada es inmutable: no hay Source que mutar.
  //
  // `idOf`/`styleOf` salen de `accessors` cuando lo hay, así que la ruta tipada los declara en el
  // MISMO lugar que la reactiva.
  addPolygonLayer(cfg) {
    const { id, data, accessors, pane, z, source: dado, geometry,
            idOf = accessors?.idOf, styleOf = accessors?.styleOf,
            interactive = true, visible = true, backend = 'gpu', ...style } = cfg
    // Un `L.polygon` no sabe leer tablas tipadas. Pedirlo es un error del llamador, no algo que
    // degradar en silencio a un mapa en blanco.
    if (geometry && backend !== 'gpu')
      throw new Error('[cristae] `geometry` sólo la dibuja el sustrato `gpu`')
    const order    = this.#order++
    const paneName = pane ?? `cristae-polygon-${id}`
    const zIndex   = z ?? (BASE_Z + order * Z_STEP)
    this.#ensurePane(paneName, zIndex, false)          // display puro; picking propio por índice

    // Sin `geometry`: dueño motor (data) vs consumidor (cfg.source). Con `geometry` no hay Source.
    const controls = geometry || dado ? null : createSource(accessors)
    const source   = geometry ? null : dado ?? controls
    const layer    = backend === 'gpu'
      ? new PolygonGpuLayer({ L: this.#L, map: this.#map, pane: paneName, source, geometry, idOf, styleOf, interactive, ...style })
      : new PolygonLayer({ L: this.#L, map: this.#map, pane: paneName, source, interactive })

    const record = { kind: 'polygon', source, layer, controls, paneName, zIndex, order, interactive, visible, enabled: true }
    this.#layers.set(id, record)

    if (interactive)   // resolvers leen record.layer (no capturan). Síncrono, no va a #pickLayers (como línea).
      this.#registerResolver(id, 'polygon', zIndex, order, e => record.layer.resolveClick(e), e => record.layer.resolveHover(e))
    this.#applyVisibility(id, paneName, visible)

    if (data && controls) controls.set(data)
    this.#flushPendingBinds()
    const handle = { id, source, set: items => controls?.set(items), setVisible: v => this.setLayerVisibility(id, v) }
    // Repintar y reestilar a mano sólo existen sobre GPU: el sustrato de Leaflet reproyecta solo y su
    // estilo se reevalúa por `styleOf` cuando la Source cambia.
    if (backend === 'gpu') Object.assign(handle, {
      redraw: () => record.layer.redraw(),
      style : options => record.layer.style(options),
    })
    return handle
  }

  /** @deprecated Una sola puerta: `addPolygonLayer({ geometry, backend: 'gpu' })`. Se retira en 1.0. */
  addPolygonGpuLayer({ id, pane, interactive = false, ...cfg }) {
    return this.addPolygonLayer({ ...cfg, id, interactive, backend: 'gpu', pane: pane ?? `cristae-polygon-gpu-${id}` })
  }

  /* ── Capas de líneas (GL glify.Lines + hit-testing nearest-segment CPU) ── */

  addLineLayer(cfg) {
    const { id, data, accessors, interactive = false, pane, z, visible = true, vector = false } = cfg
    const order    = this.#order++
    const paneName = pane ?? `cristae-line-${id}`
    const zIndex   = z ?? (BASE_Z + order * Z_STEP)
    this.#ensurePane(paneName, zIndex)               // noPointer: la capa no captura puntero (picking propio)

    // `controls` = Source que posee el motor (ruta A/data); con `cfg.source` el dueño es el consumidor.
    const controls = cfg.source ? null : createSource(accessors)
    const source   = cfg.source ?? controls
    // Backend: GL (glify, #trackGl para reproyectar en move/zoom) o Leaflet (DASH, reproyecta solo →
    // NO va a #glLayers). Mismo contrato de hit (kind 'line', nearest-segment) en ambos.
    const layer = vector
      ? new LeafletLineLayer({ L: this.#L, map: this.#map, pane: paneName, source, interactive })
      : this.#trackGl(new LineLayer({ glify: this.#glify, map: this.#map, pane: paneName, source, interactive }))

    const record = { kind: 'line', source, layer, controls, paneName, zIndex, order, interactive, visible, enabled: true }
    this.#layers.set(id, record)

    if (interactive) {
      // Los resolvers leen record.layer (no capturan). Picking síncrono (no va a #pickLayers, como polígono).
      this.#registerResolver(id, 'line', zIndex, order, e => record.layer.resolveClick(e), e => record.layer.resolveHover(e))
    }
    this.#applyVisibility(id, paneName, visible)

    if (data && controls) controls.set(data)
    this.#flushPendingBinds()
    // Handle = SÓLO las ACCIONES de la capa (empujar datos / togglear visibilidad). El estilo NO es
    // una acción: es estado (accessor `styleOf`) — para recolorear una línea se muta su item y se
    // set/patch la Source; el motor reescribe su color (incremental o rebuild). No hay `setStyle`.
    return {
      id,
      source,
      set:        items => controls?.set(items),
      setVisible: v => this.setLayerVisibility(id, v),
    }
  }

  /* ── Capa de marcadores HTML (L.divIcon; GL-safe, complementa el point-layer GPU) ── */

  addHtmlLayer(cfg) {
    const { id, data, accessors, interactive = false, pane, z, visible = true } = cfg
    const order    = this.#order++
    const paneName = pane ?? `cristae-html-${id}`
    const zIndex   = z ?? (BASE_Z + order * Z_STEP + LABEL_Z_OFFSET)   // sobre líneas/puntos: los badges van arriba
    this.#ensurePane(paneName, zIndex)   // noPointer: picking propio (los markers son interactive:false)

    const controls = cfg.source ? null : createSource(accessors)
    const source   = cfg.source ?? controls
    const layer    = new HtmlLayer({ L: this.#L, map: this.#map, pane: paneName, source, interactive })

    const record = { kind: 'html', source, layer, controls, paneName, zIndex, order, interactive, visible, enabled: true }
    this.#layers.set(id, record)
    if (interactive) {
      this.#registerResolver(id, 'html', zIndex, order, e => record.layer.resolveClick(e), e => record.layer.resolveHover(e))
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

  /* ── Círculos en METROS (Leaflet-native L.circle — escala con el zoom, a diferencia del sprite px) ── */

  addCircleLayer(cfg) {
    const { id, data, accessors, interactive = true, pane, z, visible = true } = cfg
    const order    = this.#order++
    const paneName = pane ?? `cristae-circle-${id}`
    const zIndex   = z ?? (BASE_Z + order * Z_STEP)
    this.#ensurePane(paneName, zIndex, false)          // display puro; picking propio (point-in-circle CPU)

    const controls = cfg.source ? null : createSource(accessors)
    const source   = cfg.source ?? controls
    const layer    = new CircleLayer({ L: this.#L, map: this.#map, pane: paneName, source, interactive })

    const record = { kind: 'circle', source, layer, controls, paneName, zIndex, order, interactive, visible, enabled: true }
    this.#layers.set(id, record)
    if (interactive)
      this.#registerResolver(id, 'circle', zIndex, order, e => record.layer.resolveClick(e), e => record.layer.resolveHover(e))
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
    this.#ensurePane(paneName, zIndex)

    const controls = cfg.source ? null : createSource(accessors)
    const source   = cfg.source ?? controls
    const layer    = new HeatLayer({ glify: this.#glify, map: this.#map, pane: paneName, source, radius, blur, intensity, colorRamp })

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

  /* ── Edición de geometría como INPUT CONTROLADO (Leaflet-native): value entra, cambios salen por
       onChange. No es capa de Source, y DIBUJA la geometría entera —relleno, contorno y handles— en su
       propia superficie GL: no se le ata un display aparte, que se vería superpuesto. `style` toma las
       mismas claves que un `styleOf` de PolygonLayer/LineLayer. ── */

  addEditableLayer(cfg) {
    const { id, kind = 'polygon', value = null, mode = 'edit', style, onChange, onCommit, pane, z } = cfg
    const order    = this.#order++
    const paneName = pane ?? `cristae-edit-${id}`
    const zIndex   = z ?? (BASE_Z + order * Z_STEP + LABEL_Z_OFFSET)   // handles por encima de las capas
    this.#ensurePane(paneName, zIndex, false)                          // markers interactivos → pane con puntero
    const editor = new EditableGeometry({ L: this.#L, map: this.#map, pane: paneName, kind, value, mode, style, onChange, onCommit })
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
    const labelLayer = new LabelLayer({ map: this.#map, pane: { name: paneName, zIndex }, paint, style })
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
      map:               this.#map,
      L:                 this.#L,
      layerOf:           id => this.#layers.get(id),
      nextOrder:         () => this.#order++,
      overlayZ:          (order, extra) => BASE_Z + order * Z_STEP + LABEL_Z_OFFSET + extra,   // z de las capas del fold: sobre los labels (+200)
      subAccent:         SUB_ACCENT,                                                           // acento default de la traza spiderfy
      ensurePane:        (name, z, noPointer) => this.#ensurePane(name, z, noPointer),
      makeBubbleSink:    (bubble, pane, order, foldId, interactive) => this.#makeBubbleSink(bubble, pane, order, foldId, interactive),
      subClusterIconSet: accent => this.#subClusterIconSet(accent),
      addPointLayer:     cfg => this.addPointLayer(cfg),
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
    this.#ensurePane(paneName, zIndex)

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
    const layer = this.#trackGl(new PointLayer({
      glify: this.#glify, map: this.#map, pane: paneName, source: host.source,
      accessors, iconSet: set, interactive: false, where: membresia,
    }))
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

    const map      = this.#map
    const paneName = `cristae-highlight-${id ?? layerId}`
    const pane     = map.getPane(paneName) ?? map.createPane(paneName)
    pane.style.zIndex        = String(z ?? BASE_Z + 250)
    pane.style.pointerEvents = 'none'

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
      const r = map.getContainer().getBoundingClientRect()
      if (r.width !== cssW || r.height !== cssH) {
        cssW                = r.width
        cssH                = r.height
        canvas.width        = Math.round(cssW * dpr)
        canvas.height       = Math.round(cssH * dpr)
        canvas.style.width  = `${cssW}px`
        canvas.style.height = `${cssH}px`
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      }
      const origin = map.containerPointToLayerPoint([0, 0])
      canvas.style.transform = `translate3d(${origin.x}px, ${origin.y}px, 0)`
    }
    reposition()

    const overlay = createHighlightOverlay({
      source,
      project: (lat, lng) => this.camera.latLngToContainerPoint(this.#L.latLng(lat, lng)),
      ctx,
      clear: () => { reposition(); ctx.clearRect(0, 0, cssW, cssH) },   // reasienta el pane antes de dibujar
      drawHighlight,
      sizeOf,
      schedule: fn => requestAnimationFrame(fn),
    })

    const onView = () => overlay.onViewportChange()
    map.on('moveend zoomend resize', onView)             // pan y settle de zoom: reasienta a la vista viva

    const entry = {
      // Mismo cálculo que la matriz GL del sprite, para que el tratamiento caiga exacto sobre su punto.
      renderAtView: (z, c) => {
        const half = map.getSize().divideBy(2)
        const cPix = map.project(c, z)
        overlay.renderAtView((lat, lng) => map.project(this.#L.latLng(lat, lng), z).subtract(cPix).add(half))
      },
      dispose: () => {
        map.off('moveend zoomend resize', onView)
        overlay.destroy()
        canvas.remove ? canvas.remove() : pane.removeChild?.(canvas)
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
      glify: this.#glify, map: this.#map, pane: record.paneName, source, iconSet: record.iconSet, interactive: record.interactive, where: record.where,
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
    record.group?.remove()
    record.controls?.destroy()
    record.cluster?.dispose()             // libera burbujas + sibling y su listener de zoom
    const declarabaFoco = this.#itemFocus.delete(id)
    this.#registry.removeByLayerId(id)
    this.#removePickLayer(id)
    this.#bus.clearLayer(id)
    this.#layers.delete(id)
    // Libera el pane si ya NINGUNA capa lo usa. Cubre los dos casos sin conocerlos: el pane auto
    // (`cristae-<kind>-<id>`, único) se va con su capa; un pane COMPARTIDO (varias capas con el mismo
    // `cfg.pane`) sobrevive hasta que se desmonta la última. Sin esto los panes se acumulaban en un
    // mapa de vida larga (alta/baja de capas) — el cluster ya los borraba a mano en su `dispose`.
    // Sacar el pane del DOM no alcanza: Leaflet lo retiene en `_panes` y `getPane` lo devolvería
    // desconectado, así que el alta siguiente colgaría su contenido de un nodo fuera del documento.
    if (record.paneName && !this.#paneInUse(record.paneName)) {
      this.#map.getPane(record.paneName)?.remove()
      delete this.#map._panes?.[record.paneName]
    }
    declarabaFoco && this.#applyFocus()
    return true
  }

  #paneInUse(paneName) {
    for (const [, r] of this.#layers) if (r.paneName === paneName) return true
    return false
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

  setTileProvider({ url, ...options } = {}) {
    this.#tiles ||= createTileSnapshotRetention(this.#map)
    if (this.#tileLayer) { this.#tiles.invalidateSnapshots(); this.#tileLayer.remove() }
    this.#tileLayer = this.#L.tileLayer(url, options).addTo(this.#map)
    this.#tiles.activateLayer(this.#tileLayer)
    return this
  }

  // Política de animación del zoom, en vivo: 'none' (sin transición), 'in-only' (sólo al acercar) u
  // 'on' (ambos sentidos). Aplica desde el zoom siguiente; no reconstruye capas ni pierde su cableado.
  setZoomAnimation(mode) {
    this.#zoomAnimation = mode
    return this
  }

  getLeafletMap() { return this.#map }
  getUnsafeHandler() { return this }

  // Resize del contenedor: recalcula tamaño con `pan:false` (ancla fija, NO recentra — sobre la capa
  // GL el reencuadre se percibe como salto/parpadeo), reajusta el picking FBO y resetea las capas de
  // puntos (un resize simétrico no desplaza el centro, así que el canvas glify no se redibuja solo).
  syncSize() {
    this.#map.invalidateSize({ pan: false })
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
  // respeta insets/maxZoom.
  fitToLayers(ids = null, { insets, maxZoom } = {}) {
    const box  = new Float64Array([Infinity, Infinity, -Infinity, -Infinity])   // [minLat, minLng, maxLat, maxLng]
    const grow = (lat, lng) => {
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return
      if (lat < box[0]) box[0] = lat
      if (lng < box[1]) box[1] = lng
      if (lat > box[2]) box[2] = lat
      if (lng > box[3]) box[3] = lng
    }
    const growTyped = v => {                     // tipado plano, intercalado [lat, lng, …]
      for (let i = 0; i + 1 < v.length; i += 2) grow(v[i], v[i + 1])
    }
    // Una coordenada llega como `{lat,lng}`, `[lat,lng]`, un anidado de pathOf/ringsOf, un iterable o
    // un tipado plano. Se recorre sin materializar pares.
    const walk = v =>
      ArrayBuffer.isView(v)        ? growTyped(v)
      : Array.isArray(v)           ? (typeof v[0] === 'number' ? grow(v[0], v[1]) : v.forEach(walk))
      : typeof v?.lat === 'number' ? grow(v.lat, v.lng)
      : v?.[Symbol.iterator]       ? [...v].forEach(walk)
      : undefined
    const recs = ids ? [...ids].map(id => this.#layers.get(id)) : [...this.#layers.values()]
    recs.forEach(r => {
      const b = r?.layer?.bounds                 // capa sin Source: su geometría es fija y la informa ella
      if (b) { grow(b.minLat, b.minLng); grow(b.maxLat, b.maxLng); return }
      if (!r?.source) return

      const { accessors: a, getSnapshot } = r.source
      getSnapshot().forEach(it => walk(a.positionOf ? a.positionOf(it) : a.pathOf ? a.pathOf(it) : a.ringsOf(it)))
    })
    if (!Number.isFinite(box[0])) return this

    this.camera.fitBounds(this.#L.latLngBounds([box[0], box[1]], [box[2], box[3]]), { insets })
    maxZoom != null && this.#map.getZoom() > maxZoom && this.#map.setZoom(maxZoom)
    return this
  }

  destroy() {
    if (this.#destroying) return
    this.#destroying = true
    _liveEngines.delete(this)
    ;[...this.#highlightOverlays].forEach(e => e.dispose())
    this.#interaction.destroy()
    this.camera.destroy()
    this.#tiles?.destroy()
    this.#layers.forEach((_, id) => this.removeLayer(id))
    this.#signals.clear()
    if (this.#ownsMap) this.#map.remove()
    // Tras el teardown de glify, los engines hermanos pueden quedar con referencia de canvas
    // obsoleta (singleton window.L.glify compartido). Los notificamos para auto-sanar.
    _liveEngines.forEach(e => e.#resetCanvases())
  }

  /* ── Internos ── */

  // Gate ÚNICO de la animación de zoom: se instala una vez y consulta el modo VIGENTE en CADA zoom,
  // así la política se cambia en vivo (setZoomAnimation) sin reconstruir nada.
  //
  // El latch `_zoomAnimated` del mapa NO se toca. Leaflet se lo COPIA a cada capa al agregarla, y sólo
  // con él en `true` la capa se suscribe a `zoomanim` y se marca `leaflet-zoom-animated`; apagarlo
  // dejaría a las capas ya montadas sin cablear PARA SIEMPRE — encender la animación después no las
  // revive, y los tiles saltan aunque el resto acompañe.
  #installZoomGate() {
    const map = this.#map, tryAnimatedZoom = map._tryAnimatedZoom.bind(map)
    map._tryAnimatedZoom = (center, zoom, options) => {
      if (this.#zoomAnimation === 'none') return false
      // 'in-only': al alejar, los tiles viejos se encogen mientras el fondo más amplio entra de golpe.
      // Quien prefiera esa transición a la ausencia de transición usa 'on', que anima en ambos sentidos.
      if (this.#zoomAnimation === 'in-only' && zoom < map._zoom) return false
      return tryAnimatedZoom(center, zoom, options)
    }
  }

  // Reposiciona/redibuja las capas de puntos en paneo y zoom (glify solo autoregistra moveend → _reset).
  // En `move` solo si el pane se desplazó de verdad; durante el zoom lo gobierna el cierre del gesto.
  #wireRenderLifecycle() {
    const L     = this.#L
    let zooming = false
    let lastX   = NaN, lastY = NaN
    this.#map.on('zoomstart', () => zooming = true)
    this.#map.on('zoomend', () => {
      zooming = false; lastX = NaN; lastY = NaN
      this.#forEachGlLayer(layer => layer.resetCanvasReference())
    })
    this.#map.on('move', () => {
      if (zooming) return
      const pos = L.DomUtil.getPosition(this.#map.getPanes().mapPane)
      if (pos.x === lastX && pos.y === lastY) return
      lastX = pos.x; lastY = pos.y
      this.#forEachGlLayer(layer => layer.resetCanvasReference())
    })
    this.#map.on('moveend', () => {
      lastX = NaN; lastY = NaN
      this.#forEachGlLayer(layer => layer.resetCanvasReference())
    })
  }

  // Zoom animado: reproyecta POR FRAME a la vista interpolada (tamaño de sprite/retículo fijo, alineado
  // con los tiles), en vez de dejar que el canvas escale con la transición CSS de Leaflet. Alcanza a las
  // capas GL (que apagan su `_animateZoom`, ver PointLayer) y a los overlays de interacción vía renderAtView.
  // Sincronizado al easing del tile (~cubic-bezier(0,0,.25,1), 250ms). `zoomanim` trae la vista destino.
  #wireZoomReproject() {
    const ease = t => 1 - (1 - t) ** 3          // aprox. del cubic-bezier(0,0,.25,1) del tile de Leaflet
    const DUR  = 250
    let raf    = 0
    this.#map.on('zoomanim', e => {
      const z0 = this.#map.getZoom()
      const c0 = this.#map.getCenter()
      const z1 = e.zoom
      const c1 = e.center ?? c0
      const t0 = performance.now()
      cancelAnimationFrame(raf)
      const step = () => {
        const k = ease(Math.min((performance.now() - t0) / DUR, 1))
        const z = z0 + (z1 - z0) * k
        const c = this.#L.latLng(c0.lat + (c1.lat - c0.lat) * k, c0.lng + (c1.lng - c0.lng) * k)
        this.#forEachGlLayer(l => l.renderAtView?.(z, c))
        this.#highlightOverlays.forEach(o => o.renderAtView?.(z, c))   // el realce sigue a su sprite por frame
        if (k < 1) raf = requestAnimationFrame(step)
      }
      raf = requestAnimationFrame(step)
    })
    // Al asentar: corta la interpolación y deja que cada capa se re-proyecte nítida a la vista final.
    this.#map.on('zoomend', () => { cancelAnimationFrame(raf); this.#forEachGlLayer(l => l.resetCanvasReference()) })
  }

  // Inscribe una capa GL (canvas glify propio que Leaflet NO reproyecta) en el set que el ciclo de
  // render recorre en move/zoom/resize, y envuelve su destroy() para darla de baja sola. ÚNICO punto
  // de alta/baja: cualquier capa GL —PointLayer hoy (punto, overlay, burbuja de cluster); otra
  // entidad/modificador GL mañana— se inscribe pasando por acá al CREARSE, sin enumerar `kind`s ni
  // escanear todas las capas en el hot-path. Las capas Leaflet-nativas (label, polígono) no pasan
  // por acá (Leaflet ya las reproyecta). (#2)
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

  #ensurePane(name, zIndex, noPointer = true) {
    const pane = this.#map.getPane(name) ?? this.#map.createPane(name)
    pane.style.zIndex = String(zIndex)
    if (noPointer) pane.style.pointerEvents = 'none'
    return pane
  }

  #applyVisibility(id, paneName, visible) {
    const pane = this.#map.getPane(paneName)
    if (pane) pane.style.visibility = visible ? '' : 'hidden'
    this.#registry.setLayerVisibility(id, visible)
  }

  /* ── Enfoque / atenuado de capas (primitivo general) ── */
  // `focus(ids)` deja esas capas a opacidad plena y ATENÚA el resto (opacidad `opacity`); sirve para
  // destacar un subconjunto (p. ej. el spider al expandir un cluster). `unfocus(ids)` las saca del
  // conjunto brillante (se re-atenúan); `unfocusAll()` restaura todo. La capa nombrada queda EXENTA
  // también del eje de foco por ítem.
  // Idempotente (recomputa desde cero). Cubre por id de capa; los panes sin capa (líneas del spider) no
  // se tocan → quedan a opacidad plena junto al foco. `kinds` acota QUÉ capas se atenúan (por kind:
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
    if (rec?.paneName) this.#applyOpacity(rec.paneName, alpha)
  }

  // `z` nulo vuelve al derivado en el alta.
  setLayerZ(layerId, z) {
    const record = this.#layers.get(layerId)
    const zIndex = z ?? record?.zIndex
    const pane   = record && zIndex != null ? this.#map.getPane(record.paneName) : null
    pane && (pane.style.zIndex = String(zIndex))
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
      this.#applyOpacity(rec.paneName, exacto || !atenua ? 1 : dim)
    }
  }

  #applyOpacity(paneName, alpha) {
    const pane = this.#map.getPane(paneName)
    if (pane) pane.style.opacity = alpha >= 1 ? '' : String(alpha)
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
    const zIndex    = BASE_Z + order * Z_STEP + LABEL_Z_OFFSET + 5   // burbujas sobre los labels (+200) — mismo pane que bubblePane
    const spec      = bubble ?? { kind: 'point' }

    if (spec.kind === 'label') {
      const layer  = new LabelLayer({ map: this.#map, pane: { name: bubblePane, zIndex }, paint: spec.paint, style: spec.style })
      const textOf = spec.textOf ?? (count => String(count))
      this.#layers.set(siblingId, { kind: 'label', layer, paneName: bubblePane, order, visible: true, enabled: true })
      return {
        feed:    bubbles => layer.setLabels(bubbles.map(b => ({ id: b.id, lat: b.lat, lng: b.lng, text: textOf(b.count) }))),
        dispose: () => { layer.destroy(); this.#layers.delete(siblingId) },
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
    const layer = this.#trackGl(new PointLayer({ glify: this.#glify, map: this.#map, pane: bubblePane, source: controls, iconSet, interactive }))
    this.#layers.set(siblingId, {
      kind: 'point', source: controls, layer, controls, paneName: bubblePane, order, interactive,
      visible: true, enabled: true,
    })
    if (interactive) {
      this.#addPickLayer(siblingId, layer)
      // La burbuja ocluye lo que tiene debajo (capa overlay): su click no se filtra a geocercas/puntos.
      // Hover real (demand-gated: sólo computa si alguien se suscribe) → la burbuja es una entidad
      // consultable como cualquier otra: hits por el bus + contentsOf del control.
      this.#registerResolver(siblingId, 'point', zIndex, order, e => layer.resolveClick(e), e => layer.resolveHover(e), { capture: true })
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

  #emit(event, detail) {
    this.#signals.get(event)?.forEach(cb => cb(detail))
  }
}
