// Integración del overlay de interacción sobre un MapEngine REAL (glue de addHighlightOverlay):
// crea el canvas fijo al contenedor, cablea project/clear/schedule/sizeOf desde el motor, reproyecta
// en move/zoom y desconecta en destroy. El comportamiento fino del pase (posición, gate O(K),
// no-crecimiento del atlas) está en test/render/highlight-overlay.test.mjs; acá se verifica el CABLEADO.

import '../../test-helpers/engine-stub.mjs'
import { makeGlify, makeMap, makeLeaflet, makeIconSet } from '../../test-helpers/engine-stub.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MapEngine } from '../../src/engine/MapEngine.js'

const flushRaf = () => new Promise(r => setTimeout(r, 5))
const items = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, lat: i * 0.1, lng: i * 0.2, size: 24 }))
const accessors = { idOf: it => it.id, positionOf: it => ({ lat: it.lat, lng: it.lng }), sizeOf: it => it.size }
const newEngine = () => new MapEngine({ leaflet: makeLeaflet(), glify: makeGlify(), map: makeMap() })

test('addHighlightOverlay: cablea el pase separado end-to-end sobre MapEngine', async () => {
  const engine = newEngine()
  engine.addPointLayer({ id: 'flota', accessors, iconSet: makeIconSet(), data: items })
  await flushRaf()                                      // drena el notify de set()

  const draws = []
  const ov = engine.addHighlightOverlay({ id: 'hl', layerId: 'flota', drawHighlight: (ctx, size, key) => draws.push({ size, key }) })
  assert.ok(ov, 'devuelve handle para un host de puntos válido')

  ov.setHighlighted(new Map([[2, 'follow'], [5, 'select']]))
  await flushRaf()                                      // schedule = requestAnimationFrame
  assert.equal(draws.length, 2, 'un tratamiento por resaltado')
  assert.deepEqual(draws.map(d => d.key).sort(), ['follow', 'select'])
  assert.equal(draws[0].size, 24, 'usa el sizeOf del host')

  draws.length = 0
  engine.getLeafletMap().fire('zoom')                   // move/zoom → reproyecta los resaltados
  await flushRaf()
  assert.equal(draws.length, 2, 'reproyecta en cambio de viewport')

  ov.destroy()
  draws.length = 0
  engine.getLeafletMap().fire('zoom'); await flushRaf()
  assert.equal(draws.length, 0, 'destroy desconecta del viewport y de la Source')

  engine.destroy()
})

test('addHighlightOverlay: rechaza un layerId ausente o que no es de puntos', () => {
  const engine = newEngine()
  assert.equal(engine.addHighlightOverlay({ id: 'x', layerId: 'inexistente', drawHighlight: () => {} }), null)
  engine.destroy()
})

test('engine.destroy() dispone los overlays de interacción vivos', async () => {
  const engine = newEngine()
  engine.addPointLayer({ id: 'flota', accessors, iconSet: makeIconSet(), data: items })
  await flushRaf()
  const draws = []
  engine.addHighlightOverlay({ id: 'hl', layerId: 'flota', drawHighlight: () => draws.push(1) })
  engine.destroy()                                      // no debe throwear ni dejar el overlay suscripto
  engine.getLeafletMap?.().fire?.('zoom'); await flushRaf()
  assert.equal(draws.length, 0, 'tras destroy, el overlay no redibuja')
})
