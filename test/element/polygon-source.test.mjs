// Dos entradas de dato en <cristae-polygon-layer>, simétricas con la capa de puntos: `data` (el
// elemento posee la Source interna) y `source` (la posee el consumidor y la comparte entre vistas —
// la misma que alimenta una tabla o un segundo mapa). Sin una de las dos, el montaje se difiere.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CristaePolygonLayer } from '../../src/element/CristaePolygonLayer.js'

// Sin DOM: `mountLayer` sólo lee `this.*` y llama al alta, así que alcanza un objeto con el prototipo
// de la clase (de ahí sale el getter `_placement` de la base). El motor eco devuelve la config recibida.
const capa = props => Object.assign(Object.create(CristaePolygonLayer.prototype), { visible: true, ...props })
const eco = { addPolygonLayer: cfg => cfg }

const accessors = { idOf: g => g.id, ringsOf: () => [[[0, 0], [0, 1], [1, 1]]] }

test('`source` sola alcanza para montar: la Source ya trae sus accessors', () => {
  assert.equal(capa({ source: {} }).mountReady(), true, 'ruta source')
  assert.equal(capa({ accessors }).mountReady(), true, 'ruta data: los accessors se asignan aparte')
  assert.equal(capa({}).mountReady(), false, 'sin ninguna de las dos, difiere')
})

test('`source` y `backend` llegan al alta del motor', () => {
  const source = {}
  const cfg = capa({ id: 'zonas', source, backend: 'gpu' }).mountLayer(eco)
  assert.equal(cfg.source, source, 'la MISMA Source, no una copia')
  assert.equal(cfg.backend, 'gpu', 'el sustrato declarado llega al alta')
})

test('sin declararlos, el alta los recibe ausentes y el motor aplica sus defaults', () => {
  const cfg = capa({ id: 'zonas', accessors, data: [{ id: 'z1' }] }).mountLayer(eco)
  assert.equal(cfg.source, undefined, 'sin source → el motor crea la suya con los accessors')
  assert.equal(cfg.backend, undefined, "backend ausente → el motor hace backend = 'leaflet'")
})
