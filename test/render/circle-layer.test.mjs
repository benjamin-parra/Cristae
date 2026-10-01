// Contrato de CircleLayer: un círculo en metros se dibuja en la GPU como un anillo cuyos vértices están a
// `radius` metros del centro según la MISMA esfera con la que pica, así que el borde y el hit coinciden
// por construcción a cualquier latitud. Lo que acá se congela: ese vínculo —leído de los texels que
// viajan a la GPU—, la teselación que sigue al zoom, el picking CPU, el estilo propio (color, relleno,
// dash, foco) y que la capa siga a la Source sin tomar otro contexto. Se monta en node contra el harness
// compartido, que sólo dobla el navegador: el árbol de dibujo es el real.
//
// El harness (engine-stub) shimea window/document — se importa PRIMERO.
import '../../test-helpers/engine-stub.mjs'
import { conGlDeEdicion, makeEditGl, makeGlify, makeLeaflet, makeMap, makePickSpy } from '../../test-helpers/engine-stub.mjs'
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { createSource } from '../../src/data/Source.js'
import { MapEngine } from '../../src/engine/MapEngine.js'
import { MEAN_RADIUS, arcMeters } from '../../src/geometry/geodesic.js'
import { adoptLeafletHost } from '../../src/host/LeafletHost.js'
import { CircleLayer } from '../../src/render/CircleLayer.js'
import { projX0, projY0 } from '../../src/render/project.js'

const D = Math.PI / 180

// La Source real emite en rAF (defer:'raf' → setTimeout(0) bajo el shim); un macrotask lo vacía.
const flush = () => new Promise(r => globalThis.setTimeout(r, 0))

const accessors = {
  idOf: d => d.id,
  positionOf: d => ({ lat: d.lat, lng: d.lng }),
  radiusMetersOf: d => d.radius,
  styleOf: d => d.style,
}

/* ── Dobles: un contexto por montaje, con los colores de relleno y de trazo que la capa le pide ── */

let currentGl = null
after(conGlDeEdicion(() => currentGl))

// El relleno fija su color con `uniform4f` y el trazo con `uniform4fv`: quedan separados en `fill` y
// `stroke`, y cada draw agrega el suyo.
const withColors = (gl, log) => new Proxy(gl, {
  get: (t, p) =>
    p === 'uniform4f'  ? (_loc, ...rgba) => log.fill.push(rgba)
  : p === 'uniform4fv' ? (_loc, rgba) => log.stroke.push([...rgba])
  : t[p],
})

const gpu = () => {
  const spy = makePickSpy()
  const log = { fill: [], stroke: [] }
  currentGl = withColors(makeEditGl(spy), log)
  return { spy, log }
}

const mount = async (items, { zoom = 3, source = createSource(accessors), ...options } = {}) => {
  const { spy, log } = gpu()
  const map = makeMap({ zoom })
  source.set(items)
  await flush()
  const layer = new CircleLayer({ host: adoptLeafletHost(map), pane: 'p', source, interactive: true, ...options })
  return { layer, map, source, spy, log }
}

// Los vértices del anillo subido a la GPU —sin el que repite al primero, que el store descarta—, en
// world0 px, de la última textura de posiciones. Cada texel es relativo al ancla del anillo, que no se
// expone: se recupera de que el vértice 0 es el del norte, cuya latitud es exacta (`lat + radius/R`) y
// cuya longitud es la del centro. El relleno de ceros del final de la textura no cuenta.
const ringOf = (spy, { lat, lng, radius }) => {
  const texels   = spy.texels.at(-1)
  const north    = lat + radius / MEAN_RADIUS / D
  const [ax, ay] = [projX0(lng) - texels[0], projY0(north) - texels[1]]
  let n = texels.length / 2
  while (n > 0 && texels[n * 2 - 2] === 0 && texels[n * 2 - 1] === 0) n--
  return Array.from({ length: n }, (_, i) => [ax + texels[i * 2], ay + texels[i * 2 + 1]])
}

// La inversa de la proyección del mapa: world0 px → [lat, lng].
const unproject = ([x, y]) => [
  (2 * Math.atan(Math.exp(Math.PI - 2 * Math.PI * y / 256)) - Math.PI / 2) / D,
  (x / 256 - 0.5) * 360,
]

const metersToCenter = (p, { lat, lng }) => arcMeters(...unproject(p), lat, lng)

/* ── El borde dibujado y el hit son la misma curva ── */

// Cada vértice del anillo está a `radius` metros del centro medido con `arcMeters`, que es la regla del
// pick: el borde dibujado es la frontera del hit. La tolerancia es la del float32 de la textura, no la de
// la teselación: los vértices están EN el círculo, y la cuerda sólo se aparta entre ellos.
for (const [lat, lng, radius] of [
  [0, 0, 1000], [-33.4489, -70.6693, 1000], [60, 25, 50_000], [80, 10, 100_000], [45, 8, 500_000], [10, 179.95, 20_000],
]) {
  test(`los vértices del anillo están a radius metros del centro: lat ${lat}, ${radius} m`, async () => {
    const { layer, spy } = await mount([{ id: 1, lat, lng, radius }])
    const ring = ringOf(spy, { lat, lng, radius })

    assert.ok(ring.length >= 16, 'el anillo trae sus vértices')
    ring.forEach((p, i) => {
      const meters = metersToCenter(p, { lat, lng })
      assert.ok(Math.abs(meters - radius) / radius < 1e-6, `vértice ${i} a ${meters} m del centro`)
    })

    // Y el pick traza la misma frontera: un milésimo adentro del radio, al norte y al sur, pica; afuera, no.
    const dLat  = radius / MEAN_RADIUS / D
    const picks = k => layer.resolveClick({ lat: lat + dLat * k, lng }).length
    assert.deepEqual([picks(0.999), picks(-0.999), picks(1.001), picks(-1.001)], [1, 1, 0, 0])
    layer.destroy()
  })
}

/* ── Teselación que sigue al zoom ── */

test('un círculo grande en pantalla usa más segmentos, con tope; uno diminuto, el mínimo', async () => {
  const c = { id: 1, lat: 0, lng: 0, radius: 1000 }
  const montajes = [[3, c, 16], [18, c, 256], [22, { ...c, radius: 100_000 }, 4096]]
  for (const [zoom, item, vertices] of montajes) {
    const { layer, spy } = await mount([item], { zoom })
    assert.equal(ringOf(spy, item).length, vertices, `zoom ${zoom}`)
    layer.destroy()
  }
})

test('al asentar el zoom re-tesela sólo si cambia el número de segmentos', async () => {
  const c = { id: 1, lat: 0, lng: 0, radius: 1000 }
  const { layer, map, spy } = await mount([c], { zoom: 3 })
  const base = spy.texImages.length

  map.setZoomForTest(4).fire('zoomend')
  assert.equal(spy.texImages.length, base, 'otro zoom con los mismos segmentos no sube nada')

  map.setZoomForTest(18).fire('zoomend')
  assert.equal(spy.texImages.length, base + 1, 'otro número de segmentos sube el anillo nuevo')
  assert.equal(ringOf(spy, c).length, 256)

  map.setZoomForTest(18).fire('zoomend')
  assert.equal(spy.texImages.length, base + 1, 'y repetir el mismo zoom no lo vuelve a subir')
  layer.destroy()
})

/* ── Picking ── */

test('un latlng DENTRO del radio pica; uno FUERA no', async () => {
  const { layer } = await mount([{ id: 1, lat: 0, lng: 0, radius: 100000 }])

  const dentro = layer.resolveClick({ lat: 0.5, lng: 0.5 })    // ≈ 78 km del centro
  assert.deepEqual(dentro, [{ ref: 1, id: 1, distancePx: 0 }])
  assert.deepEqual(layer.resolveHover({ lat: 0.5, lng: 0.5 }), dentro, 'hover y click contestan igual')
  assert.deepEqual(layer.resolveClick({ lat: 2, lng: 2 }), [], '≈ 314 km: fuera')
  layer.destroy()
})

test('sin `interactive` la capa dibuja y no pica', async () => {
  const { layer } = await mount([{ id: 1, lat: 0, lng: 0, radius: 100000 }], { interactive: false })
  assert.deepEqual(layer.resolveClick({ lat: 0, lng: 0 }), [])
  layer.destroy()
})

// El latlng del puntero llega sin envolver (lng 289 sobre la copia de al lado) y el círculo se dibuja
// una sola vez, en la copia de su centro: la distancia es periódica, el dibujo no.
test('sólo pica en la copia del mundo donde el círculo está dibujado', async () => {
  const { layer } = await mount([
    { id: 'A', lat: -33.45, lng: -70.66, radius: 5000 },
    { id: 'B', lat: 0, lng: 179.99, radius: 10000 },     // el anillo sigue pasado el 180
  ])
  const picks = (lat, lng) => layer.resolveClick({ lat, lng }).map(h => h.id).join()

  assert.equal(picks(-33.45, -70.66), 'A')
  assert.equal(picks(-33.45, -70.66 + 360), '', 'la copia de la derecha no tiene círculo')
  assert.equal(picks(-33.45, -70.66 - 360), '', 'la de la izquierda tampoco')
  assert.equal(picks(0, 180.05), 'B', 'pasado el 180, en la misma copia, sí')
  assert.equal(picks(0, -179.95), '', 'en el borde opuesto del mundo no')
  layer.destroy()
})

test('un círculo de centro o radio no finitos, o que abarca un polo, ni se dibuja ni pica', async () => {
  const { layer } = await mount([
    { id: 'nan', lat: NaN, lng: 0, radius: 1000 },
    { id: 'cero', lat: 0, lng: 0, radius: 0 },
    { id: 'polo', lat: 89.9, lng: 0, radius: 50_000 },
    { id: 'ok', lat: 10, lng: 10, radius: 1000 },
  ])
  assert.deepEqual(layer.resolveClick({ lat: 89.9, lng: 0 }), [], 'el del polo no pica')
  assert.deepEqual(layer.resolveClick({ lat: 0, lng: 0 }), [])
  assert.deepEqual(layer.resolveClick({ lat: 10, lng: 10 }).map(h => h.id), ['ok'], 'y el válido sigue ahí')
  layer.destroy()
})

/* ── La capa sigue a la Source ── */

test('un patch de radio rehace el anillo y el hit; un move los lleva al centro nuevo', async () => {
  const { layer, source, spy } = await mount([{ id: 1, lat: 0, lng: 0, radius: 1000 }])

  source.getSnapshot()[0].radius = 200_000
  source.patch(source.getSnapshot(), new Set([1]))
  await flush()
  const ring = ringOf(spy, { lat: 0, lng: 0, radius: 200_000 })
  assert.ok(Math.abs(metersToCenter(ring[3], { lat: 0, lng: 0 }) - 200_000) < 0.2, 'el anillo nuevo está al radio nuevo')
  assert.equal(layer.resolveClick({ lat: 1, lng: 0 }).length, 1, '111 km: dentro del radio nuevo')

  source.move(1, 5, 5)
  await flush()
  assert.deepEqual(layer.resolveClick({ lat: 5, lng: 5 }).map(h => h.id), [1], 'el hit sigue al centro movido')
  assert.deepEqual(layer.resolveClick({ lat: 0, lng: 0 }), [], 'y el centro viejo quedó vacío')
  const moved = ringOf(spy, { lat: 5, lng: 5, radius: 200_000 })
  assert.ok(Math.abs(metersToCenter(moved[3], { lat: 5, lng: 5 }) - 200_000) < 0.2, 'y el anillo, alrededor de él')
  layer.destroy()
})

test('un ítem que pasa a no-finito deja de pintarse y de picar; el resto no se toca', async () => {
  const { layer, source } = await mount([{ id: 1, lat: 0, lng: 0, radius: 1000 }, { id: 2, lat: 10, lng: 10, radius: 1000 }])

  source.getSnapshot().find(d => d.id === 1).lat = NaN
  source.patch(source.getSnapshot(), new Set([1]))
  await flush()

  assert.deepEqual(layer.resolveClick({ lat: 0, lng: 0 }), [])
  assert.deepEqual(layer.resolveClick({ lat: 10, lng: 10 }).map(h => h.id), [2])
  layer.destroy()
})

test('las altas y bajas del set de la Source llegan al anillo y al hit', async () => {
  const { layer, source } = await mount([{ id: 1, lat: 0, lng: 0, radius: 1000 }])
  source.set([{ id: 1, lat: 0, lng: 0, radius: 1000 }, { id: 2, lat: 20, lng: 20, radius: 1000 }])
  await flush()
  assert.deepEqual(layer.resolveClick({ lat: 20, lng: 20 }).map(h => h.id), [2])

  source.set([{ id: 2, lat: 20, lng: 20, radius: 1000 }])
  await flush()
  assert.deepEqual(layer.resolveClick({ lat: 0, lng: 0 }), [], 'la baja ya no pica')
  layer.destroy()
})

/* ── Estilo propio ── */

test('el color de styleOf pinta el trazo y, sin fillColor, el relleno con la opacidad por defecto', async () => {
  const { layer, log } = await mount([{ id: 1, lat: 0, lng: 0, radius: 1000, style: { color: '#ff0000' } }])

  assert.deepEqual(log.stroke.at(-1), [1, 0, 0, 1], 'trazo rojo opaco')
  assert.deepEqual(log.fill.at(-1), [1, 0, 0, 0.2], 'el relleno sigue al color, con fillOpacity 0,2')
  layer.destroy()
})

test('fillColor y fillOpacity del estilo mandan sobre el relleno, sin tocar el trazo', async () => {
  const style = { color: '#ff0000', fillColor: '#00ff00', fillOpacity: 0.5, opacity: 0.8 }
  const { layer, log } = await mount([{ id: 1, lat: 0, lng: 0, radius: 1000, style }])

  assert.deepEqual(log.fill.at(-1), [0, 1, 0, 0.5])
  assert.deepEqual(log.stroke.at(-1), [1, 0, 0, 0.8])
  layer.destroy()
})

test('un dash en el estilo sube la textura del patrón; sin dash no se sube', async () => {
  const sin = await mount([{ id: 1, lat: 0, lng: 0, radius: 1000 }])
  const con = await mount([{ id: 1, lat: 0, lng: 0, radius: 1000, style: { dash: [6, 4] } }])

  assert.equal(sin.spy.texImages.length, 1, 'sólo las posiciones')
  assert.equal(con.spy.texImages.length, 2, 'las posiciones y el largo acumulado del patrón')
  ;[sin, con].forEach(m => m.layer.destroy())
})

test('un styleOf que reusa su objeto no pinta todos los círculos con el último estilo', async () => {
  const scratch = {}
  const source  = createSource({ ...accessors, styleOf: d => Object.assign(scratch, d.style) })
  const { layer, log } = await mount([
    { id: 1, lat: 0, lng: 0, radius: 1000, style: { color: '#ff0000' } },
    { id: 2, lat: 10, lng: 10, radius: 1000, style: { color: '#0000ff' } },
  ], { source })
  log.stroke.length = 0
  layer.applyFocus(null)
  assert.deepEqual(log.stroke.map(c => c.slice(0, 3)), [[1, 0, 0], [0, 0, 1]])
  layer.destroy()
})

// Un círculo con un patrón que no cabe no deja la capa a medias: los de después no heredan el estilo
// de otro, y la geometría y el picking siguen siendo los de antes.
test('un círculo con un patrón que no cabe deja la capa como estaba', async t => {
  const errores  = []
  const original = console.error
  console.error = (...a) => errores.push(a)
  t.after(() => (console.error = original))
  const rojo = { id: 1, lat: 0, lng: 0, radius: 1000, style: { color: '#ff0000' } }
  const azul = { id: 3, lat: 10, lng: 10, radius: 1000, style: { color: '#0000ff' } }
  const { layer, source, log } = await mount([rojo, azul])

  source.set([rojo, { id: 2, lat: 5, lng: 5, radius: 1000, style: { dash: Array(17).fill(1) } }, { ...azul, style: { color: '#00ff00' } }])
  await flush()
  assert.match(String(errores[0]?.[1]), /hasta 16 valores/)
  log.stroke.length = 0
  layer.applyFocus(null)
  assert.deepEqual(log.stroke.map(c => c.slice(0, 3)), [[1, 0, 0], [0, 0, 1]], 'los dos de antes, cada uno con su color')
  assert.deepEqual(layer.resolveClick({ lat: 5, lng: 5 }), [], 'el que no entró no pica')
  layer.destroy()
})

test('el foco atenúa por círculo, devuelve true y se levanta con null', async () => {
  const { layer, log } = await mount([{ id: 1, lat: 0, lng: 0, radius: 1000 }, { id: 2, lat: 10, lng: 10, radius: 1000 }])
  const reset = () => { log.fill.length = log.stroke.length = 0 }
  reset()

  assert.equal(layer.applyFocus(new Set([1]), 0.25), true)
  assert.deepEqual(log.stroke.map(c => c[3]), [1, 0.25], 'el enfocado pleno, el otro por dim')
  assert.deepEqual(log.fill.map(c => c[3]), [0.2, 0.05])

  reset()
  layer.applyFocus(null)
  assert.deepEqual(log.stroke.map(c => c[3]), [1, 1], 'sin ids, todos plenos')
  layer.destroy()
})

test('refresh() reevalúa styleOf', async () => {
  const items = [{ id: 1, lat: 0, lng: 0, radius: 1000, style: { color: '#ff0000' } }]
  const { layer, log } = await mount(items)

  items[0].style = { color: '#0000ff' }
  layer.refresh()
  assert.deepEqual(log.stroke.at(-1), [0, 0, 1, 1])
  layer.destroy()
})

/* ── Ciclo de vida ── */

test('oculta no repinta, visible sí; destroy deja la capa inerte', async () => {
  const { layer, spy } = await mount([{ id: 1, lat: 0, lng: 0, radius: 1000 }])
  const draws = () => spy.draws.length
  const antes = draws()

  layer.setVisible(false)
  layer.refresh()
  assert.equal(draws(), antes, 'oculta no emite draws, ni al refrescarse')
  layer.setVisible(true)
  assert.ok(draws() > antes, 'al volver a mostrarse, repinta')

  layer.destroy()
  layer.refresh()
  layer.setVisible(true)
  assert.equal(layer.applyFocus(null), true, 'el motor la invoca aun tras la baja')
  assert.deepEqual(layer.resolveClick({ lat: 0, lng: 0 }), [], 'y no pica')
})

test('desde el motor: la visibilidad de la capa llega al dibujo y la baja libera el contexto', async () => {
  const engine = new MapEngine({ host: adoptLeafletHost(makeMap(), { leaflet: makeLeaflet() }), glify: makeGlify() })
  const { spy } = gpu()
  const handle = engine.addCircleLayer({ id: 'radios', accessors, data: [{ id: 1, lat: 0, lng: 0, radius: 100000 }] })
  await flush()
  const draws = () => spy.draws.length
  const antes = draws()

  handle.setVisible(false)
  handle.set([{ id: 1, lat: 1, lng: 1, radius: 100000 }])
  await flush()
  assert.equal(draws(), antes, 'una capa oculta por el motor no repinta')
  handle.setVisible(true)
  assert.ok(draws() > antes, 'y al mostrarla vuelve a dibujar')

  engine.removeLayer('radios')
})
