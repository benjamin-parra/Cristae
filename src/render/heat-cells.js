import { contribution, POINT_ALPHA } from './heat-math.js'

// Agregación del calor en celdas de pantalla, sin GL ni DOM. Con muchos puntos el costo del calor es el relleno de la GPU:
// cada splat pinta (2R)² px. Juntar los puntos de una celda de N px en UNA muestra baja las instancias sin cambiar la
// imagen a la vista, porque la celda es chica frente al radio.
//
// LA LEY SE CONSERVA. Cada punto suma −ln(1 − c·g) al acumulador. Una celda dibuja una muestra con el aporte medio c̄ = Σc/n
// y la multiplicidad n, que suma n·(−ln(1 − c̄·g)): con aportes iguales es exactamente la suma de sus n puntos en el mismo
// sitio, y con aportes distintos difiere en el término de segundo orden (Σc² frente a (Σc)²/n), que crece con lo empinado
// del término cerca de c·g = 1. Por eso un punto CALIENTE (HOT_CONTRIBUTION) no entra en ninguna celda: va solo, como sin
// agregar. El peso que se suma es el aporte c de cada punto (su peso normalizado por `intensity`, acotado como en el shader),
// no el peso crudo: dos puntos de peso 0 y 1 aportan 0,05 y 0,12, no 0 y 1.
//
// EL CENTROIDE Y LA DISPERSIÓN. La muestra va al centroide de los puntos ponderado por su aporte, no al centro de la celda:
// así el término de primer orden del desplazamiento se anula (Σc·(p − centroide) = 0). Lo que queda es de segundo orden y
// se concentra en los quiebres de la brocha (el borde del núcleo y el alcance R), donde la rampa no es lineal: con la muestra
// en el centroide, el alcance de la celda termina en R, mientras que el de su punto más lejano llega a R + media celda. En una
// región densa ese borde es el que se ve, y se correría hacia adentro. Por eso cada celda lleva también la covarianza de sus
// puntos, y el shader la proyecta en la dirección de cada px: con σ² = uᵀΣu, la dibuja `brushSpreadAt` con s = √3·σ (la
// mitad del ancho de una caja con esa varianza). Con la covarianza y no una varianza única, una ruta que cruza la celda se
// suaviza a lo largo y no de través.
//
// LA GRILLA. Las celdas son de N px de pantalla al nivel L = ⌈zoom·LEVEL_STEPS⌉/LEVEL_STEPS y cubren el mundo entero,
// alineadas a world0: un paneo no la mueve. Entre dos niveles la celda mide en pantalla N·2^(zoom − L), entre N·2^(−1/LEVEL_STEPS)
// y N px.

// Tope de la celda, px CSS: el del banco B5 (100.000 puntos en 24.618 celdas, 60 FPS en la Arc). Sólo lo alcanza un radio
// de más de 160 px; por debajo manda CELL_PER_RADIUS.
export const CELL_PX = 8

// La celda mide R/20, con R = radius + blur: con el radio por defecto (R = 40), 2 px. Medido contra la imagen sin agregar en
// una grilla de densidades, radios y zooms: con R/20 ninguna escena pasa de 0,1 % de px de calor con más de 8/255 de error ni
// de 2 niveles de índice tras admitir un borde corrido 1 px, salvo el borde de regiones de varios puntos por px²; con R/10 o
// R/5 el borde de las regiones densas se ve corrido ya a densidades corrientes. Con un radio chico la celda se achica y la
// agregación deja de pagar por sí sola (MAX_CELL_RATIO).
export const CELL_PER_RADIUS = 1 / 20

// Desde qué aporte un punto va solo y no en una celda. Con c cerca de 1 el término −ln(1 − c·g) cae empinado en el borde del
// núcleo (su pendiente es c/((1 − c·g)·w) por px) y el borde de cada punto se ve: la muestra de la celda, con sus puntos
// repartidos en una caja, lo corre. Medido contra la suma en R32F con celdas enteras: con
// `intensity` 6 (c = 0,72) cumplen 2 de 18 escenas a zoom 8 y 14 de 15 a zoom 10, y con 8 (c = 0,96) 7 de 19 a zoom 9 y 10,5,
// mientras que un splat por punto queda dentro del criterio con 8 en todas (6/255 como mucho). Es el borde de la clase 0 de la
// versión anterior, que con c ≥ 0,5 juntaba los calientes entre sí; los calientes con las celdas partidas no se midieron.
export const HOT_CONTRIBUTION = 0.5

// Desde cuántos puntos válidos la capa agrega con el radio por defecto (R = AGGREGATE_REF_RADIUS). Por debajo dibuja un splat por
// punto, como siempre. El costo de la GPU es el relleno, n·(2R)², así que el umbral sigue a n·R²: ver `aggregates`.
export const AGGREGATE_MIN_POINTS = 20_000

// El R con que se midió AGGREGATE_MIN_POINTS: el del radio y el desenfoque por defecto, 25 + 15 px.
export const AGGREGATE_REF_RADIUS = 40

// Si las celdas pasan de esta fracción de los puntos, agregar no paga: la GPU ahorraría menos de la mitad y la pasada
// queda en el CPU de balde. Corta la pasada en cuanto se cruza, y acota la memoria de las celdas a n/2.
export const MAX_CELL_RATIO = 0.5

// Una celda en el búfer de instancias: x e y del centroide relativas al ancla, el aporte medio, la multiplicidad y la
// covarianza de sus puntos (xx, yy, xy) en px² de world0.
export const CELL_FLOATS = 7

// Un punto en el espejo de HeatLayer: x e y relativas al ancla y el peso normalizado.
const POINT_FLOATS = 3

// Ancho del mundo en world0, px a zoom 0.
const WORLD0 = 256

// El índice de celda va en un Int32: con más de 2^30 celdas por fila (desde L = 26 con celdas de 8 px) no se agrega. A ese zoom
// un punto por celda es lo normal y MAX_CELL_RATIO cortaría igual.
const MAX_INDEX = 2 ** 30

// Niveles de la grilla por cada zoom entero. Con 1 (L = ⌈zoom⌉) la celda medía en pantalla entre N/2 y N px, y justo por encima
// de un entero las celdas se cuadruplicaban: con 100.000 puntos agrupados, 29.433 celdas a zoom 10 y ninguna agregación a 10,01.
// Con 4 la celda queda entre 0,84·N y N px (las celdas, a lo sumo 1,41 veces las del zoom del nivel), y un zoom entero cae en el
// mismo nivel que antes, con las mismas celdas. Más pasos achican el diente de sierra a costa de rehacer las celdas más seguido en
// un zoom continuo: una vez por cada 1/LEVEL_STEPS de zoom recorrido.
export const LEVEL_STEPS = 4

// Margen para que un zoom entero que llega con ruido de coma flotante (10.000000000001) no salte de nivel.
const LEVEL_EPS = 1e-9

// Celdas iniciales de los arreglos de trabajo; después se duplican hasta el tope de MAX_CELL_RATIO.
const MIN_CELLS = 1024

// Constantes del hash multiplicativo (de Fibonacci y de MurmurHash3): reparten índices vecinos por toda la tabla.
const HASH_X = 0x9E3779B1
const HASH_Y = 0x85EBCA77

// Agrega cuando el relleno de un splat por punto, n·(2R)², llega al de AGGREGATE_MIN_POINTS splats de AGGREGATE_REF_RADIUS: con
// R = 80, desde 5.000 puntos; con R = 13, desde 189.000. Con un radio chico la GPU no tiene qué ahorrar y la pasada costaría más que
// lo que saca.
export const aggregates = (n, R) => n * R * R >= AGGREGATE_MIN_POINTS * AGGREGATE_REF_RADIUS * AGGREGATE_REF_RADIUS

export const aggregationLevel = zoom => Math.ceil(zoom * LEVEL_STEPS - LEVEL_EPS) / LEVEL_STEPS

export const cellSize = R => Math.min(CELL_PX, R * CELL_PER_RADIUS)

// Una celda cuyos aportes suman más de HEAVY_CONTRIBUTION se parte en celdas de 1/2^SPLIT_LEVELS de lado. La caja de la
// covarianza termina en √3·σ y el reparto de los puntos no: la cola que queda afuera suma calor a la vista en el borde del
// alcance, tanto más cuanto más pesa la celda. Es el borde de las regiones densas (varios puntos por px²). Medido contra la suma
// en R32F a zoom 8, 9 y 10: con `intensity` 1 cumplen 84 de 85 escenas partiendo desde 32 puntos
// (enteras, 62; desde 8, 64, porque el R16F vuelve a perder los sumandos chicos como sin agregar; desde 128, 77), y la que no,
// mejor que un splat por punto. Con `intensity` 4 el mejor fue desde 8 puntos (30 de 33; desde 32, 24): lo que cuenta es la
// suma de los aportes, 32·POINT_ALPHA en los dos casos. Pide una pasada más sobre los puntos de las celdas pesadas.
export const HEAVY_CONTRIBUTION = 32 * POINT_ALPHA
export const SPLIT_LEVELS = 2

// Desde cuántos puntos una pasada que no va a agregar se corta con una muestra. Medido en un CPU de escritorio: rehacer las celdas
// cuesta hasta 8 ms con 100.000 puntos y de 12 a 50 ms con 500.000, así que desde unos 200.000 una pasada de balde ya no cabe en
// un cuadro.
export const SAMPLE_MIN_POINTS = 200_000

// La muestra toma uno de cada SAMPLE_STRIDE puntos, en el orden del espejo: cuesta 1/SAMPLE_STRIDE de la pasada.
export const SAMPLE_STRIDE = 16

// Una pasada se corta si la estimación de las muestras pasa del tope por este factor. Medido en una grilla de escenas
// (4 tipos, 200.000 a 1 M de puntos, 3 radios, niveles 6 a 16 de a cuarto): la estimación queda entre 0,47 y 1,68 veces
// las celdas de verdad, y la de una escena que agrega llega a 1,31 veces el tope; con 1,5 ninguna que agrega se corta y se
// cortan 517 de las 719 que no.
export const SAMPLE_MARGIN = 1.5

const hash = (ix, iy, mask) => Math.imul(ix ^ Math.imul(iy, HASH_Y), HASH_X) & mask
const FINE_TAG = 0x5BD1E995          // de MurmurHash2: separa en la tabla las celdas partidas de las de su nivel

// Un punto cuyo índice de celda cabe en un Int32. Lo que no cabe está fuera del mundo: invisible también sin agregar.
const inWorld = (x, y, scale) => Math.abs(x * scale) < MAX_INDEX && Math.abs(y * scale) < MAX_INDEX

const pow2AtLeast = n => 2 ** Math.ceil(Math.log2(Math.max(n, 2)))

const grown = (arr, n) => {
  const next = new arr.constructor(n)
  next.set(arr)
  return next
}

// Celdas que tendría la pasada entera, estimadas desde una muestra de 1 de cada `stride` puntos: las vistas, más las que no
// salieron. Con p = 1/stride, una celda de k puntos no sale con probabilidad (1 − p)^k, sale una vez (f1) con k·p·(1 − p)^(k−1) y
// dos (f2) con C(k, 2)·p²·(1 − p)^(k−2): por cada vista una vez se esconden (1 − p)/(k·p), y f2/f1 = (k − 1)·p/(2·(1 − p)) da k.
// Despejado, las escondidas son (stride − 1)·f1²/(f1 + 2·(stride − 1)·f2): exacto con celdas de un punto o de dos, y por debajo
// de la cuenta con más.
export const estimatedCells = (seen, f1, f2, stride) => seen + (f1 ? (stride - 1) * f1 * f1 / (f1 + 2 * (stride - 1) * f2) : 0)

// Los arreglos de trabajo crecen con la cantidad de celdas y se reusan entre pasadas: `build` asigna sólo cuando una pasada
// necesita más celdas que todas las anteriores.
export class HeatCells {

  out    = new Float32Array(0)        // CELL_FLOATS por muestra, listo para subir: las celdas y después los puntos calientes
  count  = 0                          // muestras en `out`; 0 si la última pasada no agregó
  cells  = 0                          // de ellas, celdas; las demás son puntos calientes
  sample = { seen: 0, f1: 0, f2: 0, hot: 0 }   // la última muestra de la proporción, si la hubo
  #table = new Int32Array(0)          // hash (ix, iy) → celda, con sondeo lineal; −1 = libre
  #mask  = 0
  #hot   = 0                          // puntos calientes de la última acumulación
  #ix    = new Int32Array(0)
  #iy    = new Int32Array(0)
  #n     = new Int32Array(0)          // puntos por celda
  #fine  = new Uint8Array(0)          // la celda es de una partida (SPLIT_LEVELS más fina)
  #cellOf = new Int32Array(0)         // la celda de cada punto en la última pasada entera; −1 = caliente o fuera del mundo
  #sumC  = new Float64Array(0)        // Σ aporte
  #sumX  = new Float64Array(0)        // Σ aporte · (x de celda − ix), en unidades de celda
  #sumY  = new Float64Array(0)
  #sumXX = new Float64Array(0)        // Σ aporte · (x de celda − ix)²
  #sumYY = new Float64Array(0)
  #sumXY = new Float64Array(0)

  // Agrega los `n` primeros puntos de `mirror` (relativos al ancla) en celdas de `cellPx` px al nivel `level`, salvo los
  // calientes, que van uno por muestra, y partiendo las pesadas. Devuelve las muestras, o 0 si no paga (más de
  // n·MAX_CELL_RATIO, o un nivel cuyo índice no cabe), y deja cada una en `out`, relativa a la misma ancla. Desde
  // SAMPLE_MIN_POINTS una muestra de los puntos estima antes si la pasada va a pagar.
  build(mirror, n, anchorX, anchorY, level, cellPx, intensity) {
    this.count = this.cells = 0
    this.sample.seen = this.sample.f1 = this.sample.f2 = this.sample.hot = 0
    const scale    = 2 ** level / cellPx           // celdas por px de world0
    const maxCells = Math.floor(n * MAX_CELL_RATIO)
    if (!(cellPx > 0) || WORLD0 * scale > MAX_INDEX || maxCells < 1) return 0

    const size = pow2AtLeast(2 * maxCells + 1)       // carga ≤ 1/2, y con las partidas nunca llena
    if (this.#table.length < size) this.#table = new Int32Array(size)
    this.#mask = size - 1

    if (n >= SAMPLE_MIN_POINTS) {
      const seen = this.#accumulate(mirror, n, anchorX, anchorY, scale, intensity, maxCells, SAMPLE_STRIDE, false)
      if (seen < 0) return 0

      let f1 = 0, f2 = 0
      for (let k = 0; k < seen; k++) this.#n[k] === 1 ? f1++ : this.#n[k] === 2 && f2++
      this.sample.seen = seen
      this.sample.f1   = f1
      this.sample.f2   = f2
      this.sample.hot  = this.#hot
      if (estimatedCells(seen, f1, f2, SAMPLE_STRIDE) + this.#hot * SAMPLE_STRIDE > maxCells * SAMPLE_MARGIN) return 0
    }
    const cells = this.#accumulate(mirror, n, anchorX, anchorY, scale, intensity, maxCells, 1, true)
    if (cells < 0) return 0

    const heavyMin  = HEAVY_CONTRIBUTION
    const fineScale = scale * 2 ** SPLIT_LEVELS
    let heavy = 0
    if (WORLD0 * fineScale <= MAX_INDEX)
      for (let k = 0; k < cells; k++) this.#sumC[k] > heavyMin && heavy++
    const fine  = heavy ? this.#split(mirror, n, anchorX, anchorY, fineScale, intensity, cells, heavyMin, maxCells - cells + heavy - this.#hot) : 0
    const kept  = fine > 0 ? cells - heavy : cells
    const total = kept + Math.max(fine, 0) + this.#hot
    if (this.out.length < total * CELL_FLOATS) this.out = new Float32Array(Math.max(total, Math.min(this.#ix.length, maxCells)) * CELL_FLOATS)
    const out = this.out
    let o = 0
    for (let k = 0; k < cells + Math.max(fine, 0); k++) {
      if (fine > 0 && k < cells && this.#sumC[k] > heavyMin) continue

      const sc   = k < cells ? scale : fineScale
      const area = sc * sc                          // celdas² por px² de world0
      const sumC = this.#sumC[k]
      const mx   = this.#sumX[k] / sumC
      const my   = this.#sumY[k] / sumC
      out[o]     = (this.#ix[k] + mx) / sc - anchorX
      out[o + 1] = (this.#iy[k] + my) / sc - anchorY
      out[o + 2] = sumC / this.#n[k]
      out[o + 3] = this.#n[k]
      out[o + 4] = Math.max(this.#sumXX[k] / sumC - mx * mx, 0) / area
      out[o + 5] = Math.max(this.#sumYY[k] / sumC - my * my, 0) / area
      out[o + 6] = (this.#sumXY[k] / sumC - mx * my) / area
      o += CELL_FLOATS
    }
    if (this.#hot)
      for (let i = 0, p = 0; i < n; i++, p += POINT_FLOATS) {
        const c = contribution(mirror[p + 2], intensity)
        if (c < HOT_CONTRIBUTION || !inWorld(anchorX + mirror[p], anchorY + mirror[p + 1], scale)) continue

        out[o]     = mirror[p]
        out[o + 1] = mirror[p + 1]
        out[o + 2] = c
        out[o + 3] = 1
        out[o + 4] = out[o + 5] = out[o + 6] = 0
        o += CELL_FLOATS
      }
    this.cells = total - this.#hot
    this.count = total
    return total
  }

  // Vuelve a juntar los puntos de las celdas pesadas (aportes que suman más de `heavyMin`) en celdas de `fineScale`, a
  // continuación de las `cells` de la tabla. Devuelve cuántas, o −1 si pasan de `budget`: entonces las pesadas quedan enteras.
  #split(mirror, n, anchorX, anchorY, fineScale, intensity, cells, heavyMin, budget) {
    const table = this.#table
    const mask  = this.#mask
    const cellOf = this.#cellOf
    let fine = 0
    for (let i = 0, o = 0; i < n; i++, o += POINT_FLOATS) {
      const parent = cellOf[i]
      if (parent < 0 || this.#sumC[parent] <= heavyMin) continue

      const x  = anchorX + mirror[o]
      const y  = anchorY + mirror[o + 1]
      const c  = contribution(mirror[o + 2], intensity)
      const fx = x * fineScale
      const fy = y * fineScale
      const ix = Math.floor(fx)
      const iy = Math.floor(fy)
      let h = hash(ix, iy ^ FINE_TAG, mask)
      let k = table[h]
      while (k >= 0 && (this.#ix[k] !== ix || this.#iy[k] !== iy || !this.#fine[k])) {
        h = (h + 1) & mask
        k = table[h]
      }
      if (k < 0) {
        if (fine === budget) return -1

        k = cells + fine++
        k === this.#ix.length && this.#grow(Math.max(MIN_CELLS, k * 2))
        table[h] = k
        this.#ix[k] = ix
        this.#iy[k] = iy
        this.#n[k]  = 0
        this.#fine[k] = 1
        this.#sumC[k] = this.#sumX[k] = this.#sumY[k] = this.#sumXX[k] = this.#sumYY[k] = this.#sumXY[k] = 0
      }
      const dx = fx - ix
      const dy = fy - iy
      this.#n[k]++
      this.#sumC[k]  += c
      this.#sumX[k]  += c * dx
      this.#sumY[k]  += c * dy
      this.#sumXX[k] += c * dx * dx
      this.#sumYY[k] += c * dy * dy
      this.#sumXY[k] += c * dx * dy
    }
    return fine
  }

  // Junta uno de cada `stride` puntos en la tabla, desde vacía, y cuenta aparte los calientes. Devuelve las celdas, o −1 si con
  // los calientes pasan de `maxCells`. Sin `sums` sólo cuenta los puntos de cada celda: es la muestra. Con `sums` anota además
  // la celda de cada punto, que `#split` reusa.
  #accumulate(mirror, n, anchorX, anchorY, scale, intensity, maxCells, stride, sums) {
    const table = this.#table
    const mask  = this.#mask
    table.fill(-1, 0, mask + 1)
    if (sums && this.#cellOf.length < n) this.#cellOf = new Int32Array(Math.max(n, this.#cellOf.length * 2))
    const cellOf = this.#cellOf
    let cells = 0
    let hot   = 0
    for (let i = 0, o = 0; i < n; i += stride, o += POINT_FLOATS * stride) {
      const x = anchorX + mirror[o]
      const y = anchorY + mirror[o + 1]
      sums && (cellOf[i] = -1)
      if (!inWorld(x, y, scale)) continue          // fuera del mundo: invisible también sin agregar

      const c = contribution(mirror[o + 2], intensity)
      if (c >= HOT_CONTRIBUTION) {
        if (cells + ++hot > maxCells) return -1
        continue
      }
      const fx = x * scale
      const fy = y * scale
      const ix = Math.floor(fx)
      const iy = Math.floor(fy)
      let h = hash(ix, iy, mask)
      let k = table[h]
      while (k >= 0 && (this.#ix[k] !== ix || this.#iy[k] !== iy || this.#fine[k])) {
        h = (h + 1) & mask
        k = table[h]
      }
      if (k < 0) {
        if (cells + hot === maxCells) return -1

        cells === this.#ix.length && this.#grow(Math.min(maxCells, Math.max(MIN_CELLS, cells * 2)))
        k = cells++
        table[h] = k
        this.#ix[k] = ix
        this.#iy[k] = iy
        this.#n[k]  = 0
        this.#fine[k] = 0
        if (sums) {
          this.#sumC[k] = 0
          this.#sumX[k] = 0
          this.#sumY[k] = 0
          this.#sumXX[k] = 0
          this.#sumYY[k] = 0
          this.#sumXY[k] = 0
        }
      }
      this.#n[k]++
      if (!sums) continue

      cellOf[i] = k
      const dx = fx - ix
      const dy = fy - iy
      this.#sumC[k]  += c
      this.#sumX[k]  += c * dx
      this.#sumY[k]  += c * dy
      this.#sumXX[k] += c * dx * dx
      this.#sumYY[k] += c * dy * dy
      this.#sumXY[k] += c * dx * dy
    }
    this.#hot = hot
    return cells
  }

  #grow(cells) {
    this.#ix   = grown(this.#ix, cells)
    this.#iy   = grown(this.#iy, cells)
    this.#n    = grown(this.#n, cells)
    this.#fine = grown(this.#fine, cells)
    this.#sumC = grown(this.#sumC, cells)
    this.#sumX = grown(this.#sumX, cells)
    this.#sumY = grown(this.#sumY, cells)
    this.#sumXX = grown(this.#sumXX, cells)
    this.#sumYY = grown(this.#sumYY, cells)
    this.#sumXY = grown(this.#sumXY, cells)
  }
}
