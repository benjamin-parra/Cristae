// Las anclas de los rótulos que no siguen el trazo: al borde del ícono más 4 px, `offset` positivo hacia
// arriba, el punto a mitad del largo y el polo del exterior más grande.
import test from 'node:test'
import assert from 'node:assert/strict'
import { anchorAt, midAlong, poleOf } from '../../src/render/labelAnchor.js'
import { createRun, projectRings } from '../../src/render/labelPath.js'

const at   = (placement, icon, offset = 0) => ({ ...anchorAt(placement, 100, 200, icon, offset, {}) })
const ICON = { w: 20, h: 30 }

test('above, below y right quedan al borde del ícono más 4 px, alineados hacia afuera', () => {
  assert.deepEqual(at('above', ICON), { x: 100, y: 200 - 15 - 4, sx: 0, sy: -1 })
  assert.deepEqual(at('below', ICON), { x: 100, y: 200 + 15 + 4, sx: 0, sy: 1 })
  assert.deepEqual(at('right', ICON), { x: 100 + 10 + 4, y: 200, sx: 1, sy: 0 })
})

test('center es la posición del ítem, centrado', () => {
  assert.deepEqual(at('center', ICON), { x: 100, y: 200, sx: 0, sy: 0 })
})

test('offset positivo sube en todas las colocaciones', () => {
  ;['center', 'above', 'below', 'right'].forEach(p => {
    assert.equal(at(p, ICON, 6).y, at(p, ICON).y - 6, p)
    assert.equal(at(p, ICON, -6).y, at(p, ICON).y + 6, p)
    assert.equal(at(p, ICON, 6).x, at(p, ICON).x, p)
  })
})

test('un ícono cuyo punto no es el centro: un pin apoyado en su punta', () => {
  const pin = { w: 20, h: 30, ax: 10, ay: 30 }
  assert.deepEqual(at('below', pin), { x: 100, y: 204, sx: 0, sy: 1 })
  assert.deepEqual(at('above', pin), { x: 100, y: 166, sx: 0, sy: -1 })
  assert.deepEqual(at('right', pin), { x: 114, y: 185, sx: 1, sy: 0 })
})

test('sin tamaño de ícono, a 4 px del punto', () => {
  assert.deepEqual(at('below', { w: 0, h: 0 }), { x: 100, y: 204, sx: 0, sy: 1 })
})

test('midAlong: el punto a mitad del largo y la tangente de su segmento', () => {
  const xy  = new Float64Array([0, 0, 10, 0, 10, 30])
  const cum = new Float64Array([0, 10, 40])
  const m   = midAlong(xy, cum, 0, 3, {})
  assert.deepEqual(m, { x: 10, y: 10, ux: 0, uy: 1 })
})

test('poleOf: el polo del exterior más grande, con sus huecos', () => {
  const chico  = [[0, 0], [0, 1], [1, 1], [1, 0]]
  const grande = [[0, 10], [0, 20], [10, 20], [10, 10]]
  const hueco  = [[2, 12], [2, 18], [8, 18], [8, 12]]
  const view   = { cx: 0, cy: 0, scale: 1, hw: 0, hh: 0 }
  const solo   = poleOf(projectRings(createRun(), [[chico], [grande]], view, null))
  const centro = poleOf(projectRings(createRun(), [[grande]], view, null))
  assert.deepEqual(solo, centro)
  const conHueco = poleOf(projectRings(createRun(), [[chico], [grande, hueco]], view, null))
  assert.ok(conHueco.distance < centro.distance, 'el hueco aleja el polo del centro')
  assert.equal(poleOf(createRun()), null)
})
