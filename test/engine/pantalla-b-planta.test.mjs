// La pantalla (b) de la propuesta en planta, manera JS: sin `relief` ni `exaggeration`. Un terreno con pendientes en
// clases, recortado a los predios que carga por url, y al pulsar un predio la cifra sale de `measure` sobre la
// geometría que el handle de los predios entrega: lo medido es lo mismo que `relief()` de las mismas teselas.
// Corre con: node --test test/engine/pantalla-b-planta.test.mjs
import '../../test-helpers/engine-stub.mjs'
import { conGlDeEdicion, makeEditGl, makeLeaflet, makeMap } from '../../test-helpers/engine-stub.mjs'
import { conNavegador, crearNavegador } from '../../test-helpers/navegador-falso.mjs'
import { coleccion, cuadrado, fetchFalso, hasta } from '../../test-helpers/datos-remotos.mjs'
import { latDe, lngDe, mundo } from '../../test-helpers/terreno.mjs'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { MapEngine } from '../../src/engine/MapEngine.js'
import { adoptLeafletHost } from '../../src/host/LeafletHost.js'
import { byDefault } from '../../src/geometry/geodesic.js'
import { boundsOf } from '../../src/geometry/bounds.js'
import { relief, terrain } from '../../src/geometry/terrain.js'

after(conNavegador(crearNavegador({ crearGl: () => makeEditGl() })))
after(conGlDeEdicion(() => makeEditGl()))

const DEM    = { url: 'https://t.test/{z}/{x}/{y}.png', encoding: 'terrarium', zoom: 14, tileSize: 64 }
const PX     = 4869 * 64 + 20
const PY     = 10007 * 64 + 20
const LAT    = latDe(PY)
const LNG    = lngDe(PX)
const COLINA = (lat, lng) => 500 + 4000 * (lat - LAT) + 3000 * (lng - LNG)
const CORTES = [0.03, 0.05]

test('el clic sobre el predio mide con geometryOf(hit.id) y da lo mismo que relief()', async () => {
  const map = makeMap({ zoom: 17 })
  map._center = { lat: LAT, lng: LNG }
  const engine  = new MapEngine({ host: adoptLeafletHost(map, { leaflet: makeLeaflet() }) })
  const mosaico = mundo({ h: COLINA, lado: 64 })
  const cargas  = []
  engine.on('dataload', d => cargas.push(d.layerId))

  // La pantalla: la capa de terreno antes que los predios que la recortan, como en la propuesta.
  const relieve = engine.addTerrainLayer({
    id: 'relieve', dem: DEM, fetch: mosaico.fetch, colorBy: 'slope', slopeBreaks: CORTES,
    slopeColors: ['#a6d96a', '#fdae61', '#d7191c'], contours: 10, clipTo: 'predios',
  })
  const datos = coleccion([
    cuadrado(LNG - 0.002, LAT - 0.002, 0.004, { rol: '101-1' }),
    cuadrado(LNG + 0.003, LAT - 0.002, 0.003, { rol: '101-2' }),
  ])
  const predios = engine.addPolygonLayer({
    id: 'predios', url: './datos/predios.geojson', fields: { id: 'rol' }, interactive: true, fill: false,
    color: '#111827', weight: 2, fetch: fetchFalso({ './datos/predios.geojson': datos }),
  })
  await hasta(() => cargas.includes('predios') && cargas.includes('relieve'))

  assert.equal(engine.getLayer('relieve').terrain.clipSource, predios.source, 'el terreno sigue a los predios que cargó por url')

  // El pase de picking no corre en node: la capa responde al clic con el predio de debajo.
  engine.getLayer('predios').layer.resolveClick = () => [{ ref: '101-1', id: '101-1', distancePx: 0 }]
  let cifra = null
  engine.on('click', 'predios', async ([hit]) => {
    if (!hit) return
    cifra = await relieve.measure(predios.geometryOf(hit.id))
  })
  await new Promise(resolve => setTimeout(resolve, 5))
  map.getContainer().emitir('pointerdown', { clientX: 400, clientY: 300 })
  map.getContainer().emitir('pointerup', { clientX: 400, clientY: 300 })
  await hasta(() => cifra)

  const zona = predios.geometryOf('101-1')
  const base = await terrain(byDefault, DEM, boundsOf(zona), { fetch: mundo({ h: COLINA, lado: 64 }).fetch })
  const esperado = relief(base, zona, CORTES)
  assert.ok(esperado.cells > 0, 'el predio cubre celdas del dem')
  assert.deepEqual(cifra.slope.areas, esperado.slope.areas)
  assert.ok(cifra.slope.areas.reduce((a, b) => a + b, 0) > 0)
  engine.destroy()
})
