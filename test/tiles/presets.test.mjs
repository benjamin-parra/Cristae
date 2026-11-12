// tileOf: lo que `tile` admite → el proveedor. Corre con: node --test test/tiles/presets.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { tilePresets, tileOf } from '../../src/tiles/presets.js'

test('tileOf: un nombre da el preset, un objeto pasa tal cual y lo demás da null', () => {
  const objeto = { url: 'https://proveedor.test/{z}/{x}/{y}.png' }
  assert.equal(tileOf('osm'), tilePresets.osm)
  assert.equal(tileOf(objeto), objeto)
  assert.equal(tileOf('nope'), null)
  assert.equal(tileOf('__proto__'), null)
  assert.equal(tileOf('toString'), null)
  assert.equal(tileOf(null), null)
  assert.equal(tileOf(undefined), null)
  assert.equal(tileOf(3), null)
})
