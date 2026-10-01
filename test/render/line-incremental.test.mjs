// Lo que la capa de líneas hace SIN rehacer el store: un patch reescribe sólo sus slots, un append sube
// sólo lo agregado, y foco, gradiente y picking siguen en pie después de ambos. Se mide por lo que ve la
// GPU (`texImages` = textura entera, `texSubImages` = filas) y por lo que el trazo recibe (rango y alfa).
//
// El Source es el real: reparte en el turno siguiente, de ahí `tick`.
import '../../test-helpers/engine-stub.mjs'
import { decorarElementos, makeGl, makeMap as makeMapStub, makePickSpy, makeSurface } from '../../test-helpers/engine-stub.mjs'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { LineGpuLayer } from '../../src/render/LineGpuLayer.js'
import { adoptLeafletHost } from '../../src/host/LeafletHost.js'
import { createSource } from '../../src/data/Source.js'

let currentGl = null

after(decorarElementos((el, tag) => {
  if (tag === 'canvas') el.getContext = kind => (kind === 'webgl2' ? currentGl : null)
  return el
}))

const tick = () => new Promise(resolve => setTimeout(resolve, 5))

const recorrido = (n, lat = 0, lng = 0) => Array.from({ length: n }, (_, i) => [lat + i * 0.001, lng + i * 0.001])

// El trazo lee `first`/`count` y el alfa del color en cada draw: se capturan en el instante.
// Asienta la ventana del `set` inicial: lo que cada test haga después es el cambio que mide.
const mount = async ({ items, accessors = {}, source: propia, ...opts } = {}) => {
  const spy  = makePickSpy()
  const vivo = {}
  const trazos = []
  const propio = {
    getUniformLocation : (_programa, nombre) => ({ nombre }),
    uniform1i          : (loc, v) => (vivo[loc.nombre] = v),
    uniform4fv         : (loc, v) => (vivo[loc.nombre] = [...v]),
    drawArrays         : () => trazos.push({ first: vivo.first, count: vivo.count, alpha: vivo.color[3], gradient: vivo.gradient }),
  }
  const gl = makeGl(null, spy, makeSurface())
  currentGl = new Proxy(gl, { get: (t, p) => (p === 'getContextAttributes' ? () => ({ stencil: true }) : propio[p] ?? t[p]) })
  const source = propia ?? createSource({ idOf: r => r.id, pathOf: r => r.path, ...accessors })
  propia || source.set(items ?? [{ id: 1, path: recorrido(50) }])
  const layer = new LineGpuLayer({ host: adoptLeafletHost(makeMapStub()), pane: 'p', source, ...opts })
  const redraw = () => { trazos.length = 0; layer.redraw(); return trazos.map(t => ({ ...t })) }
  await tick()
  return { layer, source, spy, trazos, redraw }
}

test('un patch reescribe sus slots: sube filas, no rehace la textura', async () => {
  const { source, spy, redraw } = await mount({ items: [{ id: 1, path: recorrido(20) }, { id: 2, path: recorrido(20, 1) }] })
  const imagenes = spy.texImages.length
  const subidas  = spy.texSubImages.length
  source.patch([{ id: 1, path: recorrido(10, 5) }, { id: 2, path: recorrido(20, 1) }], new Set([1]))
  await tick()
  assert.equal(spy.texImages.length, imagenes)
  assert.ok(spy.texSubImages.length > subidas)
  assert.deepEqual(redraw().map(t => t.count), [10, 20], 'el tramo del id 1 se acortó')
})

test('un cambio de membresía rehace el store', async () => {
  const { source, spy } = await mount()
  const imagenes = spy.texImages.length
  source.set([{ id: 1, path: recorrido(50) }, { id: 2, path: recorrido(5) }])
  await tick()
  assert.ok(spy.texImages.length > imagenes)
})

// Un set con los mismos ids sólo marca sucio el ítem cuyo hashOf cambió (SourceAccessors): sin hashOf
// el hash es el id, y la línea que cambió de recorrido se queda como estaba. `styleOf` dice qué recs
// se reescribieron: la capa lo llama una vez por rec que toca.
test('un set con los mismos ids reescribe sólo la línea cuyo hashOf cambió; sin hashOf, ninguna', async () => {
  const items  = [{ id: 1, path: recorrido(20) }, { id: 2, path: recorrido(20, 1) }]
  const cambio = [items[0], { id: 2, path: recorrido(10, 5), v: 1 }]
  const vistos = []
  const styleOf = it => (vistos.push(it.id), {})

  const conHash = await mount({ items, accessors: { styleOf, hashOf: it => it.v ?? 0 } })
  let imagenes = conHash.spy.texImages.length
  let subidas  = conHash.spy.texSubImages.length
  vistos.length = 0
  conHash.source.set(cambio)
  await tick()
  assert.deepEqual(vistos, [2], 'sólo la línea 2 se reescribió')
  assert.equal(conHash.spy.texImages.length, imagenes, 'mismos ids: sin rebuild')
  assert.ok(conHash.spy.texSubImages.length > subidas)
  assert.deepEqual(conHash.redraw().map(t => t.count), [20, 10])

  const sinHash = await mount({ items, accessors: { styleOf } })
  imagenes = sinHash.spy.texImages.length
  subidas  = sinHash.spy.texSubImages.length
  vistos.length = 0
  sinHash.source.set(cambio)
  await tick()
  assert.deepEqual(vistos, [], 'con hashOf = idOf los mismos ids no cuentan como cambio')
  assert.equal(sinHash.spy.texImages.length + sinHash.spy.texSubImages.length, imagenes + subidas)
  assert.deepEqual(sinHash.redraw().map(t => t.count), [20, 20])
})

test('append suma al tramo abierto: misma textura, una subida de filas, rango más largo', async () => {
  const { source, spy, redraw } = await mount()
  const imagenes = spy.texImages.length
  const subidas  = spy.texSubImages.length
  source.append(1, [1, 1], [1.1, 1.1], [1.2, 1.2])
  await tick()
  assert.equal(spy.texImages.length, imagenes, 'el hueco admite lo agregado')
  assert.ok(spy.texSubImages.length - subidas <= 2, 'una subida por textura, no por punto')
  assert.deepEqual(redraw().map(t => t.count), [53])
})

test('un tramo cortado por un vértice inválido: lo agregado abre un tramo nuevo', async () => {
  const { source, redraw } = await mount()
  source.append(1, [NaN, NaN], [3, 3], [3.1, 3.1])
  await tick()
  assert.deepEqual(redraw().map(t => t.count), [50, 2])
})

test('un punto suelto espera al siguiente para dibujar', async () => {
  const { source, redraw } = await mount({ items: [{ id: 1, path: [[0, 0]] }] })
  assert.deepEqual(redraw(), [], 'un vértice no es un tramo')
  source.append(1, [0.001, 0.001])
  await tick()
  assert.deepEqual(redraw().map(t => t.count), [2])
})

test('lo incremental dibuja lo mismo que reconstruir', async () => {
  const { source, layer, redraw } = await mount({ items: [{ id: 1, path: recorrido(20) }, { id: 2, path: [[4, 4]] }] })
  source.append(1, [2, 2], [NaN, NaN], [3, 3], [3.1, 3.1])
  source.append(2, [4.1, 4.1])
  await tick()
  const rangos = () => redraw().map(t => t.count)
  const incremental = rangos()
  layer.refresh()
  assert.deepEqual(rangos(), incremental)
  assert.deepEqual(incremental, [21, 2, 2])
})

// Una parte vacía al final no abre tramo: lo sumado sigue al de antes, igual que al reconstruir.
test('con una parte vacía al final, lo incremental dibuja lo mismo que reconstruir', async () => {
  const { source, layer, redraw } = await mount({ items: [{ id: 1, path: [recorrido(5), []] }] })
  source.append(1, [1, 1])
  await tick()
  const incremental = redraw().map(t => t.count)
  layer.refresh()
  assert.deepEqual(redraw().map(t => t.count), incremental)
  assert.deepEqual(incremental, [6])
})

// SPECS §15.2: con un id repetido en el snapshot gana el primero, y la membresía se mide contra el
// snapshot, no contra los ids: un append sigue siendo incremental. La Source de la casa no repite ids,
// así que el snapshot lo arma el test.
test('un id duplicado: gana el primero y el append no rehace el store', async () => {
  const snapshot = [{ id: 1, path: recorrido(20) }, { id: 1, path: recorrido(10) }, { id: 2, path: recorrido(5, 1) }]
  const sumados  = new Map()
  const avisos   = new Set()
  const source   = {
    accessors      : { idOf: r => r.id, pathOf: r => r.path },
    getSnapshot    : () => snapshot,
    subscribe      : cb => (avisos.add(cb), () => avisos.delete(cb)),
    itemById       : id => snapshot.find(r => r.id === id),
    dirtyIds       : () => new Set(),
    appendedPoints : () => sumados,
  }
  const { spy, redraw } = await mount({ source })
  assert.deepEqual(redraw().map(t => t.count), [20, 5])
  const imagenes = spy.texImages.length
  sumados.set(2, [[1.1, 1.1]])
  avisos.forEach(cb => cb())
  assert.equal(spy.texImages.length, imagenes)
  assert.deepEqual(redraw().map(t => t.count), [20, 6])
})

test('append de un id que el Source no tiene falla, y sin puntos no hace nada', async () => {
  const { source } = await mount()
  assert.throws(() => source.append(99, [0, 0]), RangeError)
  assert.doesNotThrow(() => source.append(1))
})

test('el foco atenúa a los demás y devuelve true, sin tocar el store', async () => {
  const { layer, spy, redraw } = await mount({ items: [{ id: 1, path: recorrido(5) }, { id: 2, path: recorrido(5, 1) }] })
  const imagenes = spy.texImages.length
  assert.equal(layer.applyFocus(new Set([2]), 0.25), true)
  assert.deepEqual(redraw().map(t => t.alpha), [0.25, 1])
  layer.applyFocus(null)
  assert.deepEqual(redraw().map(t => t.alpha), [1, 1])
  assert.equal(spy.texImages.length, imagenes)
})

test('el foco sobrevive a un patch', async () => {
  const { layer, source, redraw } = await mount({ items: [{ id: 1, path: recorrido(5) }, { id: 2, path: recorrido(5, 1) }] })
  layer.applyFocus(new Set([2]), 0.25)
  source.patch([{ id: 1, path: recorrido(6) }, { id: 2, path: recorrido(5, 1) }], new Set([1]))
  await tick()
  assert.deepEqual(redraw().map(t => t.alpha), [0.25, 1])
})

/* ── Gradiente ── */

const conGradiente = {
  scalarOf  : (_item, i) => i,
  colorRamp : v => (v < 1 ? '#ff0000' : v < 2 ? '#0000ff' : '#00ff00'),
}

const ultimosColores = spy => spy.texSubTexels.filter(t => t instanceof Uint8Array).at(-1)

test('con gradiente cada vértice lleva el color de su escalar y el trazo lo lee de la textura', async () => {
  const { spy, redraw } = await mount({ items: [{ id: 1, path: recorrido(2) }], accessors: conGradiente })
  assert.deepEqual([...ultimosColores(spy).subarray(0, 8)], [255, 0, 0, 255, 0, 0, 255, 255])
  assert.deepEqual(redraw().map(t => t.gradient), [1])
})

test('sin gradiente el trazo usa el color del estilo', async () => {
  const { redraw } = await mount({ items: [{ id: 1, path: recorrido(2) }] })
  assert.deepEqual(redraw().map(t => t.gradient), [0])
})

test('lo agregado se tiñe con el escalar de su índice en el path', async () => {
  const { source, spy, redraw } = await mount({ items: [{ id: 1, path: recorrido(2) }], accessors: conGradiente })
  source.append(1, [1, 1])
  await tick()
  const [{ first }] = redraw()
  const bytes = ultimosColores(spy)
  assert.deepEqual([...bytes.subarray((first + 2) * 4, (first + 3) * 4)], [0, 255, 0, 255], 'el índice 2 cae en el tercer tramo de la rampa')
  assert.deepEqual([...bytes.subarray(first * 4, first * 4 + 4)], [255, 0, 0, 255], 'lo escrito antes viaja con ello')
})

/* ── Rebuild con la ventana abierta ── */

// Un rebuild lee el path con lo que `append` sumó en la ventana abierta: el flush que la cierra no
// vuelve a sumarlo, y lo que llega después toma el índice que tiene en el path.
test('una capa que nace con un append pendiente no lo suma dos veces', async () => {
  const vistos = []
  const source = createSource({ idOf: r => r.id, pathOf: r => r.path, scalarOf: (_item, i) => vistos.push(i), colorRamp: () => '#ff0000' })
  source.set([{ id: 1, path: recorrido(20) }])
  await tick()
  source.append(1, [1, 1])
  const { redraw } = await mount({ source })
  assert.deepEqual(redraw().map(t => t.count), [21])
  vistos.length = 0
  source.append(1, [1.1, 1.1])
  await tick()
  assert.deepEqual(vistos, [21])
})

test('refresh con un append pendiente no lo suma dos veces, ni con la ventana ya cerrada', async () => {
  const { source, layer, redraw } = await mount({ items: [{ id: 1, path: recorrido(20) }] })
  source.append(1, [1, 1])
  layer.refresh()
  source.append(1, [1.1, 1.1])
  await tick()
  assert.deepEqual(redraw().map(t => t.count), [22], 'lo leído por el refresh no vuelve; lo de después, sí')
  layer.refresh()
  source.append(1, [1.2, 1.2])
  await tick()
  assert.deepEqual(redraw().map(t => t.count), [23], 'la ventana siguiente se suma entera')
})

test('el índice armado con un append pendiente no lo suma dos veces', async () => {
  const { layer, source } = await mount({ items: [{ id: 1, path: recorrido(5) }] })
  source.append(1, [30, 30])
  layer.resolveClick({ lat: 0, lng: 0 })
  await tick()
  source.append(1, [30.1, 30.1])
  await tick()
  const incremental = layer.resolveClick({ lat: 30.1, lng: 30.1 })
  layer.refresh()
  assert.deepEqual(incremental, layer.resolveClick({ lat: 30.1, lng: 30.1 }))
})

/* ── Picking ── */

test('el picking devuelve el id, el tramo y el vértice más cercano', async () => {
  const { layer } = await mount({ items: [{ id: 1, path: recorrido(5) }, { id: 2, path: recorrido(5, 20, 20) }] })
  const [hit] = layer.resolveClick({ lat: 0.0025, lng: 0.0025 })
  assert.deepEqual([hit.id, hit.ref, hit.partIndex], [1, 1, 0])
  assert.equal(hit.vertexIndex, 2)
  assert.ok(hit.distancePx < 1)
  assert.deepEqual(layer.resolveHover({ lat: -40, lng: 100 }), [])
})

test('el picking ve lo agregado y lo patcheado, y deja de ver lo que ya no está', async () => {
  const { layer, source } = await mount({ items: [{ id: 1, path: recorrido(5) }] })
  assert.deepEqual(layer.resolveClick({ lat: 30, lng: 30 }), [], 'arma el índice antes del append')
  source.append(1, [30, 30], [30.1, 30.1])
  await tick()
  assert.equal(layer.resolveClick({ lat: 30.1, lng: 30.1 })[0]?.id, 1)
  source.patch([{ id: 1, path: recorrido(5, -30, -30) }], new Set([1]))
  await tick()
  assert.deepEqual(layer.resolveClick({ lat: 30, lng: 30 }), [])
  assert.equal(layer.resolveClick({ lat: -30, lng: -30 })[0]?.id, 1)
})

test('el picking de una capa vacía no falla', async () => {
  const { layer } = await mount({ items: [] })
  assert.deepEqual(layer.resolveClick({ lat: 0, lng: 0 }), [])
})
