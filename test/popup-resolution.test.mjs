// M5 — resolución del popup ante el hit de una capa `for` (src/element/popupResolution.js).
// El bug: un `<cristae-popup for="<polígonos>">` no abría NUNCA, en silencio, porque la capa de
// polígonos no expone Source.itemById y el popup cerraba sin decir por qué. Ahora distingue el caso
// 'unresolvable' para avisarlo. Función pura → se testea sin DOM ni Leaflet.
// Corre con: node --test test/popup-resolution.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { resolvePopupHit } from '../src/element/popupResolution.js'

// Vista de capa como la que devuelve MapEngine.getLayer, por kind.
const capaPuntos = (items) => ({
  kind: 'point',
  source: { itemById: (id) => items.find(it => it.id === id) },
})
const capaPoligonos = () => ({ kind: 'polygon', group: {}, render: () => {} })   // sin source

test('M5 — capa de puntos con el id presente → abre con el ítem', () => {
  const r = resolvePopupHit(capaPuntos([{ id: 7, n: 'a' }]), 7)
  assert.deepEqual(r, { action: 'open', item: { id: 7, n: 'a' } })
})

test('M5 — capa de puntos con el id ausente → miss (cierra, sin aviso)', () => {
  assert.deepEqual(resolvePopupHit(capaPuntos([{ id: 7 }]), 99), { action: 'miss' })
})

test('M5 — capa de POLÍGONOS (sin Source) → unresolvable, no un cierre mudo', () => {
  assert.deepEqual(resolvePopupHit(capaPoligonos(), 3), { action: 'unresolvable' })
})

test('M5 — capa cuya Source no expone itemById → unresolvable', () => {
  assert.deepEqual(resolvePopupHit({ kind: 'label', source: {} }, 1), { action: 'unresolvable' })
})

test('M5 — capa inexistente (getLayer devolvió null) → unresolvable', () => {
  assert.deepEqual(resolvePopupHit(null, 1), { action: 'unresolvable' })
  assert.deepEqual(resolvePopupHit(undefined, 1), { action: 'unresolvable' })
})

// El id 0 / '' son ids válidos: 'miss' sólo cuando itemById devuelve null/undefined, no falsy.
test('M5 — un ítem con id 0 se resuelve (no se confunde con ausente)', () => {
  const r = resolvePopupHit(capaPuntos([{ id: 0, n: 'cero' }]), 0)
  assert.deepEqual(r, { action: 'open', item: { id: 0, n: 'cero' } })
})
