// Pruebas de src/camera/geodesy.js: esfera unidad, ENU, ECEF, horizonte, rayo-esfera y casquete.
// Corre con: node --test test/camera/geodesy.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  toUnitSphere, fromUnitSphere, enuAt, ecef, horizonCos, raySphere, capOfBox, WGS84_A, WGS84_F,
} from '../../src/camera/geodesy.js'

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const sub = (a, i) => [a[i], a[i + 1], a[i + 2]]
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} ≠ ${b}`)

test('toUnitSphere: el marco del preludio (lat 0 lng 0 sobre +z, norte sobre +y, lng 90 sobre +x)', () => {
  const v = new Float64Array(3)
  ;[[0, 0, [0, 0, 1]], [90, 0, [0, 1, 0]], [0, 90, [1, 0, 0]], [0, -90, [-1, 0, 0]], [0, 180, [0, 0, -1]]]
    .forEach(([lat, lng, esperado]) => {
      toUnitSphere(lat, lng, v)
      esperado.forEach((e, i) => near(v[i], e, 1e-15, `(${lat}, ${lng})[${i}]`))
    })
})

test('toUnitSphere da vectores unitarios', () => {
  const v = new Float64Array(3)
  for (let lat = -90; lat <= 90; lat += 15)
    for (let lng = -180; lng <= 180; lng += 20)
      near(Math.hypot(...toUnitSphere(lat, lng, v)), 1, 1e-15)
})

test('toUnitSphere → fromUnitSphere ida y vuelta ≤ 1e-12°', () => {
  const v = new Float64Array(3), ll = new Float64Array(2)
  for (let lat = -89.9; lat <= 89.9; lat += 7.3)
    for (let lng = -179.9; lng <= 180; lng += 11.7) {
      fromUnitSphere(toUnitSphere(lat, lng, v), ll)
      near(ll[0], lat, 1e-12, `lat(${lat}, ${lng})`)
      near(ll[1], lng, 1e-12, `lng(${lat}, ${lng})`)
    }
})

test('fromUnitSphere: lng en (-180, 180], vectores sin normalizar y polo', () => {
  const ll = new Float64Array(2)
  fromUnitSphere([0, 0, -1], ll)
  assert.equal(ll[1], 180)
  fromUnitSphere([-1e-16, 0, -1], ll)
  assert.equal(ll[1], 180)
  fromUnitSphere([0, 0, 5], ll)
  assert.deepEqual([...ll], [0, 0])
  fromUnitSphere([0, 3, 0], ll)
  assert.deepEqual([...ll], [90, 0])
  fromUnitSphere([0, 1 + 1e-16, 0], ll)
  assert.equal(ll[0], 90)
})

test('enuAt: ortonormal, mano derecha y arriba es el propio punto', () => {
  const m = new Float64Array(9), p = new Float64Array(3)
  ;[[0, 0], [45, 30], [-33.4, -70.6], [89, 120], [-60, 179]].forEach(([lat, lng]) => {
    enuAt(lat, lng, m)
    const e = sub(m, 0), n = sub(m, 3), u = sub(m, 6)
    near(dot(e, e), 1, 1e-15); near(dot(n, n), 1, 1e-15); near(dot(u, u), 1, 1e-15)
    near(dot(e, n), 0, 1e-15); near(dot(e, u), 0, 1e-15); near(dot(n, u), 0, 1e-15)
    const cruz = [e[1] * n[2] - e[2] * n[1], e[2] * n[0] - e[0] * n[2], e[0] * n[1] - e[1] * n[0]]
    cruz.forEach((c, i) => near(c, u[i], 1e-15, 'E×N=U'))
    toUnitSphere(lat, lng, p)
    u.forEach((c, i) => near(c, p[i], 1e-15, 'U=punto'))
  })
})

test('enuAt: moverse hacia el norte o el este sigue esas direcciones', () => {
  const m = new Float64Array(9), a = new Float64Array(3), b = new Float64Array(3)
  enuAt(40, 10, m)
  toUnitSphere(40, 10, a)
  toUnitSphere(40.001, 10, b)
  assert.ok(dot(b.map((v, i) => v - a[i]), sub(m, 3)) > 0)
  toUnitSphere(40, 10.001, b)
  assert.ok(dot(b.map((v, i) => v - a[i]), sub(m, 0)) > 0)
})

test('ecef contra valores publicados de WGS84', () => {
  const v = new Float64Array(3)
  const b = WGS84_A * (1 - WGS84_F)
  assert.equal(WGS84_A, 6378137)
  near(b, 6356752.314245, 1e-6, 'semieje menor')

  assert.deepEqual([...ecef(0, 0, 0, v)], [WGS84_A, 0, 0])
  near(ecef(90, 0, 0, v)[2], b, 1e-6, 'polo norte')
  near(ecef(-90, 0, 0, v)[2], -b, 1e-6, 'polo sur')
  near(ecef(0, 90, 0, v)[1], WGS84_A, 1e-6, 'lng 90 sobre +y')
  near(ecef(0, 0, 1000, v)[0], WGS84_A + 1000, 1e-6, 'altura')
  // Lat 45, h 0: x = N cos φ, z = N (1 − e²) sin φ, con N = a / √(1 − e² sin² φ) y e² = 6.69437999014e-3.
  ecef(45, 0, 0, v)
  near(v[0], 4517590.879, 1e-3, 'lat 45 x')
  near(v[2], 4487348.409, 1e-3, 'lat 45 z')
})

test('horizonCos es 1/d', () => {
  assert.equal(horizonCos(2), 0.5)
  assert.equal(horizonCos(1.25), 0.8)
})

test('horizonte: un punto a acos(1/d) del subpunto queda en el plano del horizonte', () => {
  const d = 1.6
  const ojo = new Float64Array(3), p = new Float64Array(3)
  toUnitSphere(30, -20, ojo)
  const theta = Math.acos(horizonCos(d)) * 180 / Math.PI
  // un punto del mismo meridiano, theta grados al norte del subpunto
  toUnitSphere(30 + theta, -20, p)
  near(dot(p, ojo), horizonCos(d), 1e-15, 'cos del ángulo central')
  // (p − ojo·d) ⟂ p: el rayo del ojo al punto es tangente
  const rayo = p.map((v, i) => v - d * ojo[i])
  near(dot(rayo, p), 0, 1e-15, 'tangente')
})

test('raySphere: golpe de frente, entrada y salida', () => {
  near(raySphere(0, 0, 5, 0, 0, -1), 4, 1e-15)
  near(raySphere(0, 0, 5, 0, 0, -2), 2, 1e-15, 'dirección no unitaria')
})

test('raySphere: tangente da su único punto', () => {
  near(raySphere(1, 0, 5, 0, 0, -1), 5, 1e-15)
})

test('raySphere: fallo, rayo que se aleja y vector nulo dan NaN', () => {
  assert.ok(Number.isNaN(raySphere(2, 0, 5, 0, 0, -1)))
  assert.ok(Number.isNaN(raySphere(0, 0, 5, 0, 0, 1)))
  assert.ok(Number.isNaN(raySphere(0, 0, 5, 0, 0, 0)))
})

test('raySphere: origen interior devuelve la salida', () => {
  near(raySphere(0, 0, 0, 0, 0, 1), 1, 1e-15)
  near(raySphere(0.5, 0, 0, 1, 0, 0), 0.5, 1e-15)
  near(raySphere(0.5, 0, 0, -1, 0, 0), 1.5, 1e-15)
})

test('raySphere: el punto devuelto cae sobre la esfera', () => {
  const t = raySphere(0.3, -2, 4, -0.05, 0.4, -1)
  assert.ok(t >= 0)
  near(Math.hypot(0.3 - 0.05 * t, -2 + 0.4 * t, 4 - t), 1, 1e-14)
})

// ── capOfBox ────────────────────────────────────────────────────────────────────

const cubre = (box, lat, lng, cap) => {
  const p = toUnitSphere(lat, lng, new Float64Array(3))
  const cosAng = cap[0] * p[0] + cap[1] * p[1] + cap[2] * p[2]
  assert.ok(Math.acos(Math.min(1, cosAng)) <= cap[3], `(${lat}, ${lng}) fuera del casquete de ${JSON.stringify(box)}`)
}

const verifica = box => {
  const cap = capOfBox(box, new Float64Array(4))
  near(Math.hypot(cap[0], cap[1], cap[2]), 1, 1e-15, 'centro unitario')
  const ancho = (box.east - box.west + 720) % 360 || (box.east > box.west ? 360 : 0)
  const lngs = [0, 0.25, 0.5, 0.75, 1].map(f => box.west + ancho * f)
  const lats = [0, 0.25, 0.5, 0.75, 1].map(f => box.south + (box.north - box.south) * f)
  lats.forEach(lat => lngs.forEach(lng => cubre(box, lat, lng, cap)))
  return cap
}

test('capOfBox: una caja chica tiene radio ≈ su semidiagonal angular', () => {
  const cap = verifica({ south: -1, west: -1, north: 1, east: 1 })
  near(cap[3], Math.acos(Math.cos(Math.PI / 180) ** 2), 1e-9)
})

test('capOfBox: cajas varias contienen esquinas, bordes y centro', () => {
  ;[
    { south: 10, west: -20, north: 50, east: 40 },
    { south: -80, west: 100, north: -10, east: 170 },
    { south: -33.6, west: -70.8, north: -33.3, east: -70.5 },
    { south: 0, west: -120, north: 80, east: 120 },
  ].forEach(verifica)
})

test('capOfBox: caja que cruza el antimeridiano', () => {
  const box = { south: -10, west: 170, north: 10, east: -170 }
  const cap = verifica(box)
  near(Math.abs(Math.abs(Math.atan2(cap[0], cap[2]) * 180 / Math.PI) - 180), 0, 1e-12, 'centro en lng 180')
})

test('capOfBox: caja con el polo en un borde', () => {
  const cap = verifica({ south: 60, west: -30, north: 90, east: 30 })
  cubre(null, 90, 0, cap)
  cubre(null, 90, 123, cap)
  verifica({ south: -90, west: 0, north: -60, east: 90 })
})

test('capOfBox: caja de 360° cubre todo su ancho, también la antípoda en el meridiano de borde', () => {
  verifica({ south: -20, west: -180, north: 40, east: 180 })
  verifica({ south: -90, west: -180, north: 90, east: 180 })
  verifica({ south: 30, west: 0, north: 30.5, east: 360 })
  const mundo = capOfBox({ south: -90, west: -180, north: 90, east: 180 }, new Float64Array(4))
  assert.ok(mundo[3] >= Math.PI - 1e-9)
})

test('capOfBox: caja degenerada de un punto tiene radio ≈ 0 y devuelve out', () => {
  const out = new Float64Array(4)
  assert.equal(capOfBox({ south: 5, west: 7, north: 5, east: 7 }, out), out)
  assert.ok(out[3] < 1e-11)
})
