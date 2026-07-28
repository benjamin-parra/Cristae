// Apilado de una capa (`z`): el declarado en el alta manda sobre el derivado por orden, y `setLayerZ`
// reapila una capa ya montada moviendo el z-index de su pane — sin recrearla.

import '../../test-helpers/engine-stub.mjs'
import { makeGlify, makeMap, makeLeaflet, makeIconSet } from '../../test-helpers/engine-stub.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MapEngine } from '../../src/engine/MapEngine.js'

const flushRaf = () => new Promise(r => setTimeout(r, 5))
const items = [{ id: 1, lat: 0, lng: 0, size: 24 }]
const accessors = { idOf: it => it.id, positionOf: it => ({ lat: it.lat, lng: it.lng }), sizeOf: it => it.size }
const newEngine = () => new MapEngine({ leaflet: makeLeaflet(), glify: makeGlify(), map: makeMap() })
const zDe = (engine, paneName) => engine.getLeafletMap().getPane(paneName)?.style.zIndex

const conCapa = async (cfg) => {
  const engine = newEngine()
  const handle = engine.addPointLayer({ id: 'flota', accessors, iconSet: makeIconSet(), data: items, ...cfg })
  await flushRaf()
  return { engine, handle }
}

test('el `z` del alta manda sobre el derivado por orden de declaración', async () => {
  const engine = newEngine()
  engine.addPointLayer({ id: 'auto', accessors, iconSet: makeIconSet(), data: items })
  engine.addPointLayer({ id: 'fija', accessors, iconSet: makeIconSet(), data: items, z: 378 })
  await flushRaf()

  assert.equal(zDe(engine, 'cristae-point-fija'), '378', 'el declarado se aplica tal cual')
  assert.notEqual(zDe(engine, 'cristae-point-auto'), '378', 'sin declarar, cae al derivado por orden')
})

test('setLayerZ reapila la capa YA montada, sin recrearla', async () => {
  const { engine, handle } = await conCapa({ z: 378 })
  const antes = engine.getLayer('flota').layer

  engine.setLayerZ('flota', 620)
  assert.equal(zDe(engine, 'cristae-point-flota'), '620', 'el pane de la capa se reapila')
  assert.equal(engine.getLayer('flota').layer, antes, 'la capa subyacente es la MISMA (no se recreó)')
  assert.equal(handle.id, 'flota', 'y el handle del consumidor sigue vivo')
})

test('setLayerZ con `z` nulo vuelve al derivado en el alta', async () => {
  const { engine } = await conCapa({ z: 378 })

  engine.setLayerZ('flota', 620)
  engine.setLayerZ('flota', null)
  assert.equal(zDe(engine, 'cristae-point-flota'), '378', 'restaura el z con que se dio de alta')
})

test('setLayerZ sobre una capa inexistente no rompe', () => {
  assert.doesNotThrow(() => newEngine().setLayerZ('no-existe', 500))
})
