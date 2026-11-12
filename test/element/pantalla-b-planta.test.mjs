// La pantalla (b) de la propuesta en planta, manera HTML: el mismo documento sin `relief` ni `exaggeration`,
// con los elementos en el stub (el prototipo de cada clase sobre un `this` falso, atributos como cadenas), las
// teselas falsas y los predios por url. La capa monta, `clip-to` queda resuelto con el polígono que cargó por
// url, y `measure` sobre la geometría del predio coincide con `relief()` de las mismas teselas.
// Corre con: node --test test/element/pantalla-b-planta.test.mjs
import '../../test-helpers/engine-stub.mjs'
import '../../test-helpers/element-stub.mjs'
import { conGlDeEdicion, makeEditGl, makeLeaflet, makeMap } from '../../test-helpers/engine-stub.mjs'
import { conNavegador, crearNavegador } from '../../test-helpers/navegador-falso.mjs'
import { coleccion, cuadrado, fetchFalso, hasta } from '../../test-helpers/datos-remotos.mjs'
import { latDe, lngDe, mundo } from '../../test-helpers/terreno.mjs'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { CristaeTerrainLayer } from '../../src/element/CristaeTerrainLayer.js'
import { CristaePolygonLayer } from '../../src/element/CristaePolygonLayer.js'
import { MapEngine } from '../../src/engine/MapEngine.js'
import { adoptLeafletHost } from '../../src/host/LeafletHost.js'
import { byDefault } from '../../src/geometry/geodesic.js'
import { boundsOf } from '../../src/geometry/bounds.js'
import { relief, terrain } from '../../src/geometry/terrain.js'

after(conNavegador(crearNavegador({ crearGl: () => makeEditGl() })))
after(conGlDeEdicion(() => makeEditGl()))

// El dem del documento va por JSON, como `dem` por atributo; el de producción es el preset `aws`.
const DEM    = { url: 'https://t.test/{z}/{x}/{y}.png', encoding: 'terrarium', zoom: 14, tileSize: 64 }
const PX     = 4869 * 64 + 20
const PY     = 10007 * 64 + 20
const LAT    = latDe(PY)
const LNG    = lngDe(PX)
const COLINA = (lat, lng) => 500 + 4000 * (lat - LAT) + 3000 * (lng - LNG)
const CORTES = [0.03, 0.05]

const elemento = (Clase, props) => Object.assign(Object.create(Clase.prototype), {
  visible: true, interactive: true, _handle: null, _engine: null,
  _enclosingModifier: () => null, closest: () => null, requestUpdate() {}, dispatchEvent: () => true,
}, props)

test('el documento de la pantalla (b) en planta monta, recorta a los predios y mide como relief()', async () => {
  const map = makeMap({ zoom: 17 })
  map._center = { lat: LAT, lng: LNG }
  const engine  = new MapEngine({ host: adoptLeafletHost(map, { leaflet: makeLeaflet() }) })
  const mosaico = mundo({ h: COLINA, lado: 64 })
  const cargas  = []
  engine.on('dataload', d => cargas.push(d.layerId))

  // Los atributos del documento, como cadenas; el terreno va antes que los predios que lo recortan.
  const relieve = elemento(CristaeTerrainLayer, {
    id: 'relieve', dem: JSON.stringify(DEM), colorBy: 'slope', slopeBreaks: '3% 5%',
    slopeColors: '#a6d96a #fdae61 #d7191c', contours: 10, clipTo: 'predios', fetch: mosaico.fetch,
  })
  const predios = elemento(CristaePolygonLayer, {
    id: 'predios', url: './datos/predios.geojson', fields: { id: 'rol' }, fill: false, color: '#111827', weight: 2,
    fetch: fetchFalso({ './datos/predios.geojson': coleccion([
      cuadrado(LNG - 0.002, LAT - 0.002, 0.004, { rol: '101-1' }),
      cuadrado(LNG + 0.003, LAT - 0.002, 0.003, { rol: '101-2' }),
    ]) }),
  })
  relieve.cristaeMount(engine)
  predios.cristaeMount(engine)
  assert.ok(relieve.controls, 'la capa de terreno monta')
  assert.ok(predios.controls, 'la de predios monta')
  await hasta(() => cargas.includes('predios') && cargas.includes('relieve'))

  assert.equal(engine.getLayer('relieve').terrain.clipSource, predios.controls.source, 'clip-to quedó resuelto con el polígono por url')

  const zona     = predios.controls.geometryOf('101-1')
  const medida   = await relieve.controls.measure(zona)
  const base     = await terrain(byDefault, DEM, boundsOf(zona), { fetch: mundo({ h: COLINA, lado: 64 }).fetch })
  const esperado = relief(base, zona, CORTES)
  assert.ok(esperado.cells > 0, 'el predio cubre celdas del dem')
  assert.deepEqual(medida.slope.areas, esperado.slope.areas)
  assert.ok(medida.slope.areas.reduce((a, b) => a + b, 0) > 0)

  relieve.cristaeUnmount()
  predios.cristaeUnmount()
  engine.destroy()
})
