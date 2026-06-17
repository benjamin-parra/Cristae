import { LayerRegistry } from '../interaction/LayerRegistry.js'
import { EventBus } from '../events/EventBus.js'
import { Interaction } from './Interaction.js'
import { Camera } from './Camera.js'
import { PointLayer } from '../render/PointLayer.js'
import { LabelLayer } from '../render/LabelLayer.js'
import { Cluster } from '../cluster/Cluster.js'
import { defineClusterIconSet } from '../atlas/IconSet.js'
import { createSource } from '../data/index.js'
import { prepareIndex, idsFor } from '../geometry/polygon.js'
import { createTileSnapshotRetention } from '../tiles/TileSnapshotRetention.js'

// MapEngine — orquestador headless (SPECS §6). Framework-agnóstico: sin Lit, sin React, sin
// dominio. Crea el L.map, deriva panes por orden de declaración (el consumidor no toca z-index),
// y cablea las piezas: registry + bus + Interaction (picking) + Camera + retención de tiles.
// Cada capa de puntos posee un Source interno (ruta C) o adopta uno externo (ruta B).

const BASE_Z = 400
const Z_STEP = 10
const BUS_EVENTS = new Set(['click', 'hover', 'hover:start', 'hover:end', 'pointer:move'])

// Lado del sprite de la burbuja default (px). El radio es `size * 0.42` y el texto escala con `size`,
// así que esto fija el tamaño visible de toda la burbuja. El consumidor lo cambia con `bubble.sizes`.
const DEFAULT_CLUSTER_SIZE = 43

// Dibujo por defecto de la burbuja de cluster. `plus` (de defineClusterIconSet) marca el bucket que
// es piso de un rango → "+", sin afirmar un conteo exacto. El consumidor reemplaza esto con su `draw`.
const DEFAULT_CLUSTER_DRAW = (ctx, size, count, plus) => {
  const r = size * 0.42
  ctx.fillStyle = count >= 200 ? '#dc2626' : count >= 50 ? '#f59e0b' : '#2563eb'
  ctx.globalAlpha = 0.9
  ctx.beginPath(); ctx.arc(size / 2, size / 2, r, 0, Math.PI * 2); ctx.fill()
  ctx.globalAlpha = 1
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
  #tiles = null
  #tileLayer = null

  #layers = new Map()             // id → record { kind, source, layer, controls, paneName, order }
  #pickLayers = []                // capas de puntos interactivas (para la sesión de picking)
  #glLayers = new Set()           // capas GL (canvas glify propio) a reproyectar en move/zoom/resize
  #pendingBinds = []              // label-layers cuyo host aún no existía (resolución por nombre)
  #signals = new Map()            // eventos del motor (ready/viewportchange/interaction*) → handlers
  #iconSets = new Map()           // nombre → IconSet registrado (resolución por nombre)
  #defaultClusters = null         // cluster icon-set por defecto (lazy)
  #order = 0

  camera
  ready

  constructor({ leaflet, glify, container, mapOptions, insets, hoverThrottleMs = 0, map, zoomAnimation = 'none', zoomControl = true } = {}) {
    this.#L = leaflet
    this.#glify = glify
    this.#ownsMap = !map
    // zoomAnimation queda en el default de Leaflet (on): así el proxy de animación y los handlers
    // `zoomanim` de tiles y glify se cablean en su onAdd. Apagarlos en el constructor los dejaría
    // sin cablear y no se podrían reactivar. La palanca en caliente es `_zoomAnimated`.
    this.#map = map ?? leaflet.map(container, {
      preferCanvas: true,
      fadeAnimation: false,
      markerZoomAnimation: false,
      zoomControl,
      center: [0, 0], zoom: 2,
      ...mapOptions,
    })

    if (this.#ownsMap) this.#applyZoomAnimation(zoomAnimation)

    this.#registry = new LayerRegistry(this.#map)
    this.#bus = new EventBus((layerId) => this.#syncDemand(layerId))
    this.#interaction = new Interaction({
      map: this.#map,
      registry: this.#registry,
      bus: this.#bus,
      pickLayers: () => this.#pickLayers,
      hoverThrottleMs,
      onInteractionStart: () => this.#emit('interactionstart', {}),
      onInteractionEnd: () => this.#emit('interactionend', {}),
    })
    this.camera = new Camera({
      map: this.#map,
      L: leaflet,
      insets,
      resolveSource: (id) => this.#layers.get(id)?.source ?? null,
    })

    this.#map.on('moveend zoomend', () => this.#emit('viewportchange', {
      center: this.#map.getCenter(), zoom: this.#map.getZoom(), bounds: this.#map.getBounds(),
    }))
    this.#wireRenderLifecycle()

    this.ready = new Promise(resolve => this.#map.whenReady(() => { this.#emit('ready', {}); resolve(this) }))
    _liveEngines.add(this)
  }

  /* ── Capas de puntos ── */

  addPointLayer(cfg) {
    const { id, data, accessors, iconSet, interactive = false, pane, z, visible = true, filters, cluster } = cfg
    const order = this.#order++
    const paneName = pane ?? `cristae-point-${id}`
    const zIndex = z ?? (BASE_Z + order * Z_STEP)
    this.#ensurePane(paneName, zIndex)

    const set = this.#resolveIconSet(iconSet)
    // `controls` = la Source que posee el motor (ruta A/data); con `cfg.source` el dueño es el
    // consumidor → el motor solo lee, no escribe. El objeto ES el Source (handle colapsado).
    const controls = cfg.source ? null : createSource(accessors, set?.variants)
    const source = cfg.source ?? controls
    const layer = this.#trackGl(new PointLayer({ glify: this.#glify, map: this.#map, pane: paneName, source, iconSet: set, interactive }))

    const record = { kind: 'point', source, layer, controls, paneName, order, interactive }
    this.#layers.set(id, record)

    if (interactive) {
      this.#pickLayers.push({ layerId: id, layer })
      // Los resolvers leen record.layer (no capturan): attachSource puede swapear la capa.
      this.#registerResolver(id, 'point', zIndex, order, e => record.layer.resolveClick(e), e => record.layer.resolveHover(e))
    }
    this.#applyVisibility(id, paneName, visible)

    filters?.forEach(f => controls?.addFilter(f))
    if (data && controls) controls.set(data)
    if (cluster) this.addCluster({ hostId: id, ...cluster })   // azúcar: <cristae-cluster> usa addCluster directo

    this.#flushPendingBinds()
    return this.#pointHandle(id, record, set)
  }

  /* ── Capas de polígonos (display Leaflet + hit-testing por índice geométrico) ── */

  addPolygonLayer(cfg) {
    const { id, data = [], accessors, pane, z, interactive = true, visible = true } = cfg
    const { idOf, ringsOf, styleOf } = accessors
    const order = this.#order++
    const paneName = pane ?? `cristae-polygon-${id}`
    const zIndex = z ?? (BASE_Z + order * Z_STEP)
    this.#ensurePane(paneName, zIndex, false)

    const group = this.#L.layerGroup([], { pane: paneName }).addTo(this.#map)
    let index = prepareIndex([])
    const render = (items) => {
      group.clearLayers()
      items.forEach(item => this.#L.polygon(ringsOf(item), { pane: paneName, ...styleOf?.(item) }).addTo(group))
      index = prepareIndex(items.map(item => ({ id: idOf(item), rings: ringsOf(item) })))
    }
    render(data)

    if (interactive) {
      const resolve = (e) => e?.latlng ? idsFor(e.latlng.lat, e.latlng.lng, index).map(hid => ({ ref: hid, id: hid, distancePx: 0 })) : []
      this.#registerResolver(id, 'polygon', zIndex, order, resolve, resolve)
    }
    const record = { kind: 'polygon', group, paneName, order, render }
    this.#layers.set(id, record)
    this.#applyVisibility(id, paneName, visible)

    return { id, set: (items) => render(items), setVisible: (v) => this.setLayerVisibility(id, v) }
  }

  /* ── Capas de labels (canvas; standalone o bind-to un host) ── */

  addLabelLayer(cfg) {
    const { id, bindTo, pane, z, paint, style, textOf, accessors } = cfg
    const order = this.#order++
    const paneName = pane ?? `cristae-label-${id}`
    const zIndex = z ?? (BASE_Z + order * Z_STEP + 200)        // labels por encima de las capas
    const labelLayer = new LabelLayer({ map: this.#map, pane: { name: paneName, zIndex }, paint, style })
    const record = { kind: 'label', layer: labelLayer, paneName, order, bindTo }
    this.#layers.set(id, record)

    const bind = () => this.#bindLabels(id, record, { bindTo, textOf, accessors, source: cfg.source })
    if (!bind()) this.#pendingBinds.push({ id, bind })           // host no existe aún → reintentar al crearlo

    return {
      id,
      setLabels: (labels) => labelLayer.setLabels(labels),
      setHovered: (ids) => labelLayer.setHovered(ids),
      setVisible: (v) => labelLayer.setVisibility(v),
    }
  }

  /* ── Cluster (fold): agrupa N capas de puntos en UN clustering y comparte la supresión ── */

  // Clusteriza el conjunto UNIÓN de varios hosts en un solo supercluster y reparte el MISMO
  // set `suppressed` (ref estable, mutado in place) a TODOS los hosts y a sus ligados (labels +
  // overlays, que leen `host.suppressed`). El <cristae-cluster> declarativo entra por acá vía el
  // reductor de la gramática; `addCluster` (un host) es azúcar imperativa que delega.
  addClusterFold(targets, { radius, maxZoom, minPoints, bubble } = {}) {
    const hosts = []
    for (const t of targets) {
      const rec = this.#layers.get(t.id)
      if (rec && rec.kind === 'point') hosts.push({ id: t.id, rec })
    }
    if (!hosts.length) return null

    const cluster = new Cluster({ radius, maxZoom, minPoints })
    const base = hosts[0].rec
    const { idOf, positionOf } = base.source.accessors   // ids deben ser únicos entre hosts (precondición)

    const foldId = `cluster-${this.#order++}`
    const bubblePane = `${foldId}-bubbles`
    this.#ensurePane(bubblePane, BASE_Z + base.order * Z_STEP + 5)
    const sink = this.#makeBubbleSink(bubble, bubblePane, base.order, foldId)
    const bubbleId = `${foldId}:clusters`

    const snapshot = () => {
      if (hosts.length === 1) return hosts[0].rec.source.getSnapshot()
      const all = []
      for (const { rec } of hosts) { const s = rec.source.getSnapshot(); for (let i = 0; i < s.length; i++) all.push(s[i]) }
      return all
    }
    const apply = () => {
      for (const { id, rec } of hosts) {
        rec.suppressed = cluster.clusteredIds
        rec.layer.suppressed = cluster.clusteredIds
        rec.layer.refresh()
        this.#resyncBound(id)                      // recluster → re-filtra labels + overlays ligados a este host
      }
      sink.feed(cluster.bubbles)
    }
    const onData = () => { cluster.index(snapshot(), idOf, positionOf); if (cluster.recluster(this.#map.getZoom())) apply() }
    const onZoom = () => { if (cluster.recluster(this.#map.getZoom())) apply() }
    const unsubs = hosts.map(({ rec }) => rec.source.subscribe(onData))
    this.#map.on('zoomend', onZoom)
    onData()

    let disposed = false
    const control = {
      setConfig: ({ radius, maxZoom, minPoints } = {}) => {
        if (radius != null) cluster.radius = radius
        if (maxZoom != null) cluster.maxZoom = maxZoom
        if (minPoints != null) cluster.minPoints = minPoints
        if (cluster.recluster(this.#map.getZoom())) apply()
      },
      dispose: () => {
        if (disposed) return
        disposed = true
        unsubs.forEach(u => u()); this.#map.off('zoomend', onZoom); sink.dispose()
        for (const { id, rec } of hosts) {
          rec.suppressed = null; rec.layer.suppressed = null; rec.layer.refresh()   // sin cluster → host completo
          this.#resyncBound(id)
          if (rec.cluster === control) rec.cluster = null
        }
      },
    }
    // dispose idempotente compartido: quitar cualquiera de los hosts (o el sibling) limpia el fold.
    for (const { rec } of hosts) rec.cluster = control

    return { kind: 'bubble', id: bubbleId, handle: { id: bubbleId, control }, source: this.#layers.get(bubbleId)?.source, suppressed: null }
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

    const order = this.#order++
    const paneName = `${host.paneName}-overlay-${order}`
    const zIndex = BASE_Z + host.order * Z_STEP + 7        // sobre el host (y sobre la burbuja, +5)
    this.#ensurePane(paneName, zIndex)

    // Comparte la Source del host (mismo dato → move/patch en vivo) pero RENDERIZA con
    // accessors propios (badge, sin rotar) y filtra con `where` (sólo los que tienen badge).
    const accessors = { ...host.source.accessors }
    if (variantOf) accessors.variantOf = variantOf
    if (sizeOf) accessors.sizeOf = sizeOf
    accessors.headingOf = null                              // el overlay no rota (badge de esquina)

    const set = this.#resolveIconSet(iconSet)
    const layer = this.#trackGl(new PointLayer({
      glify: this.#glify, map: this.#map, pane: paneName, source: host.source,
      accessors, iconSet: set, interactive: false, where,
    }))
    layer.suppressed = host.suppressed ?? null               // hereda la supresión del cluster (si la hay)
    layer.refresh()

    const record = {
      kind: 'overlay', source: host.source, layer, paneName, order, bindTo: hostId,
      // el cluster reinvoca esto al re-suprimir (#resyncBound): re-apunta al ref vivo del host + reconstruye.
      resync: () => { layer.suppressed = this.#layers.get(hostId)?.suppressed ?? null; layer.refresh() },
    }
    this.#layers.set(id, record)
    this.#applyVisibility(id, paneName, visible)

    return {
      id,
      get source() { return record.source },
      get layer() { return record.layer },
      refresh: () => layer.refresh(),
      setWhere: (fn) => { layer.where = fn; layer.refresh() },
      setVisible: (v) => this.setLayerVisibility(id, v),
    }
  }

  /* ── Fuentes externas (ruta B) ── */

  attachSource(id, source) {
    const record = this.#layers.get(id)
    if (!record || record.kind !== 'point') return this
    record.layer.destroy()
    record.source = source
    record.controls = null
    record.layer = this.#trackGl(new PointLayer({
      glify: this.#glify, map: this.#map, pane: record.paneName, source, iconSet: record.iconSet, interactive: record.interactive,
    }))
    if (record.interactive) {
      const entry = this.#pickLayers.find(e => e.layerId === id)
      if (entry) entry.layer = record.layer
    }
    return this
  }

  /* ── Acceso y lifecycle ── */

  getLayer(id) { return this.#layers.get(id) ?? null }

  removeLayer(id) {
    const record = this.#layers.get(id)
    if (!record) return false
    record.unsub?.()                      // bind de labels / suscripción de la capa
    record.layer?.destroy?.()
    record.group?.remove()
    record.controls?.destroy()
    record.cluster?.dispose()             // libera burbujas + sibling y su listener de zoom
    this.#registry.removeByLayerId(id)
    this.#pickLayers = this.#pickLayers.filter(e => e.layerId !== id)
    this.#bus.clearLayer(id)
    this.#layers.delete(id)
    return true
  }

  setLayerVisibility(id, visible) {
    const record = this.#layers.get(id)
    if (!record) return false
    this.#applyVisibility(id, record.paneName, visible)
    if (!visible) this.#bus.clearLayer(id)
    return true
  }

  on(event, layerIdOrCb, maybeCb) {
    if (BUS_EVENTS.has(event)) return this.#bus.on(event, layerIdOrCb, maybeCb)
    const cb = typeof layerIdOrCb === 'function' ? layerIdOrCb : maybeCb
    let set = this.#signals.get(event)
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
    if (!this.#tiles) this.#tiles = createTileSnapshotRetention(this.#map)
    if (this.#tileLayer) { this.#tiles.invalidateSnapshots(); this.#tileLayer.remove() }
    this.#tileLayer = this.#L.tileLayer(url, options).addTo(this.#map)
    this.#tiles.activateLayer(this.#tileLayer)
    return this
  }

  getLeafletMap() { return this.#map }
  getUnsafeHandler() { return this }

  // Resize del contenedor: Leaflet recalcula tamaño y cada picking reajusta su FBO. Además se
  // redibujan las capas de puntos: invalidateSize() solo emite move/moveend si el resize desplaza
  // el centro, así que un resize simétrico (cambio de alto, maximizar columna) limpia el canvas
  // glify sin que #wireRenderLifecycle lo redibuje. Reseteamos aquí para cerrar ese hueco.
  syncSize() {
    this.#map.invalidateSize()
    this.#pickLayers.forEach(({ layer }) => layer.syncPickingSize())
    this.#resetCanvases()
  }

  // Reposiciona y redibuja todas las capas de puntos de este motor. Escape hatch manual: el
  // <cristae-map> ya se auto-cura en resize y en show tras display:none vía su ResizeObserver →
  // syncSize(). Útil en el path headless (MapEngine sin elemento, sin observer) o si el contenedor
  // vuelve a ser visible sin cambiar de tamaño (no dispara resize).
  invalidateCanvas() { this.#resetCanvases() }

  destroy() {
    _liveEngines.delete(this)
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

  // 'none' (default): sin animación de zoom. 'in-only': zoom-in animado pero zoom-out instantáneo — un
  // zoom-out animado encoge los tiles viejos mientras el fondo más amplio aparece de golpe → desfase perceptible.
  // Nota: zoomAnimation:false en el constructor de Leaflet dejaría los handlers `zoomanim` sin
  // cablean → se usa la palanca en caliente (_zoomAnimated) en vez del latch de construcción.
  #applyZoomAnimation(mode) {
    if (mode === 'none') { this.#map._zoomAnimated = false; return }
    const tryAnimatedZoom = this.#map._tryAnimatedZoom
    this.#map._tryAnimatedZoom = function (center, zoom, options) {
      return zoom < this._zoom ? false : tryAnimatedZoom.call(this, center, zoom, options)
    }
  }

  // Reposiciona/redibuja las capas de puntos en paneo y zoom (glify solo autoregistra moveend → _reset).
  // En `move` solo si el pane se desplazó de verdad; durante el zoom lo gobierna el cierre del gesto.
  #wireRenderLifecycle() {
    const L = this.#L
    let zooming = false
    let lastX = NaN, lastY = NaN
    this.#map.on('zoomstart', () => { zooming = true })
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

  #registerResolver(id, kind, zIndex, order, resolveClick, resolveHover) {
    this.#registry.upsertResolver({ layerId: id, kind, zIndex, declOrder: order, resolveClick, resolveHover, visible: true })
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

  #pointHandle(id, record, iconSet) {
    const { controls } = record
    record.iconSet = iconSet
    return {
      id,
      get source() { return record.source },
      get layer() { return record.layer },
      set: (items) => controls?.set(items),
      patch: (items, dirtyIds) => controls?.patch(items, dirtyIds),
      move: (itemId, lat, lng) => controls?.move(itemId, lat, lng),
      remove: (itemId) => controls?.remove(itemId),
      addFilter: (f) => controls?.addFilter(f),
      removeFilter: (fid) => controls?.removeFilter(fid),
      preloadIcons: (variants) => iconSet?.seed(variants),
      refresh: () => record.layer.refresh(),
      setVisible: (v) => this.setLayerVisibility(id, v),
    }
  }

  // Burbuja parametrizable: el consumidor define CÓMO se ven los clusters (capa de puntos con
  // icon-set de cluster, o capa de labels con el conteo), o usa el default. El sink expone
  // `feed(bubbles)` (la forma de alimentar varía por tipo) y `dispose`.
  #makeBubbleSink(bubble, bubblePane, order, hostId) {
    const siblingId = `${hostId}:clusters`
    const zIndex = BASE_Z + order * Z_STEP + 5
    const spec = bubble ?? { kind: 'point' }

    if (spec.kind === 'label') {
      const layer = new LabelLayer({ map: this.#map, pane: { name: bubblePane, zIndex }, paint: spec.paint, style: spec.style })
      const textOf = spec.textOf ?? (count => String(count))
      this.#layers.set(siblingId, { kind: 'label', layer, paneName: bubblePane, order })
      return {
        feed: (bubbles) => layer.setLabels(bubbles.map(b => ({ id: b.id, lat: b.lat, lng: b.lng, text: textOf(b.count) }))),
        dispose: () => { layer.destroy(); this.#layers.delete(siblingId) },
      }
    }

    const iconSet = this.#resolveIconSet(spec.iconSet) ?? this.#clusterBubbleIconSet(spec)
    const controls = createSource({
      idOf: b => b.id,
      positionOf: b => ({ lat: b.lat, lng: b.lng }),
      variantOf: b => (iconSet.variantForCount?.(b.count) ?? String(b.count)),
      sizeOf: spec.sizeOf,
    }, iconSet.variants)
    const layer = this.#trackGl(new PointLayer({ glify: this.#glify, map: this.#map, pane: bubblePane, source: controls, iconSet, interactive: false }))
    this.#layers.set(siblingId, { kind: 'point', source: controls, layer, controls, paneName: bubblePane, order })
    return {
      feed: (bubbles) => controls.set(bubbles),
      dispose: () => { layer.destroy(); controls.destroy(); this.#layers.delete(siblingId) },
    }
  }

  // IconSet de las burbujas default. Configurable por `bubble` sin escribir un IconSet entero:
  //   bubble: { buckets, draw, sizes }  — cualquiera de los tres ajusta el default.
  // Sin ninguno → el default cacheado (lazy, una sola instancia por motor).
  #clusterBubbleIconSet({ buckets, draw, sizes } = {}) {
    if (buckets == null && draw == null && sizes == null)
      return this.#defaultClusters ??= defineClusterIconSet({ draw: DEFAULT_CLUSTER_DRAW, sizes: { default: DEFAULT_CLUSTER_SIZE } })
    return defineClusterIconSet({ buckets, draw: draw ?? DEFAULT_CLUSTER_DRAW, sizes })
  }

  #bindLabels(id, record, { bindTo, textOf, accessors, source }) {
    const host = bindTo ? this.#layers.get(bindTo) : null
    if (bindTo && !host) return false                          // host aún no declarado → pendiente

    const src = host ? host.source : source
    if (!src) return true                                      // standalone sin fuente todavía: queda listo para setLabels manual
    const idOf = (host ? host.source.accessors.idOf : accessors.idOf)
    const posOf = (host ? host.source.accessors.positionOf : accessors.positionOf)
    const text = textOf ?? (item => String(idOf(item)))

    const sync = () => record.layer.setLabels(
      src.getSnapshot().reduce((acc, item) => {
        const itemId = idOf(item)
        if (host?.suppressed?.has(itemId)) return acc        // clusterizado → sin label flotante
        const p = posOf(item)
        if (p && Number.isFinite(p.lat) && Number.isFinite(p.lng)) acc.push({ id: itemId, lat: p.lat, lng: p.lng, text: text(item) })
        return acc
      }, []))

    record.resync = sync                                     // el cluster lo reinvoca al re-suprimir
    record.unsub = src.subscribe(sync)
    sync()
    return true
  }

  // Re-sincroniza los productores LIGADOS a un host (labels y overlays) cuando su
  // supresión (cluster) cambia sin cambiar los datos — p. ej. recluster por zoom. La
  // suscripción a la fuente no dispara en ese caso. Cada `resync` re-lee `host.suppressed`
  // (labels: re-filtra; overlays: re-apunta el ref vivo + refresh).
  #resyncBound(hostId) {
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
