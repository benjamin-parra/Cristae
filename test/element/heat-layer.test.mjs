// <cristae-heat-layer>: la piel declarativa de `addHeatLayer`. Se congela que monta con `source` o
// `accessors`, que el alta recibe lo declarado (con `visible=false` incluido), que cada prop en vivo llega a
// su setter del handle y que el montaje diferido aplica lo declarado. Sin DOM: el prototipo de la clase
// sobre un objeto, y el motor real donde hace falta.
import '../../test-helpers/engine-stub.mjs'
import { makeLeaflet, makeMap } from '../../test-helpers/engine-stub.mjs'
import '../../test-helpers/element-stub.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { createSource } from '../../src/data/Source.js'
import { CristaeHeatLayer } from '../../src/element/CristaeHeatLayer.js'
import { dataLayersEmpty } from '../../src/element/CristaeMap.js'
import { MapEngine } from '../../src/engine/MapEngine.js'
import { adoptLeafletHost } from '../../src/host/LeafletHost.js'

const flush     = () => new Promise(r => globalThis.setTimeout(r, 0))
const accessors = { idOf: p => p.id, positionOf: p => ({ lat: p.lat, lng: p.lng }) }
const punto     = id => ({ id, lat: id, lng: id })
const rampa     = t => [t, 0, 0, 1]

const capa  = props => Object.assign(Object.create(CristaeHeatLayer.prototype), { visible: true, _handle: null, _engine: null, _enclosingModifier: () => null }, props)
const motor = () => new MapEngine({ host: adoptLeafletHost(makeMap(), { leaflet: makeLeaflet() }) })

// Handle espía: anota cada llamada como [método, valor].
const espia = () => {
  const llamadas = []
  const handle   = { id: 'calor', llamadas }
  ;['set', 'setVisible', 'setRadius', 'setBlur', 'setIntensity', 'setColorRamp']
    .forEach(m => handle[m] = v => llamadas.push([m, v]))
  return handle
}

test('monta con `source` o con `accessors`, y sin ninguno difiere', () => {
  assert.equal(capa({}).mountReady(), false)
  assert.equal(capa({ accessors }).mountReady(), true)
  assert.equal(capa({ source: createSource(accessors) }).mountReady(), true)
})

test('el alta recibe lo declarado, y sin id propio el `heat-N`', () => {
  const eco = { addHeatLayer: cfg => cfg }
  const cfg = capa({ accessors, pane: 'densidad', z: 390, radius: 30, blur: 5, intensity: 2, colorRamp: rampa, visible: false })
    .mountLayer(eco)
  assert.match(cfg.id, /^heat-\d+$/)
  assert.deepEqual(
    [cfg.pane, cfg.z, cfg.radius, cfg.blur, cfg.intensity, cfg.colorRamp, cfg.visible],
    ['densidad', 390, 30, 5, 2, rampa, false])
  assert.equal(capa({ id: 'propio', accessors }).mountLayer(eco).id, 'propio')
})

test('cada prop en vivo llega a su setter, y `data` sin valor no llama a `set`', () => {
  const handle = espia()
  const el     = capa({ _handle: handle, visible: false, radius: 40, blur: 8, intensity: 3, colorRamp: rampa, data: [punto(1)] })
  ;['visible', 'radius', 'blur', 'intensity', 'colorRamp', 'data'].forEach(prop => el.syncLayer(new Map([[prop, undefined]])))
  assert.deepEqual(handle.llamadas, [
    ['setVisible', false], ['setRadius', 40], ['setBlur', 8], ['setIntensity', 3], ['setColorRamp', rampa], ['set', [punto(1)]],
  ])

  handle.llamadas.length = 0
  el.data = undefined
  el.syncLayer(new Map([['data', undefined], ['pane', undefined]]))
  assert.deepEqual(handle.llamadas, [], 'ni `data` vacío ni una prop ajena tocan el handle')
})

test('`visible=false` declarado se honra en el montaje: la capa nace oculta en el motor', () => {
  const engine = motor()
  const el     = capa({ id: 'calor', accessors, visible: false })
  el.cristaeMount(engine)
  assert.equal(engine.getLayer('calor').visible, false)
  assert.equal(engine.getLayer('calor').kind, 'heat')
  engine.destroy()
})

test('montaje diferido: los accessors llegan tarde y lo declarado se aplica', async () => {
  const engine = motor()
  const el     = capa({ id: 'calor', data: [punto(1), punto(2)], radius: 12 })
  el.cristaeMount(engine)
  assert.equal(el.controls, null, 'sin accessors no monta')

  el.accessors = accessors
  el.updated(new Map([['accessors', undefined], ['data', undefined], ['radius', undefined]]))
  await flush()
  assert.equal(el.controls.id, 'calor')
  assert.deepEqual(el.controls.source.getSnapshot().map(p => p.id), [1, 2])
  engine.destroy()
})

test('cuenta como capa de datos del mapa: vacía hasta que llega un punto', async () => {
  const engine = motor()
  const el     = capa({ id: 'calor', accessors })
  el.cristaeMount(engine)
  assert.equal(dataLayersEmpty([el]), true)

  el.controls.set([punto(1)])
  await flush()
  assert.equal(dataLayersEmpty([el]), false)
  engine.destroy()
})
