import { EditFillLayer } from './EditFillLayer.js'
import { EditSurface, blendOver } from './EditSurface.js'
import { RingStore, maxTextureOf } from './RingStore.js'
import { glBudget } from './gl-budget.js'
import { createFrameView } from './frame-view.js'
import { MAXLAT, projX0, projY0, readView } from './project.js'
import { parseColor } from './color.js'
import { MAX_SLOPE_BREAKS, MODE_ELEVATION, MODE_NONE, MODE_SLOPE, NO_DATA, terrainPrograms } from './terrain-shaders.js'
import { boundsOf } from '../geometry/bounds.js'
import { GRID } from '../geometry/geodesic.js'
import { WORLD0, unprojX0, unprojY0 } from '../projection/mercator.js'

// Capa GPU del terreno en planta: dibuja sobre la textura de altura del `dem` el sombreado, el color por altura
// o por pendiente y las curvas de nivel, y mide lo mismo que dibuja. Es un miembro de tramo como las capas de
// polígonos: su superficie sale de `surface({ host, pane, owner: this })`, y cuando la superficie es la ranura
// de un tramo, `begin()` y `end(view)` enlazan y componen su cuadro.
//
// RECIBE la configuración ya normalizada (`TerrainLayerConfig` con `dem` como `TerrainSource`, `slopeBreaks` en
// razón m/m, colores CSS o `[r, g, b, a]`, `hillshade` resuelto), el modelo base del mapa para `terrain()` y
// una `HeightTileCache` por motor. Sin caché propia arma una privada. No resuelve los nombres de preset ni valida
// opciones: eso es de quien normaliza. `configure(config)` aplica una configuración nueva entera.
//
// EL MOSAICO. Las alturas son una grilla de `terrain()` (su marca `GRID`) al zoom del `dem` que cubre el viewport
// con `MOSAIC_MARGIN` por lado, de modo que un paneo corto no recarga. Se recarga sólo cuando la vista sale del
// mosaico o cuando el zoom que le toca cambia, y la imagen anterior sigue hasta que llega la nueva. Cuando el
// viewport solo ya no entra en `MOSAIC_MAX_SIDE` celdas se usa el mayor zoom menor que entre: la vista general,
// sin clases ni curvas, porque al zoom del `dem` no coincidirían con las de `measure()`. La grilla trae un margen
// de 2 celdas por lado y se dibuja desde la celda 1, la primera con sus 8 vecinas.
//
// LO GL. Lo único que sube la capa son las dos texturas del mosaico, `R32F` de alturas y `RG32F` de una columna
// con los pasos de Horn por fila (`ew`, `ns`), más el store del recorte. Las dos salen de copias de CPU que se
// conservan, así que `dropGl` las olvida y `buildGl` las rehace en un contexto nuevo sin volver a la red. Sin
// contexto `#gl` es null, y es lo único que miran los caminos que dibujan. Los programas son del contexto
// (`terrainPrograms`).
//
// EL RECORTE. `setClip(tables)` limita el color y las curvas al polígono con la máscara par-impar de
// `EditFillLayer.mask`: los anillos de las tablas componen entre sí en una sola paridad, así que dos partes que se
// pisan se cancelan en el solape, como en `PolygonGpuLayer`. Con `'pending'` —un `clip-to` declarado cuyo polígono
// aún no existe— no se dibuja color ni curvas y sí el sombreado, que el recorte no toca.
//
// LOS UNIFORMES. Los escalares viajan como arreglos de un tipado (`uniform2fv`, no `uniform2f`): pasar un double
// fraccionario a una función que V8 no inlinea lo encaja en el montón, y el dibujo no asigna. El único double que
// cruza una llamada por dibujo es el ancla de `FrameView.bind`.
//
// El sombreado sale con la mezcla `over` de la superficie, como el resto de los pases: el canvas de la capa nace
// transparente, y una mezcla multiplicativa contra él daría cero.
//
// LOS EVENTOS. `onLoad({ url, count })` avisa con las teselas servidas del mosaico, y `onError({ url, code,
// message, status })` con lo que falló. Un 401 o un 403 es un error, nunca «sin dato»; un 404 o un 204 sí es sin
// dato, y un mosaico donde ninguna tesela lo tiene se carga vacío con `count` 0. Los códigos son `unauthorized`
// (401), `forbidden` (403), `http` (otro 4xx o 5xx), `network` (el pedido no tuvo respuesta), `range` (la caja
// pide más de lo que el terreno admite) y `decode` (una tesela ilegible o de otro tamaño). Un mosaico que falló
// se reintenta en la próxima vista asentada. La capa no se pica: sin `resolveClick` ni `resolveHover`.

// Cuánto margen lleva el mosaico por lado, en viewports: un paneo de medio viewport no recarga.
export const MOSAIC_MARGIN = 0.5

// El lado más grande de la grilla en celdas, con su margen: el `MAX_TEXTURE_SIZE` mínimo que WebGL2 garantiza.
export const MOSAIC_MAX_SIDE = 2048

// Lo que la grilla de `terrain()` agrega a la caja pedida: 2 celdas por lado de margen y 1 por el redondeo de
// cada borde. El viewport entra si su lado en celdas más esto cabe en `MOSAIC_MAX_SIDE`.
const GRID_SLACK = 6

// La primera celda que se dibuja, contada desde el borde de la grilla: la que tiene sus 8 vecinas.
const GRID_INSET = 1

// El bit del stencil en que `EditFillLayer.mask` deja la paridad: la cobertura lo lee con NOTEQUAL.
const STENCIL_BIT = 1

// El stencil entero, para devolver la máscara de escritura al neutro.
const STENCIL_ALL = 0xff

// Las paradas de la rampa de pendiente por defecto, de verde a rojo pasando por amarillo: una elección de
// diseño, sin medida detrás. Con cortes se muestrea en n + 1 colores, y sin ellos se usan las tres.
const SLOPE_STOPS = [[0.18, 0.64, 0.22, 1], [0.98, 0.85, 0.2, 1], [0.84, 0.15, 0.13, 1]]

const COLOR_CHANNELS = 4
const MAX_SLOPE_COLORS = MAX_SLOPE_BREAKS + 1

// La rampa de altura mientras no hay mosaico del que sacar el rango.
const DEFAULT_RANGE = [0, 1]

const MODE_OF = { none: MODE_NONE, elevation: MODE_ELEVATION, slope: MODE_SLOPE }

const project = (lat, lng, out) => {
  out[0] = projX0(lng)
  out[1] = projY0(lat)
}

// El terreno y la caché son lo único que pesa y lo único asíncrono: se piden juntos, una vez, y la capa que no
// llega a medir ni a cargar nunca los trae. Un fallo no queda guardado: el siguiente intento vuelve a importar.
let coreLoad = null
const loadCore = () => (coreLoad ??= Promise.all([import('../geometry/terrain.js'), import('../geometry/height-tiles.js')]).then(
  ([terrain, tiles]) => ({
    terrain               : terrain.terrain,
    relief                : terrain.relief,
    elevation             : terrain.elevation,
    TILE_CACHE            : tiles.TILE_CACHE,
    createHeightTileCache : tiles.createHeightTileCache,
  }),
  error => {
    coreLoad = null
    throw error
  }))

const sameDem = (a, b) => a.url === b.url && a.encoding === b.encoding && a.zoom === b.zoom
  && a.maxZoom === b.maxZoom && a.tileSize === b.tileSize

const abortError = () => new DOMException('La capa de terreno se destruyó', 'AbortError')

// Un callback del consumidor corre fuera de la cadena que carga: si lanza, el error sale por el manejador global
// y el estado de la capa ya está al día.
const emit = (callback, detail) => {
  if (typeof callback !== 'function') return
  try {
    callback(detail)
  } catch (error) {
    queueMicrotask(() => { throw error })
  }
}

// La url de la tesela que falló, que el error lleva en su mensaje; sin ella, la plantilla del `dem`.
const failedUrl = (error, dem) => /^\[terrain\] (\S*\/\S*) /.exec(error?.message)?.[1] ?? dem.url

const codeOf = error =>
  error?.status === 401 ? 'unauthorized'
  : error?.status === 403 ? 'forbidden'
  : error?.status !== undefined ? 'http'
  : / no respondió$/.test(error?.message) ? 'network'
  : error instanceof RangeError ? 'range'
  : 'decode'

// Un mosaico donde ninguna tesela trae datos es sin dato, no un fallo.
const isNoData = error => error instanceof Error && error.status === undefined && /^\[terrain\] ningún tile/.test(error.message)

// La caja de una zona en cualquiera de sus formas: un anillo, un polígono con agujeros o un multipolígono, que
// `boundsOf` no lee anidado a ese nivel.
const zoneBounds = zone => boundsOf(Array.isArray(zone?.[0]?.[0]?.[0]) ? zone.flat() : zone)

const colorOf = color => (Array.isArray(color) ? color : parseColor(color))

// La rampa de pendiente: los `[r, g, b, a]` que la configuración trae, o la por defecto si falta alguno. Con
// cortes lleva uno por clase (n + 1), repitiendo el último si faltan.
const slopeColors = (config, breaks) => {
  const classes = breaks + 1
  const given   = config.slopeColors?.map(colorOf)
  const list    = given?.length && !given.includes(null) ? given
    : breaks ? Array.from({ length: classes }, (_, k) => {
      const s = k / breaks * (SLOPE_STOPS.length - 1)
      const i = Math.min(Math.floor(s), SLOPE_STOPS.length - 2)
      return SLOPE_STOPS[i].map((c, j) => c + (SLOPE_STOPS[i + 1][j] - c) * (s - i))
    })
    : SLOPE_STOPS
  return breaks ? Array.from({ length: classes }, (_, k) => list[Math.min(k, list.length - 1)]) : list.slice(0, MAX_SLOPE_COLORS)
}

// La configuración leída a lo que dibuja: números y arreglos de uniformes, armados una vez por cambio de estilo
// para que el dibujo no cree nada. Lanza antes de que la capa cambie nada.
const readStyle = config => {
  if (typeof config?.dem?.url !== 'string') throw new TypeError('[terrain] la capa necesita un dem')
  const breakList = Array.from(config.slopeBreaks ?? [])
  if (breakList.length > MAX_SLOPE_BREAKS)
    throw new RangeError(`[terrain] slopeBreaks admite hasta ${MAX_SLOPE_BREAKS} cortes: ${breakList.length}`)
  const mode   = MODE_OF[config.colorBy ?? 'none']
  const colors = slopeColors(config, breakList.length)
  const breaks = new Float32Array(MAX_SLOPE_BREAKS)
  const rgba   = new Float32Array(MAX_SLOPE_COLORS * COLOR_CHANNELS)
  breaks.set(breakList)
  colors.forEach((color, k) => rgba.set(color, k * COLOR_CHANNELS))
  const interval = config.contours > 0 ? config.contours : 0
  return {
    dem        : config.dem,
    fetch      : config.fetch,
    opacity    : Float32Array.of(config.opacity ?? 1),
    mode,
    hillshade  : config.hillshade ?? mode === MODE_NONE,
    paintsColor: mode !== MODE_NONE || interval > 0,
    interval   : Float32Array.of(interval),
    fixedRange : config.elevationRange ?? null,
    breakList,
    breaks,
    colors     : rgba,
    colorCount : colors.length,
    onLoad     : config.onLoad,
    onError    : config.onError,
  }
}

// Una textura de float32 muestreada por texel exacto.
const texture = (gl, internalFormat, format, width, height, data) => {
  const tex = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, width, height, 0, format, gl.FLOAT, data)
  return tex
}

export class TerrainLayer {

  #camera; #surface; #model
  #cache   = null                     // la caché de teselas: la del motor, o una propia si no se la dio
  #style   = null
  #gl      = null
  #programs = null
  // El último lado máximo de textura medido, para el store del recorte; sin contexto todavía, el del realm o el que garantiza WebGL2.
  #max     = glBudget.maxTexture ?? maxTextureOf(null)
  #core    = null                     // el terreno ya importado; null hasta la primera carga
  #frame   = createFrameView()
  #mosaic  = null                     // el vigente: la grilla, sus copias de CPU y sus texturas
  #target  = null                     // el plano del último mosaico pedido, en vuelo o ya cargado
  #seq     = 0                        // qué carga vale: una más nueva o un destroy invalida las anteriores
  #controller = null
  #measures   = new Set()             // los AbortController de las medidas en vuelo
  #fill    = null                     // la máscara par-impar del recorte, que nace con el primero
  #clip    = null                     // null, 'pending' o { store, rings }
  #range   = new Float32Array(2)      // metros de la rampa de altura
  #offSettle = null
  #offFrame  = null
  #visible   = true
  #stale     = true                   // algo pidió un dibujo mientras estaba oculta o sin contexto
  #destroyed = false

  constructor({ host, pane, config, model, cache = null, surface = opts => new EditSurface(opts) }) {
    this.#camera  = host.camera
    this.#model   = model
    this.#cache   = cache
    this.#setStyle(readStyle(config))
    this.#surface = surface({ host, pane, owner: this })
    // Lo que sigue puede tirar, y un contexto que nadie devuelve no vuelve en toda la vida de la página.
    try {
      this.#surface.open(false)       // vacía hasta el primer mosaico: la política decide cuándo toma el contexto
      this.#offSettle = this.#camera.on('moveend zoomend resize', this.#onSettle)
      this.#offFrame  = this.#camera.on('zoomframe', this.#onFrame)
      this.#onSettle()
    } catch (e) {
      this.destroy()
      throw e
    }
  }

  get surface()    { return this.#surface }
  get canvas()     { return this.#surface.canvas }
  get hasContent() { return !!this.#mosaic }                      // la política puede leerlo mientras la capa se construye

  #setStyle(style) {
    this.#style = style
    this.#range.set(style.fixedRange ?? DEFAULT_RANGE)
  }

  // Aplica una configuración normalizada entera. Un `dem` distinto pide su mosaico, y el anterior sigue en
  // pantalla hasta que llega; lo demás sólo se repinta. El `fetch` es el del alta, que no se cambia en vivo.
  // Lanza antes de cambiar nada.
  configure(config) {
    const style = readStyle({ ...config, fetch: this.#style.fetch })
    const moved = !sameDem(this.#style.dem, style.dem)
    this.#setStyle(style)
    if (moved) this.#target = null
    this.#onSettle()
    return this.redraw()
  }

  setOpacity(opacity) {
    this.#style.opacity[0] = opacity
    return this.redraw()
  }

  // Contrato de toda capa del motor: la llama al rehabilitarla, para que se ponga al día.
  refresh() { return this.redraw() }

  // Mostrarla sólo dibuja si algo pidió un dibujo mientras estaba oculta; mientras estuvo oculta no cargó, así
  // que al mostrarla pide el mosaico que le falte. Devuelve si pintó.
  setVisible(visible = true) {
    const shown   = visible && !this.#visible
    this.#visible = visible
    this.#surface.setVisible(visible)
    shown && this.#ensure(readView(this.#camera, this.#frame))
    return shown && this.#stale && this.redraw()
  }

  resetCanvasReference() { return this.redraw() }

  /* ── Recorte ── */

  // `tables` son las del lector (`xy` en [lng, lat, …], `vertexAt`, `ringAt`, `closed`, `ringCount`, y `rings` si
  // acota). Todo se arma antes de reemplazar lo anterior: si el store no entra en la textura lanza y la capa
  // queda como estaba.
  setClip(clip) {
    if (clip === null || clip === undefined || clip === 'pending') {
      this.#dropClip()
      this.#clip = clip ?? null
      return this.redraw()
    }
    const store = new RingStore({ gl: this.#gl, max: this.#max, project, rings: { ...clip, ringIds: clip.rings } })
    const rings = Array.from({ length: store.ringCount }, (_, r) => ({ arena: store.viewOf(r) }))
    this.#fill ??= new EditFillLayer({ gl: this.#gl, rings: [], step: 1 })
    this.#dropClip()
    this.#clip       = { store, rings }
    this.#fill.rings = rings
    return this.redraw()
  }

  #dropClip() {
    this.#clip?.store?.destroy()
    this.#clip = null
    this.#fill && (this.#fill.rings = [])
  }

  /* ── Lo que la capa sabe del terreno ── */

  // La altura bajo un punto del mosaico vigente, en metros, síncrona: NaN si todavía no hay mosaico o el punto
  // cae fuera de él.
  elevationAt(latlng) {
    const mosaic = this.#mosaic
    return mosaic && this.#core ? this.#core.elevation(mosaic.terrain, latlng) : NaN
  }

  // `relief()` de la zona con los cortes vigentes y las alturas del `dem` al zoom del `dem`, las mismas teselas
  // que las clases que se dibujan: lo medido coincide con lo dibujado. Las teselas ya cargadas salen de la caché.
  // Destruir la capa aborta la medida con `AbortError`.
  async measure(polygon, { signal } = {}) {
    if (this.#destroyed) throw abortError()
    const controller = new AbortController()
    const forward    = () => controller.abort(signal.reason)
    this.#measures.add(controller)
    signal?.aborted ? forward() : signal?.addEventListener('abort', forward, { once: true })
    try {
      const core = await loadCore()
      controller.signal.throwIfAborted()
      const box = zoneBounds(polygon)
      if (!box) throw new TypeError('[measure] la zona no tiene vértices válidos')

      const style   = this.#style
      const terrain = await this.#terrain(core, style.dem, box, controller.signal)
      return core.relief(terrain, polygon, style.breakList)
    } finally {
      signal?.removeEventListener('abort', forward)
      this.#measures.delete(controller)
    }
  }

  // `terrain()` con el modelo del mapa, si lo hay: un modelo ausente correría la fuente un lugar.
  #terrain(core, source, box, signal, cache = this.#cache ??= core.createHeightTileCache()) {
    const size    = source.tileSize ?? 256
    const options = {
      fetch    : this.#style.fetch,
      signal,
      maxTiles : (Math.ceil(MOSAIC_MAX_SIDE / size) + 1) ** 2,
      [core.TILE_CACHE]: cache,
    }
    return this.#model ? core.terrain(this.#model, source, box, options) : core.terrain(source, box, options)
  }

  /* ── El mosaico ── */

  #onSettle = () => {
    if (this.#destroyed) return
    const view = readView(this.#camera, this.#frame)
    this.#visible && this.#ensure(view)
    this.#autoRange(view)
    this.redraw()
  }

  #onFrame = () => { this.redraw() }

  // El plano del mosaico que le toca a esta vista: su zoom, la caja pedida con margen y el viewport, en world0. El
  // viewport solo manda el zoom, y el margen se recorta antes de bajarlo.
  #plan({ zoom, center, size }) {
    const dem    = this.#style.dem
    const scale  = 2 ** zoom
    const tile   = dem.tileSize ?? 256
    const cells  = z => tile * 2 ** z / WORLD0
    const room   = z => (MOSAIC_MAX_SIDE - GRID_SLACK) / cells(z)
    const vw     = Math.min(size.x / scale, WORLD0)
    const vh     = Math.min(size.y / scale, WORLD0)
    let z = dem.zoom
    while (z > 0 && Math.max(vw, vh) > room(z)) z--
    const grow = v => Math.max(0, Math.min(MOSAIC_MARGIN * v, (room(z) - v) / 2, (WORLD0 - v) / 2))
    const mx   = grow(vw)
    const my   = grow(vh)
    const clampY = y => Math.min(Math.max(y, 0), WORLD0)
    const x0   = center.x - vw / 2 - mx
    const x1   = center.x + vw / 2 + mx
    const y0   = clampY(center.y - vh / 2 - my)
    const y1   = clampY(center.y + vh / 2 + my)
    return {
      zoom : z,
      x0, y0, x1, y1,
      vx0  : center.x - vw / 2,
      vx1  : center.x + vw / 2,
      vy0  : clampY(center.y - vh / 2),
      vy1  : clampY(center.y + vh / 2),
      box  : {
        south : Math.max(unprojY0(y1), -MAXLAT),
        west  : unprojX0(x0),
        north : Math.min(unprojY0(y0), MAXLAT),
        east  : unprojX0(x1),
      },
    }
  }

  // Pide un mosaico sólo si el viewport salió del último pedido o si el zoom que le toca cambió.
  #ensure(view) {
    if (this.#destroyed || !(view.size.x > 0 && view.size.y > 0)) return
    const plan = this.#plan(view)
    const t    = this.#target
    if (t && t.zoom === plan.zoom && t.x0 <= plan.vx0 && t.x1 >= plan.vx1 && t.y0 <= plan.vy0 && t.y1 >= plan.vy1) return

    const seq        = ++this.#seq
    const controller = new AbortController()
    this.#controller?.abort()
    this.#controller = controller
    this.#target     = plan
    this.#load(plan, seq, controller)
  }

  // La carga entera, que no rechaza: un fallo sale por `onError`. Una carga superada o abortada calla.
  async #load(plan, seq, controller) {
    const style = this.#style
    let served = 0
    let terrain
    try {
      const core = this.#core = await loadCore()
      if (seq !== this.#seq) return

      const cache    = this.#cache ??= core.createHeightTileCache()
      // Las teselas servidas son las que la caché entrega con datos: el `null` de un 404 no cuenta.
      const counting = {
        get: async (...args) => {
          const values = await cache.get(...args)
          if (values) served++
          return values
        },
      }
      terrain = await this.#terrain(core, { ...style.dem, zoom: plan.zoom }, plan.box, controller.signal, counting)
    } catch (error) {
      if (seq !== this.#seq || controller.signal.aborted) return
      if (isNoData(error)) return this.#settleMosaic(null, style, 0)

      this.#target = null
      emit(style.onError, {
        url     : failedUrl(error, style.dem),
        code    : codeOf(error),
        message : error?.message ?? String(error),
        ...(error?.status !== undefined && { status: error.status }),
      })
      return
    }
    if (seq !== this.#seq) return

    this.#settleMosaic(this.#readMosaic(terrain, style.dem), style, served)
  }

  // La grilla del terreno a lo que se sube: las alturas con `NO_DATA` donde `terrain` deja NaN, en una copia
  // porque el terreno no se escribe (la caché compartida entrega el mismo arreglo a otras capas), y los pasos de
  // Horn por fila en float32. Costo: una copia transitoria del mosaico (a lo más `MOSAIC_MAX_SIDE`² floats) por
  // mosaico cargado, que el sustituto de NaN aprovecha para recorrer las alturas una sola vez.
  #readMosaic(terrain, dem) {
    const { heights, W, H, px0, py0, N, zoom, ew, ns } = terrain[GRID]
    const gpu  = new Float32Array(heights.length)
    const rows = new Float32Array(2 * H)
    for (let i = 0; i < heights.length; i++) gpu[i] = heights[i] === heights[i] ? heights[i] : NO_DATA
    for (let j = 0; j < H; j++) {
      rows[2 * j]     = ew[j]
      rows[2 * j + 1] = ns[j]
    }
    const cellsPerWorld = N / WORLD0
    return {
      terrain, W, H, px0, py0, gpu, rows, zoom, cellsPerWorld,
      overview  : zoom < dem.zoom,
      anchorX   : (px0 + GRID_INSET) / cellsPerWorld,
      anchorY   : (py0 + GRID_INSET) / cellsPerWorld,
      size      : Float32Array.of((W - 2 * GRID_INSET) / cellsPerWorld, (H - 2 * GRID_INSET) / cellsPerWorld),
      cells     : Float32Array.of(cellsPerWorld),
      texHeights: null,
      texRows   : null,
    }
  }

  // Cambia el mosaico vigente: sube el nuevo, suelta el viejo y pide el dibujo. Con `null` la capa queda vacía.
  #settleMosaic(mosaic, style, count) {
    const old = this.#mosaic
    this.#mosaic = mosaic
    mosaic && this.#gl && this.#upload(mosaic)
    this.#release(old)
    mosaic && this.#autoRange(readView(this.#camera, this.#frame))
    // El mosaico se avisa: sin contexto lo pide, y `buildGl` sube y pinta.
    ;(mosaic && this.#surface.need()) || this.redraw()
    emit(style.onLoad, { url: style.dem.url, count })
  }

  #upload(mosaic) {
    const gl = this.#gl
    mosaic.texHeights = texture(gl, gl.R32F, gl.RED, mosaic.W, mosaic.H, mosaic.gpu)
    mosaic.texRows    = texture(gl, gl.RG32F, gl.RG, 1, mosaic.H, mosaic.rows)
  }

  #release(mosaic) {
    const gl = this.#gl
    if (mosaic && gl && !gl.isContextLost()) {
      gl.deleteTexture(mosaic.texHeights)
      gl.deleteTexture(mosaic.texRows)
    }
    if (mosaic) mosaic.texHeights = mosaic.texRows = null
  }

  // El rango de la rampa de altura: el mínimo y el máximo de las celdas del viewport al asentar la vista, y no
  // por cuadro. Con `elevation-range` declarado queda fijo.
  #autoRange({ zoom, center, size }) {
    const m = this.#mosaic
    if (!m || this.#style.fixedRange) return

    const scale = 2 ** zoom
    const clamp = (v, hi) => Math.min(Math.max(v, GRID_INSET), hi)
    const c0    = clamp(Math.floor((center.x - size.x / (2 * scale)) * m.cellsPerWorld) - m.px0, m.W - 1 - GRID_INSET)
    const c1    = clamp(Math.ceil((center.x + size.x / (2 * scale)) * m.cellsPerWorld) - m.px0, m.W - 1 - GRID_INSET)
    const r0    = clamp(Math.floor((center.y - size.y / (2 * scale)) * m.cellsPerWorld) - m.py0, m.H - 1 - GRID_INSET)
    const r1    = clamp(Math.ceil((center.y + size.y / (2 * scale)) * m.cellsPerWorld) - m.py0, m.H - 1 - GRID_INSET)
    let lo = Infinity
    let hi = -Infinity
    for (let r = r0; r <= r1; r++)
      for (let c = c0; c <= c1; c++) {
        const h = m.gpu[r * m.W + c]
        if (h < NO_DATA / 2) continue

        if (h < lo) lo = h
        if (h > hi) hi = h
      }
    if (lo <= hi) {
      this.#range[0] = lo
      this.#range[1] = hi
    }
  }

  /* ── Dibujo ── */

  // Oculta o sin contexto no dibuja. Al volver a tenerlo, `buildGl` pinta en el acto. `end(view)` llega aunque no
  // haya pintado nada: lo limpio también se muestra. [0-alloc]
  redraw() {
    const gl = this.#gl
    if (!gl || !this.#visible) {
      this.#stale = true
      return false
    }
    this.#stale = false
    this.#surface.resetCanvasReference()
    this.#surface.begin()
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT)
    const view  = readView(this.#camera, this.#frame)
    const mosaic = this.#mosaic
    const style  = this.#style
    let pintado = false
    if (mosaic?.texHeights) {
      if (style.paintsColor && this.#clip !== 'pending') pintado = this.#colorPass(gl, view, mosaic)
      if (style.hillshade) {          // al final: oscurece el color en vez de quedar tapado por él
        this.#hillshadePass(gl, mosaic)
        pintado = true
      }
    }
    this.#surface.end(view)
    return pintado
  }

  // Lo que comparten los dos programas: la matriz del cuadro, la caja del mosaico y sus dos texturas.
  #bindMosaic(gl, locs, mosaic) {
    this.#frame.bind(gl, locs, mosaic)
    gl.uniform2fv(locs.uSize, mosaic.size)
    gl.uniform1fv(locs.uCellsPerWorld, mosaic.cells)
    gl.uniform1fv(locs.uOpacity, this.#style.opacity)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, mosaic.texHeights)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, mosaic.texRows)
    gl.activeTexture(gl.TEXTURE0)
  }

  #hillshadePass(gl, mosaic) {
    const locs = this.#programs.hillshade
    gl.useProgram(locs.program)
    blendOver(gl)
    this.#bindMosaic(gl, locs, mosaic)
    gl.drawArrays(gl.TRIANGLES, 0, 6)
  }

  // El color y las curvas. Con recorte, la paridad del polígono se marca primero y el color sólo cae donde quedó
  // en uno; si el polígono no toca el viewport no hay nada que cubrir. Devuelve si dibujó.
  #colorPass(gl, view, mosaic) {
    const clip = this.#clip
    if (!clip) {
      this.#drawColor(gl, mosaic)
      return true
    }
    if (!this.#fill.mask(view)) return false

    try {
      gl.colorMask(true, true, true, true)
      gl.stencilFunc(gl.NOTEQUAL, 0, STENCIL_BIT)
      gl.stencilOp(gl.KEEP, gl.KEEP, gl.ZERO)       // la cobertura deja el stencil limpio sin un `clear`
      this.#drawColor(gl, mosaic)
    } finally {                                     // `mask` dejó estado global encendido: se restaura aunque el dibujo lance
      gl.colorMask(true, true, true, true)
      gl.disable(gl.STENCIL_TEST)
      gl.disable(gl.SCISSOR_TEST)
      gl.stencilMask(STENCIL_ALL)
      gl.bindVertexArray(null)
    }
    return true
  }

  #drawColor(gl, mosaic) {
    const locs  = this.#programs.color
    const style = this.#style
    const range = this.#range
    gl.useProgram(locs.program)
    blendOver(gl)
    this.#bindMosaic(gl, locs, mosaic)
    gl.uniform1i(locs.uMode, style.mode)
    gl.uniform1i(locs.uOverview, mosaic.overview ? 1 : 0)
    gl.uniform1fv(locs.uBreaks, style.breaks)
    gl.uniform1i(locs.uBreakCount, style.breakList.length)
    gl.uniform4fv(locs.uColors, style.colors)
    gl.uniform1i(locs.uColorCount, style.colorCount)
    gl.uniform2fv(locs.uRange, range)
    gl.uniform1fv(locs.uInterval, style.interval)
    gl.drawArrays(gl.TRIANGLES, 0, 6)
  }

  /* ── Contexto: la superficie lo toma y lo suelta, y la capa rehace su parte GL desde las copias de CPU ── */

  // Al construirse y cada vez que la superficie vuelve a tomar un contexto: arma los programas, rehace las
  // texturas del mosaico y del recorte desde sus copias y pinta en el acto, porque el contexto nace en blanco.
  buildGl(gl) {
    this.#gl       = gl
    this.#max      = maxTextureOf(gl)
    this.#programs = terrainPrograms(gl)
    // La primera celda dibujada es la misma para todo mosaico, así que el offset se fija con el programa y no por dibujo.
    for (const { program, uOffset } of [this.#programs.hillshade, this.#programs.color]) {
      gl.useProgram(program)
      gl.uniform2i(uOffset, GRID_INSET, GRID_INSET)
    }
    this.#fill?.buildGl(gl)
    this.#clip?.store?.buildGl(gl)
    this.#mosaic && this.#upload(this.#mosaic)
    return this.redraw()
  }

  // Olvida lo GL sin tocar el contexto, que se perdió o que la superficie va a soltar con `loseContext`. El
  // mosaico, el recorte y el estilo son de CPU y siguen.
  dropGl() {
    this.#fill?.dropGl()
    this.#clip?.store?.dropGl()
    if (this.#mosaic) this.#mosaic.texHeights = this.#mosaic.texRows = null
    this.#programs = null
    this.#gl       = null
  }

  // Seguro a medio construir. Aborta la carga y las medidas en vuelo, y no sube nada más.
  destroy() {
    if (this.#destroyed) return

    this.#destroyed = true
    this.#seq++
    this.#controller?.abort()
    this.#measures.forEach(controller => controller.abort(abortError()))
    this.#measures.clear()
    this.#offSettle?.()
    this.#offFrame?.()
    this.#release(this.#mosaic)
    this.#mosaic = null
    this.#dropClip()
    this.#fill?.destroy()
    this.dropGl()
    this.#surface?.destroy()
  }
}
