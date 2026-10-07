// <cristae-shape-layer>: el elemento es la piel declarativa de `addShapeLayer`. Lo que se congela es lo que él
// pone: monta cuando hay `source` o `accessors`, entrega al alta lo declarado —con `source` ganando sobre
// `data`—, reenvía `data` y `visible` al handle, expone ese handle por `controls`, y cuenta como capa de datos
// para el estado vacío del mapa. Sin DOM: un objeto con el prototipo de la clase y el motor real, con su GL falso.
import '../../test-helpers/engine-stub.mjs'
import { conGlDeEdicion, makeEditGl, makeLeaflet, makeMap } from '../../test-helpers/engine-stub.mjs'
import '../../test-helpers/element-stub.mjs'
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { createSource } from '../../src/data/Source.js'
import { CristaeShapeLayer } from '../../src/element/CristaeShapeLayer.js'
import { dataLayersEmpty } from '../../src/element/CristaeMap.js'
import { MapEngine } from '../../src/engine/MapEngine.js'
import { adoptLeafletHost } from '../../src/host/LeafletHost.js'

after(conGlDeEdicion(() => makeEditGl()))

const flush = () => new Promise(r => globalThis.setTimeout(r, 0))

const accessors = { idOf: d => d.id, positionOf: d => ({ lat: d.lat, lng: d.lng }), radiusOf: d => d.radius }
const zona      = (id, lat) => ({ id, lat, lng: 10, radius: 500 })

const capa = props => Object.assign(Object.create(CristaeShapeLayer.prototype), { visible: true, interactive: true, ...props })
const motor = () => new MapEngine({ host: adoptLeafletHost(makeMap(), { leaflet: makeLeaflet() }) })

test('monta con `source` o con `accessors`, y sin ninguno difiere', () => {
  assert.equal(capa({}).mountReady(), false)
  assert.equal(capa({ accessors }).mountReady(), true, 'ruta data: los accessors se asignan aparte')
  assert.equal(capa({ source: createSource(accessors) }).mountReady(), true, 'ruta source: la Source ya los trae')
})

test('el alta recibe lo declarado: interactiva y visible por defecto, y sin id propio el `shape-N`', () => {
  const eco = { addShapeLayer: cfg => cfg }
  const cfg = Object.assign(new CristaeShapeLayer(), { accessors, pane: 'cristae-zonas', z: 378 }).mountLayer(eco)
  assert.match(cfg.id, /^shape-\d+$/)
  assert.deepEqual([cfg.interactive, cfg.visible, cfg.pane, cfg.z], [true, true, 'cristae-zonas', 378])

  const propia = capa({ id: 'antenas', accessors, interactive: false, visible: false }).mountLayer(eco)
  assert.deepEqual([propia.id, propia.interactive, propia.visible], ['antenas', false, false])
})

test('`controls` es el handle del motor, y `source` es la misma Source, no una copia', () => {
  const engine = motor()
  const source = createSource(accessors)
  const el     = capa({ id: 'zonas', source, data: [zona(1, 1)] })
  el.cristaeMount(engine)

  assert.equal(el.controls.id, 'zonas')
  assert.equal(el.controls.source, source)
  assert.equal(engine.getLayer('zonas').kind, 'shape')
  engine.destroy()
})

test('`data` entra por `set`, y un cambio de `data` lo reenvía al handle', async () => {
  const engine = motor()
  const el     = capa({ id: 'zonas', accessors, data: [zona(1, 1)] })
  el.cristaeMount(engine)
  await flush()
  assert.deepEqual(el.controls.source.getSnapshot().map(z => z.id), [1], 'el alta carga `data`')

  el.data = [zona(1, 1), zona(2, 2)]
  el.syncLayer(new Map([['data', undefined]]))
  await flush()
  assert.deepEqual(el.controls.source.getSnapshot().map(z => z.id), [1, 2])
  engine.destroy()
})

test('`visible` se reenvía al handle, y ni un cambio ajeno ni `data` sin valor lo tocan', () => {
  const llamadas = []
  const el = capa({ _handle: { setVisible: v => llamadas.push(v), set: () => llamadas.push('set') }, visible: false })
  el.syncLayer(new Map([['visible', true]]))
  assert.deepEqual(llamadas, [false])
  el.syncLayer(new Map([['interactive', true]]))
  assert.deepEqual(llamadas, [false], 'sin cambio de `visible` ni de `data`, el handle no se toca')
  el.syncLayer(new Map([['data', undefined]]))
  assert.deepEqual(llamadas, [false], 'sin `data`, el handle no recibe `set`')
})

test('cuenta como capa de datos del mapa: vacía hasta que llega una forma', async () => {
  const engine = motor()
  const el     = capa({ id: 'zonas', accessors })
  el.cristaeMount(engine)
  assert.equal(dataLayersEmpty([el]), true)

  el.controls.set([zona(1, 1)])
  await flush()
  assert.equal(dataLayersEmpty([el]), false)
  engine.destroy()
})
