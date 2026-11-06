// `addHeatLayer({ visible: false })` tiene que cortar el pintado y no sólo ocultar el pane: el pane oculto
// no frena el colorizado, que en cada flush de la Source lee y escribe el framebuffer entero. Se cuenta
// `getImageData` sobre un contexto 2D espía.
import '../../test-helpers/engine-stub.mjs'
import { makeLeaflet, makeMap } from '../../test-helpers/engine-stub.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MapEngine } from '../../src/engine/MapEngine.js'
import { adoptLeafletHost } from '../../src/host/LeafletHost.js'
import { createSource } from '../../src/data/Source.js'

const accessors = { idOf: it => it.id, positionOf: it => ({ lat: it.lat, lng: it.lng }) }
const flush     = () => new Promise(r => setTimeout(r, 5))

const conLienzoEspia = () => {
  const cuenta = { getImageData: 0 }
  const ctx    = {
    clearRect() {}, fillRect() {}, drawImage() {}, putImageData() {},
    createRadialGradient: () => ({ addColorStop() {} }),
    getImageData: (x, y, w, h) => (cuenta.getImageData++, { data: new Uint8ClampedArray(w * h * 4) }),
  }
  const original = document.createElement
  document.createElement = tag => String(tag).toLowerCase() === 'canvas'
    ? { width: 0, height: 0, style: {}, getContext: () => ctx, remove() {} }
    : original.call(document, tag)
  return { cuenta, restaurar: () => document.createElement = original }
}

test('el alta oculta no colorea ante un flush, y mostrarla colorea', async () => {
  const engine = new MapEngine({ host: adoptLeafletHost(makeMap(), { leaflet: makeLeaflet() }) })
  const espia  = conLienzoEspia()
  try {
    const handle = engine.addHeatLayer({ id: 'calor', accessors, visible: false })
    espia.cuenta.getImageData = 0

    handle.set([{ id: 1, lat: 1, lng: 1 }])
    await flush()
    assert.equal(espia.cuenta.getImageData, 0, 'oculta desde el alta, el flush no pinta')
    assert.equal(engine.getLayer('calor').visible, false)

    handle.setVisible(true)
    assert.equal(espia.cuenta.getImageData, 1)
  } finally {
    espia.restaurar()
    engine.destroy()
  }
})

test('el alta oculta con una Source ya cargada no colorea al construirse', () => {
  const engine = new MapEngine({ host: adoptLeafletHost(makeMap(), { leaflet: makeLeaflet() }) })
  const espia  = conLienzoEspia()
  try {
    const source = createSource(accessors)
    source.set([{ id: 1, lat: 1, lng: 1 }])
    engine.addHeatLayer({ id: 'calor', source, visible: false })
    assert.equal(espia.cuenta.getImageData, 0, 'nace oculta: ni el primer pintado colorea')
  } finally {
    espia.restaurar()
    engine.destroy()
  }
})

test('el alta visible por defecto sí colorea ante un flush', async () => {
  const engine = new MapEngine({ host: adoptLeafletHost(makeMap(), { leaflet: makeLeaflet() }) })
  const espia  = conLienzoEspia()
  try {
    const handle = engine.addHeatLayer({ id: 'calor', accessors })
    espia.cuenta.getImageData = 0
    handle.set([{ id: 1, lat: 1, lng: 1 }])
    await flush()
    assert.equal(espia.cuenta.getImageData, 1)
  } finally {
    espia.restaurar()
    engine.destroy()
  }
})
