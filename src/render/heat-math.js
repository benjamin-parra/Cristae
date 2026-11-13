import { toRGBA } from './color.js'

// Matemática PURA del campo de calor (sin GL ni DOM): constantes, brocha, aporte por punto, rampa por
// defecto y muestreo de la paleta. La comparten la capa y los shaders, para que el número que se pinta
// y el que se prueba salgan de un solo lugar.

export const DEFAULT_RADIUS    = 25     // px del núcleo sólido de la brocha
export const DEFAULT_BLUR      = 15     // px de caída (núcleo → transparente)
export const DEFAULT_INTENSITY = 1      // multiplicador del aporte por punto (1 = default; >1 satura antes)
export const POINT_ALPHA       = 0.12   // techo del alpha que aporta UN punto de peso pleno: ~1/POINT_ALPHA
                                        // puntos superpuestos llevan el campo al tope de la rampa. <1 para
                                        // que la composición ACUMULE (densidad) en vez de saturar a disco sólido
export const MIN_OPACITY       = 0.05   // piso de alpha por punto (un punto aislado igual se ve)
export const GRAD_STEPS        = 256    // resolución de la paleta (alpha 0..255 indexa 1:1)
export const CORE_MAX          = 0.99   // tope de la fracción del núcleo: el degradado necesita un tramo de caída > 0

// Tope del término −ln(1 − c·g) de la suma logarítmica. Origen razonado: un aporte saturado (c·g = 1) daría −ln(0), que
// GLSL ES 3.00 no define (según el driver es infinito o NaN). El argumento del log se acota por TERM_FLOOR = 1/(4·255),
// así que el término vale a lo sumo TERM_CAP = ln(4·255), y el alfa resultante queda a un cuarto de nivel de 8 bits
// de 1 (255·e^-TERM_CAP = 0,25).
export const TERM_FLOOR = 1 / (4 * 255)
export const TERM_CAP   = -Math.log(TERM_FLOOR)

export const nonNeg = (v, dflt) => (v == null ? dflt : Math.max(0, v))   // radius/blur < 0 romperían la brocha

// Fracción del radio total R = radius + blur que ocupa el núcleo opaco. Con R > 0 y blur > 0 es
// min(radius/R, CORE_MAX); en otro caso 0: blur 0 deja un cono lineal de radio `radius` y R = 0 no pinta.
export const brushCore = (radius, blur) => {
  const R = radius + blur
  return R > 0 && blur > 0 ? Math.min(radius / R, CORE_MAX) : 0
}

// Perfil de la brocha a distancia d del centro: 1 hasta core·R, lineal a 0 en R.
export const brushAt = (d, R, core) => {
  const r0 = core * R
  return d <= r0 ? 1 : d >= R ? 0 : (R - d) / (R - r0)
}

// La brocha de una celda agregada (heat-cells.js): `brushAt` promediada sobre un corrimiento radial uniforme en [−s, s], que es
// cómo ve un px a los puntos de la celda repartidos alrededor de su centroide. Es la convolución de la rampa con una caja, en
// forma cerrada: con H la primitiva de clamp(t, 0, 1), vale 1 − w/(2s)·[H((d + s − r0)/w) − H((d − s − r0)/w)], con r0 = core·R
// y w = R − r0. Lejos de los quiebres (r0 y R) es la brocha misma; en ellos los suaviza en ±s, y el alcance llega a R + s, como
// el del punto más lejano de la celda. Sin ella, el borde de una región densa se corre hacia adentro hasta media celda.
//
// Por debajo de SPREAD_MIN_PX la dispersión no cambia la brocha en nada visible, y en float32 la resta de las dos primitivas
// se cancela: con s → 0 da 0·∞ y pintaría el quad entero. Un dieciseisavo de px cambia la brocha a lo sumo en s/(2w), menos
// de 1/400 con el desenfoque más chico que tiene sentido (w = 10 px).
export const SPREAD_MIN_PX = 1 / 16

// Mitad del ancho de una caja uniforme por desvío estándar: una caja de ancho 2s tiene varianza s²/3. Pasa la varianza de los
// puntos de una celda al s de `brushSpreadAt`.
export const BOX_HALF_PER_SIGMA = Math.sqrt(3)
const rampIntegral = t => (t <= 0 ? 0 : t <= 1 ? t * t / 2 : t - 0.5)
export const brushSpreadAt = (d, R, core, s) => {
  const r0 = core * R
  const w  = R - r0
  if (!(s >= SPREAD_MIN_PX) || !(w > 0)) return brushAt(d, R, core)
  if (d + s <= r0) return 1
  if (d - s >= R) return 0                // el redondeo de la fórmula dejaría ±1e-16 donde ya no llega ningún punto

  return 1 - w / (2 * s) * (rampIntegral((d + s - r0) / w) - rampIntegral((d - s - r0) / w))
}

// Aporte de un punto de peso normalizado `wn`: acotado a [MIN_OPACITY, 1].
export const contribution = (wn, intensity) => Math.min(Math.max(wn * intensity * POINT_ALPHA, MIN_OPACITY), 1)

// Rampa por defecto: transparente → azul → cian → verde → amarillo → rojo. Stops [t, [r,g,b,a]] en 0..1
// (el formato que `toRGBA` lee tal cual). Un consumidor puede pasar su propia `colorRamp(t)->rgba`.
export const DEFAULT_STOPS = [
  [0.00, [0.13, 0.20, 0.80, 0]],
  [0.35, [0.13, 0.20, 0.80, 1]],
  [0.55, [0.00, 0.80, 0.80, 1]],
  [0.70, [0.30, 0.85, 0.20, 1]],
  [0.85, [0.95, 0.85, 0.10, 1]],
  [1.00, [0.90, 0.10, 0.10, 1]],
]

const lerp = (a, b, u) => a + (b - a) * u

// Interpola la rampa de stops en `t`. Sólo corre al construir la paleta (GRAD_STEPS veces), nunca en el
// hot-path de redibujo → el array por llamada es inofensivo.
const interpStops = (stops, t) => {
  const x = t <= 0 ? 0 : t >= 1 ? 1 : t
  let i = 1
  while (i < stops.length && stops[i][0] < x) i++
  const [t0, c0] = stops[i - 1]
  const [t1, c1] = stops[Math.min(i, stops.length - 1)]
  const u = t1 > t0 ? (x - t0) / (t1 - t0) : 0
  return [lerp(c0[0], c1[0], u), lerp(c0[1], c1[1], u), lerp(c0[2], c1[2], u), lerp(c0[3], c1[3], u)]
}

export const defaultRamp = t => interpStops(DEFAULT_STOPS, t)

// Muestrea `ramp` en GRAD_STEPS pasos sobre `out` (Uint8ClampedArray(GRAD_STEPS*4)) y lo devuelve.
// `toRGBA` normaliza el retorno de la rampa (hex o [r,g,b,a] en 0..1) y se escala a 0..255. No es hot path.
export const samplePalette = (ramp, out) => {
  for (let i = 0; i < GRAD_STEPS; i++) {
    const [r, g, b, a] = toRGBA(ramp(i / (GRAD_STEPS - 1)))
    const o = i * 4
    out[o]     = r * 255
    out[o + 1] = g * 255
    out[o + 2] = b * 255
    out[o + 3] = a * 255
  }
  return out
}
