// La cámara pública (SPECS §9) contra vistas inyectadas sin GL ni Leaflet: la plana, la inclinada a 45° y la
// esférica a z3, con la misma secuencia de llamadas sobre cada una.
// Corre con: node --test test/engine/camara-vistas.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { Camera } from '../../src/engine/Camera.js'
import { planeView, globeView, screenOf } from '../../src/camera/views.js'
import { viewFacet } from '../../src/camera/facet.js'
import { toUnitSphere } from '../../src/camera/geodesy.js'
import { sphere } from '../../src/geometry/geodesic.js'

const TOL_ESCALA_LOCAL = 1e-9
const TOL_IDA_VUELTA   = 1e-6
const TOL_FINITO       = 1e-9

const R      = 6371008.8
const DEG    = Math.PI / 180
const SIZE   = { x: 800, y: 600 }
const CENTRO = [-37.47, -72.35]
const ZOOM   = 3
const WORLD0 = 256
const FOCAL  = 900                       // 1,5 veces el alto, la de las vistas (views.js)
const KEYS   = ['x', 'y', 'visible', 'occluded']
const KEYS_SUELO = ['lat', 'lng', 'onSurface', 'incidence', 'altitude']

// Dos puntos visibles fuera del centro, uno fuera del rectángulo sin estar tapado, y los tapados del globo.
const FUERA_CENTRO = [[-36.0, -73.5], [-39.0, -70.5]]
const FUERA_RECT   = [-37.47, -72.35 + 90]
const A_100_GRADOS = [CENTRO[0] + 100, CENTRO[1]]
const ANTIPODA     = [-CENTRO[0], CENTRO[1] + 180]

const angulo = (a, b) => {
  const u = toUnitSphere(a[0], a[1], new Float64Array(3)), v = toUnitSphere(b[0], b[1], new Float64Array(3))
  const c = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
  return Math.atan2(Math.sqrt(c[0] ** 2 + c[1] ** 2 + c[2] ** 2), u[0] * v[0] + u[1] * v[1] + u[2] * v[2])
}

const camaraDe = view => new Camera({ host: { camera: viewFacet(view) }, model: () => sphere(R) })

const arg = { center: { lat: CENTRO[0], lng: CENTRO[1] }, zoom: ZOOM, size: SIZE }
const mercatorCentro = R * Math.cos(CENTRO[0] * DEG) * 2 * Math.PI / (WORLD0 * 2 ** ZOOM)

// Cada vista trae su cámara y la escala local cerrada en (lat, lng), la misma de views.test.mjs.
const casos = () => {
  const plana = planeView(arg)
  const incl  = planeView({ ...arg, pitch: 45 })
  const globo = globeView(arg)
  const radio = WORLD0 * 2 ** ZOOM / (2 * Math.PI) / Math.cos(CENTRO[0] * DEG)
  const D     = (FOCAL + radio) / radio
  const profundidad = (view, p) => screenOf(view, p[0], p[1], { x: 0, y: 0, occluded: false, depth: 0 }).depth
  return [
    { nombre: 'plana', view: plana, camera: camaraDe(plana), globo: false,
      escala: p => mercatorCentro * Math.cos(p[0] * DEG) / Math.cos(CENTRO[0] * DEG) * profundidad(plana, p) / FOCAL },
    { nombre: 'inclinada a 45°', view: incl, camera: camaraDe(incl), globo: false,
      escala: p => mercatorCentro * Math.cos(p[0] * DEG) / Math.cos(CENTRO[0] * DEG) * profundidad(incl, p) / FOCAL },
    { nombre: 'esférica a z3', view: globo, camera: camaraDe(globo), globo: true,
      escala: p => R * (D - Math.cos(angulo(CENTRO, p))) / FOCAL },
  ]
}

const cerca = (a, b, tol, msg) => assert.ok(Math.abs(a / b - 1) <= tol, `${msg}: ${a} y no ${b}`)

for (const caso of casos()) {
  const { nombre, camera, globo, escala } = caso

  test(`${nombre}: cada retorno trae las claves del contrato y out es el objeto devuelto`, () => {
    const out = { x: 0, y: 0, visible: false, occluded: true }
    const p   = camera.latLngToContainerPoint(CENTRO, out)
    assert.equal(p, out)
    assert.deepEqual(Object.keys(p), KEYS)
    assert.equal(p.visible, true)
    assert.equal(p.occluded, false)
    assert.ok(Math.abs(p.x - 400) <= TOL_FINITO && Math.abs(p.y - 300) <= TOL_FINITO)

    const sin = camera.latLngToContainerPoint(CENTRO)
    assert.deepEqual(Object.keys(sin), KEYS)
    assert.notEqual(sin, out)

    const suelo = camera.containerPointToLatLng([400, 300])
    assert.deepEqual(Object.keys(suelo), KEYS_SUELO)
    assert.equal(suelo.onSurface, true)
    assert.ok(Math.abs(suelo.lat - CENTRO[0]) <= TOL_FINITO && Math.abs(suelo.lng - CENTRO[1]) <= TOL_FINITO)
    assert.equal(typeof camera.metersPerPixelAt(), 'number')
    assert.equal(typeof camera.metersPerPixelAt(CENTRO), 'number')
  })

  test(`${nombre}: metersPerPixelAt coincide con la escala local cerrada en el centro y fuera de él`, () => {
    cerca(camera.metersPerPixelAt(), escala(CENTRO), TOL_ESCALA_LOCAL, 'sin argumento')
    for (const p of [CENTRO, ...FUERA_CENTRO]) {
      const out = camera.latLngToContainerPoint(p)
      assert.equal(out.visible, true, `${p} debe verse`)
      cerca(camera.metersPerPixelAt(p), escala(p), TOL_ESCALA_LOCAL, `${p}`)
    }
  })

  test(`${nombre}: ida y vuelta de los puntos visibles en ${TOL_IDA_VUELTA} px`, () => {
    const out = { x: 0, y: 0, visible: false, occluded: false }
    const de  = { x: 0, y: 0, visible: false, occluded: false }
    for (const p of [CENTRO, ...FUERA_CENTRO]) {
      camera.latLngToContainerPoint(p, out)
      const suelo = camera.containerPointToLatLng(out)
      assert.equal(suelo.onSurface, true)
      camera.latLngToContainerPoint([suelo.lat, suelo.lng], de)
      assert.ok(Math.abs(de.x - out.x) <= TOL_IDA_VUELTA && Math.abs(de.y - out.y) <= TOL_IDA_VUELTA, `${p}`)
    }
  })

  test(`${nombre}: un punto fuera del rectángulo y no tapado no es visible ni está tapado`, () => {
    // A z3 el disco entero cabe en el rectángulo: el globo prueba lo mismo a z4, donde el disco lo desborda.
    const cam = globo ? camaraDe(globeView({ ...arg, zoom: ZOOM + 1 })) : camera
    const p   = globo ? [CENTRO[0], CENTRO[1] + 50] : FUERA_RECT
    const r   = cam.latLngToContainerPoint(p)
    assert.equal(r.visible, false)
    assert.equal(r.occluded, false)
  })
}

const [plana, inclinada, globo] = casos()

test('plana con pitch 0: metersPerPixelAt() es la escala de Mercator del centro', () => {
  cerca(plana.camera.metersPerPixelAt(), mercatorCentro, TOL_ESCALA_LOCAL, 'centro')
})

test('esférica: lo que queda tras el horizonte está tapado, no es visible y no tiene escala', () => {
  for (const p of [ANTIPODA, A_100_GRADOS]) {
    const r = globo.camera.latLngToContainerPoint(p)
    assert.equal(r.occluded, true, `${p}`)
    assert.equal(r.visible, false, `${p}`)
    assert.ok(Number.isNaN(globo.camera.metersPerPixelAt(p)), `${p}`)
  }
})

test('plana: toda esquina del contenedor toca la superficie, de frente en el centro', () => {
  for (const p of [[0, 0], [SIZE.x, 0], [0, SIZE.y], [SIZE.x, SIZE.y]]) {
    const s = plana.camera.containerPointToLatLng(p)
    assert.equal(s.onSurface, true, `${p}`)
    assert.ok(s.incidence > 0 && s.incidence <= 1, `${p}`)
  }
  cerca(plana.camera.containerPointToLatLng([400, 300]).incidence, 1, TOL_FINITO, 'centro')
})

test('inclinada a 45°: el semicampo de 18,4° no alcanza el horizonte, todo píxel toca la superficie', () => {
  for (const p of [[0, 0], [400, 0], [SIZE.x, 0], [400, 600]]) {
    const s = inclinada.camera.containerPointToLatLng(p)
    assert.equal(s.onSurface, true, `${p}`)
    assert.ok(s.incidence > 0 && s.incidence < 1, `${p}`)
  }
})

test('inclinada a 80°: un píxel sobre el horizonte no toca la superficie y da lat y lng finitos', () => {
  const cam = camaraDe(planeView({ ...arg, pitch: 80 }))
  const s   = cam.containerPointToLatLng([400, 0])
  assert.equal(s.onSurface, false)
  assert.equal(s.incidence, 0)
  assert.ok(Number.isFinite(s.lat) && Number.isFinite(s.lng))
  assert.equal(cam.containerPointToLatLng([400, 600]).onSurface, true)
})

test('esférica: la incidencia es 1 en el centro del disco y 0 fuera de él', () => {
  cerca(globo.camera.containerPointToLatLng([400, 300]).incidence, 1, TOL_FINITO, 'centro')
  const borde = globo.camera.containerPointToLatLng([400, 300 + 150])
  assert.ok(borde.incidence > 0 && borde.incidence < 1)
  assert.equal(globo.camera.containerPointToLatLng([0, 0]).incidence, 0)
})

test('esférica: un píxel fuera del disco no toca la superficie y da lat y lng finitos', () => {
  const s = globo.camera.containerPointToLatLng([0, 0])
  assert.equal(s.onSurface, false)
  assert.ok(Number.isFinite(s.lat) && Number.isFinite(s.lng))
  assert.ok(Math.abs(s.lat) <= 90)
})
