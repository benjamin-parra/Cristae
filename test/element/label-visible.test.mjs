// (A) Footgun de `visible` inicial en las capas declarativas. Dos garantías:
//   1. CristaeLabelLayer.mountLayer honra el `visible` DECLARADO por el handle (el alta del motor
//      siempre nace visible e ignora `visible` de cfg → una label declarada oculta parpadearía).
//   2. base.updated(): en el montaje DIFERIDO (motor + config coinciden recién en ese ciclo) se
//      aplica el diff inicial (`syncLayer(changed)`) en vez de retornar sin aplicarlo, y se avisa al
//      mapa contenedor (`_announce`).
// Sin DOM real ni customElements: se ejercita el código REAL por métodos prestados del prototipo
// sobre un `this` falso (los campos de base son `_handle`/`_engine`, no privados #, así que prestar
// funciona). Corre con: node --test test/element/label-visible.test.mjs
import '../../test-helpers/engine-stub.mjs'   // window/document (documentElement.style) para evaluar Leaflet/Lit
import test from 'node:test'
import assert from 'node:assert/strict'

// Extensiones locales del stub para que lit-html/node evalúe (imports DINÁMICOS tras montar los shims,
// porque los `import` estáticos se hoisten y correrían antes de estas asignaciones).
globalThis.HTMLElement ??= class {}
globalThis.customElements ??= { define() {}, get() {}, whenDefined() { return Promise.resolve() } }
globalThis.document.createTreeWalker ??= () => ({ currentNode: null, nextNode() { return null } })
globalThis.document.createDocumentFragment ??= () => ({ appendChild() {} })
globalThis.document.createTextNode ??= (t) => ({ data: String(t) })

const { CristaeLabelLayer } = await import('../../src/element/CristaeLabelLayer.js')

// Motor falso: addLabelLayer registra la cfg y devuelve un handle que apunta sus setVisible.
function fakeEngine() {
  const handle = { id: 'lbl', visibleCalls: [], setVisible(v) { handle.visibleCalls.push(v) } }
  return {
    handle,
    lastCfg: null,
    addLabelLayer(cfg) { this.lastCfg = cfg; return handle },
    removeLayer() {},
  }
}

// Label falsa: hereda los métodos REALES del prototipo (mountLayer/syncLayer/updated) y expone sólo
// los campos que esos métodos tocan. `_enclosingModifier` se pisa para no recorrer la gramática/DOM.
function fakeLabel({ visible, engine }) {
  const el = Object.create(CristaeLabelLayer.prototype)
  el.id = 'lbl'
  el.visible = visible
  el.bindTo = 'host'          // mountReady() === true
  el.source = undefined
  el.accessors = undefined
  el.textOf = undefined
  el.paint = undefined
  el.style = undefined
  el._engine = engine
  el._handle = null
  el._enclosingModifier = () => null
  return el
}

test('mountLayer con visible=false lo honra por el handle (no queda visible)', () => {
  const engine = fakeEngine()
  const el = fakeLabel({ visible: false, engine })
  const handle = el.mountLayer(engine)
  assert.equal(handle.visibleCalls.at(-1), false)   // honró oculto en el propio montaje
  assert.equal(engine.lastCfg.visible, false)        // además pasó `visible` al alta (intención)
})

test('mountLayer con visible=true no fuerza setVisible (el motor lo nace visible)', () => {
  const engine = fakeEngine()
  const el = fakeLabel({ visible: true, engine })
  el.mountLayer(engine)
  assert.deepEqual(engine.handle.visibleCalls, [])
})

test('montaje DIFERIDO (base.updated) honra visible=false inicial', () => {
  const engine = fakeEngine()
  const el = fakeLabel({ visible: false, engine })   // _handle null, _engine presente, mountReady true
  const changed = new Map([['visible', undefined], ['bindTo', undefined]])
  el.updated(changed)                                 // CristaeLayerElement.prototype.updated (heredado)
  assert.ok(el._handle, 'montó el handle en updated()')
  assert.equal(engine.handle.visibleCalls.at(-1), false)   // honrado (mountLayer + diff inicial)
})

test('capa ya montada: cambiar visible a false se propaga por syncLayer', () => {
  const engine = fakeEngine()
  const el = fakeLabel({ visible: true, engine })
  el._handle = engine.handle       // ya montada (rama _handle de updated)
  el.visible = false
  el.updated(new Map([['visible', true]]))
  assert.equal(engine.handle.visibleCalls.at(-1), false)
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
