// Datos sin script en las capas declarativas: nombres de atributo, el alta con `url`/`fields`/`click-action`,
// `mountReady` con `url` sola, la precedencia función > `-of` > `fields` con su aviso, los cambios en caliente,
// `text-of` en `<cristae-labeled>` y `<cristae-text-layer>`, y el puente `cristae:load` / `cristae:error`.
// Sin DOM real ni customElements: el código REAL se presta del prototipo sobre un `this` falso.
import '../../test-helpers/element-stub.mjs'
import { readFileSync } from 'node:fs'
import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { CristaePointLayer } from '../../src/element/CristaePointLayer.js'
import { CristaePolygonLayer } from '../../src/element/CristaePolygonLayer.js'
import { CristaeLineLayer } from '../../src/element/CristaeLineLayer.js'
import { CristaeTextLayer } from '../../src/element/CristaeTextLayer.js'
import { CristaeLabeled } from '../../src/element/CristaeLabeled.js'
import { isFieldText } from '../../src/element/dataAttrs.js'

const cambios = (...claves) => new Map(claves.map(k => [k, undefined]))

const motorFalso = () => {
  const señales = new Map()
  const handle  = { id: 'capa', llamadas: [], refresh() { this.llamadas.push(['refresh']) }, reload(o) { this.llamadas.push(['reload', o]) },
                    set() {}, setVisible() {}, setWhere() {}, setEnabled() {}, style() {}, update() {} }
  return {
    handle, señales, cfg: null,
    addPointLayer(cfg)   { this.cfg = cfg; return handle },
    addPolygonLayer(cfg) { this.cfg = cfg; return handle },
    addLineLayer(cfg)    { this.cfg = cfg; return handle },
    addTextLayer(cfg)    { this.cfg = cfg; return handle },
    on(tipo, cb)         { señales.set(tipo, cb); return () => señales.delete(tipo) },
    removeLayer() {},
  }
}

const capa = (Clase, props = {}) => {
  const eventos = []
  const el = Object.assign(Object.create(Clase.prototype), {
    id: 'capa', interactive: false, visible: true, enabled: true,
    _handle: null, _engine: null,
    _enclosingModifier: () => null, closest: () => null, requestUpdate() {},   // el accessor de `source` avisa a Lit
    dispatchEvent: e => (eventos.push(e), true),
  }, props)
  el.eventos = eventos
  return el
}

const avisos = () => mock.method(console, 'warn', () => {})

test('los atributos se nombran en kebab en las propiedades declaradas', () => {
  const attr = (Clase, prop) => Clase.properties[prop].attribute
  assert.equal(attr(CristaePointLayer, 'clickAction'), 'click-action')
  assert.equal(attr(CristaePointLayer, 'idOf'), 'id-of')
  assert.equal(attr(CristaePointLayer, 'variantOf'), 'variant-of')
  assert.equal(attr(CristaePointLayer, 'headingOf'), 'heading-of')
  assert.equal(attr(CristaePointLayer, 'fetch'), false)
  assert.equal(attr(CristaePolygonLayer, 'idOf'), 'id-of')
  assert.equal(attr(CristaeLineLayer, 'clickAction'), 'click-action')
  assert.equal(attr(CristaeTextLayer, 'textOf'), 'text-of')
  assert.equal(attr(CristaeTextLayer, 'idOf'), 'id-of')
  assert.equal(attr(CristaeLabeled, 'textOf'), 'text-of')
  assert.equal(CristaePointLayer.properties.refresh.type, Number)
  assert.equal(CristaePointLayer.properties.fields.type, Object)
})

test('la variante por defecto replica la de PointLayer', () => {
  const fuente = readFileSync(new URL('../../src/render/PointLayer.js', import.meta.url), 'utf8')
  assert.match(fuente, /const DEFAULT_VARIANT = 'default'/)
})

test('mountReady: `url` sola o `fields` solos alcanzan en punto, polígono y línea; sin nada, no', () => {
  for (const Clase of [CristaePointLayer, CristaePolygonLayer, CristaeLineLayer]) {
    assert.equal(capa(Clase).mountReady(), false, Clase.name)
    assert.equal(capa(Clase, { url: './a.geojson' }).mountReady(), true, Clase.name)
    assert.equal(capa(Clase, { fields: { id: 'codigo' } }).mountReady(), true, Clase.name)
  }
  assert.equal(capa(CristaeTextLayer).mountReady(), false)
  assert.equal(capa(CristaeTextLayer, { fields: { text: 'n' } }).mountReady(), true)
})

test('el alta lleva url, format, refresh, fetch, click-action y fields; iconSet puede faltar', () => {
  const fetchFn = () => {}
  for (const [Clase, alta] of [[CristaePointLayer, 'addPointLayer'], [CristaePolygonLayer, 'addPolygonLayer'], [CristaeLineLayer, 'addLineLayer']]) {
    const engine = motorFalso()
    const el = capa(Clase, { url: './a.geojson', format: 'geojson', refresh: 5000, fetch: fetchFn, clickAction: 'fit', fields: { id: 'codigo' } })
    el.mountLayer(engine)
    const { cfg } = engine
    assert.equal(cfg.url, './a.geojson', alta)
    assert.equal(cfg.format, 'geojson')
    assert.equal(cfg.refresh, 5000)
    assert.equal(cfg.fetch, fetchFn)
    assert.equal(cfg.clickAction, 'fit')
    assert.deepEqual(cfg.fields, { id: 'codigo' })
    assert.equal(cfg.iconSet, undefined)
  }
})

test('sin lo declarado, el alta no gana claves nuevas y los accessors propios pasan por identidad en polígono y línea', () => {
  const accessors = { idOf: p => p.id, ringsOf: p => p.r }
  const engine = motorFalso()
  capa(CristaePolygonLayer, { accessors, data: [] }).mountLayer(engine)
  assert.equal(engine.cfg.accessors, accessors)
  for (const k of ['url', 'format', 'refresh', 'fetch', 'clickAction', 'fields']) assert.equal(k in engine.cfg, false, k)
})

test('`fields` por atributo JSON llega como objeto', () => {
  const engine = motorFalso()
  capa(CristaePointLayer, { fields: JSON.parse('{"id":"codigo","position":["lat","lng"]}') }).mountLayer(engine)
  assert.deepEqual(engine.cfg.fields, { id: 'codigo', position: ['lat', 'lng'] })
})

test('id-of instala el lector de id; es total sobre null y campo ausente', () => {
  const engine = motorFalso()
  capa(CristaePolygonLayer, { url: 'x', idOf: 'meta.codigo' }).mountLayer(engine)
  const { idOf } = engine.cfg.accessors
  assert.equal(idOf({ meta: { codigo: 'a1' } }), 'a1')
  assert.equal(idOf(null), '')
  assert.equal(idOf({}), '')
})

test('precedencia: la función de accessors gana al -of, con un aviso una vez', () => {
  const w = avisos()
  const idOf = p => p.k
  const engine = motorFalso()
  const el = capa(CristaePointLayer, { accessors: { idOf }, idOf: 'codigo' })
  el.mountLayer(engine)
  el.mountLayer(engine)
  assert.equal(engine.cfg.accessors.idOf, idOf)
  assert.equal(w.mock.callCount(), 1)
  w.mock.restore()
})

test('precedencia: el -of gana a la misma clave de fields, que sale de la copia, con un aviso una vez', () => {
  const w = avisos()
  const fields = { id: 'a', heading: 'rumbo' }
  const engine = motorFalso()
  const el = capa(CristaePointLayer, { fields, headingOf: 'giro' })
  el.mountLayer(engine)
  el.mountLayer(engine)
  assert.deepEqual(engine.cfg.fields, { id: 'a' })
  assert.deepEqual(fields, { id: 'a', heading: 'rumbo' }, 'no muta el original')
  assert.equal(engine.cfg.accessors.headingOf({ giro: 90 }), 90)
  assert.equal(w.mock.callCount(), 1)
  w.mock.restore()
})

test('una clave de fields sin -of ni función se queda en fields: no hay cierre', () => {
  const engine = motorFalso()
  capa(CristaePointLayer, { accessors: {}, fields: { heading: 'rumbo' } }).mountLayer(engine)
  assert.equal(engine.cfg.accessors.headingOf, undefined)
  assert.equal(engine.cfg.accessors.variantOf, undefined, 'sin atributo no hay cierre: el PointLayer trata el accessor ausente como neutro')
})

test('con `source` los cierres no se instalan: la Source trae los suyos', () => {
  const accessors = { idOf: p => p.id }
  const engine = motorFalso()
  capa(CristaePointLayer, { source: {}, accessors, variantOf: 'tipo' }).mountLayer(engine)
  assert.equal(engine.cfg.accessors, accessors)
})

test('sin atributo no se instala ningún cierre de variante ni de rumbo: el 2D de hoy no gana una llamada por ítem', () => {
  const engine = motorFalso()
  const accessors = { positionOf: p => p }
  capa(CristaePointLayer, { accessors }).mountLayer(engine)
  assert.equal(engine.cfg.accessors, accessors, 'los propios pasan por identidad')
  assert.equal('variantOf' in engine.cfg.accessors, false)
  assert.equal('headingOf' in engine.cfg.accessors, false)
})

test('con `source`, un -of o fields declarados avisan una vez que se ignoran', () => {
  const w = mock.method(console, 'warn', () => {})
  const engine = motorFalso()
  const el = capa(CristaePointLayer, { source: {}, accessors: { idOf: p => p.id }, variantOf: 'tipo', fields: { id: 'x' } })
  el.mountLayer(engine)
  el.mountLayer(engine)
  const llamadas = w.mock.calls.map(c => c.arguments[0])
  w.mock.restore()
  assert.equal(llamadas.length, 1)
  assert.match(llamadas[0], /variantOf, fields se ignoran con 'source'/)
})

test('un fallo de carga sin oyentes va a console.error una vez; preventDefault lo silencia', () => {
  const consola = mock.method(console, 'error', () => {})
  try {
    const engine = motorFalso()
    const el = capa(CristaePointLayer, { url: 'x' })
    el.mountLayer(engine)
    const falla = { layerId: 'capa', url: 'x', code: 'network', message: 'x: HTTP 404' }
    engine.señales.get('dataerror')(falla)
    engine.señales.get('dataerror')(falla)
    assert.equal(consola.mock.callCount(), 1)
    assert.match(consola.mock.calls[0].arguments[0], /la capa 'capa' no cargó x: x: HTTP 404/)

    const atendida = capa(CristaePointLayer, { url: 'x' })
    atendida.dispatchEvent = e => (e.preventDefault(), !e.defaultPrevented)
    const otro = motorFalso()
    atendida.mountLayer(otro)
    otro.señales.get('dataerror')(falla)
    assert.equal(consola.mock.callCount(), 1)
  } finally { consola.mock.restore() }
})

test('variant-of y heading-of leen el campo, y son totales', () => {
  const engine = motorFalso()
  capa(CristaePointLayer, { url: 'x', variantOf: 'estado', headingOf: 'm.rumbo' }).mountLayer(engine)
  const { variantOf, headingOf } = engine.cfg.accessors
  assert.equal(variantOf({ estado: 'activo' }), 'activo')
  assert.equal(variantOf({ estado: null }), 'default')
  assert.equal(variantOf(undefined), 'default')
  assert.equal(headingOf({ m: { rumbo: 45 } }), 45)
  assert.equal(headingOf({ m: { rumbo: 'x' } }), 0)
  assert.equal(headingOf({}), 0)
})

test('cambiar url, format o refresh recarga; el estado inicial de un montaje diferido no', () => {
  const engine = motorFalso()
  const el = capa(CristaePointLayer, { url: 'a', format: 'geojson', refresh: 10, _engine: engine })
  el._handle = el.mountLayer(engine)
  el.syncLayer(cambios('url', 'format', 'refresh'))
  assert.deepEqual(engine.handle.llamadas, [], 'el `changed` inicial coincide con lo montado')
  el.url = 'b'
  el.syncLayer(cambios('url'))
  el.refresh = 0
  el.syncLayer(cambios('refresh'))
  assert.deepEqual(engine.handle.llamadas, [
    ['reload', { url: 'b', format: 'geojson', refresh: 10 }],
    ['reload', { url: 'b', format: 'geojson', refresh: 0 }],
  ])
})

test('id-of, fields y click-action cambiados tras montar avisan una vez que se leen al montar', () => {
  const w = avisos()
  const engine = motorFalso()
  const el = capa(CristaeLineLayer, { url: 'a', idOf: 'x', clickAction: 'fit', _engine: engine })
  el._handle = el.mountLayer(engine)
  el.syncLayer(cambios('idOf', 'clickAction'))
  assert.equal(w.mock.callCount(), 0, 'lo inicial no avisa')
  el.idOf = 'y'
  el.syncLayer(cambios('idOf'))
  el.idOf = 'z'
  el.syncLayer(cambios('idOf'))
  el.fields = { id: 'q' }
  el.syncLayer(cambios('fields'))
  assert.equal(w.mock.callCount(), 2, 'una vez por nombre')
  assert.ok(w.mock.calls.every(c => /al montar/.test(c.arguments[0])))
  w.mock.restore()
})

test('text-of: una cadena se vuelve un lector total en <cristae-text-layer>, y su cambio actualiza', () => {
  const engine = motorFalso()
  const updates = []
  engine.handle.update = p => updates.push(p)
  const el = capa(CristaeTextLayer, { accessors: { positionOf: p => p }, textOf: 'nombre' })
  el._engine = engine
  el._handle = el.mountLayer(engine)
  const { textOf } = engine.cfg
  assert.equal(textOf({ nombre: 'Cautín' }), 'Cautín')
  assert.equal(textOf({}), '')
  assert.equal(textOf(null), '')
  assert.equal(isFieldText(textOf), true)

  el.textOf = 'otro'
  el.syncLayer(cambios('textOf'))
  assert.equal(updates[0].textOf({ otro: 'x' }), 'x')

  const fn = i => i.n
  el.textOf = fn
  el.syncLayer(cambios('textOf'))
  assert.equal(updates[1].textOf, fn)

  el.textOf = undefined
  el.syncLayer(cambios('textOf'))
  assert.equal(updates[2].textOf, null)
})

test('text-of ganó a fields.text en la capa de texto, con aviso; una función gana a ambos', () => {
  const w = avisos()
  const engine = motorFalso()
  capa(CristaeTextLayer, { fields: { text: 'a', id: 'k' }, textOf: 'b' }).mountLayer(engine)
  assert.deepEqual(engine.cfg.fields, { id: 'k' })
  assert.equal(w.mock.callCount(), 1)

  const fn = () => 'f'
  capa(CristaeTextLayer, { fields: { text: 'a' }, textOf: fn }).mountLayer(engine)
  assert.equal(engine.cfg.textOf, fn)
  assert.deepEqual(engine.cfg.fields, {})
  w.mock.restore()
})

test('text-of en <cristae-labeled>: cristaeConfig lo vuelve un cierre total y su cambio viaja por update', () => {
  const el = Object.assign(new CristaeLabeled(), { textOf: 'nombre' })
  const { textOf } = el.cristaeConfig()
  assert.equal(textOf({ nombre: 'A' }), 'A')
  assert.equal(textOf(undefined), '')
  assert.equal(new CristaeLabeled().cristaeConfig().textOf, undefined)
})

test('fields.text en <cristae-labeled> es el gemelo de text-of: gana text-of, con un aviso una vez', () => {
  const w = mock.method(console, 'warn', () => {})
  const solo = Object.assign(new CristaeLabeled(), { fields: { text: 'nombre' } })
  const { textOf } = solo.cristaeConfig()
  assert.equal(textOf({ nombre: 'A' }), 'A')
  assert.equal(textOf(null), '')
  assert.equal(isFieldText(textOf), true, 'una burbuja lo salta como a text-of')

  const ambos = Object.assign(new CristaeLabeled(), { textOf: 'patente', fields: { text: 'nombre' } })
  assert.equal(ambos.cristaeConfig().textOf({ patente: 'P', nombre: 'N' }), 'P')
  ambos.cristaeConfig()
  const avisos = w.mock.calls.map(c => c.arguments[0])
  w.mock.restore()
  assert.equal(avisos.length, 1)
  assert.match(avisos[0], /text-of' y fields\.text a la vez: gana 'text-of'/)
})

test('una burbuja recibe los rótulos sin text-of y se avisa una vez por capa', () => {
  const w = avisos()
  const altas = []
  const engine = { addLabels: cfg => (altas.push(cfg), { update() {}, remove() {} }), getLayer: () => null }
  const el = Object.assign(new CristaeLabeled(), { textOf: 'nombre' })
  const cfg = el.cristaeConfig()
  CristaeLabeled.cristaeApply(engine, [{ id: 'flota:clusters', kind: 'bubble' }, { id: 'flota', kind: 'point' }], cfg)
  CristaeLabeled.cristaeApply(engine, [{ id: 'flota:clusters', kind: 'bubble' }], cfg)
  assert.equal('textOf' in altas[0], false)
  assert.equal(altas[1].textOf, cfg.textOf)
  assert.equal('textOf' in altas[2], false)
  assert.equal(w.mock.callCount(), 1)
  w.mock.restore()
})

test('cristae:load y cristae:error se despachan con el detalle del motor, sólo de la propia capa', () => {
  const engine = motorFalso()
  const el = capa(CristaePointLayer, { url: 'x' })
  el.mountLayer(engine)
  engine.señales.get('dataload')({ layerId: 'capa', count: 3 })
  engine.señales.get('dataload')({ layerId: 'otra', count: 9 })
  engine.señales.get('dataerror')({ layerId: 'capa', code: 'network' })
  assert.deepEqual(el.eventos.map(e => e.type), ['cristae:load', 'cristae:error'])
  assert.deepEqual(el.eventos[0].detail, { layerId: 'capa', count: 3 })
  assert.deepEqual(el.eventos.map(e => [e.bubbles, e.composed]), [[true, true], [true, true]])

  el.cristaeUnmount()
  assert.equal(engine.señales.size, 0, 'la baja va en cristaeUnmount')
})
