// Ruta `source` de addPolygonLayer: la Source la posee el CONSUMIDOR y la comparte entre vistas, así
// que el motor sólo lee. Los mutadores del handle quedan no-op — el dueño escribe por su Source, y el
// alta no puede pisarle el contenido. Simétrico con la capa de puntos.

import '../../test-helpers/engine-stub.mjs'
import { makeGlify, makeMap, makeLeaflet } from '../../test-helpers/engine-stub.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MapEngine } from '../../src/engine/MapEngine.js'
import { adoptLeafletHost } from '../../src/host/LeafletHost.js'
import { createSource } from '../../src/data/Source.js'

const accessors = { idOf: g => g.id, ringsOf: () => [[[0, 0], [0, 1], [1, 1]]] }
// El contrato de propiedad de la Source no depende del sustrato, pero este harness no abre contextos
// WebGL: se declara el de Leaflet, que es el que sabe montar.
const LEAFLET = { backend: 'leaflet' }
const newEngine = () => new MapEngine({ host: adoptLeafletHost(makeMap(), { leaflet: makeLeaflet() }), glify: makeGlify() })
const ids = source => source.getSnapshot().map(g => g.id)

test('con `source`, el motor expone la del consumidor y el handle no la muta', () => {
  const engine = newEngine()
  const source = createSource(accessors)
  source.set([{ id: 'z1' }, { id: 'z2' }])

  const handle = engine.addPolygonLayer({ id: 'zonas', ...LEAFLET, accessors, source })
  assert.equal(handle.source, source, 'el handle expone la MISMA Source, no una copia')

  handle.set([{ id: 'z3' }])
  assert.deepEqual(ids(source), ['z1', 'z2'], 'el mutador del handle es no-op: el dueño es el consumidor')
  engine.destroy()
})

test('sin `source`, el motor posee la suya y `set` la alimenta', () => {
  const engine = newEngine()
  const handle = engine.addPolygonLayer({ id: 'zonas', ...LEAFLET, accessors, data: [{ id: 'z1' }] })
  assert.deepEqual(ids(handle.source), ['z1'], 'el `data` del alta siembra la Source poseída')

  handle.set([{ id: 'z1' }, { id: 'z2' }])
  assert.deepEqual(ids(handle.source), ['z1', 'z2'], 'el handle sí escribe la que posee')
  engine.destroy()
})
