// `addCircleLayer` es un alias de la capa de formas que se retira en 1.0. Lo que acá se congela es lo que el
// alias conserva para quien no lo migra: su kind, su pane y su handle, el orden de los hits, el radio que lee
// de `radiusMetersOf` también desde una Source externa, que ignora el rumbo, la apertura y el estilo de capa,
// y que dibuja y pica sobre la esfera por defecto aunque el mapa traiga otro modelo, con su anillo bit a bit.
// El anillo de referencia sale de la fórmula cerrada del destino sobre la esfera, no del código de la capa.
//
// El harness (engine-stub) shimea window/document — se importa PRIMERO.
import '../../test-helpers/engine-stub.mjs'
import { conGlDeEdicion, makeEditGl, makeLeaflet, makeMap, makePickSpy } from '../../test-helpers/engine-stub.mjs'
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { createSource } from '../../src/data/Source.js'
import { MapEngine } from '../../src/engine/MapEngine.js'
import { MEAN_RADIUS } from '../../src/geometry/geodesic.js'
import { WGS84 } from '../../src/geometry/ellipsoid.js'
import { adoptLeafletHost } from '../../src/host/LeafletHost.js'
import { LayerRegistry } from '../../src/interaction/LayerRegistry.js'
import { PolygonGpuLayer } from '../../src/render/PolygonGpuLayer.js'

const D = Math.PI / 180

const flush = () => new Promise(r => globalThis.setTimeout(r, 0))

const alias = {
  idOf           : d => d.id,
  positionOf     : d => ({ lat: d.center[0], lng: d.center[1] }),
  radiusMetersOf : d => d.radius,
}
const forma = { idOf: alias.idOf, positionOf: alias.positionOf, radiusOf: alias.radiusMetersOf }

/* ── Dobles: el trazo de cada capa, y las tablas que la capa le entrega a la capa interna ── */

let currentGl = null
after(conGlDeEdicion(() => currentGl))

const gpu = () => {
  const stroke = []
  currentGl = new Proxy(makeEditGl(makePickSpy()), {
    get: (t, p) => (p === 'uniform4fv' ? (_loc, rgba) => stroke.push([...rgba]) : t[p]),
  })
  return stroke
}

const entregadas  = []
const setGeometry = PolygonGpuLayer.prototype.setGeometry
PolygonGpuLayer.prototype.setGeometry = function (geometry, ...rest) {
  entregadas.push(geometry)
  return setGeometry.call(this, geometry, ...rest)
}
after(() => { PolygonGpuLayer.prototype.setGeometry = setGeometry })

const motor = ({ zoom, model } = {}) =>
  new MapEngine({ host: adoptLeafletHost(makeMap({ zoom }), { leaflet: makeLeaflet() }), model })

// Los resolvers que el motor registra, por capa: de ahí salen el kind del hit y sus partes.
const conResolvers = t => {
  const resolvers = new Map()
  const upsert    = LayerRegistry.prototype.upsertResolver
  LayerRegistry.prototype.upsertResolver = function (entry) {
    resolvers.set(entry.layerId, entry)
    return upsert.call(this, entry)
  }
  t.after(() => { LayerRegistry.prototype.upsertResolver = upsert })
  return resolvers
}

/* ── Lo que el alias conserva ── */

test('el alias conserva su kind, su pane, su hit y su handle sin `style`', async t => {
  const resolvers = conResolvers(t)
  const map       = makeMap()
  const engine    = new MapEngine({ host: adoptLeafletHost(map, { leaflet: makeLeaflet() }) })
  gpu()
  const handle = engine.addCircleLayer({ id: 'radios', accessors: alias, data: [{ id: 7, center: [0, 0], radius: 50_000 }] })
  await flush()

  assert.deepEqual(Object.keys(handle).sort(), ['id', 'set', 'setVisible', 'source'])
  assert.equal(engine.getLayer('radios').kind, 'circle')
  assert.equal(engine.getLayer('radios').interactive, true, 'interactiva por defecto')
  assert.ok(map.getPane('cristae-circle-radios'), 'pane cristae-circle-<id>')
  assert.equal(resolvers.get('radios').kind, 'circle', 'y el hit lleva kind circle')
  assert.deepEqual(resolvers.get('radios').resolveClick({ lat: 0, lng: 0 }), [{ ref: 7, id: 7, distancePx: 0 }])
  engine.destroy()
})

test('los hits del alias salen en el orden de data y los de la capa de formas, de arriba hacia abajo', async t => {
  const resolvers = conResolvers(t)
  const engine    = motor()
  const items     = [{ id: 'a', center: [0, 0], radius: 5000 }, { id: 'b', center: [0, 0.001], radius: 5000 }]
  gpu()
  engine.addCircleLayer({ id: 'radios', accessors: alias, data: items })
  gpu()
  engine.addShapeLayer({ id: 'zonas', accessors: forma, data: items })
  await flush()

  const pica = id => resolvers.get(id).resolveClick({ lat: 0, lng: 0.0005 }).map(h => h.id)
  assert.deepEqual(pica('radios'), ['a', 'b'])
  assert.deepEqual(pica('zonas'), ['b', 'a'])
  engine.destroy()
})

// `radiusMetersOf` se lee de los accessors de la Source, también la que trae el consumidor. Un par de semiejes,
// que la capa de formas leería como elipse, se descarta; y el rumbo, la apertura y el estilo de capa no
// existen en el alias.
test('el alias lee radiusMetersOf de una Source externa, sólo si es un número, e ignora rumbo, apertura y estilo de capa', async () => {
  const source = createSource({ ...alias, headingOf: () => 90, sweepOf: () => 10 })
  source.set([
    { id: 'circulo', center: [0, 0], radius: 100_000 },
    { id: 'par', center: [20, 20], radius: [100_000, 30_000] },
  ])
  await flush()
  const engine = motor()
  const stroke = gpu()
  engine.addCircleLayer({ id: 'radios', source, color: '#ff0000', fill: false })
  await flush()

  const { layer } = engine.getLayer('radios')
  assert.deepEqual(layer.resolveClick({ lat: 0, lng: 0 }).map(h => h.id), ['circulo'])
  assert.deepEqual(layer.resolveClick({ lat: 0, lng: -0.5 }).map(h => h.id), ['circulo'], 'sin apertura: también al oeste del rumbo')
  assert.deepEqual(layer.resolveClick({ lat: 20, lng: 20 }), [], 'el par no se dibuja ni pica')
  assert.equal(entregadas.at(-1).ringCount, 1)
  stroke.length = 0
  layer.applyFocus(null)
  assert.equal(stroke.length, 1, 'un solo trazo: el círculo del par no se dibuja')
  assert.notDeepEqual(stroke[0].slice(0, 3), [1, 0, 0], 'el `color` de la opción no llega al alias')
  engine.destroy()
})

/* ── La esfera por defecto, aunque el mapa traiga otro modelo ── */

// El destino directo sobre la esfera por defecto, como fórmula cerrada: `n` vértices desde el norte al rumbo
// `i·2π/n`, como `[lng, lat, …]` y cerrado repitiendo el primero.
const anilloDeLaEsfera = (lat, lng, radius, n) => {
  const sinLat = Math.sin(lat * D), cosLat = Math.cos(lat * D)
  const sinD   = Math.sin(radius / MEAN_RADIUS), cosD = Math.cos(radius / MEAN_RADIUS)
  return Array.from({ length: n + 1 }, (_, i) => {
    const bearing = i % n * 2 * Math.PI / n
    const sinOut  = sinLat * cosD + cosLat * sinD * Math.cos(bearing)
    return [lng + Math.atan2(Math.sin(bearing) * sinD * cosLat, cosD - sinLat * sinOut) / D, Math.asin(sinOut) / D]
  }).flat()
}

// Con el mapa en WGS84 el anillo del alias es, bit a bit, el de la esfera, y el de la capa de formas no.
test('con el mapa en WGS84 el anillo del alias es bit a bit el de la esfera y el de la capa de formas no', async () => {
  let comparados = 0
  for (const [lat, lng, radius] of [[-33.4489, -70.6693, 500], [60, 25, 50_000], [-80, 10, 20_000], [10, 179.95, 800]])
    for (const zoom of [3, 15, 19]) {
      const engine = motor({ zoom, model: WGS84 })
      const item   = { id: 1, center: [lat, lng], radius }
      gpu()
      engine.addCircleLayer({ id: 'radios', accessors: alias, data: [item] })
      await flush()
      const circulo = entregadas.at(-1)
      gpu()
      engine.addShapeLayer({ id: 'zonas', accessors: forma, data: [item] })
      await flush()
      const formas = entregadas.at(-1)

      const n = circulo.vertexAt[1] - 1
      assert.deepEqual(Array.from(circulo.xy), anilloDeLaEsfera(lat, lng, radius, n), `${radius} m en (${lat}, ${lng}), zoom ${zoom}`)
      assert.notDeepEqual(Array.from(formas.xy), Array.from(circulo.xy), 'la capa de formas sí usa el modelo del mapa')
      comparados++
      engine.destroy()
    }
  assert.equal(comparados, 12)
})
