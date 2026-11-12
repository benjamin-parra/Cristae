// `move(id, lat, lng, heading?)` de createSource: el override por id lleva posición y rumbo, y toda Source
// con `positionOf` expone un `headingOf` efectivo (el override, si no el del consumidor, si no 0).
// Corre con: node --test test/source-move-rumbo.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { createSource } from '../src/data/index.js'
import { bytesPorLlamada } from '../test-helpers/asignaciones.mjs'

const idOf       = it => it.id
const positionOf = it => ({ lat: it.lat, lng: it.lng })
const rumboDe    = (src, id) => src.accessors.headingOf(src.itemById(id))

test('toda Source con posición expone headingOf, 0 sin base', () => {
  const src = createSource({ idOf, positionOf })
  src.set([{ id: 1, lat: 0, lng: 0 }])
  assert.equal(typeof src.accessors.headingOf, 'function')
  assert.equal(rumboDe(src, 1), 0)
})

test('una Source de líneas no expone headingOf', () => {
  const src = createSource({ idOf, pathOf: it => it.path })
  assert.equal(src.accessors.headingOf, undefined)
})

test('move con rumbo lo pone en el headingOf efectivo, también sin base', () => {
  const src = createSource({ idOf, positionOf })
  src.set([{ id: 1, lat: 0, lng: 0 }])
  src.move(1, 5, 6, 90)
  assert.equal(rumboDe(src, 1), 90)
  assert.equal(src.accessors.positionOf(src.itemById(1)).lat, 5)
})

test('move sin rumbo, o con uno no finito, conserva el anterior', () => {
  const src = createSource({ idOf, positionOf })
  src.set([{ id: 1, lat: 0, lng: 0 }])
  src.move(1, 1, 1, 45)
  src.move(1, 2, 2)
  assert.equal(rumboDe(src, 1), 45)
  src.move(1, 3, 3, NaN)
  src.move(1, 4, 4, undefined)
  assert.equal(rumboDe(src, 1), 45)
  src.move(1, 5, 5, 0)
  assert.equal(rumboDe(src, 1), 0, 'un 0 es un rumbo')
})

test('un move sin rumbo sobre un id sin override cae al headingOf del consumidor', () => {
  const src = createSource({ idOf, positionOf, headingOf: it => it.h })
  src.set([{ id: 1, lat: 0, lng: 0, h: 33 }])
  assert.equal(rumboDe(src, 1), 33)
  src.move(1, 1, 1)
  assert.equal(rumboDe(src, 1), 33)
  src.move(1, 1, 1, 77)
  assert.equal(rumboDe(src, 1), 77)
})

test('set, patch y remove del id descartan el rumbo igual que la posición', () => {
  const base = { id: 1, lat: 0, lng: 0, h: 10 }
  const src  = createSource({ idOf, positionOf, headingOf: it => it.h })
  src.set([base])
  src.move(1, 9, 9, 200)
  src.set([base])
  assert.equal(rumboDe(src, 1), 10)
  src.move(1, 9, 9, 200)
  src.patch([base], new Set([1]))
  assert.equal(rumboDe(src, 1), 10)
  src.move(1, 9, 9, 200)
  src.remove(1)
  src.set([base])
  assert.equal(rumboDe(src, 1), 10)
})

// El aviso de la ventana (Emitter) ya asigna por su cuenta con o sin rumbo; lo que el rumbo no puede sumar es
// una asignación propia: el objeto del override se reusa.
test('move marca el id, y el rumbo no suma asignaciones al move', () => {
  const src = createSource({ idOf, positionOf })
  src.set([{ id: 1, lat: 0, lng: 0 }])
  src.move(1, 0, 0, 0)
  assert.ok(src.moveDirtyIds().has(1))
  const medir = fn => bytesPorLlamada(fn, 2_000, { calentar: 20_000 })
  const sin = medir(i => src.move(1, i, i))
  const con = medir(i => src.move(1, i, i, i & 255))
  assert.ok(con - sin < 1, `sin rumbo ${sin} bytes por llamada, con rumbo ${con}`)
})
