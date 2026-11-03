// <cristae-line-label-layer> sin DOM: los métodos reales del prototipo sobre un `this` falso, como
// label-visible.test.mjs. Qué recibe el alta, cuándo monta y qué llega a `handle.style`.
import '../../test-helpers/element-stub.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { CristaeLineLabelLayer } from '../../src/element/CristaeLineLabelLayer.js'

const fakeEngine = () => {
  const handle = { id: 'texto', styles: [], visibles: [], style(p) { handle.styles.push(p) }, setVisible(v) { handle.visibles.push(v) } }
  return { handle, cfg: null, addLineLabelLayer(cfg) { this.cfg = cfg; return handle }, removeLayer() {} }
}

const fakeLayer = (props = {}) => Object.assign(Object.create(CristaeLineLabelLayer.prototype), {
  id                 : 'texto',
  visible            : true,
  _engine            : null,
  _handle            : null,
  _enclosingModifier : () => null,
}, props)

test('firma: hoja que produce label, ligada a una línea', () => {
  assert.deepEqual(CristaeLineLabelLayer.cristaeSignature,
    { consumes: [], produces: ['label'], combine: null, arity: 'leaf', bindsTo: 'line' })
})

test('monta con bind-to o con source; sin ninguno, difiere', () => {
  assert.equal(fakeLayer().mountReady(), false)
  assert.equal(fakeLayer({ bindTo: 'rutas' }).mountReady(), true)
  assert.equal(fakeLayer({ source: {} }).mountReady(), true)
})

test('el alta recibe props, atributos mezclados sobre la prop style y visible', () => {
  const engine = fakeEngine()
  const textOf = r => r.nombre
  const el     = fakeLayer({
    bindTo : 'rutas', textOf, visible: false, repeat: 200, offset: -6, maxAngle: 30,
    style  : { color: '#123456', repeat: 50 },
  })
  el.mountLayer(engine)
  assert.equal(engine.cfg.bindTo, 'rutas')
  assert.equal(engine.cfg.textOf, textOf)
  assert.equal(engine.cfg.visible, false)
  assert.deepEqual(engine.cfg.style, { color: '#123456', repeat: 200, offset: -6, maxAngle: 30 })
})

test('montaje diferido: llega la config y monta en updated', () => {
  const engine = fakeEngine()
  const el     = fakeLayer({ _engine: engine })
  el.updated(new Map())
  assert.equal(el._handle, null)
  el.bindTo = 'rutas'
  el.updated(new Map([['bindTo', undefined]]))
  assert.equal(el._handle, engine.handle)
})

test('un cambio de repeat u offset llega a handle.style con el estilo mezclado', () => {
  const engine = fakeEngine()
  const el     = fakeLayer({ bindTo: 'rutas', _engine: engine, style: { color: 'red' } })
  el._handle = engine.handle
  el.repeat  = 120
  el.updated(new Map([['repeat', undefined]]))
  el.offset = 4
  el.updated(new Map([['offset', undefined]]))
  assert.deepEqual(engine.handle.styles, [{ color: 'red', repeat: 120 }, { color: 'red', repeat: 120, offset: 4 }])
})

test('un atributo quitado viaja como null, que devuelve la clave a su valor por defecto', () => {
  const engine = fakeEngine()
  const el     = fakeLayer({ bindTo: 'rutas', _engine: engine, repeat: null })
  el._handle = engine.handle
  el.updated(new Map([['repeat', 200]]))
  assert.deepEqual(engine.handle.styles, [{ repeat: null }])
})

test('visible y la prop style se reenvían; lo demás no toca el handle', () => {
  const engine = fakeEngine()
  const el     = fakeLayer({ bindTo: 'rutas', _engine: engine })
  el._handle = engine.handle
  el.visible = false
  el.updated(new Map([['visible', true]]))
  el.style = { font: '12px serif' }
  el.updated(new Map([['style', undefined]]))
  el.updated(new Map([['textOf', undefined]]))
  assert.deepEqual(engine.handle.visibles, [false])
  assert.deepEqual(engine.handle.styles, [{ font: '12px serif' }])
})
