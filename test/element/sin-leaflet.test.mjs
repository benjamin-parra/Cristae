// Los elementos siguen la vista por el motor, no por el mapa de Leaflet: `getLeafletMap()` es una
// escotilla para el consumidor, no un canal de Cristae. Se lee el fuente porque un elemento que la use
// sigue andando, y sólo acá se nota.
// Corre con: node --test test/element/sin-leaflet.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'

const ELEMENTOS = new URL('../../src/element/', import.meta.url)

test('ningún elemento llama a getLeafletMap', () => {
  const codigo = archivo => readFileSync(new URL(archivo, ELEMENTOS), 'utf8').replace(/\/\/.*$/gm, '')
  assert.deepEqual(readdirSync(ELEMENTOS).filter(archivo => codigo(archivo).includes('getLeafletMap')), [])
})
