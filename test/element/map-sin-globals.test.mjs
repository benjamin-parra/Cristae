// <cristae-map> no deja nada en el global del consumidor: Leaflet lo trae el anfitrión, y el elemento
// sólo lo adopta. Corre con: node --test test/element/map-sin-globals.test.mjs
import { montarMapa } from '../../test-helpers/element-stub.mjs'   // trae los shims de window/document
import test from 'node:test'
import assert from 'node:assert/strict'

test('montar un <cristae-map> no asigna window.L', async () => {
  delete globalThis.L
  await montarMapa()
  assert.equal(globalThis.L, undefined)
})
