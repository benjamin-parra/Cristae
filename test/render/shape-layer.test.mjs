// Contrato de ShapeLayer: cada forma —círculo, elipse, sector, sector de elipse— es el anillo del escritor de
// `ring` sobre el modelo que recibe, lo dibuja la capa de polígonos y el picking es punto-en-anillo sobre esas
// mismas tablas. Lo que acá se congela: que el anillo entregado es el de `ring` y está donde lo pone la
// geodésica del modelo, que el hit sigue a la curva, el orden de arriba hacia abajo, los descartes, el
// re-teselado por zoom, el tope de textura y la vuelta atrás cuando algo lanza; y desde el motor, el kind, el
// pane, el foco y el encuadre. Las referencias salen de la geographiclib directa y de fórmulas cerradas.
//
// El harness (engine-stub) shimea window/document — se importa PRIMERO.
import '../../test-helpers/engine-stub.mjs'
import { conGlDeEdicion, makeGl, makeLeaflet, makeMap, makePickSpy, makeSurface } from '../../test-helpers/engine-stub.mjs'
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import geographiclib from 'geographiclib-geodesic'
import { createSource } from '../../src/data/Source.js'
import { MapEngine } from '../../src/engine/MapEngine.js'
import { MEAN_RADIUS, byDefault } from '../../src/geometry/geodesic.js'
import { WGS84 } from '../../src/geometry/ellipsoid.js'
import { ring } from '../../src/geometry/shape.js'
import { adoptLeafletHost } from '../../src/host/LeafletHost.js'
import { LayerRegistry } from '../../src/interaction/LayerRegistry.js'
import { PolygonGpuLayer } from '../../src/render/PolygonGpuLayer.js'
import { ShapeLayer } from '../../src/render/ShapeLayer.js'

const D = Math.PI / 180

// Los oráculos: la geographiclib directa, sobre la esfera de la capa y sobre WGS84.
const { Geodesic, DISTANCE, AZIMUTH, LATITUDE, LONGITUDE, LONG_UNROLL } = geographiclib.Geodesic

const ESFERA    = new Geodesic(MEAN_RADIUS, 0)
const ELIPSOIDE = new Geodesic(6378137, 1 / 298.257223563)

// La Source real emite en rAF (defer:'raf' → setTimeout(0) bajo el shim); un macrotask lo vacía.
const flush = () => new Promise(r => globalThis.setTimeout(r, 0))

const accessors = {
  idOf       : d => d.id,
  positionOf : d => ({ lat: d.center[0], lng: d.center[1] }),
  radiusOf   : d => d.radius,
  headingOf  : d => d.heading,
  sweepOf    : d => d.sweep,
  styleOf    : d => d.style,
}

/* ── Dobles: un contexto por montaje, con los colores que pide y su tope de textura ── */

let currentGl = null
after(conGlDeEdicion(() => currentGl))

const MAX_TEXTURE = 0x0D33

// El trazo fija su color con `uniform4fv`; `cap` declara el lado máximo de textura, como un contexto real, y
// `released` cuenta los contextos devueltos.
const gpu = ({ cap = null } = {}) => {
  const spy    = Object.assign(makePickSpy(), { released: 0 })
  const stroke = []
  const gl     = makeGl(() => spy.released++, spy, makeSurface())
  const own    = {
    getContextAttributes: () => ({ stencil: true }),
    uniform4fv: (_loc, rgba) => stroke.push([...rgba]),
    ...cap === null ? {} : { MAX_TEXTURE_SIZE: MAX_TEXTURE, getParameter: p => (p === MAX_TEXTURE ? cap : undefined) },
  }
  currentGl = new Proxy(gl, { get: (t, p) => own[p] ?? t[p] })
  return { spy, stroke }
}

// Las tablas que la capa le entrega a la capa interna, en grados: de ahí salen los texels y el hit.
const entregadas  = []
const setGeometry = PolygonGpuLayer.prototype.setGeometry
PolygonGpuLayer.prototype.setGeometry = function (geometry, ...rest) {
  entregadas.push(geometry)
  return setGeometry.call(this, geometry, ...rest)
}
after(() => { PolygonGpuLayer.prototype.setGeometry = setGeometry })

// Los anillos de la última entrega como `[lat, lng]`, sin el vértice que repite al primero.
const anillos = (geometria = entregadas.at(-1)) =>
  Array.from({ length: geometria.ringCount }, (_, k) => {
    const out = []
    for (let i = geometria.vertexAt[k]; i < geometria.vertexAt[k + 1] - 1; i++) out.push([geometria.xy[i * 2 + 1], geometria.xy[i * 2]])
    return out
  })

const mount = async (items, { zoom = 12, model = byDefault, cap = null, source = createSource(accessors), interactive = true } = {}) => {
  const { spy, stroke } = gpu({ cap })
  const map = makeMap({ zoom })
  source.set(items)
  await flush()
  const layer = new ShapeLayer({ host: adoptLeafletHost(map), pane: 'p', source, model, interactive })
  return { layer, map, source, spy, stroke }
}

// El punto a `metros` y `rumbo` del centro sobre la esfera de la capa, por la geographiclib.
const destino = ([lat, lng], rumbo, metros) => {
  const r = ESFERA.Direct(lat, lng, rumbo, metros, LATITUDE | LONGITUDE | LONG_UNROLL)
  return { lat: r.lat2, lng: r.lon2 }
}
const pica = (layer, punto) => layer.resolveClick(punto).map(h => h.id)

const SANTIAGO = [-33.45, -70.66]

/* ── El anillo es el de `ring`, y está donde lo pone el modelo ── */

// La capa elige los segmentos por la vista y `ring` por la tolerancia sin vista: en el zoom en que piden el
// mismo número, los dos anillos son el mismo bit a bit.
test('el anillo de cada forma es el de ring en el zoom que pide su mismo número de segmentos', async () => {
  const formas = [
    { id: 'círculo', center: SANTIAGO, radius: 500 },
    { id: 'elipse', center: SANTIAGO, radius: [800, 300], heading: 30 },
    { id: 'sector', center: SANTIAGO, radius: 5000, heading: 45, sweep: 90 },
    { id: 'sector de elipse', center: SANTIAGO, radius: [800, 300], heading: 10, sweep: 200 },
  ]
  for (const forma of formas) {
    const publico = ring(forma)
    let iguales = 0
    for (let zoom = 0; zoom <= 22; zoom++) {
      const { layer } = await mount([forma], { zoom })
      const [dibujado] = anillos()
      if (dibujado.length === publico.length) {
        assert.deepEqual(dibujado, publico, `${forma.id} a zoom ${zoom}`)
        iguales++
      }
      layer.destroy()
    }
    assert.ok(iguales >= 1, `${forma.id}: algún zoom pide el número de ring`)
  }
})

// Con `t` uniforme la flecha máxima de la elipse es la del círculo de su semieje mayor: en cada zoom lleva sus
// mismos vértices, sea el mayor `a` o `b`, y en alguno más que el círculo del menor.
test('la elipse lleva los segmentos del círculo de su semieje mayor, sea a o b', async () => {
  let distintos = 0
  for (const zoom of [8, 12, 15, 17, 19]) {
    const { layer } = await mount([
      { id: 'a', center: SANTIAGO, radius: [2000, 300], heading: 30 },
      { id: 'b', center: SANTIAGO, radius: [300, 2000], heading: 30 },
      { id: 'mayor', center: SANTIAGO, radius: 2000 },
      { id: 'menor', center: SANTIAGO, radius: 300 },
    ], { zoom })
    const [a, b, mayor, menor] = anillos().map(anillo => anillo.length)
    assert.deepEqual([a, b], [mayor, mayor], `zoom ${zoom}`)
    distintos += mayor !== menor
    layer.destroy()
  }
  assert.ok(distintos > 0)
})

const enGrados = ang => ((ang % 360) + 540) % 360 - 180

test('con WGS84, cada vértice de la elipse está a ρ(t) del centro y a su rumbo, por la geodésica del elipsoide', async () => {
  const [a, b, rumbo] = [800, 300, 30]
  const { layer } = await mount([{ id: 1, center: SANTIAGO, radius: [a, b], heading: rumbo }], { model: WGS84 })
  const [vertices] = anillos()

  assert.ok(vertices.length >= 16)
  vertices.forEach(([lat, lng], i) => {
    const t   = 2 * Math.PI * i / vertices.length
    const u   = a * Math.cos(t), v = b * Math.sin(t)
    const inv = ELIPSOIDE.Inverse(...SANTIAGO, lat, lng, DISTANCE | AZIMUTH)
    assert.ok(Math.abs(inv.s12 - Math.hypot(u, v)) < 1e-6, `vértice ${i}: ${inv.s12} m`)
    assert.ok(Math.abs(enGrados(inv.azi1 - rumbo - Math.atan2(v, u) / D)) < 1e-7, `vértice ${i}: rumbo ${inv.azi1}`)
  })
  layer.destroy()
})

test('con WGS84, el sector parte del centro y cada vértice cae en uno de sus radios o en su arco', async () => {
  const [r, rumbo, abre] = [5000, 60, 90]
  const { layer } = await mount([{ id: 1, center: SANTIAGO, radius: r, heading: rumbo, sweep: abre }], { model: WGS84 })
  const [[centro, ...resto]] = anillos()
  const lados = { izquierdo: 0, derecho: 0, arco: 0 }

  assert.deepEqual(centro, SANTIAGO)
  resto.forEach(([lat, lng], i) => {
    const { s12, azi1 } = ELIPSOIDE.Inverse(...SANTIAGO, lat, lng, DISTANCE | AZIMUTH)
    const desvio = enGrados(azi1 - rumbo)
    const lado   = Math.abs(desvio + abre / 2) < 1e-7 ? 'izquierdo'
      : Math.abs(desvio - abre / 2) < 1e-7 ? 'derecho'
      : Math.abs(s12 - r) < 1e-6 && Math.abs(desvio) < abre / 2 ? 'arco'
      : null
    assert.ok(lado && s12 <= r + 1e-6, `vértice ${i + 1} fuera del borde: ${s12} m a ${azi1}°`)
    lados[lado]++
  })
  assert.ok(lados.izquierdo > 1 && lados.derecho > 1 && lados.arco > 1, JSON.stringify(lados))
  layer.destroy()
})

/* ── El hit sigue a la curva ── */

// Un punto dentro del polígono inscrito —a menos de la apotema r·cos(π/n) del centro— pica, y uno fuera de
// la curva no, en todas las direcciones: el borde del hit es el del anillo dibujado.
test('pica dentro de la apotema del anillo y no fuera del radio, en todas las direcciones', async () => {
  const r = 1000
  const { layer } = await mount([{ id: 1, center: SANTIAGO, radius: r }], { zoom: 15 })
  const n       = anillos()[0].length
  const apotema = r * Math.cos(Math.PI / n)

  for (let rumbo = 0; rumbo < 360; rumbo += 7.3) {
    assert.deepEqual(pica(layer, destino(SANTIAGO, rumbo, apotema * (1 - 1e-4))), [1], `adentro a ${rumbo}°`)
    assert.deepEqual(pica(layer, destino(SANTIAGO, rumbo, r * (1 + 1e-4))), [], `afuera a ${rumbo}°`)
  }
  layer.destroy()
})

test('la elipse pica a lo largo de sus semiejes y no en el círculo de su semieje mayor', async () => {
  const [a, b, rumbo] = [2000, 600, 30]
  const { layer } = await mount([{ id: 1, center: SANTIAGO, radius: [a, b], heading: rumbo }], { zoom: 15 })

  assert.deepEqual(pica(layer, destino(SANTIAGO, rumbo, a * 0.99)), [1], 'sobre a')
  assert.deepEqual(pica(layer, destino(SANTIAGO, rumbo + 180, a * 0.99)), [1], 'sobre −a')
  assert.deepEqual(pica(layer, destino(SANTIAGO, rumbo, a * 1.01)), [], 'pasado a')
  assert.deepEqual(pica(layer, destino(SANTIAGO, rumbo + 90, b * 0.99)), [1], 'sobre b')
  assert.deepEqual(pica(layer, destino(SANTIAGO, rumbo + 90, b * 1.01)), [], 'pasado b')
  assert.deepEqual(pica(layer, destino(SANTIAGO, rumbo + 90, a * 0.9)), [], 'de través, a la distancia de a')
  layer.destroy()
})

test('el sector pica dentro de su apertura, también la refleja de más de 180°, y no fuera de ella', async () => {
  const forma = { center: SANTIAGO, radius: 3000, heading: 0 }
  const { layer } = await mount([
    { ...forma, id: 'haz', sweep: 90 },
    { ...forma, id: 'reflejo', center: [-33, -70], heading: 180, sweep: 270 },
  ], { zoom: 14 })

  assert.deepEqual(pica(layer, destino(SANTIAGO, 40, 1500)), ['haz'], 'dentro del haz')
  assert.deepEqual(pica(layer, destino(SANTIAGO, 50, 1500)), [], 'pasado su borde derecho')
  assert.deepEqual(pica(layer, destino(SANTIAGO, -50, 1500)), [], 'y pasado el izquierdo')
  assert.deepEqual(pica(layer, destino(SANTIAGO, 180, 1500)), [], 'detrás')
  ;[90, 180, 270, 50, 310].forEach(rumbo =>
    assert.deepEqual(pica(layer, destino([-33, -70], rumbo, 1500)), ['reflejo'], `el reflejo a ${rumbo}°`))
  ;[0, 40, 320].forEach(rumbo =>
    assert.deepEqual(pica(layer, destino([-33, -70], rumbo, 1500)), [], `el hueco de 90° que deja, a ${rumbo}°`))
  layer.destroy()
})

// Las tres contienen el punto y su caja termina al este en otro orden que el de declaración: el hit sale en
// el inverso del orden de dibujo, no en el del índice.
test('de varias formas superpuestas, el hit sale de arriba hacia abajo', async () => {
  const { layer } = await mount([
    { id: 'abajo', center: [0, 0.02], radius: 5000 },
    { id: 'medio', center: [0, 0], radius: 1000 },
    { id: 'arriba', center: [0, 0.005], radius: 2000 },
  ])
  const hits = layer.resolveClick({ lat: 0, lng: 0.001 })

  assert.deepEqual(hits.map(h => h.id), ['arriba', 'medio', 'abajo'])
  assert.deepEqual(hits[0], { ref: 'arriba', id: 'arriba', distancePx: 0 }, 'ref es el id, y el hit es de área')
  layer.destroy()
})

test('pasado el antimeridiano pica en la copia del mundo donde se dibuja, y no en el borde opuesto', async () => {
  const { layer } = await mount([{ id: 'E', center: [0, 179.95], radius: [20000, 5000], heading: 90 }])

  assert.deepEqual(pica(layer, { lat: 0, lng: 180.1 }), ['E'], 'pasado el 180, en la misma copia')
  assert.deepEqual(pica(layer, { lat: 0, lng: -179.9 }), [], 'el mismo punto envuelto no')
  layer.destroy()
})

test('sin `interactive` la capa dibuja y no pica', async () => {
  const { layer } = await mount([{ id: 1, center: [0, 0], radius: 1000 }], { interactive: false })
  assert.equal(anillos().length, 1)
  assert.deepEqual(pica(layer, { lat: 0, lng: 0 }), [])
  layer.destroy()
})

/* ── Validez ── */

// La cota del polo se toma con el semieje mayor, sea `a` o `b`.
test('se descarta la forma cuyo borde alcanza un polo, con el semieje mayor, y la que no cumple la regla de ring', async () => {
  const { layer } = await mount([
    { id: 'polo', center: [89.9, 0], radius: [1000, 50_000] },
    { id: 'cerca', center: [89.9, 0], radius: 1000 },
    { id: 'cero', center: [89.9, 0], radius: 0 },
    { id: 'rumbo', center: [89.9, 0], radius: [1000, 900], heading: NaN },
    { id: 'abre', center: [89.9, 0], radius: 1000, sweep: -10 },
    { id: 'centro', center: [NaN, 0], radius: 1000 },
  ])
  assert.deepEqual(pica(layer, { lat: 89.9, lng: 0 }), ['cerca'])
  assert.equal(anillos().length, 1, 'y sólo esa se dibuja')
  layer.destroy()
})

test('headingOf y sweepOf que devuelven undefined dan el norte y la figura entera', async () => {
  const sinNada  = createSource({ ...accessors, headingOf: () => undefined, sweepOf: () => undefined })
  const sinEllos = createSource({ idOf: accessors.idOf, positionOf: accessors.positionOf, radiusOf: accessors.radiusOf })
  const elipse   = { id: 1, center: SANTIAGO, radius: [800, 300], heading: 70, sweep: 45 }

  const montajes = []
  for (const source of [sinNada, sinEllos]) {
    const { layer } = await mount([elipse], { source })
    montajes.push(anillos()[0])
    layer.destroy()
  }
  assert.deepEqual(montajes[0], montajes[1])
  assert.equal(montajes[0][0][1], SANTIAGO[1], 'el vértice 0 sobre el semieje a, al norte del centro')
  assert.ok(montajes[0][0][0] > SANTIAGO[0])
  assert.equal(montajes[0].length % 16, 0, 'la figura entera: una potencia de dos de vértices')
})

/* ── Teselado por zoom y tope de textura ── */

test('al asentar el zoom re-tesela sólo si cambia el número de segmentos que pide alguna forma', async () => {
  const { layer, map } = await mount([{ id: 1, center: [0, 0], radius: 1000 }], { zoom: 3 })
  const base = entregadas.length
  assert.equal(anillos()[0].length, 16)

  map.setZoomForTest(4).fire('zoomend')
  assert.equal(entregadas.length, base, 'otro zoom con los mismos segmentos no rearma')

  map.setZoomForTest(18).fire('zoomend')
  assert.equal(entregadas.length, base + 1, 'otro número de segmentos rearma')
  assert.equal(anillos()[0].length, 256)

  map.setZoomForTest(18).fire('zoomend')
  assert.equal(entregadas.length, base + 1, 'y repetir el zoom no')
  layer.destroy()
})

// Con un lado de 8 caben 64 vértices: dos círculos que piden 256 bajan a 32 cada uno, sin lanzar.
test('lo que no cabe en la textura baja los segmentos de todas a la mitad hasta que entra', async () => {
  const { layer } = await mount([{ id: 1, center: [0, 0], radius: 1000 }, { id: 2, center: [0, 1], radius: 1000 }], { zoom: 18, cap: 8 })
  assert.deepEqual(anillos().map(a => a.length), [32, 32])
  assert.deepEqual(pica(layer, { lat: 0, lng: 1 }), [2], 'y pica sobre el anillo recortado')
  layer.destroy()

  const chico = await mount([{ id: 1, center: [0, 0], radius: 2 }, { id: 2, center: [0, 1], radius: 1000 }], { zoom: 18, cap: 8 })
  assert.deepEqual(anillos().map(a => a.length), [16, 32], 'la que ya pide el mínimo no baja de él')
  chico.layer.destroy()
})

// El recorte no cambia lo pedido: comparar contra el recorte rearmaría en cada zoom.
test('con el tope activo, zoomend compara contra lo pedido y no contra lo recortado', async () => {
  const { layer, map } = await mount([{ id: 1, center: [0, 0], radius: 1000 }], { zoom: 18, cap: 8 })
  const base = entregadas.length
  assert.equal(anillos()[0].length, 64)

  map.setZoomForTest(18).fire('zoomend')
  assert.equal(entregadas.length, base, 'el mismo pedido no rearma')
  map.setZoomForTest(19).fire('zoomend')
  assert.equal(entregadas.length, base + 1, 'otro pedido sí')
  assert.equal(anillos()[0].length, 64, 'y vuelve a recortarse')
  layer.destroy()
})

// Con un lado de 4 caben 16 vértices, el mínimo de un solo círculo: dos ya no entran ni en el mínimo, y la
// capa sigue dibujando y picando lo de antes. El orden nuevo invierte las partes, así que un índice que no
// volviera con los registros contestaría el id del otro.
test('si la capa interna rechaza la geometría, refresh lanza y la capa queda como estaba', async t => {
  const errores  = []
  const original = console.error
  console.error = (...a) => errores.push(a)
  t.after(() => (console.error = original))
  const uno = { id: 1, center: [0, 0], radius: 1000 }
  const dos = { id: 2, center: [0, 1], radius: 1000 }
  const { layer, source } = await mount([uno], { zoom: 18, cap: 4 })
  assert.equal(anillos()[0].length, 16)

  source.set([dos, uno])
  await flush()
  assert.match(String(errores[0]?.[1]), /no entran/)
  assert.deepEqual(pica(layer, { lat: 0, lng: 0 }), [1], 'el de antes sigue picando con su id')
  assert.deepEqual(pica(layer, { lat: 0, lng: 1 }), [], 'el que no entró no pica')
  assert.throws(() => layer.refresh(), /no entran/)
  layer.destroy()
})

test('un alta cuya primera lectura lanza devuelve el contexto', async () => {
  const source = createSource({ ...accessors, styleOf: () => { throw new Error('estilo') } })
  source.set([{ id: 1, center: [0, 0], radius: 1000 }])
  await flush()
  const { spy } = gpu()
  assert.throws(() => new ShapeLayer({ host: adoptLeafletHost(makeMap()), pane: 'p', source, model: byDefault }), /estilo/)
  assert.equal(spy.released, 1)
})

/* ── La capa sigue a la Source y conserva el estilo propio ── */

test('un patch de radio y un move rehacen el anillo y el hit', async () => {
  const { layer, source } = await mount([{ id: 1, center: [0, 0], radius: 1000, heading: 0, sweep: 90 }])
  assert.deepEqual(pica(layer, destino([0, 0], 45, 5000)), [])

  source.getSnapshot()[0].radius = 10_000
  source.patch(source.getSnapshot(), new Set([1]))
  await flush()
  assert.deepEqual(pica(layer, destino([0, 0], 45, 5000)), [1], 'el radio nuevo')

  source.move(1, 5, 5)
  await flush()
  assert.deepEqual(pica(layer, destino([5, 5], 45, 5000)), [1], 'el centro nuevo')
  assert.deepEqual(pica(layer, destino([0, 0], 45, 5000)), [], 'y el viejo quedó vacío')
  layer.destroy()
})

test('el estilo es por forma, aunque styleOf reuse su objeto, y el foco atenúa por forma', async () => {
  const scratch = {}
  const source  = createSource({ ...accessors, styleOf: d => Object.assign(scratch, d.style) })
  const { layer, stroke } = await mount([
    { id: 1, center: [0, 0], radius: 1000, style: { color: '#ff0000' } },
    { id: 2, center: [0, 0.05], radius: 1000, heading: 0, sweep: 90, style: { color: '#0000ff' } },
  ], { source })
  stroke.length = 0

  assert.equal(layer.applyFocus(new Set([1]), 0.25), true)
  assert.deepEqual(stroke, [[1, 0, 0, 1], [0, 0, 1, 0.25]])
  layer.destroy()
})

// La caja de un círculo de 100 km en el ecuador: el anillo pasa por los cuatro rumbos cardinales, a r/R
// radianes del centro.
test('la capa informa la caja de la figura entera', async () => {
  const { layer } = await mount([{ id: 1, center: [0, 0], radius: 100_000 }])
  const lado = 100_000 / MEAN_RADIUS / D
  const { south, west, north, east } = layer.bounds

  ;[[south, -lado], [west, -lado], [north, lado], [east, lado]].forEach(([dado, esperado]) =>
    assert.ok(Math.abs(dado - esperado) < 1e-9, `${dado} vs ${esperado}`))
  const entregas = entregadas.length
  layer.bounds
  assert.equal(entregadas.length, entregas, 'sin cambios en la Source, leer la caja no rehace los anillos')
  layer.destroy()
  assert.equal(layer.bounds, null, 'sin capa interna, sin caja')
})

/* ── Desde el motor ── */

const conMotor = () => {
  const map    = makeMap()
  const engine = new MapEngine({ host: adoptLeafletHost(map, { leaflet: makeLeaflet() }) })
  return { map, engine }
}

test('desde el motor: kind shape, su pane, sus hits de arriba hacia abajo y la visibilidad', async t => {
  const resolvers = new Map()
  const upsert    = LayerRegistry.prototype.upsertResolver
  LayerRegistry.prototype.upsertResolver = function (entry) {
    resolvers.set(entry.layerId, entry)
    return upsert.call(this, entry)
  }
  t.after(() => { LayerRegistry.prototype.upsertResolver = upsert })
  const { map, engine } = conMotor()
  const { spy } = gpu()
  const handle = engine.addShapeLayer({ id: 'zonas', accessors, data: [
    { id: 1, center: [0, 0], radius: 50_000 }, { id: 2, center: [0, 0], radius: [30_000, 10_000], heading: 90 },
  ] })
  await flush()

  assert.equal(engine.getLayer('zonas').kind, 'shape')
  assert.equal(engine.getLayer('zonas').interactive, true, 'interactiva por defecto')
  assert.ok(map.getPane('cristae-shape-zonas'), 'pane cristae-shape-<id>')
  assert.equal(resolvers.get('zonas').kind, 'shape', 'y el hit lleva kind shape')
  assert.deepEqual(resolvers.get('zonas').resolveClick({ lat: 0, lng: 0 }).map(h => h.id), [2, 1])

  const draws = () => spy.draws.length
  const antes = draws()
  handle.setVisible(false)
  handle.set([{ id: 1, center: [1, 1], radius: 50_000 }])
  await flush()
  assert.equal(draws(), antes, 'oculta por el motor no repinta')
  handle.setVisible(true)
  assert.ok(draws() > antes, 'y al mostrarla vuelve a dibujar')
  engine.removeLayer('zonas')
  assert.equal(spy.released, 1, 'la baja devuelve el contexto')
})

// El foco por capa atenúa el pane de la capa que no nombra, si su kind está entre los que se atenúan.
test('desde el motor: focus con kinds shape atenúa la capa de formas', async () => {
  const { map, engine } = conMotor()
  gpu()
  engine.addShapeLayer({ id: 'zonas', accessors, data: [{ id: 1, center: [0, 0], radius: 1000 }] })
  gpu()
  engine.addShapeLayer({ id: 'radios', accessors, data: [{ id: 1, center: [1, 1], radius: 1000 }] })
  await flush()
  const opacidad = id => map.getPane(`cristae-shape-${id}`).style.opacity

  engine.focus(['zonas'], { kinds: ['polygon'], opacity: 0.25 })
  assert.equal(opacidad('radios'), '', 'otro kind: no se atenúa')
  engine.focus(['zonas'], { kinds: ['shape'], opacity: 0.25 })
  assert.deepEqual([opacidad('zonas'), opacidad('radios')], ['', '0.25'], 'kind shape: se atenúa la que no está en el foco')
  engine.destroy()
})

// El encuadre cubre la figura y no sólo su centro: un círculo de 100 km en el ecuador va de −r/R a r/R.
test('desde el motor: fitToLayers y camera.fitToLayer encuadran la figura entera', async () => {
  const { map, engine } = conMotor()
  const cajas = []
  map.fitBounds = ([sw, ne]) => { cajas.push([...sw, ...ne]); return map }
  gpu()
  engine.addShapeLayer({ id: 'zonas', accessors, data: [{ id: 1, center: [0, 0], radius: 100_000 }] })
  await flush()

  engine.fitToLayers(['zonas'])
  engine.camera.fitToLayer('zonas')
  const lado = 100_000 / MEAN_RADIUS / D
  cajas.forEach(caja => caja.forEach((v, i) => assert.ok(Math.abs(v - [-lado, -lado, lado, lado][i]) < 1e-9, `${caja}`)))
  assert.equal(cajas.length, 2)
  engine.destroy()
})

// La Source emite en el próximo frame, pero su snapshot ya trae lo nuevo: encuadrar en el mismo tick del alta
// o del `set` cubre la figura que se pidió, no la anterior ni sólo su centro.
test('desde el motor: encuadrar en el mismo tick del alta o del set cubre las figuras nuevas', async () => {
  const { map, engine } = conMotor()
  const cajas = []
  map.fitBounds = ([sw, ne]) => { cajas.push([...sw, ...ne]); return map }
  const lado  = 100_000 / MEAN_RADIUS / D
  const cubre = lng => caja => caja.forEach((v, i) =>
    assert.ok(Math.abs(v - [-lado, lng - lado, lado, lng + lado][i]) < 1e-9, `${caja} alrededor de ${lng}`))
  gpu()
  const handle = engine.addShapeLayer({ id: 'zonas', accessors, data: [{ id: 1, center: [0, 0], radius: 100_000 }] })

  engine.camera.fitToLayer('zonas')
  cubre(0)(cajas.pop())
  await flush()
  handle.set([{ id: 2, center: [0, 10], radius: 100_000 }])
  engine.camera.fitToLayer('zonas')
  engine.fitToLayers(['zonas'])
  cajas.forEach(cubre(10))
  assert.equal(cajas.length, 2)
  const entregas = entregadas.length
  await flush()
  assert.equal(entregadas.length, entregas, 'la emisión no rehace lo que el encuadre ya dibujó')
  engine.destroy()
})

// Encuadrar lee los accessors: el error de uno le llega a quien lee primero el cambio, una sola vez, y la
// capa sigue con la figura anterior hasta el próximo cambio.
test('desde el motor: un accessor que lanza al encuadrar le llega al llamador y deja la figura anterior', async () => {
  const { map, engine } = conMotor()
  const cajas = []
  map.fitBounds = ([sw, ne]) => { cajas.push([...sw, ...ne]); return map }
  gpu()
  const handle = engine.addShapeLayer({
    id: 'zonas', accessors: { ...accessors, radiusOf: d => d.radius ?? assert.fail('boom') },
    data: [{ id: 1, center: [0, 0], radius: 100_000 }],
  })
  await flush()
  engine.camera.fitToLayer('zonas')
  const entregas = entregadas.length
  handle.set([{ id: 2, center: [0, 10] }])

  assert.throws(() => engine.camera.fitToLayer('zonas'), /boom/)
  engine.fitToLayers(['zonas'])
  await flush()
  assert.deepEqual(cajas.at(-1), cajas[0], 'la caja sigue siendo la de la figura anterior')
  assert.equal(entregadas.length, entregas, 'ni el encuadre ni la emisión rehacen la figura')
  engine.destroy()
})
