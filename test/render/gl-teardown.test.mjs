// Regresión del leak de contexto WebGL: destroy() de una capa GL debe LIBERAR el contexto
// (glify.remove no lo hace → el techo ~16 contextos se agota acumulativamente al montar/desmontar).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loseGlContext, cancelPendingRedraw } from '../../src/render/gl-teardown.js'

test('loseGlContext libera el contexto vía WEBGL_lose_context.loseContext()', () => {
  let called = 0
  const layer = { gl: { getExtension: (n) => (n === 'WEBGL_lose_context' ? { loseContext: () => { called++ } } : null) } }
  loseGlContext(layer)
  assert.equal(called, 1)
})

test('loseGlContext es no-op sin gl / sin extensión / sin método (nunca rompe)', () => {
  assert.doesNotThrow(() => {
    loseGlContext(null)
    loseGlContext(undefined)
    loseGlContext({})
    loseGlContext({ gl: { getExtension: () => null } })     // extensión no soportada
    loseGlContext({ gl: { getExtension: () => ({}) } })      // extensión sin loseContext
  })
})

/* ── Redibujo agendado que sobrevive al desmontaje ── */
// glify difiere `redraw()` a un requestAnimationFrame y guarda su id en `_frame`, pero su `onRemove`
// NO lo cancela: si la capa se desmonta antes de ese frame, el callback corre con `_map` ya en null
// → "Cannot read properties of null (reading 'getSize')".

test('cancelPendingRedraw cancela el frame agendado por glify y limpia el id', () => {
  const cancelados = []
  const real = globalThis.cancelAnimationFrame
  globalThis.cancelAnimationFrame = id => cancelados.push(id)
  try {
    const capa = { layer: { _frame: 42 } }
    cancelPendingRedraw(capa)
    assert.deepEqual(cancelados, [42], 'cancela el frame en vuelo')
    assert.equal(capa.layer._frame, null, 'y limpia el id (no re-cancela)')
  } finally {
    globalThis.cancelAnimationFrame = real
  }
})

test('cancelPendingRedraw es no-op sin capa / sin overlay / sin frame pendiente', () => {
  const real = globalThis.cancelAnimationFrame
  let llamadas = 0
  globalThis.cancelAnimationFrame = () => { llamadas++ }
  try {
    assert.doesNotThrow(() => {
      cancelPendingRedraw(null)
      cancelPendingRedraw(undefined)
      cancelPendingRedraw({})                        // sin overlay
      cancelPendingRedraw({ layer: {} })             // sin frame
      cancelPendingRedraw({ layer: { _frame: null } })
    })
    assert.equal(llamadas, 0, 'sin frame pendiente no cancela nada')
  } finally {
    globalThis.cancelAnimationFrame = real
  }
})
