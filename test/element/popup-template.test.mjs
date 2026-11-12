// <cristae-popup> con <template> hijo: `data-field` escribe TEXTO, nunca HTML; `contentOf` gana; refresh vuelve a llenar.
// Corre con: node --test test/element/popup-template.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { prepararDom } from '../../test-helpers/leaflet-real.mjs'

const window = prepararDom()
;['addEventListener', 'removeEventListener'].forEach(k => { globalThis[k] ??= window[k].bind(window) })
globalThis.ResizeObserver ??= class { observe() {} disconnect() {} }
const { CristaePopup } = await import('../../src/element/CristaePopup.js')
const { fillTemplate } = await import('../../src/element/popupTemplate.js')
CristaePopup.finalize()

const plantilla = html => Object.assign(document.createElement('template'), { innerHTML: html })
const CAJA = { left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 }
const camera = { latLngToContainerPoint: () => ({ x: 10, y: 10 }), panBy() {}, insets: null }
const mapa = () => Object.assign(document.createElement('div'), {
  camera, engine: { on: () => () => {} }, getBoundingClientRect: () => CAJA,
})

const popupCon = (html, props = {}) => {
  const el = Object.assign(new CristaePopup(), { renderRoot: document.createElement('div'), closest: () => mapa(), ...props })
  Object.defineProperty(el, 'children', { value: html == null ? [] : [plantilla(html)] })
  el.connectedCallback()
  return el
}
const nodos = () => [...document.body.querySelectorAll('.cristae-popup')]
const limpiar = () => nodos().forEach(n => n.remove())
const LATLNG = { lat: 0, lng: 0 }

test('un valor con HTML queda como texto literal, sin elementos hijos', () => {
  const frag = fillTemplate(plantilla('<b data-field="x"></b>'), { x: '<b>x</b>' })
  const b = frag.querySelector('b')
  assert.equal(b.textContent, '<b>x</b>')
  assert.equal(b.children.length, 0)
})

test('camino anidado', () => {
  const frag = fillTemplate(plantilla('<i data-field="a.b.c"></i>'), { a: { b: { c: 'hondo' } } })
  assert.equal(frag.querySelector('i').textContent, 'hondo')
})

test('null, ítem nulo y campo ausente dan cadena vacía', () => {
  const t = plantilla('<i data-field="a.b"></i><u data-field="z"></u>')
  for (const item of [{ a: null }, { a: { b: null } }, {}, null]) {
    const frag = fillTemplate(t, item)
    assert.equal(frag.querySelector('i').textContent, '')
    assert.equal(frag.querySelector('u').textContent, '')
  }
})

test('los lectores se reutilizan por nombre entre aperturas', () => {
  const readers = new Map()
  const t = plantilla('<i data-field="x"></i>')
  fillTemplate(t, { x: 1 }, readers)
  const read = readers.get('x')
  fillTemplate(t, { x: 2 }, readers)
  assert.equal(readers.get('x'), read)
  assert.equal(readers.size, 1)
})

test('el popup abre con la plantilla y no usa atributos con el valor', () => {
  limpiar()
  const el = popupCon('<b data-field="n"></b>')
  el.open({ n: '<img src=x onerror=1>' }, LATLNG)
  const b = nodos()[0].querySelector('b')
  assert.equal(b.textContent, '<img src=x onerror=1>')
  assert.equal(nodos()[0].querySelector('img'), null)
  assert.equal(b.attributes.length, 1)
  el.close()
})

test('contentOf gana sobre la plantilla', () => {
  limpiar()
  const el = popupCon('<b data-field="n"></b>', { contentOf: () => 'propio' })
  el.open({ n: 'plantilla' }, LATLNG)
  assert.equal(nodos()[0].textContent, 'propio')
  el.close()
})

test('refresh() vuelve a llenar con el ítem vigente', () => {
  limpiar()
  const el = popupCon('<b data-field="n"></b>')
  const item = { n: 'uno' }
  el.open(item, LATLNG)
  assert.equal(nodos()[0].textContent, 'uno')
  item.n = 'dos'
  el.refresh()
  assert.equal(nodos()[0].textContent, 'dos')
  assert.equal(nodos()[0].querySelectorAll('b').length, 1)
  el.close()
})

test('sin plantilla ni contentOf no abre', () => {
  limpiar()
  const el = popupCon(null)
  el.open({ n: 'x' }, LATLNG)
  assert.equal(nodos().length, 0)
})

test('un clic en un polígono abre la plantilla anclada en el punto pulsado, sin posición del ítem', () => {
  limpiar()
  const item  = { codigo: 'p1', nombre: 'Predio Uno' }
  const capa  = { source: { itemById: id => (id === 'p1' ? item : null), accessors: { idOf: i => i.codigo }, subscribe: () => () => {} } }
  const pedidos = []
  const mapaPoligono = Object.assign(mapa(), {
    getLayer: id => (id === 'predios' ? capa : null),
    camera: { ...camera, containerPointToLatLng: p => (pedidos.push(p), { lat: -33, lng: -70, onSurface: true }) },
  })
  const el = Object.assign(new CristaePopup(), { renderRoot: document.createElement('div'), closest: () => mapaPoligono, for: 'predios' })
  Object.defineProperty(el, 'children', { value: [plantilla('<b data-field="nombre"></b>')] })
  el.connectedCallback()

  mapaPoligono.dispatchEvent(new window.CustomEvent('cristae:click', {
    detail: { hits: [{ layerId: 'predios', id: 'p1' }], originalEvent: { clientX: 120, clientY: 45 } },
  }))
  assert.deepEqual(pedidos, [{ x: 120, y: 45 }], 'el punto es relativo al contenedor')
  assert.equal(nodos()[0]?.textContent, 'Predio Uno')
  el.close()
  el.disconnectedCallback()
})
