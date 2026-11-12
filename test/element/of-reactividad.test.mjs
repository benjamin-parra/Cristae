// Qué atributo -of es reactivo: `variant-of` y `heading-of` sí, con un cierre estable que lee el nombre del campo
// al llamarse más `refresh()`; `id-of` no (se lee al montar). Un montaje diferido no repinta por el estado inicial,
// y la función del consumidor, que no tiene cierre propio, tampoco.
import '../../test-helpers/element-stub.mjs'
import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { CristaePointLayer } from '../../src/element/CristaePointLayer.js'

const cambios = (...claves) => new Map(claves.map(k => [k, undefined]))

const montada = (props = {}) => {
  const llamadas = []
  const handle = { id: 'capa', refresh: () => llamadas.push('refresh'), reload: () => llamadas.push('reload'), setVisible() {}, setEnabled() {}, setWhere() {}, set() {} }
  const engine = { cfg: null, addPointLayer(cfg) { this.cfg = cfg; return handle }, on: () => () => {}, removeLayer() {} }
  const el = Object.assign(Object.create(CristaePointLayer.prototype), {
    id: 'capa', interactive: false, visible: true, enabled: true, _handle: null, _engine: engine,
    _enclosingModifier: () => null, closest: () => null, dispatchEvent: () => true,
  }, props)
  el._handle = el.mountLayer(engine)
  return { el, engine, llamadas }
}

test('variant-of cambiado repinta con el nombre nuevo, sin cambiar la identidad del cierre', () => {
  const { el, engine, llamadas } = montada({ url: 'x', variantOf: 'estado' })
  const cierre = engine.cfg.accessors.variantOf
  assert.equal(cierre({ estado: 'a', tipo: 'b' }), 'a')

  el.variantOf = 'tipo'
  el.syncLayer(cambios('variantOf'))
  assert.deepEqual(llamadas, ['refresh'])
  assert.equal(cierre({ estado: 'a', tipo: 'b' }), 'b', 'el mismo cierre lee el campo nuevo')
})

test('heading-of cambiado repinta; quitarlo vuelve al neutro', () => {
  const { el, engine, llamadas } = montada({ url: 'x', headingOf: 'rumbo' })
  const cierre = engine.cfg.accessors.headingOf
  assert.equal(cierre({ rumbo: 30 }), 30)
  el.headingOf = undefined
  el.syncLayer(cambios('headingOf'))
  assert.deepEqual(llamadas, ['refresh'])
  assert.equal(cierre({ rumbo: 30 }), 0)
})

test('el estado inicial de un montaje diferido no repinta', () => {
  const { el, llamadas } = montada({ url: 'x', variantOf: 'estado', headingOf: 'rumbo' })
  el.syncLayer(cambios('variantOf', 'headingOf', 'url'))
  assert.deepEqual(llamadas, [])
})

test('cambiar los dos canales a la vez repinta una sola vez', () => {
  const { el, llamadas } = montada({ url: 'x', variantOf: 'a', headingOf: 'b' })
  el.variantOf = 'c'
  el.headingOf = 'd'
  el.syncLayer(cambios('variantOf', 'headingOf'))
  assert.deepEqual(llamadas, ['refresh'])
})

test('con una función en accessors no hay cierre propio: cambiar el atributo no repinta', () => {
  const variantOf = () => 'v'
  const { el, engine, llamadas } = montada({ accessors: { variantOf }, variantOf: 'estado' })
  const w = mock.method(console, 'warn', () => {})
  el.variantOf = 'otro'
  el.syncLayer(cambios('variantOf'))
  w.mock.restore()
  assert.equal(engine.cfg.accessors.variantOf, variantOf)
  assert.deepEqual(llamadas, [])
})

test('id-of no es reactivo: un cambio tras montar sólo avisa, no recarga ni repinta', () => {
  const w = mock.method(console, 'warn', () => {})
  const { el, engine, llamadas } = montada({ url: 'x', idOf: 'a' })
  const antes = engine.cfg.accessors.idOf
  el.idOf = 'b'
  el.syncLayer(cambios('idOf'))
  assert.deepEqual(llamadas, [])
  assert.equal(antes({ a: 1, b: 2 }), 1, 'el lector sigue siendo el del montaje')
  assert.equal(w.mock.callCount(), 1)
  w.mock.restore()
})

test('un -of declarado después de montar, sin cierre, avisa una vez que se lee al montar y no repinta', () => {
  const w = mock.method(console, 'warn', () => {})
  const { el, engine, llamadas } = montada({ url: 'x' })
  assert.equal(engine.cfg.accessors?.variantOf, undefined)
  el.variantOf = 'estado'
  el.syncLayer(cambios('variantOf'))
  el.variantOf = 'tipo'
  el.syncLayer(cambios('variantOf'))
  const avisos = w.mock.calls.map(c => c.arguments[0])
  w.mock.restore()
  assert.deepEqual(llamadas, [])
  assert.equal(avisos.length, 1)
  assert.match(avisos[0], /variantOf.*no estaba declarado al montar/)
})
