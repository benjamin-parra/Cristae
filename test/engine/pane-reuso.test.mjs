// Un pane que se sacó del DOM sigue en el registro `_panes` de Leaflet. Quien desmonta una capa tiene
// que borrar la entrada: si no, el alta siguiente con el mismo id reusa un nodo desconectado y su
// contenido no se ve, sin error y hasta recargar la página. Lo hace la superficie del anfitrión, que
// cuenta quién sostiene cada pane: el motor por cada capa, y además la capa que cuelga su propio nodo.

import '../../test-helpers/engine-stub.mjs'
import { conGlDeEdicion, makeMap, makeLeaflet, makeIconSet, oyentesDeVista } from '../../test-helpers/engine-stub.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MapEngine } from '../../src/engine/MapEngine.js'
import { adoptLeafletHost } from '../../src/host/LeafletHost.js'

const PANE      = 'cristae-point-flota'
const items     = [{ id: 1, lat: 0, lng: 0, size: 24 }]
const accessors = { idOf: it => it.id, positionOf: it => ({ lat: it.lat, lng: it.lng }), sizeOf: it => it.size }

const montar = engine => engine.addPointLayer({ id: 'flota', accessors, iconSet: makeIconSet(), data: items })

test('quitar una capa saca su pane del registro, y el alta siguiente estrena uno conectado', () => {
  const map    = makeMap()
  const engine = new MapEngine({ host: adoptLeafletHost(map, { leaflet: makeLeaflet() }) })

  montar(engine)
  const primero = map.getPane(PANE)
  assert.equal(primero.connected, true)

  engine.removeLayer('flota')
  assert.equal(map.getPane(PANE), null, 'el registro no puede seguir devolviendo el pane desmontado')

  montar(engine)
  const segundo = map.getPane(PANE)
  assert.notEqual(segundo, primero, 'el alta estrena pane en vez de reusar el viejo')
  assert.equal(segundo.connected, true, 'y el nuevo está en el documento')
})

test('un pane COMPARTIDO sobrevive mientras le quede una capa', () => {
  const map    = makeMap()
  const engine = new MapEngine({ host: adoptLeafletHost(map, { leaflet: makeLeaflet() }) })
  const comun  = 'compartido'

  engine.addPointLayer({ id: 'a', accessors, iconSet: makeIconSet(), data: items, pane: comun })
  engine.addPointLayer({ id: 'b', accessors, iconSet: makeIconSet(), data: items, pane: comun })
  const pane = map.getPane(comun)

  engine.removeLayer('a')
  assert.equal(map.getPane(comun), pane, 'todavía lo usa la otra capa')
  assert.equal(pane.connected, true)

  engine.removeLayer('b')
  assert.equal(map.getPane(comun), null, 'sin capas, el pane se va del registro')
})

test('un pane que el mapa ya tenía no se va con la capa', () => {
  const map    = makeMap()
  const propio = map.createPane('delDueño')
  const engine = new MapEngine({ host: adoptLeafletHost(map, { leaflet: makeLeaflet() }) })

  engine.addPointLayer({ id: 'flota', accessors, iconSet: makeIconSet(), data: items, pane: 'delDueño' })
  engine.removeLayer('flota')
  assert.equal(map.getPane('delDueño'), propio, 'es del dueño del mapa: el motor lo usó prestado')
  assert.equal(propio.connected, true)
})

test('las capas que cuelgan su propio nodo también sueltan su pane al quitarse', () => {
  const map    = makeMap()
  const engine = new MapEngine({ host: adoptLeafletHost(map, { leaflet: makeLeaflet() }) })
  engine.addLabelLayer({ id: 'rotulos' })
  engine.addHeatLayer({ id: 'calor', accessors, data: items })
  const panes = ['cristae-label-rotulos', 'cristae-heat-calor']
  panes.forEach(pane => assert.ok(map.getPane(pane), `${pane} montado`))

  engine.removeLayer('rotulos')
  engine.removeLayer('calor')
  panes.forEach(pane => assert.equal(map.getPane(pane), null, `${pane} fuera del registro`))
})

// Sin WebGL2 un sustrato GPU lanza al construirse, y el consumidor puede degradar a otro. Una capa que no
// llegó a nacer no tiene registro ni `removeLayer`: no deja su pane sostenido ni a nadie oyendo la vista.
// Lo mismo una capa de líneas que se pide mal.
test('una capa que lanza al darse de alta no deja su pane ni oyentes', t => {
  t.after(conGlDeEdicion(() => null))
  const map     = makeMap()
  const host    = adoptLeafletHost(map, { leaflet: makeLeaflet() })
  const oyentes = oyentesDeVista(host)
  const engine  = new MapEngine({ host })
  const vista   = () => oyentes('zoomanim', 'zoomend', 'moveend', 'resize')
  const antes   = vista()
  const lineas  = { idOf: it => it.id, pathOf: it => it.path }

  assert.throws(() => engine.addEditableLayer({ id: 'editor' }), /WebGL2/)
  assert.throws(() => engine.addPolygonLayer({ id: 'zonas', accessors: { idOf: it => it.id, ringsOf: it => it.rings } }), /WebGL2/)
  assert.throws(() => engine.addLineLayer({ id: 'rutas', accessors: lineas }), /WebGL2/)
  assert.throws(() => engine.addLineLayer({ id: 'picadas', interactive: true, accessors: lineas }), /WebGL2/)
  assert.throws(() => engine.addLineLayer({ id: 'otras', backend: 'gpu', accessors: lineas }), /backend/)

  const panes = ['cristae-edit-editor', 'cristae-polygon-zonas', 'cristae-line-rutas', 'cristae-line-picadas', 'cristae-line-otras']
  panes.forEach(pane => assert.equal(map.getPane(pane), null, `${pane} fuera del registro`))
  assert.equal(vista(), antes, 'y nadie quedó oyendo la vista')
  engine.destroy()
})

// Lo que valida la configuración —la Source, el iconSet— lanza antes de montar, y lo que lanza al
// construir la capa —código del consumidor, como la rampa del calor— suelta el pane. Un alta que no nació
// no deja nada sostenido: el reintento con el mismo id se va entero al quitarse.
test('un alta mal configurada no deja su pane sostenido', () => {
  const map    = makeMap()
  const engine = new MapEngine({ host: adoptLeafletHost(map, { leaflet: makeLeaflet() }) })
  const rampa  = () => { throw new Error('rampa') }
  engine.addPointLayer({ id: 'base', accessors, iconSet: makeIconSet(), data: items })
  const antes = Object.keys(map._panes)

  assert.throws(() => engine.addPointLayer({ id: 'flota', accessors, iconSet: 'sinRegistrar' }), /no registrado/)
  assert.throws(() => engine.addPointLayer({ id: 'puntos', accessors: {}, iconSet: makeIconSet() }), /idOf/)
  assert.throws(() => engine.addPolygonLayer({ id: 'zonas', accessors: {} }), /idOf/)
  assert.throws(() => engine.addHtmlLayer({ id: 'badges', accessors: {} }), /idOf/)
  assert.throws(() => engine.addCircleLayer({ id: 'radios', accessors: {} }), /idOf/)
  assert.throws(() => engine.addShapeLayer({ id: 'zonas-de-alcance', accessors: {} }), /idOf/)
  assert.throws(() => engine.addHeatLayer({ id: 'densidad', accessors: {} }), /idOf/)
  assert.throws(() => engine.addHeatLayer({ id: 'calor', accessors, colorRamp: rampa }), /rampa/)
  assert.throws(() => engine.addOverlay({ id: 'insignia', hostId: 'base', iconSet: 'sinRegistrar' }), /no registrado/)
  assert.throws(() => engine.addCluster({ hostId: 'base', bubble: { iconSet: 'sinRegistrar' } }), /no registrado/)
  assert.deepEqual(Object.keys(map._panes), antes, 'ningún pane quedó en el registro')

  engine.registerIconSet('sinRegistrar', makeIconSet())
  engine.addPointLayer({ id: 'flota', accessors, iconSet: 'sinRegistrar', data: items })
  engine.removeLayer('flota')
  assert.equal(map.getPane('cristae-point-flota'), null, 'el reintento se va entero')
  engine.destroy()
})
