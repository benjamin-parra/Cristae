// `append(id, ...puntos)` de createSource: un track que crece sin que el consumidor rearme su path. Lo
// sumado se ve en el `pathOf` de lectura, se anuncia a la capa por `appendedPoints` en la ventana, y
// cualquier escritura propia del id (set, patch, remove) lo descarta.
// Corre con: node --test test/source-append.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { createSource } from '../src/data/index.js'

const flush = () => new Promise(r => setTimeout(r, 0))
const nuevo = () => createSource({ idOf: it => it.id, pathOf: it => it.path })
const ruta = (id, ...path) => ({ id, path })
const leer = (src, id) => src.accessors.pathOf(src.itemById(id))

test('append requiere pathOf y un id conocido', () => {
  assert.throws(() => createSource({ idOf: it => it.id, positionOf: it => it }).append(1, [0, 0]), TypeError)
  const src = nuevo()
  src.set([ruta(1, [0, 0])])
  assert.throws(() => src.append(2, [1, 1]), RangeError)
})

test('sin puntos no hay ventana ni aviso', async () => {
  const src = nuevo()
  src.set([ruta(1, [0, 0])])
  await flush()
  let avisos = 0
  src.subscribe(() => avisos++)
  src.append(1)
  await flush()
  assert.equal(avisos, 0)
})

test('lo sumado se lee al final del path plano y se anuncia por appendedPoints', async () => {
  const src = nuevo()
  src.set([ruta(1, [0, 0], [0, 1])])
  await flush()
  src.append(1, [0, 2])
  src.append(1, [0, 3], [0, 4])
  assert.deepEqual(leer(src, 1), [[0, 0], [0, 1], [0, 2], [0, 3], [0, 4]])
  assert.deepEqual(src.appendedPoints().get(1), [[0, 2], [0, 3], [0, 4]], 'la ventana junta lo de varias llamadas')
  assert.equal(src.dirtyIds().has(1), false, 'no es un cambio estructural: la capa escribe sólo lo agregado')
})

test('en un path anidado lo sumado sigue al último tramo', () => {
  const src = createSource({ idOf: it => it.id, pathOf: it => it.path })
  src.set([{ id: 1, path: [[[0, 0], [0, 1]], [[1, 0], [1, 1]]] }])
  src.append(1, [1, 2])
  assert.deepEqual(leer(src, 1), [[[0, 0], [0, 1]], [[1, 0], [1, 1], [1, 2]]])
})

test('en un path anidado lo sumado sigue a la última parte no vacía', () => {
  const src = createSource({ idOf: it => it.id, pathOf: it => it.path })
  src.set([{ id: 1, path: [[[0, 0], [0, 1]], []] }, { id: 2, path: [[]] }])
  src.append(1, [0, 2])
  src.append(2, [0, 3])
  assert.deepEqual(leer(src, 1), [[[0, 0], [0, 1], [0, 2]], []])
  assert.deepEqual(leer(src, 2), [[[0, 3]]])
})

test('el path del consumidor no se toca', () => {
  const src = nuevo()
  const item = ruta(1, [0, 0])
  src.set([item])
  src.append(1, [0, 1])
  assert.deepEqual(item.path, [[0, 0]])
})

test('lo sumado sobrevive a los flush y la ventana se vacía', async () => {
  const src = nuevo()
  src.set([ruta(1, [0, 0])])
  src.append(1, [0, 1])
  await flush()
  src.set([ruta(2, [5, 5])])    // otra escritura, de otro id: el 1 ya no está, el 2 no tiene cola
  await flush()
  assert.equal(src.appendedPoints().size, 0)
})

test('set, patch y remove del id descartan lo sumado', async () => {
  const src = nuevo()
  src.set([ruta(1, [0, 0]), ruta(2, [5, 5])])
  src.append(1, [0, 1])
  src.append(2, [5, 6])
  await flush()
  src.set([ruta(1, [9, 9]), ruta(2, [5, 5])])
  assert.deepEqual(leer(src, 1), [[9, 9]])
  assert.equal(src.appendedPoints().size, 0)
  src.append(1, [9, 10])
  src.patch([ruta(1, [8, 8]), ruta(2, [5, 5])], new Set([1]))
  assert.deepEqual(leer(src, 1), [[8, 8]])
  src.append(2, [5, 6])
  src.remove(2)
  src.set([ruta(2, [7, 7])])
  assert.deepEqual(leer(src, 2), [[7, 7]], 'un id nuevo con el mismo nombre no hereda la cola')
})
