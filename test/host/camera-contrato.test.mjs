// El contrato agnóstico de la faceta camera del anfitrión (SPECS §9), sobre el Leaflet REAL en jsdom:
// `toScreen` idéntico bit a bit a `latLngToContainerPoint` y sin asignar, `surfaceAt` y
// `metersPerPixelAt`. Son también los tests de contrato de los privados de Leaflet que lee el anfitrión.
// Corre con: node --test test/host/camera-contrato.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { contenedor, prepararDom } from '../../test-helpers/leaflet-real.mjs'
import { bytesPorLlamada } from '../../test-helpers/asignaciones.mjs'

// Calentamiento largo: con la suite en paralelo el compilador tarda en optimizar, y medir antes da falsos rojos.
const CALENTAR = 200_000

prepararDom()
const { default: L }                          = await import('leaflet')
const { createLeafletHost, adoptLeafletHost } = await import('../../src/host/LeafletHost.js')
const { sphere }                              = await import('../../src/geometry/geodesic.js')

const TOL_CERRADA = 1e-12
// Con otro CRS los px salen de restar dos proyecciones a 1e-5 grados: el redondeo de esas coordenadas
// (~1e-13 sobre ~0,01 px) deja el cociente en unas partes en 1e9.
const TOL_PROYECTADA = 1e-8

const LATS  = [-95, -85.06, -60, -33.45, 0, 33, 60, 85, 95]
const LNGS  = [-540, -180, -70.6, 0, 179.99, 190]
const ZOOMS = [0, 2.5, 5, 12, 18]

const nuevo = () => {
  const host = createLeafletHost({ container: contenedor(), view: { center: [-33.45, -70.6], zoom: 5 } })
  return { host, camera: host.camera, map: host.map }
}
const salida = () => ({ x: 0, y: 0, visible: false, occluded: true })

// Va primero: V8 mide la forma de los argumentos con que se llamó a `toScreen`, y los tests siguientes lo
// llaman con todas las formas de punto, que sí encajonan el número leído.
test('toScreen con out reusado no asigna', () => {
  const { host, camera, map } = nuevo()
  map.panBy([5, 9], { animate: false })
  const out = salida()
  const p   = [-33.1, -70.2]
  const bytes = bytesPorLlamada(() => camera.toScreen(p, out), 2000, { calentar: CALENTAR })
  assert.ok(bytes < 1, `asignó ${bytes} bytes por llamada`)
  host.destroy()
})

test('toScreen da x e y idénticos bit a bit a latLngToContainerPoint, con la vista movida', () => {
  const { host, camera, map } = nuevo()
  const out = salida()
  for (const zoom of ZOOMS) {
    map.setView([-33.45, -70.6], zoom, { animate: false })
    map.panBy([37, -121], { animate: false })
    for (const lat of LATS) for (const lng of LNGS) {
      const esperado = map.latLngToContainerPoint(L.latLng(lat, lng))
      camera.toScreen([lat, lng], out)
      assert.ok(Object.is(out.x, esperado.x), `x en ${lat},${lng} z${zoom}: ${out.x} y no ${esperado.x}`)
      assert.ok(Object.is(out.y, esperado.y), `y en ${lat},${lng} z${zoom}: ${out.y} y no ${esperado.y}`)
    }
  }
  host.destroy()
})

test('las formas de punto dan lo mismo', () => {
  const { host, camera, map } = nuevo()
  map.panBy([10, 20], { animate: false })
  const esperado = map.latLngToContainerPoint(L.latLng(-20.5, -69.25))
  const formas   = [[-20.5, -69.25], { lat: -20.5, lng: -69.25 }, { lat: -20.5, lon: -69.25 },
    { latitude: -20.5, longitude: -69.25 }, new Float64Array([-20.5, -69.25, 100])]
  for (const forma of formas) {
    const out = camera.toScreen(forma, salida())
    assert.ok(Object.is(out.x, esperado.x) && Object.is(out.y, esperado.y), JSON.stringify(forma))
  }
  host.destroy()
})

test('visible es la prueba del rectángulo, bordes incluidos, y occluded es siempre false', () => {
  const { host, camera, map } = nuevo()
  const { x: w, y: h } = map.getSize()
  const out = salida()
  const centro = map.getCenter()
  const bajo = (px, py) => camera.surfaceAt({ x: px, y: py })
  for (const [px, py, visible] of [[0, 0, true], [w, h, true], [w, 0, true], [0, h, true], [w + 1, 10, false], [10, -1, false], [400, 300, true]]) {
    const { lat, lng } = bajo(px, py)
    camera.toScreen([lat, lng], out)
    assert.equal(out.visible, 0 <= out.x && out.x <= w && 0 <= out.y && out.y <= h)
    assert.equal(out.visible, visible, `en ${px},${py}`)
    assert.equal(out.occluded, false)
  }
  assert.ok(centro)
  host.destroy()
})

test('un mapa adoptado con EPSG:4326 da lo mismo que su latLngToContainerPoint', () => {
  const map = L.map(contenedor(), { crs: L.CRS.EPSG4326 }).setView([-33.45, -70.6], 4, { animate: false })
  const host = adoptLeafletHost(map)
  const out  = salida()
  for (const lat of [-60, 0, 33, 80]) for (const lng of [-170, -70.6, 0, 120]) {
    const esperado = map.latLngToContainerPoint(L.latLng(lat, lng))
    host.camera.toScreen({ lat, lng }, out)
    assert.ok(Object.is(out.x, esperado.x) && Object.is(out.y, esperado.y), `${lat},${lng}`)
    assert.equal(out.occluded, false)
  }
  host.destroy()
})

test('surfaceAt da lo de containerPointToLatLng, está en la superficie y escribe en out', () => {
  const { host, camera, map } = nuevo()
  map.panBy([14, -3], { animate: false })
  const out = { lat: 0, lng: 0, onSurface: false, altitude: 9 }
  const r   = camera.surfaceAt({ x: 123, y: 456 }, out)
  const esperado = map.containerPointToLatLng(L.point(123, 456))
  assert.equal(r, out)
  assert.equal(out.lat, esperado.lat)
  assert.equal(out.lng, esperado.lng)
  assert.equal(out.onSurface, true)
  assert.equal(out.altitude, 0)
  assert.deepEqual(Object.keys(camera.surfaceAt({ x: 1, y: 1 })).sort(), ['altitude', 'incidence', 'lat', 'lng', 'onSurface'])
  host.destroy()
})

test('metersPerPixelAt coincide con la fórmula cerrada de la esfera', () => {
  const { host, camera, map } = nuevo()
  const R = 6371008.8
  const model = sphere(R)
  for (const pedido of ZOOMS) {
    map.setView([0, 0], pedido, { animate: false })
    for (const lat of [-80, -33.45, 0, 45, 85]) {
      // Con zoomSnap, el zoom que queda no es el pedido.
      const zoom = map.getZoom()
      const cerrada = R * Math.cos(lat * Math.PI / 180) * 2 * Math.PI / (256 * 2 ** zoom)
      const medida  = camera.metersPerPixelAt(lat, -70.6, model)
      assert.ok(Math.abs(medida - cerrada) / cerrada <= TOL_CERRADA, `lat ${lat} z${zoom}: ${medida} y no ${cerrada}`)
    }
  }
  host.destroy()
})

test('metersPerPixelAt con otro CRS mide los px de map.project', () => {
  const map = L.map(contenedor(), { crs: L.CRS.EPSG4326 }).setView([0, 0], 3, { animate: false })
  const host = adoptLeafletHost(map)
  const model = sphere(6371008.8)
  // EPSG:4326 (la transformación de Leaflet es 1/180): 256·2^z / 180 px por grado de longitud.
  const porGrado = 256 * 2 ** 3 / 180
  const esperado = 6371008.8 * Math.cos(40 * Math.PI / 180) * Math.PI / 180 / porGrado
  const medida   = host.camera.metersPerPixelAt(40, 10, model)
  assert.ok(Math.abs(medida - esperado) / esperado <= TOL_PROYECTADA, `${medida} y no ${esperado}`)
  host.destroy()
})

test('los privados de Leaflet que lee la faceta existen', () => {
  const { host, map } = nuevo()
  assert.ok(map._pixelOrigin && typeof map._pixelOrigin.x === 'number', '_pixelOrigin')
  assert.equal(typeof map._getMapPanePos, 'function')
  assert.ok(map._size && typeof map._size.x === 'number', '_size')
  assert.ok('_sizeChanged' in map, '_sizeChanged')
  assert.ok(L.Projection.SphericalMercator.R > 0 && L.Projection.SphericalMercator.MAX_LATITUDE > 0)
  host.destroy()
})

test('lo que no tiene forma de punto lanza TypeError y una latitud NaN lanza como Leaflet', () => {
  const { host, camera } = nuevo()
  for (const malo of [null, undefined, new Float64Array(4)]) {
    assert.throws(() => camera.toScreen(malo, salida()), TypeError)
  }
  assert.throws(() => camera.toScreen([NaN, 0], salida()), /Invalid LatLng/)
  assert.throws(() => camera.toScreen({ lat: 1 }, salida()), /Invalid LatLng/)
  host.destroy()
})
