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

const capacityFor = (count) => Math.max(MIN_CAPACITY, Math.ceil((count || 1) * HEADROOM))

// Escala de footprint declarada por el descriptor (`scale`): multiplicador del tamaño en pantalla
// del sprite. Ausente o no-positiva ⇒ 1 (sin cambio). Se normaliza UNA vez, al rasterizar.
const footprintScale = (s) => (Number.isFinite(s) && s > 0 ? s : 1)

export class IconSet {

  #describe
  #renderers
  #prerender
  #tileSize
  #atlas
  #scales = []   // índice de tile → footprintScale (1 = sin cambio). Los índices del atlas son
                 // estables ante grow, así que este arreglo sigue alineado entre generaciones.

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
    return i
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
}

export const defineIconSet = (cfg) => new IconSet(cfg)

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
    describe: (variant) => {
      const c0 = variant.charCodeAt(0)
      const dim = c0 === 100                      // 'd'
      const marked = c0 === 109                   // 'm'
      const v = Number(dim || marked ? variant.slice(1) : variant)
      return { shape: 'cluster', count: v, plus: !has.has(v + 1), dim, marked }
    },
    renderers: { cluster: (ctx, size, d) => draw(ctx, size, d.count, d.plus, d.dim, d.marked) },
  })
  // Conteo real → variante. O(1), cero alloc: clamp a [0, top] e indexa LUT + string cacheado.
  set.variantForCount = (count) => variants[count >= top ? lut[top] : lut[count > 0 ? count : 0]]
  // Variante "atenuada" (cluster expandido). Round-trip con el describe de arriba (prefijo 'd'). El
  // sink de burbujas la usa SÓLO si existe (set.expandedVariant) → custom iconSets sin esto no dimean.
  set.expandedVariant = (count) => 'd' + set.variantForCount(count)
  // Variante "marcada" (burbuja que contiene ids marcados por el consumidor). Mismo round-trip
  // (prefijo 'm'); el sink la usa SÓLO si existe → custom iconSets sin esto no resaltan.
  set.markedVariant = (count) => 'm' + set.variantForCount(count)
  return set
}
