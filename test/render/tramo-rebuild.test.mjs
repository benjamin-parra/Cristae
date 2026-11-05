// La cola de reconstrucción A2 de un tramo (src/render/tramo-rebuild.js), con reloj y cuadros falsos:
//
//   R1  la primera tanda es síncrona y arma al menos uno aunque él solo se pase del tope; respeta el tope; el resto sigue
//       en cuadros sucesivos; `after` tras cada tanda; `pending` baja
//   R2  `cancel` corta lo pendiente y el cuadro; `start` sobre una cola en curso la reemplaza; un `cancel` desde dentro de
//       un `build` detiene la tanda
//   R3  un `build` que lanza no impide armar al resto y pasa por el onError del módulo
//
// Corre con: node --test test/render/tramo-rebuild.test.mjs
import { mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { RebuildQueue, REBUILD_BUDGET_MS } from '../../src/render/tramo-rebuild.js'

// Reloj que sólo avanza cuando un `build` gasta; cuadros que corre el test.
const harness = () => {
  const h = { t: 0, frames: new Map(), nextId: 1, cancelled: 0 }
  h.queue = new RebuildQueue({
    now         : () => h.t,
    frame       : cb => (h.frames.set(h.nextId, cb), h.nextId++),
    cancelFrame : id => (h.cancelled++, h.frames.delete(id)),
  })
  h.runFrame = () => {
    const [[id, cb]] = h.frames
    h.frames.delete(id)
    cb(0)
  }
  return h
}

test('R1: tanda síncrona con al menos uno, tope de 8 ms, el resto en cuadros y after tras cada tanda', () => {
  assert.equal(REBUILD_BUDGET_MS, 8)
  const h      = harness()
  const cost   = { a: 20, b: 3, c: 3, d: 3, e: 1 }     // a se pasa del tope solo; b+c+d = 9 cruza el tope
  const built  = []
  const tandas = []
  const items  = ['a', 'b', 'c', 'd', 'e', 'ignorado']
  h.queue.start(items, 5, item => (built.push(item), h.t += cost[item]), () => tandas.push(built.join('')))

  assert.deepEqual(built, ['a'], 'la primera tanda arma a aunque gaste 20 ms')
  assert.deepEqual(tandas, ['a'])
  assert.equal(h.queue.pending, 4)
  assert.equal(h.frames.size, 1)

  h.runFrame()                                          // b (3), c (6), d (9 ≥ 8 corta)
  assert.deepEqual(tandas, ['a', 'abcd'])
  assert.equal(h.queue.pending, 1)

  h.runFrame()
  assert.deepEqual(tandas, ['a', 'abcd', 'abcde'])
  assert.equal(h.queue.pending, 0)
  assert.equal(h.frames.size, 0, 'sin pendientes no agenda otro cuadro')
})

test('R2: cancel corta lo pendiente y el cuadro; start reemplaza; cancel desde un build detiene la tanda', () => {
  const h     = harness()
  const after = mock.fn()
  const build = mock.fn(() => h.t += 10)
  h.queue.start(['a', 'b', 'c'], 3, build, after)
  assert.equal(h.queue.pending, 2)

  h.queue.cancel()
  assert.equal(h.queue.pending, 0)
  assert.equal(h.frames.size, 0)
  assert.equal(h.cancelled, 1)

  // start sobre una cola en curso: la vieja no vuelve a armar ni a llamar su after.
  h.queue.start(['a', 'b', 'c'], 3, build, after)
  const nuevo  = mock.fn(() => h.t += 10)
  const after2 = mock.fn()
  h.queue.start(['x', 'y'], 2, nuevo, after2)
  assert.equal(h.cancelled, 2)
  assert.equal(h.frames.size, 1)
  h.runFrame()
  assert.deepEqual(nuevo.mock.calls.map(c => c.arguments[0]), ['x', 'y'])
  assert.equal(build.mock.callCount(), 2, 'la cola vieja armó sólo su primera tanda')
  assert.equal(after.mock.callCount(), 2)
  assert.equal(after2.mock.callCount(), 2)

  // cancel desde dentro de un build (el tramo se pierde a mitad de la tanda): no sigue ni llama after.
  const h2     = harness()
  const visto  = []
  const after3 = mock.fn()
  h2.queue.start(['a', 'b', 'c'], 3, item => (visto.push(item), item === 'b' && h2.queue.cancel()), after3)
  assert.deepEqual(visto, ['a', 'b'])
  assert.equal(after3.mock.callCount(), 0)
  assert.equal(h2.queue.pending, 0)
  assert.equal(h2.frames.size, 0)

  // start desde dentro de un build: corre la cola nueva y la vieja no sigue sobre sus ítems.
  const h3     = harness()
  const visto3 = []
  const viejo  = mock.fn()
  h3.queue.start(['a', 'b', 'c'], 3, item => {
    visto3.push(item)
    item === 'a' && h3.queue.start(['z'], 1, z => visto3.push(z), () => visto3.push('fin'))
  }, viejo)
  assert.deepEqual(visto3, ['a', 'z', 'fin'])
  assert.equal(viejo.mock.callCount(), 0)
  assert.equal(h3.queue.pending, 0)
  assert.equal(h3.frames.size, 0)
})

test('R3: un build que lanza no impide armar al resto y pasa por el onError del módulo', t => {
  const consola = t.mock.method(console, 'error', () => {})
  const h       = harness()
  const built   = []
  const after   = mock.fn()
  h.queue.start(['a', 'b', 'c'], 3, item => {
    if (item === 'b') throw new Error('falla b')
    built.push(item)
  }, after)
  assert.deepEqual(built, ['a', 'c'])
  assert.equal(after.mock.callCount(), 1)
  assert.equal(consola.mock.callCount(), 1)
  assert.equal(consola.mock.calls[0].arguments[1].message, 'falla b')
})
