// <cristae-labeled>: modificador `map` con `reach: 'nearest'`. Con las firmas REALES registradas por el entry,
// se monta cada árbol de la regla de qué se rotula (docs/labeled.md) y se valida R2 con el calor solo, los
// TypeError de las props y los del hijo antes de tocar el motor, el cambio en caliente sin remontar,
// `visible`, que `renderer` no tape el `render()` de Lit y los avisos de retiro. Los hijos son nodos falsos con
// el protocolo del reductor, o los modificadores reales; el motor anota las altas.
import '../../test-helpers/element-stub.mjs'
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import '../../src/index.js'
import { CristaeLayerElement } from '../../src/element/base.js'
import { CristaeLabeled } from '../../src/element/CristaeLabeled.js'
import { CristaeCluster } from '../../src/element/CristaeCluster.js'
import { CristaeGeodesic } from '../../src/element/CristaeGeodesic.js'
import { CristaeOverlay } from '../../src/element/CristaeOverlay.js'
import { CristaeLabelLayer } from '../../src/element/CristaeLabelLayer.js'
import { grammar } from '../../src/element/composite.js'
import { GrammarError, leafUnits, validate } from '../../src/grammar/index.js'

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

const modificador = (Clase, tag) => (...hijos) => Object.assign(new Clase(), {
  tagName: tag, children: hijos, getAttribute: () => null, _enclosingModifier: () => null,
})
const rotulo    = modificador(CristaeLabeled, 'CRISTAE-LABELED')
const cluster   = modificador(CristaeCluster, 'CRISTAE-CLUSTER')
const geodesica = modificador(CristaeGeodesic, 'CRISTAE-GEODESIC')
const overlay   = (...hijos) => Object.assign(modificador(CristaeOverlay, 'CRISTAE-OVERLAY')(...hijos), { iconSet: 'badges' })

// Motor falso: anota cada `addLabels` y lo que pasa por su handle. Los hosts de `nulos` no son rotulables.
const motor = ({ nulos = [], capas = {} } = {}) => {
  const e = {
    altas: [], updates: [], bajas: [], folds: [],
    addLabels: cfg => {
      e.altas.push(cfg)
      return nulos.includes(cfg.hostId) ? null : { update: o => e.updates.push([cfg.hostId, o]), remove: () => e.bajas.push(cfg.hostId) }
    },
    addGeodesic: () => () => {},
    addOverlay: ({ id }) => ({ id }),
    addClusterFold: targets => {
      e.folds.push(targets.map(t => t.id))
      return { kind: 'bubble', id: 'flota:clusters', handle: { id: 'flota:clusters' }, suppressed: null }
    },
    getLayer: id => capas[id] ?? null,
    removeLayer: () => false,
  }
  return e
}

const hosts = e => e.altas.map(c => c.hostId)

test('la firma: modificador `map` que alcanza lo que produce el hijo directo', () => {
  assert.deepEqual(CristaeLabeled.cristaeSignature, {
    consumes: ['point', 'line', 'polygon', 'shape', 'html', 'bubble'], produces: ['label'], combine: 'map', arity: 'wrapper', reach: 'nearest',
    passThrough: true,
  }, 'la capa base sube intacta')
  assert.equal(grammar.isWrapper('cristae-labeled'), true)
})

test('los árboles de la regla: qué rotula cada uno', () => {
  const casos = [
    ['labeled > puntos', () => rotulo(hoja('cristae-point-layer', 'flota')), ['flota']],
    ['labeled > geodesic > line', () => rotulo(geodesica(hoja('cristae-line-layer', 'rutas'))), ['rutas']],
    ['labeled > overlay > puntos', () => rotulo(overlay(hoja('cristae-point-layer', 'flota'))), ['flota']],
    ['cluster > labeled > puntos', () => cluster(rotulo(hoja('cristae-point-layer', 'flota'))), ['flota']],
    ['labeled > cluster > puntos', () => rotulo(cluster(hoja('cristae-point-layer', 'flota'))), ['flota:clusters']],
    ['labeled > cluster > labeled > puntos', () => rotulo(cluster(rotulo(hoja('cristae-point-layer', 'flota')))), ['flota', 'flota:clusters']],
    ['labeled > labeled > line', () => rotulo(rotulo(hoja('cristae-line-layer', 'rutas'))), ['rutas', 'rutas']],
    ['hermanas de distinto tipo', () => rotulo(hoja('cristae-point-layer', 'camiones'), hoja('cristae-polygon-layer', 'predios')), ['camiones', 'predios']],
  ]
  casos.forEach(([arbol, armar, esperado]) => {
    const engine = motor()
    const raiz   = armar()
    assert.equal(validate(raiz, ctx), true, arbol)
    raiz.cristaeMount(engine)
    assert.deepEqual(hosts(engine), esperado, arbol)
  })
})

test('cluster > labeled > puntos: el cluster sigue agrupando los puntos', () => {
  const engine = motor()
  cluster(rotulo(hoja('cristae-point-layer', 'flota'))).cristaeMount(engine)
  assert.deepEqual(engine.folds, [['flota']])
})

test('envolver sólo el calor o la imagen es R2, y un hermano que no se consume pasa intacto', () => {
  ;['cristae-heat-layer', 'cristae-image-layer', 'cristae-editable-point', 'cristae-label-layer'].forEach(tag =>
    assert.throws(() => validate(rotulo(hoja(tag)), ctx), e => e instanceof GrammarError && e.code === 'R2', tag))

  const engine = motor()
  const raiz   = rotulo(hoja('cristae-heat-layer', 'calor'), hoja('cristae-point-layer', 'flota'))
  raiz.cristaeMount(engine)
  assert.deepEqual(hosts(engine), ['flota'])
  assert.deepEqual(raiz.cristaeUnits().map(u => u.kind), ['heat', 'point', 'label'])
})

test('la config llega entera a cada alta, con `visible` normalizado', () => {
  const engine = motor()
  const textOf = r => r.nombre
  const raiz   = Object.assign(rotulo(hoja('cristae-line-layer', 'rutas')), { textOf, repeat: 240, offset: 6 })
  raiz.cristaeMount(engine)
  const { hostId, ...cfg } = engine.altas[0]
  assert.equal(hostId, 'rutas')
  assert.equal(cfg.textOf, textOf)
  assert.deepEqual([cfg.repeat, cfg.offset, cfg.visible], [240, 6, true])
})

test('TypeError de las props: sale de cristaeConfig y del montaje, sin tocar el motor ni montar al hijo', () => {
  const casos = [
    { renderer: 'gl' },
    { renderer: 'webgpu' },
    { htmlOf: () => 'x', renderer: 'canvas' },
    { interactive: true },
    { paint: () => {}, renderer: 'html' },
    { paint: () => {}, placement: 'below' },
    { repeat: 0 },
    { offset: Number.NaN },
    { placement: 'center', repeat: 100 },
    { orientation: 'up' },
  ]
  casos.forEach(props => {
    const engine = motor()
    const punto  = hoja('cristae-point-layer', 'flota')
    const raiz   = Object.assign(rotulo(punto), props)
    assert.throws(() => raiz.cristaeConfig(), TypeError, JSON.stringify(props))
    assert.throws(() => raiz.mountLayer(engine), TypeError, JSON.stringify(props))
    assert.deepEqual([engine.altas.length, punto.montajes], [0, 0], JSON.stringify(props))
  })
})

test('`renderer="gl"` dice que está pendiente', () => {
  assert.throws(() => Object.assign(rotulo(hoja('cristae-line-layer')), { renderer: 'gl' }).cristaeConfig(), /pendiente/)
})

test('TypeError del hijo: un placement que la capa alcanzada no admite lanza antes de montar', () => {
  const casos = [
    ['along sobre puntos', 'along', () => hoja('cristae-point-layer', 'flota')],
    ['along sobre burbujas', 'along', () => cluster(hoja('cristae-point-layer', 'flota'))],
    ['below sobre una línea', 'below', () => hoja('cristae-line-layer', 'rutas')],
    ['along sobre formas', 'along', () => hoja('cristae-shape-layer', 'antenas')],
    ['along sobre una de dos hermanas', 'along', () => hoja('cristae-html-layer', 'avisos')],
  ]
  casos.forEach(([caso, placement, hijo]) => {
    const engine = motor()
    const raiz   = Object.assign(rotulo(hijo(), hoja('cristae-line-layer', 'otra')), { placement })
    assert.doesNotThrow(() => raiz.cristaeConfig(), caso)
    assert.throws(() => raiz.mountLayer(engine), TypeError, caso)
    assert.deepEqual([engine.altas.length, engine.folds.length], [0, 0], caso)
  })
})

test('con `auto`, `repeat` y `orientation` valen para las hermanas que van sobre el trazo', () => {
  const engine = motor()
  const raiz   = Object.assign(rotulo(hoja('cristae-point-layer', 'flota'), hoja('cristae-line-layer', 'rutas')),
    { repeat: 200, orientation: 'path' })
  raiz.cristaeMount(engine)
  assert.deepEqual(hosts(engine), ['flota', 'rutas'])
})

test('un `textOf` nuevo no remonta: viaja por `update`', () => {
  const engine = motor()
  const linea  = hoja('cristae-line-layer', 'rutas')
  const raiz   = Object.assign(rotulo(linea), { textOf: r => r.a })
  raiz.cristaeMount(engine)

  const otro  = r => r.b
  raiz.textOf = otro
  raiz.syncLayer(new Map([['textOf', undefined]]))
  assert.deepEqual(engine.updates, [['rutas', { textOf: otro }]])
  assert.deepEqual([engine.altas.length, linea.montajes], [1, 1])

  raiz.syncLayer(new Map([['focusIds', undefined]]))
  assert.equal(engine.updates.length, 1, 'una prop que no es suya no llega a los rótulos')
})

test('una prop quitada vuelve a su valor por defecto', () => {
  const engine = motor()
  const raiz   = Object.assign(rotulo(hoja('cristae-line-layer', 'rutas')), { repeat: 200 })
  raiz.cristaeMount(engine)
  raiz.repeat = undefined
  raiz.syncLayer(new Map([['repeat', 200]]))
  assert.deepEqual(engine.updates, [['rutas', { repeat: null }]])
})

test('un cambio en caliente inválido no toca ningún host', () => {
  const engine = motor()
  const raiz   = rotulo(hoja('cristae-line-layer', 'rutas'), hoja('cristae-point-layer', 'flota'))
  raiz.cristaeMount(engine)

  raiz.placement = 'along'
  assert.throws(() => raiz.syncLayer(new Map([['placement', undefined]])), TypeError, 'along sobre los puntos')
  raiz.placement = 'center'
  raiz.repeat    = 0
  assert.throws(() => raiz.syncLayer(new Map([['placement', undefined], ['repeat', undefined]])), TypeError)
  assert.deepEqual(engine.updates, [])

  raiz.repeat = undefined
  raiz.syncLayer(new Map([['placement', undefined], ['repeat', 0]]))
  assert.deepEqual(engine.updates.map(([host]) => host), ['rutas', 'flota'])
})

test('`visible="false"` oculta sin desmontar', () => {
  CristaeLabeled.finalize()
  const { fromAttribute } = CristaeLabeled.elementProperties.get('visible').converter
  assert.deepEqual(['false', '0', '', 'true'].map(fromAttribute), [false, false, true, true])

  const engine = motor()
  const linea  = hoja('cristae-line-layer', 'rutas')
  const raiz   = Object.assign(rotulo(linea), { visible: 'false' })
  assert.equal(raiz.cristaeConfig().visible, false, 'como propiedad llega crudo')
  raiz.cristaeMount(engine)
  assert.equal(engine.altas[0].visible, false)

  raiz.visible = true
  raiz.syncLayer(new Map([['visible', 'false']]))
  assert.deepEqual(engine.updates, [['rutas', { visible: true }]])
  assert.equal(linea.montajes, 1)
})

test('asignar `renderer` no tapa el `render()` de Lit', () => {
  const el = rotulo(hoja('cristae-line-layer'))
  el.renderer = 'html'
  assert.equal(el.render, CristaeLayerElement.prototype.render)
  assert.equal(CristaeLabeled.elementProperties.has('render'), false)
  assert.equal(el.renderer, 'html')
})

test('alterna y da de baja sólo sus rótulos, no los de un `labeled` anidado', () => {
  const engine  = motor()
  const adentro = rotulo(hoja('cristae-line-layer', 'rutas'))
  const afuera  = rotulo(adentro)
  afuera.cristaeMount(engine)
  assert.deepEqual(hosts(engine), ['rutas', 'rutas'])

  afuera.offset = 8
  afuera.syncLayer(new Map([['offset', undefined]]))
  assert.equal(engine.updates.length, 1, 'el de afuera actualiza sólo el suyo')

  afuera.cristaeUnmount()
  assert.deepEqual(engine.bajas, ['rutas'], 'y da de baja sólo el suyo')
  afuera.cristaeUnmount()
  assert.deepEqual(engine.bajas, ['rutas'], 'una segunda baja no repite')
})

test('un editor no se rotula y se avisa una vez por editor', () => {
  const warn   = mock.method(console, 'warn', () => {})
  const engine = motor({ nulos: ['trazo'], capas: { trazo: { kind: 'editable' } } })
  rotulo(hoja('cristae-editable-polyline', 'trazo')).cristaeMount(engine)
  rotulo(hoja('cristae-editable-polyline', 'trazo')).cristaeMount(engine)
  assert.equal(warn.mock.callCount(), 1)
  assert.match(warn.mock.calls[0].arguments[0], /trazo.*junto al editor/)
  warn.mock.restore()
})

test('<cristae-label-layer> avisa su retiro una vez por página, al montarse como capa', () => {
  const warn   = mock.method(console, 'warn', () => {})
  const handle = { id: 'nombres', setVisible() {} }
  const capa   = () => Object.assign(Object.create(CristaeLabelLayer.prototype), { bindTo: 'flota', visible: true, layerId: () => 'nombres' })
  const engine = { addLabelLayer: () => handle }
  capa().mountLayer(engine)
  capa().mountLayer(engine)
  assert.equal(warn.mock.callCount(), 1)
  assert.match(warn.mock.calls[0].arguments[0], /se retira en 1\.0.*<cristae-labeled>/)
  warn.mock.restore()
})

test('<cristae-cluster> avisa una vez por página al leer una hija `slot="bubble"` de rótulo', () => {
  const warn     = mock.method(console, 'warn', () => {})
  const burbuja  = tag => ({ tagName: tag, getAttribute: k => (k === 'slot' ? 'bubble' : null) })
  const conHija  = hija => Object.assign(new CristaeCluster(), { children: [hija] })
  assert.equal(conHija(burbuja('CRISTAE-POINT-LAYER')).cristaeConfig().bubble.kind, 'point')
  assert.equal(warn.mock.callCount(), 0, 'la de puntos no avisa')

  assert.equal(conHija(burbuja('CRISTAE-LABEL-LAYER')).cristaeConfig().bubble.kind, 'label')
  conHija(burbuja('CRISTAE-LABEL-LAYER')).cristaeConfig()
  assert.equal(warn.mock.callCount(), 1)
  assert.match(warn.mock.calls[0].arguments[0], /slot="bubble".*se retira en 1\.0.*<cristae-labeled>/)
  warn.mock.restore()
})
