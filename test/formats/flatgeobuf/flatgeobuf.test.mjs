// Lector de FlatGeobuf (DISENO-INTEROP §3.8). Lo esperado de la geometría sale del oráculo de GeoJSON
// sobre la misma colección que escribe el generador; el generador se contrasta antes contra dos
// fixtures hex escritos a mano (§5-3bis).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFlatGeobuf } from '../../../src/formats/flatgeobuf.js'
import { FormatError } from '../../../src/formats/core/error.js'
import { areasOf } from '../../../src/geojson/geojson.js'
import { oraculo, comparar } from '../../geojson/oraculo.mjs'
import { escribirFgb, serializar, tabla, escalar, ref, vector, tablas, geometria, nodosDelIndice } from './escritor.mjs'
import { PUNTO, LINEA } from './fixtures.mjs'

const fc      = (...geometrias) => ({ type: 'FeatureCollection', features: geometrias.map(geometry => ({ type: 'Feature', properties: null, geometry })) })
const iguales = (read, coleccion) => assert.deepEqual(comparar(read, oraculo(coleccion)), [])
const falla   = (fn, code) => assert.throws(fn, e => e instanceof FormatError && e.format === 'flatgeobuf' && e.code === code)

// Un archivo con la cabecera del escritor (sin conteo ni índice) y features armados a mano.
const largo   = bytes => Uint8Array.from([...new Uint8Array(new Uint32Array([bytes.length]).buffer), ...bytes])
const archivo = (features, opciones = {}) => Uint8Array.from([
  ...escribirFgb(fc(), { tipo: 0, conteo: false, ...opciones }),
  ...features.flatMap(f => [...largo(serializar(f))]),
])
const conGeometria = g => tabla([ref(g)])

const EXT  = (x, y, s = 10) => [[x, y], [x + s, y], [x + s, y + s], [x, y + s], [x, y]]
const HOYO = (x, y, s = 2) => [[x, y], [x, y + s], [x + s, y + s], [x + s, y], [x, y]]

// ── el generador contra los fixtures a mano ─────────────────────────────────────────────────────

test('fixture: Point a mano, contra el oráculo y contra el generador', () => {
  const coleccion = fc({ type: 'Point', coordinates: [-70.5, -33.25] })
  const read      = readFlatGeobuf(PUNTO)
  iguales(read, coleccion)
  assert.deepEqual(comparar(readFlatGeobuf(escribirFgb(coleccion, { nodo: 0, conteo: false })), read), [])
  assert.equal(read.format, 'flatgeobuf')
  assert.equal(read.crs, 'EPSG:4326')
  assert.equal(read.propertiesOf(0), null)
  assert.deepEqual(read.layers, [{ name: null, parent: -1 }])
})

test('fixture: LineString con z y tipo por feature, contra el oráculo y contra el generador', () => {
  const coleccion = fc({ type: 'LineString', coordinates: [[1, 2, 10], [3, 4, 20]] })
  const read      = readFlatGeobuf(LINEA)
  iguales(read, coleccion)
  assert.deepEqual(comparar(readFlatGeobuf(escribirFgb(coleccion, { tipo: 0, nodo: 0, z: true })), read), [])
})

test('generador: el tamaño del índice sigue el bucle de la referencia', () => {
  assert.equal(nodosDelIndice(1, 16), 2)
  assert.equal(nodosDelIndice(20, 16), 23)
  assert.equal(nodosDelIndice(256, 16), 256 + 16 + 1)
})

// ── geometría contra el oráculo ─────────────────────────────────────────────────────────────────

const TODAS = fc(
  { type: 'Point', coordinates: [1, 2] },
  { type: 'MultiPoint', coordinates: [[1, 2], [3, 4]] },
  { type: 'LineString', coordinates: [[0, 0], [1, 1], [2, 0]] },
  { type: 'MultiLineString', coordinates: [[[0, 0], [1, 1]], [[5, 5], [6, 6], [7, 5]]] },
  { type: 'MultiLineString', coordinates: [[[0, 0], [1, 1]]] },
  { type: 'Polygon', coordinates: [EXT(0, 0), HOYO(2, 2), HOYO(6, 6)] },
  { type: 'Polygon', coordinates: [EXT(0, 0)] },
  { type: 'MultiPolygon', coordinates: [[EXT(0, 0), HOYO(2, 2)], [EXT(20, 0)]] },
  null,
  { type: 'GeometryCollection', geometries: [
    { type: 'Point', coordinates: [9, 9] },
    { type: 'GeometryCollection', geometries: [{ type: 'LineString', coordinates: [[0, 0], [1, 1]] }] },
    { type: 'Polygon', coordinates: [EXT(30, 30)] },
  ] },
)

test('tipos: los seis, nulos y colecciones anidadas que se aplanan, con cabecera Unknown', () => {
  iguales(readFlatGeobuf(escribirFgb(TODAS, { tipo: 0 })), TODAS)
})

test('tipos: con la cabecera fija, el tipo del feature no hace falta', () => {
  ;[
    fc({ type: 'Polygon', coordinates: [EXT(0, 0), HOYO(2, 2)] }, { type: 'Polygon', coordinates: [] }),
    fc({ type: 'MultiPolygon', coordinates: [[EXT(0, 0)], [EXT(20, 0), HOYO(22, 2)]] }),
    fc({ type: 'MultiPoint', coordinates: [[1, 2]] }, { type: 'MultiPoint', coordinates: [] }),
    fc({ type: 'GeometryCollection', geometries: [{ type: 'Point', coordinates: [1, 1] }] }),
  ].forEach(coleccion => iguales(readFlatGeobuf(escribirFgb(coleccion)), coleccion))
})

test('z y m: z va a z; m se descarta contándola', () => {
  const coleccion = fc({ type: 'LineString', coordinates: [[0, 0, 5], [1, 1, 6], [2, 2, 7]] })
  const read      = readFlatGeobuf(escribirFgb(coleccion, { z: true, m: true }))
  iguales(read, coleccion)
  assert.equal(read.stats.extraOrdinates, 3)
})

test('curvas, superficies y TIN se saltan y se cuentan; el feature y el resto de la colección quedan', () => {
  const curva = tabla([undefined, ref(vector('f64', [0, 0, 1, 1, 2, 0])), undefined, undefined, undefined, undefined, escalar('u8', 8)])
  const punto = tabla([undefined, ref(vector('f64', [5, 5])), undefined, undefined, undefined, undefined, escalar('u8', 1)])
  const mixta = tabla([undefined, undefined, undefined, undefined, undefined, undefined, escalar('u8', 7), ref(tablas([curva, punto]))])
  const read  = readFlatGeobuf(archivo([conGeometria(curva), conGeometria(mixta)]))
  assert.equal(read.featureCount, 2)
  assert.equal(read.stats.skippedGeometries, 2)
  iguales(read, fc(null, { type: 'Point', coordinates: [5, 5] }))
})

test('polígonos: areasOf sirve sin cambios (§5-3ter)', () => {
  const read  = readFlatGeobuf(escribirFgb(fc({ type: 'MultiPolygon', coordinates: [[EXT(0, 0), HOYO(2, 2)], [EXT(20, 0)]] })))
  const areas = areasOf(read)
  assert.deepEqual([...areas.parts], [0, 1])
  assert.deepEqual([...areas.rings], [0, 1, 2])
  assert.deepEqual([...areas.owner], [0, 0])
  assert.equal(read.stats.reversedRings, 0)
})

// ── propiedades ─────────────────────────────────────────────────────────────────────────────────

const COLUMNAS = ['i8', 'u8', 'bool', 'i16', 'u16', 'i32', 'u32', 'i64', 'u64', 'f32', 'f64', 'texto', 'json', 'fecha', 'binario']
  .map((nombre, tipo) => ({ nombre, tipo }))

test('propiedades: un valor por ColumnType', () => {
  const props = {
    i8: -5, u8: 200, bool: true, i16: -300, u16: 60000, i32: -70000, u32: 4000000000, i64: -9007199254740993n, u64: 42,
    f32: 1.5, f64: 0.1, texto: 'ñandú', json: '{"a":1}', fecha: '2026-11-03T00:00:00Z', binario: Uint8Array.of(1, 2, 3),
  }
  const read = readFlatGeobuf(escribirFgb({ type: 'FeatureCollection', features: [
    { type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: [0, 0] } },
    { type: 'Feature', properties: { texto: 'sólo' }, geometry: { type: 'Point', coordinates: [1, 1] } },
  ] }, { columnas: COLUMNAS }))
  assert.deepEqual(read.propertiesOf(0), props)
  assert.deepEqual(read.propertiesOf(1), { texto: 'sólo' })
  assert.equal(read.propertiesOf(2), null)
  read.release()
  assert.throws(() => read.propertiesOf(0), e => e instanceof FormatError && e.code === 'liberado')
})

test('propiedades: una columna inexistente o un valor cortado es properties al pedirlo', () => {
  const columnas = [{ nombre: 'n', tipo: 5 }]
  const malos    = [[9, 0, 1, 0, 0, 0], [0, 0, 1, 0], [0]]
  const read     = readFlatGeobuf(archivo(malos.map(p => tabla([undefined, ref(vector('u8', p))])), { columnas }))
  assert.equal(read.featureCount, 3)
  ;[0, 1, 2].forEach(f => assert.throws(() => read.propertiesOf(f), e => e instanceof FormatError && e.code === 'properties'))
})

test('propiedades: una columna __proto__ es una clave, no el prototipo', () => {
  const columnas = [{ nombre: '__proto__', tipo: 14 }, { nombre: 'b', tipo: 5 }]
  const props    = Object.fromEntries([['__proto__', Uint8Array.of(1)], ['b', 2]])
  const p        = readFlatGeobuf(escribirFgb({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: props, geometry: null }] },
    { tipo: 1, columnas })).propertiesOf(0)
  assert.equal(Object.getPrototypeOf(p), Object.prototype)
  assert.deepEqual(Object.keys(p), ['__proto__', 'b'])
  assert.deepEqual([...Object.getOwnPropertyDescriptor(p, '__proto__').value], [1])
})

test('propiedades: columns por feature se cuenta como miembro ajeno', () => {
  const read = readFlatGeobuf(archivo([tabla([undefined, undefined, ref(tablas([]))])]))
  assert.equal(read.stats.foreignMembers, 1)
})

// ── cabecera e índice ───────────────────────────────────────────────────────────────────────────

const VEINTE = fc(...Array.from({ length: 20 }, (_, k) => ({ type: 'Point', coordinates: [k, -k] })))

test('índice: se salta con nodo explícito, con el default de 16, sin conteo o con nodo 0', () => {
  ;[{ nodo: 16 }, {}, { nodo: 4 }, { conteo: false }, { nodo: 0 }].forEach(opciones =>
    iguales(readFlatGeobuf(escribirFgb(VEINTE, opciones)), VEINTE))
  iguales(readFlatGeobuf(escribirFgb(fc({ type: 'Point', coordinates: [1, 1] }))), fc({ type: 'Point', coordinates: [1, 1] }))
})

test('índice: nodo 1 no forma árbol; un índice que no cabe es truncado', () => {
  falla(() => readFlatGeobuf(escribirFgb(VEINTE, { nodo: 1 })), 'estructura')
  const fgb = escribirFgb(VEINTE, { nodo: 16 })
  falla(() => readFlatGeobuf(fgb.subarray(0, 200)), 'truncado')
})

test('cabecera: mágico, versión, largos y tipo', () => {
  const con = (pos, v) => { const c = PUNTO.slice(); c[pos] = v; return c }
  falla(() => readFlatGeobuf(con(1, 0x68)), 'formato')
  falla(() => readFlatGeobuf(con(5, 0x68)), 'formato')
  falla(() => readFlatGeobuf(con(3, 2)), 'version')
  falla(() => readFlatGeobuf(PUNTO.subarray(0, 11)), 'truncado')
  falla(() => readFlatGeobuf(PUNTO.subarray(0, 40)), 'truncado')
  falla(() => readFlatGeobuf(con(44, 18)), 'tipo')
  falla(() => readFlatGeobuf(42), 'entrada')
})

test('features: de más tras el conteo es estructura; uno cortado es truncado', () => {
  const fgb = escribirFgb(VEINTE, { nodo: 0 })
  falla(() => readFlatGeobuf(Uint8Array.from([...fgb, 0, 0, 0, 0])), 'estructura')
  falla(() => readFlatGeobuf(fgb.subarray(0, fgb.length - 1)), 'truncado')
  const sin = escribirFgb(VEINTE, { conteo: false })
  falla(() => readFlatGeobuf(sin.subarray(0, sin.length - 2)), 'truncado')
})

test('geometría: offsets, vectores y conteos que mienten son estructura', () => {
  const xy = valores => ref(vector('f64', valores))
  falla(() => readFlatGeobuf(archivo([conGeometria(tabla([undefined, xy([1, 2, 3]), undefined, undefined, undefined, undefined, escalar('u8', 2)]))])), 'estructura')
  falla(() => readFlatGeobuf(archivo([conGeometria(tabla([ref(vector('u32', [3])), xy([0, 0, 1, 1]), undefined, undefined, undefined, undefined, escalar('u8', 3)]))])), 'estructura')
  falla(() => readFlatGeobuf(archivo([conGeometria(tabla([ref(vector('u32', [2, 1])), xy([0, 0, 1, 1]), undefined, undefined, undefined, undefined, escalar('u8', 3)]))])), 'estructura')
  falla(() => readFlatGeobuf(archivo([conGeometria(tabla([ref(vector('u32', [1])), xy([0, 0, 1, 1]), undefined, undefined, undefined, undefined, escalar('u8', 3)]))])), 'estructura')
  falla(() => readFlatGeobuf(archivo([conGeometria(tabla([undefined, xy([0, 0, 1, 1]), ref(vector('f64', [1])), undefined, undefined, undefined, escalar('u8', 2)]))])), 'estructura')
  falla(() => readFlatGeobuf(archivo([conGeometria(tabla([undefined, xy([0, 0, 1, 1]), undefined, undefined, undefined, undefined, escalar('u8', 1)]))])), 'estructura')
  falla(() => readFlatGeobuf(archivo([conGeometria(tabla([undefined, xy([0, 0])]))])), 'tipo')
  falla(() => readFlatGeobuf(archivo([conGeometria(tabla([undefined, xy([0, 0]), undefined, undefined, undefined, undefined, escalar('u8', 30)]))])), 'tipo')
  // Un uoffset que apunta fuera del feature.
  const malo   = archivo([conGeometria(geometria({ type: 'Point', coordinates: [1, 1] }, true))])
  const inicio = escribirFgb(fc(), { tipo: 0, conteo: false }).length + 4
  new DataView(malo.buffer).setUint32(inicio, 1 << 20, true)
  falla(() => readFlatGeobuf(malo), 'estructura')
})

test('geometría: una coordenada no finita es numero (§1.6-4)', () => {
  falla(() => readFlatGeobuf(escribirFgb(fc({ type: 'LineString', coordinates: [[0, 0], [NaN, 1]] }))), 'numero')
  falla(() => readFlatGeobuf(escribirFgb(fc({ type: 'Point', coordinates: [Infinity, 1] }))), 'numero')
  falla(() => readFlatGeobuf(escribirFgb(fc({ type: 'Point', coordinates: [1, 1, NaN] }), { z: true })), 'numero')
})

// ── amplificación y recursión ───────────────────────────────────────────────────────────────────

test('amplificación: partes que repiten la misma tabla no multiplican la salida (§1.6-3)', () => {
  const poligono = geometria({ type: 'Polygon', coordinates: [Array.from({ length: 100 }, (_, k) => [k, k % 2])] }, false)
  const multi    = tabla([undefined, undefined, undefined, undefined, undefined, undefined, escalar('u8', 6), ref(tablas(Array(1000).fill(poligono)))])
  const fgb      = archivo([conGeometria(multi)])
  assert.ok(fgb.length < 8000)
  falla(() => readFlatGeobuf(fgb), 'estructura')

  let nivel = geometria({ type: 'Point', coordinates: [1, 1] }, true)
  for (let k = 0; k < 40; k++)
    nivel = tabla([undefined, undefined, undefined, undefined, undefined, undefined, escalar('u8', 7), ref(tablas([nivel, nivel]))])
  falla(() => readFlatGeobuf(archivo([conGeometria(nivel)])), 'estructura')
})

test('recursión: 100 mil colecciones anidadas son profundidad, no un RangeError (§1.5)', () => {
  // Una vtable compartida en 20 y una tabla de 12 bytes más su vector de partes por nivel.
  const niveles = 100000
  const size    = 40 + 20 * niveles - 4
  const f       = new DataView(new ArrayBuffer(size))
  f.setUint32(0, 12, true)                                  // raíz: Feature en 12
  ;[6, 8, 4, 0].forEach((v, k) => f.setUint16(4 + 2 * k, v, true))   // vtable de Feature: geometry en +4
  f.setInt32(12, 8, true)
  f.setUint32(16, 24, true)                                 // geometry en 40
  ;[20, 12, 0, 0, 0, 0, 0, 0, 8, 4].forEach((v, k) => f.setUint16(20 + 2 * k, v, true))   // type en +8, parts en +4
  for (let k = 0; k < niveles; k++) {
    const t = 40 + 20 * k
    f.setInt32(t, t - 20, true)
    f.setUint32(t + 4, 8, true)
    f.setUint8(t + 8, 7)
    f.setUint32(t + 12, k + 1 < niveles ? 1 : 0, true)
    k + 1 < niveles && f.setUint32(t + 16, 4, true)
  }
  const fgb = Uint8Array.from([...escribirFgb(fc(), { tipo: 0, conteo: false }), ...largo(new Uint8Array(f.buffer))])
  falla(() => readFlatGeobuf(fgb), 'profundidad')
  falla(() => readFlatGeobuf(fgb, { maxDepth: 2000 }), 'profundidad')
  // Una cota más alta que la pila: la recursión se agota antes y sigue siendo profundidad.
  falla(() => readFlatGeobuf(fgb, { maxDepth: 1e9 }), 'profundidad')
  ;[Infinity, 'x', 0, 1.5].forEach(maxDepth => falla(() => readFlatGeobuf(fgb, { maxDepth }), 'entrada'))
})

// ── CRS ─────────────────────────────────────────────────────────────────────────────────────────

const UTM19S = 'PROJCS["WGS_1984_UTM_Zone_19S",GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],' +
  'PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",500000.0],' +
  'PARAMETER["False_Northing",10000000.0],PARAMETER["Central_Meridian",-69.0],PARAMETER["Scale_Factor",0.9996],' +
  'PARAMETER["Latitude_Of_Origin",0.0],UNIT["Meter",1.0]]'

test('CRS: org + code, CRS84, WKT, y lo no soportado es crs', () => {
  // 3857: x = a·λ, así que a·π/180 metros es un grado.
  const metro = fc({ type: 'Point', coordinates: [6378137 * Math.PI / 180, 0] })
  const read  = readFlatGeobuf(escribirFgb(metro, { crs: { org: 'EPSG', code: 3857 } }))
  assert.equal(read.crs, 'EPSG:3857')
  assert.ok(Math.abs(read.xy[0] - 1) < 1e-12 && Math.abs(read.xy[1]) < 1e-12)
  assert.equal(readFlatGeobuf(escribirFgb(metro, { crs: { code: 3857 } })).crs, 'EPSG:3857')
  assert.equal(readFlatGeobuf(escribirFgb(fc({ type: 'Point', coordinates: [1, 1] }), { crs: { code: 4326 } })).crs, 'EPSG:4326')
  assert.ok(readFlatGeobuf(escribirFgb(fc({ type: 'Point', coordinates: [1, 1] }), { crs: { org: 'OGC', codeString: 'CRS84' } })).crs)
  const utm = readFlatGeobuf(escribirFgb(fc({ type: 'Point', coordinates: [500000, 10000000] }), { crs: { wkt: UTM19S } }))
  assert.ok(Math.abs(utm.xy[0] - -69) < 1e-9 && Math.abs(utm.xy[1]) < 1e-9)
  falla(() => readFlatGeobuf(escribirFgb(metro, { crs: { org: 'EPSG', code: 2000 } })), 'crs')
  falla(() => readFlatGeobuf(escribirFgb(metro, { crs: { org: 'IGNF', code: 7 } })), 'crs')
})

test('CRS: sin crs declarado, proyectado declara EPSG:4326 y avisa, y options.crs lo resuelve', () => {
  const fgb = escribirFgb(fc({ type: 'Point', coordinates: [500000, 10000000] }))
  const fuera = readFlatGeobuf(fgb)
  assert.equal(fuera.crs, 'EPSG:4326')
  assert.deepEqual(fuera.warnings.map(w => w.code), ['crs'])
  const read = readFlatGeobuf(fgb, { crs: 32719 })
  assert.equal(read.crs, 'EPSG:32719')
  assert.ok(Math.abs(read.xy[0] - -69) < 1e-9)
  // Una tabla Crs sin código ni WKT es no declarado, y la fuente gana a la opción cuando declara.
  assert.equal(readFlatGeobuf(escribirFgb(fc({ type: 'Point', coordinates: [500000, 10000000] }), { crs: {} }), { crs: 'EPSG:32719' }).crs, 'EPSG:32719')
  assert.equal(readFlatGeobuf(escribirFgb(fc({ type: 'Point', coordinates: [1, 1] }), { crs: { code: 4326 } }), { crs: 32719 }).crs, 'EPSG:4326')
  falla(() => readFlatGeobuf(fgb, { crs: 'EPSG:2000' }), 'crs')
})

// ── salidas y fuzz ──────────────────────────────────────────────────────────────────────────────

test('salidas: Uint8Array, ArrayBuffer, vista desplazada y Buffer de pool dan lo mismo (§5-5)', () => {
  const fgb     = escribirFgb(TODAS, { tipo: 0, columnas: COLUMNAS })
  const base    = readFlatGeobuf(fgb)
  const corrido = new Uint8Array(fgb.length + 5)
  corrido.set(fgb, 5)
  ;[fgb.buffer, corrido.subarray(5), Buffer.from(fgb), new DataView(fgb.buffer)].forEach(entrada =>
    assert.deepEqual(comparar(readFlatGeobuf(entrada), base), []))
})

test('bounds, capacityHint y maxDepth', () => {
  const read = readFlatGeobuf(escribirFgb(fc({ type: 'Polygon', coordinates: [EXT(0, 0)] })), { bounds: true, capacityHint: 3 })
  assert.deepEqual([...read.bounds], [0, 0, 10, 10])
  falla(() => readFlatGeobuf(escribirFgb(TODAS, { tipo: 0 }), { maxDepth: 1 }), 'profundidad')
  assert.equal(readFlatGeobuf(escribirFgb(TODAS, { tipo: 0 }), { maxDepth: 2 }).featureCount, 10)
})

test('fuzz: un byte cambiado sólo produce FormatError (§5-6)', () => {
  const props = { i8: 1, texto: 'a', binario: Uint8Array.of(9), f64: 2 }
  const fgb   = escribirFgb({ type: 'FeatureCollection', features: TODAS.features.map(f => ({ ...f, properties: props })) },
    { tipo: 0, columnas: COLUMNAS, nodo: 4 })
  let semilla = 11
  const azar = n => (semilla = (semilla * 1103515245 + 12345) >>> 0) % n
  const fin  = Date.now() + 1500
  let casos = 0
  while (Date.now() < fin) {
    const m = fgb.slice()
    for (let k = azar(4); k >= 0; k--) m[azar(m.length)] = azar(256)
    try {
      const read = readFlatGeobuf(m)
      for (let f = 0; f < read.featureCount; f++) {
        try { read.propertiesOf(f) }
        catch (e) { assert.ok(e instanceof FormatError, `propertiesOf: ${e}`) }
      }
    }
    catch (e) { assert.ok(e instanceof FormatError, `caso ${casos}: ${e}`) }
    casos++
  }
  assert.ok(casos > 100)
})
