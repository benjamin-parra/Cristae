// El ECO del input controlado en los editores de geometría: el valor que el editor acaba de emitir
// vuelve como `value` desde el host y NO se reingiere — `setValue` suelta la interacción, así que
// reingerir el eco cortaría el arrastre en su primer frame. Se congela también el lado opuesto (un
// valor AJENO sí entra), las salidas live/asentada y que la FORMA salga de `static kind`.
// Sin DOM real ni customElements: se ejercita el código REAL por métodos prestados del prototipo sobre
// un `this` falso. Corre con: node --test test/element/editable-eco.test.mjs
import '../../test-helpers/element-stub.mjs'   // window/document y lo que Lit toca al evaluar: PRIMERO
import test from 'node:test'
import assert from 'node:assert/strict'
import { CristaeEditablePolygon } from '../../src/element/CristaeEditablePolygon.js'
import { CristaeEditablePolyline } from '../../src/element/CristaeEditablePolyline.js'
import { CristaeEditablePoint } from '../../src/element/CristaeEditablePoint.js'
import { CristaeEditableRectangle } from '../../src/element/CristaeEditableRectangle.js'

// Motor falso: addEditableLayer registra la cfg (de ahí salen onChange/onCommit) y devuelve un handle
// que apunta sus llamadas.
function fakeEngine() {
  const handle = {
    id: 'edit', valores: [], modos: [], estilos: [],
    setValue(v) { handle.valores.push(v) },
    setMode(m) { handle.modos.push(m) },
    setStyle(s) { handle.estilos.push(s) },
  }
  return {
    handle,
    lastCfg: null,
    addEditableLayer(cfg) { this.lastCfg = cfg; return handle },
    removeLayer() {},
  }
}

// Editor falso: hereda los métodos REALES del prototipo y expone sólo los campos que tocan.
function fakeEditor({ Clase = CristaeEditablePolyline, value, engine, mode = 'edit' }) {
  const el = Object.create(Clase.prototype)
  el.id = 'edit'
  el.mode = mode
  el.value = value
  el.geometryStyle = undefined
  el._engine = engine
  el._handle = null
  el._eco = null
  el.eventos = []
  el.dispatchEvent = (ev) => el.eventos.push(ev)
  el._enclosingModifier = () => null
  return el
}

const montado = (opts) => {
  const engine = fakeEngine()
  const el = fakeEditor({ ...opts, engine })
  el._handle = el.mountLayer(engine)
  return { el, engine }
}

test('la FORMA sale de `static kind`, no de una prop', () => {
  const casos = [
    [CristaeEditablePolygon, 'polygon'],
    [CristaeEditablePolyline, 'polyline'],
    [CristaeEditablePoint, 'point'],
    [CristaeEditableRectangle, 'rectangle'],
  ]
  casos.forEach(([Clase, kind]) => {
    const { engine, el } = montado({ Clase, value: null })
    assert.equal(engine.lastCfg.kind, kind)
    assert.equal(el.kind, undefined, 'la forma no se expone como prop del elemento')
  })
})

test('mountLayer pasa mode/value/style al alta (style, no geometryStyle)', () => {
  const engine = fakeEngine()
  const el = fakeEditor({ Clase: CristaeEditablePolygon, value: [[1, 1]], engine, mode: 'draw' })
  el.geometryStyle = { color: '#278cff' }
  el.mountLayer(engine)
  assert.equal(engine.lastCfg.mode, 'draw')
  assert.deepEqual(engine.lastCfg.value, [[1, 1]])
  assert.deepEqual(engine.lastCfg.style, { color: '#278cff' })
})

test('el diff inicial no reingresa el value que el alta ya recibió', () => {
  const inicial = [[1, 1], [2, 2]]
  const { el, engine } = montado({ value: inicial })
  el.updated(new Map([['value', undefined], ['mode', undefined]]))
  assert.deepEqual(engine.handle.valores, [], 'setValue redundante sobre el valor del alta')
})

// Un consumidor que SÍ escucha: lee `detail.value` del último evento (es lo que dispara la lectura).
const escuchar = (el) => el.eventos.at(-1).detail.value

test('una emisión que NADIE lee no serializa: el valor se PIDE, no se empuja', () => {
  // `#emit` corre por frame de arrastre; serializar el trazo entero asigna un par por vértice, así que
  // empujarlo costaba O(n) por frame aunque no hubiera un solo listener.
  const { engine } = montado({ value: [[1, 1]] })
  let lecturas = 0
  const leer = () => (lecturas++, [[1, 1], [9, 9]])

  for (let frame = 0; frame < 100; frame++) engine.lastCfg.onChange(leer)
  assert.equal(lecturas, 0, '100 frames de arrastre sin listener no deben serializar ni una vez')
})

test('el valor se serializa UNA vez por emisión, aunque se lea varias', () => {
  const { el, engine } = montado({ value: [[1, 1]] })
  let lecturas = 0
  engine.lastCfg.onCommit(() => (lecturas++, [[7, 7]]))

  assert.deepEqual(escuchar(el), [[7, 7]])
  assert.deepEqual(escuchar(el), [[7, 7]])
  assert.equal(lecturas, 1)
})

test('ECO: el valor recién emitido, devuelto por el host, NO se reingiere', () => {
  const { el, engine } = montado({ value: [[1, 1]] })
  const emitido = [[1, 1], [9, 9]]              // lo que el editor serializó en el arrastre
  engine.lastCfg.onChange(() => emitido)
  assert.equal(escuchar(el), emitido)

  el.value = emitido                            // el host lo devuelve tal cual
  el.updated(new Map([['value', undefined]]))
  assert.deepEqual(engine.handle.valores, [], 'reingerir el eco soltaría el gesto en curso')
})

test('sin leer no hay eco: lo que el host no recibió, no lo puede devolver', () => {
  const { el, engine } = montado({ value: [[1, 1]] })
  const ajeno = [[9, 9]]
  engine.lastCfg.onChange(() => ajeno)          // emitido pero NO leído

  el.value = ajeno
  el.updated(new Map([['value', undefined]]))
  assert.deepEqual(engine.handle.valores, [ajeno])
})

test('un valor AJENO sí entra (el mundo empujando estado, no un eco)', () => {
  const { el, engine } = montado({ value: [[1, 1]] })
  engine.lastCfg.onChange(() => [[1, 1], [9, 9]])
  escuchar(el)

  const deAfuera = [[5, 5]]
  el.value = deAfuera
  el.updated(new Map([['value', undefined]]))
  assert.deepEqual(engine.handle.valores, [deAfuera])
})

test('un host que CLONA el valor rompe el eco: entra y corta el gesto', () => {
  // Congela el límite documentado (docs/editing.md): la comparación es por REFERENCIA.
  const { el, engine } = montado({ value: [[1, 1]] })
  const emitido = [[1, 1], [9, 9]]
  engine.lastCfg.onChange(() => emitido)
  escuchar(el)

  el.value = [...emitido]                       // mismo contenido, otra referencia
  el.updated(new Map([['value', undefined]]))
  assert.equal(engine.handle.valores.length, 1)
})

test('onChange y onCommit despachan cristae:change / cristae:commit con el valor en detail', () => {
  const { el, engine } = montado({ value: [[1, 1]] })
  engine.lastCfg.onChange(() => [[2, 2]])
  engine.lastCfg.onCommit(() => [[3, 3]])
  assert.deepEqual(el.eventos.map(e => e.type), ['cristae:change', 'cristae:commit'])
  assert.deepEqual(escuchar(el), [[3, 3]])
  assert.ok(el.eventos.every(e => e.bubbles && e.composed), 'el evento tiene que salir del elemento')
})

test('mode y geometryStyle se propagan al handle ya montado', () => {
  const { el, engine } = montado({ value: [[1, 1]] })
  el.mode = 'draw'
  el.geometryStyle = { weight: 5 }
  el.updated(new Map([['mode', 'edit'], ['geometryStyle', undefined]]))
  assert.deepEqual(engine.handle.modos, ['draw'])
  assert.deepEqual(engine.handle.estilos, [{ weight: 5 }])
})
