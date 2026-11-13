import { contribution, TERM_CAP } from './heat-math.js'

// Agregación del calor en celdas de pantalla, sin GL ni DOM. Con muchos puntos el costo del calor es el relleno de la GPU:
// cada splat pinta (2R)² px. Juntar los puntos de una celda de N px en UNA muestra baja las instancias sin cambiar la
// imagen a la vista, porque la celda es chica frente al radio.
//
// LA LEY SE CONSERVA. Cada punto suma −ln(1 − c·g) al acumulador. Una celda dibuja una muestra con el aporte medio c̄ = Σc/n
// y la multiplicidad n, que suma n·(−ln(1 − c̄·g)): con aportes iguales es exactamente la suma de sus n puntos en el mismo
// sitio, y con aportes distintos difiere en el término de segundo orden (Σc² frente a (Σc)²/n), que crece con lo empinado
// del término cerca de c·g = 1. Por eso una celda sólo junta puntos de la misma CLASE de aporte (CLASS_STEP): con `intensity`
// ≤ 4 todos caen en una sola y la celda es la de siempre. El peso que se suma es el aporte c de cada punto (su peso
// normalizado por `intensity`, acotado como en el shader), no el peso crudo: dos puntos de peso 0 y 1 aportan 0,05 y 0,12,
// no 0 y 1.
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
// LA GRILLA. Las celdas son de N px de pantalla al nivel entero L = ⌈zoom⌉ y cubren el mundo entero, alineadas a world0:
// un paneo no la mueve. Con L = ⌈zoom⌉, entre dos niveles la celda mide en pantalla N·2^(zoom − L) ≤ N px.

// Tope de la celda, px CSS: el del banco B5 (100.000 puntos en 24.618 celdas, 60 FPS en la Arc). Sólo lo alcanza un radio
// de más de 160 px; por debajo manda CELL_PER_RADIUS.
export const CELL_PX = 8

// La celda mide R/20, con R = radius + blur: con el radio por defecto (R = 40), 2 px. Medido contra la imagen sin agregar en
// una grilla de densidades, radios y zooms: con R/20 ninguna escena pasa de 0,1 % de px de calor con más de 8/255 de error ni
// de 2 niveles de índice tras admitir un borde corrido 1 px, salvo el borde de regiones de varios puntos por px²; con R/10 o
// R/5 el borde de las regiones densas se ve corrido ya a densidades corrientes. Con un radio chico la celda se achica y la
// agregación deja de pagar por sí sola (MAX_CELL_RATIO).
export const CELL_PER_RADIUS = 1 / 20

// Ancho de una clase de aporte, en el valor del término a g = 1: u = −ln(1 − c), que es cuánto suma el punto en el centro de
// su brocha. Con ln 2 cada clase deja 1 − c a la mitad (c < 0,5; hasta 0,75; hasta 0,875...). El término es convexo en c y la
// muestra de la celda usa el aporte medio, así que subestima a una celda de aportes distintos tanto más cuanto más cerca de 1
// llegan. Medido en una suma en CPU de la ley (escena agrupada de 100.000 puntos, radio por defecto, celda de 2 px, el 3 % de
// los puntos con peso pleno y el resto casi sin peso): sin clases el peor error pasa el criterio (≤ 12/255 y ≤ 0,1 % de los px
// de calor con más de 8/255) hasta `intensity` 4 (9/255, 0,06 %) y no desde 5 (9/255, 0,21 %; con 8: 51/255 y 0,62 %); con
// clases, 6/255 y ningún px desde 5 hasta 8. Razonado: el aporte máximo es POINT_ALPHA·intensity, así que con `intensity` ≤ 4
// (c ≤ 0,48) todo cae en la clase 0 y nada cambia. Si con las clases las celdas pasan de MAX_CELL_RATIO, no agrega.
export const CLASS_STEP = Math.LN2

// Desde cuántos puntos válidos la capa agrega. Por debajo dibuja un splat por punto, como siempre.
export const AGGREGATE_MIN_POINTS = 20_000

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

// Margen para que un zoom entero que llega con ruido de coma flotante (10.000000000001) no salte de nivel.
const LEVEL_EPS = 1e-9

// Celdas iniciales de los arreglos de trabajo; después se duplican hasta el tope de MAX_CELL_RATIO.
const MIN_CELLS = 1024

// Constantes del hash multiplicativo (de Fibonacci y de MurmurHash3): reparten índices vecinos por toda la tabla.
const HASH_X = 0x9E3779B1
const HASH_Y = 0x85EBCA77
const HASH_CLASS = 0x27D4EB2F      // de xxHash32: reparte las clases de una misma celda

export const aggregationLevel = zoom => Math.ceil(zoom - LEVEL_EPS)

export const cellSize = R => Math.min(CELL_PX, R * CELL_PER_RADIUS)

// La clase de un aporte: el escalón de u = −ln(1 − c), con u acotado a TERM_CAP (c = 1 daría ∞).
export const contributionClass = c => Math.floor(Math.min(-Math.log1p(-c), TERM_CAP) / CLASS_STEP)

const pow2AtLeast = n => 2 ** Math.ceil(Math.log2(Math.max(n, 2)))

const grown = (arr, n) => {
  const next = new arr.constructor(n)
  next.set(arr)
  return next
}

// Los arreglos de trabajo crecen con la cantidad de celdas y se reusan entre pasadas: `build` asigna sólo cuando una pasada
// necesita más celdas que todas las anteriores.
export class HeatCells {

  out    = new Float32Array(0)        // CELL_FLOATS por celda, listo para subir
  count  = 0                          // celdas en `out`; 0 si la última pasada no agregó
  #table = new Int32Array(0)          // hash (ix, iy) → celda, con sondeo lineal; −1 = libre
  #ix    = new Int32Array(0)
  #iy    = new Int32Array(0)
  #cls   = new Int32Array(0)          // clase de aporte de la celda
  #n     = new Int32Array(0)          // puntos por celda
  #sumC  = new Float64Array(0)        // Σ aporte
  #sumX  = new Float64Array(0)        // Σ aporte · (x de celda − ix), en unidades de celda
  #sumY  = new Float64Array(0)
  #sumXX = new Float64Array(0)        // Σ aporte · (x de celda − ix)²
  #sumYY = new Float64Array(0)
  #sumXY = new Float64Array(0)

  // Agrega los `n` primeros puntos de `mirror` (relativos al ancla) en celdas de `cellPx` px al nivel `level`, una por cada
  // clase de aporte que haya en la celda. Devuelve las celdas, o 0 si no paga (más de n·MAX_CELL_RATIO celdas, o un nivel cuyo índice no cabe), y deja la muestra de cada una en
  // `out`, relativa a la misma ancla.
  build(mirror, n, anchorX, anchorY, level, cellPx, intensity) {
    this.count = 0
    const scale    = 2 ** level / cellPx           // celdas por px de world0
    const maxCells = Math.floor(n * MAX_CELL_RATIO)
    if (!(cellPx > 0) || WORLD0 * scale > MAX_INDEX || maxCells < 1) return 0

    const size = pow2AtLeast(2 * maxCells)           // carga ≤ 1/2: el sondeo lineal queda corto
    if (this.#table.length < size) this.#table = new Int32Array(size)
    const table = this.#table
    const mask  = size - 1
    table.fill(-1, 0, size)

    let cells = 0
    for (let i = 0, o = 0; i < n; i++, o += POINT_FLOATS) {
      const fx = (anchorX + mirror[o]) * scale
      const fy = (anchorY + mirror[o + 1]) * scale
      if (!(Math.abs(fx) < MAX_INDEX && Math.abs(fy) < MAX_INDEX)) continue    // fuera del mundo: invisible también sin agregar

      const ix = Math.floor(fx)
      const iy = Math.floor(fy)
      const c   = contribution(mirror[o + 2], intensity)
      const cls = contributionClass(c)
      let h = Math.imul(ix ^ Math.imul(iy, HASH_Y) ^ Math.imul(cls, HASH_CLASS), HASH_X) & mask
      let k = table[h]
      while (k >= 0 && (this.#ix[k] !== ix || this.#iy[k] !== iy || this.#cls[k] !== cls)) {
        h = (h + 1) & mask
        k = table[h]
      }
      if (k < 0) {
        if (cells === maxCells) return 0

        cells === this.#ix.length && this.#grow(Math.min(maxCells, Math.max(MIN_CELLS, cells * 2)))
        k = cells++
        table[h] = k
        this.#ix[k]   = ix
        this.#iy[k]   = iy
        this.#cls[k]  = cls
        this.#n[k]    = 0
        this.#sumC[k] = 0
        this.#sumX[k] = 0
        this.#sumY[k] = 0
        this.#sumXX[k] = 0
        this.#sumYY[k] = 0
        this.#sumXY[k] = 0
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

    if (this.out.length < cells * CELL_FLOATS) this.out = new Float32Array(this.#ix.length * CELL_FLOATS)
    const out = this.out
    for (let k = 0, o = 0; k < cells; k++, o += CELL_FLOATS) {
      const sumC = this.#sumC[k]
      const mx   = this.#sumX[k] / sumC
      const my   = this.#sumY[k] / sumC
      const area     = scale * scale                // celdas² por px² de world0
      out[o]     = (this.#ix[k] + mx) / scale - anchorX
      out[o + 1] = (this.#iy[k] + my) / scale - anchorY
      out[o + 2] = sumC / this.#n[k]
      out[o + 3] = this.#n[k]
      out[o + 4] = Math.max(this.#sumXX[k] / sumC - mx * mx, 0) / area
      out[o + 5] = Math.max(this.#sumYY[k] / sumC - my * my, 0) / area
      out[o + 6] = (this.#sumXY[k] / sumC - mx * my) / area
    }
    this.count = cells
    return cells
  }

  #grow(cells) {
    this.#ix   = grown(this.#ix, cells)
    this.#iy   = grown(this.#iy, cells)
    this.#cls  = grown(this.#cls, cells)
    this.#n    = grown(this.#n, cells)
    this.#sumC = grown(this.#sumC, cells)
    this.#sumX = grown(this.#sumX, cells)
    this.#sumY = grown(this.#sumY, cells)
    this.#sumXX = grown(this.#sumXX, cells)
    this.#sumYY = grown(this.#sumYY, cells)
    this.#sumXY = grown(this.#sumXY, cells)
  }
}
