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
// Offset de la capa de LABELS sobre su host. El fold de cluster (burbujas + spider) se cuelga por ENCIMA
// de esta banda para que las etiquetas de otros marcadores NO tapen los vehículos que el cluster superpone
// al expandirse (el spider es el contenido enfocado → va arriba de los labels). Ver addLabelLayer + fold.
const LABEL_Z_OFFSET = 200
const BUS_EVENTS = new Set(['click', 'secondary-click', 'hover', 'hover:start', 'hover:end', 'pointer:move'])

// Ventana de coalescido del re-index del cluster ante moves de POSICIÓN (no estructurales).
// `cluster.index` (Supercluster.load) es O(n log n) + ~4 allocs/punto y resetea la firma → fuerza
// apply() (rebuild GL completo). Bajo WS la Source emite ~1 vez/frame; re-indexar por frame satura
// el hilo y traba el zoom. A zoom de cluster, mover unos metros NO cambia el bucket → el re-index
// puede diferirse a esta ventana sin pérdida visual. Los cambios ESTRUCTURALES (alta/baja/patch)
// NO esperan: re-indexan al instante (ver onData en addClusterFold).
const CLUSTER_REINDEX_THROTTLE_MS = 1000

// Decimales del centro de burbuja en la firma de `cluster:marked` (~1 m). El centroide puede
// correrse por miembros NO marcados sin cambiar la membresía del marcado: con el centro en la
// firma, el ancla reportada se re-emite y no queda despegada del sprite. Más fino re-emitiría
// por jitter sub-marcador; más grueso dejaría el ancla visiblemente corrida.
const MARKED_CENTER_QUANT = 5

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

// Posiciones spiderfy alrededor de un punto-contenedor (px), estilo Leaflet.markercluster: anillo
// para pocos elementos, espiral arquimediana para muchos. Devuelve offsets [x,y] en px del contenedor.
// Se calcula en PÍXELES (no metros) → no se deforma por la latitud de Web-Mercator.
const SPIDER_CIRCLE_MAX = 9
const SPIDER_MIN_RADIUS = 42   // radio interior libre default: despeja el botón de cierre + el 1er marcador (vehículos ~44px)

// gap = radio interior mínimo (deja libre el centro para el botón X); circleMax = umbral círculo↔espiral.
function spiderfyOffsets(cx, cy, n, sep = 30, gap = SPIDER_MIN_RADIUS, circleMax = SPIDER_CIRCLE_MAX) {
  const out = []
  if (n <= circleMax) {
    const legLength = Math.max((sep * (2 + n)) / (2 * Math.PI), sep * 0.85, gap)
    const step = (2 * Math.PI) / n
    for (let i = 0; i < n; i++) { const a = i * step; out.push([cx + legLength * Math.cos(a), cy + legLength * Math.sin(a)]) }
  } else {
    // Espiral arquimediana de PASO CONSTANTE: r = b·θ, radio interior `gap` (despeja la X) y paso radial
    // por vuelta = `sep` (= la separación tangencial) → vueltas equiespaciadas. Así el radio no se dispara
    // con muchos elementos ni queda un hueco grande entre la última vuelta y las demás (donde cabía el
    // popup/hover). La separación tangencial se mantiene ≈ sep avanzando el ángulo sep/r por marcador.
    const b = sep / (2 * Math.PI)
    let angle = gap / b
    for (let i = 0; i < n; i++) {
      const r = b * angle
      out.push([cx + r * Math.cos(angle), cy + r * Math.sin(angle)])
      angle += sep / r
    }
  }
  return out
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
  #destroying = false             // teardown del engine en curso → no rebuildear glify (canvas muriendo)

  #layers = new Map()             // id → record { kind, source, layer, controls, paneName, order }
  #pickLayers = []                // capas de puntos interactivas (para la sesión de picking)
  #glLayers = new Set()           // capas GL (canvas glify propio) a reproyectar en move/zoom/resize
  #pendingBinds = []              // label-layers cuyo host aún no existía (resolución por nombre)
  #signals = new Map()            // eventos del motor (ready/viewportchange/interaction*) → handlers
  #iconSets = new Map()           // nombre → IconSet registrado (resolución por nombre)
  #defaultClusters = null         // cluster icon-set por defecto (lazy)
  #defaultSubClusters = null      // icon-set de sub-clusters de la espiral (jerarquía, lazy)
  #order = 0
  #focused = null                 // enfoque: Set(id) de capas a opacidad plena (resto atenuado), o null
  #dimOpacity = 0.3               // opacidad del resto mientras hay enfoque activo
  #focusKinds = null              // kinds de capa que el enfoque atenúa (null = todas)

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
      // Zoom mínimo de desclusterización por (capa, id): la cámara lo consulta para revealPoint /
      // followPoint({reveal}) sin conocer el cluster. El fold ata rec.cluster = control (ver addClusterFold).
      declusterZoomOf: (layerId, id) => this.#layers.get(layerId)?.cluster?.declusterZoomFor(id) ?? null,
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
    const { id, data, accessors, iconSet, interactive = false, pane, z, visible = true, enabled = true, filters, where, cluster, capture, presentAs } = cfg
    const order = this.#order++
    const paneName = pane ?? `cristae-point-${id}`
    const zIndex = z ?? (BASE_Z + order * Z_STEP)
    this.#ensurePane(paneName, zIndex)

    const set = this.#resolveIconSet(iconSet)
    // `controls` = la Source que posee el motor (ruta A/data); con `cfg.source` el dueño es el
    // consumidor → el motor solo lee, no escribe. El objeto ES el Source (handle colapsado).
    const controls = cfg.source ? null : createSource(accessors, set?.variants)
    const source = cfg.source ?? controls
    // `where`: membresía por-capa (filtra qué ítems de la Source compartida entran a ESTA capa
    // sin mutar la Source). Otras vistas de la misma Source no se ven afectadas.
    const layer = this.#trackGl(new PointLayer({ glify: this.#glify, map: this.#map, pane: paneName, source, iconSet: set, interactive, where }))

    // `where`/`enabled` en el record: si esta capa está clusterizada, el cluster indexa `source ∧ where`
    // de los hosts HABILITADOS (no la Source cruda) → cuenta lo que la capa REALMENTE muestra.
    // setWhere/setLayerEnabled los actualizan y re-indexan el cluster. `visible` (pintado puro) se
    // persiste para componer la visibilidad EFECTIVA del pane (visible ∧ enabled).
    const record = { kind: 'point', source, layer, controls, paneName, order, interactive, where: where ?? null, visible, enabled }
    this.#layers.set(id, record)
    if (!enabled) layer.enabled = false          // nace gateada: no reacciona a la Source hasta setLayerEnabled(true)

    if (interactive) {
      this.#pickLayers.push({ layerId: id, layer })
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
    const zIndex = z ?? (BASE_Z + order * Z_STEP + LABEL_Z_OFFSET)        // labels por encima de las capas
    const labelLayer = new LabelLayer({ map: this.#map, pane: { name: paneName, zIndex }, paint, style })
    // `visible` en record: controla si sync() (la suscripción a la Source) corre el reduce O(n) +
    // setLabels. Con setVisible(false) el sync es no-op → cero CPU por cada emit del WS.
    const record = { kind: 'label', layer: labelLayer, paneName, order, bindTo, visible: true }
    this.#layers.set(id, record)

    const bind = () => this.#bindLabels(id, record, { bindTo, textOf, accessors, source: cfg.source })
    if (!bind()) this.#pendingBinds.push({ id, bind })           // host no existe aún → reintentar al crearlo

    return {
      id,
      setLabels: (labels) => labelLayer.setLabels(labels),
      setHovered: (ids) => labelLayer.setHovered(ids),
      setVisible: (v) => {
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
        labelLayer.setVisibility(v && host?.enabled !== false)
      },
    }
  }

  /* ── Cluster (fold): agrupa N capas de puntos en UN clustering y comparte la supresión ── */

  // Clusteriza el conjunto UNIÓN de varios hosts en un solo supercluster y reparte el MISMO
  // set `suppressed` (ref estable, mutado in place) a TODOS los hosts y a sus ligados (labels +
  // overlays, que leen `host.suppressed`). El <cristae-cluster> declarativo entra por acá vía el
  // reductor de la gramática; `addCluster` (un host) es azúcar imperativa que delega.
  addClusterFold(targets, { radius, maxZoom, minPoints, enabled, expandable = true, bubble, dimRest = false, dimRestOpacity = 0.3, dimMarked = false, dimRestExcept = [], circleThreshold = null, spiralGap = null, accent = null, lineColor = null } = {}) {
    const hosts = []
    for (const t of targets) {
      const rec = this.#layers.get(t.id)
      if (rec && rec.kind === 'point') hosts.push({ id: t.id, rec })
    }
    if (!hosts.length) return null

    let expandableActive = expandable ?? true   // mutable via setConfig
    let dimRestActive = dimRest                  // atenuar el resto del mapa al expandir (mutable)
    let dimRestOpacityActive = dimRestOpacity ?? 0.3
    let dimMarkedActive = dimMarked              // atenuar el resto mientras haya ids marcados (mutable)
    let dimRestExceptActive = dimRestExcept ?? []  // capas del consumidor que quedan brillantes al atenuar
    let circleThresholdActive = circleThreshold  // umbral círculo↔espiral (nº) o null = auto (SPIDER_CIRCLE_MAX)
    let spiralGapActive = spiralGap              // radio interior de la espiral (nº) o null = default (SPIDER_MIN_RADIUS)
    let accentActive = accent                    // color de acento (sub-burbujas al montar + traza si no hay lineColor) o null
    let lineColorActive = lineColor              // color de la TRAZA que une los elementos (el consumidor lo deriva) o null
    const cluster = new Cluster({ radius, maxZoom, minPoints, enabled })
    const base = hosts[0].rec
    const { idOf, positionOf } = base.source.accessors   // ids deben ser únicos entre hosts (precondición)

    const foldId = `cluster-${this.#order++}`
    const bubblePane = `${foldId}-bubbles`
    this.#ensurePane(bubblePane, BASE_Z + base.order * Z_STEP + LABEL_Z_OFFSET + 5)   // sobre los labels (+200)
    // La burbuja se registra SIEMPRE como interactiva (no condicionada a expandable): así habilitar
    // expandable en runtime no exige recablear el picking. El gate real vive en el handler de click.
    const sink = this.#makeBubbleSink(bubble, bubblePane, base.order, foldId, true)
    const bubbleId = `${foldId}:clusters`

    // Resuelve un id de dato desclusterizado a su host → { layerId, item }. Recorre los hosts (un
    // cluster puede envolver varias capas). itemById es OPCIONAL → fallback a scan lineal con el idOf
    // del host. Primer host que resuelve gana; si ninguno, item:null. Lo usan el spider y el evento.
    const resolveOne = (id) => {
      for (const { id: layerId, rec } of hosts) {
        let item = rec.source.itemById?.(id)
        if (item == null && !rec.source.itemById) {
          const hidOf = rec.source.accessors.idOf
          item = rec.source.getSnapshot().find(it => hidOf(it) === id)
        }
        if (item != null) return { layerId, item }
      }
      return { layerId: null, item: null }
    }

    // ── Spiderfy: capa de marcadores en espiral + líneas para los clusters expandidos ──
    // Las hojas expandidas QUEDAN suprimidas en el host; acá se renderizan en posiciones espirales
    // (markercluster-style) REUSANDO el iconSet del host (mismo sprite que el vehículo real) con líneas
    // desde el centro. Una sola sesión spider por fold: id + pane ESTABLES (reusados open/close) → sin
    // leak de panes ni crecimiento de #order. La capa va por la API PÚBLICA addPointLayer (no privados).
    const spiderId = `${foldId}:spider`
    // Hoja desplegada = dato del host en el overlay → se PRESENTA como su capa host (mismo id de dato, en
    // su posición desplegada); aplica a TODO canal (lo usa resolveHits). presentedFrom deja que el
    // auto-collapse la reconozca propia. leafLL lo llena applySpider.
    const leafLL = new Map()
    const presentLeaf = (hit) => {
      const ll = leafLL.get(hit.ref)
      if (!ll) return null
      const { layerId } = resolveOne(hit.ref)
      return layerId && { ...hit, layerId, id: hit.ref, ref: hit.ref, latlng: ll, presentedFrom: spiderId }
    }
    const ha = base.source.accessors
    const spiderAccessors = {
      idOf: s => s.id,
      positionOf: s => ({ lat: s.lat, lng: s.lng }),
      // hashOf por posición: al recalcularse la espiral (mismo id, nueva pos por reflow/compactado)
      // el default (=idOf) no marcaría dirty → el marcador quedaría en su pos vieja dejando huecos.
      hashOf: s => `${s.lat}:${s.lng}`,
    }
    if (ha.variantOf) spiderAccessors.variantOf = s => ha.variantOf(s.orig)   // mismo sprite que el host
    if (ha.headingOf) spiderAccessors.headingOf = s => ha.headingOf(s.orig)   // rumbo (si el iconSet rota)
    if (ha.sizeOf)    spiderAccessors.sizeOf    = s => ha.sizeOf(s.orig)
    const spiderHandle = base.iconSet ? this.addPointLayer({
      id: spiderId, data: [], accessors: spiderAccessors, iconSet: base.iconSet,
      interactive: true, z: BASE_Z + base.order * Z_STEP + LABEL_Z_OFFSET + 7, presentAs: presentLeaf,   // hoja: sobre labels(+200), burbuja(+5) y líneas(+4)
    }) : null
    // Capa de SUB-CLUSTERS de la espiral (jerarquía): burbujas de conteo con el MISMO iconSet de
    // conteo que las burbujas base. Slots {kind:'subcluster'} van acá; los {kind:'leaf'} a `spiderHandle`.
    const spiderSubId = `${foldId}:spider-sub`
    const subIconSet = this.#subClusterIconSet(accentActive)   // accent (si hay) pinta las sub-burbujas; fijado al montar
    const spiderSubHandle = this.addPointLayer({
      id: spiderSubId, data: [],
      accessors: {
        idOf: s => s.id,
        positionOf: s => ({ lat: s.lat, lng: s.lng }),
        variantOf: s => (subIconSet.variantForCount?.(s.count) ?? String(s.count)),
        hashOf: s => `${s.count}:${s.lat}:${s.lng}`,   // re-encode al cambiar conteo/posición
      },
      iconSet: subIconSet, interactive: true, z: BASE_Z + base.order * Z_STEP + LABEL_Z_OFFSET + 8, capture: true,   // sobre labels(+200); ocluye lo de abajo
    })
    const legsPane = `${foldId}-legs`
    // Líneas DETRÁS de la burbuja (+5) y de los marcadores (+7): look canónico spiderfy. Si fueran
    // encima, con muchas patas tapan el centro y la burbuja dim queda ilegible.
    this.#ensurePane(legsPane, BASE_Z + base.order * Z_STEP + LABEL_Z_OFFSET + 4, true)        // sobre labels(+200); noPointer: las líneas no pican
    const legGroup = this.#L.layerGroup([], { pane: legsPane }).addTo(this.#map)
    const setLegs = (segs) => {
      legGroup.clearLayers()
      for (const s of segs)
        this.#L.polyline(s.pts, { pane: legsPane, color: s.color, weight: s.weight, opacity: s.opacity ?? 0.7, interactive: false }).addTo(legGroup)
    }
    // Recalcula espiral (px del contenedor → latlng) + marcadores + líneas desde cluster.expandedGroups.
    // Sin expansión → vacía capa y líneas. Colapsa en zoomstart, así que nunca queda con el pixel-radius
    // de otro zoom (no hay drift). Cero costo cuando no hay nada expandido (groups vacío).
    const applySpider = () => {
      if (!spiderHandle) return
      leafLL.clear()
      const leafItems = [], subItems = [], segs = [], bands = []
      for (const g of cluster.expandedGroups) {
        const c = this.#map.latLngToContainerPoint([g.center.lat, g.center.lng])
        // sep mayor cuando hay sub-burbujas para que no se solapen ni queden impickeables. Los slots ya son
        // 1:1 con marcadores renderables (el índice del cluster deduplica por id) → el caracol se dimensiona
        // por g.slots.length sin huecos: cada slot recibe UNA posición, UNA pata y UN marcador.
        const hasSub = g.slots.some(s => s.kind === 'subcluster')
        // Estabilidad círculo↔espiral al abrir una sub-burbuja: la RAMA se decide sobre el conteo COLAPSADO
        // de sub-burbujas (subs actuales + la que está abierta, single-open), NO sobre el expandido. Así, si
        // colapsado era un CÍRCULO (≤ SPIDER_CIRCLE_MAX sub-burbujas), abrir una NO morphea a espiral → no se
        // pierde la forma ni cuál se abrió. Se fuerza el círculo pasando circleMax = total de slots.
        const subCount = g.slots.reduce((n, s) => n + (s.kind === 'subcluster' ? 1 : 0), 0)
        const hasBloom = g.slots.some(s => s.kind === 'leaf' && s.group != null)
        const collapsedCount = subCount + (hasBloom ? 1 : 0)
        const circleMax = circleThresholdActive ?? SPIDER_CIRCLE_MAX   // umbral círculo↔espiral configurable (auto = default)
        const gap = spiralGapActive ?? SPIDER_MIN_RADIUS                // radio interior de la espiral configurable
        const keepCircle = collapsedCount > 0 && collapsedCount <= circleMax
        const offs = spiderfyOffsets(c.x, c.y, g.slots.length, hasSub ? 58 : 54, gap, keepCircle ? g.slots.length : circleMax)
        // Traza que UNE los marcadores ENTRE SÍ (no las patas al centro): es lo que hace legible la forma
        // de la espiral aunque quede compacta. Un tramo por corrida contigua del MISMO tipo — hojas
        // (individuales 'base' o florecidas 'bloom') → traza índigo; sub-burbujas → traza gris —. Va gruesa
        // y con harta opacidad para SEGUIRLA a simple vista (asoma en el hueco entre marcadores); las patas
        // al centro (segs) quedan tenues y secundarias. Antes las hojas 'base' no llevaban traza.
        let runType = null, runPts = null
        const flushRun = () => {
          if (runPts && runPts.length >= 2) {
            const leaf = runType !== 'sub'   // 'base' | 'bloom' = hojas
            // Color de la traza que UNE los elementos: `lineColor` si el consumidor lo pasó (típico: una
            // variación cromática del acento para que los marcadores del acento puro resalten), si no el
            // `accent`, si no los defaults. Las secciones se distinguen por opacidad (hojas 0.6 / sub 0.55).
            // La librería NO deriva colores: recibe el que corresponda ya resuelto.
            const color = lineColorActive ?? accentActive ?? (leaf ? SUB_ACCENT : '#94a3b8')
            bands.push({ pts: runPts, color, weight: 12, opacity: leaf ? 0.6 : 0.55 })
          }
          runType = null; runPts = null
        }
        g.slots.forEach((slot, i) => {
          const ll = this.#map.containerPointToLatLng(offs[i])
          const pts = [[g.center.lat, g.center.lng], [ll.lat, ll.lng]]
          let type
          if (slot.kind === 'subcluster') {
            subItems.push({ id: slot.id, lat: ll.lat, lng: ll.lng, count: slot.count })
            type = 'sub'
          } else {
            const { item } = resolveOne(slot.id)
            leafItems.push({ id: slot.id, lat: ll.lat, lng: ll.lng, orig: item })
            leafLL.set(slot.id, { lat: ll.lat, lng: ll.lng })
            type = slot.group != null ? 'bloom' : 'base'
          }
          segs.push({ pts, color: '#94a3b8', weight: 1.2, opacity: 0.45 })   // pata al centro: tenue, secundaria
          if (type !== runType) { flushRun(); runType = type; runPts = [] }
          runPts.push([ll.lat, ll.lng])
        })
        flushRun()
      }
      // set + refresh(): refresh fuerza un REBUILD completo sincrónico desde el snapshot recién seteado
      // → limpia marcadores stale. Sin él, si el set nuevo tiene la MISMA cantidad de ítems que el
      // anterior pero ids distintos (cambiar de base / togglear sub-cluster), el path incremental de la
      // capa puede dejar una sub-burbuja vieja flotando en su posición previa.
      spiderHandle.set(leafItems); spiderHandle.refresh?.()
      spiderSubHandle.set(subItems); spiderSubHandle.refresh?.()
      setLegs([...bands, ...segs])   // bandas detrás (se dibujan primero), patas encima
    }

    // El cluster indexa lo que la capa MUESTRA = `source ∧ where` de cada host HABILITADO (membresía
    // por-capa + membresía de la ENTIDAD), no la Source cruda → los conteos de burbuja reflejan lo que
    // la pantalla ve. Un host con `enabled=false` aporta ∅: sus puntos no clusterizan y las burbujas se
    // recomputan sobre los hosts vivos (sin ninguno → sin burbujas). Sin el `where` de una capa, es su
    // snapshot completo. La re-indexación ante cambios de `where`/`enabled` la disparan
    // setWhere/setLayerEnabled (record.cluster.reindex).
    const snapshot = () => {
      const live = hosts.filter(({ rec }) => rec.enabled !== false)
      if (live.length === 1) {
        const { rec } = live[0]
        const s = rec.source.getSnapshot()
        return rec.where ? s.filter(rec.where) : s
      }
      const all = []
      for (const { rec } of live) {
        const s = rec.source.getSnapshot(), w = rec.where
        for (let i = 0; i < s.length; i++) if (!w || w(s[i])) all.push(s[i])
      }
      return all
    }
    // Enfoque del cluster: con expansión activa (y dim-rest on) resalta el spider, y con ids
    // marcados (y dim-marked on) resalta las burbujas; en ambos casos ATENÚA el resto del mapa.
    // `dimRestExcept` deja brillantes capas del consumidor (p. ej. una capa propia ligada a los
    // marcados). Sin causa activa, restaura. Idempotente.
    const syncFocus = () => {
      const porExpansion = dimRestActive && cluster.expandedGroups.length
      const porMarcado = dimMarkedActive && cluster.hasMarked
      if (porExpansion || porMarcado)
        // Sólo marcadores (point/label/overlay): las geocercas/polígonos quedan como contexto, no
        // se atenúan. Las capas LIGADAS (labels/overlays con bindTo) siguen la suerte de su host.
        this.focus([spiderId, spiderSubId, bubbleId, ...dimRestExceptActive], { opacity: dimRestOpacityActive, kinds: ['point', 'label', 'overlay'] })
      else
        this.unfocusAll()
    }
    // Estado de expansión mostrado, para detectar transiciones expandido→colapsado en apply(). apply() es
    // el ÚNICO emisor de 'collapse': cubre TODA causa de cierre (colapso explícito, click-toggle, zoom,
    // deshabilitar clustering, o el reindex que poda el ancla al salir su móvil de la flota). Sin esto,
    // los cierres implícitos (enabled=false / ancla podada) cerraban la espiral pero dejaban el botón X
    // flotando (sólo se ocultaba con el 'collapse' de los caminos explícitos). 'expand' sí es explícito
    // (lo emiten los handlers de click / la API, con su payload rico: clusterId, center, entities).
    // Estado de la última sesión de expansión EMITIDA por este fold: { id, sig } o null (colapsado). El
    // `sig` = id-ancla | count | subgrupo-abierto detecta cambios estructurales (drill de subburbuja,
    // poda/crecimiento) al mismo estado abierto. `dismissReason` es una pista best-effort para el evento
    // dismiss (zoom la marca; el resto cae a 'collapse').
    let lastSession = null
    let dismissReason = 'collapse'
    // Ids marcados del fold (dueño: setMarked snapshotea el input) + firma del último emit del
    // eje marked. Declarados ANTES de apply(): su guard los lee en el primer doIndex del montaje.
    const markedSet = new Set()
    let lastMarkedSig = ''
    const apply = () => {
      for (const { id, rec } of hosts) {
        rec.suppressed = cluster.clusteredIds
        rec.layer.suppressed = cluster.clusteredIds
        if (rec.enabled === false) continue        // host deshabilitado: pane oculto — repintar/resyncear se difiere a setLayerEnabled(true)
        rec.layer.refresh()
        this.#resyncBound(id)                      // recluster → re-filtra labels + overlays ligados a este host
      }
      sink.feed(cluster.bubbles)
      applySpider()                                // marcadores en espiral + líneas de los expandidos
      syncFocus()                                  // resalta el spider / atenúa el resto (si dim-rest)
      // ── Emisor ÚNICO de la sesión de expansión (cluster:expand/update/dismiss) ──
      // Cubre TODA causa (click en burbuja base/sub, zoom, poda del ancla, enabled=false) comparando la
      // sesión previa vs la nueva por id + firma estructural. Gated por firma → NO emite en un reindex sin
      // cambio estructural (p. ej. sólo moves de WS): la lista llega una vez y el consumidor la actualiza
      // en vivo desde la Source compartida. El `_onInteraction` interno mantiene el botón central (X) del
      // elemento; `#emit` publica el evento del bus (`map.on('cluster:*')`).
      const struct = cluster.sessionStructure
      if (!struct) {
        if (lastSession) {
          const detail = { id: lastSession.id, reason: dismissReason }
          lastSession = null
          _onInteraction?.({ type: 'dismiss' })
          this.#emit('cluster:dismiss', detail)
        }
      } else {
        const center = cluster.expandedGroups[0]?.center ?? null
        const sig = struct.id + '|' + struct.count + '|' + (struct.groups.find(g => g.expanded)?.id ?? '')
        if (!lastSession) {
          lastSession = { id: struct.id, sig }
          _onInteraction?.({ type: 'expand', center })
          this.#emit('cluster:expand', buildSession(struct, center))
        } else if (lastSession.id !== struct.id) {
          // Cambió de base directo (abrir otra sin cerrar): dismiss del viejo + expand del nuevo.
          this.#emit('cluster:dismiss', { id: lastSession.id, reason: 'collapse' })
          lastSession = { id: struct.id, sig }
          _onInteraction?.({ type: 'expand', center })
          this.#emit('cluster:expand', buildSession(struct, center))
        } else if (lastSession.sig !== sig) {
          lastSession.sig = sig
          _onInteraction?.({ type: 'update', center })
          this.#emit('cluster:update', buildSession(struct, center))
        }
      }
      // ── Emisor ÚNICO del eje "marked" (cluster:marked) — espejo del bloque de sesión ──
      // Snapshot level-triggered: cada emisión es la verdad completa de los marcados ocultos en
      // una burbuja ({ hidden: [{layerId, id, center}] }); vacío = "ninguno oculto". Gated por
      // firma con el centro cuantizado (ver MARKED_CENTER_QUANT). El guard además evita
      // markedSigOf/buildMarked en el primer apply() del montaje (consts aún no declaradas).
      if (markedSet.size || lastMarkedSig) {
        const sig = markedSigOf(cluster.markedHidden)
        if (sig !== lastMarkedSig) {
          lastMarkedSig = sig
          this.#emit('cluster:marked', buildMarked(cluster.markedHidden))
        }
      }
    }
    const doIndex = () => { cluster.index(snapshot(), idOf, positionOf); if (cluster.recluster(this.#map.getZoom())) apply() }
    // ¿hubo cambio ESTRUCTURAL (alta/baja/patch del set) en algún host esta ventana? Un move de
    // posición NO marca dirtyIds (sólo moveDirtyIds) → se trata como deriva, no como cambio de set.
    // Si un host no expone dirtyIds (ruta B sin la señal) caemos al comportamiento previo (inmediato)
    // por conservadurismo — la optimización aplica sólo cuando la Source puede distinguir (ruta C).
    const structuralDirty = () => hosts.some(({ rec }) => {
      const fn = rec.source.dirtyIds
      if (typeof fn !== 'function') return true
      const d = fn.call(rec.source)
      return d != null && d.size > 0
    })
    let reindexTimer = null
    const onData = () => {
      if (structuralDirty()) {
        if (reindexTimer != null) { clearTimeout(reindexTimer); reindexTimer = null }
        doIndex()                                    // el SET cambió → re-index inmediato (membresía puede cambiar)
      } else if (reindexTimer == null) {
        reindexTimer = setTimeout(() => { reindexTimer = null; doIndex() }, CLUSTER_REINDEX_THROTTLE_MS)  // sólo moves → diferido
      }
    }
    const onZoom = () => { if (cluster.recluster(this.#map.getZoom())) apply() }
    const unsubs = hosts.map(({ rec }) => rec.source.subscribe(onData))
    this.#map.on('zoomend', onZoom)
    doIndex()                                        // primer index inmediato (no esperar la ventana)

    // Callback que CristaeCluster instala para traducir interacciones a DOM events.
    // El motor no sabe de DOM; el elemento web component hace esa traducción.
    let _onInteraction = null

    // Las entidades desclusterizadas, cada una con su capa de origen (heterogéneo-safe). Ver resolveOne.
    const entitiesOf = (ids) => ids.map(id => { const { layerId, item } = resolveOne(id); return { layerId, id, item } })

    // Payload VANILLA del evento cluster:* a partir de la estructura lógica (Cluster.sessionStructure).
    // Resuelve ids→entities UNA vez (Map reusado por los grupos → sin doble scan). `groups` viene [] cuando
    // el base es plano (≤ splitThreshold): el consumidor usa `entities`. Orden = espacial (getLeaves).
    const buildSession = (struct, center) => {
      const entities = entitiesOf(struct.ids)
      const byId = new Map(entities.map(e => [e.id, e]))
      const groups = struct.groups.map(g => ({
        id: g.id, count: g.count, expanded: g.expanded,
        entities: g.ids.map(id => byId.get(id) ?? { layerId: null, id, item: null }),
      }))
      return { id: struct.id, center, count: struct.count, entities, groups }
    }

    // Firma y payload del eje "marked" a partir de Cluster.markedHidden ([{id, center}], orden
    // canónico por id). El payload agrega el `layerId` del host dueño (set heterogéneo cross-capa);
    // la firma cuantiza el centro (MARKED_CENTER_QUANT) para re-emitir sólo ante movimiento real.
    const markedSigOf = (hidden) => hidden
      .map(h => `${h.id}@${h.center.lat.toFixed(MARKED_CENTER_QUANT)},${h.center.lng.toFixed(MARKED_CENTER_QUANT)}`)
      .join('|')
    const buildMarked = (hidden) => ({
      hidden: hidden.map(h => ({ layerId: resolveOne(h.id).layerId, id: h.id, center: h.center })),
    })

    // Colapsa TODO (re-forma los clusters). Una sola vía para el click-afuera, el zoom y el
    // setConfig(expandable=false) → emite el DOM event 'collapse' de forma consistente.
    const doCollapseAll = () => {
      if (cluster.collapseAll() && cluster.recluster(this.#map.getZoom())) { apply(); return true }   // apply() emite 'collapse' por transición
      return false
    }

    // Colapso al hacer ZOOM: la pertenencia del ancla no tiene sentido entre niveles de zoom (el
    // ancla cae en ALGÚN cluster a cada zoom → auto-expandiría uno distinto). Limpiar en zoomstart
    // mantiene los bursts de zoom en el fast-path de recluster (zoom re-clusteriza, como en los wrappers de mapa).
    const onZoomStart = () => { dismissReason = 'zoom'; doCollapseAll(); dismissReason = 'collapse' }
    this.#map.on('zoomstart', onZoomStart)

    // Click en burbuja → expande ESE cluster (modelo ancla). Se registra SIEMPRE; el toggle
    // `expandableActive` se evalúa en vivo. Guarda de generación: hit.ref debe existir en la fuente
    // de burbujas VIVA, que contiene exactamente los cluster-ids de la generación de #sc vigente
    // (apply() la repobla sincrónicamente tras cada recluster). Si no está, la burbuja es de un paint
    // previo (repaint pendiente) → se ignora. Así getLeaves nunca recibe un id stale (ni lanza ni
    // devuelve hojas equivocadas).
    const bubbleRec = this.#layers.get(bubbleId)
    // El bus entrega los handlers por-capa con un ARRAY de hits (ya filtrado a esta capa), no un hit
    // suelto (ver EventBus.#emit). El top hit de la burbuja es hits[0].
    const offBubbleClick = this.#bus.on('click', bubbleId, (hits) => {
      if (!expandableActive) return
      const ref = hits[0]?.ref
      if (ref == null) return
      // Guarda anti-carrera: el id debe seguir vivo en la fuente de burbujas (misma generación que
      // #sc, repoblada sincrónicamente por apply()). Evita pasar un cluster-id de un frame previo a
      // getLeaves —que podría devolver hojas equivocadas sin lanzar—. En el caso común no bloquea.
      // `bub` además trae el centro de la burbuja → posiciona el panel del consumidor.
      const bub = bubbleRec?.source?.itemById?.(ref)
      if (!bub) return
      // TOGGLE por-cluster: si esta burbuja ya está expandida (semitransparente) → colapsa SÓLO ella;
      // si no → la expande. El click en la burbuja lo captura esta capa (el popup sólo abre en top-hit).
      if (cluster.isClusterExpanded(ref)) {
        const ids = cluster.collapseCluster(ref)
        if (ids && cluster.recluster(this.#map.getZoom())) apply()   // apply() emite 'collapse' por transición
      } else {
        const res = cluster.expandCluster(ref)
        if (res && cluster.recluster(this.#map.getZoom())) apply()   // apply() es el ÚNICO emisor de 'cluster:expand'
      }
    })

    // Click en SUB-CLUSTER de la espiral (depth-2): florece SUS hojas empujando a los hermanos (toggle).
    // hits[0].ref = el id del sub-bubble = min leaf-id = el ancla interna que espera expandInner.
    const offSubClick = this.#bus.on('click', spiderSubId, (hits) => {
      if (!expandableActive) return
      const subId = hits[0]?.ref
      if (subId == null) return
      cluster.expandInner(subId)
      if (cluster.recluster(this.#map.getZoom())) apply()
    })

    let disposed = false
    const control = {
      setConfig: ({ radius, maxZoom, minPoints, enabled, expandable: newExpandable, dimRest: newDimRest, dimRestOpacity: newDimRestOpacity, dimMarked: newDimMarked, dimRestExcept: newDimRestExcept, circleThreshold: newCircleThreshold, spiralGap: newSpiralGap, accent: newAccent, lineColor: newLineColor } = {}) => {
        if (radius != null) cluster.radius = radius
        if (maxZoom != null) cluster.maxZoom = maxZoom
        if (minPoints != null) cluster.minPoints = minPoints
        if (enabled != null) cluster.enabled = enabled
        if (newDimRestOpacity != null) dimRestOpacityActive = newDimRestOpacity
        if (newDimRest != null) dimRestActive = newDimRest
        if (newDimMarked != null) dimMarkedActive = newDimMarked
        if (newDimRestExcept !== undefined) dimRestExceptActive = newDimRestExcept ?? []
        // Geometría/estilo de la espiral: no cambian la clusterización (recluster puede no gatillar), así
        // que si cambian con una espiral abierta hay que re-aplicar a mano para re-layoutear/re-colorear.
        // `accent` recolorea la TRAZA en caliente; las SUB-BURBUJAS quedan con el accent del montaje (su
        // icon-set está horneado) → un cambio reactivo de accent no las repinta.
        let geomChanged = false
        if (newCircleThreshold !== undefined && newCircleThreshold !== circleThresholdActive) { circleThresholdActive = newCircleThreshold; geomChanged = true }
        if (newSpiralGap !== undefined && newSpiralGap !== spiralGapActive) { spiralGapActive = newSpiralGap; geomChanged = true }
        if (newAccent !== undefined && newAccent !== accentActive) { accentActive = newAccent; geomChanged = true }
        if (newLineColor !== undefined && newLineColor !== lineColorActive) { lineColorActive = newLineColor; geomChanged = true }
        if (newExpandable != null && newExpandable !== expandableActive) {
          expandableActive = newExpandable
          if (!expandableActive) doCollapseAll()   // al deshabilitar, re-formar y limpiar estado
        }
        if (cluster.recluster(this.#map.getZoom())) apply()
        else if (geomChanged && cluster.expandedGroups.length) apply()   // geometría cambió con espiral abierta → re-layout
        else syncFocus()   // sin cambio de recluster, pero dim-rest pudo togglear en caliente → resincronizar el enfoque
      },
      dispose: () => {
        if (disposed) return
        disposed = true
        this.unfocusAll()                          // restaura opacidades por si el fold estaba atenuando el resto
        offBubbleClick?.()
        offSubClick?.()
        if (reindexTimer != null) { clearTimeout(reindexTimer); reindexTimer = null }   // cancela re-index diferido pendiente
        unsubs.forEach(u => u()); this.#map.off('zoomend', onZoom); this.#map.off('zoomstart', onZoomStart); sink.dispose()
        // Sesión spider: capa (removeLayer NO borra su pane → lo borro a mano), líneas y su pane.
        this.removeLayer(spiderId)
        this.removeLayer(spiderSubId)
        legGroup.remove()
        this.#map.getPane(legsPane)?.remove()
        this.#map.getPane('cristae-point-' + spiderId)?.remove()
        this.#map.getPane('cristae-point-' + spiderSubId)?.remove()
        // Teardown del engine: TODO se está removiendo, así que des-suprimir el host y
        // refrescarlo (+ resyncear sus labels/overlays ligados) es trabajo inútil y peligroso
        // — rebuildearía glify sobre un canvas que se destruye (crash `_redraw` getSize null).
        // El `destroy()` de cada capa libera igual. Fuera del teardown (quitar UNA capa) el
        // host SÍ se des-suprime y resyncea normalmente.
        if (this.#destroying) return
        for (const { id, rec } of hosts) {
          rec.suppressed = null; rec.layer.suppressed = null; rec.layer.refresh()   // sin cluster → host completo
          this.#resyncBound(id)
          if (rec.cluster === control) rec.cluster = null
        }
      },
      // API de expand/collapse: usada por CristaeCluster y como escape-hatch via getUnsafeHandler.
      // `id` es un cluster-id de Supercluster — sólo válido dentro del frame actual; el caller debe
      // pasarlo recién obtenido. El estado interno queda anclado por hoja, así que sobrevive a
      // reindex/zoom aunque el id ya no exista. Para reaccionar a la interacción del usuario, preferir
      // los eventos del bus `map.on('cluster:expand'|'cluster:update'|'cluster:dismiss', cb)`.
      expand: (id) => {
        const res = cluster.expandCluster(id)
        if (res && cluster.recluster(this.#map.getZoom())) apply()   // apply() es el ÚNICO emisor de 'cluster:expand'
        return res ? res.ids : null
      },
      collapse: (id) => {
        const ids = cluster.collapseCluster(id)
        if (ids && cluster.recluster(this.#map.getZoom())) apply()   // apply() emite 'collapse' por transición
      },
      collapseAll: () => doCollapseAll(),
      // Re-indexa el cluster con el snapshot actual (source ∧ where). Lo dispara setWhere cuando cambia
      // el filtro por-capa: un cambio de `where` no emite en la Source (que sigue completa), así que sin
      // esto las burbujas mantendrían el conteo de la flota sin filtrar.
      reindex: () => doIndex(),
      isExpanded: (id) => cluster.isClusterExpanded(id),
      // ¿esta capa pertenece al fold? (burbuja o spider). El auto-collapse del web component lo usa
      // para NO colapsar cuando el click cae en la burbuja o en un marcador de la espiral.
      ownsLayer: (layerId) => layerId === bubbleId || layerId === spiderId || layerId === spiderSubId,
      // Lectura imperativa de la sesión actual (o null): paridad con map.camera para consumidores que
      // montan tarde y necesitan el estado sin esperar el próximo evento cluster:*.
      getSession: () => { const s = cluster.sessionStructure; return s ? buildSession(s, cluster.expandedGroups[0]?.center ?? null) : null },
      // Zoom mínimo al que `id` deja de estar clusterizado (cómputo puro; ver Cluster.declusterZoomFor).
      // Lo inyecta la cámara para revealPoint/followPoint({reveal}); también disponible para lectura
      // imperativa. null si el id no está en el cluster o el clustering está apagado.
      declusterZoomFor: (id) => cluster.declusterZoomFor(id),
      // ── Eje "marked": burbujas que contienen ids marcados por el consumidor ──
      // setMarked REEMPLAZA el set (snapshotea el input antes de limpiar: aliasing-safe) →
      // recluster re-taggea las burbujas (variante `marked` del icon-set) y apply() emite
      // `cluster:marked` si la colocación cambió. La lib nunca muta el set por su cuenta: un id
      // podado que reaparece vuelve a señalizarse solo; desmarcar es del consumidor.
      setMarked: (ids) => {
        const next = ids ? Array.from(ids) : []
        markedSet.clear()
        for (const id of next) markedSet.add(id)
        cluster.marked = markedSet
        if (cluster.recluster(this.#map.getZoom())) apply()
      },
      // Lectura imperativa del eje marked (paridad con getSession): mismo payload que el evento.
      getMarked: () => buildMarked(cluster.markedHidden),
      // Contenido (ids de dato) de una burbuja del frame actual — consulta pura, hermana de
      // expand() pero sin efectos. Misma guarda de generación que el click handler. Sólo entiende
      // ids de burbuja BASE (los de Supercluster + el sintético 'b:' de la sesión); el contenido de
      // una SUB-burbuja de la espiral se lee de la estructura de sesión (getSession / cluster:*).
      contentsOf: (id) => (bubbleRec?.source?.itemById?.(id) ? cluster.contents(id) : null),
      // Id de la capa de burbujas: el consumidor se suscribe a sus hits por el bus normal
      // (map.on('click' | 'hover', bubbleLayerId, cb)) y compone con contentsOf/expand.
      bubbleLayerId: bubbleId,
      // Id de la capa de SUB-burbujas de la espiral (jerarquía depth-2). Mismo patrón que bubbleLayerId:
      // suscribirse a sus hits por el bus; el hit.id es el ancla del grupo → componer con la estructura
      // de sesión (getSession / eventos cluster:*), que trae los miembros de cada grupo.
      subBubbleLayerId: spiderSubId,
      set onInteraction(fn) { _onInteraction = fn },
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
      kind: 'overlay', source: host.source, layer, paneName, order, bindTo: hostId, visible,
      // el cluster reinvoca esto al re-suprimir (#resyncBound): re-apunta al ref vivo del host + reconstruye.
      resync: () => { layer.suppressed = this.#layers.get(hostId)?.suppressed ?? null; layer.refresh() },
    }
    this.#layers.set(id, record)
    this.#applyVisibility(id, paneName, visible && host.enabled !== false)   // ligado: nace oculto si su host está deshabilitado
    if (host.enabled === false) layer.enabled = false                        // y gateado (setLayerEnabled(true) lo revive con resync)

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
      glify: this.#glify, map: this.#map, pane: record.paneName, source, iconSet: record.iconSet, interactive: record.interactive, where: record.where,
    }))
    if (record.enabled === false) record.layer.enabled = false   // el swap conserva el gate de la entidad deshabilitada
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
    // `visible` (pintado) se persiste para componer con `enabled` (membresía de la entidad): la
    // visibilidad EFECTIVA del pane es visible ∧ enabled — el propio para hosts, el del host para
    // ligados (bindTo). Los labels mantienen su flag por su canal propio (gate del sync, #bindLabels).
    if (record.kind !== 'label') record.visible = visible
    const host = record.bindTo ? this.#layers.get(record.bindTo) : null
    const effective = visible && record.enabled !== false && (!host || host.enabled !== false)
    this.#applyVisibility(id, record.paneName, effective)
    if (!effective) this.#bus.clearLayer(id)
    return true
  }

  // Habilita/deshabilita una capa de puntos como ENTIDAD de la composición — eje ortogonal a
  // `visible` (pintado puro): deshabilitada aporta ∅ a los modificadores que la consumen (un
  // cluster que la envuelva re-indexa sin sus puntos y recomputa las burbujas), su pane se
  // oculta, su picking se limpia y sus LIGADOS (labels/overlays bind-to) se ocultan con ella.
  // Habilitarla restaura todo (resync + reindex incluidos). Idempotente; NO toca la Source —
  // los datos siguen vivos (move/patch del WS) y al volver, la capa aparece al día.
  setLayerEnabled(id, enabled) {
    const record = this.#layers.get(id)
    if (!record || record.kind !== 'point') return false
    const next = enabled !== false
    if ((record.enabled !== false) === next) return true
    record.enabled = next
    // Gate del pipeline de render: deshabilitada, la capa NO reacciona a la Source (cero CPU/GPU
    // por emit del WS — el ahorro real de "deshabilitar", no sólo ocultar). refresh() abajo es el
    // catch-up al volver (la Source siguió viva mientras tanto).
    record.layer.enabled = next
    this.#applyVisibility(id, record.paneName, next && record.visible !== false)
    if (!next) this.#bus.clearLayer(id)
    // Ligados: siguen la suerte de la ENTIDAD (un badge/label de un host deshabilitado no queda
    // flotando solo). Componen su propio `visible` — re-habilitar no revive lo que el consumidor
    // ocultó por su toggle. Los labels van por su canal nativo (setVisibility: pane + gate de
    // pintado JUNTOS — su canvas retiene lo último pintado, ocultar sólo el pane desalinearía el
    // gate al componer con su propio toggle); los overlays gatean su pipeline y ocultan su pane.
    this.#layers.forEach((r, rid) => {
      if (r.bindTo !== id) return
      const on = next && r.visible !== false
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
    if (this.#destroying) return
    this.#destroying = true
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
  // conjunto brillante (se re-atenúan); `unfocusAll()` restaura todo. Sólo toca `pane.style.opacity`:
  // barato, NO re-renderiza glify ni toca datos ni el picking → las capas atenuadas siguen interactivas.
  // Idempotente (recomputa desde cero). Cubre por id de capa; los panes sin capa (líneas del spider) no
  // se tocan → quedan a opacidad plena junto al foco. `kinds` acota QUÉ capas se atenúan (por kind:
  // 'point'/'label'/'polygon'…); null = todas. Ej: atenuar sólo marcadores dejando las geocercas de
  // contexto intactas → `focus(ids, { kinds: ['point', 'label'] })`.
  focus(ids, { opacity = 0.3, kinds = null } = {}) {
    this.#focused = new Set(ids)
    this.#dimOpacity = opacity
    this.#focusKinds = kinds
    this.#applyFocus()
  }

  unfocus(ids) {
    if (!this.#focused) return
    for (const id of ids) this.#focused.delete(id)
    this.#applyFocus()
  }

  unfocusAll() {
    if (!this.#focused) return
    this.#focused = null
    for (const [, rec] of this.#layers) if (rec.paneName) this.#applyOpacity(rec.paneName, 1)
  }

  setLayerOpacity(id, alpha) {
    const rec = this.#layers.get(id)
    if (rec?.paneName) this.#applyOpacity(rec.paneName, alpha)
  }

  #applyFocus() {
    for (const [id, rec] of this.#layers) {
      if (!rec.paneName) continue
      if (this.#focusKinds && !this.#focusKinds.includes(rec.kind)) continue   // fuera de alcance → intacta (brillante)
      // Las capas LIGADAS a un host (labels/overlays con bindTo) siguen su suerte de foco: un
      // badge no queda brillante sobre un marcador atenuado ni atenuado sobre uno enfocado.
      const key = rec.bindTo ?? id
      this.#applyOpacity(rec.paneName, this.#focused.has(key) ? 1 : this.#dimOpacity)
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
      set: (items) => controls?.set(items),
      patch: (items, dirtyIds) => controls?.patch(items, dirtyIds),
      move: (itemId, lat, lng) => controls?.move(itemId, lat, lng),
      remove: (itemId) => controls?.remove(itemId),
      addFilter: (f) => controls?.addFilter(f),
      removeFilter: (fid) => controls?.removeFilter(fid),
      // Membresía declarativa por-capa: cambia el predicado `where` y reconstruye SOLO esta
      // capa (no toca la Source compartida → otras vistas no se ven afectadas). Lee record.layer
      // (no captura) porque attachSource puede swapear la capa. Espejo del setWhere del overlay.
      // Además persiste el `where` en el record y RE-INDEXA el cluster que envuelve esta capa (si lo
      // hay): el cluster indexa `source ∧ where`, y un cambio de `where` no emite en la Source → sin
      // esto los conteos de burbuja quedarían obsoletos (mostrarían la flota completa, no la filtrada).
      setWhere: (fn) => { record.where = fn ?? null; record.layer.where = fn; record.layer.refresh(); record.cluster?.reindex() },
      preloadIcons: (variants) => iconSet?.seed(variants),
      refresh: () => record.layer.refresh(),
      setVisible: (v) => this.setLayerVisibility(id, v),
      // Membresía de la ENTIDAD en la composición (eje ortogonal a setVisible, que es pintado
      // puro): off → la capa aporta ∅ a sus modificadores (el cluster re-indexa sin ella), pane
      // oculto, picking limpio y ligados ocultos. Ver setLayerEnabled.
      setEnabled: (v) => this.setLayerEnabled(id, v),
    }
  }

  // Burbuja parametrizable: el consumidor define CÓMO se ven los clusters (capa de puntos con
  // icon-set de cluster, o capa de labels con el conteo), o usa el default. El sink expone
  // `feed(bubbles)` (la forma de alimentar varía por tipo) y `dispose`.
  // interactive: true cuando expandable está activo (las burbujas reciben clicks de expand/collapse).
  #makeBubbleSink(bubble, bubblePane, order, hostId, interactive = false) {
    const siblingId = `${hostId}:clusters`
    const zIndex = BASE_Z + order * Z_STEP + LABEL_Z_OFFSET + 5   // burbujas sobre los labels (+200) — mismo pane que bubblePane
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
    this.#layers.set(siblingId, { kind: 'point', source: controls, layer, controls, paneName: bubblePane, order, interactive })
    if (interactive) {
      this.#pickLayers.push({ layerId: siblingId, layer })
      // La burbuja ocluye lo que tiene debajo (capa overlay): su click no se filtra a geocercas/puntos.
      // Hover real (demand-gated: sólo computa si alguien se suscribe) → la burbuja es una entidad
      // consultable como cualquier otra: hits por el bus + contentsOf del control.
      this.#registerResolver(siblingId, 'point', zIndex, order, e => layer.resolveClick(e), e => layer.resolveHover(e), { capture: true })
    }
    return {
      // feed SINCRÓNICO con el recluster: set() deja el Store al día ya, y refresh() reconstruye
      // buffers + #idBySlot + picking EN EL MISMO TICK (la emisión del Source va a rAF, el rebuild
      // acá no espera). Sin el refresh, el pick de un click quedaría UNA generación detrás del
      // estado vivo (ventana rAF): un cluster-id viejo que colisione numéricamente con uno nuevo
      // (los ids de Supercluster son densos) pasaría la guarda de itemById y getLeaves resolvería
      // OTRO cluster. El #onChange del rAF posterior re-camina los dirty ya escritos (idempotente,
      // n = nº de burbujas). Simétrico con los hosts (apply) y el spider (applySpider).
      feed: (bubbles) => { controls.set(bubbles); layer.refresh() },
      // removeLayer limpia registry, pickLayers y bus — más completo que el destroy manual anterior.
      dispose: () => this.removeLayer(siblingId),
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

  // IconSet de los SUB-CLUSTERS de la espiral (jerarquía): estilo claro+anillo, distinto a la burbuja
  // base sólida; un poco más chico. Sin `accent` → color por conteo, cacheado (lazy, compartido). Con
  // `accent` → color fijo, icon-set propio (no cacheado: cada acento es distinto).
  #subClusterIconSet(accent = null) {
    if (accent) return defineClusterIconSet({ draw: makeSubClusterDraw(accent), sizes: { default: DEFAULT_CLUSTER_SIZE - 6 } })
    return this.#defaultSubClusters ??= defineClusterIconSet({ draw: SUB_CLUSTER_DRAW, sizes: { default: DEFAULT_CLUSTER_SIZE - 6 } })
  }

  #bindLabels(id, record, { bindTo, textOf, accessors, source }) {
    const host = bindTo ? this.#layers.get(bindTo) : null
    if (bindTo && !host) return false                          // host aún no declarado → pendiente

    const src = host ? host.source : source
    if (!src) return true                                      // standalone sin fuente todavía: queda listo para setLabels manual
    const idOf = (host ? host.source.accessors.idOf : accessors.idOf)
    const posOf = (host ? host.source.accessors.positionOf : accessors.positionOf)
    const text = textOf ?? (item => String(idOf(item)))

    const sync = () => {
      // Guard de visibilidad: si la capa está oculta —o su host está deshabilitado como ENTIDAD
      // (setLayerEnabled ocultó este pane junto a él)— saltar el reduce O(n) + setLabels. Con WS
      // a alta frecuencia este sync se invoca en cada emit (~1/frame); sin el guard procesaría
      // 2000+ ítems y pintaría fillText en un canvas que el usuario no ve. `record.visible` lo
      // setea addLabelLayer.setVisible; para bubble-labels (#makeBubbleSink, sin addLabelLayer)
      // es undefined → no se aplica el guard (siempre visible). Al re-habilitar el host,
      // setLayerEnabled resyncea (este mismo sync) → labels frescos.
      if (record.visible === false || host?.enabled === false) return
      record.layer.setLabels(
        src.getSnapshot().reduce((acc, item) => {
          const itemId = idOf(item)
          if (host?.suppressed?.has(itemId)) return acc        // clusterizado → sin label flotante
          const p = posOf(item)
          if (p && Number.isFinite(p.lat) && Number.isFinite(p.lng)) acc.push({ id: itemId, lat: p.lat, lng: p.lng, text: text(item) })
          return acc
        }, []))
    }

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
