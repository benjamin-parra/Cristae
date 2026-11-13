// La agregación del calor en celdas (heat-cells.js), sin GL. Lo que se fija:
//   · la suma de los aportes y la de los puntos se conservan, celda por celda y en total;
//   · la muestra va al centroide ponderado por el aporte, no al centro de la celda;
//   · la grilla es del mundo: no depende del ancla, y en el nivel L una celda mide N/2^L de world0;
//   · el aporte de cada punto es el del shader, acotado por punto antes de sumar;
//   · si las celdas pasan de MAX_CELL_RATIO de los puntos no agrega, y los puntos fuera del mundo no entran;
//   · el nivel es ⌈zoom⌉ y la celda no pasa de CELL_PX ni de R·CELL_PER_RADIUS.
// Corre con: node --test test/render/heat-cells.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HeatCells, CELL_FLOATS, CELL_PX, CELL_PER_RADIUS, MAX_CELL_RATIO, aggregationLevel, cellSize } from '../../src/render/heat-cells.js'
import { contribution, MIN_OPACITY } from '../../src/render/heat-math.js'

// Un espejo como el de HeatLayer: [x, y, peso normalizado] por punto, relativo al ancla.
const espejo = (puntos, ax, ay) => {
  const m = new Float32Array(puntos.length * 3)
  puntos.forEach(([x, y, w], i) => { m[i * 3] = x - ax; m[i * 3 + 1] = y - ay; m[i * 3 + 2] = w })
  return m
}

const celdas = hc => Array.from({ length: hc.count }, (_, k) => {
  const o = k * CELL_FLOATS
  return { x: hc.out[o], y: hc.out[o + 1], c: hc.out[o + 2], n: hc.out[o + 3] }
})

// Nivel 8 y celdas de 8 px: una celda mide 8 / 2^8 = 1/32 de px de world0.
const NIVEL = 8
const LADO  = CELL_PX / 2 ** NIVEL

test('la suma de aportes y la de puntos se conservan', () => {
  const puntos = []
  for (let i = 0; i < 400; i++) puntos.push([100 + (i % 20) * LADO * 0.3, 80 + Math.floor(i / 20) * LADO * 0.3, (i % 7) / 6])
  const hc = new HeatCells()
  const n = hc.build(espejo(puntos, 100, 80), puntos.length, 100, 80, NIVEL, CELL_PX, 1.5)
  assert.ok(n > 0 && n < puntos.length * MAX_CELL_RATIO, `agrega: ${n} celdas`)
  const cs = celdas(hc)
  const sumaC = cs.reduce((s, c) => s + c.c * c.n, 0)
  const ideal = puntos.reduce((s, [, , w]) => s + contribution(Math.fround(w), 1.5), 0)
  assert.ok(Math.abs(sumaC - ideal) < 1e-4, `Σ n·c̄ = ${sumaC}, Σ c = ${ideal}`)
  assert.equal(cs.reduce((s, c) => s + c.n, 0), puntos.length)
})

test('el aporte se acota por punto antes de sumar: peso 0 aporta MIN_OPACITY, no 0', () => {
  const hc = new HeatCells()
  const x0 = 10 * LADO + LADO / 2
  const puntos = [[x0, x0, 0], [x0, x0, 0], [x0, x0, 1], [x0 + 5, x0, 1], [x0 + 5, x0, 1]]
  hc.build(espejo(puntos, 0, 0), puntos.length, 0, 0, NIVEL, CELL_PX, 1)
  const [primera] = celdas(hc)
  assert.equal(primera.n, 3)
  assert.ok(Math.abs(primera.c - (2 * MIN_OPACITY + contribution(1, 1)) / 3) < 1e-7, `c̄ = ${primera.c}`)
})

test('la muestra va al centroide ponderado por el aporte, no al centro de la celda', () => {
  const hc = new HeatCells()
  const ix = 3200, iy = 1700                       // una celda del nivel 8
  const en = (fx, fy) => [(ix + fx) * LADO, (iy + fy) * LADO]
  // Dos puntos en la misma celda: uno pesado en (0,1; 0,1) y uno de peso 0 en (0,9; 0,9) de la celda. Más dos lejos, para
  // que la proporción de celdas no corte.
  const puntos = [[...en(0.1, 0.1), 1], [...en(0.9, 0.9), 0], [...en(40.5, 0.5), 1], [...en(40.5, 0.6), 1]]
  const ax = 99.9, ay = 53.2
  hc.build(espejo(puntos, ax, ay), puntos.length, ax, ay, NIVEL, CELL_PX, 1)
  const cs = celdas(hc)
  const c1 = contribution(1, 1), c0 = contribution(0, 1)
  const fx = (c1 * 0.1 + c0 * 0.9) / (c1 + c0)
  const [esperadoX, esperadoY] = en(fx, fx)
  const celda = cs.find(c => c.n === 2 && Math.abs(c.x + ax - esperadoX) < LADO)
  assert.ok(celda, 'la celda de los dos puntos')
  assert.ok(Math.abs(celda.x + ax - esperadoX) < 1e-5 && Math.abs(celda.y + ay - esperadoY) < 1e-5,
    `centroide (${celda.x + ax}, ${celda.y + ay}) contra (${esperadoX}, ${esperadoY})`)
  const centro = en(0.5, 0.5)
  assert.ok(Math.abs(celda.x + ax - centro[0]) > LADO * 0.1, 'no es el centro geométrico')
})

test('la grilla es del mundo: dos anclas dan las mismas celdas, y el nivel siguiente parte cada una en cuatro', () => {
  const puntos = []
  for (let i = 0; i < 64; i++) puntos.push([50 + (i % 8 + 0.5) * LADO / 2, 50 + (Math.floor(i / 8) + 0.5) * LADO / 2, 1])
  const a = new HeatCells(), b = new HeatCells()
  a.build(espejo(puntos, 50, 50), puntos.length, 50, 50, NIVEL, CELL_PX, 1)
  b.build(espejo(puntos, 49.3, 51.7), puntos.length, 49.3, 51.7, NIVEL, CELL_PX, 1)
  const abs = (hc, ax, ay) => celdas(hc).map(c => [+(c.x + ax).toFixed(4), +(c.y + ay).toFixed(4), c.n]).sort((p, q) => p[0] - q[0] || p[1] - q[1])
  assert.deepEqual(abs(a, 50, 50), abs(b, 49.3, 51.7))
  assert.equal(a.count, 16, 'medio lado por punto: 4 puntos por celda')
  const c = new HeatCells()
  assert.equal(c.build(espejo(puntos, 50, 50), puntos.length, 50, 50, NIVEL + 1, CELL_PX, 1), 0, 'un punto por celda: no paga')
  c.build(espejo(puntos, 50, 50), puntos.length, 50, 50, NIVEL - 1, CELL_PX, 1)
  assert.equal(c.count, 4, 'el nivel anterior junta cuatro celdas en una')
})

test('con más celdas que MAX_CELL_RATIO de los puntos no agrega', () => {
  const puntos = Array.from({ length: 100 }, (_, i) => [10 + i * LADO * 3, 10, 1])
  const hc = new HeatCells()
  assert.equal(hc.build(espejo(puntos, 10, 10), puntos.length, 10, 10, NIVEL, CELL_PX, 1), 0)
  assert.equal(hc.count, 0)
  const juntos = Array.from({ length: 100 }, (_, i) => [10 + (i % 50) * LADO * 3, 10, 1])
  assert.equal(hc.build(espejo(juntos, 10, 10), juntos.length, 10, 10, NIVEL, CELL_PX, 1), 50, 'justo en la proporción, sí')
})

test('un punto fuera del mundo no entra en ninguna celda', () => {
  const puntos = [[20, 20, 1], [20, 20, 1], [20, 20, 1], [20, -Infinity, 1]]
  const hc = new HeatCells()
  hc.build(espejo(puntos, 20, 20), puntos.length, 20, 20, NIVEL, CELL_PX, 1)
  assert.deepEqual(celdas(hc).map(c => c.n), [3])
})

test('un nivel cuyo índice no cabe en un Int32 no agrega', () => {
  const puntos = Array.from({ length: 10 }, () => [128, 128, 1])
  assert.equal(new HeatCells().build(espejo(puntos, 128, 128), 10, 128, 128, 26, CELL_PX, 1), 0)
  assert.ok(new HeatCells().build(espejo(puntos, 128, 128), 10, 128, 128, 25, CELL_PX, 1) > 0)
})

test('los arreglos se reusan: una segunda pasada igual no asigna', () => {
  const puntos = Array.from({ length: 5000 }, (_, i) => [100 + (i % 70) * LADO / 3, 100 + Math.floor(i / 70) * LADO / 3, 1])
  const m = espejo(puntos, 100, 100)
  const hc = new HeatCells()
  hc.build(m, puntos.length, 100, 100, NIVEL, CELL_PX, 1)
  const out = hc.out
  hc.build(m, puntos.length, 100, 100, NIVEL, CELL_PX, 1)
  assert.equal(hc.out, out)
})

test('el nivel es ⌈zoom⌉, y un entero con ruido de coma flotante no salta', () => {
  assert.equal(aggregationLevel(10), 10)
  assert.equal(aggregationLevel(10 + 1e-12), 10)
  assert.equal(aggregationLevel(10.001), 11)
  assert.equal(aggregationLevel(10.999), 11)
})

test('la celda no pasa de CELL_PX ni de R·CELL_PER_RADIUS', () => {
  assert.equal(cellSize(1000), CELL_PX)
  assert.equal(cellSize(CELL_PX / CELL_PER_RADIUS), CELL_PX)
  assert.equal(cellSize(10), 10 * CELL_PER_RADIUS)
  assert.equal(cellSize(0), 0)
})

test('la covarianza de una celda es la de sus puntos ponderada por el aporte, en px² de world0', () => {
  const hc = new HeatCells()
  const ix = 3000, iy = 1500
  // Cuatro puntos de igual aporte sobre la diagonal de la celda: varianza por eje 0,05 celda² y covarianza igual (correlación 1).
  const puntos = [[0.2, 0.2], [0.4, 0.4], [0.6, 0.6], [0.8, 0.8]].map(([fx, fy]) => [(ix + fx) * LADO, (iy + fy) * LADO, 1])
  puntos.push([(ix + 40.5) * LADO, (iy + 0.5) * LADO, 1], [(ix + 40.5) * LADO, (iy + 0.5) * LADO, 1])
  hc.build(espejo(puntos, 93.7, 46.8), puntos.length, 93.7, 46.8, NIVEL, CELL_PX, 1)
  const o = Array.from({ length: hc.count }, (_, k) => k * CELL_FLOATS)
  const cuadrado = o.find(i => hc.out[i + 3] === 4)
  const juntos   = o.find(i => hc.out[i + 3] === 2)
  const v = 0.05 * LADO * LADO
  ;[4, 5, 6].forEach(j => assert.ok(Math.abs(hc.out[cuadrado + j] - v) < v * 1e-4, `covarianza[${j - 4}] = ${hc.out[cuadrado + j]}, esperada ${v}`))
  assert.deepEqual([4, 5, 6].map(j => hc.out[juntos + j]), [0, 0, 0], 'puntos coincidentes: sin dispersión')
})
