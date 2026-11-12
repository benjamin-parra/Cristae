// fitToLayer con `ids`: encuadra la caja de lo dibujado de esos ítems —la figura, no su centro— y, si es un
// solo lugar, acerca hasta FIT_POINT_MIN_ZOOM sin alejar nunca. Cámara del anfitrión falsa, como en
// camera-nav: Leaflet recibe la caja como par de esquinas, y flyTo/panTo/setView quedan espiados.
import '../../test-helpers/engine-stub.mjs'
import { makeMap, makeLeaflet } from '../../test-helpers/engine-stub.mjs'
import { createSource } from '../../src/data/Source.js'
import { Camera, FIT_POINT_MIN_ZOOM } from '../../src/engine/Camera.js'
import { adoptLeafletHost } from '../../src/host/LeafletHost.js'
import test from 'node:test'
import assert from 'node:assert/strict'

const setup = (accessors, items, { zoom = 12, insets } = {}) => {
  const map   = makeMap({ zoom })
  const calls = { fitBounds: [], flyTo: [], panTo: [], setView: [] }
  map.fitBounds = (bounds, padding) => { calls.fitBounds.push({ bounds, padding }); return map }
  map.flyTo     = (c, z) => { calls.flyTo.push([c.lat, c.lng, z]); map._zoom = z; return map }
  map.panTo     = c => { calls.panTo.push([c.lat, c.lng, map._zoom]); return map }
  map.setView   = (c, z) => { calls.setView.push([c.lat, c.lng, z]); map._zoom = z; return map }
  map.getMinZoom = () => 0
  map.getMaxZoom = () => 22
  map.unproject  = (pt, z) => { const k = 256 * 2 ** z; return { lat: pt.y / k, lng: pt.x / k } }
  const source = createSource({ idOf: o => o.id, ...accessors })
  source.set(items)
  const camera = new Camera({
    host: adoptLeafletHost(map, { leaflet: makeLeaflet() }), resolveSource: () => source, insets,
  })
  return { map, camera, calls }
}

const puntos = [
  { id: 'a', pos: { lat: 10, lng: 10 } },
  { id: 'b', pos: { lat: 20, lng: 20 } },
]
const conPunto = { positionOf: o => o.pos }

test('ids de polígonos dan la caja de la figura, no la del centro', () => {
  const { camera, calls } = setup(
    { ringsOf: o => o.rings },
    [{ id: 'p', rings: [[[0, 0], [0, 4], [3, 4], [3, 0]]] }, { id: 'q', rings: [[[50, 50], [50, 51], [51, 51]]] }])
  camera.fitToLayer('capa', { ids: ['p'] })
  assert.deepEqual(calls.fitBounds[0].bounds, [[0, 0], [3, 4]])
})

test('ids de líneas dan la caja del trazo', () => {
  const { camera, calls } = setup(
    { pathOf: o => o.path },
    [{ id: 'l', path: [[1, 2], [5, 9], [3, 4]] }, { id: 'm', path: [[60, 60], [61, 61]] }])
  camera.fitToLayer('capa', { ids: new Set(['l']) })
  assert.deepEqual(calls.fitBounds[0].bounds, [[1, 2], [5, 9]])
})

test('un punto con zoom 12 vuela a FIT_POINT_MIN_ZOOM', () => {
  const { camera, calls } = setup(conPunto, puntos, { zoom: 12 })
  camera.fitToLayer('capa', { ids: ['a'] })
  assert.equal(FIT_POINT_MIN_ZOOM, 16)
  assert.deepEqual(calls.flyTo.concat(calls.setView), [[10, 10, 16]])
  assert.equal(calls.fitBounds.length, 0)
})

test('un punto con zoom 17 sólo se centra, sin cambiar el zoom', () => {
  const { map, camera, calls } = setup(conPunto, puntos, { zoom: 17 })
  camera.fitToLayer('capa', { ids: ['a'] })
  assert.deepEqual(calls.panTo, [[10, 10, 17]])
  assert.equal(calls.flyTo.length + calls.setView.length, 0)
  assert.equal(map._zoom, 17)
})

test('maxZoom acota el acercamiento y nunca aleja', () => {
  const bajo = setup(conPunto, puntos, { zoom: 12 })
  bajo.camera.fitToLayer('capa', { ids: ['a'], maxZoom: 14 })
  assert.equal(bajo.map._zoom, 14)

  const alto = setup(conPunto, puntos, { zoom: 15 })
  alto.camera.fitToLayer('capa', { ids: ['a'], maxZoom: 14 })
  assert.equal(alto.map._zoom, 15, 'con zoom sobre el tope no se aleja')
})

test('ids vacíos o desconocidos no mueven la cámara', () => {
  const { camera, calls } = setup(conPunto, puntos)
  camera.fitToLayer('capa', { ids: [] })
  camera.fitToLayer('capa', { ids: ['nadie'] })
  assert.equal(calls.fitBounds.length + calls.flyTo.length + calls.panTo.length + calls.setView.length, 0)
})

test('dos ítems no son un lugar: encuadran por caja, sin la regla del punto', () => {
  const { camera, calls } = setup(conPunto, puntos)
  camera.fitToLayer('capa', { ids: ['a', 'b'] })
  assert.deepEqual(calls.fitBounds[0].bounds, [[10, 10], [20, 20]])
  assert.equal(calls.flyTo.length, 0)
})

test('sin ids la regla del punto no aplica: una capa de un solo ítem encuadra por caja', () => {
  const { camera, calls } = setup(conPunto, [puntos[0]])
  camera.fitToLayer('capa')
  assert.equal(calls.fitBounds.length, 1)
  assert.equal(calls.flyTo.length + calls.panTo.length, 0)
})

test('una capa de líneas sin curva y sin ids ya no lanza', () => {
  const { camera, calls } = setup({ pathOf: o => o.path }, [{ id: 'l', path: [[1, 2], [5, 9]] }])
  camera.fitToLayer('capa')
  assert.deepEqual(calls.fitBounds[0].bounds, [[1, 2], [5, 9]])
})

test('los insets de la llamada se componen con los de la cámara al centrar un punto', () => {
  const sin = setup(conPunto, puntos, { zoom: 17 })
  sin.camera.fitToLayer('capa', { ids: ['a'] })
  const con = setup(conPunto, puntos, { zoom: 17, insets: { left: 100 } })
  con.camera.fitToLayer('capa', { ids: ['a'], insets: { right: 300 } })
  assert.notDeepEqual(con.calls.panTo[0], sin.calls.panTo[0], 'el centro se corre por los insets')
})
