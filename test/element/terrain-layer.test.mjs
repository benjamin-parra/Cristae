// <cristae-terrain-layer>: la piel declarativa de `addTerrainLayer`. Se congela la firma de gramática, que sin
// dem legible no monta y avisa una vez, que cada atributo llega al alta con su lector (cortes en % y en grados
// como razones, colores como rgba()), que cada cambio llega a UN `update` parcial, que lo ilegible no cambia
// nada, los eventos, y la atribución del dem como texto en <cristae-map>. Sin DOM real: el código REAL se presta
// del prototipo sobre un `this` falso.
import '../../test-helpers/element-stub.mjs'
import { montarMapa } from '../../test-helpers/element-stub.mjs'
import { makeMap } from '../../test-helpers/engine-stub.mjs'
import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { CristaeTerrainLayer } from '../../src/element/CristaeTerrainLayer.js'
import { terrainPresets } from '../../src/geometry/terrain-presets.js'
import { terrainPresets as deGeometria } from '../../src/geometry/index.js'

// El canvas 2D donde se resuelven los nombres CSS: como el real, un valor inválido deja el anterior.
const NOMBRES = { tomato: '#ff6347', rebeccapurple: '#663399' }
const canvasFalso = () => {
  let color = '#000000'
  return { get fillStyle() { return color }, set fillStyle(v) { color = NOMBRES[v] ?? (/^#[0-9a-f]{6}$/.test(v) ? v : color) } }
}
const ctx = canvasFalso()
globalThis.document.createElement = () => ({ getContext: () => ctx })

const cambios = (...claves) => new Map(claves.map(k => [k, undefined]))
const DEM = { url: 'https://t.test/{z}/{x}/{y}.png', encoding: 'terrarium', zoom: 12 }

const motorFalso = () => {
  const señales = new Map()
  const handle  = { id: 'relieve', llamadas: [] }
  ;['update', 'setVisible', 'setOpacity'].forEach(m => handle[m] = v => handle.llamadas.push([m, v]))
  return {
    handle, señales, cfg: null, quitadas: [],
    addTerrainLayer(cfg) { this.cfg = cfg; return handle },
    on(tipo, cb)         { señales.set(tipo, cb); return () => señales.delete(tipo) },
    removeLayer(id)      { this.quitadas.push(id) },
  }
}

const capa = (props = {}) => {
  const eventos = []
  const el = Object.assign(Object.create(CristaeTerrainLayer.prototype), {
    id: 'relieve', visible: true, _handle: null, _engine: null,
    _enclosingModifier: () => null, closest: () => null, requestUpdate() {},
    dispatchEvent: e => (eventos.push(e), true),
  }, props)
  el.eventos = eventos
  return el
}

const avisos = () => mock.method(console, 'warn', () => {})
const errores = () => mock.method(console, 'error', () => {})

test('es una hoja que produce `terrain`, y sus atributos van en kebab', () => {
  assert.deepEqual(CristaeTerrainLayer.cristaeSignature, { role: 'leaf', produces: ['terrain'] })
  const props = CristaeTerrainLayer.properties
  assert.equal(props.colorBy.attribute, 'color-by')
  assert.equal(props.slopeBreaks.attribute, 'slope-breaks')
  assert.equal(props.slopeColors.attribute, 'slope-colors')
  assert.equal(props.elevationRange.attribute, 'elevation-range')
  assert.equal(props.clipTo.attribute, 'clip-to')
  assert.equal(props.fetch.attribute, false)
  assert.equal(props.contours.type, Number)
  assert.equal(props.opacity.type, Number)
  assert.equal(props.visible.type, Boolean)
  assert.equal(capa().visible, true)
})

test('hillshade tiene tres estados: ausente, "false" o "0" y presente', () => {
  const { fromAttribute } = CristaeTerrainLayer.properties.hillshade.converter
  assert.deepEqual([null, 'false', '0', '', 'true'].map(fromAttribute), [undefined, false, false, true, true])
})

test('sin dem legible no monta y avisa una vez; con un preset o un objeto monta', () => {
  const w = avisos()
  const engine = motorFalso()
  for (const dem of [undefined, '', 'nadie', '{no es json', '{"a":']) {
    const el = capa({ dem })
    el.cristaeMount(engine)
    el.cristaeMount(engine)
    assert.equal(el.controls, null, String(dem))
  }
  assert.equal(engine.cfg, null)
  assert.equal(w.mock.callCount(), 5, 'un aviso por dem distinto, no por intento')
  const el = capa({ dem: 'nadie' })
  el.mountReady()
  el.mountReady()
  assert.equal(w.mock.callCount(), 6, 'el mismo dem avisa una vez')
  w.mock.restore()
  assert.equal(capa({ dem: 'aws' }).mountReady(), true)
  assert.equal(capa({ dem: DEM }).mountReady(), true)
  assert.equal(capa({ dem: JSON.stringify(DEM) }).mountReady(), true)
})

test('el alta recibe cada atributo con su lector', () => {
  const engine = motorFalso()
  const fetchFn = () => {}
  capa({
    dem: JSON.stringify(DEM), hillshade: true, colorBy: 'slope', slopeBreaks: '15% 17° 0.5',
    slopeColors: '#a6d96a tomato rgb(215, 25, 28) rebeccapurple', elevationRange: '200 600', contours: 10,
    clipTo: 'predios', opacity: 0.4, visible: false, pane: 'suelo', z: 12, fetch: fetchFn,
  }).cristaeMount(engine)
  const { cfg, handle } = engine
  assert.match(cfg.id, /^relieve$/)
  assert.deepEqual(cfg.dem, DEM)
  assert.equal(cfg.hillshade, true)
  assert.equal(cfg.colorBy, 'slope')
  assert.deepEqual(cfg.slopeBreaks, [0.15, Math.tan(17 * Math.PI / 180), 0.5])
  assert.deepEqual(cfg.slopeColors, ['rgba(166, 217, 106, 1)', 'rgba(255, 99, 71, 1)', 'rgba(215, 25, 28, 1)', 'rgba(102, 51, 153, 1)'])
  assert.deepEqual(cfg.elevationRange, [200, 600])
  assert.equal(cfg.contours, 10)
  assert.equal(cfg.clipTo, 'predios')
  assert.equal(cfg.visible, false)
  assert.equal(cfg.pane, 'suelo')
  assert.equal(cfg.z, 12)
  assert.equal(cfg.fetch, fetchFn)
  assert.equal('opacity' in cfg, false, 'la opacidad va por su setter')
  assert.deepEqual(handle.llamadas, [['setOpacity', 0.4]])
})

test('sin lo declarado el alta lleva sólo el dem, y sin id propio el `terrain-N`', () => {
  const engine = motorFalso()
  capa({ id: '', dem: 'aws' }).cristaeMount(engine)
  assert.match(engine.cfg.id, /^terrain-\d+$/)
  for (const k of ['hillshade', 'colorBy', 'slopeBreaks', 'slopeColors', 'elevationRange', 'contours', 'clipTo', 'fetch'])
    assert.equal(k in engine.cfg, false, k)
  assert.equal(engine.cfg.dem, 'aws')
  assert.deepEqual(engine.handle.llamadas, [])
})

test('un dem por propiedad como objeto, y los arreglos por propiedad, pasan tal cual', () => {
  const engine = motorFalso()
  capa({ dem: DEM, slopeBreaks: [0.1, 0.2], elevationRange: [0, 100], slopeColors: ['#fff', '#000', '#123456'] }).cristaeMount(engine)
  assert.equal(engine.cfg.dem, DEM)
  assert.deepEqual(engine.cfg.slopeBreaks, [0.1, 0.2])
  assert.deepEqual(engine.cfg.elevationRange, [0, 100])
  assert.deepEqual(engine.cfg.slopeColors, ['rgba(255, 255, 255, 1)', 'rgba(0, 0, 0, 1)', 'rgba(18, 52, 86, 1)'])
})

test('un atributo ilegible al montar se omite con un error, sin impedir el montaje', () => {
  const e = errores()
  const engine = motorFalso()
  capa({ dem: 'aws', slopeBreaks: '15xx', slopeColors: 'tomato nocolor', elevationRange: '1 2 3', contours: NaN }).cristaeMount(engine)
  for (const k of ['slopeBreaks', 'slopeColors', 'elevationRange', 'contours']) assert.equal(k in engine.cfg, false, k)
  assert.equal(e.mock.callCount(), 4)
  e.mock.restore()
})

test('el motor que rechaza el alta deja la capa sin montar, sin lanzar y con un error', () => {
  const e = errores()
  const engine = motorFalso()
  engine.addTerrainLayer = () => { throw new TypeError('[terrain-layer] colorBy tiene que ser none') }
  const el = capa({ dem: 'aws', colorBy: 'x' })
  el.cristaeMount(engine)
  assert.equal(el.controls, null)
  assert.equal(e.mock.callCount(), 1)
  e.mock.restore()
})

test('cada atributo en vivo llega a UN update parcial con sólo lo que cambió', () => {
  const engine = motorFalso()
  const el = capa({ dem: 'aws' })
  el.cristaeMount(engine)
  const { handle } = engine
  const llamadas = () => handle.llamadas.splice(0)

  el.colorBy = 'slope'
  el.slopeBreaks = '15% 30%'
  el.slopeColors = '#a6d96a #fdae61 #d7191c'
  el.syncLayer(cambios('colorBy', 'slopeBreaks', 'slopeColors'))
  assert.deepEqual(llamadas(), [['update', {
    colorBy: 'slope', slopeBreaks: [0.15, 0.3], slopeColors: ['rgba(166, 217, 106, 1)', 'rgba(253, 174, 97, 1)', 'rgba(215, 25, 28, 1)'],
  }]])

  el.dem = 'mapterhorn'
  el.contours = 20
  el.clipTo = 'predios'
  el.elevationRange = '100 900'
  el.hillshade = false
  el.syncLayer(cambios('dem', 'contours', 'clipTo', 'elevationRange', 'hillshade'))
  assert.deepEqual(llamadas(), [['update', { dem: 'mapterhorn', contours: 20, clipTo: 'predios', elevationRange: [100, 900], hillshade: false }]])

  el.slopeBreaks = '17° 30°'
  el.syncLayer(cambios('slopeBreaks'))
  const [[, { slopeBreaks }]] = llamadas()
  assert.deepEqual(slopeBreaks, [Math.tan(17 * Math.PI / 180), Math.tan(30 * Math.PI / 180)])

  el.clipTo = undefined
  el.hillshade = undefined
  el.syncLayer(cambios('clipTo', 'hillshade'))
  assert.deepEqual(llamadas(), [['update', { clipTo: undefined, hillshade: undefined }]], 'quitar el atributo vuelve al valor por defecto')
})

test('visible y opacity van por su setter, y una prop ajena no toca el handle', () => {
  const engine = motorFalso()
  const el = capa({ dem: 'aws' })
  el.cristaeMount(engine)
  const { handle } = engine
  el.visible = false
  el.opacity = 0.3
  el.syncLayer(cambios('visible', 'opacity'))
  assert.deepEqual(handle.llamadas.splice(0), [['setVisible', false], ['setOpacity', 0.3]])
  el.syncLayer(cambios('pane', 'focusIds', 'fetch'))
  assert.deepEqual(handle.llamadas, [])
})

test('un atributo ilegible no cambia nada y avisa una vez; un TypeError del motor deja la capa como estaba', () => {
  const e = errores()
  const engine = motorFalso()
  const el = capa({ dem: 'aws' })
  el.cristaeMount(engine)
  const { handle } = engine

  el.slopeBreaks = '15%% 30%'
  el.elevationRange = 'uno dos'
  el.slopeColors = 'tomato nocolor'
  el.opacity = 7
  el.syncLayer(cambios('slopeBreaks', 'elevationRange', 'slopeColors', 'opacity'))
  el.syncLayer(cambios('slopeBreaks'))
  assert.deepEqual(handle.llamadas, [], 'nada llega al handle')
  assert.equal(e.mock.callCount(), 4, 'un error por atributo, una vez')

  el.dem = 'nadie'
  handle.update = () => { throw new TypeError('[terrain-layer] dem desconocido') }
  assert.doesNotThrow(() => el.syncLayer(cambios('dem')))
  assert.equal(e.mock.callCount(), 5)
  assert.throws(() => { handle.update = () => { throw new Error('bug') }; el.syncLayer(cambios('dem')) }, /bug/)
  e.mock.restore()
})

test('los colores se normalizan una vez por cambio, no por cada sync', () => {
  const engine = motorFalso()
  const el = capa({ dem: 'aws', slopeColors: 'tomato rebeccapurple' })
  el.cristaeMount(engine)
  const antes = engine.cfg.slopeColors
  let lecturas = 0
  const original = Object.getOwnPropertyDescriptor(ctx, 'fillStyle')
  Object.defineProperty(ctx, 'fillStyle', { ...original, get() { lecturas++; return original.get.call(this) }, configurable: true })
  el.syncLayer(cambios('slopeColors'))
  el.syncLayer(cambios('slopeColors'))
  Object.defineProperty(ctx, 'fillStyle', { ...original, configurable: true })
  assert.equal(lecturas, 0, 'misma cadena: no se vuelve a resolver')
  assert.deepEqual(engine.handle.llamadas.map(([, p]) => p.slopeColors), [antes, antes])
})

test('cristae:load y cristae:error salen filtrados por la capa, y el error cancelable va a consola sin oyente', () => {
  const e = errores()
  const engine = motorFalso()
  const el = capa({ dem: 'aws' })
  el.cristaeMount(engine)
  engine.señales.get('dataload')({ layerId: 'otra', url: 'u', count: 1 })
  engine.señales.get('dataload')({ layerId: 'relieve', url: 'https://t.test/12/1/2.png', count: 4 })
  engine.señales.get('dataerror')({ layerId: 'relieve', url: 'https://t.test/12/1/3.png', code: 'http', message: 'HTTP 500', status: 500 })
  assert.deepEqual(el.eventos.map(ev => [ev.type, ev.detail.count ?? ev.detail.code]), [['cristae:load', 4], ['cristae:error', 'http']])
  assert.equal(el.eventos[1].cancelable, true)
  assert.equal(e.mock.callCount(), 1)
  el.cristaeUnmount()
  assert.equal(engine.señales.size, 0, 'la baja corta los oyentes')
  assert.deepEqual(engine.quitadas, ['relieve'])
  e.mock.restore()
})

test('la atribución del dem va al mapa al montar, al cambiar de dem y al desmontar', () => {
  const dadas = []
  const mapa = { cristaeAttribution: (el, texto) => dadas.push(texto) }
  const engine = motorFalso()
  const el = capa({ dem: 'aws', closest: () => mapa })
  el.cristaeMount(engine)
  assert.deepEqual(dadas, [terrainPresets.aws.attribution])

  el.dem = JSON.stringify({ ...DEM, attribution: 'Datos propios <b>x</b>' })
  el.syncLayer(cambios('dem'))
  el.dem = JSON.stringify(DEM)
  el.syncLayer(cambios('dem'))
  assert.deepEqual(dadas.slice(1), ['Datos propios <b>x</b>', null], 'una fuente sin atribución la quita')

  el.dem = 'mapterhorn'
  el.syncLayer(cambios('dem'))
  el.closest = () => null   // ya desconectada: el mapa se recuerda
  el.cristaeUnmount()
  assert.deepEqual(dadas.slice(3), [terrainPresets.mapterhorn.attribution, null])
})

test('un dem rechazado por el motor no toca la atribución', () => {
  const e = errores()
  const dadas = []
  const engine = motorFalso()
  const el = capa({ dem: 'aws', closest: () => ({ cristaeAttribution: (_, t) => dadas.push(t) }) })
  el.cristaeMount(engine)
  engine.handle.update = () => { throw new RangeError('[terrain-layer] dem.zoom') }
  el.dem = DEM
  el.syncLayer(cambios('dem'))
  assert.equal(dadas.length, 1)
  e.mock.restore()
})

// El texto del dem es un nodo de texto del template de Lit: nunca unsafeHTML.
const buscar = (plantilla, parte) => {
  if (!plantilla || typeof plantilla !== 'object') return []
  if (Array.isArray(plantilla)) return plantilla.flatMap(p => buscar(p, parte))
  const propio = plantilla.strings?.some(t => t.includes(`part="${parte}"`)) ? [plantilla] : []
  return [...propio, ...(plantilla.values ?? []).flatMap(v => buscar(v, parte))]
}

test('<cristae-map> dibuja la atribución del dem detrás de la del proveedor, como texto', async () => {
  const { el } = await montarMapa({}, Object.assign(makeMap(), { getMinZoom: () => 2, getMaxZoom: () => 5, addLayer() { return this } }))
  const peticiones = []
  el.requestUpdate = () => peticiones.push(1)
  const capa1 = {}, capa2 = {}
  const XSS = '<b>x</b>'

  el.cristaeAttribution(capa1, XSS)
  el.cristaeAttribution(capa2, XSS)
  const spans = buscar(el.render(), 'attribution-dem')
  assert.equal(spans.length, 1, 'el mismo texto de dos capas se dibuja una vez')
  assert.deepEqual(spans[0].values, [XSS], 'binding de texto: la cadena cruda, sin directiva')
  assert.equal(typeof spans[0].values[0], 'string')
  assert.ok(buscar(el.render(), 'attribution').length >= 1, 'comparte la caja de atribución')

  el.cristaeAttribution(capa1, 'Otro')
  assert.deepEqual(buscar(el.render(), 'attribution-dem').map(s => s.values[0]), ['Otro', XSS])

  el.cristaeAttribution(capa1, null)
  el.cristaeAttribution(capa2, null)
  assert.deepEqual(buscar(el.render(), 'attribution-dem'), [])
  assert.equal(buscar(el.render(), 'attribution').length, 0, 'sin proveedor ni dem no hay caja')
  const n = peticiones.length
  el.cristaeAttribution(capa1, null)
  assert.equal(peticiones.length, n, 'quitar lo que no está no repinta')
  el.disconnectedCallback()
})

test('cristae/map reexporta terrainPresets con la misma identidad que cristae/geometry y registra la capa', async () => {
  const mapa = await import('../../src/index.js')
  assert.equal(mapa.terrainPresets, deGeometria)
  assert.equal(mapa.CristaeTerrainLayer, CristaeTerrainLayer)
  assert.equal(globalThis.customElements.get('cristae-terrain-layer') ?? CristaeTerrainLayer, CristaeTerrainLayer)
})
