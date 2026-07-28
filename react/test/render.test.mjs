// Tests de RENDER del binding con un árbol React real (react-dom/client sobre jsdom). Prueban las
// garantías que definen el paquete:
//   (a) el DATO entra por PROPIEDAD y los escalares por ATRIBUTO;
//   (b) 🔴 cambiar `data` re-asigna la propiedad SIN reconciliar los hijos React (no hay hot-path por React);
//   (c) un handler `onX` se cablea con addEventListener(cristae:*) y se limpia al desmontar;
//   (d) los handlers del BUS del motor se suscriben por engine.on (filtrados por capa), NO por el DOM;
//   (e) el `ref` publica el elemento vivo sin romper la aplicación de props.
// No registramos los custom elements de la lib: un `<cristae-map>` sin definir es un elemento genérico,
// suficiente para observar lo que el binding le aplica (atributos / propiedades / listeners).

import './setup-jsdom.mjs'   // primero: puebla los globals DOM antes de que react-dom se evalúe
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement as e, act, createRef, memo } from 'react'
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

test('(d) los canales del BUS van por engine.on (filtrados por capa) y se dan de baja al desmontar', () => {
  const subs = []
  // Motor fake: registra cada suscripción y devuelve su baja.
  const engine = { on: (channel, layerId, cb) => { const s = { channel, layerId, cb, bajas: 0 }; subs.push(s); return () => s.bajas++ } }
  const recibidos = []

  const { container, unmount } = mount(
    e(CristaeMap, { onSecondaryClick: (hits) => recibidos.push(hits) },
      e(CristaePointLayer, { id: 'fleet', data: [], accessors, onClick: (hits) => recibidos.push(hits) }),
    ),
  )
  const mapEl = container.querySelector('cristae-map')
  const layerEl = container.querySelector('cristae-point-layer')

  // No se filtraron al elemento: ni como propiedad ni como listener DOM (`cristae:click` en una capa
  // no existe — lo emite el mapa y burbujea hacia arriba).
  assert.equal(layerEl.onClick, undefined, 'onClick NO se asignó como propiedad de la capa')
  layerEl.dispatchEvent(new CustomEvent('cristae:click', { detail: { hits: [] } }))
  assert.equal(recibidos.length, 0, 'ningún listener DOM cableado para un canal de bus')
  assert.equal(subs.length, 0, 'sin motor todavía no hay suscripción')

  // El motor aparece con el montaje; `cristae:ready` (re)cabla — tras un re-mount es OTRA instancia.
  mapEl.engine = engine
  mapEl.dispatchEvent(new CustomEvent('cristae:ready', { detail: {} }))
  const click = subs.find((s) => s.channel === 'click')
  const secundario = subs.find((s) => s.channel === 'secondary-click')
  assert.equal(subs.length, 2, 'una suscripción por canal declarado')
  assert.equal(click.layerId, 'fleet', 'el canal de la capa se filtra por su layerId')
  assert.equal(secundario.layerId, null, 'el canal del mapa escucha todas las capas')

  click.cb([{ layerId: 'fleet', id: 1 }], null)
  assert.deepEqual(recibidos, [[{ layerId: 'fleet', id: 1 }]], 'el handler recibe los hits DIRECTOS (sin detail)')

  unmount()
  assert.deepEqual(subs.map((s) => s.bajas), [1, 1], 'ambas suscripciones se dieron de baja al desmontar')
})

test('(f) una capa sin `id` no se suscribe: el bus sólo trata `null` como "todas las capas"', () => {
  const subs = []
  const engine = { on: (channel, layerId, cb) => { subs.push({ channel, layerId, cb }); return () => {} } }

  const { container } = mount(
    e(CristaeMap, null, e(CristaePointLayer, { data: [], accessors, onClick: () => {} })),
  )
  const mapEl = container.querySelector('cristae-map')
  const layerEl = container.querySelector('cristae-point-layer')
  assert.equal(layerEl.id, '', 'sin `id` declarado el DOM devuelve cadena vacía, no undefined')

  mapEl.engine = engine
  mapEl.dispatchEvent(new CustomEvent('cristae:ready', { detail: {} }))
  assert.equal(subs.length, 0, 'filtrar por "" no matchearía ninguna capa: la suscripción sería muda')

  // Ya montada, el id sale del handle vivo (la capa lo auto-generó) y recién ahí se cabla.
  layerEl.controls = { id: 'point-7' }
  mapEl.dispatchEvent(new CustomEvent('cristae:ready', { detail: {} }))
  assert.deepEqual(subs.map((s) => s.layerId), ['point-7'], 'el handle vivo habilita la suscripción')
})

test('(e) el `ref` publica el elemento vivo y las props se siguen aplicando', () => {
  const ref = createRef()
  const { container, unmount } = mount(e(CristaeMap, { ref, initialZoom: 7 }))
  const mapEl = container.querySelector('cristae-map')

  assert.equal(ref.current, mapEl, 'el ref del consumidor apunta al <cristae-map>')
  assert.equal(mapEl.getAttribute('initial-zoom'), '7', 'el ref interno del hook sigue aplicando las props')

  unmount()
  assert.equal(ref.current, null, 'React lo anula al desmontar')
})
