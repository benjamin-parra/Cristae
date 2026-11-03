// Lector de Shapefile y .dbf (DISENO-INTEROP §3.7). Lo esperado de la geometría sale del oráculo de
// GeoJSON sobre la misma colección que escribe el generador; el generador se contrasta antes contra
// fixtures hex escritos a mano (§5-3bis).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readShapefile, readShapefileZip } from '../../../src/formats/shapefile.js'
import { FormatError } from '../../../src/formats/core/error.js'
import { areasOf } from '../../../src/geojson/geojson.js'
import { oraculo, comparar } from '../../geojson/oraculo.mjs'
import { escribirShp, escribirDbf, escribirZip, latin1 } from './escritor.mjs'
import { PUNTO, CUADRADO, ATRIBUTOS } from './fixtures.mjs'

const fc      = (...geometrias) => ({ type: 'FeatureCollection', features: geometrias.map(geometry => ({ type: 'Feature', properties: null, geometry })) })
const iguales = (read, coleccion) => assert.deepEqual(comparar(read, oraculo(coleccion)), [])
const falla   = (fn, code) => assert.throws(fn, e => e instanceof FormatError && e.format === 'shapefile' && e.code === code)
const rechaza = (promesa, code) => assert.rejects(promesa, e => e instanceof FormatError && e.code === code)

// Exterior horario e interior antihorario: la orientación de «Polygon» en la descripción técnica.
const EXT  = (x, y, s = 10) => [[x, y], [x, y + s], [x + s, y + s], [x + s, y], [x, y]]
const HOYO = (x, y, s = 2) => [[x, y], [x + s, y], [x + s, y + s], [x, y + s], [x, y]]

// ── el generador contra los fixtures a mano ─────────────────────────────────────────────────────

test('generador: el Point escrito a mano y el generado son el mismo archivo', () => {
  assert.deepEqual(escribirShp(fc({ type: 'Point', coordinates: [-70.5, -33.25] })).subarray(100), PUNTO.subarray(100))
})

test('generador: el Polygon escrito a mano y el generado tienen el mismo registro', () => {
  assert.deepEqual(escribirShp(fc({ type: 'Polygon', coordinates: [EXT(0, 0, 1)] })).subarray(100), CUADRADO.subarray(100))
})

test('generador: el .dbf escrito a mano y el generado son el mismo archivo', () => {
  const campos = [{ nombre: 'nombre', tipo: 'C', largo: 10 }, { nombre: 'valor', tipo: 'N', largo: 5 }]
  assert.deepEqual(escribirDbf(campos, [['Ñuble', '42']]), ATRIBUTOS)
})

// ── fixtures a mano ─────────────────────────────────────────────────────────────────────────────

test('fixture: Point con su .dbf', () => {
  const read = readShapefile({ shp: PUNTO, dbf: ATRIBUTOS })
  iguales(read, fc({ type: 'Point', coordinates: [-70.5, -33.25] }))
  assert.equal(read.format, 'shapefile')
  assert.equal(read.crs, null)
  assert.deepEqual(read.propertiesOf(0), { nombre: 'Ñuble', valor: 42 })
  assert.equal(read.idOf(0), null)
  assert.deepEqual(read.layers, [{ name: null, parent: -1 }])
})

test('fixture: el cuadrado horario es un Polygon sin anillos invertidos', () => {
  const read = readShapefile({ shp: CUADRADO })
  iguales(read, fc({ type: 'Polygon', coordinates: [EXT(0, 0, 1)] }))
  assert.equal(read.stats.reversedRings, 0)
  assert.equal(read.propertiesOf(0), null)
})

// ── geometría contra el oráculo ─────────────────────────────────────────────────────────────────

test('tipos: Point, MultiPoint, PolyLine de una y de varias partes, nulos', () => {
  ;[
    fc({ type: 'Point', coordinates: [1, 2] }, null, { type: 'Point', coordinates: [3, 4] }),
    fc({ type: 'MultiPoint', coordinates: [[1, 2], [3, 4], [5, 6]] }, { type: 'MultiPoint', coordinates: [[7, 8]] }),
    fc({ type: 'LineString', coordinates: [[0, 0], [1, 1], [2, 0]] },
      { type: 'MultiLineString', coordinates: [[[0, 0], [1, 1]], [[5, 5], [6, 6], [7, 5]]] }),
  ].forEach(coleccion => iguales(readShapefile({ shp: escribirShp(coleccion) }), coleccion))
})

test('polígonos: los hoyos van a su exterior aunque el archivo los liste después de todos', () => {
  // El archivo trae exterior A, exterior B, hoyo de B, hoyo de A; la salida reagrupa (§2.4).
  const shp = escribirShp(fc({ type: 'MultiPolygon', coordinates: [[EXT(0, 0)], [EXT(20, 0)], [HOYO(22, 2)], [HOYO(2, 2)]] }))
  const read = readShapefile({ shp })
  iguales(read, fc({ type: 'MultiPolygon', coordinates: [[EXT(0, 0), HOYO(2, 2)], [EXT(20, 0), HOYO(22, 2)]] }))
  assert.equal(read.stats.reversedRings, 0)
  assert.equal(read.stats.orphanHoles, 0)
})

test('polígonos: un hoyo sin exterior sale como exterior propio y se cuenta', () => {
  const read = readShapefile({ shp: escribirShp(fc({ type: 'MultiPolygon', coordinates: [[EXT(0, 0)], [HOYO(50, 50)]] })) })
  iguales(read, fc({ type: 'MultiPolygon', coordinates: [[EXT(0, 0)], [HOYO(50, 50)]] }))
  assert.equal(read.stats.orphanHoles, 1)
  assert.equal(read.stats.reversedRings, read.stats.orphanHoles)   // §1.3: forma cerrada en Shapefile
})

test('polígonos: areasOf sirve sin cambios (§5-3ter)', () => {
  const read  = readShapefile({ shp: escribirShp(fc({ type: 'Polygon', coordinates: [EXT(0, 0), HOYO(2, 2)] }, { type: 'Polygon', coordinates: [EXT(30, 0)] })) })
  const areas = areasOf(read)
  assert.deepEqual([...areas.parts], [0, 1])
  assert.deepEqual([...areas.rings], [0, 1, 2])
  assert.deepEqual([...areas.owner], [0, 1])
})

test('Z: llena z; el bloque de M es opcional y se descarta contándolo', () => {
  const coleccion = fc({ type: 'LineString', coordinates: [[0, 0, 5], [1, 1, 6]] })
  const sinM = readShapefile({ shp: escribirShp(coleccion, { variante: 10 }) })
  const conM = readShapefile({ shp: escribirShp(coleccion, { variante: 10, m: true }) })
  iguales(sinM, coleccion)
  iguales(conM, coleccion)
  assert.equal(sinM.stats.extraOrdinates, 0)
  assert.equal(conM.stats.extraOrdinates, 2)
})

test('Z y M en puntos y multipuntos', () => {
  const puntos = fc({ type: 'Point', coordinates: [1, 2, 3] })
  iguales(readShapefile({ shp: escribirShp(puntos, { variante: 10 }) }), puntos)
  iguales(readShapefile({ shp: escribirShp(puntos, { variante: 10, m: true }) }), puntos)
  const multi = fc({ type: 'MultiPoint', coordinates: [[1, 2, 3], [4, 5, 6]] })
  iguales(readShapefile({ shp: escribirShp(multi, { variante: 10, m: true }) }), multi)
  const medidos = fc({ type: 'MultiPoint', coordinates: [[1, 2], [4, 5]] })
  const read    = readShapefile({ shp: escribirShp(medidos, { variante: 20, m: true }) })
  iguales(read, medidos)
  assert.equal(read.z, null)
  assert.equal(read.stats.extraOrdinates, 2)
})

test('MultiPatch se salta y se cuenta; el feature queda sin geometría', () => {
  const shp  = escribirShp(fc(null), { tipo: 31 })
  const read = readShapefile({ shp })
  assert.equal(read.featureCount, 1)
  assert.equal(read.geometryCount, 0)
  // Un registro real de tipo 31: tipo y nada más alcanza para saltarlo.
  const real = shp.slice()
  real[108] = 31
  const saltado = readShapefile({ shp: real })
  assert.equal(saltado.stats.skippedGeometries, 1)
  assert.equal(saltado.geometryCount, 0)
})

// ── rechazos ────────────────────────────────────────────────────────────────────────────────────

const poner32 = (bytes, pos, v, be = false) => {
  const copia = bytes.slice()
  new DataView(copia.buffer).setInt32(pos, v, !be)
  return copia
}

test('cabecera: código, versión, tipo y largos', () => {
  falla(() => readShapefile({ shp: poner32(PUNTO, 0, 9995, true) }), 'formato')
  falla(() => readShapefile({ shp: poner32(PUNTO, 28, 1001) }), 'version')
  falla(() => readShapefile({ shp: poner32(PUNTO, 32, 2) }), 'tipo')
  falla(() => readShapefile({ shp: PUNTO.subarray(0, 99) }), 'truncado')
  falla(() => readShapefile({ shp: PUNTO.subarray(0, 120) }), 'truncado')
  falla(() => readShapefile({ shp: poner32(PUNTO, 24, 49, true) }), 'estructura')
  falla(() => readShapefile({}), 'entrada')
  falla(() => readShapefile({ shp: 42 }), 'entrada')
  falla(() => readShapefile({ shp: PUNTO, dbf: 42 }), 'entrada')
})

test('cabecera: lo que sigue al largo declarado no es del archivo', () => {
  const largo = new Uint8Array(PUNTO.length + 8)
  largo.set(PUNTO)
  assert.equal(readShapefile({ shp: largo }).featureCount, 1)
})

test('registros: largo, tipo distinto del de la cabecera y contenido corto', () => {
  falla(() => readShapefile({ shp: poner32(PUNTO, 104, 1, true) }), 'estructura')     // 2 bytes: menos que el tipo
  falla(() => readShapefile({ shp: poner32(PUNTO, 104, 12, true) }), 'truncado')      // pasa del archivo
  falla(() => readShapefile({ shp: poner32(PUNTO, 108, 3) }), 'estructura')           // registro PolyLine en archivo Point
  falla(() => readShapefile({ shp: poner32(poner32(PUNTO, 32, 11), 108, 11) }), 'truncado')   // PointZ sin Z
})

test('registros: un largo que no es ni con M ni sin M es estructura', () => {
  const shp = escribirShp(fc({ type: 'LineString', coordinates: [[0, 0, 1], [1, 1, 2]] }), { variante: 10 })
  const largo = new Uint8Array(shp.length + 8)
  largo.set(shp)
  const v = new DataView(largo.buffer)
  v.setInt32(24, largo.length / 2)
  v.setInt32(104, v.getInt32(104) + 4)
  falla(() => readShapefile({ shp: largo }), 'estructura')
})

test('Parts[]: debe abrir en 0, no decrecer y quedar bajo NumPoints', () => {
  const shp = escribirShp(fc({ type: 'MultiLineString', coordinates: [[[0, 0], [1, 1]], [[2, 2], [3, 3]]] }))
  // Registro en 108: tipo, caja (32), NumParts en 144, NumPoints en 148, Parts[] desde 152.
  falla(() => readShapefile({ shp: poner32(shp, 152, 1) }), 'estructura')
  falla(() => readShapefile({ shp: poner32(shp, 156, 4) }), 'estructura')
  falla(() => readShapefile({ shp: poner32(poner32(shp, 152, 0), 156, -1) }), 'estructura')
  falla(() => readShapefile({ shp: poner32(shp, 144, -1) }), 'estructura')
  falla(() => readShapefile({ shp: poner32(shp, 148, 1 << 28) }), 'truncado')
})

test('una coordenada no finita es numero (§1.6-4)', () => {
  const shp = PUNTO.slice()
  new DataView(shp.buffer).setFloat64(112, NaN, true)
  falla(() => readShapefile({ shp }), 'numero')
  new DataView(shp.buffer).setFloat64(112, Infinity, true)
  falla(() => readShapefile({ shp }), 'numero')
})

// ── .dbf ────────────────────────────────────────────────────────────────────────────────────────

const CAMPOS = [
  { nombre: 'texto', tipo: 'C', largo: 8 }, { nombre: 'entero', tipo: 'N', largo: 6 },
  { nombre: 'real', tipo: 'F', largo: 8 },  { nombre: 'logico', tipo: 'L', largo: 1 },
  { nombre: 'fecha', tipo: 'D', largo: 8 }, { nombre: 'memo', tipo: 'M', largo: 10 },
  { nombre: 'foxpro', tipo: 'I', largo: 4 },
]
const puntos = n => escribirShp(fc(...Array.from({ length: n }, (_, k) => ({ type: 'Point', coordinates: [k, k] }))))

test('dbf: un valor por tipo de campo, y los de fuera de la tabla salen null contados', () => {
  const dbf  = escribirDbf(CAMPOS, [
    ['árbol', '-12', '3.5e2', 'T', '20261103', '1', 'xxxx'],
    ['', '', '', '?', '', '', ''],
    ['x', '7', '.5', 'n', '19991231', '', ''],
  ], { borrados: [1] })
  const read = readShapefile({ shp: puntos(3), dbf })
  assert.deepEqual(read.propertiesOf(0), { texto: 'árbol', entero: -12, real: 350, logico: true, fecha: '2026-11-03', memo: null, foxpro: null })
  assert.deepEqual(read.propertiesOf(1), { texto: '', entero: null, real: null, logico: null, fecha: null, memo: null, foxpro: null })
  assert.deepEqual(read.propertiesOf(2), { texto: 'x', entero: 7, real: 0.5, logico: false, fecha: '1999-12-31', memo: null, foxpro: null })
  assert.equal(read.stats.deletedRecords, 1)
  assert.equal(read.stats.foreignMembers, 6)
  assert.equal(read.propertiesOf(3), null)
  assert.equal(read.propertiesOf(-1), null)
  assert.ok(read.bytes === dbf || read.bytes.buffer === dbf.buffer)
})

test('dbf: un valor que no decodifica es properties al pedirlo, no al leer', () => {
  const read = readShapefile({ shp: puntos(3), dbf: escribirDbf(CAMPOS.slice(1, 5), [['0x10'], ['', '', 'S'], ['', '', '', '2026-1']]) })
  ;[0, 1, 2].forEach(f => assert.throws(() => read.propertiesOf(f), e => e instanceof FormatError && e.code === 'properties'))
})

test('dbf: un campo __proto__ es una clave, no el prototipo', () => {
  const dbf = escribirDbf([{ nombre: '__proto__', tipo: 'C', largo: 3 }, { nombre: 'b', tipo: 'N', largo: 2 }], [['x', '7']])
  const p   = readShapefile({ shp: puntos(1), dbf }).propertiesOf(0)
  assert.equal(Object.getPrototypeOf(p), Object.prototype)
  assert.deepEqual(Object.entries(p), [['__proto__', 'x'], ['b', 7]])
})

test('dbf: liberado', () => {
  const read = readShapefile({ shp: PUNTO, dbf: ATRIBUTOS })
  read.release()
  assert.throws(() => read.propertiesOf(0), e => e instanceof FormatError && e.code === 'liberado')
})

test('dbf: codificación por opción, .cpg, language driver y windows-1252 por defecto', () => {
  const campo = [{ nombre: 'n', tipo: 'C', largo: 8 }]
  const utf8  = s => new TextEncoder().encode(s)
  const leer  = (dbf, extra = {}, options) => readShapefile({ shp: PUNTO, dbf, ...extra }, options).propertiesOf(0).n
  assert.equal(leer(escribirDbf(campo, [['Ñandú']])), 'Ñandú')
  assert.equal(leer(escribirDbf(campo, [['Ñandú']], { codificar: utf8 }), { cpg: 'UTF-8' }), 'Ñandú')
  assert.equal(leer(escribirDbf(campo, [['Ñandú']], { codificar: utf8 }), { cpg: latin1('65001\r\n') }), 'Ñandú')
  assert.equal(leer(escribirDbf(campo, [['Ñandú']], { codificar: utf8 }), {}, { encoding: 'utf-8' }), 'Ñandú')
  // 0xC9 es windows-1251: 0xC4 es «Д».
  assert.equal(leer(escribirDbf(campo, [['\xC4']], { ldid: 0xC9 })), 'Д')
  // La opción gana al .cpg.
  assert.equal(leer(escribirDbf(campo, [['Ñ']]), { cpg: 'UTF-8' }, { encoding: 'windows-1252' }), 'Ñ')
  falla(() => readShapefile({ shp: PUNTO, dbf: escribirDbf(campo, [['a']]) }, { encoding: 'klingon' }), 'codificacion')
  falla(() => readShapefile({ shp: PUNTO, dbf: escribirDbf(campo, [['a']]), cpg: 'klingon' }), 'codificacion')
})

test('dbf: versión, estructura y truncado', () => {
  const campo = [{ nombre: 'n', tipo: 'C', largo: 4 }]
  falla(() => readShapefile({ shp: PUNTO, dbf: escribirDbf(campo, [['a']], { version: 0x04 }) }), 'version')
  falla(() => readShapefile({ shp: PUNTO, dbf: escribirDbf(campo, [['a'], ['b']]) }), 'estructura')   // 1 en .shp, 2 en .dbf
  const largo = escribirDbf(campo, [['a']])
  largo[10] = 9
  falla(() => readShapefile({ shp: PUNTO, dbf: largo }), 'estructura')
  falla(() => readShapefile({ shp: PUNTO, dbf: ATRIBUTOS.subarray(0, 100) }), 'truncado')
  falla(() => readShapefile({ shp: PUNTO, dbf: ATRIBUTOS.subarray(0, 20) }), 'truncado')
  const sinFin = ATRIBUTOS.slice()
  sinFin[96] = 0x20
  falla(() => readShapefile({ shp: PUNTO, dbf: sinFin }), 'estructura')
})

// ── CRS ─────────────────────────────────────────────────────────────────────────────────────────

const UTM19S = 'PROJCS["WGS_1984_UTM_Zone_19S",GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],' +
  'PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",500000.0],' +
  'PARAMETER["False_Northing",10000000.0],PARAMETER["Central_Meridian",-69.0],PARAMETER["Scale_Factor",0.9996],' +
  'PARAMETER["Latitude_Of_Origin",0.0],UNIT["Meter",1.0]]'

// Arco de meridiano de Snyder (Map Projections — A Working Manual, ec. 3-21), independiente de la
// inversa de Krüger del núcleo: sobre el meridiano central, el norte es k0·M(φ).
const arco = phi => {
  const a = 6378137, f = 1 / 298.257223563, e2 = f * (2 - f), e4 = e2 * e2, e6 = e4 * e2
  return a * ((1 - e2 / 4 - 3 * e4 / 64 - 5 * e6 / 256) * phi - (3 * e2 / 8 + 3 * e4 / 32 + 45 * e6 / 1024) * Math.sin(2 * phi)
    + (15 * e4 / 256 + 45 * e6 / 1024) * Math.sin(4 * phi) - 35 * e6 / 3072 * Math.sin(6 * phi))
}

test('CRS: el .prj en UTM 19S pasa a grados WGS84', () => {
  const norte = 10000000 + 0.9996 * arco(-37.5 * Math.PI / 180)
  const read  = readShapefile({ shp: escribirShp(fc({ type: 'Point', coordinates: [500000, norte] })), prj: UTM19S })
  assert.ok(Math.abs(read.xy[0] - -69) < 1e-9, `lng ${read.xy[0]}`)
  assert.ok(Math.abs(read.xy[1] - -37.5) < 1e-7, `lat ${read.xy[1]}`)
  assert.ok(read.crs)
})

test('CRS: sin .prj, UTM es crs; con options.crs se lee, y el .prj gana a la opción', () => {
  const shp = escribirShp(fc({ type: 'Point', coordinates: [500000, 6000000] }))
  falla(() => readShapefile({ shp }), 'crs')
  const read = readShapefile({ shp }, { crs: 32719 })
  assert.equal(read.crs, 'EPSG:32719')
  assert.ok(Math.abs(read.xy[0] - -69) < 1e-9)
  assert.equal(readShapefile({ shp }, { crs: 'EPSG:32719' }).crs, 'EPSG:32719')
  assert.ok(Math.abs(readShapefile({ shp }, { crs: UTM19S }).xy[0] - -69) < 1e-9)
  assert.ok(Math.abs(readShapefile({ shp, prj: UTM19S }, { crs: 4326 }).xy[0] - -69) < 1e-9)
  falla(() => readShapefile({ shp }, { crs: 'EPSG:2000' }), 'crs')
  falla(() => readShapefile({ shp: PUNTO, prj: 'GEOGCS["x",DATUM["PSAD56",SPHEROID["International_1924",6378388,297]]]' }), 'crs')
})

// ── zip ─────────────────────────────────────────────────────────────────────────────────────────

test('zip: .shp, .dbf, .prj y .cpg emparejados por nombre base, stored y deflate', async () => {
  const dbf = escribirDbf([{ nombre: 'n', tipo: 'C', largo: 8 }], [['Ñandú']], { codificar: s => new TextEncoder().encode(s) })
  const zip = await escribirZip([
    { nombre: 'capas/rodales.SHP', bytes: PUNTO },
    { nombre: 'capas/rodales.Dbf', bytes: dbf, metodo: 0 },
    { nombre: 'capas/rodales.cpg', bytes: latin1('UTF-8') },
    { nombre: 'capas/otro.dbf', bytes: ATRIBUTOS },
  ])
  const read = await readShapefileZip(zip)
  iguales(read, fc({ type: 'Point', coordinates: [-70.5, -33.25] }))
  assert.deepEqual(read.propertiesOf(0), { n: 'Ñandú' })
})

test('zip: varias capas exigen options.layer, y sin .shp es formato', async () => {
  const zip = await escribirZip([{ nombre: 'a.shp', bytes: PUNTO }, { nombre: 'b.shp', bytes: CUADRADO }])
  await assert.rejects(readShapefileZip(zip), e => e instanceof FormatError && e.code === 'formato' && /a, b/.test(e.message))
  assert.equal((await readShapefileZip(zip, { layer: 'b' })).kinds[0], 5)
  await rechaza(readShapefileZip(zip, { layer: 'c' }), 'formato')
  await rechaza(readShapefileZip(await escribirZip([{ nombre: 'a.dbf', bytes: ATRIBUTOS }])), 'formato')
  await rechaza(readShapefileZip(42), 'entrada')
})

test('zip: lo inflado suma contra maxBytes', async () => {
  const zip = await escribirZip([{ nombre: 'a.shp', bytes: PUNTO }, { nombre: 'a.dbf', bytes: ATRIBUTOS }])
  assert.equal((await readShapefileZip(zip, { maxBytes: PUNTO.length + ATRIBUTOS.length })).featureCount, 1)
  await rechaza(readShapefileZip(zip, { maxBytes: PUNTO.length + ATRIBUTOS.length - 1 }), 'tope')
  // Una cota que no es entero ≥ 1 es entrada, como en readKmz: NaN no puede apagar el tope.
  for (const maxBytes of [NaN, 'x', 0, 1.5]) await rechaza(readShapefileZip(zip, { maxBytes }), 'entrada')
})

// ── salidas y fuzz ──────────────────────────────────────────────────────────────────────────────

test('salidas: Uint8Array, ArrayBuffer, vista desplazada y Buffer de pool dan lo mismo (§5-5)', () => {
  const shp     = escribirShp(fc({ type: 'Polygon', coordinates: [EXT(0, 0), HOYO(2, 2)] }))
  const base    = readShapefile({ shp })
  const corrido = new Uint8Array(shp.length + 3)
  corrido.set(shp, 3)
  ;[shp.buffer, corrido.subarray(3), Buffer.from(shp), new DataView(shp.buffer)].forEach(entrada =>
    assert.deepEqual(comparar(readShapefile({ shp: entrada }), base), []))
})

test('bounds y capacityHint pasan al constructor', () => {
  const read = readShapefile({ shp: CUADRADO }, { bounds: true, capacityHint: 1 })
  assert.deepEqual([...read.bounds], [0, 0, 1, 1])
  falla(() => readShapefile({ shp: CUADRADO }, { capacityHint: -1 }), 'entrada')
})

test('fuzz: un byte cambiado sólo produce FormatError (§5-6)', () => {
  const shp = escribirShp(fc({ type: 'MultiPolygon', coordinates: [[EXT(0, 0), HOYO(2, 2)], [EXT(20, 0)]] }, null,
    { type: 'Polygon', coordinates: [EXT(40, 0)] }))
  const dbf = escribirDbf(CAMPOS, [['a', '1', '2', 'T', '20200101', '', ''], ['b'], ['c']])
  let semilla = 7
  const azar = n => (semilla = (semilla * 1103515245 + 12345) >>> 0) % n
  const fin  = Date.now() + 1500
  let casos = 0
  while (Date.now() < fin) {
    const s = shp.slice(), d = dbf.slice()
    for (let k = azar(4); k >= 0; k--) {
      const blanco = azar(2) ? s : d
      blanco[azar(blanco.length)] = azar(256)
    }
    try {
      const read = readShapefile({ shp: s, dbf: d })
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
