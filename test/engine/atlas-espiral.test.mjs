// Un pliegue de cluster no paga atlas por lo que no usa (etapa 4, D2, T4.2): sus dos IconSets de cluster —las
// burbujas y los sub-clusters de la espiral— declaran 199 buckets cada uno, y antes de D2 los dos rasterizaban
// los 199 al nacer (≥ 19 MiB de atlas) aunque la espiral nunca se abriera. Ahora cada uno dibuja sólo lo que
// su capa usa, y un IconSet que no se usó no crea ni su canvas de trabajo. Los IconSets son los REALES; lo
// único falso es el canvas 2D, que cuenta cuántos tiles se leyeron y cuántos IconSets lo estrenaron (cada
// IconSet tiene el suyo).
import '../../test-helpers/engine-stub.mjs'
import { NOOP_CTX, conGlDeEdicion, decorarElementos, makeEditGl, makeIconSet, makeMap, makeLeaflet, installCanvasStub } from '../../test-helpers/engine-stub.mjs'
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { MapEngine } from '../../src/engine/MapEngine.js'
import { adoptLeafletHost } from '../../src/host/LeafletHost.js'

installCanvasStub()
after(conGlDeEdicion(() => makeEditGl()))                 // las patas de la espiral toman su contexto WebGL2

const tiles = { lecturas: 0, contextos: 0 }                // tiles leídos y canvases de trabajo creados
after(decorarElementos((el, tag) => {
  if (tag !== 'canvas') return el
  const base = el.getContext
  el.getContext = (kind, ...resto) => {
    if (kind !== '2d') return base(kind, ...resto)
    tiles.contextos++
    return new Proxy({ getImageData: (_x, _y, w, h) => (tiles.lecturas++, { data: new Uint8ClampedArray(w * h * 4) }) }, { get: (t, p) => t[p] ?? NOOP_CTX[p], set: () => true })
  }
  return el
}))

const FLOTA = [
  { id: 1, lat: 0,      lng: 0 },
  { id: 2, lat: 0,      lng: 0.0001 },
  { id: 3, lat: 0.0001, lng: 0 },
  { id: 4, lat: 0.0001, lng: 0.0001 },
  { id: 5, lat: 0,      lng: 0.0002 },
]
const accessors = { idOf: v => v.id, positionOf: v => ({ lat: v.lat, lng: v.lng }) }

const montar = () => {
  const engine = new MapEngine({ host: adoptLeafletHost(makeMap({ zoom: 3 }), { leaflet: makeLeaflet() }) })
  engine.addPointLayer({ id: 'flota', data: FLOTA, accessors, iconSet: makeIconSet(), interactive: false })
  const fold = engine.addClusterFold([{ id: 'flota' }], { radius: 80, maxZoom: 18, minPoints: 2 })
  return { engine, control: fold.handle.control, burbujas: () => engine.getLayer(fold.handle.control.bubbleLayerId).source.getSnapshot() }
}

test('T4.2 montar el pliegue rasteriza la burbuja que se ve: un tile, no los 199 buckets de cada set', () => {
  const antes = { ...tiles }
  const { burbujas } = montar()
  assert.equal(burbujas().length, 1, 'una burbuja')
  assert.equal(tiles.lecturas - antes.lecturas, 1, 'un solo tile leído')
  assert.equal(tiles.contextos - antes.contextos, 1, 'y un solo IconSet lo estrenó: el de los sub-clusters de la espiral ni creó su canvas')
})

test('T4.2 una espiral que nunca se abre no rasteriza un solo tile de sub-clusters, aunque se la monte y se la deje', () => {
  const { burbujas } = montar()
  const antes = { ...tiles }
  assert.equal(burbujas().length, 1)
  assert.deepEqual({ ...tiles }, antes, 'el reposo no lee tiles ni crea canvases')
})

test('T4.2 abrir una espiral de hojas directas dibuja la burbuja atenuada, y el set de sub-clusters sigue sin usarse', () => {
  const { control, burbujas } = montar()
  const antes = { ...tiles }
  control.expand(burbujas()[0].id)
  assert.equal(tiles.lecturas - antes.lecturas, 1, 'un tile más: la variante atenuada de la burbuja')
  assert.equal(tiles.contextos - antes.contextos, 0, 'ningún IconSet nuevo: los sub-clusters sólo existen si la espiral los tiene')
  control.collapseAll()
})
