// Pruebas de src/projection/sphere.js: el gemelo de CPU de `sphereRel` contra la esfera directa.
// Corre con: node --test test/camera/sphere.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { sphereAnchor, sphereRel, KW, SERIES_LIMIT } from '../../src/projection/sphere.js'
import { projX0, projY0, unprojX0, unprojY0, WORLD0 } from '../../src/projection/mercator.js'
import { toUnitSphere } from '../../src/camera/geodesy.js'

// Lo que el gemelo puede apartarse de la esfera directa en float64: las dos salen de restar vectores de
// módulo 1 (1e-16) y la serie ya no deja resto (§3.2: los términos de más bajan el resto de 5e-11 a 1e-17).
const TOL_GEMELO = 1e-12

const LATS  = [0, 37, 60, 85]
// |d| y |dl| a ambos lados del límite de las series, en radianes.
const ANGULOS = [0, 0.01, 0.1, SERIES_LIMIT - 1e-9, SERIES_LIMIT + 1e-9, 0.5, 1, 2.5]

test('sphereAnchor da sin λ, cos λ, sech ψ y tanh ψ del ancla', () => {
  const a = new Float64Array(4)
  sphereAnchor(37, -70.6, a)
  const phi = 37 * Math.PI / 180, lam = -70.6 * Math.PI / 180
  const psi = Math.atanh(Math.sin(phi))
  ;[Math.sin(lam), Math.cos(lam), 1 / Math.cosh(psi), Math.tanh(psi)]
    .forEach((esperado, i) => assert.ok(Math.abs(a[i] - esperado) <= 1e-15, `[${i}] ${a[i]} ≠ ${esperado}`))
})

test('sphereAnchor acota la latitud a la de projY0', () => {
  const a = new Float64Array(4), b = new Float64Array(4)
  sphereAnchor(90, 10, a)
  sphereAnchor(85.0511287798, 10, b)
  assert.deepEqual([...a], [...b])
})

test('KW es la vuelta entera entre los px de world0', () => {
  assert.equal(KW, 2 * Math.PI / WORLD0)
})

// Compara sphereRel con la esfera directa en (ancla + rel); false si ese punto cae fuera del mundo, donde
// projY0 acota y ya no es el mismo.
const contraDirecta = (lat, lng, relX, relY, atrig, ctx) => {
  const y0 = projY0(lat) + relY
  if (y0 < 0 || y0 > WORLD0) return 0
  toUnitSphere(unprojY0(y0), unprojX0(projX0(lng) + relX), ctx.b)
  sphereRel(relX, relY, atrig, 0, 0, 0, ctx.out)
  let peor = 0
  for (let i = 0; i < 3; i++) peor = Math.max(peor, Math.abs(ctx.out[i] - (ctx.b[i] - ctx.a[i])))
  return peor
}

test('sphereRel = esfera(ancla + rel) − esfera(ancla) en float64 directo, ≤ TOL_GEMELO, con |d| y |dl| a ambos lados del límite', () => {
  const atrig = new Float64Array(4)
  const ctx = { a: new Float64Array(3), b: new Float64Array(3), out: new Float64Array(3) }
  let peor = 0, casos = 0
  for (const lat of LATS) for (const lng of [-70.6, 179.5]) {
    sphereAnchor(lat, lng, atrig)
    toUnitSphere(lat, lng, ctx.a)
    for (const d of ANGULOS) for (const dl of ANGULOS) for (const sd of [1, -1]) for (const sl of [1, -1]) {
      peor = Math.max(peor, contraDirecta(lat, lng, sl * dl / KW, sd * d / KW, atrig, ctx))
      casos++
    }
  }
  assert.ok(casos > 1000, `sólo ${casos} casos`)
  assert.ok(peor <= TOL_GEMELO, `error ${peor} > ${TOL_GEMELO}`)
})

test('sphereRel a zoom 0 a 18: rel de unos px de pantalla, de uno a 2000 px', () => {
  const atrig = new Float64Array(4)
  const ctx = { a: new Float64Array(3), b: new Float64Array(3), out: new Float64Array(3) }
  let peor = 0
  for (const lat of LATS) for (let zoom = 0; zoom <= 18; zoom++) {
    sphereAnchor(lat, -70.6, atrig)
    toUnitSphere(lat, -70.6, ctx.a)
    for (const px of [1, 37.5, 400, 2000]) for (const sx of [1, -1]) for (const sy of [1, -1])
      peor = Math.max(peor, contraDirecta(lat, -70.6, sx * px / 2 ** zoom, sy * px * 0.75 / 2 ** zoom, atrig, ctx))
  }
  assert.ok(peor <= TOL_GEMELO, `error ${peor} > ${TOL_GEMELO}`)
})

test('sphereRel suma sa: devuelve esfera(ancla + rel) − rtc', () => {
  const atrig = new Float64Array(4), out = new Float64Array(3), s0 = new Float64Array(3), s1 = new Float64Array(3)
  sphereAnchor(-33.45, -70.6, atrig)
  toUnitSphere(-33.45, -70.6, s0)
  const rtc = [0.1, -0.2, 0.3]
  const sa  = [s0[0] - rtc[0], s0[1] - rtc[1], s0[2] - rtc[2]]
  const relX = 3.5, relY = -2.25
  toUnitSphere(unprojY0(projY0(-33.45) + relY), unprojX0(projX0(-70.6) + relX), s1)
  sphereRel(relX, relY, atrig, sa[0], sa[1], sa[2], out)
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(out[i] - (s1[i] - rtc[i])) <= TOL_GEMELO, `[${i}]`)
})

test('sphereRel con rel 0 devuelve sa', () => {
  const atrig = new Float64Array(4), out = new Float64Array(3)
  sphereAnchor(10, 20, atrig)
  sphereRel(0, 0, atrig, 0.25, -0.5, 0.75, out)
  assert.deepEqual([...out], [0.25, -0.5, 0.75])
})

test('sphereRel escribe en out y lo devuelve', () => {
  const atrig = sphereAnchor(0, 0, new Float64Array(4)), out = new Float64Array(3)
  assert.equal(sphereRel(1, 1, atrig, 0, 0, 0, out), out)
})
