// El estado de dibujo del motor: `drawingstart` al entrar el primer editor que toma la pulsación para
// dibujar y `drawingend` al salir el último, por `engine.on`. Corre con:
//   node --test test/engine/estado-de-dibujo.test.mjs
//
// Importa el helper de stubs PRIMERO: instala el shim window/document que la carga del árbol toca por
// top-level.
import { conGlDeEdicion, makeEditGl, makeLeaflet, makeMap } from '../../test-helpers/engine-stub.mjs'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { MapEngine } from '../../src/engine/MapEngine.js'
import { adoptLeafletHost } from '../../src/host/LeafletHost.js'

after(conGlDeEdicion(() => makeEditGl()))

// Un motor con las dos señales anotadas en orden, con su detail.
const montar = () => {
  const engine = new MapEngine({ host: adoptLeafletHost(makeMap(), { leaflet: makeLeaflet() }) })
  const oidas  = []
  engine.on('drawingstart', detail => oidas.push(['start', detail]))
  engine.on('drawingend', detail => oidas.push(['end', detail]))
  return { engine, oidas, nombres: () => oidas.splice(0).map(([s]) => s) }
}

const editor = (engine, id, mode = 'edit', kind = 'polygon') => engine.addEditableLayer({ id, kind, mode })

test('un editor entra y sale del estado con su modo, y el detail es {}', () => {
  const { engine, oidas, nombres } = montar()
  const geo = editor(engine, 'geo')
  assert.deepEqual(oidas, [], 'en edit no dibuja')

  geo.setMode('draw')
  assert.deepEqual(oidas, [['start', {}]])
  nombres()
  geo.setMode('edit')
  geo.setMode('draw')
  assert.deepEqual(nombres(), ['end', 'start'])
  engine.destroy()
})

test('con dos editores avisan sólo el primero que entra y el último que sale', () => {
  const { engine, nombres } = montar()
  const a = editor(engine, 'a')
  const b = editor(engine, 'b')

  a.setMode('draw')
  b.setMode('draw')
  a.setMode('edit')
  assert.deepEqual(nombres(), ['start'])
  b.setMode('edit')
  assert.deepEqual(nombres(), ['end'])
  engine.destroy()
})

test('freehand cuenta sólo donde traza: en un kind que no crece es inerte, y draw cuenta en todos', () => {
  const { engine, nombres } = montar()
  const caja = editor(engine, 'caja', 'edit', 'rectangle')
  caja.setMode('freehand')
  assert.deepEqual(nombres(), [], 'el rectángulo no traza a mano alzada')
  caja.setMode('draw')
  caja.setMode('edit')
  assert.deepEqual(nombres(), ['start', 'end'], 'pero coloca en draw')

  editor(engine, 'ruta', 'edit', 'polyline').setMode('freehand')
  assert.deepEqual(nombres(), ['start'])
  engine.destroy()
})

test('quitar el último editor que dibuja emite drawingend, y quitar uno que no dibuja no', () => {
  const { engine, nombres } = montar()
  editor(engine, 'quieto')
  editor(engine, 'geo', 'draw')
  nombres()

  engine.removeLayer('quieto')
  assert.deepEqual(nombres(), [])
  engine.removeLayer('geo')
  assert.deepEqual(nombres(), ['end'])
  engine.destroy()
})

test('engine.destroy() no avisa aunque un editor siga dibujando', () => {
  const { engine, nombres } = montar()
  editor(engine, 'geo', 'draw')
  nombres()

  engine.destroy()
  assert.deepEqual(nombres(), [])
})

test('el editor que nace en draw emite drawingstart una vez, con su capa ya registrada', () => {
  const { engine, oidas } = montar()
  const vista = []
  engine.on('drawingstart', () => vista.push(engine.getLayer('geo')?.editor != null))

  editor(engine, 'geo', 'draw')
  assert.deepEqual(vista, [true])
  assert.equal(oidas.length, 1)
  engine.destroy()
})

test('removeLayer emite drawingend con la capa ya quitada: lo que el handler da de alta con el mismo id queda', () => {
  const { engine, nombres } = montar()
  editor(engine, 'geo', 'draw')
  nombres()
  const vista = []
  let nuevo   = null
  engine.on('drawingend', () => {
    vista.push(engine.getLayer('geo'))
    nuevo ??= editor(engine, 'geo', 'draw')
  })

  engine.removeLayer('geo')
  assert.deepEqual(vista, [null])
  assert.deepEqual(nombres(), ['end', 'start'])
  assert.notEqual(engine.getLayer('geo'), null, 'la baja de afuera no pisa el alta del handler')
  assert.equal(nuevo.destroy(), true)
  assert.deepEqual(nombres(), ['end'])
  engine.destroy()
})
