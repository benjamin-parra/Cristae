// Contrato del sustrato `gpu` de líneas: el grosor sale de UN quad por segmento, no de la brocha de
// glify. Lo que se mide es el conteo de `drawArrays` — con la brocha, un trazo de 3 px paga `(4·1+1)² =
// 25` pasadas por feature y por frame; acá paga UNA por tramo, sea cual sea el grosor.
//
// El árbol es el REAL (EditSurface + RingStore + StrokePass); lo único doble es el navegador.
//
// El harness (engine-stub) shimea window/document — se importa PRIMERO.

import './../../test-helpers/engine-stub.mjs'
import { decorarElementos, makeGl, makeLeaflet, makeMap as makeMapStub, makePickSpy, makeSurface } from '../../test-helpers/engine-stub.mjs'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { LineGpuLayer } from '../../src/render/LineGpuLayer.js'
import { MapEngine } from '../../src/engine/MapEngine.js'
import { adoptLeafletHost } from '../../src/host/LeafletHost.js'

const WITH_STENCIL = () => ({ stencil: true })

const editGl = spy => {
  const gl = makeGl(() => spy.released++, spy, makeSurface())
  return new Proxy(gl, { get: (t, p) => (p === 'getContextAttributes' ? WITH_STENCIL : t[p]) })
}

const newSpy = () => Object.assign(makePickSpy(), { released: 0 })

let currentGl = null

after(decorarElementos((el, tag) => {
  if (tag !== 'canvas') return el
  const dispose = el.remove
  el.getContext = kind => (kind === 'webgl2' ? currentGl : null)
  el.remove     = () => {
    const at = el.pane?.children.indexOf(el) ?? -1
    at >= 0 && el.pane.children.splice(at, 1)
    dispose()
  }
  return el
}))

const makePane = () => {
  const pane = {
    style     : {},
    children  : [],
    connected : true,
    appendChild(child) { pane.children.push(child); child.pane = pane },
    remove()           { pane.connected = false },
  }
  return pane
}

const makeMap = () => {
  const listeners = new Map()
  const panes     = {}
  const each      = (types, fn) => String(types).split(/\s+/).forEach(fn)
  const map = Object.assign(makeMapStub(), {
    listeners,
    _panes     : panes,
    on(types, cb)      { each(types, t => (listeners.get(t) ?? listeners.set(t, new Set()).get(t)).add(cb)); return map },
    off(types, cb)     { each(types, t => listeners.get(t)?.delete(cb)); return map },
    fire(type, e = {}) { listeners.get(type)?.forEach(cb => cb(e)); return map },
    getPane    : name => panes[name] ?? null,
    createPane : name => (panes[name] = makePane()),
  })
  return map
}

const listenerCount = (map, ...types) => types.reduce((n, type) => n + (map.listeners.get(type)?.size ?? 0), 0)

/* ── Dato: un Source mínimo con el accessor que la capa consume ── */

const recorrido = (n, lat = 0, lng = 0) =>
  Array.from({ length: n }, (_, i) => [lat + i * 0.001, lng + i * 0.001])

const fakeSource = (items, styleOf = null) => ({
  accessors  : { pathOf: r => r.path, styleOf },
  getSnapshot: () => items,
  subscribe  : () => () => {},
})

const mount = ({ items = [{ id: 1, path: recorrido(50) }], styleOf = null, map = makeMap() } = {}) => {
  const spy = newSpy()
  currentGl = editGl(spy)
  const layer = new LineGpuLayer({ L: makeLeaflet(), map, pane: 'gpu-line', source: fakeSource(items, styleOf) })
  return { layer, map, spy }
}

// Los `drawArrays` de UN repintado, contados desde cero.
const drawsOf = (spy, run) => {
  spy.draws.length = 0
  run()
  return spy.draws.length
}

/* ── 1. El grosor no multiplica las pasadas ── */

test('un tramo son DOS draws (limpieza + trazo), sea cual sea el grosor', () => {
  const delgada = mount({ styleOf: () => ({ weight: 1 }) })
  const gruesa  = mount({ styleOf: () => ({ weight: 12 }) })
  const conUno  = drawsOf(delgada.spy, () => delgada.layer.redraw())
  const conDoce = drawsOf(gruesa.spy, () => gruesa.layer.redraw())
  assert.equal(conUno, conDoce, 'la brocha de glify pagaría (4w+1)²: 25 pasadas con 3px, 2209 con 12px')
  assert.equal(conUno, 1, 'un tramo = un drawArrays')
})

test('el conteo de draws no depende del largo del recorrido', () => {
  const corto = mount({ items: [{ id: 1, path: recorrido(10) }] })
  const largo = mount({ items: [{ id: 1, path: recorrido(10_000) }] })
  assert.equal(
    drawsOf(corto.spy, () => corto.layer.redraw()),
    drawsOf(largo.spy, () => largo.layer.redraw()),
    'los vértices van por textura: el trazo entero sale en una pasada',
  )
})

test('cada PARTE es su propia pasada (un track con baches no se une)', () => {
  const conBache = [{ id: 1, path: [[0, 0], [0, 0.001], [NaN, NaN], [0, 0.003], [0, 0.004]] }]
  const { layer, spy } = mount({ items: conBache })
  assert.equal(drawsOf(spy, () => layer.redraw()), 2, 'dos tramos → dos pasadas, sin recta fantasma entre ellos')
})

/* ── 2. Vista asentada, visibilidad y baja ── */

test('la vista asentada repinta: moveend, zoomend y resize', () => {
  const { map, spy } = mount()
  const porEvento = ['moveend', 'zoomend', 'resize'].map(type => drawsOf(spy, () => map.fire(type)))
  assert.deepEqual(porEvento, [1, 1, 1])
})

test('setVisible(false) deja de dibujar y setVisible(true) vuelve', () => {
  const { layer, spy } = mount()
  assert.equal(drawsOf(spy, () => layer.setVisible(false)), 0)
  assert.equal(drawsOf(spy, () => layer.redraw()), 0, 'oculta, un repintado pedido tampoco dibuja')
  assert.equal(drawsOf(spy, () => layer.setVisible(true)), 1)
})

test('destroy() desengancha del mapa y devuelve el contexto', () => {
  const { layer, map, spy } = mount()
  // La capa toma 'moveend zoomend resize'; su superficie suma los suyos del zoom animado.
  assert.ok(listenerCount(map, 'moveend', 'zoomend', 'resize') >= 3)
  layer.destroy()
  assert.equal(listenerCount(map, 'moveend', 'zoomend', 'resize', 'zoomanim'), 0, 'ni los de la superficie quedan')
  assert.equal(spy.released, 1, 'el techo de ~16 contextos es acumulativo: nadie devuelve uno solo')
})

test('set() reingiere y repinta', () => {
  const { layer, spy } = mount()
  assert.equal(drawsOf(spy, () => layer.set([{ id: 1, path: recorrido(5) }, { id: 2, path: recorrido(5, 1) }])), 2)
})

/* ── 3. El motor lo expone como sustrato, y rechaza lo que no sabe hacer ── */

test('addLineLayer({ backend: "gpu" }) monta el sustrato de quads, no el de glify', () => {
  const map    = makeMap()
  currentGl    = editGl(newSpy())
  // `glify: {}` no sabe montar nada: si el sustrato se resolviera al de siempre, esto reventaría.
  const engine = new MapEngine({ host: adoptLeafletHost(map, { leaflet: makeLeaflet() }), glify: {} })
  const handle = engine.addLineLayer({
    id: 'ruta',
    backend: 'gpu',
    accessors: { idOf: r => r.id, pathOf: r => r.path },
  })
  assert.equal(handle.id, 'ruta')
  assert.ok(engine.getLayer('ruta').layer instanceof LineGpuLayer)
})

test('pedir picking sobre el sustrato gpu falla RUIDOSO, no deja una capa muda', () => {
  const map    = makeMap()
  currentGl    = editGl(newSpy())
  const engine = new MapEngine({ host: adoptLeafletHost(map, { leaflet: makeLeaflet() }), glify: {} })
  assert.throws(
    () => engine.addLineLayer({ id: 'x', backend: 'gpu', interactive: true, accessors: { idOf: r => r.id, pathOf: r => r.path } }),
    /no resuelve picking/,
  )
})

test('un backend desconocido se rechaza nombrando los válidos', () => {
  const map    = makeMap()
  const engine = new MapEngine({ host: adoptLeafletHost(map, { leaflet: makeLeaflet() }), glify: {} })
  assert.throws(
    () => engine.addLineLayer({ id: 'x', backend: 'triangulos', accessors: { idOf: r => r.id, pathOf: r => r.path } }),
    /glify \| gpu \| leaflet/,
  )
})
