// Gemelo en float64 de `sphereRel` del preludio de la variante `sphere`: la esfera unidad de un punto dado
// por su world0 relativo a un ancla, menos un origen `rtc`, calculada por diferencias y no sobre el
// absoluto. Sirve a la cámara de CPU y fija, contra la esfera directa, las fórmulas que el shader repite
// en float32. Sólo t = 1: la mezcla con el plano y la cesión no están aquí. Cada función escribe en `out`.
//
// Marco de la esfera unidad: el de `toUnitSphere` (camera/geodesy.js). La latitud entra por la coordenada
// de Mercator ψ = atanh(sin φ), la que mide world0 en y, de modo que cos φ = sech ψ y sin φ = tanh ψ.
import { MAXLAT, WORLD0 } from './mercator.js'

const D = Math.PI / 180

// Radianes por px world0: la vuelta entera, 2π, reparte los 256 px del mundo a zoom 0.
export const KW = 2 * Math.PI / WORLD0

// Bajo este ángulo (rad) el seno y el coseno hiperbólicos y circulares salen de series de Taylor y no de la
// función de la librería, que pierde el delta pequeño. Origen: a 0,3 rad el resto de la serie de `TERMS`
// términos (x^14/14! ≈ 5e-19) queda bajo el redondeo de float64, y por encima la función de la librería
// ya no pierde cifras.
export const SERIES_LIMIT = 0.3

// Las series llegan a x^13 y x^12, no a x^7 y x^8 como en el preludio: en float32 el resto de esas series
// (x^9/9! = 5e-11 en 0,3) cae bajo el redondeo, pero en float64 es 50 veces mayor que la tolerancia del
// gemelo. Con los términos de más el resto baja de 1e-16, y las fórmulas y las ramas siguen siendo las mismas.
// Los coeficientes salen de los factoriales (exactos en float64 hasta 18!) y el Horner es un bucle, no una
// cadena de términos escrita a mano: así la función es lo bastante corta para que V8 la inline en quien la
// llama, y los números no se encajonan al cruzar la llamada.
const TERMS = 7

const factorial = n => n < 2 ? 1 : n * factorial(n - 1)
const series    = (first, sign) => Float64Array.from({ length: TERMS }, (_, k) => sign ** k / factorial(2 * k + first))

const SINH  = series(1, 1)    // sinh x = x · Σ x^2k / (2k + 1)!
const COSH1 = series(2, 1)    // cosh x − 1 = x² · Σ x^2k / (2k + 2)!
const SIN   = series(1, -1)   // sin x = x · Σ (−1)^k x^2k / (2k + 1)!
const COS1  = series(2, -1)   // cos x − 1 = −x² · Σ (−1)^k x^2k / (2k + 2)!


// out4 = [sin λa, cos λa, sech ψa, tanh ψa] del ancla. La latitud se acota a ±MAXLAT, como `projY0`, para que
// el ancla sea la del mismo world0 con que se miden los rel.
export const sphereAnchor = (lat, lng, out4) => {
  const phi = (lat > MAXLAT ? MAXLAT : lat < -MAXLAT ? -MAXLAT : lat) * D
  const lam = lng * D
  out4[0] = Math.sin(lam)
  out4[1] = Math.cos(lam)
  out4[2] = Math.cos(phi)
  out4[3] = Math.sin(phi)
  return out4
}

// out3 = esfera(ancla + rel) − rtc, con rel = [relX, relY] en px world0 (y hacia el sur, como projY0), `atrig`
// la salida de `sphereAnchor` y sa = [x, y, z] = esfera(ancla) − rtc. Es el cuerpo de `sphereRel`, con todo
// lo que cruza la llamada en arreglos: un número que pasa a una función que V8 no inlinea se encajona, y
// con esta firma la cámara no asigna aunque la función quede fuera de línea.
export const sphereRelInto = (rel, atrig, sa, out3) => {
  const dl = rel[0] * KW
  const d  = -rel[1] * KW

  let sh, chm1, th   // sinh d, cosh d − 1, tanh d
  if (Math.abs(d) < SERIES_LIMIT) {
    const d2 = d * d
    let s = 0, c = 0
    for (let k = TERMS - 1; k >= 0; k--) {
      s = s * d2 + SINH[k]
      c = c * d2 + COSH1[k]
    }
    sh   = d * s
    chm1 = d2 * c
    th   = sh / (1 + chm1)
  } else {
    sh   = Math.sinh(d)
    chm1 = Math.cosh(d) - 1
    th   = Math.tanh(d)
  }

  const sl = atrig[0], cl = atrig[1], ca = atrig[2], ta = atrig[3]
  const g   = 1 / (1 + chm1 + ta * sh)
  const gm1 = -(chm1 + ta * sh) * g

  let sdl, cdlm1   // sin dl y cos dl − 1
  if (Math.abs(dl) < SERIES_LIMIT) {
    const e2 = dl * dl
    let s = 0, c = 0
    for (let k = TERMS - 1; k >= 0; k--) {
      s = s * e2 + SIN[k]
      c = c * e2 + COS1[k]
    }
    sdl   = dl * s
    cdlm1 = -e2 * c
  } else {
    const hs = Math.sin(0.5 * dl)
    sdl   = Math.sin(dl)
    cdlm1 = -2 * hs * hs
  }

  const gcm1 = gm1 * (1 + cdlm1) + cdlm1
  out3[0] = sa[0] + ca * (sl * gcm1 + g * cl * sdl)
  out3[1] = sa[1] + th * ca * ca / (1 + ta * th)
  out3[2] = sa[2] + ca * (cl * gcm1 - g * sl * sdl)
  return out3
}

const REL = new Float64Array(2)
const SA  = new Float64Array(3)

// out3 = esfera(ancla + rel) − rtc, con (relX, relY) en px world0 (y hacia el sur, como projY0), `atrig` la
// salida de `sphereAnchor` y (sax, say, saz) = esfera(ancla) − rtc: la firma de la función del preludio.
export const sphereRel = (relX, relY, atrig, sax, say, saz, out3) => {
  REL[0] = relX
  REL[1] = relY
  SA[0]  = sax
  SA[1]  = say
  SA[2]  = saz
  return sphereRelInto(REL, atrig, SA, out3)
}
