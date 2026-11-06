// Contrato de LayerRegistry.restack: el motor le corre el z o el orden a una capa ya registrada (un reasiento o
// un setLayerZ) y el desempate de resolveHits lo sigue desde la próxima consulta, sin una entrada nueva.
// Corre con: node --test test/interaction/registry-restack.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { LayerRegistry } from '../../src/interaction/LayerRegistry.js'
import { EVENT_HOVER } from '../../src/events/events.js'

// Una capa visible con demanda de hover cuyo resolver devuelve siempre las partes dadas.
const capa = (layerId, zIndex, declOrder, ...parts) =>
  ({ layerId, kind: 'test', zIndex, declOrder, activeMask: EVENT_HOVER, resolveHover: () => parts })

const registro = (...capas) => {
  const reg = new LayerRegistry()
  capas.forEach(c => reg.upsertResolver(c))
  return reg
}

const ids = reg => reg.resolveHits('hover', {}).map(h => h.layerId)

test('restack con un z mayor pone arriba a la capa de abajo', () => {
  const reg = registro(capa('abajo', 400, 0, { distancePx: 0 }), capa('arriba', 410, 1, { distancePx: 0 }))
  assert.deepEqual(ids(reg), ['arriba', 'abajo'])

  assert.equal(reg.restack('abajo', 420, 0), true)
  assert.deepEqual(ids(reg), ['abajo', 'arriba'])
})

test('con el mismo z, restack a un orden menor gana el desempate', () => {
  const reg = registro(capa('a', 400, 0, { distancePx: 0 }), capa('b', 400, 1, { distancePx: 0 }))
  assert.deepEqual(ids(reg), ['a', 'b'])

  reg.restack('a', 400, 2)
  assert.deepEqual(ids(reg), ['b', 'a'])
})

test('restack actualiza todas las partes de la capa, y sus hits llevan el z y el orden nuevos', () => {
  const reg = registro(
    capa('multi', 400, 0, { tag: 'cerca', distancePx: 1 }, { tag: 'lejos', distancePx: 5 }),
    capa('otra', 410, 1, { tag: 'otra', distancePx: 0 }),
  )

  reg.restack('multi', 500, 3)
  assert.deepEqual(
    reg.resolveHits('hover', {}).map(({ tag, zIndex, order }) => [tag, zIndex, order]),
    [['cerca', 500, 3], ['lejos', 500, 3], ['otra', 410, 1]],
  )
})

test('restack de un id ausente devuelve false y no crea entradas', () => {
  const reg = registro(capa('a', 400, 0, { distancePx: 0 }))

  assert.equal(reg.restack('nadie', 900, 0), false)
  assert.deepEqual({ ids: reg.layerIds(), hits: ids(reg) }, { ids: ['a'], hits: ['a'] })
})

test('restack repetido no duplica la capa', () => {
  const reg = registro(capa('a', 400, 0, { distancePx: 0 }), capa('b', 410, 1, { distancePx: 0 }))

  reg.restack('a', 420, 0)
  reg.restack('a', 430, 0)
  reg.restack('b', 440, 1)
  assert.deepEqual({ ids: reg.layerIds(), hits: ids(reg) }, { ids: ['a', 'b'], hits: ['b', 'a'] })
})
