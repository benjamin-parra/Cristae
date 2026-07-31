// Banco de geometrías patológicas para el relleno par-impar: cóncavos, auto-intersecciones, agujeros
// y winding inconsistente son los casos donde una triangulación se rompe y donde el abanico de stencil
// tiene que dar el mismo resultado sin triangular. Lo comparten los tests y el probe de fill-rate.
//
// Convención: un anillo es un `Float64Array` de pares [x, y] con CIERRE IMPLÍCITO (el último punto NO
// repite el primero), y toda forma cabe en el cuadrado [-1, 1] — así el consumidor la lleva a pantalla
// con UN factor de escala y el porcentaje de pantalla que mide es el que pidió.

const TAU = Math.PI * 2

// Anillo de n vértices: `escribir(r, o, i)` deja el punto i en el offset o. El array se dimensiona una
// sola vez, así que la cuenta de vértices es exacta por construcción.
const anillo = (n, escribir) => {
  const r = new Float64Array(n * 2)
  for (let i = 0; i < n; i++) escribir(r, i * 2, i)
  return r
}

const circulo = (n, radio, sentido, cx = 0, cy = 0) => anillo(n, (r, o, i) => {
  const a = sentido * TAU * i / n
  r[o]     = cx + Math.cos(a) * radio
  r[o + 1] = cy + Math.sin(a) * radio
})

// Reparte n vértices entre varios anillos según pesos; el último absorbe el redondeo, así la suma es n.
const reparto = (n, pesos) => {
  const total  = pesos.reduce((s, p) => s + p, 0)
  const partes = pesos.map(p => Math.round(n * p / total))
  partes[partes.length - 1] += n - partes.reduce((s, p) => s + p, 0)
  return partes
}

const mcd = (a, b) => (b ? mcd(b, a % b) : a)

// Paso más grande coprimo con n: da un polígono estrellado {n/k}, o sea el moño de 4 puntos llevado a
// n cruces — la auto-intersección que ninguna triangulación por orejas resuelve.
const pasoEstrella = n => {
  for (let k = (n >> 1) - 1; k > 1; k--) if (mcd(n, k) === 1) return k
  return 1
}

const convexo = n => [circulo(n, 1, 1)]

// Peine de n/4 dientes verticales: peor caso clásico de la triangulación por orejas y, para el abanico,
// el de mayor solape de triángulos por unidad de área.
const peine = n => {
  const dientes = Math.max(1, (n / 4) | 0)
  const paso    = 2 / dientes
  const cuerpo  = dientes * 4
  const ultimo  = 1 - 0.25 * paso
  return [anillo(n, (r, o, i) => {
    // Los sobrantes del redondeo caminan la base hacia la izquierda: vértices colineales, patológicos
    // por su cuenta y sin doblar el trazo sobre sí mismo.
    if (i >= cuerpo) { r[o] = ultimo - (i - cuerpo + 1) * 1e-3; r[o + 1] = -1; return }
    const k = i % 4
    r[o]     = -1 + ((i / 4) | 0) * paso + paso * (k < 2 ? 0.25 : 0.75)
    r[o + 1] = k === 1 || k === 2 ? 1 : -1
  })]
}

// Espiral de ida y vuelta (una cinta): la forma con más concavidad y más solape de abanico del banco.
const VUELTAS = 12
const espiral = n => {
  const mitad = n >> 1
  return [anillo(n, (r, o, i) => {
    const ida = i < mitad
    const t   = ida ? i / mitad : (n - i) / (n - mitad)
    const a   = TAU * VUELTAS * t
    const rad = 0.08 + 0.86 * t + (ida ? 0 : 0.05)
    r[o]     = Math.cos(a) * rad
    r[o + 1] = Math.sin(a) * rad
  })]
}

const mono = n => {
  const k = pasoEstrella(n)
  return [anillo(n, (r, o, i) => {
    const a = TAU * ((i * k) % n) / n
    r[o]     = Math.cos(a)
    r[o + 1] = Math.sin(a)
  })]
}

const agujero = n => {
  const [exterior, hueco] = reparto(n, [3, 2])
  return [circulo(exterior, 1, 1), circulo(hueco, 0.55, -1)]
}

const isla = n => {
  const [exterior, hueco, dentro] = reparto(n, [5, 3, 2])
  return [circulo(exterior, 1, 1), circulo(hueco, 0.66, -1), circulo(dentro, 0.3, 1)]
}

// Los dos anillos con el MISMO sentido: el agujero sólo aparece bajo par-impar (con nonzero se rellena).
// Es el caso real, porque el backend no garantiza la orientación de los anillos.
const windingInvertido = n => {
  const [exterior, hueco] = reparto(n, [3, 2])
  return [circulo(exterior, 1, 1), circulo(hueco, 0.55, 1)]
}

const CENTROS = [[-0.55, -0.55], [0.55, -0.55], [0.55, 0.55], [-0.55, 0.55]]

const disjuntos = n => reparto(n, CENTROS.map(() => 1))
  .map((cuenta, k) => circulo(cuenta, 0.4, 1, CENTROS[k][0], CENTROS[k][1]))

export const FORMAS = { convexo, peine, espiral, mono, agujero, isla, windingInvertido, disjuntos }

export const TAMANOS = [400, 5_000, 50_000]

export const CASOS = Object.keys(FORMAS).flatMap(forma => TAMANOS.map(n => ({ id: `${forma}-${n}`, forma, n })))

export const crear = ({ forma, n }) => FORMAS[forma](n)

export const cuentaVertices = anillos => anillos.reduce((total, r) => total + r.length / 2, 0)

// Degeneradas: no son casos de medición sino los que el consumidor tiene que resolver sin propagar.
export const DEGENERADAS = {
  // Un NaN o un ±Infinity envenena cualquier bbox y con él el scissor: el anillo se descarta entero.
  noFinitas       : [Float64Array.from([0, 0, 1, 0, NaN, 0.5, Infinity, -Infinity, 0, 1])],
  // El último punto repite el primero: con cierre implícito eso es una arista de longitud cero (la
  // paridad no se altera, pero la normal del segmento divide por cero).
  cierreDuplicado : [Float64Array.from([0, 0, 1, 0, 1, 1, 0, 1, 0, 0])],
}
