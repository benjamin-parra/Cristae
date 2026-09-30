// El motor reposiciona sus capas GL con el ciclo de vista del anfitrión. En `move` lo hace sólo si el
// marco del paneo se desplazó —un `move` que no mueve nada no cuesta un redibujo—, y durante un zoom no
// lo hace: lo gobierna el cierre del gesto.
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
