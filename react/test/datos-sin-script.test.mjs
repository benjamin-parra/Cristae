// Props nuevas del tramo de datos sin script en el binding React: url/format/variantOf/textOf por
// atributo kebab, fields/fetch/textOf-función por propiedad, y CristaeIconSet/CristaeIcon con sus
// eventos 'cristae:load' / 'cristae:error'. Los elementos son stubs que sólo declaran
// `elementProperties` (la entrada que clasifica cada prop); no se registra la lib.

import { window } from './setup-jsdom.mjs'   // primero: puebla los globals DOM antes de que react-dom se evalúe
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement as e, act } from 'react'
import { createRoot } from 'react-dom/client'
import { CristaePointLayer, CristaeTextLayer, CristaeIconSet, CristaeIcon } from '../src/index.js'

// Los stubs se definen una vez: customElements no admite redefinir un tag.
const stub = (tag, declaradas) => window.customElements.define(tag, class extends window.HTMLElement {
  static elementProperties = new Map(Object.entries(declaradas))
})
stub('cristae-point-layer', {
  url: { attribute: 'url' }, format: { attribute: 'format' }, variantOf: { attribute: 'variant-of' },
  fields: { attribute: false }, fetch: { attribute: false },
})
stub('cristae-text-layer', { textOf: { attribute: 'text-of' }, fields: { attribute: false } })

function mount(element) {
  const container = window.document.createElement('div')
  window.document.body.appendChild(container)
  const root = createRoot(container)
  act(() => root.render(element))
  return { container, unmount: () => act(() => root.unmount()) }
}

test('url, format y variantOf (string) viajan por atributo kebab', () => {
  const { container, unmount } = mount(e(CristaePointLayer, { url: '/flota.geojson', format: 'geojson', variantOf: 'tipo' }))
  const el = container.querySelector('cristae-point-layer')
  assert.equal(el.getAttribute('url'), '/flota.geojson')
  assert.equal(el.getAttribute('format'), 'geojson')
  assert.equal(el.getAttribute('variant-of'), 'tipo', 'variantOf="tipo" termina en variant-of')
  assert.equal(el.getAttribute('variantOf'), null)
  unmount()
})

test('fields y fetch entran por propiedad, no por atributo', () => {
  const fields = { position: 'geo.pos', text: 'nombre' }
  const fetch = async () => ({})
  const { container, unmount } = mount(e(CristaePointLayer, { url: '/x', fields, fetch }))
  const el = container.querySelector('cristae-point-layer')
  assert.equal(el.fields, fields)
  assert.equal(el.fetch, fetch)
  assert.equal(el.getAttribute('fields'), null)
  assert.equal(el.getAttribute('fetch'), null)
  unmount()
})

test('textOf: string en el atributo text-of; función en la propiedad', () => {
  const a = mount(e(CristaeTextLayer, { textOf: 'nombre' }))
  const elA = a.container.querySelector('cristae-text-layer')
  assert.equal(elA.getAttribute('text-of'), 'nombre')
  a.unmount()

  const fn = d => d.nombre
  const b = mount(e(CristaeTextLayer, { textOf: fn }))
  const elB = b.container.querySelector('cristae-text-layer')
  assert.equal(elB.textOf, fn, 'la función va por propiedad')
  assert.equal(elB.getAttribute('text-of'), null)
  b.unmount()
})

test('CristaeIconSet: onLoad y onError oyen cristae:load y cristae:error', () => {
  const load = [], error = []
  const { container, unmount } = mount(e(CristaeIconSet, { onLoad: ev => load.push(ev), onError: ev => error.push(ev) }))
  const el = container.querySelector('cristae-icon-set')
  assert.ok(el, 'el tag se monta')
  el.dispatchEvent(new window.CustomEvent('cristae:load', { detail: { count: 2 } }))
  el.dispatchEvent(new window.CustomEvent('cristae:error', { detail: { code: 'network' } }))
  assert.equal(load.length, 1)
  assert.equal(load[0].detail.count, 2)
  assert.equal(error.length, 1)
  assert.equal(error[0].detail.code, 'network')
  unmount()
  el.dispatchEvent(new window.CustomEvent('cristae:load'))
  assert.equal(load.length, 1, 'al desmontar se limpian los listeners')
})

test('CristaeIcon renderiza <cristae-icon name src> dentro del set', () => {
  const { container, unmount } = mount(
    e(CristaeIconSet, null, e(CristaeIcon, { name: 'camion', src: '/iconos/camion.svg' })),
  )
  const icon = container.querySelector('cristae-icon-set > cristae-icon')
  assert.ok(icon, 'el ícono es hijo del set')
  assert.equal(icon.getAttribute('name'), 'camion')
  assert.equal(icon.getAttribute('src'), '/iconos/camion.svg')
  unmount()
})
