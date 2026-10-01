// Integración del overlay de interacción sobre un MapEngine REAL (glue de addHighlightOverlay):
// monta el canvas en un pane (cabalga el transform del mapa), cablea project/clear/schedule/sizeOf
// desde el motor, reasienta en moveend/zoomend/resize y desconecta en destroy. El comportamiento fino
// del pase (posición, gate O(K), no-crecimiento del atlas) está en test/render/highlight-overlay.test.mjs;
// acá se verifica el CABLEADO.

import '../../test-helpers/engine-stub.mjs'
import { makeMap, makeLeaflet, makeIconSet, decorarElementos } from '../../test-helpers/engine-stub.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MapEngine } from '../../src/engine/MapEngine.js'
import { adoptLeafletHost } from '../../src/host/LeafletHost.js'

const flushRaf = () => new Promise(r => setTimeout(r, 5))
const items = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, lat: i * 0.1, lng: i * 0.2, size: 24 }))
const accessors = { idOf: it => it.id, positionOf: it => ({ lat: it.lat, lng: it.lng }), sizeOf: it => it.size }
const newEngine = (map = makeMap()) =>
  ({ map, engine: new MapEngine({ host: adoptLeafletHost(map, { leaflet: makeLeaflet() }) }) })

test('addHighlightOverlay: cablea el pase separado end-to-end sobre MapEngine', async () => {
  const { engine, map } = newEngine()
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
  map.fire('zoomend')                                   // settle de viewport → reasienta los resaltados
  await flushRaf()
  assert.equal(draws.length, 2, 'reasienta en cambio de viewport')

  ov.destroy()
  draws.length = 0
  map.fire('zoomend'); await flushRaf()
  assert.equal(draws.length, 0, 'destroy desconecta del viewport y de la Source')
  assert.equal(map.getPane('cristae-highlight-hl'), null, 'y suelta su pane')

  engine.destroy()
})

test('addHighlightOverlay: el ViewAnimator lo reproyecta POR FRAME durante el zoom animado', async () => {
  const { engine, map } = newEngine()
  engine.addPointLayer({ id: 'flota', accessors, iconSet: makeIconSet(), data: items })
  await flushRaf()

  const draws = []
  const ov = engine.addHighlightOverlay({ id: 'hl', layerId: 'flota', drawHighlight: (ctx, size, key) => draws.push(key) })
  ov.setHighlighted(new Map([[2, 'follow'], [5, 'select']]))
  await flushRaf()
  draws.length = 0

  // `zoomanim` = un frame de zoom animado (trae la vista DESTINO). El motor interpola (z,c) y reproyecta
  // los resaltados por frame ANTES de zoomend → el retículo sigue a su sprite en vez de teletransportarse.
  map.fire('zoomanim', { zoom: 6, center: { lat: 1, lng: 1 } })
  await flushRaf()
  assert.ok(draws.length >= 2, 'reproyecta los resaltados DURANTE la animación, no sólo al asentar')

  map.fire('zoomend')                                   // corta la interpolación
  ov.destroy()
  engine.destroy()
})

// El último frame de la animación reproyecta a la vista destino, y el realce cae donde la matriz del
// sprite pone su punto: su píxel a ese zoom, menos el del centro, más medio contenedor. La proyección del
// doble es px = coord·100·2^z; el contenedor, 800×600; el destino, zoom 3 con el centro en (1, 1), que
// a ese zoom es el píxel (800, 800).
test('addHighlightOverlay: en el zoom animado, cada realce cae sobre el punto de su sprite', async () => {
  const origenes  = []
  // Sólo el 2D del pase: la superficie de la capa de puntos sigue tomando su WebGL2 del harness.
  const restaurar = decorarElementos((el, tag) => {
    const getContext = el.getContext
    if (tag === 'canvas') el.getContext = kind => (kind !== '2d' ? getContext(kind) : new Proxy({}, {
      get: (_, p) => (p === 'translate' ? (x, y) => origenes.push([x, y]) : () => {}),
      set: () => true,
    }))
    return el
  })
  const { engine, map } = newEngine()
  engine.addPointLayer({ id: 'flota', accessors, iconSet: makeIconSet(), data: items })
  const ov = engine.addHighlightOverlay({ id: 'hl', layerId: 'flota', drawHighlight: () => {} })
  ov.setHighlighted(new Map([[2, 'follow'], [5, 'select']]))
  await flushRaf()

  origenes.length = 0
  map.fire('zoomanim', { zoom: 3, center: { lat: 1, lng: 1 } })
  await new Promise(r => setTimeout(r, 300))           // la animación dura 250 ms
  assert.deepEqual(origenes.slice(-2), [
    [0.2 * 800 - 800 + 400, 0.1 * 800 - 800 + 300],
    [0.8 * 800 - 800 + 400, 0.4 * 800 - 800 + 300],
  ])

  map.fire('zoomend')
  engine.destroy()
  restaurar()
})

// El canvas del pase declara DOS tamaños, y sólo el par correcto lo deja caer sobre su sprite: con la caja
// ausente el canvas mide su BUFFER, así que en pantalla ocupa dpr× el viewport y todo lo dibujado aparece a
// dpr× de su punto —el realce se despega del marcador y arrastra en el zoom—, además de borroso.
test('addHighlightOverlay: el canvas mide el viewport en px CSS y su buffer en px de dispositivo', async () => {
  const previo = globalThis.window.devicePixelRatio
  globalThis.window.devicePixelRatio = 2
  const canvases = []
  const restaurar = decorarElementos((el, tag) => (tag === 'canvas' && canvases.push(el), el))

  const { engine } = newEngine()
  engine.addPointLayer({ id: 'flota', accessors, iconSet: makeIconSet(), data: items })
  await flushRaf()
  engine.addHighlightOverlay({ id: 'hl', layerId: 'flota', drawHighlight: () => {} })

  const canvas = canvases.at(-1)                        // el contenedor del stub mide 800×600
  assert.deepEqual([canvas.width, canvas.height], [1600, 1200], 'buffer en px de dispositivo')
  assert.deepEqual([canvas.style.width, canvas.style.height], ['800px', '600px'], 'caja CSS en px lógicos')

  engine.destroy()
  restaurar()
  globalThis.window.devicePixelRatio = previo
})

test('addHighlightOverlay: rechaza un layerId ausente o que no es de puntos', () => {
  const { engine } = newEngine()
  assert.equal(engine.addHighlightOverlay({ id: 'x', layerId: 'inexistente', drawHighlight: () => {} }), null)
  engine.destroy()
})

test('engine.destroy() dispone los overlays de interacción vivos', async () => {
  const { engine, map } = newEngine()
  engine.addPointLayer({ id: 'flota', accessors, iconSet: makeIconSet(), data: items })
  await flushRaf()
  const draws = []
  engine.addHighlightOverlay({ id: 'hl', layerId: 'flota', drawHighlight: () => draws.push(1) })
  engine.destroy()                                      // no debe throwear ni dejar el overlay suscripto
  map.fire('zoomend'); await flushRaf()
  assert.equal(draws.length, 0, 'tras destroy, el overlay no redibuja')
})
