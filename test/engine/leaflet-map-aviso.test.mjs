// `getLeafletMap()` está fuera de contrato: devuelve el mapa y avisa por consola una sola vez por motor.
// Corre con: node --test test/engine/leaflet-map-aviso.test.mjs
import '../../test-helpers/engine-stub.mjs'
import { makeMap, makeLeaflet } from '../../test-helpers/engine-stub.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MapEngine } from '../../src/engine/MapEngine.js'
import { adoptLeafletHost } from '../../src/host/LeafletHost.js'

const nuevo = map => new MapEngine({ host: adoptLeafletHost(map, { leaflet: makeLeaflet() }) })

test('devuelve el mapa y avisa una vez, aunque se llame de nuevo', t => {
  const aviso = t.mock.method(console, 'warn', () => {})
  const map   = makeMap()
  const motor = nuevo(map)

  assert.equal(motor.getLeafletMap(), map)
  assert.equal(motor.getLeafletMap(), map)
  assert.equal(aviso.mock.callCount(), 1)
  assert.match(aviso.mock.calls[0].arguments[0], /getLeafletMap\(\) está fuera de contrato/)
})

test('cada motor avisa por su cuenta, y uno que nunca la llama no avisa', t => {
  const aviso = t.mock.method(console, 'warn', () => {})
  const a     = nuevo(makeMap())
  const b     = nuevo(makeMap())
  nuevo(makeMap())

  a.getLeafletMap()
  b.getLeafletMap()
  assert.equal(aviso.mock.callCount(), 2)
})
