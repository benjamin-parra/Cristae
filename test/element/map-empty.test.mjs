// (B) Estado "sin datos" de <cristae-map>: el predicado puro `dataLayersEmpty` decide si mostrar el
// `empty-message`. Vacío ⇔ hay al menos una capa de datos y TODAS tienen 0 features; con datos, oculto.
// Se testea el predicado (la sustancia de la decisión "se muestra con 0 features / se oculta con
// datos"); el filtrado de labels (handles sin `source`) y el toggle DOM se cablean sobre él en el
// componente (cristaeLayerMounted → #refreshEmpty). Corre con: node --test test/element/map-empty.test.mjs
import '../../test-helpers/engine-stub.mjs'   // window/document (documentElement.style) para evaluar Leaflet/Lit
import test from 'node:test'
import assert from 'node:assert/strict'

// Extensiones locales del stub para que lit-html/node evalúe al importar CristaeMap (import DINÁMICO
// tras los shims: los estáticos se hoisten y correrían antes).
globalThis.HTMLElement ??= class {}
globalThis.customElements ??= { define() {}, get() {}, whenDefined() { return Promise.resolve() } }
globalThis.document.createTreeWalker ??= () => ({ currentNode: null, nextNode() { return null } })
globalThis.document.createDocumentFragment ??= () => ({ appendChild() {} })
globalThis.document.createTextNode ??= (t) => ({ data: String(t) })

const { dataLayersEmpty } = await import('../../src/element/CristaeMap.js')

// Capa de datos falsa: un handle (`controls`) con una Source cuyo snapshot son `items`.
const layer = (items) => ({ controls: { source: { getSnapshot: () => items } } })

test('sin capas de datos → no vacío (mapa de sólo tiles; evita el flash pre-montaje)', () => {
  assert.equal(dataLayersEmpty([]), false)
})

test('una capa con 0 features → vacío (se muestra el mensaje)', () => {
  assert.equal(dataLayersEmpty([layer([])]), true)
})

test('una capa con datos → no vacío (se oculta el mensaje)', () => {
  assert.equal(dataLayersEmpty([layer([{ id: 1 }])]), false)
})

test('varias capas: vacío sólo si TODAS están vacías', () => {
  assert.equal(dataLayersEmpty([layer([]), layer([])]), true)
  assert.equal(dataLayersEmpty([layer([]), layer([{ id: 1 }])]), false)
})

test('relee el snapshot: la misma capa transiciona 0→N features (muestra→oculta)', () => {
  let items = []
  const el = { controls: { source: { getSnapshot: () => items } } }
  assert.equal(dataLayersEmpty([el]), true)    // 0 features → vacío
  items = [{ id: 1 }]
  assert.equal(dataLayersEmpty([el]), false)   // llegaron datos → no vacío
})

test('handle sin Source no aporta features (getSnapshot ausente → tratado como vacío)', () => {
  // El componente FILTRA estas capas en cristaeLayerMounted (no entran a #dataLayers); acá se documenta
  // que el predicado, si igual recibiera una, no la cuenta como "con datos".
  assert.equal(dataLayersEmpty([{ controls: {} }]), true)
})
