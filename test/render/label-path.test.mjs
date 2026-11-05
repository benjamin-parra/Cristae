// El trazo de los rótulos proyectado a px: la curva sigue los mismos puntos que dibuja la línea (los de
// `geodesic`, que arma con `count` y `at` como `LineGpuLayer#pack`), los anillos cierran y marcan sus
// huecos, y un vértice repetido en el mismo px no suma.
import test from 'node:test'
import assert from 'node:assert/strict'
import { PART, createRun, projectPath, projectRings } from '../../src/render/labelPath.js'
import { geodesic } from '../../src/geometry/curve.js'
import { byDefault } from '../../src/geometry/geodesic.js'
import { projX0, projY0 } from '../../src/render/project.js'

const VIEW = { cx: 80, cy: 150, scale: 4, hw: 500, hh: 300 }
const px   = ([lat, lng]) => [(projX0(lng) - VIEW.cx) * VIEW.scale + VIEW.hw, (projY0(lat) - VIEW.cy) * VIEW.scale + VIEW.hh]
const xyOf = (run, p) => {
  const from = run.parts[p * PART], n = run.parts[p * PART + 1]
  return Array.from({ length: n }, (_, i) => [run.xy[2 * (from + i)], run.xy[2 * (from + i) + 1]])
}

test('la curva pasa por los mismos puntos que la geodésica de la línea', () => {
  const path  = [[-33.4, -70.6], [40.4, -3.7], [51.5, -0.1]]
  const run   = projectPath(createRun(), path, VIEW, byDefault)
  const curve = geodesic(path)[0].map(px)
  assert.equal(run.count, 1)
  assert.ok(curve.length > path.length + 10, 'la geodésica agrega puntos')
  assert.deepEqual(xyOf(run, 0), curve)
})

test('sin curva, sólo los vértices; el largo acumulado es la suma de los segmentos', () => {
  const path = [[0, 0], [0, 10], [10, 10]]
  const run  = projectPath(createRun(), path, VIEW, null)
  const pts  = path.map(px)
  assert.deepEqual(xyOf(run, 0), pts)
  const len = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]) + Math.hypot(pts[2][0] - pts[1][0], pts[2][1] - pts[1][1])
  assert.ok(Math.abs(run.cum[2] - len) < 1e-9)
  assert.equal(run.cum[0], 0)
})

test('un path anidado da una parte por tramo, cada una con su caja y su largo desde 0', () => {
  const run = projectPath(createRun(), [[[0, 0], [0, 10]], [[5, 0], [5, 10]]], VIEW, null)
  assert.equal(run.count, 2)
  assert.equal(run.cum[run.parts[PART]], 0)
  const [x0, y0] = px([5, 0]), [x1] = px([5, 10])
  assert.deepEqual([...run.parts.slice(PART + 2, PART + 7)], [x0, y0, x1, y0, 0])
})

test('un vértice que cae en el mismo px que el anterior no suma; una parte de un px no queda', () => {
  const run = projectPath(createRun(), [[[0, 0], [0, 0], [0, 10]], [[1, 1], [1, 1]]], VIEW, null)
  assert.equal(run.count, 1)
  assert.equal(run.parts[1], 2)
})

test('los anillos cierran en su primer vértice y los huecos quedan marcados', () => {
  const ext  = [[0, 0], [0, 10], [10, 10], [10, 0]]
  const hole = [[2, 2], [2, 4], [4, 4], [4, 2]]
  const ext2 = [[20, 20], [20, 25], [25, 25]]
  const run  = projectRings(createRun(), [[ext, hole], [ext2]], VIEW, null)
  assert.equal(run.count, 3)
  assert.deepEqual([0, 1, 2].map(p => run.parts[p * PART + 6]), [0, 1, 0])
  const ring = xyOf(run, 0)
  assert.equal(ring.length, 5)
  assert.deepEqual(ring[4], ring[0])
})

test('un anillo que ya repite su primer vértice no lo repite dos veces', () => {
  const run = projectRings(createRun(), [[0, 0], [0, 10], [10, 10], [0, 0]], VIEW, null)
  assert.equal(run.parts[1], 4)
})

test('con curva, la arista de cierre también se curva', () => {
  const ring = [[-40, -70], [-40, 20], [10, 20]]
  const run  = projectRings(createRun(), ring, VIEW, byDefault)
  const pts  = xyOf(run, 0)
  const back = geodesic([ring[2], ring[0]])[0].map(px)
  assert.deepEqual(pts.slice(pts.length - back.length), back)
})

test('una zona inválida no deja partes, aunque el run tuviera de antes', () => {
  const run = createRun()
  projectPath(run, [[0, 0], [0, 10]], VIEW, null)
  projectRings(run, [[[0, 0], [0, 1], 'x']], VIEW, null)
  assert.equal(run.count, 0)
})
