import Atlas from './Atlas.js'

// IconSet — rasteriza variantes (string opaca) a canvas y las administra en un Atlas.
// Declarativo (describe: variante → descriptor) + imperativo (renderers: forma → canvas).
// Sin dominio: `variant` la compone el consumidor; el core no la interpreta.
// El Atlas es el valor; el IconSet rasteriza y direcciona; la residencia GPU es del binding.
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

const HEADROOM = 1.5
const MIN_CAPACITY = 16

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
    this.#atlas      = new Atlas(capacityFor(variants.length), this.#tileSize)
    this.#armFontGate()                          // ANTES de sembrar: capta el estado de las fuentes al nacer
    this.ready       = this.#init(variants)
  }

  // El atlas vivo. Su identidad cambia en regrow → el binding re-sube y la capa re-encoda.
  get atlas() { return this.#atlas }

  // Escala de footprint del tile ya resuelto (1 por defecto). La point-layer la aplica sobre
  // gl_PointSize: una variante puede rendir un sprite MÁS grande que su `sizeOf`, sin re-rasterizar.
  tileScale(i) { return this.#scales[i] ?? 1 }

  // variante → índice. Nueva: rasteriza + append (red de seguridad, nunca invisible).
  // Capacidad agotada → nueva generación (Atlas.grow); el caller detecta el regrow por identidad.
  resolve(variant) {
    let i = this.#atlas.indexOf(variant)
    if (i !== -1) return i
    const { bitmap, scale } = this.#rasterize(variant)
    i = this.#atlas.append(variant, bitmap)
    if (i === -1) {
      this.#atlas = Atlas.grow(this.#atlas)
      i = this.#atlas.append(variant, bitmap)
    }
    this.#scales[i] = scale
    this.#variants[i] = variant
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

  // Canvas rasterizado de UNA variante (el MISMO tile que usa el atlas GPU) para reusar el icono FUERA del
  // mapa: una celda de tabla, una leyenda, etc. Idéntico al marcador (mismo describe+render). Genérico, sin
  // dominio. El consumidor lo cachea (p. ej. dataURL por variante) si lo pinta por fila. Si el iconSet
  // rota (`rotates`), el consumidor aplica la rotación por headingOf al reusarlo (el tile va sin rotar).
  // El `scale` (footprint) TAMPOCO va en el tile: es tamaño en pantalla (gl_PointSize), no del bitmap →
  // el reuse fuera del mapa muestra el ícono a tamaño de tile nativo (sin el agrandado del on-map).
  sprite(variant) { return this.#atlas.tileAt(this.resolve(variant)) }

  async #init(variants) {
    if (this.#prerender) await this.#prerender()
    this.seed(variants)                          // preseed: 0 append en runtime para lo declarado
    return this
  }

  #rasterize(variant) {
    const d = this.#describe(variant)
    const render = this.#renderers[d.shape]
    if (!render) throw new Error(`[IconSet] sin renderer para shape '${d.shape}'`)
    const canvas = document.createElement('canvas')
    canvas.width = this.#tileSize
    canvas.height = this.#tileSize
    render(canvas.getContext('2d'), this.#tileSize, d)
    return { bitmap: canvas, scale: footprintScale(d.scale) }
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
  // alineados) y sólo cambian los bitmaps. La identidad distinta es la señal que el binding GPU ya
  // entiende (re-sube todo en el próximo sync), sin agregar un canal de "tile sucio". Luego se emite
  // 'atlasrefreshed' para que el consumidor gatille ese sync. Idempotente: corre una sola vez.
  #onFontsReady() {
    if (!this.#fontsPending) return
    this.#fontsPending = false
    const prev = this.#atlas
    if (prev.count === 0) return                 // nada resuelto aún (p. ej. prerender siembra después)
    const next = new Atlas(prev.capacity, this.#tileSize, prev.generation + 1)
    this.#variants.slice(0, prev.count).forEach((variant, i) => {
      const { bitmap, scale } = this.#rasterize(variant)
      next.append(variant, bitmap)
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
