// La agregación del calor en celdas (heat-cells.js), sin GL. Lo que se fija:
//   · la suma de los aportes y la de los puntos se conservan, celda por celda y en total;
//   · la muestra va al centroide ponderado por el aporte, no al centro de la celda;
//   · la grilla es del mundo: no depende del ancla, y en el nivel L una celda mide N/2^L de world0;
//   · el aporte de cada punto es el del shader, acotado por punto antes de sumar;
//   · si las celdas pasan de MAX_CELL_RATIO de los puntos no agrega, y los puntos fuera del mundo no entran;
//   · el nivel es ⌈zoom·LEVEL_STEPS⌉/LEVEL_STEPS y la celda no pasa de CELL_PX ni de R·CELL_PER_RADIUS;
//   · un punto caliente (aporte ≥ HOT_CONTRIBUTION) no entra en una celda: va solo, en su sitio y con su aporte;
//   · el umbral sigue a n·R²;
//   · una celda pesada (aportes que suman más de HEAVY_CONTRIBUTION) se parte en celdas de 1/2^SPLIT_LEVELS de lado;
//   · desde SAMPLE_MIN_POINTS una muestra corta la pasada que no va a pagar, con la estimación exacta para celdas de 1 y 2 puntos.
// Corre con: node --test test/render/heat-cells.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  HeatCells, CELL_FLOATS, CELL_PX, CELL_PER_RADIUS, MAX_CELL_RATIO, HOT_CONTRIBUTION, AGGREGATE_MIN_POINTS, AGGREGATE_REF_RADIUS,
  LEVEL_STEPS, HEAVY_CONTRIBUTION, SPLIT_LEVELS, SAMPLE_MIN_POINTS, SAMPLE_STRIDE, SAMPLE_MARGIN, aggregates, aggregationLevel, cellSize, estimatedCells,
} from '../../src/render/heat-cells.js'
import { contribution, MIN_OPACITY, POINT_ALPHA } from '../../src/render/heat-math.js'

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

test('un punto más allá de la proporción no agrega: 51 celdas de 100 puntos son demasiadas, 50 no', () => {
  const hc = new HeatCells()
  const con = celdasDistintas => Array.from({ length: 100 }, (_, i) => [10 + (i % celdasDistintas) * LADO * 3, 10, 1])
  assert.equal(hc.build(espejo(con(51), 10, 10), 100, 10, 10, NIVEL, CELL_PX, 1), 0)
  assert.equal(hc.count, 0)
  assert.equal(hc.build(espejo(con(50), 10, 10), 100, 10, 10, NIVEL, CELL_PX, 1), 50)
  assert.ok(hc.out.subarray(0, 50 * CELL_FLOATS).every(Number.isFinite), 'ninguna celda sin definir')
})

test('los arreglos de celdas no pasan del tope de MAX_CELL_RATIO: la memoria queda acotada a n/2', () => {
  const n = 3000
  const puntos = Array.from({ length: n }, (_, i) => [10 + (i % 1500) * LADO * 3, 10, 1])
  const hc = new HeatCells()
  assert.equal(hc.build(espejo(puntos, 10, 10), n, 10, 10, NIVEL, CELL_PX, 1), 1500)
  assert.ok(hc.out.length <= Math.floor(n * MAX_CELL_RATIO) * CELL_FLOATS, `${hc.out.length} floats para 1.500 celdas`)
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
  // Con los puntos cerca del origen el índice de cada uno cabe, pero el del extremo del mundo no: no agrega igual.
  const cerca = Array.from({ length: 10 }, () => [1, 1, 1])
  assert.equal(new HeatCells().build(espejo(cerca, 1, 1), 10, 1, 1, 26, CELL_PX, 1), 0)
  assert.equal(new HeatCells().build(espejo(cerca, 1, 1), 10, 1, 1, 25, CELL_PX, 1), 1)
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

test('el nivel es ⌈zoom⌉ de a cuarto, un entero cae en su nivel de siempre y uno con ruido de coma flotante no salta', () => {
  assert.equal(LEVEL_STEPS, 4)
  assert.equal(aggregationLevel(10), 10)
  assert.equal(aggregationLevel(10 + 1e-12), 10)
  assert.equal(aggregationLevel(10.001), 10.25)
  assert.equal(aggregationLevel(10.25), 10.25)
  assert.equal(aggregationLevel(10.26), 10.5)
  assert.equal(aggregationLevel(10.999), 11)
  // La celda en pantalla mide N·2^(zoom − L): entre 2^(−1/4)·N y N, nunca más.
  for (let z = 9; z < 12; z += 0.013) {
    const lado = 2 ** (z - aggregationLevel(z))
    assert.ok(lado <= 1 && lado > 2 ** (-1 / LEVEL_STEPS), `zoom ${z}: ${lado}`)
  }
})

test('el umbral sigue a n·R²: AGGREGATE_MIN_POINTS con el radio de referencia, menos con uno grande y más con uno chico', () => {
  assert.equal(aggregates(AGGREGATE_MIN_POINTS - 1, AGGREGATE_REF_RADIUS), false)
  assert.equal(aggregates(AGGREGATE_MIN_POINTS, AGGREGATE_REF_RADIUS), true)
  assert.equal(aggregates(4_999, 80), false)
  assert.equal(aggregates(5_000, 80), true, 'R = 80: un cuarto')
  assert.equal(aggregates(189_349, 13), false)
  assert.equal(aggregates(189_350, 13), true, 'R = 13: (40/13)² veces')
  assert.equal(aggregates(1e9, 0), false, 'sin radio no hay relleno que ahorrar')
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

test('la covarianza es por eje: puntos alineados en x no dan varianza en y, y al revés', () => {
  const ix = 3000, iy = 1500
  const ejeX = [0.1, 0.3, 0.5, 0.7, 0.9].map(f => [(ix + f) * LADO, (iy + 0.5) * LADO, 1])
  const ejeY = [0.1, 0.3, 0.5, 0.7, 0.9].map(f => [(ix + 0.5) * LADO, (iy + f) * LADO, 1])
  for (const [puntos, xx, yy] of [[ejeX, true, false], [ejeY, false, true]]) {
    const hc = new HeatCells()
    hc.build(espejo(puntos, 93.7, 46.8), puntos.length, 93.7, 46.8, NIVEL, CELL_PX, 1)
    const cero = 1e-9 * LADO * LADO
    assert.equal(hc.out[4] > cero, xx, `xx = ${hc.out[4]}`)
    assert.equal(hc.out[5] > cero, yy, `yy = ${hc.out[5]}`)
    assert.ok(Math.abs(hc.out[6]) < cero, `xy = ${hc.out[6]}`)
  }
})

test('la varianza de puntos coincidentes nunca sale negativa por redondeo', () => {
  const hc = new HeatCells()
  let peor = 0
  for (let k = 0; k < 400; k++) {
    const x = 3000.137 + k * 0.00317, y = 1500.291 + k * 0.00211
    const puntos = Array.from({ length: 7 }, (_, i) => [(x + (k % 3) * 1e-9) * LADO, (y + i * 0) * LADO, (i % 5 + 1) / 5])
    hc.build(espejo(puntos, 93.7, 46.8), 7, 93.7, 46.8, NIVEL, CELL_PX, 1.37)
    peor = Math.min(peor, hc.out[4], hc.out[5])
  }
  assert.ok(peor >= 0, `varianza ${peor}`)
})

test('un punto caliente va solo, en su sitio y con su aporte; los fríos de su celda forman la celda', () => {
  const ix = 3000, iy = 1500
  const en = (fx, fy, w) => [(ix + fx) * LADO, (iy + fy) * LADO, w]
  const frios  = [[0.8, 0.8], [0.3, 0.7], [0.6, 0.4], [0.1, 0.9], [0.5, 0.5], [0.7, 0.2], [0.4, 0.6]].map(([fx, fy]) => en(fx, fy, 0.02))
  const puntos = [en(0.2, 0.2, 1), ...frios, en(40.5, 0.5, 1), en(40.5, 0.5, 1)]
  const ax = 93.7, ay = 46.8
  const hc = new HeatCells()
  // Con intensity 8 los de peso pleno aportan 0,96: tres calientes y una celda de siete fríos.
  assert.ok(contribution(1, 8) >= HOT_CONTRIBUTION && contribution(0.02, 8) < HOT_CONTRIBUTION)
  const m = espejo(puntos, ax, ay)
  assert.equal(hc.build(m, puntos.length, ax, ay, NIVEL, CELL_PX, 8), 4)
  assert.equal(hc.cells, 1, 'una celda')
  const cs = celdas(hc)
  assert.deepEqual(cs.map(c => c.n), [7, 1, 1, 1])
  assert.ok(Math.abs(cs[0].c - MIN_OPACITY) < 1e-7, 'la celda fría conserva su aporte')
  ;[0, 8, 9].forEach((i, k) => {
    const o = (k + 1) * CELL_FLOATS
    assert.deepEqual([hc.out[o], hc.out[o + 1]], [m[i * 3], m[i * 3 + 1]], `el caliente ${i} en su sitio exacto del espejo`)
    assert.equal(hc.out[o + 2], Math.fround(contribution(1, 8)))
    assert.deepEqual([...hc.out.subarray(o + 4, o + 7)], [0, 0, 0], 'sin dispersión')
  })
  // Con intensity 4 (aporte 0,48) nada es caliente: dos celdas, como siempre.
  assert.equal(hc.build(m, puntos.length, ax, ay, NIVEL, CELL_PX, 4), 2)
  assert.deepEqual(celdas(hc).map(c => c.n).sort(), [2, 8])
})

test('los calientes cuentan en la proporción: 51 calientes de 100 puntos no agregan, 50 sí', () => {
  const ix = 3000, iy = 1500
  const con = calientes => Array.from({ length: 100 }, (_, i) => [(ix + (i < calientes ? 3 * i : 0.5)) * LADO, (iy + 0.5) * LADO, i < calientes ? 1 : 0])
  const hc = new HeatCells()
  assert.equal(hc.build(espejo(con(51), 0, 0), 100, 0, 0, NIVEL, CELL_PX, 8), 0)
  assert.equal(hc.build(espejo(con(49), 0, 0), 100, 0, 0, NIVEL, CELL_PX, 8), 50, '49 calientes y una celda fría')
})

test('estimatedCells: exacta en esperanza con celdas de un punto o de dos', () => {
  const S = SAMPLE_STRIDE, p = 1 / S
  for (const [N1, N2] of [[10_000, 0], [0, 10_000]]) {
    const vistas = N1 * p + N2 * (1 - (1 - p) ** 2)
    const f1 = N1 * p + N2 * 2 * p * (1 - p)
    const f2 = N2 * p * p
    assert.ok(Math.abs(estimatedCells(vistas, f1, f2, S) - (N1 + N2)) < 1e-6, `${N1} de uno y ${N2} de dos: ${estimatedCells(vistas, f1, f2, S)}`)
  }
  assert.equal(estimatedCells(500, 0, 0, S), 500, 'sin celdas vistas una vez, las vistas')
})

// Una nube de `n` puntos donde los de índice múltiplo de SAMPLE_STRIDE (los que toma la muestra) caen cada uno en su celda y el
// resto en una sola: la pasada entera agregaría en n/SAMPLE_STRIDE + 1 celdas, pero la muestra sólo ve celdas sueltas.
const trampa = n => Array.from({ length: n }, (_, i) => [(3000 + (i % SAMPLE_STRIDE ? 0.5 : 3 * i + 7)) * LADO, 1500.5 * LADO, 1])

test('desde SAMPLE_MIN_POINTS la muestra corta antes la pasada que estima por encima del tope', () => {
  const n = SAMPLE_MIN_POINTS
  const hc = new HeatCells()
  assert.equal(hc.build(espejo(trampa(n), 0, 0), n, 0, 0, NIVEL, CELL_PX, 1), 0, 'la muestra la corta')
  assert.deepEqual(hc.sample, { seen: n / SAMPLE_STRIDE, f1: n / SAMPLE_STRIDE, f2: 0, hot: 0 })
  assert.ok(estimatedCells(n / SAMPLE_STRIDE, n / SAMPLE_STRIDE, 0, SAMPLE_STRIDE) > n * MAX_CELL_RATIO * SAMPLE_MARGIN)
  // Un punto menos y no hay muestra: la pasada entera agrega.
  const m = n - SAMPLE_STRIDE
  assert.equal(hc.build(espejo(trampa(m), 0, 0), m, 0, 0, NIVEL, CELL_PX, 1), m / SAMPLE_STRIDE + 1)
  assert.equal(hc.sample.seen, 0)
})

test('una muestra que estima dentro del margen deja correr la pasada', () => {
  const n = SAMPLE_MIN_POINTS
  const puntos = Array.from({ length: n }, (_, i) => [(3000 + (i % 1000) * 3 + 0.5) * LADO, 1500.5 * LADO, 1])
  const hc = new HeatCells()
  assert.equal(hc.build(espejo(puntos, 0, 0), n, 0, 0, NIVEL, CELL_PX, 1), 1000)
  assert.ok(hc.sample.seen > 0 && hc.sample.seen <= 1000)
})

// Constantes que salen de una medición, no de una cuenta: el error de la imagen y el costo de la GPU se midieron con estos valores
// (las cifras de docs/heat.md#agregación). Cambiar una pide volver a medir; esta prueba hace que no se cambien sin verlo.
test('las constantes medidas de la agregación', () => {
  assert.equal(AGGREGATE_MIN_POINTS, 20_000)
  assert.equal(AGGREGATE_REF_RADIUS, 40)
  assert.equal(CELL_PER_RADIUS, 1 / 20)
  assert.equal(CELL_PX, 8)
  assert.equal(MAX_CELL_RATIO, 0.5)
  assert.equal(HOT_CONTRIBUTION, 0.5)
  assert.equal(HEAVY_CONTRIBUTION, 32 * POINT_ALPHA)
  assert.equal(SPLIT_LEVELS, 2)
  assert.equal(LEVEL_STEPS, 4)
  assert.equal(SAMPLE_MIN_POINTS, 200_000)
  assert.equal(SAMPLE_STRIDE, 16)
  assert.equal(SAMPLE_MARGIN, 1.5)
})

// Puntos de aporte POINT_ALPHA (peso 1, intensity 1) en la celda (3000, 1500) del nivel NIVEL, `k` en cada una de las 16
// subceldas de 1/4 de lado, y uno suelto lejos.
const pesada = k => {
  const puntos = []
  for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) for (let j = 0; j < k; j++)
    puntos.push([(3000 + (sx + 0.3 + 0.4 * j / k) / 4) * LADO, (1500 + (sy + 0.5) / 4) * LADO, 1])
  puntos.push([(3040.5) * LADO, 1500.5 * LADO, 1])
  return puntos
}

test('una celda cuyos aportes suman más de HEAVY_CONTRIBUTION se parte en celdas de 1/2^SPLIT_LEVELS de lado', () => {
  const hc = new HeatCells()
  const justo = Math.floor(HEAVY_CONTRIBUTION / POINT_ALPHA / 16)    // 2 por subcelda: 32 puntos, Σc = HEAVY_CONTRIBUTION
  assert.equal(hc.build(espejo(pesada(justo), 0, 0), 16 * justo + 1, 0, 0, NIVEL, CELL_PX, 1), 2, 'en el umbral, entera')
  const p = pesada(justo + 1)
  const n = hc.build(espejo(p, 0, 0), p.length, 0, 0, NIVEL, CELL_PX, 1)
  assert.equal(n, 17, 'pasado el umbral, sus 16 subceldas y la suelta')
  const cs = celdas(hc)
  assert.deepEqual(cs.map(c => c.n).sort((a, b) => a - b), [1, ...Array(16).fill(justo + 1)])
  assert.ok(Math.abs(cs.reduce((t, c) => t + c.c * c.n, 0) - p.length * POINT_ALPHA) < 1e-5, 'la suma de aportes se conserva')
  // Cada subcelda lleva su covarianza en px² de world0 de la subcelda: a lo largo de x, la de sus puntos.
  const sub = LADO / 2 ** SPLIT_LEVELS
  for (let k = 0; k < hc.count; k++) {
    const o = k * CELL_FLOATS
    if (hc.out[o + 3] === 1) continue
    assert.ok(hc.out[o + 4] > 0 && hc.out[o + 4] < sub * sub, `xx ${hc.out[o + 4]}`)
    assert.ok(Math.abs(hc.out[o + 5]) < 1e-12 * sub * sub, `yy ${hc.out[o + 5]}`)
  }
})

test('si las subceldas pasan del tope, la celda pesada queda entera', () => {
  // 40 puntos de la pesada en 16 subceldas y uno suelto: 17 muestras para 41 puntos caben en el tope de 20.
  const hc = new HeatCells()
  const p = pesada(2).concat(pesada(1).slice(0, 8))
  assert.equal(hc.build(espejo(p, 0, 0), p.length, 0, 0, NIVEL, CELL_PX, 1), 17)
  // 33 en la pesada y dos sueltas: tope de 17, con las dos sueltas quedan 15 para las 16 subceldas. Entera.
  const pocas = Array.from({ length: 33 }, (_, i) => [(3000 + ((i % 16) % 4 + 0.5) / 4) * LADO, (1500 + (Math.floor((i % 16) / 4) + 0.5) / 4) * LADO, 1])
  pocas.push([3040.5 * LADO, 1500.5 * LADO, 1], [3080.5 * LADO, 1500.5 * LADO, 1])
  assert.ok(33 * POINT_ALPHA > HEAVY_CONTRIBUTION)
  assert.equal(hc.build(espejo(pocas, 0, 0), pocas.length, 0, 0, NIVEL, CELL_PX, 1), 3, 'la pesada entera y las dos sueltas')
  assert.equal(celdas(hc).find(c => c.n === 33)?.n, 33)
})
