// LineLabelLayer sobre el anfitrión del harness: cuándo pinta y cuándo no. El contexto 2D se espía para
// contar los dibujos (cada uno empieza con `clearRect`) y los glifos (`fillText`/`strokeText`). Dónde cae
// cada glifo lo fija text-path.test.mjs.
import { makeMap } from '../../test-helpers/engine-stub.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { LineLabelLayer } from '../../src/render/LineLabelLayer.js'
import { adoptLeafletHost } from '../../src/host/LeafletHost.js'
import { createSource } from '../../src/data/Source.js'

const frame = () => new Promise(resolve => setTimeout(resolve, 5))

// Un 2D que cuenta. Cada glifo mide 7 px.
const spyCanvas = () => {
  const calls = { draws: 0, fill: [], stroke: [], canvas: null }
  const ctx   = new Proxy({
    measureText : ch => ({ width: 7 * [...ch].length }),
    clearRect   : () => calls.draws++,
    fillText    : ch => calls.fill.push(ch),
    strokeText  : ch => calls.stroke.push(ch),
  }, { get: (t, p) => t[p] ?? (() => {}), set: () => true })
  const original = document.createElement
  document.createElement = tag => {
    const el = original.call(document, tag)
    if (String(tag).toLowerCase() === 'canvas') {
      el.getContext = () => ctx
      calls.canvas  = el
    }
    return el
  }
  return { calls, restore: () => { document.createElement = original } }
}

const accessors = { idOf: r => r.id, pathOf: r => r.path }
// Al zoom 3 del harness, 40° de longitud son unos 228 px: caben los textos de los tests.
const RUTA = { id: 'R1', path: [[0, 0], [0, 40]] }

// Espera el aviso de la Source que deja pendiente el `set` previo al ligado: los conteos arrancan en calma.
const mount = async ({ data = [RUTA], style, visible, textOf } = {}) => {
  const spy    = spyCanvas()
  const map    = makeMap()
  const source = createSource(accessors)
  source.set(data)
  const layer = new LineLabelLayer({ host: adoptLeafletHost(map), pane: 'texto', style, visible })
  layer.bind(source, accessors, textOf)
  await frame()
  const inicial = { draws: spy.calls.draws, fill: [...spy.calls.fill] }
  spy.calls.draws = 0
  spy.calls.fill.length = spy.calls.stroke.length = 0
  return {
    inicial, spy, map, source, layer, done: () => { layer.destroy(); spy.restore() } }
}

test('pinta al ligar y vuelve a pintar tras moveend', async () => {
  const { inicial, spy, map, done } = await mount()
  assert.deepEqual(inicial.fill.slice(0, 2), ['R', '1'])
  map.fire('moveend')
  assert.deepEqual(spy.calls.fill, ['R', '1'])
  done()
})

test('se oculta en zoomstart y reaparece, redibujada, en zoomend', async () => {
  const { spy, map, done } = await mount()
  map.fire('zoomstart')
  assert.equal(spy.calls.canvas.style.visibility, 'hidden')
  const antes = spy.calls.draws
  map.fire('zoomend')
  assert.equal(spy.calls.canvas.style.visibility, '')
  assert.ok(spy.calls.draws > antes, 'zoomend redibuja')
  done()
})

test('setVisible(false) corta el pintado ante los avisos de la Source; al volver pinta lo actual', async () => {
  const { spy, source, layer, map, done } = await mount()
  layer.setVisible(false)
  const antes = spy.calls.draws
  source.set([{ id: 'R2', path: RUTA.path }])
  await frame()
  map.fire('moveend')
  assert.equal(spy.calls.draws, antes, 'oculta no dibuja')
  layer.setVisible(true)
  assert.deepEqual(spy.calls.fill.slice(-2), ['R', '2'])
  done()
})

test('nacer con visible: false no pinta', async () => {
  const { inicial, done } = await mount({ visible: false })
  assert.deepEqual(inicial, { draws: 0, fill: [] })
  done()
})

test('style({ repeat }) redibuja una vez, en el frame siguiente', async () => {
  const { spy, layer, done } = await mount({ textOf: () => 'ab' })
  const antes = spy.calls.draws
  layer.style({ repeat: 40 })
  layer.style({ offset: -6 })
  assert.equal(spy.calls.draws, antes, 'todavía no')
  await frame()
  assert.equal(spy.calls.draws, antes + 1)
  assert.ok(spy.calls.fill.length > 4, `con repeat hay varias colocaciones: ${spy.calls.fill.length / 2}`)
  done()
})

test('destroy con el rAF del estilo en vuelo: lo cancela y no dibuja después', async () => {
  const { spy, layer, done } = await mount()
  const cancel     = globalThis.cancelAnimationFrame
  const cancelados = []
  globalThis.cancelAnimationFrame = id => cancelados.push(id) && cancel(id)
  layer.style({ offset: 4 })
  done()
  globalThis.cancelAnimationFrame = cancel
  await frame()
  assert.equal(cancelados.length, 1)
  assert.equal(spy.calls.draws, 0)
  assert.doesNotThrow(() => layer.destroy())
})

test('un par sustituto es un solo glifo', async () => {
  const { spy, map, done } = await mount({ textOf: () => '😀a' })
  map.fire('moveend')
  assert.deepEqual(spy.calls.fill, ['😀', 'a'])
  done()
})

test('el halo se pinta con strokeText y se apaga con haloWidth 0', async () => {
  const { spy, map, layer, done } = await mount()
  map.fire('moveend')
  assert.deepEqual(spy.calls.stroke, ['R', '1'])
  layer.style({ haloWidth: 0 })
  await frame()
  assert.equal(spy.calls.stroke.length, 2)
  assert.equal(spy.calls.fill.length, 4)
  done()
})

test('ítems sin path, con path de un vértice o con texto vacío no se dibujan', async () => {
  const { spy, map, done } = await mount({
    data   : [{ id: 'A', path: null }, { id: 'B', path: [[0, 0]] }, { id: 'C', path: RUTA.path }, RUTA],
    textOf : r => (r.id === 'C' ? '' : r.id),
  })
  map.fire('moveend')
  assert.deepEqual(spy.calls.fill, ['R', '1'])
  done()
})

test('estilo inválido lanza TypeError, al construir y en style, sin cambiar el vigente', async () => {
  const nace = spyCanvas()
  assert.throws(() => new LineLabelLayer({ host: adoptLeafletHost(makeMap()), pane: 'x', style: { repeat: 0 } }), TypeError)
  assert.equal(nace.calls.canvas, null, 'lanza antes de crear el canvas')
  nace.restore()

  const { spy, map, layer, done } = await mount()
  ;[{ maxAngle: 180 }, { placement: 'end' }, { orientation: 'up' }, { offset: NaN }, { repeat: -5 }]
    .forEach(patch => assert.throws(() => layer.style(patch), TypeError, JSON.stringify(patch)))
  await frame()
  assert.equal(spy.calls.draws, 0, 'un estilo rechazado no agenda dibujo')
  map.fire('moveend')
  assert.deepEqual(spy.calls.fill, ['R', '1'])
  done()
})
