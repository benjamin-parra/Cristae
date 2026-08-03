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

/* ── Registro de nodos DOM (alimenta el presupuesto; ver contadorNodos abajo) ── */

// El harness no monta nodos: los DECLARA. Dos entradas alimentan el registro y el contador no distingue
// cuál — el `document` del shim (todo lo que sale de createElement/createElementNS) y los dobles de
// Leaflet, donde un `L.marker` es el div de su icono y un path vectorial es su <path>. Por eso el
// presupuesto no miente cuando una capa deja de usar `L.marker`: si pasa a colgar nodos por su cuenta los
// cuenta igual, y si no cuelga ninguno mide 0 sin que haya que tocar el test.
const registro = { serie: 0, muertes: [] }

// Un nodo nace numerado y devuelve su baja, idempotente (quitarlo dos veces no descuenta dos).
const nodoDom = () => {
  const serie = registro.serie++
  let vivo = true
  return () => { vivo && registro.muertes.push(serie); vivo = false }
}

// Elemento del `document` del shim: no-op salvo lo que las capas tocan, más su baja.
const elemento = (base = {}) => Object.assign(base, {
  style:  base.style ?? {},
  remove: nodoDom(),
  setAttribute() {}, appendChild() {}, addEventListener() {}, removeEventListener() {},
  removeChild(hijo) { hijo?.remove?.() },
})

const NOOP_CTX = new Proxy({}, { get: () => () => {}, set: () => true })
const makeCanvas = () => ({ width: 0, height: 0, style: {}, getContext: () => NOOP_CTX })

if (!globalThis.window) {
  const doc = {
    documentElement: { style: {} },
    body: { style: {} },
    createElement: (tag) => elemento(String(tag).toLowerCase() === 'canvas' ? makeCanvas() : {}),
    createElementNS: () => elemento(),
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

// Constantes numéricas explícitas (para que cualquier comparación/aritmética sobre ellas se sostenga);
// el resto (métodos y constantes del picking: createRenderbuffer, fenceSync, FRAMEBUFFER…)
// cae al no-op del Proxy que devuelve {} — sirve como retorno de create*/getParameter y como arg ignorado
// de los métodos no-op. Las capas INTERACTIVAS del fold (burbuja/espiral) arman un FBO de picking en su
// construcción; el pase en sí sólo corre si el test dispara click/hover, y entonces lo observa por
// `gl.spy` (makePickSpy).
const GL_CONSTS = {
  ARRAY_BUFFER: 1, DYNAMIC_DRAW: 2, TEXTURE_2D: 3, RGBA: 4, UNSIGNED_BYTE: 5, TEXTURE0: 6,
  LINEAR: 7, CLAMP_TO_EDGE: 8, TEXTURE_MIN_FILTER: 9, TEXTURE_MAG_FILTER: 10,
  TEXTURE_WRAP_S: 11, TEXTURE_WRAP_T: 12, CURRENT_PROGRAM: 13,
  NEAREST: 14, RG: 15, RG32F: 16, FLOAT: 17, STATIC_DRAW: 18,
  // Enums reales: el pase de picking los COMPARA (el status del fence) y los ADJUNTA (el destino), así
  // que no pueden caer al no-op del Proxy —que devolvería una función distinta en cada lectura—.
  POINTS: 0x0000, RGBA8: 0x8058, COLOR_ATTACHMENT0: 0x8CE0, DEPTH_ATTACHMENT: 0x8D00,
  TIMEOUT_EXPIRED: 0x911A, WAIT_FAILED: 0x911D, PIXEL_PACK_BUFFER: 0x88EB,
}

// La superficie sobre la que rinde un contexto: el canvas MIDE `width × height` px CSS y su drawing
// buffer va a `× dpr`. Los dos tamaños hacen falta para que el harness vea un desajuste CSS↔dispositivo:
// con DPR 1 son el mismo número, y ahí cualquier confusión de unidades pasa en verde.
export const makeSurface = ({ width = 800, height = 600, dpr = 1 } = {}) => ({
  width        : Math.round(width * dpr),
  height       : Math.round(height * dpr),
  clientWidth  : width,
  clientHeight : height,
  style        : {},
})

const enSuperficie = canvas => ({
  canvas,
  drawingBufferWidth  : canvas.width,
  drawingBufferHeight : canvas.height,
})

// Espía del pase de PICKING, la única parte del GL que se le lee de vuelta a la GPU. El parche que
// devuelven readPixels/getBufferSubData sale de `bajoElCursor` DERIVADO de los draws del pase (ver
// `componer`) o, si nadie lo declaró, del `frame` crudo que pinta el test; `status` guioniza el fence.
// El resto registra lo que el pase PIDIÓ —tamaño del destino, adjuntos, origen del viewport, tags de
// draw y draws—, que es lo caracterizable sin GPU. Vive en `gl.spy` de toda capa del harness.
const PICK_PATCH = 6

// Los campos de subida (`tex*`, `buffer*`, `uploads`) son la otra mitad observable sin GPU: lo que se
// ESCRIBE. De un espejo de datos en GPU no se puede leer el contenido, pero sí el TRABAJO que costó
// mantenerlo —cuántas subidas, de qué tamaño y a qué offset—, que es lo que distingue una escritura
// incremental de una reconstrucción.
export const makePickSpy = () => ({
  frame          : new Uint8Array(PICK_PATCH * PICK_PATCH * 4),
  bajoElCursor   : undefined,   // ver `componer`: declarado (aunque sea null) ⇒ el parche lo deriva el pase
  tileVacio      : undefined,   // canal de tile transparente; sin declararlo ninguna entrada descarta
  status         : 0,
  renderbuffers  : 0,
  framebuffers   : 0,
  storage        : null,
  attachments    : [],
  viewports      : [],
  readbacks      : [],
  tags           : [],
  draws          : [],
  texImages      : [],
  texSubImages   : [],
  bufferDatas    : [],
  bufferSubDatas : [],
  uploads        : [],
  pase           : null,        // draws emitidos contra el framebuffer de picking, con su tag
  tagVivo        : null,        // el tag del draw en curso; se limpia al bindear, así ninguno hereda el anterior
  pack           : null,        // PBO bindeado: la lectura diferida deja el parche EN él
  array          : null,        // ARRAY_BUFFER bindeado; su `datos` es el espejo de lo que se le subió
  vao            : null,        // VAO bindeado; su `buffer` es el que leen sus atributos
})

// El texel del cursor —el pase traslada el viewport, así que siempre es el centro del parche— y el objeto
// que codifica un tag ya en bytes.
const CURSOR = ((PICK_PATCH >> 1) * PICK_PATCH + (PICK_PATCH >> 1)) * 4
const objDe  = tag => (tag[1] >> 2) | (tag[2] << 6)

// El fragment descarta por SILUETA (`if (tex.a < 0.01) discard`), así que una entrada con el tile
// TRANSPARENTE no escribe texel aunque el draw la cubra —es con lo que se apaga un handle del visual y del
// pase de una sola escritura—. El tile sale del espejo del VBO que alimenta al draw, que es de donde lo lee
// la GPU; `tileVacio` es el canal que el test declara transparente.
const FLOATS_ENTRADA = 7                  // layout de glify: [x, y, tile, angle, b, a, size]
const CANAL_TILE     = 2

const descarta = (spy, d, entrada) =>
  spy.tileVacio !== undefined
  && d.vbo?.datos?.[entrada * FLOATS_ENTRADA + CANAL_TILE] === Math.fround(spy.tileVacio)

// El parche que devuelve el pase NO lo pinta el test: lo COMPONE el doble con los draws que el pase emitió
// contra su framebuffer. `spy.bajoElCursor = { obj, entrada, local }` declara qué hay bajo el puntero —un
// hecho de la GEOMETRÍA—, y el texel sale sólo si algún draw de ese objeto cubrió esa entrada sin descartarla,
// con el tag de ESE draw; sin DEPTH_TEST gana el último, como en el pase real. Así una entrada que la capa
// dejó fuera de sus rangos NO se pickea: un doble que la contestara igual deja pasar un handle inagarrable
// en verde.
// `spy.frame` sigue siendo el parche CRUDO —bytes que no corresponden a ningún draw: otro objeto, el objeto
// sin entrada, el parche limpio— y es lo que caracteriza el DECODE, donde la entrada de verdad son bytes.
const componer = spy => {
  const frame = spy.frame
  const o     = spy.bajoElCursor
  if (o === undefined) return frame
  frame.fill(0)
  const d = o && spy.pase?.findLast(
    d => d.tag && objDe(d.tag) === o.obj && o.entrada >= d.first && o.entrada < d.first + d.count)
  if (!d || descarta(spy, d, o.entrada)) return frame
  const id = o.local + 1                    // el fragment suma el índice local +1 al tag del draw
  frame.set([d.tag[0] + (id >> 8), id & 255, d.tag[1], d.tag[2]], CURSOR)
  return frame
}

// Los tags se guardan ya en bytes: el uniform viaja normalizado (÷255) y compararlo en float sería
// comparar redondeos.
const pickGl = spy => ({
  createRenderbuffer      : () => { spy.renderbuffers++; return {} },
  createFramebuffer       : () => { spy.framebuffers++;  return {} },
  renderbufferStorage     : (_target, format, width, height) => { spy.storage = { format, width, height } },
  framebufferRenderbuffer : (_target, attachment) => spy.attachments.push(attachment),
  viewport                : (x, y, width, height) => spy.viewports.push({ x, y, width, height }),
  bindFramebuffer         : (_target, fbo) => { spy.pase = fbo ? [] : null; spy.tagVivo = null },
  bindBuffer              : (target, buf) => {
    target === GL_CONSTS.PIXEL_PACK_BUFFER && (spy.pack  = buf)
    target === GL_CONSTS.ARRAY_BUFFER      && (spy.array = buf)
  },
  uniform3fv              : (_loc, tag) => {
    spy.tagVivo = [...tag].map(c => Math.round(c * 255))
    spy.tags.push(spy.tagVivo)
  },
  drawArrays              : (mode, first, count) => {
    spy.draws.push({ mode, first, count })
    spy.pase?.push({ first, count, tag: spy.tagVivo, vbo: spy.vao?.buffer })
  },
  clientWaitSync          : () => spy.status,
  getBufferSubData        : (_target, _offset, dst) => dst.set(spy.pack?.parche ?? spy.frame),
  readPixels              : (x, y, width, height, _format, _type, dst) => {
    spy.readbacks.push({ x, y, width, height })
    const parche = componer(spy)
    // La lectura diferida pasa el offset del PBO, no un array: el parche queda EN el buffer hasta que lo
    // cobre `getBufferSubData` —que corre después del `#restore`, con el pase ya cerrado—.
    if (dst instanceof Uint8Array) dst.set(parche)
    else if (spy.pack && spy.bajoElCursor !== undefined) spy.pack.parche = parche.slice()
  },
})
// Subidas a GPU. Los registros guardan la GEOMETRÍA del pedido —origen y tamaño del rectángulo,
// byteOffset y largo del rango—, que es lo que distingue una escritura acotada de una reconstrucción y no
// depende de la GPU. El PAYLOAD del rango va aparte, en `uploads` y con el mismo índice, para que
// caracterizar el trabajo y caracterizar el encoding no se pisen en el mismo aserto.
//
// Del ARRAY_BUFFER se guarda ADEMÁS el espejo (`datos`, en el buffer mismo): `bufferData` lo estrena y
// `bufferSubData` le parcha un rango, como en GPU. Es la única copia que el doble puede leer, y de ahí sale
// el tile de cada entrada. La copia es a propósito: el origen es un espejo VIVO que se escribe entero y se
// sube por tramos, así que retenerlo mostraría datos que nunca viajaron.
const arrayBuffer = (spy, target) => (target === GL_CONSTS.ARRAY_BUFFER ? spy.array : null)

const uploadGl = spy => ({
  texImage2D    : (_target, _level, _internal, width, height) => spy.texImages.push({ width, height }),
  texSubImage2D : (_target, _level, x, y, width, height, _format, _type, _src, srcOffset) =>
    spy.texSubImages.push({ x, y, width, height, srcOffset }),
  bufferData    : (target, src) => {
    spy.bufferDatas.push({ length: src?.length ?? src })
    const buf = src?.length && arrayBuffer(spy, target)
    buf && (buf.datos = src.slice())
  },
  bufferSubData : (target, offset, src, srcOffset, length) => {
    const rango = src.slice(srcOffset, srcOffset + length)
    spy.bufferSubDatas.push({ offset, srcOffset, length })
    spy.uploads.push(rango)
    arrayBuffer(spy, target)?.datos?.set(rango, offset / rango.BYTES_PER_ELEMENT)
  },
})

// Qué buffer alimenta a un VAO: lo captura el ATRIBUTO al declararse, tomando el ARRAY_BUFFER vigente,
// igual que en GL. De ahí sale, por draw, cuál de los espejos hay que leer cuando hay varios arenas sobre
// el mismo contexto (un polígono con dos anillos son dos VBOs).
const vaoGl = spy => ({
  bindVertexArray     : vao => { spy.vao = vao ?? null },
  vertexAttribPointer : () => { spy.vao && (spy.vao.buffer = spy.array) },
})

// `onLose`: spy de WEBGL_lose_context.loseContext() (para caracterizar el teardown de contexto GL).
// getExtension('WEBGL_lose_context') → { loseContext: onLose }; cualquier otra extensión → {} (como
// antes). El resto de métodos/constantes cae al no-op del Proxy.
export const makeGl = (onLose, spy = makePickSpy(), canvas = makeSurface()) => new Proxy({ ...GL_CONSTS, ...enSuperficie(canvas), ...pickGl(spy), ...uploadGl(spy), ...vaoGl(spy), spy }, {
  get: (t, p) => {
    if (p === 'getExtension') return (name) => (name === 'WEBGL_lose_context' ? { loseContext: onLose ?? (() => {}) } : {})
    return p in t ? t[p] : () => ({})
  },
})

/* ── La costura de `document.createElement` ── */

// El `document` del shim fabrica elementos no-op; el test que necesita más —un WebGL2 de verdad en el
// canvas de una superficie, un espía de listeners— DECORA lo que sale de la fábrica. Devuelve la
// restauración, que es lo que un parche a un global no puede no tener: `after(decorarElementos(…))`.
export const decorarElementos = decorar => {
  const crear = document.createElement
  document.createElement = tag => decorar(crear(tag), String(tag).toLowerCase())
  return () => { document.createElement = crear }
}

// El contexto que abre `EditSurface`. `gl()` se lee por llamada: cada montaje estrena el suyo. Cualquier
// otro contexto cae al no-op del shim, como sin decorar.
export const conGlDeEdicion = gl => decorarElementos((el, tag) => {
  if (tag === 'canvas') el.getContext = kind => (kind === 'webgl2' ? gl() : NOOP_CTX)
  return el
})

// El doble de GL que `EditSurface` acepta: el del repo más `getContextAttributes`, por donde comprueba que
// consiguió el stencil (sin él tira, porque el relleno par-impar no es representable).
const CON_STENCIL = () => ({ stencil: true })

export const makeEditGl = (spy = makePickSpy(), canvas = makeSurface()) =>
  new Proxy(makeGl(null, spy, canvas), { get: (t, p) => (p === 'getContextAttributes' ? CON_STENCIL : t[p]) })

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
    getCenter: () => map._center,
    _center: { lat: 0, lng: 0 },
    getZoomScale: (a, b) => 2 ** (a - (b ?? map._zoom)),
    // Helper del TEST: un frame de zoom ANIMADO como lo hace Leaflet — emite `zoomanim` con la vista
    // DESTINO y recién DESPUÉS mueve la vista viva (durante la transición, getZoom/getCenter ya son las
    // del destino: por eso una capa que se reproyecte contra el mapa vivo aterriza en el final).
    animarZoom(zoom, center = map._center) {
      map.fire('zoomanim', { zoom, center })
      map._zoom   = zoom
      map._center = center
      return map
    },
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

// Doble del handler `map.dragging`. Expone la MISMA superficie que `L.Handler` —`enable`/`disable`/
// `enabled()`—, que es por donde una capa averigua si el arrastre estaba prendido antes de tomarlo
// prestado; `activo` es el campo que leen los asertos.
export const makeDragging = ({ activo = true } = {}) => {
  const h = {
    activo,
    enable()  { h.activo = true;  return h },
    disable() { h.activo = false; return h },
    enabled:  () => h.activo,
  }
  return h
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
    const morir = nodoDom()
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
      remove()  { p.removed = true; morir() },
    }
    log.paths.push(p)
    return p
  }

  // Marcador con handlers propios: `fire` los dispara como haría Leaflet ante el gesto real
  // (drag / dragend / dblclick / click), que es como el test ejerce una edición.
  const marker = (latlng, opts = {}) => {
    const handlers = new Map()
    const morir = nodoDom()
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
      remove()  { m.removed = true; morir() },
    }
    log.markers.push(m)
    return m
  }

  return {
    log,
    marker,
    DomUtil: {
      getPosition:  () => ({ x: 0, y: 0 }),
      // Lo que Leaflet le aplica a un elemento `leaflet-zoom-animated` en cada frame de zoom.
      setTransform: (el, pt, escala) => { el.style.transform = `translate3d(${pt.x}px, ${pt.y}px, 0) scale(${escala})` },
    },
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
      // Vaciar el grupo —o quitarlo del mapa— da de baja los nodos de sus hijos, como el onRemove real.
      const vaciar = () => { g.layers.forEach(l => l.remove?.()); g.layers.length = 0 }
      const g = {
        opts,
        layers: [...iniciales],
        addTo: () => g,
        addLayer(l)   { log.addLayer++;    g.layers.push(l); return g },
        clearLayers() { log.clearLayers++; vaciar();         return g },
        remove: vaciar,
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

// Presupuesto de nodos DOM en DOS ejes, porque contestan preguntas distintas y ninguno implica al otro:
//   · `vivos` (ESTADO) — cuántos nodos mantiene vivos el navegador AHORA por culpa de la capa; es lo que
//     se paga mientras la pantalla está abierta.
//   · `creados` / `destruidos` (FLUJO) — el trabajo de DOM que costó llegar hasta acá. Crear y tirar 800
//     nodos por edición deja `vivos` clavado y cuesta lo mismo que tenerlos: sólo el flujo lo ve.
// `vivos` se mide contra el origen del contador, que NO se mueve; el flujo contra la última `marcar()`,
// para aislar el costo de un gesto sin perder el estado acumulado. Medir desde el origen en vez de en
// absoluto es lo que impide que un test herede los nodos que otro dejó montados.
// Es la contraparte barata del banco: mide la COTA estructural sin navegador, sin reloj y sin medirse a
// sí misma. La NATURALEZA de cada nodo no es asunto suyo (por eso no miente) — para eso está `L.log`.
export const contadorNodos = () => {
  const origen = registro.serie
  let marca = origen, marcaBajas = registro.muertes.length
  // La asimetría es a propósito: `vivos` cuenta las bajas de los nodos NACIDOS desde el origen, y el
  // flujo cuenta las bajas OCURRIDAS desde la marca —hayan nacido cuando hayan nacido—, porque un
  // rebuild tira los de la vuelta anterior y ese trabajo es justamente lo que se quiere ver.
  const bajasDelOrigen = () => registro.muertes.filter(m => m >= origen).length
  return {
    get vivos()      { return registro.serie - origen - bajasDelOrigen() },
    get creados()    { return registro.serie - marca },
    get destruidos() { return registro.muertes.length - marcaBajas },
    marcar() { marca = registro.serie; marcaBajas = registro.muertes.length },
  }
}
