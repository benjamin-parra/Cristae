// <CristaeTerrainLayer> en React: la pantalla (b) en planta (sin `relief` ni `exaggeration` en el mapa).
// Prueban lo que define el wrap de la capa de terreno:
//   (a) los escalares entran por ATRIBUTO (slopeBreaks → slope-breaks, clipTo → clip-to, contours número)
//       y el arreglo de colores por PROPIEDAD;
//   (b) `controls` existe tras el montaje y `measure` sobre los anillos del predio da las cifras de relief();
//   (c) onLoad y onError viajan por el camino genérico de eventos (cristae:load, cristae:error), sin bus,
//       y se limpian al desmontar.
// La capa real vive en el núcleo: acá un elemento falso con su mismo contrato (atributos, `controls`) y un
// terreno sin red, que es lo que observa el binding.

import './setup-jsdom.mjs'   // primero: puebla los globals DOM antes de que react-dom se evalúe
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement as e, act, createRef } from 'react'
import { createRoot } from 'react-dom/client'
import { CristaeMap, CristaePolygonLayer, CristaeTerrainLayer } from '../src/index.js'
import { terrain, relief } from '../../src/geometry/terrain.js'
import { parseSlopeBreaks } from '../../src/element/terrainAttrs.js'
import { mundo, latDe, lngDe } from '../../test-helpers/terreno.mjs'
import { window } from './setup-jsdom.mjs'

const R = 6371008.8
const RAD = Math.PI / 180
const FUENTE = { url: 'https://t.test/{z}/{x}/{y}.png', encoding: 'terrarium', zoom: 14, tileSize: 64 }
const PX = 4869 * 64 + 20
const PY = 10007 * 64 + 20
const PENDIENTE = 0.2   // 20 %: cae en la clase del medio de «15% 30%»
const COLORES = ['#a6d96a', '#fdae61', '#d7191c']

// Un predio rectangular de ~60 × 80 celdas, como [lat, lng][][] (la forma de `anillos`).
const anillos = [[
  [latDe(PY + 40), lngDe(PX - 30)], [latDe(PY + 40), lngDe(PX + 30)],
  [latDe(PY - 40), lngDe(PX + 30)], [latDe(PY - 40), lngDe(PX - 30)],
]]
const CAJA = { south: latDe(PY + 80), west: lngDe(PX - 80), north: latDe(PY - 80), east: lngDe(PX + 80) }

const mundoRampa = mundo({ h: lat => 1000 + PENDIENTE * R * (lat + 37) * RAD })
const suelo = await terrain(FUENTE, CAJA, { fetch: mundoRampa.fetch })

// El elemento falso: al conectarse publica `controls` con `measure` sobre el terreno y los cortes de SU atributo.
class FakeTerrain extends window.HTMLElement {
  static elementProperties = new Map([['slopeColors', { attribute: false }]])
  connectedCallback() {
    const el = this
    this.controls = {
      get id() { return el.id },   // React aplica el atributo después de conectar
      measure: async polygon => relief(suelo, polygon, parseSlopeBreaks(this.getAttribute('slope-breaks'))),
    }
  }
}
window.customElements.define('cristae-terrain-layer', FakeTerrain)

function mount(element) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => root.render(element))
  return { container, unmount: () => act(() => root.unmount()) }
}

// La pantalla (b) en planta de §3.2: sin `relief` ni `exaggeration`.
const pantalla = (props, ref) =>
  e(CristaeMap, { tile: 'osm', initialZoom: 14 },
    e(CristaeTerrainLayer, {
      ref, id: 'relieve', dem: 'aws', colorBy: 'slope', slopeBreaks: '15% 30%', slopeColors: COLORES,
      contours: 10, clipTo: 'predios', ...props,
    }),
    e(CristaePolygonLayer, { id: 'predios', data: [], interactive: true }),
  )

test('(a) escalares por atributo, colores por propiedad, contours como número', () => {
  const { container, unmount } = mount(pantalla({}))
  const capa = container.querySelector('cristae-terrain-layer')
  assert.ok(capa, 'el elemento montó dentro del mapa')
  assert.equal(capa.getAttribute('slope-breaks'), '15% 30%', 'slopeBreaks → atributo slope-breaks, con sus unidades')
  assert.equal(capa.getAttribute('clip-to'), 'predios', 'clipTo → atributo clip-to')
  assert.equal(capa.getAttribute('contours'), '10', 'contours (número) → atributo contours')
  assert.equal(capa.getAttribute('color-by'), 'slope')
  assert.equal(capa.getAttribute('dem'), 'aws')
  assert.equal(capa.slopeColors, COLORES, 'slopeColors (arreglo) entra por PROPIEDAD, misma ref')
  assert.equal(capa.getAttribute('slope-colors'), null, 'slopeColors no es atributo')
  const mapa = container.querySelector('cristae-map')
  assert.equal(mapa.getAttribute('relief'), null, 'el mapa no lleva relief')
  assert.equal(mapa.getAttribute('exaggeration'), null, 'el mapa no lleva exaggeration')
  unmount()
})

test('(b) `controls` existe tras el montaje y measure da las cifras de relief()', async () => {
  const ref = createRef()
  const { unmount } = mount(pantalla({}, ref))
  const capa = ref.current?.controls
  assert.ok(capa, 'ref.current.controls existe tras el montaje')
  assert.equal(capa.id, 'relieve')

  const medido = await capa.measure(anillos)
  const esperado = relief(suelo, anillos, [0.15, 0.3])
  assert.deepEqual(medido, esperado, 'measure sobre los anillos = relief() con los mismos cortes')
  assert.ok(medido.slope.areas[1] > 0 && medido.slope.areas[0] === 0 && medido.slope.areas[2] === 0,
    'la rampa del 20 % cae toda en la clase del medio')
  unmount()
})

test('(c) onLoad y onError viajan por cristae:load y cristae:error, y se limpian al desmontar', () => {
  const cargas = []
  const errores = []
  const { container, unmount } = mount(pantalla({
    onLoad: ev => cargas.push(ev.detail),
    onError: ev => errores.push(ev.detail),
  }))
  const capa = container.querySelector('cristae-terrain-layer')
  assert.equal(capa.onLoad, undefined, 'el handler no se filtró como propiedad')

  const carga = { layerId: 'relieve', url: 'https://t.test/14/1/2.png', count: 12 }
  capa.dispatchEvent(new CustomEvent('cristae:load', { detail: carga }))
  assert.deepEqual(cargas, [carga], 'onLoad recibe { layerId, url, count }')

  const fallo = { layerId: 'relieve', url: 'https://t.test/14/1/2.png', code: 'http', message: 'x', status: 500 }
  capa.dispatchEvent(new CustomEvent('cristae:error', { detail: fallo }))
  assert.deepEqual(errores, [fallo], 'onError recibe el detalle del error')

  unmount()
  capa.dispatchEvent(new CustomEvent('cristae:load', { detail: carga }))
  assert.equal(cargas.length, 1, 'tras desmontar, el handler ya no recibe eventos')
})
