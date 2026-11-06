// <cristae-text-layer>: monta con accessors o Source, el alta lleva las opciones de los rótulos y las de la
// capa, los cambios llegan por el handle y su firma es una hoja que produce `text`. Sin DOM real ni
// customElements: el código REAL se presta del prototipo sobre un `this` falso, como image-layer.test.mjs.
import '../../test-helpers/element-stub.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { CristaeTextLayer } from '../../src/element/CristaeTextLayer.js'
import { STACK } from '../../src/engine/stack.js'
import { defineGrammar } from '../../src/grammar/index.js'
import { grammar } from '../../src/element/composite.js'

const puntos = { idOf: c => c.id, positionOf: c => c }

const motorFalso = () => {
  const llamadas = []
  const anotar   = nombre => valor => llamadas.push([nombre, valor])
  const handle   = { id: 'ciudades', set: anotar('set'), update: anotar('update'), setVisible: anotar('setVisible') }
  return {
    llamadas, cfg: null,
    addTextLayer(cfg) { this.cfg = cfg; return handle },
    attachSource: (id, source) => llamadas.push(['attachSource', [id, source]]),
    removeLayer() {},
  }
}

const capa = (props = {}) => Object.assign(Object.create(CristaeTextLayer.prototype), {
  id: 'ciudades', interactive: false, visible: true,
  _handle: null, _engine: null,
  _enclosingModifier: () => null,
  closest: () => null,
}, props)

const cambios = (...claves) => new Map(claves.map(k => [k, undefined]))

test('es una hoja que produce text, y una gramática que declara el kind la acepta', () => {
  assert.deepEqual(CristaeTextLayer.cristaeSignature, { role: 'leaf', produces: ['text'] })
  const g = defineGrammar({ kinds: [...grammar.kinds, 'text'] })
  assert.doesNotThrow(() => g.register('cristae-text-layer', CristaeTextLayer.cristaeSignature))
})

test('sin accessors ni source no monta; con accessors, en el próximo ciclo', () => {
  const engine = motorFalso()
  const el     = capa({ _engine: engine })
  el.updated(cambios('data'))
  assert.equal(el._handle, null)
  el.accessors = puntos
  el.updated(cambios('accessors'))
  assert.ok(el._handle)
  assert.equal(engine.cfg.accessors, puntos)
})

test('el alta lleva lo declarado; visible="false" llega apagado', () => {
  const engine = motorFalso()
  const textOf = c => c.nombre
  const el     = capa({ accessors: puntos, data: [], textOf, placement: 'above', offset: 2, renderer: 'canvas', interactive: true, visible: 'false' })
  el.mountLayer(engine)
  const { [STACK]: lugar, ...cfg } = engine.cfg
  assert.equal(lugar, el, 'el alta lleva el elemento para apilar por su lugar en el documento')
  assert.deepEqual(cfg, {
    id: 'ciudades', source: undefined, data: [], accessors: puntos, interactive: true, visible: false,
    textOf, htmlOf: undefined, renderer: 'canvas', placement: 'above', offset: 2,
    font: undefined, color: undefined, halo: undefined, paint: undefined,
  })
})

test('los cambios llegan por el handle: datos, Source, visible y las opciones, con null al quitarlas', () => {
  const engine = motorFalso()
  const el     = capa({ accessors: puntos, placement: 'above' })
  el._engine   = engine
  el._handle   = el.mountLayer(engine)

  const datos = [{ id: 'a' }]
  const otra  = { accessors: puntos }
  Object.assign(el, { data: datos, visible: false, placement: undefined, color: '#f00' })
  el.syncLayer(cambios('data', 'visible', 'placement', 'color'))
  el.source = otra
  el.syncLayer(cambios('source', 'data'))
  assert.deepEqual(engine.llamadas, [
    ['set', datos],
    ['setVisible', false],
    ['update', { placement: null, color: '#f00' }],
    ['attachSource', ['ciudades', otra]],
  ])
})

test('sin id propio toma uno automático y estable', () => {
  const el = capa({ id: '' })
  assert.match(el.layerId(), /text/)
  assert.equal(el.layerId(), el.layerId())
})
