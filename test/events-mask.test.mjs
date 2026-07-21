// Contrato de los bits de canal (src/events/events.js). Son los mismos números que cruzan
// Interaction y LayerRegistry: un typo acá no rompe nada visible, apaga el picking en silencio.
// Corre con: node --test test/events-mask.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { EVENT_CLICK, EVENT_HOVER, EVENT_SECONDARY, PICK_CHANNELS, maskOfEventType } from '../src/events/events.js'

test('los bits de canal son potencias de dos fijas y PICK_CHANNELS es click|hover, sin secondary', () => {
  assert.deepEqual([EVENT_CLICK, EVENT_HOVER, EVENT_SECONDARY], [1, 2, 4])
  assert.equal(PICK_CHANNELS, 3)
  assert.equal(PICK_CHANNELS, EVENT_CLICK | EVENT_HOVER)
  assert.equal(PICK_CHANNELS & EVENT_SECONDARY, 0, 'el click contextual no abre sesión de hover')
})

test('maskOfEventType: tabla completa de tipos conocidos, y 0 para cualquier otro valor', () => {
  const tabla = { 'click': 1, 'secondary-click': 4, 'hover': 2, 'hover:start': 2, 'hover:end': 2 }
  Object.entries(tabla).forEach(([tipo, bit]) => assert.equal(maskOfEventType(tipo), bit, tipo))
  // Sin canal: los que existen pero no generan demanda, y la basura (ojo con el case-sensitive).
  const sinCanal = ['pointer:move', 'hover:out', 'Click', 'CLICK', 'hoverstart', 'secondary', '', undefined, null, 0, 1, {}]
  sinCanal.forEach((tipo) => assert.equal(maskOfEventType(tipo), 0, String(tipo)))
})
