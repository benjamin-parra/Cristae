// El zoom y la atribución de <cristae-map> son overlays del elemento, no controles de Leaflet: el zoom abre
// la zona de arriba a la izquierda, se deshabilita en los topes de la cámara y le pide el paso al motor, y
// la atribución del proveedor cierra la de abajo a la derecha, como HTML. Sin DOM real: el elemento se
// monta con `montarMapa` del harness, y lo que se mira es el template de su render. Corre con:
//   node --test test/element/map-zoom-atribucion.test.mjs
// El harness va PRIMERO: window/document y lo que Lit toca al evaluar.
import { montarMapa } from '../../test-helpers/element-stub.mjs'
import { makeMap } from '../../test-helpers/engine-stub.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { unsafeHTML } from 'lit/directives/unsafe-html.js'

const ATRIBUCION = '&copy; <a href="https://proveedor.test">Proveedor</a>'

// El doble con los topes y los pasos de zoom de Leaflet, que anota los pasos pedidos, y donde la capa de
// tiles entra sin dibujarse.
const conZoom = (map, pasos, topes = { min: 2, max: 5 }) => Object.assign(map, {
  getMinZoom : () => topes.min,
  getMaxZoom : () => topes.max,
  zoomIn     : () => pasos.push('+'),
  zoomOut    : () => pasos.push('-'),
  addLayer   : () => map,
})

// El template de un overlay por su part, entre los anidados del render.
const overlay = (template, part) =>
  template?.strings?.some(tramo => tramo.includes(`part="${part}"`))
    ? template
    : template?.values?.reduce((hallado, valor) => hallado ?? overlay(valor, part), undefined)

// La vista se asienta en `zoom`, como al terminar un zoom de Leaflet.
const asentar = (map, zoom) => map.setZoomForTest(zoom).fire('moveend')

test('el zoom se deshabilita en cada tope de la cámara, y pide el paso al motor', async () => {
  const pasos       = []
  const map         = conZoom(makeMap({ zoom: 3 }), pasos)
  const { el }      = await montarMapa({}, map)
  const habilitados = () => (([acercar, , alejar]) => ({ acercar: !acercar, alejar: !alejar }))(overlay(el.render(), 'zoom').values)

  const estados = [habilitados()]
  asentar(map, 5)
  estados.push(habilitados())
  asentar(map, 2)
  estados.push(habilitados())
  assert.deepEqual(estados, [
    { acercar: true, alejar: true },
    { acercar: false, alejar: true },
    { acercar: true, alejar: false },
  ])

  const [, acercar, , alejar] = overlay(el.render(), 'zoom').values
  acercar()
  alejar()
  assert.deepEqual(pasos, ['+', '-'])
  el.disconnectedCallback()
})

// Leaflet abre un tope sin mover la vista: avisa `zoomlevelschange` y nada más. El elemento pide un render,
// que aquí se hace en el acto.
test('un tope que se abre sin mover la vista vuelve a habilitar el zoom', async () => {
  const topes   = { min: 2, max: 5 }
  const map     = conZoom(makeMap({ zoom: 5 }), [], topes)
  const { el }  = await montarMapa({}, map)
  const acercar = () => !overlay(el.render(), 'zoom').values[0]
  const renders = []
  const antes   = acercar()
  el.requestUpdate = () => renders.push(acercar())

  topes.max = 8
  map.fire('zoomlevelschange')
  assert.deepEqual({ antes, renders }, { antes: false, renders: [true] })
  el.disconnectedCallback()
})

test('no-zoom-control quita el zoom', async () => {
  const { el } = await montarMapa({ noZoomControl: true }, conZoom(makeMap(), []))
  assert.equal(overlay(el.render(), 'zoom'), undefined)
  el.disconnectedCallback()
})

test('la atribución del proveedor va como HTML, y sin ella no hay overlay', async () => {
  const tile   = { url: 'https://proveedor.test/{z}/{x}/{y}.png', attribution: ATRIBUCION }
  const { el } = await montarMapa({ tile }, conZoom(makeMap(), []))
  const sinEl  = (await montarMapa({}, conZoom(makeMap(), []))).el

  assert.deepEqual(overlay(el.render(), 'attribution').values, [unsafeHTML(ATRIBUCION)])
  assert.equal(overlay(sinEl.render(), 'attribution'), undefined)
  el.disconnectedCallback()
  sinEl.disconnectedCallback()
})
