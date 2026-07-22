import { Cluster } from './Cluster.js'

// ClusterFold — orquestación del fold de cluster (SPECS §8.3): clusteriza el conjunto UNIÓN de varios
// hosts en UN solo supercluster y reparte el MISMO set `suppressed` (ref estable, mutado in place) a
// TODOS los hosts y a sus ligados (labels + overlays, que leen `host.suppressed`). Vive fuera de
// MapEngine y NO toca sus privados: pide los servicios del motor (panes, capas, focus, bus, emit,
// proyección) por el `bridge` acotado que le pasa `MapEngine.addClusterFold`. La API que expone (el
// objeto `control` + el descriptor de retorno) es idéntica a la que devolvía el motor.
//
// El bridge expone: `map`/`L` (Leaflet), `layerOf(id)`, `nextOrder()`, `overlayZ(order, extra)` (z de
// las capas del fold, sobre los labels), `subAccent` (acento default de la traza), `ensurePane`,
// `makeBubbleSink`, `subClusterIconSet`, `addPointLayer`, `removeLayer`, `resyncBound`, `focus`,
// `unfocusAll`, `emit`, `busOn`, `destroying()`.

// Ventana de coalescido del re-index del cluster ante moves de POSICIÓN (no estructurales).
// `cluster.index` (Supercluster.load) es O(n log n) + ~4 allocs/punto y resetea la firma → fuerza
// apply() (rebuild GL completo). Bajo WS la Source emite ~1 vez/frame; re-indexar por frame satura
// el hilo y traba el zoom. A zoom de cluster, mover unos metros NO cambia el bucket → el re-index
// puede diferirse a esta ventana sin pérdida visual. Los cambios ESTRUCTURALES (alta/baja/patch)
// NO esperan: re-indexan al instante (ver onData).
const CLUSTER_REINDEX_THROTTLE_MS = 1000

// Decimales del centro de burbuja en la firma de `cluster:marked` (~1 m). El centroide puede
// correrse por miembros NO marcados sin cambiar la membresía del marcado: con el centro en la
// firma, el ancla reportada se re-emite y no queda despegada del sprite. Más fino re-emitiría
// por jitter sub-marcador; más grueso dejaría el ancla visiblemente corrida.
const MARKED_CENTER_QUANT = 5

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

// Crea un fold de cluster sobre `targets` (capas de puntos del motor). El `<cristae-cluster>` declarativo
// entra por acá vía el reductor de la gramática; `MapEngine.addCluster` (un host) es azúcar que delega.
// Devuelve el descriptor `{ kind, id, handle, source, suppressed }`, o null si ningún target es punto.
export function createClusterFold(bridge, targets, { radius, maxZoom, minPoints, enabled, expandable = true, bubble, dimRest = false, dimRestOpacity = 0.3, dimMarked = false, dimRestExcept = [], circleThreshold = null, spiralGap = null, accent = null, lineColor = null } = {}) {
  const hosts = []
  for (const t of targets) {
    const rec = bridge.layerOf(t.id)
    if (rec && rec.kind === 'point') hosts.push({ id: t.id, rec })
  }
  if (!hosts.length) return null

  // Config VIVA del fold: un solo objeto mutado por setConfig (en vez de 9 `let` sueltos).
  const cfg = {
    expandable: expandable ?? true,          // mutable via setConfig
    dimRest,                                 // atenuar el resto del mapa al expandir
    dimRestOpacity: dimRestOpacity ?? 0.3,
    dimMarked,                               // atenuar el resto mientras haya ids marcados
    dimRestExcept: dimRestExcept ?? [],      // capas del consumidor que quedan brillantes al atenuar
    circleThreshold,                         // umbral círculo↔espiral (nº) o null = auto (SPIDER_CIRCLE_MAX)
    spiralGap,                               // radio interior de la espiral (nº) o null = default (SPIDER_MIN_RADIUS)
    accent,                                  // color de acento (sub-burbujas al montar + traza si no hay lineColor) o null
    lineColor,                               // color de la TRAZA que une los elementos (el consumidor lo deriva) o null
  }
  const cluster = new Cluster({ radius, maxZoom, minPoints, enabled })
  const base = hosts[0].rec
  const { idOf, positionOf } = base.source.accessors   // ids deben ser únicos entre hosts (precondición)

  const foldId = `cluster-${bridge.nextOrder()}`
  const bubblePane = `${foldId}-bubbles`
  bridge.ensurePane(bubblePane, bridge.overlayZ(base.order, 5))   // sobre los labels (+200)
  // La burbuja se registra SIEMPRE como interactiva (no condicionada a expandable): así habilitar
  // expandable en runtime no exige recablear el picking. El gate real vive en el handler de click.
  const sink = bridge.makeBubbleSink(bubble, bubblePane, base.order, foldId, true)
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
  const spiderHandle = base.iconSet ? bridge.addPointLayer({
    id: spiderId, data: [], accessors: spiderAccessors, iconSet: base.iconSet,
    interactive: true, z: bridge.overlayZ(base.order, 7), presentAs: presentLeaf,   // hoja: sobre labels(+200), burbuja(+5) y líneas(+4)
  }) : null
  // Capa de SUB-CLUSTERS de la espiral (jerarquía): burbujas de conteo con el MISMO iconSet de
  // conteo que las burbujas base. Slots {kind:'subcluster'} van acá; los {kind:'leaf'} a `spiderHandle`.
  const spiderSubId = `${foldId}:spider-sub`
  const subIconSet = bridge.subClusterIconSet(cfg.accent)   // accent (si hay) pinta las sub-burbujas; fijado al montar
  const spiderSubHandle = bridge.addPointLayer({
    id: spiderSubId, data: [],
    accessors: {
      idOf: s => s.id,
      positionOf: s => ({ lat: s.lat, lng: s.lng }),
      variantOf: s => (subIconSet.variantForCount?.(s.count) ?? String(s.count)),
      hashOf: s => `${s.count}:${s.lat}:${s.lng}`,   // re-encode al cambiar conteo/posición
    },
    iconSet: subIconSet, interactive: true, z: bridge.overlayZ(base.order, 8), capture: true,   // sobre labels(+200); ocluye lo de abajo
  })
  const legsPane = `${foldId}-legs`
  // Líneas DETRÁS de la burbuja (+5) y de los marcadores (+7): look canónico spiderfy. Si fueran
  // encima, con muchas patas tapan el centro y la burbuja dim queda ilegible.
  bridge.ensurePane(legsPane, bridge.overlayZ(base.order, 4), true)        // sobre labels(+200); noPointer: las líneas no pican
  const legGroup = bridge.L.layerGroup([], { pane: legsPane }).addTo(bridge.map)
  const setLegs = (segs) => {
    legGroup.clearLayers()
    for (const s of segs)
      bridge.L.polyline(s.pts, { pane: legsPane, color: s.color, weight: s.weight, opacity: s.opacity ?? 0.7, interactive: false }).addTo(legGroup)
  }
  // Recalcula espiral (px del contenedor → latlng) + marcadores + líneas desde cluster.expandedGroups.
  // Sin expansión → vacía capa y líneas. Colapsa en zoomstart, así que nunca queda con el pixel-radius
  // de otro zoom (no hay drift). Cero costo cuando no hay nada expandido (groups vacío).
  const applySpider = () => {
    if (!spiderHandle) return
    leafLL.clear()
    const leafItems = [], subItems = [], segs = [], bands = []
    for (const g of cluster.expandedGroups) {
      const c = bridge.map.latLngToContainerPoint([g.center.lat, g.center.lng])
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
      const circleMax = cfg.circleThreshold ?? SPIDER_CIRCLE_MAX   // umbral círculo↔espiral configurable (auto = default)
      const gap = cfg.spiralGap ?? SPIDER_MIN_RADIUS                // radio interior de la espiral configurable
      const keepCircle = collapsedCount > 0 && collapsedCount <= circleMax
      const offs = spiderfyOffsets(c.x, c.y, g.slots.length, hasSub ? 58 : 54, gap, keepCircle ? g.slots.length : circleMax)
      // Traza que UNE los marcadores ENTRE SÍ (no las patas al centro): es lo que hace legible la forma
      // de la espiral aunque quede compacta. Un tramo por corrida contigua del MISMO tipo — hojas
      // (individuales 'base' o florecidas 'bloom') → traza índigo; sub-burbujas → traza gris —. Va gruesa
      // y con harta opacidad para SEGUIRLA a simple vista (asoma en el hueco entre marcadores); las patas
      // al centro (segs) quedan tenues y secundarias.
      let runType = null, runPts = null
      const flushRun = () => {
        if (runPts && runPts.length >= 2) {
          const leaf = runType !== 'sub'   // 'base' | 'bloom' = hojas
          // Color de la traza que UNE los elementos: `lineColor` si el consumidor lo pasó (típico: una
          // variación cromática del acento para que los marcadores del acento puro resalten), si no el
          // `accent`, si no los defaults. Las secciones se distinguen por opacidad (hojas 0.6 / sub 0.55).
          // La librería NO deriva colores: recibe el que corresponda ya resuelto.
          const color = cfg.lineColor ?? cfg.accent ?? (leaf ? bridge.subAccent : '#94a3b8')
          bands.push({ pts: runPts, color, weight: 12, opacity: leaf ? 0.6 : 0.55 })
        }
        runType = null; runPts = null
      }
      g.slots.forEach((slot, i) => {
        const ll = bridge.map.containerPointToLatLng(offs[i])
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
    const porExpansion = cfg.dimRest && cluster.expandedGroups.length
    const porMarcado = cfg.dimMarked && cluster.hasMarked
    if (porExpansion || porMarcado)
      // Sólo marcadores (point/label/overlay): las geocercas/polígonos quedan como contexto, no
      // se atenúan. Las capas LIGADAS (labels/overlays con bindTo) siguen la suerte de su host.
      bridge.focus([spiderId, spiderSubId, bubbleId, ...cfg.dimRestExcept], { opacity: cfg.dimRestOpacity, kinds: ['point', 'label', 'overlay'] })
    else
      bridge.unfocusAll()
  }
  // Estado de expansión mostrado, para detectar transiciones expandido→colapsado en apply(). apply() es
  // el ÚNICO emisor de 'collapse': cubre TODA causa de cierre (colapso explícito, click-toggle, zoom,
  // deshabilitar clustering, o el reindex que poda el ancla al salir su móvil de la flota). 'expand' sí
  // es explícito (lo emiten los handlers de click / la API, con su payload rico: clusterId, center, entities).
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
      bridge.resyncBound(id)                      // recluster → re-filtra labels + overlays ligados a este host
    }
    sink.feed(cluster.bubbles)
    applySpider()                                // marcadores en espiral + líneas de los expandidos
    syncFocus()                                  // resalta el spider / atenúa el resto (si dim-rest)
    // ── Emisor ÚNICO de la sesión de expansión (cluster:expand/update/dismiss) ──
    // Cubre TODA causa (click en burbuja base/sub, zoom, poda del ancla, enabled=false) comparando la
    // sesión previa vs la nueva por id + firma estructural. Gated por firma → NO emite en un reindex sin
    // cambio estructural (p. ej. sólo moves de WS): la lista llega una vez y el consumidor la actualiza
    // en vivo desde la Source compartida. El `_onInteraction` interno mantiene el botón central (X) del
    // elemento; `bridge.emit` publica el evento del bus (`map.on('cluster:*')`).
    const struct = cluster.sessionStructure
    if (!struct) {
      if (lastSession) {
        const detail = { id: lastSession.id, reason: dismissReason }
        lastSession = null
        _onInteraction?.({ type: 'dismiss' })
        bridge.emit('cluster:dismiss', detail)
      }
    } else {
      const center = cluster.expandedGroups[0]?.center ?? null
      const sig = struct.id + '|' + struct.count + '|' + (struct.groups.find(g => g.expanded)?.id ?? '')
      if (!lastSession) {
        lastSession = { id: struct.id, sig }
        _onInteraction?.({ type: 'expand', center })
        bridge.emit('cluster:expand', buildSession(struct, center))
      } else if (lastSession.id !== struct.id) {
        // Cambió de base directo (abrir otra sin cerrar): dismiss del viejo + expand del nuevo.
        bridge.emit('cluster:dismiss', { id: lastSession.id, reason: 'collapse' })
        lastSession = { id: struct.id, sig }
        _onInteraction?.({ type: 'expand', center })
        bridge.emit('cluster:expand', buildSession(struct, center))
      } else if (lastSession.sig !== sig) {
        lastSession.sig = sig
        _onInteraction?.({ type: 'update', center })
        bridge.emit('cluster:update', buildSession(struct, center))
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
        bridge.emit('cluster:marked', buildMarked(cluster.markedHidden))
      }
    }
  }
  const doIndex = () => { cluster.index(snapshot(), idOf, positionOf); if (cluster.recluster(bridge.map.getZoom())) apply() }
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
  const onZoom = () => { if (cluster.recluster(bridge.map.getZoom())) apply() }
  const unsubs = hosts.map(({ rec }) => rec.source.subscribe(onData))
  bridge.map.on('zoomend', onZoom)
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
    if (cluster.collapseAll() && cluster.recluster(bridge.map.getZoom())) { apply(); return true }   // apply() emite 'collapse' por transición
    return false
  }

  // Colapso al hacer ZOOM: la pertenencia del ancla no tiene sentido entre niveles de zoom (el
  // ancla cae en ALGÚN cluster a cada zoom → auto-expandiría uno distinto). Limpiar en zoomstart
  // mantiene los bursts de zoom en el fast-path de recluster (zoom re-clusteriza, como en los wrappers de mapa).
  const onZoomStart = () => { dismissReason = 'zoom'; doCollapseAll(); dismissReason = 'collapse' }
  bridge.map.on('zoomstart', onZoomStart)

  // Click en burbuja → expande ESE cluster (modelo ancla). Se registra SIEMPRE; el toggle
  // `cfg.expandable` se evalúa en vivo. Guarda de generación: hit.ref debe existir en la fuente
  // de burbujas VIVA, que contiene exactamente los cluster-ids de la generación de #sc vigente
  // (apply() la repobla sincrónicamente tras cada recluster). Si no está, la burbuja es de un paint
  // previo (repaint pendiente) → se ignora. Así getLeaves nunca recibe un id stale (ni lanza ni
  // devuelve hojas equivocadas).
  const bubbleRec = bridge.layerOf(bubbleId)
  // El bus entrega los handlers por-capa con un ARRAY de hits (ya filtrado a esta capa), no un hit
  // suelto (ver EventBus.#emit). El top hit de la burbuja es hits[0].
  const offBubbleClick = bridge.busOn('click', bubbleId, (hits) => {
    if (!cfg.expandable) return
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
      if (ids && cluster.recluster(bridge.map.getZoom())) apply()   // apply() emite 'collapse' por transición
    } else {
      const res = cluster.expandCluster(ref)
      if (res && cluster.recluster(bridge.map.getZoom())) apply()   // apply() es el ÚNICO emisor de 'cluster:expand'
    }
  })

  // Click en SUB-CLUSTER de la espiral (depth-2): florece SUS hojas empujando a los hermanos (toggle).
  // hits[0].ref = el id del sub-bubble = min leaf-id = el ancla interna que espera expandInner.
  const offSubClick = bridge.busOn('click', spiderSubId, (hits) => {
    if (!cfg.expandable) return
    const subId = hits[0]?.ref
    if (subId == null) return
    cluster.expandInner(subId)
    if (cluster.recluster(bridge.map.getZoom())) apply()
  })

  let disposed = false
  const control = {
    setConfig: ({ radius, maxZoom, minPoints, enabled, expandable: newExpandable, dimRest: newDimRest, dimRestOpacity: newDimRestOpacity, dimMarked: newDimMarked, dimRestExcept: newDimRestExcept, circleThreshold: newCircleThreshold, spiralGap: newSpiralGap, accent: newAccent, lineColor: newLineColor } = {}) => {
      if (radius != null) cluster.radius = radius
      if (maxZoom != null) cluster.maxZoom = maxZoom
      if (minPoints != null) cluster.minPoints = minPoints
      if (enabled != null) cluster.enabled = enabled
      if (newDimRestOpacity != null) cfg.dimRestOpacity = newDimRestOpacity
      if (newDimRest != null) cfg.dimRest = newDimRest
      if (newDimMarked != null) cfg.dimMarked = newDimMarked
      if (newDimRestExcept !== undefined) cfg.dimRestExcept = newDimRestExcept ?? []
      // Geometría/estilo de la espiral: no cambian la clusterización (recluster puede no gatillar), así
      // que si cambian con una espiral abierta hay que re-aplicar a mano para re-layoutear/re-colorear.
      // `accent` recolorea la TRAZA en caliente; las SUB-BURBUJAS quedan con el accent del montaje (su
      // icon-set está horneado) → un cambio reactivo de accent no las repinta.
      let geomChanged = false
      if (newCircleThreshold !== undefined && newCircleThreshold !== cfg.circleThreshold) { cfg.circleThreshold = newCircleThreshold; geomChanged = true }
      if (newSpiralGap !== undefined && newSpiralGap !== cfg.spiralGap) { cfg.spiralGap = newSpiralGap; geomChanged = true }
      if (newAccent !== undefined && newAccent !== cfg.accent) { cfg.accent = newAccent; geomChanged = true }
      if (newLineColor !== undefined && newLineColor !== cfg.lineColor) { cfg.lineColor = newLineColor; geomChanged = true }
      if (newExpandable != null && newExpandable !== cfg.expandable) {
        cfg.expandable = newExpandable
        if (!cfg.expandable) doCollapseAll()   // al deshabilitar, re-formar y limpiar estado
      }
      if (cluster.recluster(bridge.map.getZoom())) apply()
      else if (geomChanged && cluster.expandedGroups.length) apply()   // geometría cambió con espiral abierta → re-layout
      else syncFocus()   // sin cambio de recluster, pero dim-rest pudo togglear en caliente → resincronizar el enfoque
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      bridge.unfocusAll()                        // restaura opacidades por si el fold estaba atenuando el resto
      offBubbleClick?.()
      offSubClick?.()
      if (reindexTimer != null) { clearTimeout(reindexTimer); reindexTimer = null }   // cancela re-index diferido pendiente
      unsubs.forEach(u => u()); bridge.map.off('zoomend', onZoom); bridge.map.off('zoomstart', onZoomStart); sink.dispose()
      // Sesión spider: capa (removeLayer NO borra su pane → lo borro a mano), líneas y su pane.
      bridge.removeLayer(spiderId)
      bridge.removeLayer(spiderSubId)
      legGroup.remove()
      bridge.map.getPane(legsPane)?.remove()
      bridge.map.getPane('cristae-point-' + spiderId)?.remove()
      bridge.map.getPane('cristae-point-' + spiderSubId)?.remove()
      // Teardown del engine: TODO se está removiendo, así que des-suprimir el host y
      // refrescarlo (+ resyncear sus labels/overlays ligados) es trabajo inútil y peligroso
      // — rebuildearía glify sobre un canvas que se destruye.
      // El `destroy()` de cada capa libera igual. Fuera del teardown (quitar UNA capa) el
      // host SÍ se des-suprime y resyncea normalmente.
      if (bridge.destroying()) return
      for (const { id, rec } of hosts) {
        rec.suppressed = null; rec.layer.suppressed = null; rec.layer.refresh()   // sin cluster → host completo
        bridge.resyncBound(id)
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
      if (res && cluster.recluster(bridge.map.getZoom())) apply()   // apply() es el ÚNICO emisor de 'cluster:expand'
      return res ? res.ids : null
    },
    collapse: (id) => {
      const ids = cluster.collapseCluster(id)
      if (ids && cluster.recluster(bridge.map.getZoom())) apply()   // apply() emite 'collapse' por transición
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
      if (cluster.recluster(bridge.map.getZoom())) apply()
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

  return { kind: 'bubble', id: bubbleId, handle: { id: bubbleId, control }, source: bridge.layerOf(bubbleId)?.source, suppressed: null }
}
