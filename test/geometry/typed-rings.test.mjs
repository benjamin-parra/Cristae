// Los hermanos tipados de `pointInPoly` y `bboxOfRings` —`pointInPart`, `oddEvenRange`,
// `growBoxOfRange` y `partAtPoint`— contra el camino de arrays, que acá hace de oráculo: sobre la
// misma geometría los dos caminos tienen que responder lo mismo.
import test from 'node:test'
import assert from 'node:assert/strict'
import { pointInPoly, pointInPart, oddEvenRange, prepareRangeIndex, partAtPoint } from '../../src/geometry/polygon.js'
import { bboxOfRings, growBoxOfRange } from '../../src/geometry/bbox.js'

// Un polígono como lista de anillos [[lat,lng],…] → las tablas CSR del lector, con `xy` en [lng,lat].
const csr = poligonos => {
  const xy = [], vertexAt = [0], ringAt = [0]
  poligonos.forEach(anillos => {
    anillos.forEach(anillo => {
      anillo.forEach(([lat, lng]) => xy.push(lng, lat))
      vertexAt.push(xy.length / 2)
    })
    ringAt.push(vertexAt.length - 1)
  })
  return {
    xy        : Float64Array.from(xy),
    vertexAt  : Uint32Array.from(vertexAt),
    ringAt    : Uint32Array.from(ringAt),
    partCount : poligonos.length,
  }
}

const cuadrado = (x0, y0, lado) =>
  [[y0, x0], [y0 + lado, x0], [y0 + lado, x0 + lado], [y0, x0 + lado], [y0, x0]]

// Partes disjuntas: con partes solapadas «la primera que contiene el punto» depende del orden de
// recorrido, y el índice recorre por maxLng mientras la barrida lineal recorre por parte.
const CON_AGUJERO = [cuadrado(0, 0, 10), cuadrado(3, 3, 4)]
const SUELTO      = [cuadrado(20, 0, 5)]
const ABIERTO     = [cuadrado(15, 15, 5).slice(0, 4)]     // sin repetir el primero
const CASOS       = [CON_AGUJERO, SUELTO, ABIERTO, [cuadrado(-5, -5, 3)]]

// Rejilla que cae adentro, en el agujero, sobre los bordes y afuera de todo.
const SONDAS = []
for (let lat = -7; lat <= 27; lat += 1.25)
  for (let lng = -7; lng <= 27; lng += 1.25) SONDAS.push([lat, lng])

test('el tipado responde lo mismo que el camino de arrays, sonda por sonda', () => {
  const g = csr(CASOS)
  CASOS.forEach((anillos, p) => {
    SONDAS.forEach(([lat, lng]) => {
      const esperado = pointInPoly(lat, lng, anillos)
      const dado     = pointInPart(g.xy, g.vertexAt, g.ringAt[p], g.ringAt[p + 1] - g.ringAt[p], lng, lat)
      assert.equal(dado, esperado, `parte ${p} en (${lat}, ${lng})`)
    })
  })
})

test('el agujero se abre: el centro queda afuera y la corona adentro', () => {
  const g      = csr([CON_AGUJERO])
  const dentro = (lat, lng) => pointInPart(g.xy, g.vertexAt, 0, g.ringAt[1], lng, lat)
  assert.equal(dentro(5, 5), false)
  assert.equal(dentro(1, 1), true)
  assert.equal(dentro(9, 9), true)
})

test('un anillo cerrado y su gemelo abierto dan la misma paridad', () => {
  const cerrado = csr([[cuadrado(15, 15, 5)]])
  const abierto = csr([ABIERTO])
  SONDAS.forEach(([lat, lng]) => assert.equal(
    oddEvenRange(cerrado.xy, 0, cerrado.vertexAt[1], lng, lat),
    oddEvenRange(abierto.xy, 0, abierto.vertexAt[1], lng, lat),
    `(${lat}, ${lng})`))
})

test('un tramo vacío no cruza nada ni mueve la caja', () => {
  const xy  = Float64Array.from([0, 0, 10, 10])
  const box = Float64Array.from([Infinity, Infinity, -Infinity, -Infinity])
  assert.equal(oddEvenRange(xy, 0, 0, 5, 5), false)
  assert.deepEqual([...growBoxOfRange(xy, 0, 0, box)], [Infinity, Infinity, -Infinity, -Infinity])
})

test('growBoxOfRange acumula entre tramos sin asignar', () => {
  const xy  = Float64Array.from([0, 0, 10, 4, -3, 8])
  const box = Float64Array.from([Infinity, Infinity, -Infinity, -Infinity])
  growBoxOfRange(xy, 0, 2, box)
  growBoxOfRange(xy, 2, 1, box)
  assert.deepEqual([...box], [-3, 0, 10, 8])
  assert.equal(growBoxOfRange(xy, 0, 0, box), box)
})

test('el índice de partes encuentra la parte dueña y respeta el agujero', () => {
  const g = prepareRangeIndex(csr(CASOS))
  assert.equal(partAtPoint(g, 1, 1), 0)          // corona del que tiene agujero
  assert.equal(partAtPoint(g, 5, 5), -1)         // su agujero: ninguna parte lo contiene
  assert.equal(partAtPoint(g, 22, 2), 1)
  assert.equal(partAtPoint(g, 17, 17), 2)        // el abierto
  assert.equal(partAtPoint(g, -4, -4), 3)
  assert.equal(partAtPoint(g, 100, 100), -1)
})

test('el índice coincide con la barrida lineal sobre toda la rejilla', () => {
  const tablas = csr(CASOS)
  const g      = prepareRangeIndex(tablas)
  SONDAS.forEach(([lat, lng]) => {
    const lineal = CASOS.findIndex((_, p) => pointInPart(
      tablas.xy, tablas.vertexAt, tablas.ringAt[p], tablas.ringAt[p + 1] - tablas.ringAt[p], lng, lat))
    assert.equal(partAtPoint(g, lng, lat), lineal, `(${lat}, ${lng})`)
  })
})

test('bboxOfRings baja las tres profundidades a la misma caja', () => {
  const esperado = { minLat: 0, maxLat: 10, minLng: 0, maxLng: 10 }
  assert.deepEqual(bboxOfRings(cuadrado(0, 0, 10)), esperado)
  assert.deepEqual(bboxOfRings(CON_AGUJERO), esperado)
  assert.deepEqual(bboxOfRings([CON_AGUJERO]), esperado)
})
