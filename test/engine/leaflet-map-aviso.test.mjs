// `getLeafletMap()` está fuera de contrato y se retira en v0.47.0: devuelve el mapa y avisa por consola una sola
// vez por página, aunque la llamen varios motores.
// Corre con: node --test test/engine/leaflet-map-aviso.test.mjs
import '../../test-helpers/engine-stub.mjs'
import { makeMap, makeLeaflet } from '../../test-helpers/engine-stub.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MapEngine } from '../../src/engine/MapEngine.js'
import { adoptLeafletHost } from '../../src/host/LeafletHost.js'

const nuevo = map => new MapEngine({ host: adoptLeafletHost(map, { leaflet: makeLeaflet() }) })

test('devuelve el mapa de cada motor y avisa una vez por página', t => {
  const aviso = t.mock.method(console, 'warn', () => {})
  const mapA  = makeMap()
  const mapB  = makeMap()
  const a     = nuevo(mapA)
  const b     = nuevo(mapB)

  assert.equal(aviso.mock.callCount(), 0, 'un motor que no la llama no avisa')
  assert.equal(a.getLeafletMap(), mapA)
  assert.equal(a.getLeafletMap(), mapA)
  assert.equal(b.getLeafletMap(), mapB)
  assert.equal(aviso.mock.callCount(), 1)
  assert.match(aviso.mock.calls[0].arguments[0], /getLeafletMap\(\) se retira en v0\.47\.0: .*fuera de contrato/)
})
