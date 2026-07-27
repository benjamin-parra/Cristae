// Pliegue puro del eje focus (lo comparten polygon / circle / line / html).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { focusFactor, focusedStyle } from '../../src/render/focus.js'

const SIN_FOCO = { ids: null, dim: 0.3 }
const CON_FOCO = { ids: new Set(['a']), dim: 0.25 }

test('focusFactor: sin foco todo pleno; con foco, sólo los del set', () => {
  assert.equal(focusFactor(SIN_FOCO, 'a'), 1)
  assert.equal(focusFactor(SIN_FOCO, 'z'), 1)
  assert.equal(focusFactor(CON_FOCO, 'a'), 1, 'enfocado → pleno')
  assert.equal(focusFactor(CON_FOCO, 'z'), 0.25, 'no enfocado → dim')
})

test('focusedStyle: sin foco devuelve el estilo tal cual (misma referencia)', () => {
  const st = { color: '#f00', opacity: 0.8 }
  assert.equal(focusedStyle(st, SIN_FOCO, 'a'), st, 'no aloca ni altera cuando no hay foco')
  assert.deepEqual(focusedStyle(undefined, SIN_FOCO, 'a'), {}, 'sin styleOf devuelve objeto vacío')
})

test('focusedStyle: el no enfocado MODULA su opacidad base, conservando el resto del estilo', () => {
  const st = { color: '#f00', weight: 3, opacity: 0.8, fillOpacity: 0.5 }
  const out = focusedStyle(st, CON_FOCO, 'z')
  assert.equal(out.color, '#f00', 'conserva el estilo no-opacidad')
  assert.equal(out.weight, 3)
  assert.equal(out.opacity, 0.8 * 0.25, 'modula sobre la opacidad declarada, no la pisa')
  assert.equal(out.fillOpacity, 0.5 * 0.25)
  assert.equal(st.opacity, 0.8, 'no muta el estilo de entrada')
})

test('focusedStyle: sin opacidades declaradas usa los defaults de Leaflet (1 y 0.2)', () => {
  const out = focusedStyle({ color: '#00f' }, CON_FOCO, 'z')
  assert.equal(out.opacity, 0.25)
  assert.equal(out.fillOpacity, 0.2 * 0.25)
})
