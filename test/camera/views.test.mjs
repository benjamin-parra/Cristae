// Pruebas de src/camera/views.js y de la faceta de src/camera/facet.js: las tres vistas inyectadas.
// Corre con: node --test test/camera/views.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { bytesPorLlamada } from '../../test-helpers/asignaciones.mjs'
import { planeView, globeView, orthoView, screenOf, surfaceOf, metersPerPixelOf, boundsOf, FOV, FAR } from '../../src/camera/views.js'
import { viewFacet } from '../../src/camera/facet.js'
import { toUnitSphere } from '../../src/camera/geodesy.js'
import { projX0, projY0, MAXLAT } from '../../src/projection/mercator.js'
import { sphere } from '../../src/geometry/geodesic.js'

const TOL_PX           = 1e-9
const TOL_IDA_VUELTA   = 1e-6
const TOL_ESCALA_LOCAL = 1e-9
const TOL_LIMBO        = 1e-9

const R      = 6371008.8
const MODELO = sphere(R)
const DEG    = Math.PI / 180
const SIZE   = { x: 800, y: 600 }
const CHILE  = { lat: -33.45, lng: -70.6 }

const salida  = () => ({ x: 0, y: 0, occluded: false, depth: 0 })
const suelo   = () => ({ lat: 0, lng: 0, onSurface: false, incidence: 0, altitude: 0 })
const angulo  = (a, b) => {
  const u = toUnitSphere(a.lat, a.lng, new Float64Array(3)), v = toUnitSphere(b.lat, b.lng, new Float64Array(3))
  const c = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
  return Math.atan2(Math.hypot(...c), u[0] * v[0] + u[1] * v[1] + u[2] * v[2])
}

const vistas = zoom => ({
  plana    : planeView({ center: CHILE, zoom, size: SIZE }),
  inclinada: planeView({ center: CHILE, zoom, size: SIZE, pitch: 45, bearing: 30 }),
  globo    : globeView({ center: CHILE, zoom, size: SIZE }),
  orto     : orthoView({ center: CHILE, zoom, size: SIZE }),
})

test('FOV es el de MapLibre: atan(3/4), y la focal del plano es 1,5 veces el alto', () => {
  assert.equal(FOV, Math.atan(3 / 4))
  assert.ok(Math.abs(planeView({ center: CHILE, zoom: 3, size: SIZE }).f - 900) < 1e-9)
})

test('el plano con pitch 0 reproduce (projX0(lng) − projX0(lngc))·2^z + w/2 ≤ 1e-9 px', () => {
  const out = salida()
  for (const zoom of [0, 3, 8, 12, 18]) {
    const view = planeView({ center: CHILE, zoom, size: SIZE })
    for (const dLat of [-0.3, -0.01, 0, 0.02, 0.3]) for (const dLng of [-0.4, -0.001, 0, 0.003, 0.4]) {
      const lat = CHILE.lat + dLat, lng = CHILE.lng + dLng
      screenOf(view, lat, lng, out)
      const x = (projX0(lng) - projX0(CHILE.lng)) * 2 ** zoom + SIZE.x / 2
      const y = (projY0(lat) - projY0(CHILE.lat)) * 2 ** zoom + SIZE.y / 2
      assert.ok(Math.abs(out.x - x) <= TOL_PX, `x z${zoom} ${out.x} ≠ ${x}`)
      assert.ok(Math.abs(out.y - y) <= TOL_PX, `y z${zoom} ${out.y} ≠ ${y}`)
      assert.equal(out.occluded, false)
      assert.ok(out.depth > 0)
    }
  }
})

test('el centro cae en el centro de la pantalla en las cuatro vistas', () => {
  const out = salida()
  for (const view of Object.values(vistas(5))) {
    screenOf(view, CHILE.lat, CHILE.lng, out)
    assert.ok(Math.abs(out.x - 400) <= 1e-9 && Math.abs(out.y - 300) <= 1e-9, `${view.kind} ${out.x},${out.y}`)
    assert.equal(out.occluded, false)
  }
})

test('el plano inclinado achica lo lejano: el norte de la pantalla (arriba) queda más cerca entre sí que el sur', () => {
  const view = planeView({ center: CHILE, zoom: 12, size: SIZE, pitch: 50 })
  const a = salida(), b = salida()
  const paso = 0.01
  screenOf(view, CHILE.lat + paso, CHILE.lng, a)
  screenOf(view, CHILE.lat + 2 * paso, CHILE.lng, b)
  const lejos = a.y - b.y
  screenOf(view, CHILE.lat - paso, CHILE.lng, a)
  screenOf(view, CHILE.lat - 2 * paso, CHILE.lng, b)
  const cerca = b.y - a.y
  assert.ok(lejos > 0 && cerca > lejos, `lejos ${lejos}, cerca ${cerca}`)
})

test('el rumbo gira el plano: con bearing 90 el este queda hacia arriba', () => {
  const view = planeView({ center: CHILE, zoom: 10, size: SIZE, bearing: 90 })
  const out  = salida()
  screenOf(view, CHILE.lat, CHILE.lng + 0.05, out)
  assert.ok(out.y < 300 && Math.abs(out.x - 400) < 1e-6, `${out.x},${out.y}`)
})

test('en el centro el globo da la misma escala que Mercator, y la ortográfica también', () => {
  for (const zoom of [0, 2, 3, 6, 12]) {
    const cerrada = 2 * Math.PI * R * Math.cos(CHILE.lat * DEG) / (256 * 2 ** zoom)
    const v = vistas(zoom)
    for (const k of ['plana', 'globo', 'orto']) {
      const m = metersPerPixelOf(v[k], CHILE.lat, CHILE.lng, MODELO)
      assert.ok(Math.abs(m / cerrada - 1) <= TOL_ESCALA_LOCAL, `${k} z${zoom}: ${m} y no ${cerrada}`)
    }
  }
})

test('metersPerPixelOf del plano con pitch 0 es Mercator en cualquier punto, con la latitud acotada', () => {
  const view = planeView({ center: CHILE, zoom: 6, size: SIZE })
  for (const lat of [-80, -33.45, 0, 45, 85, 89]) {
    const phi = Math.max(Math.min(MAXLAT, lat), -MAXLAT)
    const cerrada = 2 * Math.PI * R * Math.cos(phi * DEG) / (256 * 2 ** 6)
    const m = metersPerPixelOf(view, lat, -70, MODELO)
    assert.ok(Math.abs(m / cerrada - 1) <= TOL_ESCALA_LOCAL, `${lat}: ${m} y no ${cerrada}`)
  }
})

test('metersPerPixelOf del globo es mR·(D − cos θ)/f, y en el polo norte también', () => {
  const zoom = 3
  const view = globeView({ center: CHILE, zoom, size: SIZE })
  const f = 900
  const r = 256 * 2 ** zoom / (2 * Math.PI) / Math.cos(CHILE.lat * DEG)
  const D = (f + r) / r
  for (const [lat, lng] of [[-33.45, -70.6], [-10, -50], [20, -100], [80, 10], [90, 0], [-45, 30]]) {
    const m = metersPerPixelOf(view, lat, lng, MODELO)
    const esperado = R * (D - Math.cos(angulo(CHILE, { lat, lng }))) / f
    assert.ok(Math.abs(m / esperado - 1) <= TOL_ESCALA_LOCAL, `${lat},${lng}: ${m} y no ${esperado}`)
  }
})

test('metersPerPixelOf de la ortográfica es R/r en todo punto', () => {
  const view = orthoView({ center: CHILE, zoom: 3, size: SIZE })
  const r = 256 * 8 / (2 * Math.PI) / Math.cos(CHILE.lat * DEG)
  assert.ok(Math.abs(metersPerPixelOf(view, 10, -20, MODELO) / (R / r) - 1) <= TOL_ESCALA_LOCAL)
})

test('metersPerPixelOf del plano inclinado crece con la profundidad', () => {
  const view = planeView({ center: CHILE, zoom: 12, size: SIZE, pitch: 55 })
  const cerca = metersPerPixelOf(view, CHILE.lat - 0.01, CHILE.lng, MODELO)
  const medio = metersPerPixelOf(view, CHILE.lat, CHILE.lng, MODELO)
  const lejos = metersPerPixelOf(view, CHILE.lat + 0.01, CHILE.lng, MODELO)
  assert.ok(cerca < medio && medio < lejos, `${cerca} ${medio} ${lejos}`)
})

test('ida y vuelta surfaceOf → screenOf ≤ 1e-6 px en las tres vistas (y la ortográfica)', () => {
  const out = salida(), hit = suelo()
  for (const zoom of [3, 8]) for (const [nombre, view] of Object.entries(vistas(zoom))) {
    let probados = 0
    for (let x = 10; x < SIZE.x; x += 97) for (let y = 10; y < SIZE.y; y += 83) {
      surfaceOf(view, x, y, hit)
      if (!hit.onSurface) continue
      screenOf(view, hit.lat, hit.lng, out)
      assert.ok(Math.hypot(out.x - x, out.y - y) <= TOL_IDA_VUELTA, `${nombre} z${zoom} (${x}, ${y}) → (${out.x}, ${out.y})`)
      assert.equal(out.occluded, false, `${nombre} (${x}, ${y})`)
      assert.equal(hit.altitude, 0)
      probados++
    }
    assert.ok(probados > 10, `${nombre}: sólo ${probados}`)
  }
})

test('ida y vuelta del punto: lat/lng → px → lat/lng en las tres vistas', () => {
  const out = salida(), hit = suelo()
  for (const [nombre, view] of Object.entries(vistas(4))) for (const [lat, lng] of [[-33, -70.5], [-30, -75], [-36, -66], [-34.2, -71.7]]) {
    screenOf(view, lat, lng, out)
    surfaceOf(view, out.x, out.y, hit)
    assert.ok(Math.abs(hit.lat - lat) <= 1e-9 && Math.abs(hit.lng - lng) <= 1e-9, `${nombre} ${hit.lat},${hit.lng}`)
  }
})

test('globo a z3 (800×600): el antípoda y un punto a 100° quedan occluded, y uno a 60° no', () => {
  const view = globeView({ center: { lat: 0, lng: -70 }, zoom: 3, size: SIZE })
  const out  = salida()
  screenOf(view, 0, 110, out)
  assert.equal(out.occluded, true, 'antípoda')
  screenOf(view, 0, 30, out)
  assert.equal(out.occluded, true, '100°')
  screenOf(view, 0, -10, out)
  assert.equal(out.occluded, false, '60°')
  screenOf(view, 0, 10, out)
  assert.equal(out.occluded, true, '80° pasa el horizonte, a acos(1/D) = 74,6°')
})

test('globo a z3: una esquina cae fuera del disco, onSurface es false y su punto está a acos(1/D) del centro', () => {
  const view = globeView({ center: CHILE, zoom: 3, size: SIZE })
  const hit  = suelo()
  const f = 900, r = 256 * 8 / (2 * Math.PI) / Math.cos(CHILE.lat * DEG)
  const alfa = Math.acos(1 / ((f + r) / r))
  for (const [x, y] of [[0, 0], [SIZE.x, 0], [0, SIZE.y], [SIZE.x, SIZE.y], [SIZE.x / 2, 0], [799, 300]]) {
    surfaceOf(view, x, y, hit)
    assert.equal(hit.onSurface, false, `(${x}, ${y})`)
    const dist = angulo(CHILE, hit)
    assert.ok(Math.abs(dist - alfa) <= TOL_LIMBO, `(${x}, ${y}) a ${dist}, no ${alfa}`)
  }
})

test('globo: el limbo sale en la dirección radial desde el centro de la pantalla', () => {
  const view = globeView({ center: { lat: 0, lng: 0 }, zoom: 3, size: SIZE })
  const hit  = suelo()
  surfaceOf(view, 800, 300, hit)          // a la derecha del centro: el este
  assert.ok(hit.lng > 0 && Math.abs(hit.lat) < 1e-9, `${hit.lat},${hit.lng}`)
  surfaceOf(view, 400, 0, hit)            // arriba: el norte
  assert.ok(hit.lat > 0 && Math.abs(hit.lng) < 1e-9, `${hit.lat},${hit.lng}`)
})

test('ortográfica: fuera del disco, onSurface false y el punto a 90° del centro', () => {
  const view = orthoView({ center: CHILE, zoom: 3, size: SIZE })
  const hit  = suelo()
  surfaceOf(view, 0, 0, hit)
  assert.equal(hit.onSurface, false)
  assert.ok(Math.abs(angulo(CHILE, hit) - Math.PI / 2) <= TOL_LIMBO)
})

test('plano muy inclinado: un rayo sobre el horizonte no toca el suelo y da el punto a FAR focales', () => {
  const view = planeView({ center: CHILE, zoom: 12, size: SIZE, pitch: 80 })
  const hit  = suelo(), out = salida()
  surfaceOf(view, 400, 0, hit)
  assert.equal(hit.onSurface, false)
  assert.ok(Number.isFinite(hit.lat) && Number.isFinite(hit.lng))
  surfaceOf(view, 400, 599, hit)
  assert.equal(hit.onSurface, true)
  screenOf(view, hit.lat, hit.lng, out)
  assert.ok(Math.abs(out.y - 599) <= TOL_IDA_VUELTA)
  assert.ok(FAR > 0)
})

test('plano con pitch 60 no pierde el suelo en ningún borde de la pantalla', () => {
  const view = planeView({ center: CHILE, zoom: 12, size: SIZE, pitch: 60 })
  const hit  = suelo()
  for (const [x, y] of [[0, 0], [799, 0], [0, 599], [799, 599]]) {
    surfaceOf(view, x, y, hit)
    assert.equal(hit.onSurface, true, `(${x}, ${y})`)
  }
})

// ¿La caja contiene el punto? Con west > east la caja cruza el antimeridiano.
const dentro = (box, lat, lng) => {
  if (lat < box.south || lat > box.north) return false
  return box.west <= box.east ? lng >= box.west && lng <= box.east : lng >= box.west || lng <= box.east
}

test('boundsOf contiene todo punto muestreado que la vista ve', () => {
  const out = salida()
  const centros = [CHILE, { lat: 60, lng: 170 }, { lat: -80, lng: 10 }, { lat: 5, lng: -179 }]
  for (const center of centros) for (const zoom of [1, 3, 6]) {
    const v = {
      plana    : planeView({ center, zoom, size: SIZE }),
      inclinada: planeView({ center, zoom, size: SIZE, pitch: 50, bearing: -40 }),
      globo    : globeView({ center, zoom, size: SIZE }),
      orto     : orthoView({ center, zoom, size: SIZE }),
    }
    for (const [nombre, view] of Object.entries(v)) {
      const box = boundsOf(view, { south: 0, west: 0, north: 0, east: 0 })
      let vistos = 0
      for (let lat = -84; lat <= 84; lat += 4) for (let lng = -180; lng < 180; lng += 4) {
        screenOf(view, lat, lng, out)
        if (out.occluded || !(out.depth > 0) || out.x < 0 || out.x > SIZE.x || out.y < 0 || out.y > SIZE.y) continue
        vistos++
        // La plana lleva la lng sin envolver: se prueba también la copia ±360.
        const ok = dentro(box, lat, lng) || dentro(box, lat, lng + 360) || dentro(box, lat, lng - 360)
        assert.ok(ok, `${nombre} ${JSON.stringify(center)} z${zoom}: (${lat}, ${lng}) fuera de ${JSON.stringify(box)}`)
      }
      void vistos
    }
  }
})

test('boundsOf del plano con pitch 0 y rumbo 0 es exacta: sus esquinas', () => {
  const view = planeView({ center: CHILE, zoom: 7, size: SIZE })
  const box  = boundsOf(view, { south: 0, west: 0, north: 0, east: 0 })
  const sw = suelo(), ne = suelo()
  surfaceOf(view, 0, SIZE.y, sw)
  surfaceOf(view, SIZE.x, 0, ne)
  assert.ok(Math.abs(box.south - sw.lat) <= 1e-12 && Math.abs(box.west - sw.lng) <= 1e-12)
  assert.ok(Math.abs(box.north - ne.lat) <= 1e-12 && Math.abs(box.east - ne.lng) <= 1e-12)
})

test('boundsOf de una esfera que abarca un polo da toda la vuelta de longitud', () => {
  const box = boundsOf(globeView({ center: { lat: 80, lng: 0 }, zoom: 2, size: SIZE }), { south: 0, west: 0, north: 0, east: 0 })
  assert.equal(box.north, 90)
  assert.equal(box.west, -180)
  assert.equal(box.east, 180)
})

// Los argumentos salen de un Float64Array: así llegan como números sin caja, y lo que mide la prueba es la
// función y no el encajonado de un número calculado en el cierre.
const LATS = new Float64Array([-33.45, -33.44, -33.43, -33.42, -33.41, -33.4, -33.39, -33.38])
const LNGS = new Float64Array([-70.6, -70.59, -70.58, -70.57])
const XS   = new Float64Array([100, 250, 400, 550, 700, 321, 77, 640])
const CALENTAR = 300_000

// Cada vista se mide en su propia copia del módulo (el `?` del especificador): V8 inlinea según lo que cada
// sitio de llamada vio, y si la misma `screenOf` vio ya otro tipo de vista, no cabe todo en el presupuesto
// de inlineado y los números empiezan a encajonarse al cruzar llamadas. En el motor, cada capa llama con un
// solo tipo.
const aislada = async nombre => {
  const copia = await import(`../../src/camera/views.js?${nombre}`)
  const args  = { center: CHILE, zoom: 5, size: SIZE }
  return {
    copia,
    view: nombre === 'plana' ? copia.planeView(args)
      : nombre === 'inclinada' ? copia.planeView({ ...args, pitch: 45, bearing: 30 })
        : nombre === 'globo' ? copia.globeView(args) : copia.orthoView(args),
  }
}

// Un bloque por vista y no un bucle: el sitio de llamada de `copia.screenOf` de un bucle ve las cuatro copias
// del módulo, es polimórfico y V8 no lo inlinea.
const sinAsignar = bytes => assert.ok(bytes < 1, `asignó ${bytes} bytes por llamada`)

test('screenOf no asigna en la vista plana', async () => {
  const { copia, view } = await aislada('plana')
  const out = salida()
  sinAsignar(bytesPorLlamada(i => copia.screenOf(view, LATS[i & 7], LNGS[i & 3], out), 20_000, { calentar: CALENTAR }))
})

test('surfaceOf no asigna en la vista plana', async () => {
  const { copia, view } = await aislada('plana')
  const hit = suelo()
  sinAsignar(bytesPorLlamada(i => copia.surfaceOf(view, XS[i & 7], XS[(i + 3) & 7] * 0.7, hit), 20_000, { calentar: CALENTAR }))
})

test('screenOf no asigna en la vista inclinada', async () => {
  const { copia, view } = await aislada('inclinada')
  const out = salida()
  sinAsignar(bytesPorLlamada(i => copia.screenOf(view, LATS[i & 7], LNGS[i & 3], out), 20_000, { calentar: CALENTAR }))
})

test('surfaceOf no asigna en la vista inclinada', async () => {
  const { copia, view } = await aislada('inclinada')
  const hit = suelo()
  sinAsignar(bytesPorLlamada(i => copia.surfaceOf(view, XS[i & 7], XS[(i + 3) & 7] * 0.7, hit), 20_000, { calentar: CALENTAR }))
})

test('screenOf no asigna en la vista globo', async () => {
  const { copia, view } = await aislada('globo')
  const out = salida()
  sinAsignar(bytesPorLlamada(i => copia.screenOf(view, LATS[i & 7], LNGS[i & 3], out), 20_000, { calentar: CALENTAR }))
})

test('surfaceOf no asigna en la vista globo', async () => {
  const { copia, view } = await aislada('globo')
  const hit = suelo()
  sinAsignar(bytesPorLlamada(i => copia.surfaceOf(view, XS[i & 7], XS[(i + 3) & 7] * 0.7, hit), 20_000, { calentar: CALENTAR }))
})

test('screenOf no asigna en la vista orto', async () => {
  const { copia, view } = await aislada('orto')
  const out = salida()
  sinAsignar(bytesPorLlamada(i => copia.screenOf(view, LATS[i & 7], LNGS[i & 3], out), 20_000, { calentar: CALENTAR }))
})

test('surfaceOf no asigna en la vista orto', async () => {
  const { copia, view } = await aislada('orto')
  const hit = suelo()
  sinAsignar(bytesPorLlamada(i => copia.surfaceOf(view, XS[i & 7], XS[(i + 3) & 7] * 0.7, hit), 20_000, { calentar: CALENTAR }))
})

// ---- la faceta ----

test('viewFacet: toScreen da visible por el rectángulo, la esfera y el ojo; sin asignar', () => {
  const globo = viewFacet(globeView({ center: { lat: 0, lng: -70 }, zoom: 3, size: SIZE }))
  const out   = { x: 0, y: 0, visible: false, occluded: false }
  globo.toScreen([0, -70], out)
  assert.deepEqual(out, { x: 400, y: 300, visible: true, occluded: false })
  globo.toScreen([0, 110], out)
  assert.equal(out.occluded, true)
  assert.equal(out.visible, false)

  const plana = viewFacet(planeView({ center: CHILE, zoom: 5, size: SIZE }))
  plana.toScreen({ lat: -33.45, lng: -70.6 }, out)
  assert.equal(out.visible, true)
  plana.toScreen([60, 100], out)
  assert.equal(out.visible, false)
  assert.equal(out.occluded, false)

  const bytes = bytesPorLlamada(() => plana.toScreen([-33, -70], out), 20_000, { calentar: CALENTAR })
  assert.ok(bytes < 1, `asignó ${bytes} bytes por llamada`)
})

test('viewFacet: un punto detrás del ojo no es visible', () => {
  const facet = viewFacet(planeView({ center: CHILE, zoom: 12, size: SIZE, pitch: 85 }))
  const out   = { x: 0, y: 0, visible: true, occluded: false }
  // A 85° el ojo casi roza el suelo: lo que queda a su espalda tiene w ≤ 0.
  facet.toScreen([CHILE.lat - 5, CHILE.lng], out)
  assert.equal(out.visible, false)
})

test('viewFacet: lo que no es un punto lanza TypeError y una coordenada NaN lanza Error', () => {
  const facet = viewFacet(planeView({ center: CHILE, zoom: 5, size: SIZE }))
  const out   = { x: 0, y: 0, visible: false, occluded: false }
  assert.throws(() => facet.toScreen(null, out), TypeError)
  assert.throws(() => facet.toScreen(new Float64Array(5), out), TypeError)
  assert.throws(() => facet.toScreen([NaN, 0], out), /Invalid LatLng/)
})

test('viewFacet: surfaceAt acepta {x, y} y [x, y], y escribe en el out dado', () => {
  const facet = viewFacet(globeView({ center: CHILE, zoom: 3, size: SIZE }))
  const out   = suelo()
  const a = facet.surfaceAt({ x: 400, y: 300 }, out)
  assert.equal(a, out)
  assert.ok(Math.abs(out.lat - CHILE.lat) <= 1e-9 && Math.abs(out.lng - CHILE.lng) <= 1e-9)
  const b = facet.surfaceAt([400, 300])
  assert.deepEqual(b, { lat: out.lat, lng: out.lng, onSurface: true, incidence: out.incidence, altitude: 0 })
})

test('viewFacet: center, zoom, size, bounds, toContainer, fromContainer y metersPerPixelAt', () => {
  const facet = viewFacet(planeView({ center: CHILE, zoom: 7, size: SIZE }))
  assert.equal(facet.hasView(), true)
  assert.deepEqual(facet.center(), CHILE)
  assert.equal(facet.zoom(), 7)
  assert.deepEqual(facet.size(), SIZE)
  const box = facet.bounds()
  assert.ok(box.south < CHILE.lat && CHILE.lat < box.north && box.west < CHILE.lng && CHILE.lng < box.east)
  const p = facet.toContainer([-33.45, -70.6])
  assert.deepEqual(p, { x: 400, y: 300 })
  const ll = facet.fromContainer({ x: 400, y: 300 })
  assert.ok(Math.abs(ll.lat - CHILE.lat) <= 1e-9 && Math.abs(ll.lng - CHILE.lng) <= 1e-9)
  assert.ok(facet.metersPerPixelAt(CHILE.lat, CHILE.lng, MODELO) > 0)
  assert.deepEqual(facet.frameOrigin(), { x: 0, y: 0 })
  assert.equal(typeof facet.on('move', () => {}), 'function')
})
