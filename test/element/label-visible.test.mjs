// (A) Footgun de `visible` inicial en las capas declarativas. Dos garantías:
//   1. <cristae-label-layer> monta con el `visible` DECLARADO: los rótulos del host, o la capa de texto, nacen
//      ocultos si la capa se declaró oculta, y el handle y la prop los encienden y apagan después.
//   2. base.updated(): en el montaje DIFERIDO (motor + config coinciden recién en ese ciclo) se
//      aplica el diff inicial (`syncLayer(changed)`) en vez de retornar sin aplicarlo, y se avisa al
//      mapa contenedor (`_announce`).
// Sin DOM real ni customElements: se ejercita el código REAL por métodos prestados del prototipo
// sobre un `this` falso (los campos de base son `_handle`/`_engine`, no privados #, así que prestar
// funciona). Corre con: node --test test/element/label-visible.test.mjs
import '../../test-helpers/element-stub.mjs'   // window/document y lo que Lit toca al evaluar: PRIMERO
import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { CristaeLabelLayer } from '../../src/element/CristaeLabelLayer.js'

mock.method(console, 'warn', () => {})

// Motor falso: el host existe, y `addLabels` y `addTextLayer` anotan su alta y lo que pasa por su handle.
function fakeEngine() {
  const e = {
    altas: [], updates: [], visibles: [],
    getLayer: () => ({ kind: 'point' }),
    addLabels(cfg) {
      e.altas.push(cfg)
      return { update: o => e.updates.push(o), remove() {} }
    },
    addTextLayer(cfg) {
      e.altas.push(cfg)
      return { id: cfg.id, update: o => e.updates.push(o), setVisible: v => e.visibles.push(v) }
    },
    removeLayer() {},
  }
  return e
}

// Label falsa: hereda los métodos REALES del prototipo (mountLayer/syncLayer/updated) y expone sólo
// los campos que esos métodos tocan. `_enclosingModifier` se pisa para no recorrer la gramática/DOM.
function fakeLabel({ visible, engine, bindTo = 'host', source }) {
  const el = Object.create(CristaeLabelLayer.prototype)
  el.id = 'lbl'
  el.visible = visible
  el.bindTo = bindTo
  el.source = source
  el.accessors = undefined
  el.textOf = undefined
  el.paint = undefined
  el.style = undefined
  el._engine = engine
  el._handle = null
  el._enclosingModifier = () => null
  return el
}

test('mountLayer con visible=false liga los rótulos ya ocultos', () => {
  const engine = fakeEngine()
  fakeLabel({ visible: false, engine }).mountLayer(engine)
  assert.equal(engine.altas.at(-1).visible, false)
  assert.equal(engine.altas.at(-1).hostId, 'host')
})

test('mountLayer con visible=true los liga visibles', () => {
  const engine = fakeEngine()
  fakeLabel({ visible: true, engine }).mountLayer(engine)
  assert.equal(engine.altas.at(-1).visible, true)
})

test('con source propio, la capa de texto nace con el visible declarado y el handle la alterna', () => {
  const engine = fakeEngine()
  const el     = fakeLabel({ visible: false, engine, bindTo: null, source: {} })
  el._handle   = el.mountLayer(engine)
  assert.equal(engine.altas.at(-1).visible, false)
  assert.equal(engine.altas.at(-1).id, 'lbl')
  el._handle.setVisible(true)
  assert.deepEqual(engine.visibles, [true])
})

test('montaje DIFERIDO (base.updated) honra visible=false inicial', () => {
  const engine = fakeEngine()
  const el = fakeLabel({ visible: false, engine })   // _handle null, _engine presente, mountReady true
  const changed = new Map([['visible', undefined], ['bindTo', undefined]])
  el.updated(changed)                                 // CristaeLayerElement.prototype.updated (heredado)
  assert.ok(el._handle, 'montó el handle en updated()')
  assert.equal(engine.altas.at(-1).visible, false)
  assert.deepEqual(engine.updates, [{ visible: false }], 'el diff inicial no la enciende')
})

test('capa ya montada: cambiar visible a false se propaga por syncLayer', () => {
  const engine = fakeEngine()
  const el = fakeLabel({ visible: true, engine })
  el._handle = el.mountLayer(engine)       // ya montada (rama _handle de updated)
  el.visible = false
  el.updated(new Map([['visible', true]]))
  assert.deepEqual(engine.updates.at(-1), { visible: false })
})

test('montaje DIFERIDO avisa al mapa contenedor (cristaeLayerMounted)', () => {
  const engine = fakeEngine()
  const el = fakeLabel({ visible: true, engine })
  const mounted = []
  el.closest = (sel) => (sel === 'cristae-map' ? { cristaeLayerMounted: (l) => mounted.push(l) } : null)
  el.updated(new Map([['bindTo', undefined]]))
  assert.deepEqual(mounted, [el])
})

test('capa fuera de un mapa: _announce es no-op (no explota sin closest)', () => {
  const engine = fakeEngine()
  const el = fakeLabel({ visible: true, engine })     // sin closest en el fake
  assert.doesNotThrow(() => el.updated(new Map([['bindTo', undefined]])))
})
