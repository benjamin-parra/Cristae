// El contrato de la cámara pública (SPECS §9) sobre el Leaflet REAL, con un MapEngine: `x` e `y` iguales
// a los de Leaflet, `visible`, `occluded`, `onSurface`, `incidence`, el portador reusado sin asignar y
// `metersPerPixelAt` contra la cuerda que mide <cristae-scale>, a z12 y z18, donde coinciden.
// Corre con: node --test test/engine/camera-contrato.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { contenedor, prepararDom } from '../../test-helpers/leaflet-real.mjs'
import { bytesPorLlamada } from '../../test-helpers/asignaciones.mjs'

// Calentamiento largo: con la suite en paralelo el compilador tarda en optimizar, y medir antes da falsos rojos.
const CALENTAR = 200_000

prepararDom()
const { default: L }                = await import('leaflet')
const { MapEngine }                 = await import('../../src/engine/MapEngine.js')
const { createLeafletHost }         = await import('../../src/host/LeafletHost.js')
const { distance, byDefault }       = await import('../../src/geometry/geodesic.js')
const { WGS84 }                     = await import('../../src/geometry/ellipsoid.js')

const CENTRO = [-33.45, -70.6]
// Cuerda contra arco en 100 px a z12 da ~5e-9 de error relativo; el resto es redondeo.
const TOL_ESCALA = 1e-7
const ANCHO_BARRA = 100

const montar = async (model, insets) => {
  const host   = createLeafletHost({ container: contenedor(), view: { center: CENTRO, zoom: 5 } })
  const engine = new MapEngine({ host, model, insets })
  await engine.ready
  return { engine, camera: engine.camera, map: host.map }
}

// Va primero: V8 encajona el número leído si antes se llamó con otras formas de punto.
test('con out reusado devuelve el mismo objeto y no asigna', async () => {
  const { engine, camera } = await montar()
  const out   = { x: 0, y: 0, visible: false, occluded: true }
  const punto = [-33.1, -70.2]
  assert.equal(camera.latLngToContainerPoint(punto, out), out)
  const bytes = bytesPorLlamada(() => camera.latLngToContainerPoint(punto, out), 2000, { calentar: CALENTAR })
  assert.ok(bytes < 1, `asignó ${bytes} bytes por llamada`)
  engine.destroy()
})

for (const [nombre, insets] of [['sin insets', undefined], ['con insets', { top: 40, right: 10, bottom: 70, left: 120 }]]) {
  test(`x e y son idénticos a Leaflet en z5, z12 y z18, ${nombre}`, async () => {
    const { engine, camera, map } = await montar(undefined, insets)
    for (const zoom of [5, 12, 18]) {
      camera.setView(CENTRO, zoom)
      const size = map.getSize()
      for (const punto of [CENTRO, [-33.4, -70.5], [-33.5, -70.7], [10, 100], [60, -170]]) {
        const esperado = map.latLngToContainerPoint(L.latLng(punto))
        const p        = camera.latLngToContainerPoint(punto)
        assert.deepEqual(Object.keys(p), ['x', 'y', 'visible', 'occluded'])
        assert.ok(Object.is(p.x, esperado.x) && Object.is(p.y, esperado.y), `${punto} z${zoom}`)
        assert.equal(p.visible, 0 <= p.x && p.x <= size.x && 0 <= p.y && p.y <= size.y)
        assert.equal(p.occluded, false)
        assert.equal(camera.containerPointToLatLng({ x: p.x, y: p.y }).onSurface, true)
      }
      const esquina = camera.latLngToContainerPoint(map.containerPointToLatLng(L.point(size.x, size.y)))
      assert.equal(esquina.occluded, false)
      assert.equal(camera.containerPointToLatLng({ x: size.x, y: size.y }).onSurface, true)
    }
    engine.destroy()
  })
}

test('containerPointToLatLng trae lat, lng, onSurface, incidence y altitude', async () => {
  const { engine, camera } = await montar()
  const r = camera.containerPointToLatLng({ x: 100, y: 80 })
  assert.deepEqual(Object.keys(r), ['lat', 'lng', 'onSurface', 'incidence', 'altitude'])
  assert.equal(r.incidence, 1)
  assert.equal(r.altitude, 0)
  engine.destroy()
})

for (const [nombre, model] of [['la esfera por defecto', byDefault], ['WGS84', WGS84]]) {
  test(`metersPerPixelAt coincide con la cuerda de <cristae-scale> a z12 y z18, con ${nombre}`, async () => {
    const { engine, camera, map } = await montar(model)
    for (const zoom of [12, 18]) {
      camera.setView(CENTRO, zoom)
      const y        = camera.latLngToContainerPoint(camera.getCenter()).y
      const w        = map.getSize().x
      const esperado = distance(model, camera.containerPointToLatLng({ x: 0, y }), camera.containerPointToLatLng({ x: ANCHO_BARRA, y })) / ANCHO_BARRA
      const medio    = camera.containerPointToLatLng({ x: w / 2, y })
      const error    = Math.abs(camera.metersPerPixelAt(medio) / esperado - 1)
      assert.ok(error <= TOL_ESCALA, `z${zoom}: error relativo ${error}`)
    }
    engine.destroy()
  })
}

test('metersPerPixelAt sin argumento es el del centro del contenedor', async () => {
  const { engine, camera, map } = await montar()
  camera.setView(CENTRO, 12)
  const size   = map.getSize()
  const centro = camera.containerPointToLatLng({ x: size.x / 2, y: size.y / 2 })
  assert.equal(camera.metersPerPixelAt(), camera.metersPerPixelAt(centro))
  assert.ok(camera.metersPerPixelAt() > 0)
  engine.destroy()
})

test('lo que no es un punto lanza TypeError', async () => {
  const { engine, camera } = await montar()
  assert.throws(() => camera.metersPerPixelAt(null), TypeError)
  assert.throws(() => camera.metersPerPixelAt(Float64Array.of(-33, -70, 0, -33.1, -70.1)), TypeError)
  assert.throws(() => camera.latLngToContainerPoint(null), TypeError)
  engine.destroy()
})

test('ningún retorno lleva una instancia de Leaflet', async () => {
  const { engine, camera } = await montar()
  const valores = [camera.latLngToContainerPoint(CENTRO), camera.containerPointToLatLng({ x: 50, y: 50 })]
  for (const v of valores) {
    assert.equal(Object.getPrototypeOf(v), Object.prototype)
    assert.ok(!(v instanceof L.Point) && !(v instanceof L.LatLng))
  }
  engine.destroy()
})
