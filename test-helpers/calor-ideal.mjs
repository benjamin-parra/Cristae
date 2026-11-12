// Referencia IDEAL del campo de calor, en float64, y los gemelos numéricos de lo que hace la GPU
// (suma logarítmica en R16F/R32F y mezcla `over` en RGBA8). Sirve a las pruebas de Node y al escenario
// de navegador. Reimplementa la brocha y el aporte desde la semántica del canvas (degradado radial con
// núcleo opaco y caída lineal; alfa acumulado con source-over) e importa sólo las constantes numéricas
// de heat-math: no copia la implementación que valida.
import { POINT_ALPHA, MIN_OPACITY, CORE_MAX, TERM_FLOOR } from '../src/render/heat-math.js'

// Origen, por formato. Unidades: niveles del índice alfa (0..255); `media` es la media del error absoluto por píxel.
//   · r16f : máximo 2 y media 0,3, medidos en una NVIDIA y en una Arc con 5 000 a 100 000 puntos agolpados contra este
//     mismo ideal (el máximo 2 salió con blur 0 en la Arc). R16F con pilas de cientos de aportes de borde NO está medido.
//   · rgba8: máximo 8 y media 1,3, de la tabla de 20 000 puntos con blur 0 (máximo medido 8, media medida 0,97 de
//     1,21 según la GPU): el máximo medido es IGUAL a la tolerancia, sin margen, y no se midió a 100 000 puntos.
//   · El escenario de navegador las confirmó en una Intel UHD 730 (Mesa, ANGLE sobre GL) con el ideal en la posición fraccionaria
//     de cada punto: r16f, máximo 1 y media hasta 0,24; rgba8, máximo 5 y media hasta 0,83. Con el ideal en el píxel redondeado
//     que reporta la cámara el error sube a máximo 10 y media 1,4: lo redondeado es el ideal, no la GPU.
//   · rgba8 no llega al tope: con 60 puntos coincidentes el índice se estanca en 251, igual que `gemeloOver8`.
export const TOLERANCIA = {
  r16f : { max: 2, media: 0.3 },
  rgba8: { max: 8, media: 1.3 },
}

/* ── Conjunto de puntos determinista ── */

const LCG_A = 1664525            // Numerical Recipes: multiplicador del congruencial lineal de 32 bits
const LCG_C = 1013904223
const LCG_M = 4294967296

const lcg = semilla => {
  let s = semilla >>> 0
  return () => (s = (Math.imul(s, LCG_A) + LCG_C) >>> 0) / LCG_M
}

// Puntos en px de contenedor {x, y, peso} con el peso normalizado por el máximo del conjunto: `nucleos`
// racimos gaussianos más una fracción `dispersos` repartida uniforme.
export const conjunto = ({ semilla = 1, n, ancho, alto, nucleos = 60, dispersos = 0.15, pesos = [0.05, 1] }) => {
  const rnd     = lcg(semilla)
  const centros = Array.from({ length: nucleos }, () => ({ x: rnd() * ancho, y: rnd() * alto }))
  const sigma   = Math.min(ancho, alto) / 25
  const gauss   = () => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd())
  const crudos  = Array.from({ length: n }, () => {
    const c    = centros[Math.floor(rnd() * nucleos)]
    const x    = rnd() < dispersos ? rnd() * ancho : c.x + gauss() * sigma
    const y    = rnd() < dispersos ? rnd() * alto : c.y + gauss() * sigma
    return { x, y, peso: pesos[0] + rnd() * (pesos[1] - pesos[0]) }
  })
  const max = crudos.reduce((m, p) => Math.max(m, p.peso), 0) || 1
  return crudos.map(p => ({ x: p.x, y: p.y, peso: p.peso / max }))
}

/* ── Brocha y aporte (semántica del canvas) ── */

const parametros = ({ radius, blur, intensity }) => {
  const R = radius + blur
  return { R, nucleo: R > 0 && blur > 0 ? Math.min(radius, CORE_MAX * R) : 0, intensity }
}
const perfil  = (d, R, nucleo) => (d <= nucleo ? 1 : d >= R ? 0 : (R - d) / (R - nucleo))
const aporte  = (peso, intensity) => Math.min(Math.max(peso * intensity * POINT_ALPHA, MIN_OPACITY), 1)

// Recorre los píxeles que toca cada splat, EN el orden de los splats, y entrega (índice de píxel, c, g).
// El alcance es el cuadro de lado 2R: no hace falta O(px·n).
const splats = ({ ancho, alto, puntos, radius, blur, intensity }, fn) => {
  const { R, nucleo } = parametros({ radius, blur, intensity })
  if (R <= 0) return
  puntos.forEach(p => {
    const c  = aporte(p.peso, intensity)
    const x0 = Math.max(0, Math.ceil(p.x - R - 0.5))
    const x1 = Math.min(ancho - 1, Math.floor(p.x + R - 0.5))
    const y0 = Math.max(0, Math.ceil(p.y - R - 0.5))
    const y1 = Math.min(alto - 1, Math.floor(p.y + R - 0.5))
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const g = perfil(Math.hypot(x + 0.5 - p.x, y + 0.5 - p.y), R, nucleo)
        g > 0 && fn(y * ancho + x, c, g)
      }
    }
  })
}

/* ── Ideal float64: a = 1 − Π(1 − c·g), idx = round(a·255) ── */

export const ideal = args => {
  const { ancho, alto } = args
  const resto  = new Float64Array(ancho * alto).fill(1)
  splats(args, (i, c, g) => { resto[i] *= 1 - c * g })
  const indice = new Uint8Array(ancho * alto)
  resto.forEach((r, i) => { indice[i] = Math.round((1 - r) * 255) })
  return { indice, alfa: resto.map(r => 1 - r) }
}

/* ── Medio flotante por bits (Math.f16round no está garantizado en Node 24) ── */

const f32 = new Float32Array(1)
const u32 = new Uint32Array(f32.buffer)

const F16_MAX     = 65504          // mayor half finito
const F16_MIN_EXP = -14            // exponente del menor half normal
const F16_MANT    = 10             // bits de mantisa del half
const F16_SUB_EXP = -24            // cuanto de los subnormales: 2^-24

// Redondea x (≥ 0 o negativo) al half más cercano ('cercano', empate al par) o hacia cero ('cero').
export const f16 = (x, modo = 'cercano') => {
  if (!Number.isFinite(x) || x === 0) return x
  f32[0] = x
  const bits = u32[0]
  const exp  = ((bits >>> 23) & 0xff) - 127
  const paso = 2 ** (exp < F16_MIN_EXP ? F16_SUB_EXP : exp - F16_MANT)
  const ax   = Math.abs(f32[0])
  const q    = ax / paso
  let r      = Math.floor(q)
  if (modo === 'cercano') {
    const dif = q - r
    if (dif > 0.5 || (dif === 0.5 && r % 2 === 1)) r++
  }
  const v = r * paso
  const m = v > F16_MAX ? (modo === 'cercano' ? Infinity : F16_MAX) : v
  return x < 0 ? -m : m
}

/* ── Gemelo de la suma logarítmica: S += −ln(1 − c·g), a = 1 − exp(−S) ── */

export const gemeloLogsum = ({ almacen = 'f16-cercano', ...args }) => {
  const { ancho, alto } = args
  const guarda = almacen === 'f32' ? Math.fround : almacen === 'f16-cero' ? x => f16(x, 'cero') : x => f16(x, 'cercano')
  const suma   = new Float32Array(ancho * alto)
  splats(args, (i, c, g) => {
    const cg     = Math.fround(c * g)
    const termino = guarda(Math.fround(-Math.log(Math.max(Math.fround(1 - cg), Math.fround(TERM_FLOOR)))))
    suma[i]      = guarda(suma[i] + termino)
  })
  const indice = new Uint8Array(ancho * alto)
  suma.forEach((s, i) => { indice[i] = Math.round(Math.fround(Math.fround(1 - Math.fround(Math.exp(-s))) * 255)) })
  return indice
}

/* ── Gemelo de RGBA8 con mezcla over: cada mezcla cuantiza a 8 bits ── */

export const gemeloOver8 = args => {
  const { ancho, alto } = args
  const acum = new Uint8Array(ancho * alto)
  splats(args, (i, c, g) => {
    const q = Math.round(Math.round(c * 255) * Math.round(g * 255) / 255) / 255
    acum[i] = Math.round((q + (acum[i] / 255) * (1 - q)) * 255)
  })
  return acum
}

/* ── Comparación de dos índices ── */

export const comparar = (a, b) => {
  const histograma = {}
  let suma = 0
  let max  = 0
  a.forEach((v, i) => {
    const d = Math.abs(v - b[i])
    suma += d
    max   = Math.max(max, d)
    histograma[d] = (histograma[d] ?? 0) + 1
  })
  return { media: suma / a.length, max, histograma }
}
