// Prueba pura de la búsqueda binaria de punto de partición (geometry/binary-search.js).
// El foco son los BORDES: qué pasa cuando el valor buscado coincide EXACTO con una clave del array.
// Las dos capas de hit-test comparten el bucle pero difieren en el borde:
//   · polígonos (maxLng, `<=`): borde EXCLUSIVO — una clave igual al valor queda del lado descartado.
//   · líneas    (maxX,   `<`):  borde INCLUSIVO — una clave igual al valor SOBREVIVE (no se descarta).
// Este test congela ambos comportamientos como oráculo de la desfragmentación (Eje 5).
// Corre con: node --test test/geometry/binary-search.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'

import { lowerBoundBy } from '../../src/geometry/binary-search.js'

// Las dos semánticas de borde salen del MISMO lowerBoundBy, sólo cambia el comparador:
//   `<=` (polígonos) → borde EXCLUSIVO; `<` (líneas) → borde INCLUSIVO. Son los predicados verbatim
//   que quedaron en polygon.js (endsWestOfPoint) y polyline.js (endsWestOfBand).
const endsWestExclusive = (entry, value) => entry.bbox.maxLng <= value // reproduce el viejo upperBound
const endsWestInclusive = (entry, value) => entry.bbox.maxX < value    // reproduce el viejo lowerBound

// Adaptadores: reproducen las dos semánticas de borde sobre un array de claves ordenadas ascendente.
//   firstGreater    → índice del primer elemento con clave ESTRICTAMENTE mayor que value (`<=` descarta).
//   firstAtOrAbove  → índice del primer elemento con clave >= value (`<` descarta, INCLUSIVO en el borde).
const firstGreater = (keys, value) =>
  lowerBoundBy(keys.map((maxLng) => ({ bbox: { maxLng } })), value, endsWestExclusive)
const firstAtOrAbove = (keys, value) =>
  lowerBoundBy(keys.map((maxX) => ({ bbox: { maxX } })), value, endsWestInclusive)

// ── firstGreater (borde EXCLUSIVO, `<=`) ──────────────────────────────────────

test('firstGreater: valor entre claves → índice del primer mayor', () => {
  assert.equal(firstGreater([1, 3, 5, 7], 4), 2) // primer maxLng > 4 es 5 (índice 2)
})

test('firstGreater: valor IGUAL a una clave → salta la clave igual (borde exclusivo)', () => {
  assert.equal(firstGreater([1, 3, 5, 7], 5), 3) // 5 <= 5 descarta; primer > 5 es 7 (índice 3)
})

test('firstGreater: valor igual con claves DUPLICADAS salta todas las iguales', () => {
  assert.equal(firstGreater([2, 5, 5, 5, 9], 5), 4) // descarta los tres 5; primer > 5 es 9 (índice 4)
})

test('firstGreater: fuera de rango por debajo → 0; por encima → length', () => {
  assert.equal(firstGreater([1, 3, 5, 7], 0), 0)
  assert.equal(firstGreater([1, 3, 5, 7], 10), 4)
  assert.equal(firstGreater([], 5), 0)
})

// ── firstAtOrAbove (borde INCLUSIVO, `<`) ─────────────────────────────────────

test('firstAtOrAbove: valor entre claves → índice del primer >=', () => {
  assert.equal(firstAtOrAbove([1, 3, 5, 7], 4), 2) // primer maxX >= 4 es 5 (índice 2)
})

test('firstAtOrAbove: valor IGUAL a una clave → INCLUYE la clave igual (borde inclusivo)', () => {
  assert.equal(firstAtOrAbove([1, 3, 5, 7], 5), 2) // 5 no es < 5 → el 5 sobrevive (índice 2)
})

test('firstAtOrAbove: valor igual con claves DUPLICADAS se detiene en la PRIMERA igual', () => {
  assert.equal(firstAtOrAbove([2, 5, 5, 5, 9], 5), 1) // sólo el 2 es < 5; el primer 5 sobrevive (índice 1)
})

test('firstAtOrAbove: fuera de rango por debajo → 0; por encima → length', () => {
  assert.equal(firstAtOrAbove([1, 3, 5, 7], 0), 0)
  assert.equal(firstAtOrAbove([1, 3, 5, 7], 10), 4)
  assert.equal(firstAtOrAbove([], 5), 0)
})

// ── El contraste de borde es EL punto: mismo array, mismo valor, resultado distinto ──

test('en el valor de borde las dos semánticas divergen exactamente en las claves iguales', () => {
  const keys = [2, 5, 5, 5, 9]
  assert.equal(firstAtOrAbove(keys, 5), 1) // inclusivo: primera clave igual
  assert.equal(firstGreater(keys, 5), 4)   // exclusivo: pasada la última clave igual
})
