// Stubs para montar un MapEngine headless en node:test y caracterizar el FOLD de cluster
// (addClusterFold). No es un jsdom ni un Leaflet real: sólo existe lo que el motor toca en el camino
// del cluster —construcción + addPointLayer + addClusterFold + control.*—. El GL/glify reusa el mismo
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
// construcción; el picking en sí NUNCA se ejercita en el harness (no se disparan clicks/hover).
const GL_CONSTS = {
  ARRAY_BUFFER: 1, DYNAMIC_DRAW: 2, TEXTURE_2D: 3, RGBA: 4, UNSIGNED_BYTE: 5, TEXTURE0: 6,
  LINEAR: 7, CLAMP_TO_EDGE: 8, TEXTURE_MIN_FILTER: 9, TEXTURE_MAG_FILTER: 10,
  TEXTURE_WRAP_S: 11, TEXTURE_WRAP_T: 12, CURRENT_PROGRAM: 13,
  drawingBufferWidth: 800, drawingBufferHeight: 600,
}
const makeGl = () => new Proxy({ ...GL_CONSTS }, {
  get: (t, p) => (p in t ? t[p] : () => ({})),
})

// UN glify por engine; cada points() devuelve una capa nueva (el fold crea host/burbuja/spider/sub).
export const makeGlify = () => ({
  points({ data }) {
    const layer = {
      gl: makeGl(),
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
    return layer
  },
})

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

// Contenedor DOM que toca Interaction (addEventListener/style/rect). No-op salvo lo mínimo.
const makeContainer = () => ({
  style: {},
  addEventListener() {}, removeEventListener() {},
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
})

// Proyección determinista e INVERTIBLE (px = coord·100): el fold la usa para el layout de la espiral
// (latLng→container→offsets→latLng). No se asertan píxeles; sólo hace falta que sea consistente.
const P = 100

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
    getContainer: () => container,
    getPane: (n) => panes.get(n) ?? null,
    createPane: (n) => { const p = { style: {}, remove() { panes.delete(n) } }; panes.set(n, p); return p },
    getPanes: () => ({ mapPane }),
    getZoom: () => map._zoom,
    // Helper del TEST: fija el zoom lógico (el que lee recluster). No dispara eventos por sí solo.
    setZoomForTest(z) { map._zoom = z; return map },
    getCenter: () => ({ lat: 0, lng: 0 }),
    getBounds: () => ({}),
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

export const makeLeaflet = () => ({
  DomUtil: { getPosition: () => ({ x: 0, y: 0 }) },
  layerGroup: () => {
    const g = {
      _layers: [],
      addTo: () => g,
      addLayer(l) { g._layers.push(l); return g },
      clearLayers() { g._layers.length = 0; return g },
      remove() {},
    }
    return g
  },
  polyline: (pts, opts) => ({ pts, opts, addTo: (g) => { g.addLayer?.({ pts, opts }); return {} } }),
  polygon: () => ({ addTo: () => ({}) }),
  point: (x, y) => ({ x, y }),
  latLng: (lat, lng) => ({ lat, lng }),
})
