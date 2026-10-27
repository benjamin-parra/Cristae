import Atlas from './Atlas.js'

// IconSet — rasteriza variantes (string opaca) a tiles de píxeles y las administra en un Atlas.
// Declarativo (describe: variante → descriptor) + imperativo (renderers: forma → canvas).
// Sin dominio: `variant` la compone el consumidor; el core no la interpreta.
// El Atlas es el valor; el IconSet rasteriza y direcciona; la residencia GPU es del binding.
//
// PIPELINE (cada etapa tiene su entrada y su salida, y se puede medir sola):
//   1 dibujar     variante → describe → renderer sobre UN canvas de trabajo, reusado por todas las variantes
//   2 leer        canvas de trabajo → tile de píxeles RGBA (`Uint8ClampedArray` de tileSize²·4 bytes)
//   3 direccionar tile → celda del Atlas (`resolve`): índice estable, `count` = celdas pedidas
//   4 subir       celdas pedidas → textura (GpuAtlasBinding): una subida por tile, al adquirir y por variante nueva
// 1–2 corren al PRIMER USO de cada variante (`resolve`) y, para las declaradas en `variants`, ADELANTADAS en
// ranuras ociosas de unos ms: lo declarado no se rasteriza ni se sube entero, sólo lo que se usa; lo que ya
// se adelantó espera en un depósito (`#prepared`) hasta que alguien lo pide y entonces sólo toma celda.
// Declarar un espacio grande (199 buckets de cluster) no cuesta al definir, y re-adquirir sube sólo lo pedido. Los tiles
// suben desde bytes: con muchos en uso, en Chromium cuesta más que desde canvases (los de un canvas acelerado ya están en
// la GPU) y en Firefox menos (desde un canvas hay que leerlo). Ninguna forma gana en los dos (etapa3/ARREGLOS.md, R2).
//
// CONTRATO DEL ESPACIO DE DESCRIPTOR (responsabilidad del consumidor):
//   `describe(variant)` DEBE ser TOTAL sobre el espacio de variantes: para CUALQUIER string que
//   pueda llegar por `variantOf` —incluidas las que aparezcan recién en runtime (regrow)— debe
//   devolver un descriptor completo `{ shape, ...props }` con `shape` ∈ renderers y todas las
//   props que su renderer lea ya resueltas (color, etc.). El core no valida ni rellena defaults.
//   Un campo faltante NO falla: degrada en silencio al default del canvas (p. ej. `fillStyle`
//   inválido → negro), que se ve como "ícono correcto pero mal pintado", no como excepción.
//   Anti-patrón típico: derivar una prop vía `LISTA.indexOf(variant)` sobre una lista cerrada
//   precalculada → `-1` para variantes nuevas → prop undefined. Derivar de la variante misma
//   (hash, parseo) en su lugar, para que sea total por construcción.
//
//   Campo OPCIONAL `scale` (número > 0): multiplicador del tamaño en pantalla del sprite (su
//   footprint), default 1. Deja que una variante rinda un ícono MÁS grande que su `sizeOf` sin
//   re-rasterizar ni tocar el accessor — p. ej. un realce dibujado alrededor que excede el ícono.

const HEADROOM         = 1.5
const MIN_CAPACITY     = 16
const SLICE_MS         = 3      // tope de CPU de una ranura ociosa de adelanto: un par de tiles, nunca un cuadro entero
const MIN_IDLE_MS      = 2      // una ranura con menos ocio que un tile no se usa, salvo que haya vencido
const IDLE_TIMEOUT_MS  = 1000   // si la página nunca queda ociosa, igual avanza (un tile por ranura vencida)
const IDLE_FALLBACK_MS = 50     // sin `requestIdleCallback` (Safari, node) se agenda por tiempo

const capacityFor = count => Math.max(MIN_CAPACITY, Math.ceil((count || 1) * HEADROOM))

// Escala de footprint declarada por el descriptor (`scale`): multiplicador del tamaño en pantalla
// del sprite. Ausente o no-positiva ⇒ 1 (sin cambio). Se normaliza UNA vez, al rasterizar.
const footprintScale = s => (Number.isFinite(s) && s > 0 ? s : 1)

export class IconSet {

  #describe
  #renderers
  #prerender
  #tileSize
  #atlas
  #scales = []   // índice de tile → footprintScale (1 = sin cambio). Los índices del atlas son
                 // estables ante grow, así que este arreglo sigue alineado entre generaciones.
  #variants = []   // índice de tile → variante ya resuelta. Alineado con el atlas (índices estables
                   // ante grow) → permite re-rasterizar en bloque cuando cargan las fuentes (font-gate).
  #fontsPending = false      // hay una re-rasterización encolada a document.fonts.ready
  #waiting                   // `prerender` no terminó: el adelanto espera, que dibujaría sin lo que el raster necesita
  #ctx                       // contexto 2D de trabajo (tileSize², `willReadFrequently`): el mismo para toda variante
  #prepared = new Map()      // variante → { tile, scale }: ya rasterizadas en una ranura ociosa, todavía sin celda
  #sprites  = new Map()      // variante → canvas entregado por `sprite()` (sólo las que alguien pidió)
  #declared                  // variantes declaradas, en orden: lo que el adelanto ocioso recorre
  #next = 0                  // cursor de `#declared`
  #idle = 0                  // ranura ociosa agendada (0 = ninguna)
  #due  = 0                  // cuándo vence la espera de esa ranura: ceder el turno no la reinicia
  // Suscriptores a 'atlasrefreshed' (el motor fuerza re-subida/re-encode). NO necesita teardown propio:
  // el IconSet es long-lived (vive tanto como el binding GPU que muestrea su atlas), así que el Set no
  // sobrevive a sus suscriptores. La baja POR suscriptor ya existe —`onAtlasRefresh` devuelve su
  // des-suscriptor (`delete`)—; el motor la llama al desmontar la capa. No hay un ciclo que el Set retenga.
  #onRefresh = new Set()

  rotates
  defaultSize
  ready

  constructor({ rotates = false, variants = [], sizes = {}, describe, renderers, prerender } = {}) {
    this.rotates     = rotates
    this.defaultSize = sizes.default ?? 32
    this.#tileSize   = sizes.canvas ?? 128
    this.#describe   = describe
    this.#renderers  = renderers ?? {}
    this.#prerender  = prerender
    this.#declared   = [...variants]
    this.#waiting    = !!prerender
    this.#atlas      = new Atlas(capacityFor(variants.length), this.#tileSize)
    this.#armFontGate()                          // ANTES del primer raster: capta el estado de las fuentes al nacer
    this.ready       = this.#init()
  }

  // El atlas vivo. Su identidad cambia en regrow → el binding re-sube y la capa re-encoda.
  get atlas() { return this.#atlas }

  // Escala de footprint del tile ya resuelto (1 por defecto). La point-layer la aplica sobre
  // gl_PointSize: una variante puede rendir un sprite MÁS grande que su `sizeOf`, sin re-rasterizar.
  tileScale(i) { return this.#scales[i] ?? 1 }

  // variante → índice. Nueva: toma el tile que el adelanto ocioso ya dejó listo o lo rasteriza ahora, y le
  // asigna celda (red de seguridad, nunca invisible). La variante está disponible en el mismo cuadro: la celda
  // nueva sube en el próximo `sync` del binding, que es el del dibujo que la pidió.
  // Capacidad agotada → nueva generación (Atlas.grow); el caller detecta el regrow por identidad.
  // El primer pedido arranca el adelanto de lo declarado: un IconSet que nadie usa no rasteriza nada.
  resolve(variant) {
    let i = this.#atlas.indexOf(variant)
    if (i !== -1) return i
    const ready = this.#prepared.get(variant)
    ready && this.#prepared.delete(variant)
    const { tile, scale } = ready ?? this.#rasterize(variant)
    i = this.#atlas.append(variant, tile)
    if (i === -1) {
      this.#atlas = Atlas.grow(this.#atlas)
      i = this.#atlas.append(variant, tile)
    }
    this.#scales[i] = scale
    this.#variants[i] = variant
    this.#arm()
    return i
  }

  // Suscripción a 'atlasrefreshed': se emite cuando las fuentes web terminan de cargar y las variantes
  // ya resueltas se re-rasterizan (font-gate). El consumidor (el motor) la usa para forzar el re-encode
  // de las capas que muestrean este atlas —el binding GPU re-sube solo porque la identidad cambió, pero
  // hay que gatillarle un sync—. Opcional: sin suscriptores el atlas igual queda re-rasterizado en CPU.
  // Devuelve el des-suscriptor. Agnóstico: no sabe qué es una "capa", sólo avisa "el atlas cambió".
  onAtlasRefresh(fn) {
    this.#onRefresh.add(fn)
    return () => this.#onRefresh.delete(fn)
  }

  // Siembra manual idempotente (preloadIcons): adelanta variantes sin esperar a los datos.
  seed(variants) { for (let i = 0; i < variants.length; i++) this.resolve(variants[i]) }

  // Canvas de UNA variante (los MISMOS píxeles que usa el atlas GPU) para reusar el icono FUERA del mapa:
  // una celda de tabla, una leyenda, etc. Idéntico al marcador (mismo describe+render). Genérico, sin
  // dominio. Es el mismo canvas en cada llamada, armado al primer pedido (el atlas guarda píxeles, no canvases).
  // El consumidor lo cachea (p. ej. dataURL por variante) si lo pinta por fila. Si el iconSet
  // rota (`rotates`), el consumidor aplica la rotación por headingOf al reusarlo (el tile va sin rotar).
  // El `scale` (footprint) TAMPOCO va en el tile: es tamaño en pantalla (gl_PointSize), no del bitmap →
  // el reuse fuera del mapa muestra el ícono a tamaño de tile nativo (sin el agrandado del on-map).
  sprite(variant) {
    const i    = this.resolve(variant)           // antes de leer el atlas: un regrow lo reemplaza
    const size = this.#tileSize
    let canvas = this.#sprites.get(variant)
    if (!canvas) {
      canvas = Object.assign(document.createElement('canvas'), { width: size, height: size })
      canvas.getContext('2d').putImageData(new ImageData(this.#atlas.tileAt(i), size, size), 0, 0)
      this.#sprites.set(variant, canvas)
    }
    return canvas
  }

  // `ready` espera lo que el raster necesita (fuentes, imágenes). Lo declarado NO se siembra acá: se
  // rasteriza al usarlo y, adelantado, en ranuras ociosas (ver `#arm`), que no empiezan antes de esto.
  async #init() {
    if (this.#prerender) {
      await this.#prerender()
      this.#waiting = false
      this.#atlas.count && this.#arm()
    }
    return this
  }

  // Etapas 1 y 2 del pipeline: dibuja la variante sobre el canvas de trabajo y devuelve sus píxeles.
  // Un solo canvas para todas (crear uno por tile era lo caro de rasterizar en Firefox); `reset()` deja el
  // contexto como nuevo —sin el estado que el renderer anterior haya dejado, `globalAlpha` o una
  // transformación—, y `willReadFrequently` lo mantiene en CPU: leerlo no es un viaje a la GPU.
  #rasterize(variant) {
    const d = this.#describe(variant)
    const render = this.#renderers[d.shape]
    if (!render) throw new Error(`[IconSet] sin renderer para shape '${d.shape}'`)
    const size = this.#tileSize
    const ctx  = this.#ctx ??= Object.assign(document.createElement('canvas'), { width: size, height: size })
      .getContext('2d', { willReadFrequently: true })
    ctx.reset ? ctx.reset() : (ctx.canvas.width = size)
    render(ctx, size, d)
    return { tile: ctx.getImageData(0, 0, size, size).data, scale: footprintScale(d.scale) }
  }

  // Adelanto ocioso de lo declarado: agenda UNA ranura (no corre mientras `prerender` no termina ni mientras las
  // fuentes cargan: sus tiles saldrían en tofu) y `#advance` la gasta en rasterizar lo que todavía no tiene tile.
  // Nada por cuadro.
  #arm(due = performance.now() + IDLE_TIMEOUT_MS) {
    if (this.#idle || this.#waiting || this.#fontsPending || this.#next >= this.#declared.length) return
    this.#due  = due
    this.#idle = typeof requestIdleCallback === 'function'
      ? requestIdleCallback(this.#advance, { timeout: Math.max(1, due - performance.now()) })
      : setTimeout(this.#advance, IDLE_FALLBACK_MS)
    this.#idle.unref?.()                         // node: el adelanto no mantiene vivo el proceso
  }

  // Una ranura: los tiles que quepan en SLICE_MS y en lo que el navegador deja libre, y al menos uno si la
  // espera venció. Una ranura con menos ocio que un tile cede el turno y conserva el vencimiento: una página
  // siempre ocupada igual avanza, un tile por segundo.
  #advance = deadline => {
    this.#idle = 0
    if (deadline && !deadline.didTimeout && deadline.timeRemaining() < MIN_IDLE_MS) return this.#arm(this.#due)
    const t0 = performance.now()
    do {
      const variant = this.#declared[this.#next++]
      this.#atlas.indexOf(variant) === -1 && !this.#prepared.has(variant) && this.#prepared.set(variant, this.#rasterize(variant))
    } while (this.#next < this.#declared.length && performance.now() - t0 < SLICE_MS && (deadline?.timeRemaining?.() ?? SLICE_MS) > 1)
    this.#arm()
  }

  // Font-gate (naturalización 3.4): #rasterize es SÍNCRONO, así que una variante con glifo de fuente web
  // resuelta ANTES de que la fuente cargue hornea un "tofu" (cuadro vacío) PERMANENTE en su tile. Si al
  // nacer hay un FontFaceSet que todavía no terminó ('loaded'), encolamos una re-rasterización a su
  // document.fonts.ready. Sin FontFaceSet (document.fonts undefined) o ya cargado → no se arma nada y el
  // camino queda idéntico al actual. Complementa a prerenderFonts (que espera ANTES de rasterizar): esto
  // cubre a los consumidores que no lo usan y a las variantes que aparecen en el ínterin.
  #armFontGate() {
    const fonts = typeof document !== 'undefined' && document.fonts
    if (!fonts || fonts.status === 'loaded') return
    this.#fontsPending = true
    fonts.ready.then(() => this.#onFontsReady()).catch(() => {})
  }

  // Cargaron las fuentes: re-rasteriza en bloque las variantes ya resueltas. Se hornea una generación
  // NUEVA del atlas con la MISMA capacidad → los índices no se mueven (`#variants`/`#scales` siguen
  // alineados) y sólo cambian los tiles. La identidad distinta es la señal que el binding GPU ya
  // entiende (re-sube todo en el próximo sync), sin agregar un canal de "tile sucio". Luego se emite
  // 'atlasrefreshed' para que el consumidor gatille ese sync. Idempotente: corre una sola vez.
  // Los sprites entregados se arman de nuevo (eran del tile viejo) y lo declarado arranca el adelanto.
  #onFontsReady() {
    if (!this.#fontsPending) return
    this.#fontsPending = false
    const prev = this.#atlas
    this.#sprites.clear()
    this.#arm()
    if (prev.count === 0) return                 // nada resuelto aún: no hay generación que rehacer
    const next = new Atlas(prev.capacity, this.#tileSize, prev.generation + 1)
    this.#variants.slice(0, prev.count).forEach((variant, i) => {
      const { tile, scale } = this.#rasterize(variant)
      next.append(variant, tile)
      this.#scales[i] = scale
    })
    this.#atlas = next
    this.#onRefresh.forEach(fn => fn())
  }
}

export const defineIconSet = cfg => new IconSet(cfg)

// Helper de `prerender`: espera a que una o más fuentes web estén disponibles antes de rasterizar
// glifos al canvas — si no, el primer raster sale en blanco/tofu. Componer en la config del IconSet:
//   defineIconSet({ ..., prerender: prerenderFonts('unicons-line') })
// El `16px` es indistinto (alcanza para gatillar la carga del face); `document.fonts.ready` confirma.
export const prerenderFonts = (...families) => async () => {
  if (typeof document === 'undefined' || !document.fonts) return
  await Promise.all(families.map(f => document.fonts.load(`16px "${f}"`)))
  await document.fonts.ready
}

// Buckets por defecto de un cluster. Son THRESHOLDS, no un rango de conteos posibles: el más alto
// es un "+" que absorbe todo conteo mayor, así la LUT queda acotada por el threshold tope (no por
// el conteo máximo posible). El atlas es de texturas chicas → tener buckets finos no cuesta memoria.
//   exacto < 100 · decena 100–999 · centena 1000–2000 (tope realista; sobre eso → "2000+").
// El consumidor casi siempre pasa los suyos: su dominio fija la escala (flota, sensores, personas…).
// Los tres tramos [desde, hasta, paso] (con `hasta` EXCLUSIVO) son DATOS, no tres for sueltos:
//   exacto 2–99 (paso 1) · decena 100–990 (paso 10) · centena 1000–2000 (paso 100, tope inclusivo).
const CLUSTER_BUCKET_TRAMOS = [
  [2, 100, 1],
  [100, 1000, 10],
  [1000, 2001, 100],
]
const tramoValues = ([desde, hasta, paso]) => {
  const out = []
  for (let c = desde; c < hasta; c += paso) out.push(c)
  return out
}
const DEFAULT_CLUSTER_BUCKETS = CLUSTER_BUCKET_TRAMOS.flatMap(tramoValues)

// IconSet para clusters, keyed por bucket de conteo (genérico — un cluster es agregación de conteo,
// no dominio). El consumidor define `buckets` (thresholds ascendentes) y `draw(ctx, size, count, plus)`.
//
// Hot-loop: `variantForCount` corre por ítem en cada rebuild y el host puede emitir miles de
// updates/seg → debe ser O(1) y SIN alloc. Por eso, en construcción (una vez) se precomputan:
//   • `variants`  — el string de cada bucket, cacheado (no se crea string por llamada);
//   • `lut`       — Uint16Array que mapea conteo → índice de bucket (piso: mayor threshold ≤ conteo).
// `variantForCount` queda en una sola indexación, sin búsqueda ni concatenación.
export const defineClusterIconSet = ({ buckets = DEFAULT_CLUSTER_BUCKETS, draw, sizes } = {}) => {
  const values = [...new Set(buckets)].filter(v => v >= 0).sort((a, b) => a - b)
  if (!values.length) throw new Error('[defineClusterIconSet] `buckets` no puede quedar vacío')
  const top = values[values.length - 1]
  const variants = values.map(String)            // 1 string por bucket; reusado, nunca realocado
  const has = new Set(values)

  // LUT[conteo] = índice del bucket = mayor threshold ≤ conteo. O(top) una vez, O(1) por consulta.
  const lut = new Uint16Array(top + 1)
  for (let c = 0, bi = 0; c <= top; c++) {
    while (bi + 1 < values.length && values[bi + 1] <= c) bi++
    lut[c] = bi
  }

  const set = new IconSet({
    variants,
    sizes,
    // `plus`: el bucket absorbe conteos por encima de su valor (el siguiente entero no es bucket) →
    // el draw lo marca con "+", honesto sin afirmar un conteo exacto. Derivado de la topología de
    // buckets, no de un umbral horneado. Se evalúa en append (rasterización), nunca en el hot-loop.
    // `dim`/`marked`: prefijos 'd' (cluster expandido en spiderfy) / 'm' (burbuja con ids marcados)
    // → se parsean ANTES de Number() para no romper el contrato describe-TOTAL (Number('d50')=NaN
    // renderaría 'NaN'). El draw los recibe como flags (semitransparente / resaltada).
    describe: variant => {
      const c0 = variant.charCodeAt(0)
      const dim = c0 === 100                      // 'd'
      const marked = c0 === 109                   // 'm'
      const v = Number(dim || marked ? variant.slice(1) : variant)
      return { shape: 'cluster', count: v, plus: !has.has(v + 1), dim, marked }
    },
    renderers: { cluster: (ctx, size, d) => draw(ctx, size, d.count, d.plus, d.dim, d.marked) },
  })
  // Conteo real → variante. O(1), cero alloc: clamp a [0, top] e indexa LUT + string cacheado.
  set.variantForCount = count => variants[count >= top ? lut[top] : lut[count > 0 ? count : 0]]
  // Variante "atenuada" (cluster expandido). Round-trip con el describe de arriba (prefijo 'd'). El
  // sink de burbujas la usa SÓLO si existe (set.expandedVariant) → custom iconSets sin esto no dimean.
  set.expandedVariant = count => 'd' + set.variantForCount(count)
  // Variante "marcada" (burbuja que contiene ids marcados por el consumidor). Mismo round-trip
  // (prefijo 'm'); el sink la usa SÓLO si existe → custom iconSets sin esto no resaltan.
  set.markedVariant = count => 'm' + set.variantForCount(count)
  return set
}
