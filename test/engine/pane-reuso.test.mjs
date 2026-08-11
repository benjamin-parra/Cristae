// Un pane que se sacó del DOM sigue en el registro `_panes` de Leaflet. Quien desmonta una capa tiene
// que borrar la entrada: si no, el alta siguiente con el mismo id reusa un nodo desconectado y su
// contenido no se ve, sin error y hasta recargar la página.

import '../../test-helpers/engine-stub.mjs'
import { makeGlify, makeMap, makeLeaflet, makeIconSet } from '../../test-helpers/engine-stub.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MapEngine } from '../../src/engine/MapEngine.js'

const PANE      = 'cristae-point-flota'
const items     = [{ id: 1, lat: 0, lng: 0, size: 24 }]
const accessors = { idOf: it => it.id, positionOf: it => ({ lat: it.lat, lng: it.lng }), sizeOf: it => it.size }

const montar = engine => engine.addPointLayer({ id: 'flota', accessors, iconSet: makeIconSet(), data: items })

test('quitar una capa saca su pane del registro, y el alta siguiente estrena uno conectado', () => {
  const map    = makeMap()
  const engine = new MapEngine({ leaflet: makeLeaflet(), glify: makeGlify(), map })

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
  const engine = new MapEngine({ leaflet: makeLeaflet(), glify: makeGlify(), map })
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
