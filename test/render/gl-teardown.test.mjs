// Regresión del leak de contexto WebGL: destroy() de una capa GL debe LIBERAR el contexto
// (glify.remove no lo hace → el techo ~16 contextos se agota acumulativamente al montar/desmontar).

import '../../test-helpers/engine-stub.mjs'
import { makeGlify, makeMap, makeIconSet } from '../../test-helpers/engine-stub.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loseGlContext } from '../../src/render/gl-teardown.js'
import { createSource } from '../../src/data/Source.js'
import { PointLayer } from '../../src/render/PointLayer.js'

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

test('PointLayer.destroy() libera el contexto GL (no lo leakea)', () => {
  const glify = makeGlify()
  const source = createSource({ idOf: it => it.id, positionOf: it => ({ lat: it.lat, lng: it.lng }) })
  source.set([{ id: 1, lat: 0, lng: 0 }])
  const layer = new PointLayer({ glify, map: makeMap(), pane: 'p', source, iconSet: makeIconSet() })
  const gl = glify.layers[0]
  assert.equal(gl._lost, false, 'contexto vivo mientras la capa existe')
  layer.destroy()
  assert.equal(gl._lost, true, 'destroy libera el contexto (loseContext)')
})
