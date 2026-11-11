// <cristae-popup> y el botón central de <cristae-cluster> sobre el contrato de la cámara: con el ancla tapada
// por la superficie (tras el horizonte de un globo inyectado) se ocultan, y sobre el Leaflet REAL se ubican
// donde la fórmula vieja (`latLngToContainerPoint` sin portador ni oclusión) los pone. El mapa es un nodo de
// jsdom con cámara de verdad y un motor que sólo anota su `move`.
// Corre con: node --test test/element/camara-overlays.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { contenedor, prepararDom } from '../../test-helpers/leaflet-real.mjs'

const window = prepararDom()
;['addEventListener', 'removeEventListener'].forEach(k => { globalThis[k] ??= window[k].bind(window) })
globalThis.ResizeObserver ??= class { observe() {} disconnect() {} }
const { createLeafletHost } = await import('../../src/host/LeafletHost.js')
const { Camera }            = await import('../../src/engine/Camera.js')
const { viewFacet }         = await import('../../src/camera/facet.js')
const { globeView }         = await import('../../src/camera/views.js')
const { CristaePopup }      = await import('../../src/element/CristaePopup.js')
const { CristaeCluster }    = await import('../../src/element/CristaeCluster.js')

CristaePopup.finalize()
CristaeCluster.finalize()

const SIZE = { x: 800, y: 600 }
const CAJA = { left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 }

const motor = () => ({ on: () => () => {} })
const mapa = camera => Object.assign(document.createElement('div'), {
  camera, engine: motor(), getBoundingClientRect: () => CAJA,
})
const globo = () => mapa(new Camera({ host: { camera: viewFacet(globeView({ center: { lat: 0, lng: 0 }, zoom: 3, size: SIZE })) } }))
const leaflet = (center = [-33.45, -70.66], zoom = 10) =>
  mapa(new Camera({ host: createLeafletHost({ container: contenedor(), view: { center, zoom } }) }))

const popupEn = (map, props = {}) => {
  const el = Object.assign(new CristaePopup(), { renderRoot: document.createElement('div'), closest: () => map, contentOf: () => 'x', ...props })
  el.connectedCallback()
  return el
}
const nodoDe = () => document.body.querySelector('.cristae-popup:last-of-type')

const clusterEn = map => {
  const control = {}
  const el = Object.assign(new CristaeCluster(), {
    closest: () => map, children: [], expandable: false, _reduce: () => {}, _units: [{ kind: 'bubble', id: 'b', handle: { control } }],
  })
  el.mountLayer({})
  return { el, abrir: center => control.onInteraction({ type: 'expand', center }) }
}
const botonDe = () => document.body.querySelector('.cristae-cluster-center:last-of-type')

test('un popup anclado tras el horizonte queda oculto y uno en el centro, visible', () => {
  const map = globo()
  const alto = popupEn(map, { offset: '0,0' })
  alto.open({ id: 1 }, { lat: 0, lng: 0 })
  const visible = nodoDe()
  assert.equal(visible.style.visibility, '')
  alto.open({ id: 2 }, { lat: 0, lng: 180 })
  assert.equal(nodoDe().style.visibility, 'hidden')
  alto.close()
})

test('el popup oculto reaparece al volver el ancla a la cara visible', () => {
  const map = globo()
  const popup = popupEn(map)
  popup.open({ id: 1 }, { lat: 0, lng: 180 })
  const nodo = nodoDe()
  assert.equal(nodo.style.visibility, 'hidden')
  map.camera = new Camera({ host: { camera: viewFacet(globeView({ center: { lat: 0, lng: 180 }, zoom: 3, size: SIZE })) } })
  popup.refresh()
  assert.equal(nodo.style.visibility, '')
  popup.close()
})

test('un visibility externo del nodo sobrevive a la reposición en 2D', () => {
  const map = leaflet()
  const popup = popupEn(map, { autoPan: false })
  popup.open({ id: 1 }, { lat: -33.45, lng: -70.66 })
  const nodo = nodoDe()
  nodo.style.visibility = 'hidden'
  popup.refresh()
  assert.equal(nodo.style.visibility, 'hidden')
  popup.close()
})

test('en el globo a z4 un popup con ancla fuera del rectángulo y no tapada sigue visible', () => {
  const map = mapa(new Camera({ host: { camera: viewFacet(globeView({ center: { lat: 0, lng: 0 }, zoom: 4, size: SIZE })) } }))
  const popup = popupEn(map, { autoPan: false })
  const lng = [10, 20, 30, 40, 50, 60, 70, 80].find(g => {
    const p = map.camera.latLngToContainerPoint([0, g])
    return !p.occluded && p.x > SIZE.x
  })
  assert.notEqual(lng, undefined, 'hay un ancla fuera del rectángulo y no tapada')
  popup.open({ id: 1 }, { lat: 0, lng })
  assert.equal(nodoDe().style.visibility, '')
  popup.close()
})

test('el botón del cluster con el ancla tapada queda en display none, y con ancla visible, no', () => {
  const map = globo()
  const { abrir } = clusterEn(map)
  abrir({ lat: 0, lng: 0 })
  const boton = botonDe()
  assert.notEqual(boton.style.display, 'none')
  abrir({ lat: 0, lng: 180 })
  assert.equal(boton.style.display, 'none')
})

test('sobre Leaflet el popup cae donde la fórmula vieja lo pone', () => {
  const map = leaflet()
  const popup = popupEn(map, { offset: '4,-12', clip: false })
  const lat = -33.4, lng = -70.7
  popup.open({ id: 1 }, { lat, lng })
  const viejo = map.camera.latLngToContainerPoint([lat, lng])
  const nodo = nodoDe()
  assert.equal(nodo.style.visibility, '')
  assert.equal(nodo.style.left, `${CAJA.left + viejo.x + 4}px`)
  assert.equal(nodo.style.top, `${CAJA.top + viejo.y - 12}px`)
  popup.close()
})

test('sobre Leaflet el popup fuera del rectángulo sigue visible (se recorta, no se oculta)', () => {
  const map = leaflet()
  const popup = popupEn(map, { autoPan: false })
  popup.open({ id: 1 }, { lat: 10, lng: 10 })
  assert.equal(nodoDe().style.visibility, '')
  popup.close()
})

test('sobre Leaflet el botón del cluster cae donde la fórmula vieja lo pone', () => {
  const map = leaflet()
  const { abrir } = clusterEn(map)
  const centro = { lat: -33.4, lng: -70.7 }
  abrir(centro)
  const viejo = map.camera.latLngToContainerPoint([centro.lat, centro.lng])
  const boton = botonDe()
  assert.equal(boton.style.display, '')
  assert.equal(boton.style.left, `${CAJA.left + viejo.x}px`)
  assert.equal(boton.style.top, `${CAJA.top + viejo.y}px`)
  abrir({ lat: 10, lng: 10 })
  assert.equal(boton.style.display, 'none')   // fuera de la región visible: la condición de hoy
})
