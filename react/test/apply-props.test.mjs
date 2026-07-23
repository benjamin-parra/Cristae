// Núcleo del binding React: applyElementProps clasifica y difea props sobre un custom element.
// Puro DOM (no necesita React ni jsdom): un elemento fake registra atributos / propiedades / eventos.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyElementProps } from '../src/apply-props.js'

// Elemento fake: `_attrs`/`_props`/`_events` registran lo que el aplicador hace. Un Proxy dirige
// `el[key] = v` (propiedad) a `_props`, y deja los métodos DOM en el target.
const makeEl = () => {
  const _attrs = {}, _props = {}, _events = []
  const target = {
    _attrs, _props, _events,
    setAttribute(k, v) { _attrs[k] = v },
    removeAttribute(k) { delete _attrs[k] },
    addEventListener(t, fn) { _events.push(['add', t, fn]) },
    removeEventListener(t, fn) { _events.push(['remove', t, fn]) },
  }
  return new Proxy(target, {
    set(t, k, v) { if (k in t) t[k] = v; else _props[k] = v; return true },
    get(t, k) { return k in t ? t[k] : _props[k] },
  })
}

test('serializables → atributos kebab-case; objetos/funciones → propiedades', () => {
  const el = makeEl()
  const source = { move() {} }
  const acc = { idOf: () => 1 }
  applyElementProps(el, {}, { initialZoom: 5, cluster: true, hidden: false, source, accessors: acc })
  assert.equal(el._attrs['initial-zoom'], '5', 'number → atributo string')
  assert.equal(el._attrs['cluster'], '', 'boolean true → atributo vacío')
  assert.equal('hidden' in el._attrs, false, 'boolean false → sin atributo')
  assert.equal(el._props.source, source, 'objeto → propiedad (el dato NO va por atributo)')
  assert.equal(el._props.accessors, acc, 'accessors → propiedad')
  assert.equal('source' in el._attrs, false, 'el objeto no se serializa a atributo')
})

test('diff: sólo toca lo que cambió; una prop igual no re-asigna', () => {
  const el = makeEl()
  const source = { a: 1 }
  const p1 = applyElementProps(el, {}, { initialZoom: 5, source })
  el._attrs['initial-zoom'] = 'SENTINEL'                  // si re-asigna, lo pisa
  el._props.source = 'SENTINEL'
  applyElementProps(el, p1, { initialZoom: 5, source })   // mismas refs
  assert.equal(el._attrs['initial-zoom'], 'SENTINEL', 'atributo sin cambio no se re-setea')
  assert.equal(el._props.source, 'SENTINEL', 'propiedad sin cambio no se re-asigna')
})

test('propiedad nueva referencia → re-asigna (así entra el dato nuevo por propiedad)', () => {
  const el = makeEl()
  const s1 = { v: 1 }, s2 = { v: 2 }
  const p1 = applyElementProps(el, {}, { source: s1 })
  applyElementProps(el, p1, { source: s2 })
  assert.equal(el._props.source, s2)
})

test('eventos: add/replace/remove con el nombre mapeado', () => {
  const el = makeEl()
  const f1 = () => {}, f2 = () => {}
  const evName = (k) => 'cristae:' + k.slice(2).toLowerCase()
  const p1 = applyElementProps(el, {}, { onViewportChange: f1 }, evName)
  assert.deepEqual(el._events.at(-1), ['add', 'cristae:viewportchange', f1])

  const p2 = applyElementProps(el, p1, { onViewportChange: f2 }, evName)
  assert.deepEqual(el._events.at(-2), ['remove', 'cristae:viewportchange', f1], 'quita el handler viejo')
  assert.deepEqual(el._events.at(-1), ['add', 'cristae:viewportchange', f2], 'agrega el nuevo')

  applyElementProps(el, p2, {}, evName)                    // baja de la key
  assert.deepEqual(el._events.at(-1), ['remove', 'cristae:viewportchange', f2], 'la remoción de la key desengancha')
})

test('baja de props: atributo → removeAttribute; propiedad → undefined', () => {
  const el = makeEl()
  const source = { a: 1 }
  const p1 = applyElementProps(el, {}, { initialZoom: 5, source })
  applyElementProps(el, p1, {})
  assert.equal('initial-zoom' in el._attrs, false, 'quita el atributo')
  assert.equal(el._props.source, undefined, 'limpia la propiedad')
})
