// La costura que ningún test cubría: el ELEMENTO sobre el motor y el editor REALES. Cada lado estaba
// probado con el otro doblado —el editor con callbacks falsos, el elemento con un motor falso—, así que
// un click de mapa en modo `draw` nunca había atravesado la cadena entera hasta el CustomEvent.
//
// El harness (element-stub) shimea window/document y lo que Lit toca al evaluar — se importa PRIMERO.

import '../../test-helpers/element-stub.mjs'
import { conGlDeEdicion, makeEditGl, makeLeaflet, makeMap as makeMapStub, makePickSpy, makeSurface } from '../../test-helpers/engine-stub.mjs'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { CristaeEditablePolyline } from '../../src/element/CristaeEditablePolyline.js'
import { MapEngine } from '../../src/engine/MapEngine.js'
import { adoptLeafletHost } from '../../src/host/LeafletHost.js'

// `conGlDeEdicion` da el webgl2 del doble Y un 2D no-op: el atlas de handles rasteriza al montar.
let currentGl = null
after(conGlDeEdicion(() => currentGl))

const makePane = () => ({
  style: {}, children: [], appendChild(c) { this.children.push(c); c.pane = this }, remove() {},
})

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

// El elemento REAL sobre el motor REAL: sólo se le prestan los campos que la base usa.
const montarElemento = ({ mode = 'draw', value = [] } = {}) => {
  const map = makeMap()
  currentGl = makeEditGl(makePickSpy(), makeSurface())
  const engine = new MapEngine({ host: adoptLeafletHost(map, { leaflet: makeLeaflet() }) })

  const el = Object.create(CristaeEditablePolyline.prototype)
  el.id = 'ruta'
  el.mode = mode
  el.value = value
  el.geometryStyle = undefined
  el._engine = engine
  el._handle = null
  el._eco = null
  el.eventos = []
  el.dispatchEvent = (ev) => el.eventos.push(ev)
  el._enclosingModifier = () => null
  el._handle = el.mountLayer(engine)
  return { el, map, engine }
}

// El click del mapa: una pulsación quieta en el píxel de la posición, que el doble proyecta a coord·100.
const clickMapa = (map, lat, lng) => ['pointerdown', 'pointerup'].forEach(tipo =>
  map.getContainer().emitir(tipo, { clientX: lng * 100, clientY: lat * 100 }))

const ultimo = (el, tipo) => el.eventos.filter(e => e.type === tipo).at(-1)

test('draw: un click de mapa llega hasta cristae:commit con el punto', () => {
  const { el, map } = montarElemento()

  clickMapa(map, 1, 2)

  const commit = ultimo(el, 'cristae:commit')
  assert.ok(commit, 'el click no produjo ningún cristae:commit')
  assert.deepEqual(commit.detail.value, [[1, 2]], 'el commit tiene que traer el vértice recién agregado')
})

test('draw: los clicks sucesivos acumulan, arrancando de un valor VACÍO', () => {
  const { el, map } = montarElemento({ value: [] })

  clickMapa(map, 1, 2)
  clickMapa(map, 3, 4)

  assert.deepEqual(ultimo(el, 'cristae:commit').detail.value, [[1, 2], [3, 4]])
})

test('draw: el eco queda fijado por la LECTURA del host, no por la emisión', () => {
  const { el, map } = montarElemento()

  clickMapa(map, 1, 2)
  const leido = ultimo(el, 'cristae:commit').detail.value
  assert.equal(el._eco, leido, 'devolver ese mismo array como `value` no debe reingerir')
})
