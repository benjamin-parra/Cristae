// `engine.surfaces()` y la señal `surfacechange`: una fila por superficie WebGL del motor —su capa, su
// clase, su pane, su z, su estado, si hay algo que dibujarle y si se ve— y el aviso cuando el navegador
// le quita el contexto a una. Perder una necesaria es presión de cupo: la política suelta las prescindibles
// (acá, la línea vacía), y cada una avisa. El doble no cuelga los canvases de su pane, así que para la política
// toda capa se ve. Corre con:
//   node --test test/engine/superficies.test.mjs
//
// El harness va PRIMERO: instala el shim window/document que la carga del árbol toca por top-level.
import { decorarElementos, makeIconSet, makeLeaflet, makeMap } from '../../test-helpers/engine-stub.mjs'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { MapEngine } from '../../src/engine/MapEngine.js'
import { adoptLeafletHost } from '../../src/host/LeafletHost.js'
import { createSource } from '../../src/data/Source.js'

// Cada <canvas> guarda los oyentes que se le registran: es por donde el navegador avisa
// `webglcontextlost`, y el doble lo dispara a mano.
const sinOyentes = decorarElementos((el, tag) => {
  tag === 'canvas' && Object.assign(el, {
    oyentes          : {},
    addEventListener : (tipo, fn) => (el.oyentes[tipo] ??= []).push(fn),
  })
  return el
})
after(sinOyentes)

const flush     = () => new Promise(r => setTimeout(r, 5))
// Una capa vacía toma su contexto en un rato ocioso, después del alta: se espera a que ninguna quede sin tomarlo.
const asentar   = async engine => {
  for (let i = 0; i < 50 && engine.surfaces().some(s => s.state === 'none'); i++) await flush()
}
const flota     = [{ id: 1, lat: 0, lng: 0, size: 24 }]
const puntos    = { idOf: it => it.id, positionOf: it => ({ lat: it.lat, lng: it.lng }), sizeOf: it => it.size }
const lineas    = { idOf: r => r.id, pathOf: r => r.path }
const zonas     = { idOf: g => g.id, ringsOf: () => [[[0, 0], [0, 1], [1, 1]]] }
const recorrido = { id: 'r', path: [[0, 0], [0, 1]] }

// Un motor con tres capas de clases distintas: puntos con datos, líneas vacías y polígonos con datos
// ocultos. Cada una trae su `z`. El calor dibuja en 2D: no tiene superficie y no sale.
const montar = async () => {
  const map    = makeMap()
  const engine = new MapEngine({ host: adoptLeafletHost(map, { leaflet: makeLeaflet() }) })
  engine.addPointLayer({ id: 'flota', accessors: puntos, iconSet: makeIconSet(), data: flota, z: 378 })
  const rutas = engine.addLineLayer({ id: 'rutas', accessors: lineas, z: 380 })
  engine.addPolygonLayer({ id: 'zonas', accessors: zonas, data: [{ id: 'z1' }], visible: false, z: 382 })
  engine.addHeatLayer({ id: 'calor', accessors: puntos, data: flota })
  await flush()
  await asentar(engine)
  return { engine, map, rutas }
}

const fila = (engine, id) => engine.surfaces().find(s => s.layerId === id)

const canvasDe = (engine, id) => {
  const { layer, editor } = engine.getLayer(id)
  return (layer ?? editor).surface.canvas
}
// Lo que hace el navegador al sacarle el contexto a un canvas, sin llamar a `preventDefault`.
const perder = (engine, id) => canvasDe(engine, id).oyentes.webglcontextlost.forEach(fn => fn())

test('una fila por superficie WebGL, en el orden de alta, con su clase, su pane, su z y su estado', async () => {
  const { engine } = await montar()
  assert.deepEqual(engine.surfaces(), [
    { layerId: 'flota', kind: 'point',   pane: 'cristae-point-flota',   z: 378, cssZoom: false, state: 'live', hasContent: true,  visible: true },
    { layerId: 'rutas', kind: 'line',    pane: 'cristae-line-rutas',    z: 380, cssZoom: true,  state: 'live', hasContent: false, visible: true },
    { layerId: 'zonas', kind: 'polygon', pane: 'cristae-polygon-zonas', z: 382, cssZoom: true,  state: 'live', hasContent: true,  visible: false },
  ])
  engine.destroy()
})

test('hasContent, visible y z siguen a la capa', async () => {
  const { engine, rutas } = await montar()
  rutas.source.set([recorrido])
  await flush()
  assert.equal(fila(engine, 'rutas').hasContent, true, 'la línea que recibe un recorrido tiene qué dibujar')

  rutas.source.set([])
  await flush()
  assert.equal(fila(engine, 'rutas').hasContent, false, 'y al vaciarla, deja de tenerlo')

  engine.setLayerVisibility('flota', false)
  assert.equal(fila(engine, 'flota').visible, false)
  engine.setLayerVisibility('flota', true)
  engine.setLayerEnabled('flota', false)
  assert.equal(fila(engine, 'flota').visible, false, 'deshabilitada no se ve aunque esté visible')
  engine.setLayerEnabled('flota', true)
  assert.equal(fila(engine, 'flota').visible, true)

  engine.setLayerZ('flota', 620)
  assert.equal(fila(engine, 'flota').z, 620, 'la z es la vigente del pane, no la del alta')
  engine.setLayerZ('flota', null)
  assert.equal(fila(engine, 'flota').z, 378)
  engine.destroy()
})

test('una capa ligada se ve si su host se ve', async () => {
  const { engine } = await montar()
  engine.addOverlay({ id: 'insignia', hostId: 'flota', iconSet: makeIconSet() })
  assert.equal(fila(engine, 'insignia').kind, 'overlay')
  assert.equal(fila(engine, 'insignia').visible, true)

  engine.setLayerEnabled('flota', false)
  assert.equal(fila(engine, 'insignia').visible, false, 'sigue la suerte de su host')
  engine.destroy()
})

test('las formas y los círculos, que dibujan con un polígono por dentro, tienen su fila con la clase de la capa', async () => {
  const { engine } = await montar()
  const forma = { idOf: s => s.id, positionOf: s => ({ lat: s.lat, lng: s.lng }), radiusOf: () => 500, radiusMetersOf: () => 500 }
  const datos = [{ id: 's', lat: 0, lng: 0 }]
  engine.addShapeLayer({ id: 'alcances', accessors: forma, data: datos })
  engine.addCircleLayer({ id: 'radios', accessors: forma, data: datos })
  engine.addShapeLayer({ id: 'vacia', accessors: forma })
  await flush()
  await asentar(engine)

  const resumen = id => [fila(engine, id).kind, fila(engine, id).state, fila(engine, id).hasContent]
  assert.deepEqual(resumen('alcances'), ['shape', 'live', true])
  assert.deepEqual(resumen('radios'), ['circle', 'live', true])
  assert.deepEqual(resumen('vacia'), ['shape', 'live', false])
  engine.destroy()
})

test('el editor también tiene fila: con contenido si hay geometría o un trazado en curso', async () => {
  const { engine } = await montar()
  const editor = engine.addEditableLayer({ id: 'geo', kind: 'polygon', mode: 'edit' })
  const geo    = () => fila(engine, 'geo')
  assert.deepEqual([geo().kind, geo().state, geo().cssZoom, geo().hasContent], ['editable', 'live', true, false])
  assert.equal(typeof geo().z, 'number')

  editor.setMode('draw')
  assert.equal(geo().hasContent, true, 'trazando no está vacío')
  editor.setMode('edit')
  assert.equal(geo().hasContent, false)
  editor.setValue([[0, 0], [0, 1], [1, 1]])
  assert.equal(geo().hasContent, true, 'con vértices tiene qué mostrar')
  engine.destroy()
})

test('quitar una capa saca su fila, y destruir el motor las saca todas', async () => {
  const { engine } = await montar()
  engine.removeLayer('rutas')
  assert.deepEqual(engine.surfaces().map(s => s.layerId), ['flota', 'zonas'])
  engine.destroy()
  assert.deepEqual(engine.surfaces(), [])
})

/* ── El contexto perdido ── */

test('al perderse el contexto de una necesaria, su fila queda lost y la vacía se suelta', async () => {
  const { engine } = await montar()
  perder(engine, 'flota')
  assert.deepEqual(engine.surfaces().slice(0, 2).map(s => [s.layerId, s.state]), [['flota', 'lost'], ['rutas', 'released']])
  engine.destroy()
})

test('surfacechange avisa la pérdida con la fila de la capa, y sólo de esa', async () => {
  const { engine, rutas } = await montar()
  rutas.source.set([recorrido])                         // con contenido es necesaria, y no hay prescindibles que soltar
  await flush()
  const avisos = []
  const baja   = engine.on('surfacechange', detail => avisos.push(detail))

  perder(engine, 'rutas')
  assert.equal(avisos.length, 1)
  assert.deepEqual(avisos[0], fila(engine, 'rutas'), 'el detail es la fila de surfaces()')
  assert.deepEqual([avisos[0].layerId, avisos[0].state], ['rutas', 'lost'])

  baja()
  perder(engine, 'flota')
  assert.equal(avisos.length, 1, 'dada de baja, no oye más')
  engine.destroy()
})

test('el editor también avisa su pérdida', async () => {
  const { engine } = await montar()
  engine.addEditableLayer({ id: 'geo', kind: 'polygon', mode: 'edit' })
  const avisos = []
  engine.on('surfacechange', detail => avisos.push([detail.layerId, detail.kind, detail.state]))

  perder(engine, 'geo')
  assert.deepEqual(avisos, [['rutas', 'line', 'released'], ['geo', 'editable', 'lost']], 'la vacía se suelta primero')
  engine.destroy()
})

test('la capa que attachSource cambió avisa con su superficie nueva, y la de antes no', async () => {
  const { engine } = await montar()
  const vieja  = canvasDe(engine, 'flota')
  const avisos = []
  engine.on('surfacechange', detail => avisos.push(detail.layerId))

  const source = createSource(puntos)
  source.set(flota)                                     // con algo que dibujar, la capa nueva toma el contexto ya
  engine.attachSource('flota', source)
  const nueva = canvasDe(engine, 'flota')
  assert.notEqual(nueva, vieja, 'la capa nueva tiene su superficie')

  // `loseContext` del destroy hace salir `webglcontextlost` del canvas viejo, y no es una pérdida.
  vieja.oyentes.webglcontextlost.forEach(fn => fn())
  assert.deepEqual(avisos, [], 'la superficie destruida no avisa')
  assert.equal(fila(engine, 'flota').state, 'live')

  nueva.oyentes.webglcontextlost.forEach(fn => fn())
  assert.deepEqual(avisos, ['rutas', 'flota'], 'la nueva avisa su pérdida, y la vacía se suelta')
  assert.equal(fila(engine, 'flota').state, 'lost')
  engine.destroy()
  source.destroy()
})

test('quitar la capa o destruir el motor no es una pérdida: no avisan', async () => {
  const { engine } = await montar()
  const avisos = []
  engine.on('surfacechange', detail => avisos.push(detail.layerId))
  const canvas = canvasDe(engine, 'rutas')

  engine.removeLayer('rutas')
  canvas.oyentes.webglcontextlost.forEach(fn => fn())   // el evento que `loseContext` del destroy deja en camino
  engine.destroy()
  assert.deepEqual(avisos, [])
})
