// Stubs para montar un MapEngine o una capa headless en node:test. No es un jsdom ni un Leaflet real:
// existe lo que las capas y el motor tocan —construcción + addPointLayer + addClusterFold + control.*,
// más las factories nativas de Leaflet (marker / divIcon / polyline / polygon / rectangle / circle /
// latLngBounds / layerGroup) bajo UNA convención de log, ver makeLeaflet—. El GL/glify reusa el mismo
// enfoque que test/pointlayer.test.mjs (la capa no lee nada de vuelta salvo el buffer). Los iconSets
// de burbuja/sub-cluster que arma el fold son los REALES (defineClusterIconSet); rasterizan a un canvas
// stub cuyo ctx es no-op y cuyos píxeles nunca se leen en CPU (Atlas.tileAt guarda el canvas; sólo se
// entrega a gl.texImage2D, no-op). Así el harness ejerce el camino real de iconos, no uno paralelo.
//
// Globals de módulo (se ejecutan al EVALUAR este helper, ANTES que el árbol de MapEngine): LabelLayer y
// TileSnapshotRetention hacen `import L from 'leaflet'` por top-level (no por inyección), y la carga de
// Leaflet real toca window/navigator/document. Shim mínimo para que el módulo evalúe en node — Leaflet
// real NO se usa en el fold (L va inyectado por makeLeaflet). Mismo `document` sirve para el canvas que
// rasteriza defineClusterIconSet. El test importa este helper ANTES que MapEngine, así el shim ya está.

const NOOP_CTX = new Proxy({}, { get: () => () => {}, set: () => true })
const makeCanvas = () => ({ width: 0, height: 0, style: {}, getContext: () => NOOP_CTX })

if (!globalThis.window) {
  const doc = {
    documentElement: { style: {} },
    body: { style: {} },
    createElement: (tag) => (String(tag).toLowerCase() === 'canvas'
      ? makeCanvas()
      : { style: {}, setAttribute() {}, appendChild() {}, addEventListener() {}, removeEventListener() {} }),
    createElementNS: () => ({ style: {}, setAttribute() {} }),
    addEventListener() {}, removeEventListener() {},
  }
  const win = {
    navigator: { userAgent: '', platform: '' },
    document: doc,
    devicePixelRatio: 1,
    screen: { width: 800, height: 600 },
    location: { href: 'http://localhost/', protocol: 'http:' },
    getComputedStyle: () => ({}),
    requestAnimationFrame: (cb) => globalThis.setTimeout(() => cb(0), 0),
    cancelAnimationFrame: (id) => globalThis.clearTimeout(id),
    addEventListener() {}, removeEventListener() {},
  }
  // navigator NO se asigna: en node es un getter de sólo lectura (ya existe). Leaflet lee `navigator`
  // (cae al de node) o `window.navigator` (el del shim) — ambos alcanzan para su detección de browser.
  globalThis.window = win
  globalThis.document = doc
  globalThis.requestAnimationFrame ??= win.requestAnimationFrame
  globalThis.cancelAnimationFrame ??= win.cancelAnimationFrame
}

/* ── WebGL + glify (idéntico contrato al de pointlayer.test) ── */

// Constantes numéricas explícitas (para que cualquier comparación/aritmética sobre ellas se sostenga)
// + drawingBuffer*; el resto (métodos y constantes del picking: createRenderbuffer, fenceSync, FRAMEBUFFER…)
// cae al no-op del Proxy que devuelve {} — sirve como retorno de create*/getParameter y como arg ignorado
// de los métodos no-op. Las capas INTERACTIVAS del fold (burbuja/espiral) arman un FBO de picking en su
// construcción; el pase en sí sólo corre si el test dispara click/hover, y entonces lo observa por
// `gl.spy` (makePickSpy).
const GL_CONSTS = {
  ARRAY_BUFFER: 1, DYNAMIC_DRAW: 2, TEXTURE_2D: 3, RGBA: 4, UNSIGNED_BYTE: 5, TEXTURE0: 6,
  LINEAR: 7, CLAMP_TO_EDGE: 8, TEXTURE_MIN_FILTER: 9, TEXTURE_MAG_FILTER: 10,
  TEXTURE_WRAP_S: 11, TEXTURE_WRAP_T: 12, CURRENT_PROGRAM: 13,
  // Enums reales: el pase de picking los COMPARA (el status del fence) y los ADJUNTA (el destino), así
  // que no pueden caer al no-op del Proxy —que devolvería una función distinta en cada lectura—.
  POINTS: 0x0000, RGBA8: 0x8058, COLOR_ATTACHMENT0: 0x8CE0, DEPTH_ATTACHMENT: 0x8D00,
  TIMEOUT_EXPIRED: 0x911A, WAIT_FAILED: 0x911D,
  drawingBufferWidth: 800, drawingBufferHeight: 600,
}

// Espía del pase de PICKING, la única parte del GL que se le lee de vuelta a la GPU. `frame` es el
// parche que devuelven readPixels/getBufferSubData (lo pinta el test) y `status` guioniza el fence;
// el resto registra lo que el pase PIDIÓ —tamaño del destino, adjuntos, origen del viewport, tags de
// draw y draws—, que es lo caracterizable sin GPU. Vive en `gl.spy` de toda capa del harness.
const PICK_PATCH = 6

export const makePickSpy = () => ({
  frame         : new Uint8Array(PICK_PATCH * PICK_PATCH * 4),
  status        : 0,
  renderbuffers : 0,
  framebuffers  : 0,
  storage       : null,
  attachments   : [],
  viewports     : [],
  readbacks     : [],
  tags          : [],
  draws         : [],
})

// Los tags se guardan ya en bytes: el uniform viaja normalizado (÷255) y compararlo en float sería
// comparar redondeos.
const pickGl = spy => ({
  createRenderbuffer      : () => { spy.renderbuffers++; return {} },
  createFramebuffer       : () => { spy.framebuffers++;  return {} },
  renderbufferStorage     : (_target, format, width, height) => { spy.storage = { format, width, height } },
  framebufferRenderbuffer : (_target, attachment) => spy.attachments.push(attachment),
  viewport                : (x, y, width, height) => spy.viewports.push({ x, y, width, height }),
  uniform3fv              : (_loc, tag) => spy.tags.push([...tag].map(c => Math.round(c * 255))),
  drawArrays              : (mode, first, count) => spy.draws.push({ mode, first, count }),
  clientWaitSync          : () => spy.status,
  getBufferSubData        : (_target, _offset, dst) => dst.set(spy.frame),
  readPixels              : (x, y, width, height, _format, _type, dst) => {
    spy.readbacks.push({ x, y, width, height })
    if (dst instanceof Uint8Array) dst.set(spy.frame)   // la lectura diferida pasa el offset del PBO, no un array
  },
})
// `onLose`: spy de WEBGL_lose_context.loseContext() (para caracterizar el teardown de contexto GL).
// getExtension('WEBGL_lose_context') → { loseContext: onLose }; cualquier otra extensión → {} (como
// antes). El resto de métodos/constantes cae al no-op del Proxy.
export const makeGl = (onLose, spy = makePickSpy()) => new Proxy({ ...GL_CONSTS, ...pickGl(spy), spy }, {
  get: (t, p) => {
    if (p === 'getExtension') return (name) => (name === 'WEBGL_lose_context' ? { loseContext: onLose ?? (() => {}) } : {})
    return p in t ? t[p] : () => ({})
  },
})

// UN glify por engine; cada points() devuelve una capa nueva (el fold crea host/burbuja/spider/sub).
// `layers` expone las capas creadas (con `_lost`, que el spy de loseContext marca) para caracterizar
// que destroy() libera el contexto GL.
export const makeGlify = () => {
  const layers = []
  return {
    layers,
    points({ data }) {
      const layer = {
        _lost: false,
        bytes: 7,
        program: {},
        typedVertices: new Float32Array(Math.max(data.length, 1) * 7),
        mapMatrix: { array: new Float32Array(16) },
        mapCenterPixels: { x: 0, y: 0 },
        getBuffer: () => ({}),
        setData(next) { layer.typedVertices = new Float32Array(Math.max(next.length, 1) * 7) },
        layer: { redraw() {}, _reset() {} },
        remove() {},
      }
      layer.gl = makeGl(() => { layer._lost = true })
      layers.push(layer)
      return layer
    },
  }
}

// IconSet stub para los HOSTS (el fold no lo rasteriza; sólo direcciona). Atlas mínimo como en
// pointlayer.test. Las burbujas/sub-clusters usan el defineClusterIconSet REAL (canvas stub abajo).
export const makeIconSet = () => ({
  rotates: false,
  defaultSize: 24,
  atlas: {
    count: 1, cols: 1, rows: 1, tileSize: 2, capacity: 4,
    tileChannel: () => 0,
    cellOf: () => ({ col: 0, row: 0 }),
    tileAt: () => new Uint8Array(2 * 2 * 4),
  },
  resolve: () => 0,
  tileScale: () => 1,
})

// El canvas de defineClusterIconSet ya está cubierto por el `document` de módulo (arriba). Se conserva
// como no-op idempotente por si un test quiere ser explícito sobre la dependencia.
export const installCanvasStub = () => {}

/* ── Leaflet + L.map ── */

// Contenedor DOM que toca Interaction (addEventListener/style/rect) y el overlay de interacción
// (appendChild/removeChild del canvas). No-op salvo lo mínimo.
const makeContainer = () => ({
  style: {},
  addEventListener() {}, removeEventListener() {},
  appendChild() {}, removeChild() {},
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
})

// Proyección determinista e INVERTIBLE (px = coord·100): el fold la usa para el layout de la espiral
// (latLng→container→offsets→latLng). No se asertan píxeles; sólo hace falta que sea consistente.
const P = 100

// Point mínimo (divideBy/subtract/add) para el reproyectado de vista. Inmutable, como L.Point.
const makePoint = (x, y) => ({
  x, y,
  divideBy: (n) => makePoint(x / n, y / n),
  subtract: (p) => makePoint(x - p.x, y - p.y),
  add:      (p) => makePoint(x + p.x, y + p.y),
})

export const makeMap = ({ zoom = 3 } = {}) => {
  const panes = new Map()
  const handlers = new Map()   // evento → Set(cb); Leaflet acepta 'a b' (varios en un on)
  const container = makeContainer()
  const mapPane = { style: {} }

  const each = (types, fn) => { for (const t of String(types).split(/\s+/)) fn(t) }

  const map = {
    _zoom: zoom,
    on(types, cb) { each(types, t => (handlers.get(t) ?? handlers.set(t, new Set()).get(t)).add(cb)); return map },
    off(types, cb) { each(types, t => handlers.get(t)?.delete(cb)); return map },
    // Helper del TEST: dispara un evento del mapa (zoomstart/zoomend/…) hacia los handlers cableados.
    fire(type, e = {}) { handlers.get(type)?.forEach(cb => cb(e)); return map },
    whenReady(cb) { cb(); return map },
    // L.Layer.addTo(map) delega en map.addLayer. Se registra sin invocar onAdd: el harness no monta
    // canvas reales (la CanvasOverlay de labels exigiría panes y contexto 2D vivos).
    addLayer(layer) { map._added.push(layer); return map },
    removeLayer(layer) { map._added = map._added.filter(l => l !== layer); return map },
    _added: [],
    getContainer: () => container,
    getPane: (n) => panes.get(n) ?? null,
    createPane: (n) => { const p = { style: {}, appendChild() {}, remove() { panes.delete(n) } }; panes.set(n, p); return p },
    getPanes: () => ({ mapPane }),
    getZoom: () => map._zoom,
    // Helper del TEST: fija el zoom lógico (el que lee recluster). No dispara eventos por sí solo.
    setZoomForTest(z) { map._zoom = z; return map },
    getCenter: () => ({ lat: 0, lng: 0 }),
    getBounds: () => ({}),
    getSize: () => makePoint(800, 600),
    // Proyección a píxeles dependiente del zoom (px = coord·P·2^z), para el reproyectado de vista.
    project: (ll, z = map._zoom) => {
      const lat = Array.isArray(ll) ? ll[0] : ll.lat, lng = Array.isArray(ll) ? ll[1] : ll.lng
      const s = P * Math.pow(2, z)
      return makePoint(lng * s, lat * s)
    },
    invalidateSize: () => map,
    latLngToContainerPoint: (ll) => {
      const lat = Array.isArray(ll) ? ll[0] : ll.lat, lng = Array.isArray(ll) ? ll[1] : ll.lng
      return { x: lng * P, y: lat * P }
    },
    containerPointToLatLng: (pt) => {
      const x = Array.isArray(pt) ? pt[0] : pt.x, y = Array.isArray(pt) ? pt[1] : pt.y
      return { lat: y / P, lng: x / P }
    },
    containerPointToLayerPoint: (pt) => (Array.isArray(pt) ? { x: pt[0], y: pt[1] } : { x: pt.x, y: pt.y }),
    remove() {},
  }
  return map
}

// Toda coordenada se normaliza a {lat,lng} —venga par o objeto— como hace Leaflet al construir.
const toLatLng = ll => (Array.isArray(ll) ? { lat: ll[0], lng: ll[1] } : { lat: ll.lat, lng: ll.lng })

// `L` COMPLETO bajo UNA convención de log (antes cada test se armaba su propio doble y convivían dos
// nombres para lo mismo). Cada factory apila su instancia en el array de su naturaleza —en orden de
// creación— y cada instancia cuenta sus mutaciones en `<mutador>Calls` y guarda su último estado
// (`latlng` / `latlngs` / `radius` / `style` / `opacity`). Con eso una capa se caracteriza sin doble
// local: cuántos nodos creó, de qué naturaleza y qué se le tocó después.
export const makeLeaflet = () => {
  const log = { markers: [], paths: [], icons: [], clearLayers: 0, addLayer: 0 }

  // Molde único de path vectorial: expone TODOS los mutadores de path y cada capa usa los suyos
  // (polygon → setLatLngs, circle → setLatLng/setRadius) contra los mismos campos.
  const path = (tipo, { latlngs = null, latlng = null, opts = {} }) => {
    const p = {
      tipo, opts, latlngs, latlng,
      style:   { ...opts },
      radius:  opts.radius,
      removed: false,
      setStyleCalls: 0, setLatLngsCalls: 0, setLatLngCalls: 0, setRadiusCalls: 0,
      setStyle(s)    { p.setStyleCalls++;   p.style   = s;            return p },
      setLatLngs(ll) { p.setLatLngsCalls++; p.latlngs = ll;           return p },
      setLatLng(ll)  { p.setLatLngCalls++;  p.latlng  = toLatLng(ll); return p },
      setRadius(r)   { p.setRadiusCalls++;  p.radius  = r;            return p },
      getLatLngs: () => p.latlngs,
      getLatLng:  () => p.latlng,
      getRadius:  () => p.radius,
      addTo(g) { g.addLayer?.(p); return p },
      remove()  { p.removed = true },
    }
    log.paths.push(p)
    return p
  }

  // Marcador con handlers propios: `fire` los dispara como haría Leaflet ante el gesto real
  // (drag / dragend / dblclick / click), que es como el test ejerce una edición.
  const marker = (latlng, opts = {}) => {
    const handlers = new Map()
    const m = {
      opts, handlers,
      latlng:  toLatLng(latlng),
      icon:    opts.icon ?? null,
      opacity: opts.opacity ?? 1,
      removed: false,
      setLatLngCalls: 0, setOpacityCalls: 0,
      on(type, cb)  { (handlers.get(type) ?? handlers.set(type, []).get(type)).push(cb); return m },
      fire(type, e) { handlers.get(type)?.forEach(cb => cb(e)); return m },
      setLatLng(ll) { m.setLatLngCalls++;  m.latlng  = toLatLng(ll); return m },
      setOpacity(o) { m.setOpacityCalls++; m.opacity = o;            return m },
      getLatLng: () => m.latlng,
      addTo(g) { g.addLayer?.(m); return m },
      remove()  { m.removed = true },
    }
    log.markers.push(m)
    return m
  }

  return {
    log,
    marker,
    DomUtil: { getPosition: () => ({ x: 0, y: 0 }) },
    point:   (x, y) => ({ x, y }),
    latLng:  (lat, lng) => ({ lat, lng }),
    divIcon(opts = {}) {
      const icon = { isDivIcon: true, ...opts }
      log.icons.push(icon)
      return icon
    },
    polyline:  (latlngs, opts) => path('polyline',  { latlngs, opts }),
    polygon:   (latlngs, opts) => path('polygon',   { latlngs, opts }),
    rectangle: (bounds,  opts) => path('rectangle', { latlngs: bounds, opts }),
    circle:    (latlng,  opts) => path('circle',    { latlng: toLatLng(latlng), opts }),
    layerGroup: (iniciales = [], opts = {}) => {
      const g = {
        opts,
        layers: [...iniciales],
        addTo: () => g,
        addLayer(l)   { log.addLayer++;    g.layers.push(l);    return g },
        clearLayers() { log.clearLayers++; g.layers.length = 0; return g },
        remove() {},
      }
      return g
    },
    latLngBounds: (pts = []) => {
      let minLat = Infinity, minLng = Infinity, maxLat = -Infinity, maxLng = -Infinity
      const bounds = {
        extend(ll) {
          const { lat, lng } = toLatLng(ll)
          minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat)
          minLng = Math.min(minLng, lng); maxLng = Math.max(maxLng, lng)
          return bounds
        },
        contains(ll) {
          const { lat, lng } = toLatLng(ll)
          return lat >= minLat && lat <= maxLat && lng >= minLng && lng <= maxLng
        },
        isValid:   () => minLat <= maxLat,
        getCenter: () => ({ lat: (minLat + maxLat) / 2, lng: (minLng + maxLng) / 2 }),
        // Caja acumulada: deja asertar el encuadre sin depender de la aritmética interna de Leaflet.
        get box() { return { minLat, minLng, maxLat, maxLng } },
      }
      pts.forEach(pt => bounds.extend(pt))
      return bounds
    },
  }
}

// Presupuesto de NODOS sobre el log de un `L`: `markers` son nodos DOM (uno por ítem en las capas que
// no llegaron a la GPU), `paths` son paths SVG de Leaflet, `elementos` es el total que el navegador
// tiene que mantener vivo por esa capa. Es la contraparte barata del banco: mide la COTA estructural
// —cuántos nodos cuesta un set— sin navegador, sin reloj y sin medirse a sí misma.
export const contadorCreaciones = ({ log }) => ({
  get markers()   { return log.markers.length },
  get paths()     { return log.paths.length },
  get elementos() { return log.markers.length + log.paths.length },
  reset() {
    log.markers.length = log.paths.length = log.icons.length = 0
    log.clearLayers = log.addLayer = 0
  },
})
