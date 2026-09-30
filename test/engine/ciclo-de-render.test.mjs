// El motor reposiciona sus capas GL con el ciclo de vista del anfitrión. En `move` lo hace sólo si el
// marco del paneo se desplazó —un `move` que no mueve nada no cuesta un redibujo—, y durante un zoom no
// lo hace: lo gobierna el cierre del gesto. Sus señales salen en ese mismo ciclo: `move` en cada paso, y
// una capa que se quita desde ellas ya no se llama en el reparto en curso.
// Corre con: node --test test/engine/ciclo-de-render.test.mjs

import '../../test-helpers/engine-stub.mjs'
import { makeGlify, makeMap, makeLeaflet, makeIconSet } from '../../test-helpers/engine-stub.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MapEngine } from '../../src/engine/MapEngine.js'
import { adoptLeafletHost } from '../../src/host/LeafletHost.js'

const accessors = { idOf: it => it.id, positionOf: it => ({ lat: it.lat, lng: it.lng }) }

test('en move, las capas GL se reposicionan sólo si el marco se desplazó, y no durante un zoom', () => {
  const marco  = { x: 0, y: 0 }
  const map    = Object.assign(makeMap(), {
    containerPointToLayerPoint: ([x, y]) => ({ x: x - marco.x, y: y - marco.y }),
  })
  const glify  = makeGlify()
  const engine = new MapEngine({ host: adoptLeafletHost(map, { leaflet: makeLeaflet() }), glify })
  engine.addPointLayer({ id: 'flota', accessors, iconSet: makeIconSet(), data: [{ id: 1, lat: 0, lng: 0 }] })

  let resets = 0
  glify.layers[0].layer._reset = () => resets++
  const mover = (x, y) => {
    Object.assign(marco, { x, y })
    map.fire('move')
  }

  mover(0, 0)
  mover(0, 0)
  assert.equal(resets, 1, 'el mismo marco no se redibuja dos veces')
  mover(5, 2)
  assert.equal(resets, 2, 'un marco desplazado sí')

  map.fire('zoomstart')
  mover(9, 9)
  assert.equal(resets, 2, 'durante el zoom, move no reposiciona')
  engine.destroy()
})

// Para lo que sigue la vista en continuo —la tarjeta de un popup, el botón de un cluster—: cada paso del
// movimiento, sin esperar a que se asiente.
test('la señal move sale en cada paso del movimiento del anfitrión', () => {
  const map    = makeMap()
  const engine = new MapEngine({ host: adoptLeafletHost(map, { leaflet: makeLeaflet() }), glify: makeGlify() })
  const pasos  = []
  const off    = engine.on('move', detail => pasos.push(detail))

  map.fire('move')
  map.fire('move')
  assert.deepEqual(pasos, [{}, {}])
  off()
  map.fire('move')
  assert.equal(pasos.length, 2, 'hasta la baja')
  engine.destroy()
})

// El LOD habitual: capas que se quitan según la vista, desde las señales del motor. Salen en el mismo
// reparto del anfitrión que oyen las capas, antes que ellas.
test('quitar capas desde las señales de la vista no rompe el reparto', () => {
  const map    = makeMap()
  const engine = new MapEngine({ host: adoptLeafletHost(map, { leaflet: makeLeaflet() }), glify: makeGlify() })
  engine.addLabelLayer({ id: 'rotulos' })
  engine.addHeatLayer({ id: 'calor', accessors, data: [{ id: 1, lat: 0, lng: 0 }] })
  engine.on('interactionstart', () => engine.removeLayer('calor'))
  engine.on('viewportchange', () => engine.removeLayer('rotulos'))

  assert.doesNotThrow(() => map.fire('zoomstart'), 'el calor se ocultaba en zoomstart')
  assert.doesNotThrow(() => map.fire('zoomend'), 'y las etiquetas se mostraban en zoomend')
  assert.deepEqual([engine.getLayer('calor'), engine.getLayer('rotulos')], [null, null])
  engine.destroy()
})
