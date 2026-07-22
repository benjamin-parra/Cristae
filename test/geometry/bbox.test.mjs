// Prueba pura del álgebra de bounding-boxes / rectángulos (geometry/bbox.js).
// Congela el comportamiento ACTUAL como oráculo de la desfragmentación (Eje 5): las mismas
// entradas → las mismas salidas antes y después de unificar las tres copias del álgebra.
// Corre con: node --test test/geometry/bbox.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { bboxOfRings, bboxOfPoints, rect, area, intersect } from '../../src/geometry/bbox.js'

// ── bboxOfRings: anillos [lat,lng] ────────────────────────────────────────────

test('bboxOfRings sobre un anillo simple toma min/max de lat y lng', () => {
  assert.deepEqual(
    bboxOfRings([[0, 0], [10, 20], [-5, 3]]),
    { minLat: -5, maxLat: 10, minLng: 0, maxLng: 20 },
  )
})

test('bboxOfRings sobre un anillo de un solo vértice: min == max', () => {
  assert.deepEqual(bboxOfRings([[5, 7]]), { minLat: 5, maxLat: 5, minLng: 7, maxLng: 7 })
})

test('bboxOfRings detecta el multi-anillo por Array.isArray(rings[0][0]) y une todos', () => {
  assert.deepEqual(
    bboxOfRings([[[0, 0], [2, 2]], [[10, 10], [-3, -3]]]),
    { minLat: -3, maxLat: 10, minLng: -3, maxLng: 10 },
  )
})

test('bboxOfRings: un anillo simple no se confunde con multi-anillo', () => {
  // rings[0][0] === 0 (número, no array) → se trata como anillo único.
  assert.deepEqual(bboxOfRings([[1, 4], [3, 2]]), { minLat: 1, maxLat: 3, minLng: 2, maxLng: 4 })
})

// ── bboxOfPoints: puntos proyectados {x,y} ────────────────────────────────────

test('bboxOfPoints toma min/max de x e y', () => {
  assert.deepEqual(
    bboxOfPoints([{ x: 1, y: 2 }, { x: 5, y: -3 }, { x: 0, y: 10 }]),
    { minX: 0, maxX: 5, minY: -3, maxY: 10 },
  )
})

test('bboxOfPoints con un solo punto: min == max', () => {
  assert.deepEqual(bboxOfPoints([{ x: 4, y: 9 }]), { minX: 4, maxX: 4, minY: 9, maxY: 9 })
})

// ── rect / area / intersect ───────────────────────────────────────────────────

test('rect arma { left, top, right, bottom }', () => {
  assert.deepEqual(rect(1, 2, 3, 4), { left: 1, top: 2, right: 3, bottom: 4 })
})

test('area de un rect normal = ancho·alto', () => {
  assert.equal(area(rect(0, 0, 4, 3)), 12)
})

test('area de un rect invertido/colapsado = 0 (no negativa)', () => {
  assert.equal(area(rect(5, 5, 3, 3)), 0)
  assert.equal(area(rect(0, 0, 0, 10)), 0)
})

test('intersect de dos rects solapados devuelve el rect común', () => {
  assert.deepEqual(intersect(rect(0, 0, 10, 10), rect(5, 5, 20, 20)), rect(5, 5, 10, 10))
  assert.equal(area(intersect(rect(0, 0, 10, 10), rect(5, 5, 20, 20))), 25)
})

test('intersect de dos rects disjuntos da un rect de area 0', () => {
  const r = intersect(rect(0, 0, 2, 2), rect(5, 5, 8, 8))
  assert.equal(area(r), 0)
})
