// Pruebas de src/camera/mat4.js: valores a mano y la inversa contra la identidad.
// Corre con: node --test test/camera/mat4.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { create, multiply, invert, perspective, ortho, fromPose, transform } from '../../src/camera/mat4.js'

const close = (a, b, tol, msg) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) <= tol, `${msg ?? ''}[${i}] ${v} ≠ ${b[i]}`))

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

test('create es la identidad en float64', () => {
  const m = create()
  assert.ok(m instanceof Float64Array)
  assert.deepEqual([...m], IDENTITY)
})

test('multiply: dos traslaciones suman y el orden es a · b', () => {
  const t = (x, y, z) => Float64Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1)
  const out = multiply(create(), t(1, 2, 3), t(10, 20, 30))
  assert.deepEqual([...out.slice(12)], [11, 22, 33, 1])

  // escala · traslación ≠ traslación · escala
  const s = Float64Array.of(2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1)
  assert.deepEqual([...multiply(create(), s, t(1, 1, 1)).slice(12)], [2, 2, 2, 1])
  assert.deepEqual([...multiply(create(), t(1, 1, 1), s).slice(12)], [1, 1, 1, 1])
})

test('multiply admite out igual a una entrada', () => {
  const a = Float64Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16)
  const b = Float64Array.of(2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0, 1, 1, 1, 1)
  const esperado = multiply(create(), a, b)
  multiply(a, a, b)
  assert.deepEqual([...a], [...esperado])
})

test('invert · multiply da la identidad a ≤ 1e-15 en una pose y en una proyección', () => {
  const view = fromPose(create(), [3, -4, 5], [0.5, 0.25, -1], [0, 1, 0])
  const proj = perspective(create(), 0.6435, 1.5, 1, 10)
  ;[view, proj].forEach(m => {
    const inv = invert(create(), m)
    close(multiply(create(), inv, m), IDENTITY, 1e-15, 'inv·m')
    close(multiply(create(), m, inv), IDENTITY, 1e-15, 'm·inv')
  })
})

test('invert · multiply de una vista-proyección con near/far muy separados, a ≤ 1e-12', () => {
  const view = fromPose(create(), [3, -4, 5], [0.5, 0.25, -1], [0, 1, 0])
  const vp   = multiply(create(), perspective(create(), 0.6435, 1.5, 0.01, 1000), view)
  close(multiply(create(), invert(create(), vp), vp), IDENTITY, 1e-12)
})

test('invert de una matriz singular devuelve null y no escribe en out', () => {
  const out = create()
  const sing = new Float64Array(16)
  assert.equal(invert(out, sing), null)
  assert.deepEqual([...out], IDENTITY)
})

test('perspective contra valores a mano (fovy 90°, aspect 2, near 1, far 3)', () => {
  const m = perspective(create(), Math.PI / 2, 2, 1, 3)
  close(m, [0.5, 0, 0, 0, 0, 1, 0, 0, 0, 0, -2, -1, 0, 0, -3, 0], 1e-15)
})

test('perspective con far infinito lleva near a -1 y se aleja a 1', () => {
  const m = perspective(create(), Math.PI / 2, 1, 1, Infinity)
  const out = new Float64Array(4)
  transform(out, m, 0, 0, -1, 1)
  assert.ok(Math.abs(out[2] / out[3] + 1) < 1e-15)
  transform(out, m, 0, 0, -1e9, 1)
  assert.ok(Math.abs(out[2] / out[3] - 1) < 1e-8)
})

test('ortho contra valores a mano y mapea sus esquinas a ±1', () => {
  const m = ortho(create(), 0, 200, 0, 100, 1, 11)
  close(m, [0.01, 0, 0, 0, 0, 0.02, 0, 0, 0, 0, -0.2, 0, -1, -1, -1.2, 1], 1e-15)
  const out = new Float64Array(4)
  transform(out, m, 200, 100, -11, 1)
  close(out, [1, 1, 1, 1], 1e-15)
  transform(out, m, 0, 0, -1, 1)
  close(out, [-1, -1, -1, 1], 1e-15)
})

test('fromPose: el ojo va al origen y el objetivo a -z a distancia', () => {
  const m = fromPose(create(), [1, 2, 3], [1, 2, -2], [0, 1, 0])
  const out = new Float64Array(4)
  transform(out, m, 1, 2, 3, 1)
  close(out, [0, 0, 0, 1], 1e-15, 'ojo')
  transform(out, m, 1, 2, -2, 1)
  close(out, [0, 0, -5, 1], 1e-15, 'objetivo')
})

test('fromPose: un up inclinado deja +y de la vista en el semiespacio de up', () => {
  const m = fromPose(create(), [0, 0, 10], [0, 0, 0], [0, 1, 0])
  close(m, IDENTITY.map((v, i) => (i === 14 ? -10 : v)), 1e-15)
})

test('fromPose degenerada (ojo en el objetivo o up paralelo) devuelve la identidad', () => {
  close(fromPose(create(), [1, 1, 1], [1, 1, 1], [0, 1, 0]), IDENTITY, 0)
  close(fromPose(create(), [0, 5, 0], [0, 0, 0], [0, 1, 0]), IDENTITY, 0)
})

test('transform contra la traslación a mano, con w', () => {
  const m = Float64Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 6, 7, 1)
  assert.deepEqual([...transform(new Float64Array(4), m, 1, 2, 3, 1)], [6, 8, 10, 1])
  assert.deepEqual([...transform(new Float64Array(4), m, 1, 2, 3, 0)], [1, 2, 3, 0])
})
