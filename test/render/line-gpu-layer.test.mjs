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
  const panes = {}
  return Object.assign(makeMapStub(), {
    _panes     : panes,
    getPane    : name => panes[name] ?? null,
    createPane : name => (panes[name] = makePane()),
  })
}

/* ── Dato: un Source mínimo con el accessor que la capa consume ── */

const recorrido = (n, lat = 0, lng = 0) =>
  Array.from({ length: n }, (_, i) => [lat + i * 0.001, lng + i * 0.001])

const fakeSource = (items, styleOf = null) => ({
  accessors  : { pathOf: r => r.path, styleOf },
  getSnapshot: () => items,
  subscribe  : () => () => {},
})

const mount = ({ items = [{ id: 1, path: recorrido(50) }], styleOf = null, map = makeMap(), envolver = gl => gl } = {}) => {
  const spy = newSpy()
  currentGl = envolver(editGl(spy))
  const layer = new LineGpuLayer({ host: adoptLeafletHost(map), pane: 'gpu-line', source: fakeSource(items, styleOf) })
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

/* ── 1b. dash y tapa: cada tramo lleva el suyo ── */

// Lo que el trazo le pide a la GPU en cada draw: patrón y tapa vigentes en ese instante.
const espiarTrazos = () => {
  const uniform = {}
  const trazos  = []
  const propio  = {
    getUniformLocation : (_programa, nombre) => ({ nombre }),
    uniform1i          : (loc, v) => (uniform[loc.nombre] = v),
    drawArrays         : () => trazos.push({ dashCount: uniform.dashCount, cap: uniform.cap }),
  }
  return { trazos, envolver: gl => new Proxy(gl, { get: (t, p) => propio[p] ?? t[p] }) }
}

test('el dash y la tapa de styleOf llegan al trazo, y un tramo sin ellos no hereda los del anterior', () => {
  const items = [
    { id: 1, path: recorrido(5),    estilo: { dash: [6, 6], cap: 'round' } },
    { id: 2, path: recorrido(5, 1), estilo: { weight: 2 } },
    { id: 3, path: recorrido(5, 2), estilo: { dash: [1, 6, 1], cap: 'square' } },
  ]
  const { trazos, envolver } = espiarTrazos()
  const { layer } = mount({ items, styleOf: item => item.estilo, envolver })
  trazos.length = 0
  layer.redraw()
  assert.deepEqual(trazos, [
    { dashCount: 2, cap: 1 },
    { dashCount: 0, cap: 0 },
    { dashCount: 6, cap: 2 },
  ])
})

test('un patrón mutado en sitio y publicado con set se vuelve a leer', () => {
  const patron = [8, 6]
  const items  = [{ id: 1, path: recorrido(5), estilo: { dash: patron } }]
  const { trazos, envolver } = espiarTrazos()
  const { layer } = mount({ items, styleOf: item => item.estilo, envolver })
  layer.redraw()
  patron.push(2)
  trazos.length = 0
  layer.set(items)
  assert.deepEqual(trazos.map(t => t.dashCount), [6], '[8, 6, 2] se repite: seis valores')
})

test('el dash no cambia el conteo de draws: sigue siendo uno por tramo', () => {
  const items = [{ id: 1, path: recorrido(50), estilo: { dash: [1, 6], cap: 'round' } }]
  const { layer, spy } = mount({ items, styleOf: item => item.estilo })
  assert.equal(drawsOf(spy, () => layer.redraw()), 1)
})

// El patrón se comprueba al resolver el estilo: el error sale de quien cargó los datos, no de un
// repintado que corre dentro del ciclo de vista y cortaría a los demás oyentes.
test('un patrón que no cabe lanza al cargar los datos y deja la capa como estaba', () => {
  const largo = [{ id: 2, path: recorrido(5), estilo: { dash: Array(18).fill(1) } }]
  assert.throws(() => mount({ items: largo, styleOf: item => item.estilo }), RangeError, 'el alta')
  const { layer, map, spy } = mount({ styleOf: item => item.estilo })
  const subidas = spy.texImages.length
  assert.throws(() => layer.set(largo), RangeError)
  assert.equal(spy.texImages.length, subidas, 'el store no se rehízo')
  assert.equal(drawsOf(spy, () => map.fire('moveend')), 1, 'la vista sigue repintando el recorrido de antes')
})

// Por el motor los datos entran por el Source, que reparte a sus suscriptores aislados: el error sale
// por el reporte del Source, no al llamador, y la capa sigue dibujando lo que tenía.
test('por el motor, un patrón que no cabe se reporta desde el Source y la capa conserva lo anterior', async t => {
  const errores  = []
  const original = console.error
  console.error = (...a) => errores.push(a)
  t.after(() => (console.error = original))
  const spy = newSpy()
  currentGl = editGl(spy)
  const engine = new MapEngine({ host: adoptLeafletHost(makeMap(), { leaflet: makeLeaflet() }), glify: {} })
  const handle = engine.addLineLayer({
    id       : 'ruta',
    backend  : 'gpu',
    data     : [{ id: 1, path: recorrido(5) }],
    accessors: { idOf: r => r.id, pathOf: r => r.path, styleOf: r => r.estilo },
  })
  const reparto = () => new Promise(resolve => setTimeout(resolve, 5))
  await reparto()
  assert.doesNotThrow(() => handle.set([{ id: 2, path: recorrido(5), estilo: { dash: Array(18).fill(1) } }]))
  await reparto()
  assert.match(String(errores[0]?.[1]), /hasta 16 valores/)
  assert.equal(drawsOf(spy, () => engine.getLayer('ruta').layer.redraw()), 1, 'el recorrido de antes')
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

test('destroy() desengancha del ciclo de vista, suelta su pane y devuelve el contexto', () => {
  const { layer, map, spy } = mount()
  layer.destroy()
  const porEvento = ['moveend', 'zoomend', 'resize'].map(type => drawsOf(spy, () => map.fire(type)))
  assert.deepEqual(porEvento, [0, 0, 0], 'una vista asentada ya no la repinta')
  assert.equal(map.getPane('gpu-line'), null, 'el pane se va con la superficie, que era la única que lo sostenía')
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
    /glify \| gpu/,
  )
})

// `leaflet` fue un sustrato de líneas: pedirlo ahora no cae en silencio al de glify.
test("`backend: 'leaflet'` ya no existe: se rechaza como cualquier desconocido", () => {
  const engine = new MapEngine({ host: adoptLeafletHost(makeMap(), { leaflet: makeLeaflet() }), glify: {} })
  assert.throws(
    () => engine.addLineLayer({ id: 'x', backend: 'leaflet', accessors: { idOf: r => r.id, pathOf: r => r.path } }),
    /backend de líneas desconocido 'leaflet'/,
  )
})

// `vector` fue el flag del sustrato con dash: pedirlo no cae en silencio a glify, que no lo dibuja.
test('`vector` ya no existe: se rechaza nombrando su reemplazo', () => {
  const engine = new MapEngine({ host: adoptLeafletHost(makeMap(), { leaflet: makeLeaflet() }), glify: {} })
  assert.throws(
    () => engine.addLineLayer({ id: 'x', vector: true, accessors: { idOf: r => r.id, pathOf: r => r.path } }),
    /backend: 'gpu'/,
  )
})
