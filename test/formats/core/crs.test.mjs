// CRS del núcleo (DISENO-INTEROP §2.5 y §5-7). Las referencias son independientes de la inversa: la
// forma cerrada de 3857, el cuadrante de meridiano publicado de WGS84, una directa de Krüger escrita acá y
// la directa de Snyder (USGS PP 1395, 1987, §8), que es otra serie. IOGP GN 7-2 queda pendiente (D-11).

import test from 'node:test'
import assert from 'node:assert/strict'
import { crsFromEpsg, crsFromWkt, optionCrs, toLngLat, isGeographic } from '../../../src/formats/core/crs.js'

const enc = new TextEncoder()
const wkt = texto => crsFromWkt(enc.encode(texto))
const inv = (crs, x, y) => {
  const xy = new Float64Array([x, y])
  assert.ok(toLngLat(crs, xy, 0, 1))
  return [xy[0], xy[1]]
}

const RAD = Math.PI / 180

// Directa de Krüger a orden 6 (Karney 2011, ec. 35), con la latitud conforme por la fórmula exacta.
const krugerDirecta = (crs, lng, lat) => {
  const { a, f, k0, lon0, fe, fn } = crs
  const n  = f / (2 - f), n2 = n * n, n3 = n2 * n, n4 = n3 * n, n5 = n4 * n, n6 = n5 * n
  const e  = Math.sqrt(f * (2 - f))
  const A  = a / (1 + n) * (1 + n2 / 4 + n4 / 64 + n6 / 256)
  const al = [
    n / 2 - 2 * n2 / 3 + 5 * n3 / 16 + 41 * n4 / 180 - 127 * n5 / 288 + 7891 * n6 / 37800,
    13 * n2 / 48 - 3 * n3 / 5 + 557 * n4 / 1440 + 281 * n5 / 630 - 1983433 * n6 / 1935360,
    61 * n3 / 240 - 103 * n4 / 140 + 15061 * n5 / 26880 + 167603 * n6 / 181440,
    49561 * n4 / 161280 - 179 * n5 / 168 + 6601661 * n6 / 7257600,
    34729 * n5 / 80640 - 3418889 * n6 / 1995840,
    212378941 * n6 / 319334400,
  ]
  const phi = lat * RAD, lam = (lng - lon0) * RAD
  const tau = Math.tan(phi)
  const sig = Math.sinh(e * Math.atanh(e * tau / Math.sqrt(1 + tau * tau)))
  const tp  = tau * Math.sqrt(1 + sig * sig) - sig * Math.sqrt(1 + tau * tau)
  const xp  = Math.atan2(tp, Math.cos(lam))
  const ep  = Math.asinh(Math.sin(lam) / Math.sqrt(tp * tp + Math.cos(lam) ** 2))
  let xi = xp, eta = ep
  for (let j = 1; j <= 6; j++) {
    xi  += al[j - 1] * Math.sin(2 * j * xp) * Math.cosh(2 * j * ep)
    eta += al[j - 1] * Math.cos(2 * j * xp) * Math.sinh(2 * j * ep)
  }
  return [fe + k0 * A * eta, fn + k0 * A * xi]
}

// Directa de Snyder (1987), ecs. 8-9 a 8-10: serie en A = Δλ·cos φ, de precisión centimétrica cerca del
// meridiano central.
const snyderDirecta = (crs, lng, lat) => {
  const { a, f, k0, lon0, fe, fn } = crs
  const e2  = f * (2 - f), ep2 = e2 / (1 - e2)
  const phi = lat * RAD
  const N   = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2)
  const T   = Math.tan(phi) ** 2
  const C   = ep2 * Math.cos(phi) ** 2
  const A   = (lng - lon0) * RAD * Math.cos(phi)
  const M   = a * ((1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256) * phi -
    (3 * e2 / 8 + 3 * e2 ** 2 / 32 + 45 * e2 ** 3 / 1024) * Math.sin(2 * phi) +
    (15 * e2 ** 2 / 256 + 45 * e2 ** 3 / 1024) * Math.sin(4 * phi) - (35 * e2 ** 3 / 3072) * Math.sin(6 * phi))
  const x = k0 * N * (A + (1 - T + C) * A ** 3 / 6 + (5 - 18 * T + T * T + 72 * C - 58 * ep2) * A ** 5 / 120)
  const y = k0 * (M + N * Math.tan(phi) * (A * A / 2 + (5 - T + 9 * C + 4 * C * C) * A ** 4 / 24 +
    (61 - 58 * T + T * T + 600 * C - 330 * ep2) * A ** 6 / 720))
  return [fe + x, fn + y]
}

test('crsFromEpsg: 4326, CRS84, 3857 y alias, UTM norte y sur; lo demás es null', () => {
  assert.equal(crsFromEpsg(4326).kind, 0)
  assert.equal(crsFromEpsg('OGC:CRS84').kind, 0)
  assert.equal(crsFromEpsg('urn:ogc:def:crs:OGC:1.3:CRS84').name, 'OGC:CRS84')
  ;[3857, 900913, 102100, 102113, 'ESRI:102100'].forEach(c => assert.equal(crsFromEpsg(c).kind, 1, String(c)))
  const s = crsFromEpsg('urn:ogc:def:crs:EPSG::32719')
  assert.deepEqual([s.kind, s.lon0, s.fe, s.fn, s.k0], [2, -69, 500000, 10000000, 0.9996])
  assert.deepEqual([crsFromEpsg(32618).lon0, crsFromEpsg(32618).fn], [-75, 0])
  ;[4267, 32600, 32661, 32761, 24879, 'EPSG:abc', 1.5, null].forEach(c => assert.equal(crsFromEpsg(c), null, String(c)))
})

test('3857: la inversa es la forma cerrada', () => {
  const crs = crsFromEpsg(3857)
  const R   = 6378137
  ;[[0, 0], [-7861912.5, -3955830.25], [20037508.342789244, 0], [1000, 19971868.88]].forEach(([x, y]) => {
    const [lng, lat] = inv(crs, x, y)
    assert.ok(Math.abs(lng - x / R / RAD) < 1e-12)
    assert.ok(Math.abs(lat - (Math.PI / 2 - 2 * Math.atan(Math.exp(-y / R))) / RAD) < 1e-12)
  })
  assert.ok(Math.abs(inv(crs, 20037508.342789244, 0)[0] - 180) < 1e-9)
})

test('TM: el meridiano central y el polo contra el cuadrante de meridiano publicado de WGS84', () => {
  const crs = crsFromEpsg(32719)
  assert.deepEqual(inv(crs, 500000, 10000000).map(v => Math.abs(v) < 1e-12 ? 0 : v), [-69, 0])
  // Cuadrante de meridiano de WGS84: 10 001 965,729 m (NIMA TR8350.2, de memoria: va con D-11).
  const [, lat] = inv(crsFromEpsg(32619), 500000, 0.9996 * 10001965.729)
  assert.ok(Math.abs(lat - 90) < 1e-7, `polo: ${lat}`)
})

test('TM: ida con Krüger independiente y vuelta con la inversa, submilimétrica en la zona', () => {
  const crs = crsFromEpsg(32719)
  for (let lat = -80; lat <= 80; lat += 4)
    for (let d = -3; d <= 3; d += 0.75) {
      const [x, y]  = krugerDirecta(crs, -69 + d, lat)
      const [lng, la] = inv(crs, x, y)
      // 1e-9 grados son ~0,1 mm.
      assert.ok(Math.abs(lng - (-69 + d)) < 1e-9 && Math.abs(la - lat) < 1e-9, `(${-69 + d}, ${lat}) → (${lng}, ${la})`)
    }
})

test('TM: contra la directa de Snyder, otra serie, al centímetro cerca del meridiano central', () => {
  const crs = crsFromEpsg(32719)
  ;[[-69.5, -33.45], [-70.6, -33.4], [-68.2, -18.5], [-71.5, -53.1], [-69, -45]].forEach(([lng, lat]) => {
    const [x, y]    = snyderDirecta(crs, lng, lat)
    const [lo, la]  = inv(crs, x, y)
    const metrosLng = Math.abs(lo - lng) * RAD * 6378137 * Math.cos(lat * RAD)
    const metrosLat = Math.abs(la - lat) * RAD * 6378137
    assert.ok(metrosLng < 0.01 && metrosLat < 0.01, `(${lng}, ${lat}): ${metrosLng} m, ${metrosLat} m`)
  })
})

const GEOGCS_WGS = 'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]'
const UTM19S = `PROJCS["WGS_1984_UTM_Zone_19S",${GEOGCS_WGS},PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",500000.0],PARAMETER["False_Northing",10000000.0],PARAMETER["Central_Meridian",-69.0],PARAMETER["Scale_Factor",0.9996],PARAMETER["Latitude_Of_Origin",0.0],UNIT["Meter",1.0]]`
const SIRGAS19S = 'PROJCS["SIRGAS_2000_UTM_Zone_19S",GEOGCS["GCS_SIRGAS_2000",DATUM["D_SIRGAS_2000",SPHEROID["GRS_1980",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",500000.0],PARAMETER["False_Northing",10000000.0],PARAMETER["Central_Meridian",-69.0],PARAMETER["Scale_Factor",0.9996],PARAMETER["Latitude_Of_Origin",0.0],UNIT["Meter",1.0]]'
const OGC32719 = 'PROJCS["WGS 84 / UTM zone 19S",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563,AUTHORITY["EPSG","7030"]],AUTHORITY["EPSG","6326"]],PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],AUTHORITY["EPSG","4326"]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",0],PARAMETER["central_meridian",-69],PARAMETER["scale_factor",0.9996],PARAMETER["false_easting",500000],PARAMETER["false_northing",10000000],UNIT["metre",1,AUTHORITY["EPSG","9001"]],AXIS["Easting",EAST],AXIS["Northing",NORTH],AUTHORITY["EPSG","32719"]]'
const MERC_AUX = `PROJCS["WGS_1984_Web_Mercator_Auxiliary_Sphere",${GEOGCS_WGS},PROJECTION["Mercator_Auxiliary_Sphere"],PARAMETER["False_Easting",0.0],PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",0.0],PARAMETER["Standard_Parallel_1",0.0],PARAMETER["Auxiliary_Sphere_Type",0.0],UNIT["Meter",1.0]]`

test('crsFromWkt: .prj de ESRI y WKT de OGC con AUTHORITY y AXIS', () => {
  const esri = wkt(UTM19S)
  assert.deepEqual([esri.name, esri.kind, esri.lon0, esri.fn], ['WGS_1984_UTM_Zone_19S', 2, -69, 10000000])
  const ogc = wkt(OGC32719)
  assert.deepEqual([ogc.name, ogc.kind, ogc.k0], ['EPSG:32719', 2, 0.9996])
  assert.deepEqual(inv(ogc, 350000, 6300000), inv(crsFromEpsg(32719), 350000, 6300000))
  assert.equal(wkt(GEOGCS_WGS).kind, 0)
  assert.equal(wkt(MERC_AUX).kind, 1)
  // Paréntesis en lugar de corchetes también es WKT1.
  assert.equal(wkt(GEOGCS_WGS.replaceAll('[', '(').replaceAll(']', ')')).kind, 0)
})

test('crsFromWkt: SIRGAS sobre GRS80 se lee como WGS84 sin desplazamiento (D-2)', () => {
  const crs = wkt(SIRGAS19S)
  assert.equal(crs.kind, 2)
  assert.ok(Math.abs(1 / crs.f - 298.257222101) < 1e-9)
})

test('crsFromWkt: la unidad lineal entra con su factor (pie de EE. UU.)', () => {
  const pies = UTM19S.replace('PARAMETER["False_Easting",500000.0]', 'PARAMETER["False_Easting",1640416.6667]')
    .replace('PARAMETER["False_Northing",10000000.0]', 'PARAMETER["False_Northing",32808333.3333]')
    .replace('UNIT["Meter",1.0]]', 'UNIT["Foot_US",0.3048006096012192]]')
  const crs = wkt(pies)
  const [lng, lat] = inv(crs, 350000 / 0.3048006096012192, 6300000 / 0.3048006096012192)
  const [lngM, latM] = inv(crsFromEpsg(32719), 350000, 6300000)
  assert.ok(Math.abs(lng - lngM) < 1e-8 && Math.abs(lat - latM) < 1e-8)
})

test('crsFromWkt: datum con desplazamiento, PRIMEM, unidad angular, ejes invertidos y proyecciones fuera son null', () => {
  ;[
    UTM19S.replace('D_WGS_1984', 'D_Provisional_S_American_1956').replace('SPHEROID["WGS_1984",6378137.0,298.257223563]', 'SPHEROID["International_1924",6378388.0,297.0]'),
    UTM19S.replace('D_WGS_1984', 'D_South_American_1969'),
    GEOGCS_WGS.replace('PRIMEM["Greenwich",0.0]', 'PRIMEM["Paris",2.33722917]'),
    GEOGCS_WGS.replace('UNIT["Degree",0.0174532925199433]', 'UNIT["Grad",0.01570796326794897]'),
    OGC32719.replace('AXIS["Easting",EAST],AXIS["Northing",NORTH]', 'AXIS["Northing",NORTH],AXIS["Easting",EAST]'),
    OGC32719.replace('AXIS["Easting",EAST],AXIS["Northing",NORTH]', 'AXIS["Westing",WEST],AXIS["Southing",SOUTH]'),
    UTM19S.replace('Transverse_Mercator', 'Transverse_Mercator_South_Orientated'),
    UTM19S.replace('Transverse_Mercator', 'Lambert_Conformal_Conic'),
    UTM19S.replace('PARAMETER["Latitude_Of_Origin",0.0]', 'PARAMETER["Latitude_Of_Origin",49.0]'),
    GEOGCS_WGS.replace('DATUM["D_WGS_1984"', 'DATUM["D_WGS_1984",TOWGS84[1,2,3,0,0,0,0]'),
    UTM19S.replace('UNIT["Meter",1.0]]', 'UNIT["Meter",-1.0]]'),
  ].forEach((t, k) => assert.equal(wkt(t), null, `caso ${k}`))
})

test('crsFromWkt: lo que no es WKT1 bien formado es null, nunca una excepción', () => {
  ;['', 'GEOGCS', 'GEOGCS[', 'GEOGCS["a"', 'PROJCS["x",]', '{"type":"name"}', 'GEOGCS["a"]]]]', '[[[[',
    'A['.repeat(5000), 'GEOGCS["sin cerrar', 'PROJCS["x",GEOGCS["y",DATUM["z",SPHEROID["w",1e999,1]]]]',
  ].forEach(t => assert.equal(wkt(t), null, t.slice(0, 20)))
})

test('crsFromWkt respeta from y to', () => {
  const bytes = enc.encode(`xx${GEOGCS_WGS}yy`)
  assert.equal(crsFromWkt(bytes, 2, bytes.length - 2).kind, 0)
})

test('isGeographic: −1 si todo cabe, si no el índice del primero que no; NaN no cabe', () => {
  assert.equal(isGeographic(new Float64Array([-180, -90, 180, 90]), 0, 2), -1)
  assert.equal(isGeographic(new Float64Array([0, 0, 180.0001, 0, 500000, 0]), 0, 3), 1)
  assert.equal(isGeographic(new Float64Array([0, 0, NaN, 0]), 0, 2), 1)
  assert.equal(isGeographic(new Float64Array([500000, 0, 0, 0]), 1, 2), -1)
})

test('toLngLat devuelve false si sale NaN, y es no-op en geográfico', () => {
  const xy = new Float64Array([NaN, 0])
  assert.equal(toLngLat(crsFromEpsg(3857), xy, 0, 1), false)
  const g = new Float64Array([1, 2])
  assert.equal(toLngLat(crsFromEpsg(4326), g, 0, 1), true)
  assert.deepEqual([...g], [1, 2])
})

// `options.crs` (§1.5) es la misma regla para los ocho lectores: ausente es null, otro tipo es
// 'entrada' y un CRS sin soporte es 'crs' con lo pedido en el mensaje.
test('optionCrs: código, nombre o WKT1; null sin opción; entrada y crs en los rechazos', () => {
  assert.equal(optionCrs(undefined, 'wkt'), null)
  assert.equal(optionCrs(null, 'wkt'), null)
  assert.equal(optionCrs(32719, 'wkt').name, 'EPSG:32719')
  assert.equal(optionCrs('EPSG:3857', 'wkt').name, 'EPSG:3857')
  assert.equal(optionCrs('GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["Degree",0.0174532925199433]]', 'wkt').kind, 0)
  assert.throws(() => optionCrs({}, 'shapefile'), e => e.name === 'FormatError' && e.code === 'entrada' && e.format === 'shapefile')
  assert.throws(() => optionCrs(4269, 'flatgeobuf'),
    e => e.code === 'crs' && e.at === -1 && e.hint === null && e.message === 'flatgeobuf: crs: 4269')
})
