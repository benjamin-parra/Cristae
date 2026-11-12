// `addHeatLayer({ visible: false })` tiene que cortar el pintado y no sólo ocultar el pane: un calor oculto no acumula
// ni colorea ante un flush de la Source. Se cuentan los `drawArraysInstanced` (un splat por punto) de un contexto
// WebGL espía.
import '../../test-helpers/engine-stub.mjs'
import { conGlDeEdicion, makeEditGl, makeLeaflet, makeMap } from '../../test-helpers/engine-stub.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MapEngine } from '../../src/engine/MapEngine.js'
import { adoptLeafletHost } from '../../src/host/LeafletHost.js'
import { createSource } from '../../src/data/Source.js'

const accessors = { idOf: it => it.id, positionOf: it => ({ lat: it.lat, lng: it.lng }) }
const flush     = () => new Promise(r => setTimeout(r, 5))

// Un contexto que cuenta los splats (`drawArraysInstanced`): lo que el calor sólo emite si pinta. Los contextos de GL
// se estrenan por canvas y todos cuentan sobre el mismo contador.
const conGlEspia = () => {
  const cuenta = { splats: 0 }
  const gl     = new Proxy(makeEditGl(), {
    get: (t, p) => p === 'drawArraysInstanced' ? () => { cuenta.splats++ } : t[p],
  })
  const restaurar = conGlDeEdicion(() => gl)
  return { cuenta, restaurar }
}

test('el alta oculta no pinta ante un flush, y mostrarla pinta', async () => {
  const engine = new MapEngine({ host: adoptLeafletHost(makeMap(), { leaflet: makeLeaflet() }) })
  const espia  = conGlEspia()
  try {
    const handle = engine.addHeatLayer({ id: 'calor', accessors, visible: false })
    espia.cuenta.splats = 0

    handle.set([{ id: 1, lat: 1, lng: 1 }])
    await flush()
    assert.equal(espia.cuenta.splats, 0, 'oculta desde el alta, el flush no pinta')
    assert.equal(engine.getLayer('calor').visible, false)

    handle.setVisible(true)
    assert.equal(espia.cuenta.splats, 1)
  } finally {
    espia.restaurar()
    engine.destroy()
  }
})

test('el alta oculta con una Source ya cargada no pinta al construirse', () => {
  const engine = new MapEngine({ host: adoptLeafletHost(makeMap(), { leaflet: makeLeaflet() }) })
  const espia  = conGlEspia()
  try {
    const source = createSource(accessors)
    source.set([{ id: 1, lat: 1, lng: 1 }])
    engine.addHeatLayer({ id: 'calor', source, visible: false })
    assert.equal(espia.cuenta.splats, 0, 'nace oculta: ni el primer pintado pinta')
  } finally {
    espia.restaurar()
    engine.destroy()
  }
})

test('el alta visible por defecto sí pinta ante un flush', async () => {
  const engine = new MapEngine({ host: adoptLeafletHost(makeMap(), { leaflet: makeLeaflet() }) })
  const espia  = conGlEspia()
  try {
    const handle = engine.addHeatLayer({ id: 'calor', accessors })
    espia.cuenta.splats = 0
    handle.set([{ id: 1, lat: 1, lng: 1 }])
    await flush()
    assert.equal(espia.cuenta.splats, 1)
  } finally {
    espia.restaurar()
    engine.destroy()
  }
})
