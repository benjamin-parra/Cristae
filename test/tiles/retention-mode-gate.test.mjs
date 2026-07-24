// Gate de MODO de createTileSnapshotRetention: en zoom animado (map._zoomAnimated) se hace a un lado;
// en instantáneo engancha. Observable: startRetention → showSnapshot consulta el pane de snapshot.

import '../../test-helpers/engine-stub.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTileSnapshotRetention } from '../../src/tiles/TileSnapshotRetention.js'

const makeMapStub = () => {
  const handlers = new Map()
  let lookups = 0
  return {
    _zoomAnimated: false,
    lookups: () => lookups,
    on(types, cb) { String(types).split(/\s+/).forEach(t => (handlers.get(t) ?? handlers.set(t, new Set()).get(t)).add(cb)) },
    off(types, cb) { String(types).split(/\s+/).forEach(t => handlers.get(t)?.delete(cb)) },
    fire(t) { handlers.get(t)?.forEach(cb => cb({ zoom: 6, center: { lat: 0, lng: 0 } })) },
    getPane() { lookups++; return null },
    createPane: () => ({ style: {}, appendChild() {}, remove() {} }),
    getZoom: () => 5, getMaxZoom: () => 19,
    getPixelOrigin: () => ({ x: 0, y: 0 }),
    getSize: () => ({ x: 100, y: 100 }),
    getZoomScale: () => 1,
  }
}
const layerStub = () => ({ _pruneTiles() {}, _tileZoom: null, options: {} })

test('zoom ANIMADO → la retención se hace a un lado (no toca el pane de snapshot)', () => {
  const map = makeMapStub()
  const ret = createTileSnapshotRetention(map)
  ret.activateLayer(layerStub())
  map._zoomAnimated = true
  const antes = map.lookups()
  map.fire('zoomstart')
  assert.equal(map.lookups(), antes, 'no captura ni muestra snapshot mientras Leaflet anima')
  ret.destroy()
})

test('zoom INSTANTÁNEO → engancha (consulta el pane para cubrir el flicker del snap)', () => {
  const map = makeMapStub()
  const ret = createTileSnapshotRetention(map)
  ret.activateLayer(layerStub())
  map._zoomAnimated = false
  const antes = map.lookups()
  map.fire('zoomstart')
  assert.ok(map.lookups() > antes, 'engancha: showSnapshot consulta el pane de snapshot')
  ret.destroy()
})
