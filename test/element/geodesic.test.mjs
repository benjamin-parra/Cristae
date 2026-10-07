// <cristae-geodesic>: modificador `map` de la gramática. Con las firmas REALES registradas por el entry, se
// valida que sólo envuelva líneas, polígonos y los editores de polilínea y de polígono (R2 con cualquier
// otro), que un hermano que no consume pase intacto, que `enabled` alterne la curva sin remontar al hijo y
// que, como todo modificador, no apile. Los hijos son nodos falsos con el protocolo del reductor; el motor
// anota las altas, salvo en el test del apilado, que usa el de verdad.
import '../../test-helpers/element-stub.mjs'
import { conGlDeEdicion, makeEditGl, makeLeaflet, makeMap } from '../../test-helpers/engine-stub.mjs'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import '../../src/index.js'
import { CristaeLayerElement } from '../../src/element/base.js'
import { CristaeGeodesic } from '../../src/element/CristaeGeodesic.js'
import { grammar } from '../../src/element/composite.js'
import { MapEngine } from '../../src/engine/MapEngine.js'
import { GrammarError, leafUnits, validate } from '../../src/grammar/index.js'
import { adoptLeafletHost } from '../../src/host/LeafletHost.js'

after(conGlDeEdicion(() => makeEditGl()))

const ctx = { signatureFor: grammar.signatureFor, isRegistered: grammar.isRegistered, mode: 'throw' }

// Una hoja que monta al pedírselo y cuenta cuántas veces.
const hoja = (tag, id = tag) => {
  const el = {
    tagName: tag.toUpperCase(), children: [], getAttribute: () => null, _handle: null, montajes: 0,
    mountReady: () => true,
    cristaeMount(engine) { el.montajes++; el._engine = engine; el._handle = { id } },
    cristaeUnits: () => leafUnits(el, el._engine, grammar),
  }
  return el
}

const geodesica = (...hijos) => Object.assign(new CristaeGeodesic(), {
  tagName: 'CRISTAE-GEODESIC', children: hijos, _enclosingModifier: () => null,
})

// Motor falso: anota cada alta y cada baja.
const motor = () => {
  const e = {
    altas: [], bajas: [],
    addGeodesic: ({ hostId }) => {
      e.altas.push(hostId)
      return () => e.bajas.push(hostId)
    },
  }
  return e
}

const rechaza = (...hijos) => assert.throws(() => validate(geodesica(...hijos), ctx), e => e instanceof GrammarError && e.code === 'R2')

test('envuelve líneas, polígonos y los editores de polilínea y de polígono', () => {
  ;['cristae-line-layer', 'cristae-polygon-layer', 'cristae-editable-polyline', 'cristae-editable-polygon']
    .forEach(tag => assert.equal(validate(geodesica(hoja(tag)), ctx), true, tag))
})

test('envolver sólo algo que no se curva es R2', () => {
  ;['cristae-editable-rectangle', 'cristae-editable-point', 'cristae-editable-circle', 'cristae-editable-ellipse',
    'cristae-editable-sector', 'cristae-shape-layer', 'cristae-point-layer', 'cristae-html-layer', 'cristae-label-layer']
    .forEach(tag => rechaza(hoja(tag)))
})

test('un hermano que no se consume pasa intacto al montar, y sólo el host se curva', () => {
  const engine = motor()
  const linea  = hoja('cristae-line-layer', 'ruta')
  const rect   = hoja('cristae-editable-rectangle', 'rect')
  const geo    = geodesica(linea, rect)
  assert.equal(validate(geo, ctx), true)

  geo.mountLayer(engine)
  assert.deepEqual(engine.altas, ['ruta'])
  assert.deepEqual(geo.cristaeUnits().map(u => [u.kind, u.id]),
    [['line', 'ruta'], ['edit', 'rect'], ['geodesic', 'ruta:geodesic']])
})

test('una unit de geodésica por host, y cada una con su baja', () => {
  const engine = motor()
  const geo    = geodesica(hoja('cristae-line-layer', 'a'), hoja('cristae-editable-polygon', 'b'))
  geo.mountLayer(engine)
  assert.deepEqual(engine.altas, ['a', 'b'])
  assert.deepEqual(geo.cristaeUnits().filter(u => u.kind === 'geodesic').map(u => u.id), ['a:geodesic', 'b:geodesic'])
})

test('`enabled` alterna la curva sin remontar al hijo', () => {
  const engine = motor()
  const linea  = hoja('cristae-line-layer', 'ruta')
  const geo    = geodesica(linea)
  geo.mountLayer(engine)
  assert.deepEqual([engine.altas, engine.bajas], [['ruta'], []])

  geo.enabled = false
  geo.syncLayer(new Map([['enabled', true]]))
  assert.deepEqual([engine.altas, engine.bajas], [['ruta'], ['ruta']], 'en false llama la baja')

  geo.syncLayer(new Map([['enabled', false]]))
  assert.deepEqual([engine.altas, engine.bajas], [['ruta'], ['ruta']], 'repetir el valor no baja dos veces')

  geo.enabled = true
  geo.syncLayer(new Map([['enabled', false]]))
  assert.deepEqual([engine.altas, engine.bajas], [['ruta', 'ruta'], ['ruta']], 'en true vuelve a dar de alta')

  geo.syncLayer(new Map([['enabled', false]]))
  assert.equal(engine.altas.length, 2, 'repetir el valor no da de alta dos veces')
  geo.syncLayer(new Map([['otra', 1]]))
  assert.equal(engine.altas.length, 2, 'una prop que no es suya no toca la curva')
  assert.equal(linea.montajes, 1, 'el hijo se montó una sola vez')
})

test('con `enabled` en false desde el montaje no hay alta, y al encenderlo se da', () => {
  const engine = motor()
  const geo    = geodesica(hoja('cristae-line-layer', 'ruta'))
  geo.enabled  = false
  geo.mountLayer(engine)
  assert.deepEqual(engine.altas, [])

  geo.enabled = true
  geo.syncLayer(new Map([['enabled', false]]))
  assert.deepEqual(engine.altas, ['ruta'])
})

// Asignado como propiedad el valor llega crudo, sin el converter: quitarlo deja la curva y "false" la apaga.
test('`enabled` como propiedad: undefined o null dejan la curva, y "false" o "0" la apagan', () => {
  const engine = motor()
  const geo    = geodesica(hoja('cristae-line-layer', 'ruta'))
  geo.enabled  = undefined
  geo.mountLayer(engine)
  assert.deepEqual([engine.altas, engine.bajas], [['ruta'], []], 'sin la prop monta curvada')

  ;[[null, []], ['false', ['ruta']], [undefined, ['ruta']], ['0', ['ruta', 'ruta']]].forEach(([valor, bajas]) => {
    geo.enabled = valor
    geo.syncLayer(new Map([['enabled', true]]))
    assert.deepEqual(engine.bajas, bajas, String(valor))
  })
})

// La curva de un geodesic anidado sube con los hijos del de afuera, pero la alterna sólo el suyo.
test('`enabled` alterna sólo sus curvas, no las de un <cristae-geodesic> anidado', () => {
  const engine  = motor()
  const adentro = geodesica(hoja('cristae-line-layer', 'ruta'))
  const afuera  = geodesica(Object.assign(adentro, { cristaeMount: e => adentro.mountLayer(e) }))
  afuera.mountLayer(engine)
  assert.deepEqual(engine.altas, ['ruta', 'ruta'])

  afuera.enabled = false
  afuera.syncLayer(new Map([['enabled', true]]))
  assert.deepEqual(engine.bajas, ['ruta'], 'el de afuera da de baja sólo la suya')
  afuera.enabled = true
  afuera.syncLayer(new Map([['enabled', false]]))
  assert.deepEqual(engine.altas, ['ruta', 'ruta', 'ruta'], 'y sólo la suya vuelve a dar de alta')
})

test('`enabled` vale true por defecto, y es la única config', () => {
  const el = new CristaeGeodesic()
  assert.equal(el.enabled, true)
  assert.deepEqual(el.cristaeConfig(), { enabled: true })
})

// Un Boolean de Lit lee `enabled="false"` como presente, o sea true: con el converter de «default ON» apaga.
test('`enabled="false"` o "0" como atributo apaga la curva, y presente o vacío la deja', () => {
  CristaeGeodesic.finalize()
  const { fromAttribute } = CristaeGeodesic.elementProperties.get('enabled').converter
  assert.deepEqual(['false', '0', '', 'true', 'enabled'].map(fromAttribute), [false, false, true, true, true])
})

test('monta cuando todos sus hijos tienen su config', () => {
  const pendiente = Object.assign(hoja('cristae-line-layer'), { mountReady: () => false })
  assert.equal(geodesica(hoja('cristae-line-layer'), pendiente).mountReady(), false)
  assert.equal(geodesica(hoja('cristae-line-layer')).mountReady(), true)
})

// Como todo modificador no apila: su `z` sale por la base hacia el id del marcador, que no es una capa del
// motor, y el pane del host no se mueve.
test('el `z` del modificador no llega a la capa que envuelve', () => {
  const map    = makeMap()
  const engine = new MapEngine({ host: adoptLeafletHost(map, { leaflet: makeLeaflet() }) })
  engine.addLineLayer({ id: 'ruta', accessors: { idOf: r => r.id, pathOf: r => r.path }, data: [{ id: 1, path: [[0, 0], [1, 1]] }] })
  const antes = map.getPane('cristae-line-ruta').style.zIndex

  const geo = geodesica(hoja('cristae-line-layer', 'ruta'))
  Object.assign(geo, { _engine: engine, _handle: geo.mountLayer(engine), z: 999 })
  CristaeLayerElement.prototype.updated.call(geo, new Map([['z', undefined]]))
  assert.equal(map.getPane('cristae-line-ruta').style.zIndex, antes)
  engine.destroy()
})
