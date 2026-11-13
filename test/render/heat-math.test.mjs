// Contrato de heat-math: matemática pura del calor (constantes, brocha, aporte, rampa y paleta).
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_RADIUS, DEFAULT_BLUR, DEFAULT_INTENSITY, POINT_ALPHA, MIN_OPACITY, GRAD_STEPS, CORE_MAX, TERM_CAP, TERM_FLOOR,
  nonNeg, brushCore, brushAt, brushSpreadAt, SPREAD_MIN_PX, contribution, DEFAULT_STOPS, defaultRamp, samplePalette,
} from '../../src/render/heat-math.js'

test('constantes: los valores de hoy', () => {
  assert.deepEqual([DEFAULT_RADIUS, DEFAULT_BLUR, DEFAULT_INTENSITY], [25, 15, 1])
  assert.deepEqual([POINT_ALPHA, MIN_OPACITY, GRAD_STEPS, CORE_MAX], [0.12, 0.05, 256, 0.99])
})

test('nonNeg: null toma el default y lo negativo se acota a 0', () => {
  assert.equal(nonNeg(null, 7), 7)
  assert.equal(nonNeg(undefined, 7), 7)
  assert.equal(nonNeg(-3, 7), 0)
  assert.equal(nonNeg(4, 7), 4)
})

test('brushCore: fracción del núcleo, tope 0,99, blur 0 en cono y R = 0 sin pintar', () => {
  assert.equal(brushCore(25, 15), 25 / 40)
  assert.equal(brushCore(1000, 1), CORE_MAX)
  assert.equal(brushCore(25, 0), 0)
  assert.equal(brushCore(0, 0), 0)
  assert.equal(brushCore(0, 10), 0)
})

test('brushAt: 1 en el núcleo, lineal a 0 en R; blur 0 es un cono de radio `radius`', () => {
  const R = 40
  const core = brushCore(25, 15)
  assert.equal(brushAt(0, R, core), 1)
  assert.equal(brushAt(25, R, core), 1)
  assert.equal(brushAt(32.5, R, core), 0.5)
  assert.equal(brushAt(40, R, core), 0)
  assert.equal(brushAt(99, R, core), 0)
  assert.equal(brushAt(10, 20, brushCore(20, 0)), 0.5)
  assert.equal(brushAt(0, 20, brushCore(20, 0)), 1)
  assert.equal(brushAt(0, 0, brushCore(0, 0)), 1, 'con R = 0 el alcance es nulo: el culling lo descarta antes')
})

test('contribution: clamp a [MIN_OPACITY, 1]', () => {
  assert.equal(contribution(1, 1), POINT_ALPHA)
  assert.equal(contribution(0, 1), MIN_OPACITY)
  assert.equal(contribution(0.1, 1), MIN_OPACITY)
  assert.equal(contribution(1, 100), 1)
  assert.equal(contribution(0.5, 2), POINT_ALPHA)
})

test('TERM_CAP: un aporte saturado da índice 255 y evita el -ln(0)', () => {
  assert.equal(-Math.log(1 - 1 * 1), Infinity)
  const S = -Math.log(Math.max(1 - 1 * 1, TERM_FLOOR))
  assert.equal(S, TERM_CAP, 'el argumento acotado da el tope sin pasar por log(0)')
  assert.equal(Math.round((1 - Math.exp(-S)) * 255), 255)
  assert.ok(255 * Math.exp(-TERM_CAP) <= 0.25 + 1e-12, 'el alfa queda a un cuarto de nivel de 1')
})

test('rampa por defecto: extremos y stops', () => {
  assert.deepEqual(defaultRamp(0), DEFAULT_STOPS[0][1])
  defaultRamp(1).forEach((v, i) => assert.ok(Math.abs(v - DEFAULT_STOPS.at(-1)[1][i]) < 1e-12))
  assert.deepEqual(defaultRamp(-5), defaultRamp(0))
  assert.deepEqual(defaultRamp(0.35), DEFAULT_STOPS[1][1])
})

test('samplePalette: llama a la rampa GRAD_STEPS veces y escribe en `out`', () => {
  const ts  = []
  const out = new Uint8ClampedArray(GRAD_STEPS * 4)
  const ret = samplePalette(t => (ts.push(t), [1, 0.5, 0, t]), out)
  assert.equal(ret, out)
  assert.equal(ts.length, GRAD_STEPS)
  assert.equal(ts[0], 0)
  assert.equal(ts.at(-1), 1)
  assert.deepEqual([...out.subarray(0, 4)], [255, 128, 0, 0])
  assert.deepEqual([...out.subarray(-4)], [255, 128, 0, 255])
})

test('brushSpreadAt: la brocha promediada en ±s, igual a la integral numérica, y con s = 0 la brocha misma', () => {
  const R = 40
  const core = brushCore(25, 15)
  const PASOS = 20_000
  const promedio = (d, s) => {
    let suma = 0
    for (let i = 0; i < PASOS; i++) suma += brushAt(d - s + (i + 0.5) / PASOS * 2 * s, R, core)
    return suma / PASOS
  }
  for (const s of [0.5, 3, 7])
    for (const d of [0, 20, 24, 25, 27, 32.5, 38, 40, 42, 46])
      assert.ok(Math.abs(brushSpreadAt(d, R, core, s) - promedio(d, s)) < 1e-6, `d = ${d}, s = ${s}: ${brushSpreadAt(d, R, core, s)} contra ${promedio(d, s)}`)
  assert.equal(brushSpreadAt(33, R, core, 0), brushAt(33, R, core))
  assert.equal(brushSpreadAt(39.99, R, core, SPREAD_MIN_PX / 2), brushAt(39.99, R, core), 'bajo SPREAD_MIN_PX, la brocha sin promediar')
  assert.ok(Math.abs(brushSpreadAt(32.5, R, core, 4) - 0.5) < 1e-12, 'lejos de los quiebres es la rampa misma')
  assert.equal(brushSpreadAt(R + 3, R, core, 3), 0, 'el alcance es R + s')
  assert.ok(brushSpreadAt(R + 1, R, core, 3) > 0)
})
