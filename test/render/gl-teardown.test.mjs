// Regresión del leak de contexto WebGL: destroy() de una capa GL debe LIBERAR el contexto
// (quitar el canvas no lo hace → el techo ~16 contextos se agota acumulativamente al montar/desmontar).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loseGlContext } from '../../src/render/gl-teardown.js'

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
