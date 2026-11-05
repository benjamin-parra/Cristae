// El polo de inaccesibilidad contra una referencia de fuerza bruta: una grilla fina de puntos, con la
// distancia al borde medida acá segmento por segmento. Una C, donde el centroide cae afuera; un anillo
// con hueco; y los degenerados.
import test from 'node:test'
import assert from 'node:assert/strict'
import { pole } from '../../src/geometry/pole.js'

const flat = ring => Float64Array.from(ring.flat())

// Referencia: adentro por paridad y distancia mínima a las aristas, recorriendo cada anillo cerrado.
const inside = (x, y, rings) => rings.reduce((acc, ring) => {
  let odd = false
  ring.forEach(([ax, ay], i) => {
    const [bx, by] = ring[(i + 1) % ring.length]
    if ((ay > y) !== (by > y) && x < ax + (bx - ax) * (y - ay) / (by - ay)) odd = !odd
  })
  return acc !== odd
}, false)
const edge = (x, y, rings) => Math.min(...rings.flatMap(ring => ring.map(([ax, ay], i) => {
  const [bx, by] = ring[(i + 1) % ring.length]
  const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)))
  return Math.hypot(ax + t * (bx - ax) - x, ay + t * (by - ay) - y)
})))
const bruteBest = (rings, step) => {
  let best = 0
  const xs = rings[0].map(p => p[0]), ys = rings[0].map(p => p[1])
  for (let x = Math.min(...xs); x <= Math.max(...xs); x += step)
    for (let y = Math.min(...ys); y <= Math.max(...ys); y += step)
      if (inside(x, y, rings)) best = Math.max(best, edge(x, y, rings))
  return best
}

const C = [[0, 0], [10, 0], [10, 1], [1, 1], [1, 9], [10, 9], [10, 10], [0, 10]]

test('C: el centroide cae afuera y el polo adentro, en la esquina interior que da más aire', () => {
  const area = 10 + 10 + 8
  const cx   = (10 * 5 + 10 * 5 + 8 * 0.5) / area
  assert.equal(inside(cx, 5, [C]), false, 'el centroide de la C está afuera')
  const p = pole([flat(C)], 0.01)
  assert.ok(inside(p.x, p.y, [C]))
  assert.ok(Math.abs(p.distance - edge(p.x, p.y, [C])) < 1e-9, 'la distancia es la del punto')
  // En la esquina, a igual distancia de las dos paredes de afuera y del vértice de adentro: t = √2·(1 − t).
  assert.ok(Math.abs(p.distance - Math.SQRT2 / (1 + Math.SQRT2)) <= 0.01)
})

test('anillo con hueco: el polo no cae en el hueco y alcanza a la fuerza bruta', () => {
  const outer = [[0, 0], [10, 0], [10, 10], [0, 10]]
  const hole  = [[4, 4], [6, 4], [6, 6], [4, 6]]
  const p     = pole([flat(outer), flat(hole)], 0.01)
  assert.ok(inside(p.x, p.y, [outer, hole]), 'adentro del exterior y fuera del hueco')
  assert.ok(p.distance >= bruteBest([outer, hole], 0.05) - 0.01)
  assert.ok(Math.abs(p.distance - edge(p.x, p.y, [outer, hole])) < 1e-9)
})

test('cuadrado: el centro, con la precisión por defecto', () => {
  const p = pole([flat([[0, 0], [8, 0], [8, 8], [0, 8]])])
  assert.ok(Math.hypot(p.x - 4, p.y - 4) <= 0.08 * Math.SQRT2)
  assert.ok(Math.abs(p.distance - 4) <= 0.08)
})

test('el sentido de giro y repetir el primer vértice no cambian el resultado', () => {
  const a = pole([flat(C)], 0.01)
  const b = pole([flat([...C].reverse())], 0.01)
  const c = pole([flat([...C, C[0]])], 0.01)
  assert.ok(Math.abs(a.distance - b.distance) <= 0.01)
  assert.ok(Math.abs(a.distance - c.distance) <= 0.01)
})

test('degenerados: un segmento y un punto dan el centro de su caja; sin vértices, null', () => {
  assert.deepEqual(pole([flat([[0, 0], [10, 0]])]), { x: 5, y: 0, distance: 0 })
  assert.deepEqual(pole([flat([[3, 4]])]), { x: 3, y: 4, distance: 0 })
  assert.deepEqual(pole([flat([[0, 0], [5, 5], [10, 10]])]), { x: 5, y: 5, distance: 0 })
  assert.equal(pole([new Float64Array(0)]), null)
  assert.equal(pole([]), null)
})
