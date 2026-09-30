// Cambiar `viewport-insets` re-emite `cristae:viewportchange` sin que la cámara se mueva, y el detail lo
// arma la cámara: centro y caja planos aunque el mapa de abajo devuelva los objetos de Leaflet. El
// elemento se monta con `montarMapa` del harness, sobre el mapa doble. Corre con:
//   node --test test/element/map-viewport.test.mjs
// El harness va PRIMERO: window/document y lo que Lit toca al evaluar.
import { montarMapa } from '../../test-helpers/element-stub.mjs'
import { makeMap } from '../../test-helpers/engine-stub.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import L from 'leaflet'

test('viewport-insets re-emite la vista con el centro y la caja planos', async () => {
  const map     = makeMap()
  const eventos = []
  map.getCenter = () => L.latLng(-33, -70)
  map.getBounds = () => L.latLngBounds([-34, -71], [-32, -69])
  const { el } = await montarMapa({ dispatchEvent: ev => eventos.push(ev) }, map)

  el.viewportInsets = { left: 300 }
  el.updated(new Map([['viewportInsets', undefined]]))

  const { detail } = eventos.findLast(ev => ev.type === 'cristae:viewportchange')
  assert.deepEqual(detail, {
    center : { lat: -33, lng: -70 },
    zoom   : map.getZoom(),
    bounds : { south: -34, west: -71, north: -32, east: -69 },
  })
  assert.equal(Object.getPrototypeOf(detail.center), Object.prototype, 'no el L.LatLng del mapa')
  assert.equal(Object.getPrototypeOf(detail.bounds), Object.prototype, 'no el L.LatLngBounds del mapa')
  assert.deepEqual(el.camera.insets, { top: 0, right: 0, bottom: 0, left: 300 })
  el.disconnectedCallback()
})
