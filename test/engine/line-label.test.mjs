// `addLineLabelLayer` en el motor: el bind por nombre a una capa de líneas, el alta oculta, el `textOf` que
// lanza, el estilo inválido y la baja del host. Lo que se mira es lo que la capa pinta (`fillText`).
import '../../test-helpers/engine-stub.mjs'
import { makeLeaflet, makeMap } from '../../test-helpers/engine-stub.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { MapEngine } from '../../src/engine/MapEngine.js'
import { adoptLeafletHost } from '../../src/host/LeafletHost.js'
import { createSource } from '../../src/data/Source.js'

const frame = () => new Promise(resolve => setTimeout(resolve, 5))

// Los canvas 2D del motor van a un contexto que anota los glifos; el resto queda como en el harness.
const spyText = () => {
  const fill     = []
  const ctx      = new Proxy({ measureText: ch => ({ width: 7 * [...ch].length }), fillText: ch => fill.push(ch) },
    { get: (t, p) => t[p] ?? (() => {}), set: () => true })
  const original = document.createElement
  document.createElement = tag => {
    const el = original.call(document, tag)
    if (String(tag).toLowerCase() !== 'canvas') return el
    const real = el.getContext
    el.getContext = kind => (kind === '2d' ? ctx : real(kind))
    return el
  }
  return { fill, restore: () => { document.createElement = original } }
}

const accessors = { idOf: r => r.id, pathOf: r => r.path }
const RUTAS     = [{ id: 'A', path: [[0, 0], [0, 40]] }, { id: 'B', path: [[5, 0], [5, 40]] }]

const motor = () => {
  const map = makeMap()
  return { map, engine: new MapEngine({ host: adoptLeafletHost(map, { leaflet: makeLeaflet() }) }) }
}

test('bindTo pendiente: se resuelve al dar de alta la capa de líneas', async () => {
  const spy        = spyText()
  const { engine } = motor()
  engine.addLineLabelLayer({ id: 'texto', bindTo: 'rutas' })
  await frame()
  assert.deepEqual(spy.fill, [], 'sin host no hay texto')

  engine.addLineLayer({ id: 'rutas', accessors, data: RUTAS })
  await frame()
  assert.ok(spy.fill.includes('A') && spy.fill.includes('B'), `rotuladas: ${spy.fill}`)
  engine.destroy()
  spy.restore()
})

test('bindTo a una capa que no es de líneas queda pendiente', async () => {
  const spy        = spyText()
  const { engine } = motor()
  engine.addHtmlLayer({ id: 'rutas', accessors: { idOf: r => r.id, positionOf: () => ({ lat: 0, lng: 0 }), htmlOf: () => '' }, data: RUTAS })
  engine.addLineLabelLayer({ id: 'texto', bindTo: 'rutas' })
  await frame()
  assert.deepEqual(spy.fill, [])
  engine.destroy()
  spy.restore()
})

test('el alta con visible: false no pinta, y setVisible(true) sí', async () => {
  const spy        = spyText()
  const { engine } = motor()
  engine.addLineLayer({ id: 'rutas', accessors, data: RUTAS })
  const texto = engine.addLineLabelLayer({ id: 'texto', bindTo: 'rutas', visible: false })
  await frame()
  assert.deepEqual(spy.fill, [])
  texto.setVisible(true)
  assert.ok(spy.fill.length > 0)
  engine.destroy()
  spy.restore()
})

test('standalone con Source propia: los accessors salen de la Source', async () => {
  const spy    = spyText()
  const source = createSource(accessors)
  source.set(RUTAS.slice(0, 1))
  const { engine } = motor()
  engine.addLineLabelLayer({ id: 'texto', source, textOf: r => `ruta ${r.id}` })
  await frame()
  assert.equal(spy.fill.join('').slice(0, 6), 'ruta A')
  engine.destroy()
  spy.restore()
})

test('un textOf que lanza queda aislado: el resto se dibuja', async () => {
  const spy     = spyText()
  const errores = []
  const error   = console.error
  console.error = (...args) => errores.push(args)
  const { engine } = motor()
  engine.addLineLayer({ id: 'rutas', accessors, data: RUTAS })
  engine.addLineLabelLayer({ id: 'texto', bindTo: 'rutas', textOf: r => { if (r.id === 'A') throw new Error('x'); return r.id } })
  await frame()
  console.error = error
  assert.ok(!spy.fill.includes('A') && spy.fill.includes('B'))
  assert.ok(errores.length > 0, 'el error se informa')
  engine.destroy()
  spy.restore()
})

test('estilo inválido lanza TypeError antes de registrar la capa ni dejar su pane', () => {
  const { engine, map } = motor()
  assert.throws(() => engine.addLineLabelLayer({ id: 'texto', bindTo: 'rutas', style: { orientation: 'up' } }), TypeError)
  assert.equal(engine.getLayer('texto'), null)
  assert.equal(map.getPane('cristae-line-label-texto'), null)

  const texto = engine.addLineLabelLayer({ id: 'texto', bindTo: 'rutas' })
  assert.throws(() => texto.style({ repeat: Infinity }), TypeError)
  assert.equal(texto.style({ repeat: 120 }).repeat, 120)
  engine.destroy()
})

test('z por defecto: sobre su host, en la banda de las etiquetas', () => {
  const { engine } = motor()
  engine.addLineLayer({ id: 'rutas', accessors, data: RUTAS })
  engine.addLineLabelLayer({ id: 'texto', bindTo: 'rutas' })
  assert.ok(engine.getLayer('texto').zIndex >= engine.getLayer('rutas').zIndex + 200)
  engine.destroy()
})

// Heredado de la capa de etiquetas de puntos (DISENO-PARIDAD §3, «Baja del host»): la baja del host no
// suelta la Source ligada, y un host nuevo con el mismo id no se vuelve a ligar. Con la Source del
// consumidor, que sobrevive al host, se ve. Este test lo fija; el día que `removeLayer` suelte a los
// ligados, cambia junto con el de la capa de etiquetas.
test('baja del host: el texto sigue ligado a la Source vieja', async () => {
  const spy        = spyText()
  const { engine } = motor()
  const vieja      = createSource(accessors)
  vieja.set(RUTAS)
  engine.addLineLayer({ id: 'rutas', source: vieja })
  engine.addLineLabelLayer({ id: 'texto', bindTo: 'rutas' })
  engine.removeLayer('rutas')
  engine.addLineLayer({ id: 'rutas', accessors, data: [{ id: 'N', path: RUTAS[0].path }] })
  await frame()
  spy.fill.length = 0

  vieja.set([{ id: 'V', path: RUTAS[0].path }])
  await frame()
  assert.ok(spy.fill.includes('V') && !spy.fill.includes('N'), `dibuja la Source vieja: ${spy.fill}`)
  engine.destroy()
  spy.restore()
})
