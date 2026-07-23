// Tests de RENDER del binding con un árbol React real (react-dom/client sobre jsdom). Prueban las tres
// garantías que definen el paquete:
//   (a) el DATO entra por PROPIEDAD y los escalares por ATRIBUTO;
//   (b) 🔴 cambiar `data` re-asigna la propiedad SIN reconciliar los hijos React (no hay hot-path por React);
//   (c) un handler `onX` se cablea con addEventListener(cristae:*) y se limpia al desmontar.
// No registramos los custom elements de la lib: un `<cristae-map>` sin definir es un elemento genérico,
// suficiente para observar lo que el binding le aplica (atributos / propiedades / listeners).

import './setup-jsdom.mjs'   // primero: puebla los globals DOM antes de que react-dom se evalúe
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement as e, act, memo } from 'react'
import { createRoot } from 'react-dom/client'
import { CristaeMap, CristaePointLayer } from '../src/index.js'

const accessors = { idOf: (d) => d.id, positionOf: (d) => ({ lat: d.lat, lng: d.lng }) }

// Monta un árbol en un contenedor nuevo; devuelve el contenedor y un unmount envuelto en act().
function mount(element) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => root.render(element))
  return { container, root, rerender: (el) => act(() => root.render(el)), unmount: () => act(() => root.unmount()) }
}

test('(a) el dato entra por PROPIEDAD; los escalares del map por ATRIBUTO', () => {
  const data = [{ id: 1, lat: 0, lng: 0 }]
  const { container, unmount } = mount(
    e(CristaeMap, { initialZoom: 5, emptyMessage: 'sin datos' },
      e(CristaePointLayer, { data, accessors }),
    ),
  )
  const mapEl = container.querySelector('cristae-map')
  const layerEl = container.querySelector('cristae-point-layer')
  assert.ok(mapEl && layerEl, 'ambos elementos montaron en el DOM')

  // El dato → propiedad del elemento (misma referencia), nunca atributo.
  assert.equal(layerEl.data, data, 'data se asignó como PROPIEDAD (misma ref)')
  assert.equal(layerEl.accessors, accessors, 'accessors se asignó como PROPIEDAD')
  assert.equal(layerEl.getAttribute('data'), null, 'data NO es atributo')
  assert.equal(layerEl.getAttribute('accessors'), null, 'accessors NO es atributo')
  // Y no se materializó como nodos hijos (el dato no pasa por el árbol React).
  assert.equal(layerEl.childElementCount, 0, 'data no se volcó a hijos DOM')

  // Los escalares del map → atributos kebab-case.
  assert.equal(mapEl.getAttribute('initial-zoom'), '5', 'initialZoom → atributo initial-zoom')
  assert.equal(mapEl.getAttribute('empty-message'), 'sin datos', 'emptyMessage → atributo empty-message')

  unmount()
})

test('(b) cambiar `data` re-asigna la propiedad SIN re-renderizar los hijos React', () => {
  let spyRenders = 0
  // memo sin props: bailea cuando su padre re-renderiza → cualquier re-render del Spy vendría de que
  // el dato se metió por el árbol React (estado reconciliado), no del binding.
  const Spy = memo(function Spy() { spyRenders++; return e('span', { 'data-spy': '' }, 'x') })

  const dataA = [{ id: 1, lat: 0, lng: 0 }]
  const dataB = [{ id: 1, lat: 1, lng: 1 }, { id: 2, lat: 2, lng: 2 }]   // NUEVA ref, más ítems

  const Harness = ({ data }) =>
    e(CristaeMap, null, e(CristaePointLayer, { data, accessors }, e(Spy)))

  const { container, rerender, unmount } = mount(e(Harness, { data: dataA }))
  const layerEl = container.querySelector('cristae-point-layer')
  assert.equal(layerEl.data, dataA, 'primer dato por propiedad')
  assert.equal(spyRenders, 1, 'el hijo React renderizó una vez al montar')

  rerender(e(Harness, { data: dataB }))   // tick del feed: nueva referencia de data
  assert.equal(layerEl.data, dataB, 'la nueva referencia se re-asignó por propiedad')
  assert.equal(layerEl.childElementCount, 1, 'el subárbol del hijo NO creció con la longitud del dato (data no es hijo)')
  assert.equal(spyRenders, 1, '🔴 el hijo React NO se re-renderizó por el cambio de data (sin reconciliación en el hot-path)')

  unmount()
})

test('(c) onViewportChange → addEventListener(cristae:viewportchange), y se limpia al desmontar', () => {
  const details = []
  const onViewportChange = (ev) => details.push(ev?.detail)

  const { container, unmount } = mount(e(CristaeMap, { onViewportChange }))
  const mapEl = container.querySelector('cristae-map')
  assert.ok(mapEl, 'map montó')

  // Si está cableado por addEventListener del evento mapeado, despachar el CustomEvent lo dispara.
  mapEl.dispatchEvent(new CustomEvent('cristae:viewportchange', { detail: { zoom: 9 } }))
  assert.equal(details.length, 1, 'el listener se disparó (addEventListener del evento cristae:*)')
  assert.deepEqual(details[0], { zoom: 9 }, 'recibe el CustomEvent con su detail')

  unmount()   // el teardown debe soltar el listener
  mapEl.dispatchEvent(new CustomEvent('cristae:viewportchange', { detail: { zoom: 10 } }))
  assert.equal(details.length, 1, 'tras desmontar, el handler ya no recibe eventos (se limpió el listener)')
})
