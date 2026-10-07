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
import { byDefault } from '../../src/geometry/geodesic.js'
import geographiclib from 'geographiclib-geodesic'

let currentGl = null

after(decorarElementos((el, tag) => {
  if (tag === 'canvas') el.getContext = kind => (kind === 'webgl2' ? currentGl : null)
  return el
}))

const tick = () => new Promise(resolve => setTimeout(resolve, 5))

const recorrido = (n, lat = 0, lng = 0) => Array.from({ length: n }, (_, i) => [lat + i * 0.001, lng + i * 0.001])

// El trazo lee `first`/`count` y el alfa del color en cada draw: se capturan en el instante.
// Asienta la ventana del `set` inicial: lo que cada test haga después es el cambio que mide.
const mount = async ({ items, accessors = {}, source: propia, zoom, ...opts } = {}) => {
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
  const layer = new LineGpuLayer({ host: adoptLeafletHost(makeMapStub({ zoom })), pane: 'p', source, ...opts })
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

// Lo que la ventana abierta sumó al path todavía no se dibuja, y el índice que se arma entonces tampoco lo
// ve: se pica lo que se ve.
test('el índice armado con un append pendiente no pica lo que todavía no se dibujó', async () => {
  const { layer, source } = await mount({ items: [{ id: 1, path: recorrido(5) }] })
  source.append(1, [30, 30], [NaN, NaN], [40, 40], [40.1, 40.1])
  assert.deepEqual([layer.resolveClick({ lat: 30, lng: 30 }), layer.resolveClick({ lat: 40, lng: 40 })], [[], []])
  await tick()
  assert.deepEqual([30, 40].map(v => layer.resolveClick({ lat: v, lng: v })[0]?.vertexIndex), [4, 7])
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

/* ── Geodésica ── */

// Las referencias no salen de la capa: la geodésica de la esfera de radio medio la da la geographiclib con
// f = 0, y el vértice de un círculo máximo entre dos puntos de igual latitud φ separados por Δλ está a
// medio camino, en tan φv = tan φ / cos(Δλ/2). La capa pica en el plano de Mercator, así que la distancia
// del hit en px, llevada a metros con la escala de la latitud, es lo que la cuerda se aparta de la curva.
const R      = 6371008.8
const RAD    = Math.PI / 180
const ZOOM   = 8
const esfera = new geographiclib.Geodesic.Geodesic(R, 0)
const metros = (px, lat) => px * 2 * Math.PI * R * Math.cos(lat * RAD) / (256 * 2 ** ZOOM)
const sobre  = (a, b, t) => {
  const tramo = esfera.InverseLine(a[0], a[1], b[0], b[1])
  const p     = tramo.Position(tramo.s13 * t)
  return { lat: p.lat2, lng: p.lon2 }
}

const A       = [50, 0]
const B       = [50, 10]
const VERTICE = { lat: Math.atan(Math.tan(50 * RAD) / Math.cos(5 * RAD)) / RAD, lng: 5 }
const RECTA   = { lat: 50, lng: 5 }                   // el medio de la recta de Mercator, ~12 km al sur

test('con curva, el tramo largo se dibuja y se pica sobre la geodésica, con el vértice de la entrada', async () => {
  const { layer, redraw } = await mount({ items: [{ id: 1, path: [[NaN, NaN], A, B] }], zoom: ZOOM })
  assert.deepEqual(layer.resolveClick(VERTICE), [], 'recta: la curva no está')
  assert.equal(layer.resolveClick(RECTA)[0]?.vertexIndex, 1)

  layer.setCurve(byDefault)
  for (let k = 0; k <= 20; k++) {
    const p     = sobre(A, B, k / 20)
    const [hit] = layer.resolveClick(p)
    assert.deepEqual([hit?.id, hit?.partIndex, hit?.vertexIndex], [1, 0, 1], `${k}/20: el corte ocupa el índice 0`)
    assert.ok(metros(hit.distancePx, p.lat) <= 0.11, `${k}/20: ${metros(hit.distancePx, p.lat)} m de la geodésica`)
  }
  assert.deepEqual(layer.resolveClick(RECTA), [], 'el medio de la recta ya no se pica')
  const [{ count }] = redraw()
  assert.ok(count > 100, `${count} puntos dibujados`)

  layer.setCurve(null)
  assert.deepEqual(redraw().map(t => t.count), [2], 'sin curva vuelve a la recta')
  assert.deepEqual(layer.resolveClick(VERTICE), [])
})

test('con curva, los puntos insertados interpolan el escalar de los dos vértices', async () => {
  const valores = []
  const { layer, redraw } = await mount({
    items     : [{ id: 1, path: [A, B] }],
    accessors : { scalarOf: (_item, i) => i * 10, colorRamp: v => (valores.push(v), '#ff0000') },
  })
  valores.length = 0
  layer.setCurve(byDefault)
  const [{ count }] = redraw()
  const m = valores.length - 1
  assert.equal(valores.length, count, 'un color por punto dibujado')
  valores.forEach((v, k) => assert.ok(Math.abs(v - 10 * k / m) < 1e-9, `el punto ${k} de ${m} lleva ${v}`))
})

test('un track GPS con curva se dibuja byte a byte igual que sin ella', async () => {
  const items     = [{ id: 1, path: recorrido(300, -37, -73) }, { id: 2, path: recorrido(300, 60, 10) }]
  const accessors = { scalarOf: (_item, i) => i, colorRamp: v => [v / 300, 0, 1 - v / 300, 1] }
  const recto     = await mount({ items, accessors })
  const curvo     = await mount({ items, accessors })
  const subidas   = ({ spy }) => [spy.texImages.length, spy.texSubImages.length]
  const [i0, s0]  = subidas(recto)
  const [i1, s1]  = subidas(curvo)
  recto.layer.refresh()
  curvo.layer.setCurve(byDefault)
  assert.deepEqual(curvo.spy.texels.slice(i1), recto.spy.texels.slice(i0))
  assert.deepEqual(curvo.spy.texSubTexels.slice(s1), recto.spy.texSubTexels.slice(s0))
  assert.ok(recto.spy.texSubTexels.length > s0)
})

test('con curva, lo agregado a un tramo abierto se curva desde su último vértice', async () => {
  const valores = []
  const { layer, source, redraw } = await mount({
    items     : [{ id: 1, path: [[49, 0], A] }],
    accessors : { scalarOf: (_item, i) => i, colorRamp: v => (valores.push(v), '#ff0000') },
    zoom      : ZOOM,
  })
  layer.setCurve(byDefault)
  layer.resolveClick(VERTICE)
  valores.length = 0
  source.append(1, B)
  await tick()
  const m = valores.length
  assert.ok(m > 100, `${m} puntos agregados`)
  valores.forEach((v, k) => assert.ok(Math.abs(v - (1 + (k + 1) / m)) < 1e-9, `el agregado ${k} lleva ${v}`))
  const incremental = [redraw().map(t => t.count), layer.resolveClick(VERTICE)]
  assert.equal(incremental[1][0]?.vertexIndex, 1, 'el hit sobre lo agregado da el vértice que abre el tramo')
  layer.refresh()
  assert.deepEqual([redraw().map(t => t.count), layer.resolveClick(VERTICE)], incremental, 'igual que reconstruir')
})

test('con curva, un punto suelto se une a lo agregado por la geodésica', async () => {
  const { layer, source, redraw } = await mount({ items: [{ id: 1, path: [A] }], zoom: ZOOM })
  layer.setCurve(byDefault)
  layer.resolveClick(VERTICE)
  source.append(1, B)
  await tick()
  const incremental = [redraw().map(t => t.count), layer.resolveClick(VERTICE)]
  assert.ok(incremental[0][0] > 100)
  assert.equal(incremental[1][0]?.vertexIndex, 0)
  layer.refresh()
  assert.deepEqual([redraw().map(t => t.count), layer.resolveClick(VERTICE)], incremental, 'igual que reconstruir')
})

test('un punto suelto que se une a lo agregado abre el tramo: junto a él se pica su vértice, con y sin curva', async () => {
  for (const curve of [null, byDefault]) {
    const { layer, source } = await mount({ items: [{ id: 1, path: [A] }], zoom: ZOOM })
    layer.setCurve(curve)
    layer.resolveClick(VERTICE)
    source.append(1, B)
    await tick()
    assert.equal(layer.resolveClick(sobre(A, B, 0.002))[0]?.vertexIndex, 0, `curva ${!!curve}`)
  }
})

test('los buffers que crecen conservan el color de lo ya empacado', async () => {
  const rojo = [255, 0, 0, 255]
  const { spy } = await mount({
    items     : [{ id: 1, path: recorrido(40) }],    // más que los 32 puntos con que nacen los buffers
    accessors : { scalarOf: (_item, i) => i, colorRamp: v => v ? '#0000ff' : '#ff0000' },
  })
  const [primera] = spy.texSubTexels.filter(datos => datos instanceof Uint8Array)
  assert.deepEqual([...primera.subarray(0, 4)], rojo, 'el primer punto sube rojo en la subida que hizo crecer los buffers')
})

test('la caja de la capa es la de la curva, y sin curva la capa no la informa', async () => {
  const { layer } = await mount({ items: [{ id: 1, path: [A, B] }, { id: 2, path: [[-20, 3]] }] })
  assert.equal(layer.bounds, null, 'sin curva encuadra la Source')
  layer.setCurve(byDefault)
  const { south, west, north, east } = layer.bounds
  assert.ok(Math.abs(north - VERTICE.lat) < 1e-4, `norte ${north} contra el vértice ${VERTICE.lat}`)
  ;[[south, 50], [west, 0], [east, 10]].forEach(([real, ref]) => assert.ok(Math.abs(real - ref) < 1e-9, `${real} vs ${ref}`))
})
