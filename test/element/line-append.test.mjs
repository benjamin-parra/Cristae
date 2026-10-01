// Dónde se suma a un track: en el handle de la capa, que el elemento expone por `controls`. El elemento
// no declara `append`: el suyo es el del DOM (`ParentNode.append`), y taparlo rompería a quien le cuelga
// nodos.
import { CristaeLineLayer } from '../../src/element/CristaeLineLayer.js'
import '../../test-helpers/engine-stub.mjs'
import { conGlDeEdicion, makeEditGl, makeLeaflet, makeMap } from '../../test-helpers/engine-stub.mjs'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { MapEngine } from '../../src/engine/MapEngine.js'
import { adoptLeafletHost } from '../../src/host/LeafletHost.js'
import { createSource } from '../../src/data/Source.js'

after(conGlDeEdicion(() => makeEditGl()))

const accessors = { idOf: r => r.id, pathOf: r => r.path }
const motor     = () => new MapEngine({ host: adoptLeafletHost(makeMap(), { leaflet: makeLeaflet() }) })

test('el elemento no tapa el append del DOM', () => {
  assert.equal(Object.hasOwn(CristaeLineLayer.prototype, 'append'), false)
})

test('la capa ya no declara `backend`', () => {
  assert.equal('backend' in CristaeLineLayer.prototype, false)
  assert.equal(CristaeLineLayer.observedAttributes?.includes('backend') ?? false, false)
})

test('el handle suma sobre la Source que posee la capa', () => {
  const engine = motor()
  const handle = engine.addLineLayer({ id: 'ruta', accessors, data: [{ id: 1, path: [[0, 0], [0, 1]] }] })
  handle.append(1, [0, 2])
  assert.deepEqual(handle.source.accessors.pathOf(handle.source.itemById(1)), [[0, 0], [0, 1], [0, 2]])
  engine.destroy()
})

test('con una Source del consumidor el handle lanza en vez de perder los puntos', () => {
  const engine = motor()
  const source = createSource(accessors)
  source.set([{ id: 1, path: [[0, 0], [0, 1]] }])
  const handle = engine.addLineLayer({ id: 'ruta', source })
  assert.throws(() => handle.append(1, [0, 2]), TypeError)
  source.append(1, [0, 2])
  assert.deepEqual(source.accessors.pathOf(source.itemById(1)), [[0, 0], [0, 1], [0, 2]], 'su dueño sí suma')
  engine.destroy()
  source.destroy()
})
