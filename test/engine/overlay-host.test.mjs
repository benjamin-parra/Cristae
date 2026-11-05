// El host del badge (`addOverlay`): una capa de puntos, como siempre, o las burbujas de un cluster, que es lo
// que alcanza un <cristae-overlay> que envuelve al cluster. Corre con:
//   node --test test/engine/overlay-host.test.mjs
import '../../test-helpers/engine-stub.mjs'
import { makeMap, makeLeaflet, makeIconSet } from '../../test-helpers/engine-stub.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MapEngine } from '../../src/engine/MapEngine.js'
import { adoptLeafletHost } from '../../src/host/LeafletHost.js'

const frame = () => new Promise(resolve => setTimeout(resolve, 5))

// Cinco puntos juntos cerca de (0, 0): a zoom 3 son una burbuja de 5.
const FLOTA = [
  { id: 1, lat: 0, lng: 0 }, { id: 2, lat: 0, lng: 0.0001 }, { id: 3, lat: 0.0001, lng: 0 },
  { id: 4, lat: 0.0001, lng: 0.0001 }, { id: 5, lat: 0, lng: 0.0002 },
]
const puntos = { idOf: v => v.id, positionOf: v => ({ lat: v.lat, lng: v.lng }) }

const montar = () => {
  const map    = makeMap()
  const engine = new MapEngine({ host: adoptLeafletHost(map, { leaflet: makeLeaflet() }) })
  engine.addPointLayer({ id: 'flota', accessors: puntos, iconSet: makeIconSet(), data: FLOTA })
  return { map, engine }
}
const zDe = (map, engine, id) => Number(map.getPane(engine.getLayer(id).paneName).style.zIndex)

test('sobre una capa de puntos: comparte su Source y va 7 sobre ella', async () => {
  const { map, engine } = montar()
  const badge = engine.addOverlay({ id: 'badges', hostId: 'flota', iconSet: makeIconSet() })
  await frame()

  assert.equal(badge.id, 'badges')
  assert.equal(engine.getLayer('badges').source, engine.getLayer('flota').source)
  assert.equal(engine.getLayer('badges').bindTo, 'flota')
  assert.equal(zDe(map, engine, 'badges'), zDe(map, engine, 'flota') + 7)
  engine.destroy()
})

test('sobre las burbujas de un cluster: lee las burbujas y va sobre ellas, sus rótulos y la espiral', async () => {
  const { map, engine } = montar()
  const { bubbleLayerId } = engine.addClusterFold([{ id: 'flota' }], { radius: 80, maxZoom: 18, minPoints: 2 }).handle.control
  engine.addLabels({ hostId: bubbleLayerId })
  const vistas = []
  const badge  = engine.addOverlay({ id: 'badges', hostId: bubbleLayerId, iconSet: makeIconSet(), variantOf: b => (vistas.push(b), 'default') })
  await frame()

  assert.ok(badge, 'una burbuja es un host válido')
  assert.equal(engine.getLayer('badges').source, engine.getLayer(bubbleLayerId).source)
  assert.equal(engine.getLayer('badges').bindTo, bubbleLayerId)
  assert.ok(vistas.some(b => b.count === 5), '`variantOf` recibe la burbuja con su conteo')

  const burbuja = engine.getLayer(bubbleLayerId)
  const z       = zDe(map, engine, 'badges')
  assert.ok(z > zDe(map, engine, bubbleLayerId), 'sobre la burbuja')
  assert.ok(z > burbuja.labelZ, 'sobre sus rótulos')
  const espiral = ['spider', 'spider-sub'].map(s => zDe(map, engine, bubbleLayerId.replace('clusters', s)))
  assert.ok(espiral.every(e => z > e), 'sobre la espiral')
  assert.equal(Math.floor(z / 10), Math.floor(zDe(map, engine, bubbleLayerId) / 10), 'en el escalón del fold')
  engine.destroy()
})
