// setTileProvider por nombre de preset: 'osm' llega al anfitrión; un nombre desconocido es TypeError y deja el
// proveedor vigente. Corre con: node --test test/engine/tile-por-nombre.test.mjs
import '../../test-helpers/engine-stub.mjs'
import { makeLeaflet, makeMap } from '../../test-helpers/engine-stub.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { MapEngine } from '../../src/engine/MapEngine.js'
import { adoptLeafletHost } from '../../src/host/LeafletHost.js'
import { tilePresets } from '../../src/tiles/presets.js'

const montar = () => {
  const host = adoptLeafletHost(makeMap(), { leaflet: makeLeaflet() })
  const dado = []
  host.tiles.setProvider = tile => { dado.push(tile) }   // el doble de Leaflet no trae TileLayer: se observa lo que llega
  return { engine: new MapEngine({ host }), dado }
}

test("setTileProvider('osm') entrega el preset al anfitrión y devuelve el motor", () => {
  const { engine, dado } = montar()
  assert.equal(engine.setTileProvider('osm'), engine)
  assert.deepEqual(dado, [tilePresets.osm])
  engine.destroy()
})

test('un objeto pasa tal cual', () => {
  const { engine, dado } = montar()
  const propio = { url: 'https://t.test/{z}/{x}/{y}.png' }
  engine.setTileProvider(propio)
  assert.equal(dado[0], propio)
  engine.destroy()
})

test('un nombre desconocido es TypeError que nombra los presets, y no cambia el proveedor', () => {
  const { engine, dado } = montar()
  engine.setTileProvider('osm')
  for (const malo of ['x', '__proto__', 'toString'])
    assert.throws(() => engine.setTileProvider(malo), e => e instanceof TypeError && /osm/.test(e.message) && /cartoDark/.test(e.message))
  assert.equal(dado.length, 1)
  engine.destroy()
})
