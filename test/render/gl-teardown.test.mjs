// Regresión del leak de contexto WebGL: destroy() de una capa GL debe LIBERAR el contexto
// (glify.remove no lo hace → el techo ~16 contextos se agota acumulativamente al montar/desmontar).

import '../../test-helpers/engine-stub.mjs'
import { makeGlify, makeMap, makeIconSet } from '../../test-helpers/engine-stub.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loseGlContext, cancelPendingRedraw } from '../../src/render/gl-teardown.js'
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

test('PointLayer.destroy() no deja un redraw en vuelo (regresión del crash de _redraw)', () => {
  const glify = makeGlify()
  const source = createSource({ idOf: it => it.id, positionOf: it => ({ lat: it.lat, lng: it.lng }) })
  source.set([{ id: 1, lat: 0, lng: 0 }])
  const layer = new PointLayer({ glify, map: makeMap(), pane: 'p', source, iconSet: makeIconSet() })

  glify.layers[0].layer._frame = 7                   // un redraw quedó agendado (glify no lo cancela solo)
  const cancelados = []
  const real = globalThis.cancelAnimationFrame
  globalThis.cancelAnimationFrame = id => cancelados.push(id)
  try {
    layer.destroy()
    assert.deepEqual(cancelados, [7], 'el destroy cancela el frame antes de soltar el mapa')
  } finally {
    globalThis.cancelAnimationFrame = real
  }
})
