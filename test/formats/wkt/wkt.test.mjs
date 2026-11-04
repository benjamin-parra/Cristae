// Lector de WKT/EWKT (DISENO-INTEROP §3.3): corpus contra el oráculo, errores con código, CRS,
// números exactos, formas de entrada, `areasOf` y fuzz.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readWkt } from '../../../src/formats/wkt.js'
import { areasOf } from '../../../src/geojson/geojson.js'
import { wktAGeoJson } from './oraculo-wkt.mjs'
import { lanza, igualAlOraculo, cuatroFormas, fuzz } from './comun-wkt.mjs'

const leer = (texto, opciones) => readWkt(texto, opciones)

// Cada fixture cita lo que ejercita. Las de 06-103r4 citan su § (verificadas contra la norma, DISENO D-11).
const CORPUS = {
  felices: [
    ['POINT(1 2)',                                           '06-103r4 §7.2.2, point tagged text'],
    ['point (1 2)',                                          'palabras clave sin distinguir mayúsculas'],
    ['LINESTRING(0 0, 1 1, 2 2)',                            'linestring text'],
    ['POLYGON((0 0, 10 0, 10 10, 0 10, 0 0), (2 2, 2 4, 4 4, 4 2, 2 2))', 'polygon text, exterior y un hoyo'],
    ['MULTIPOINT((1 2), (3 4))',                             'multipoint con paréntesis por punto'],
    ['MULTILINESTRING((0 0, 1 1), (2 2, 3 3))',              'una parte por línea (§17.1)'],
    ['MULTIPOLYGON(((0 0, 1 0, 1 1, 0 0)), ((5 5, 6 5, 6 6, 5 5), (5.2 5.2, 5.4 5.2, 5.4 5.4, 5.2 5.2)))', 'una parte por polígono'],
    ['GEOMETRYCOLLECTION(POINT(1 2), LINESTRING(0 0, 1 1), GEOMETRYCOLLECTION(POLYGON((0 0, 1 0, 1 1, 0 0))))', 'aplanado en profundidad (§17.1)'],
    ['SRID=4326;POINT(-70.6 -33.4)',                         'EWKT de PostGIS'],
  ],
  especificacion: [
    ['POINT Z (1 2 3)',                                      'modificador Z'],
    ['POINT M (1 2 3)',                                      'M se descarta (D-3)'],
    ['POINT ZM (1 2 3 4)',                                   'ZM: la cuarta es M'],
    ['POINTM(1 2 3)',                                        'M pegada, como la escribe ST_AsEWKT'],
    ['LINESTRINGZM(0 0 0 9, 1 1 1 9)',                       'ZM pegado'],
    ['POINT(1 2 3)',                                         'sin modificador y 3 números: Z de PostGIS'],
    ['POINT(1 2 3 4)',                                       'sin modificador y 4 números: ZM'],
    ['MULTIPOINT(1 2, 3 4)',                                 'multipoint sin paréntesis, forma vieja'],
    ['TRIANGLE((0 0, 1 0, 0 1, 0 0))',                       'TRIANGLE como Polygon'],
    ['TIN Z (((0 0 0, 1 0 0, 0 1 0, 0 0 0)), ((1 0 0, 1 1 0, 0 1 0, 1 0 0)))', 'TIN como MultiPolygon'],
    ['POLYHEDRALSURFACE Z (((0 0 0, 0 1 0, 1 1 0, 0 0 0)))', 'POLYHEDRALSURFACE como MultiPolygon'],
    ['GEOMETRYCOLLECTION Z (POINT(1 2 3), LINESTRING Z (0 0 0, 1 1 1))', 'el hijo hereda el modificador'],
    ['POINT(1 2)\nPOINT(3 4)',                               'un WKT por línea: dos features'],
    ['POINT(1 2);LINESTRING(0 0, 1 1);',                     'separador ;'],
    ['﻿\tPOINT\r\n(\t1\r\n2 )  ',                       'BOM y espacio en blanco variado'],
  ],
  degenerados: [
    ['POINT EMPTY',                                          'geometría de 0 partes (§17.9)'],
    ['LINESTRING EMPTY',                                     ''],
    ['POLYGON EMPTY',                                        ''],
    ['POLYGON(EMPTY)',                                       '1 parte, 1 anillo de 0 vértices (§17.3-14)'],
    ['MULTIPOINT EMPTY',                                     ''],
    ['MULTIPOINT(EMPTY, (1 2))',                             'el punto vacío no aporta posición'],
    ['MULTIPOINT(EMPTY)',                                    'igual a MULTIPOINT EMPTY'],
    ['MULTILINESTRING(EMPTY, (0 0, 1 1))',                   'línea vacía: parte con anillo de 0'],
    ['MULTIPOLYGON(EMPTY, ((0 0, 1 0, 1 1, 0 0)))',          'polígono vacío: parte de 0 anillos'],
    ['GEOMETRYCOLLECTION EMPTY',                             'feature sin geometrías'],
    ['GEOMETRYCOLLECTION(POINT EMPTY, GEOMETRYCOLLECTION EMPTY)', ''],
    ['POLYGON((0 0, 1 0, 1 1))',                             'anillo abierto y corto: se cuenta, no se corrige'],
    ['POLYGON((0 0, 0 1, 1 1, 0 0))',                        'exterior horario'],
    ['LINESTRING(0 0)',                                      'línea de un vértice'],
  ],
}

for (const [familia, casos] of Object.entries(CORPUS))
  for (const [texto, cita] of casos)
    test(`${familia}: ${JSON.stringify(texto)} igual al oráculo${cita && ` (${cita})`}`, () =>
      igualAlOraculo(leer(texto), wktAGeoJson(texto), texto))

test('estadísticas que cuenta el lector: M descartada, raíces y números lentos', () => {
  assert.equal(leer('POINT M (1 2 3)').stats.extraOrdinates, 1)
  assert.equal(leer('LINESTRING ZM (0 0 0 0, 1 1 1 1)').stats.extraOrdinates, 2)
  assert.equal(leer('POINT(1 2 3 4)').stats.extraOrdinates, 1)
  assert.equal(leer('POINT Z (1 2 3)').stats.extraOrdinates, 0)
  assert.equal(leer('POINT(1 2) POINT(3 4);POINT(5 6)').stats.roots, 3)
  assert.equal(leer('GEOMETRYCOLLECTION(POINT(1 2), POINT(3 4))').stats.roots, 1)
})

test('salida: formato, capa única, sin atributos', () => {
  const geo = leer('POINT(1 2)\nPOINT(3 4)')
  assert.equal(geo.format, 'wkt')
  assert.equal(geo.crs, null)
  assert.equal(geo.featureCount, 2)
  assert.deepEqual([...geo.layerOf], [0, 0])
  assert.deepEqual(geo.layers, [{ name: null, parent: -1 }])
  assert.equal(geo.propertiesOf(0), null)
  assert.equal(geo.idOf(1), null)
  geo.release()
  assert.equal(geo.bytes, null)
})

const ERRORES = [
  ['',                                           'sintaxis',    0],
  ['   \n',                                      'sintaxis',    0],
  ['POINT(1 2',                                  'truncado',    9],
  ['MULTIPOLYGON(((0 0, 1 0, 1 1, 0 0))',        'truncado'],
  ['GEOMETRYCOLLECTION(POINT(1 2)',              'truncado'],
  ['POINT',                                      'truncado'],
  ['POINT(1 2, 3 4)',                            'sintaxis',    9],
  ['POINT()',                                    'sintaxis',    6],
  ['POINT(1.2.3 4)',                             'sintaxis'],
  ['POINT(1 2) )',                               'sintaxis'],
  ['POINT(1 2);;POINT(3 4)',                     'sintaxis'],
  ['POINT(1)',                                   'posicion',    6],
  ['POINT(1 2 3 4 5)',                           'posicion'],
  ['POINT Z (1 2)',                              'posicion'],
  ['POINT ZM (1 2 3)',                           'posicion'],
  ['LINESTRING(0 0, 1 1 1)',                     'posicion'],
  ['GEOMETRYCOLLECTION Z (POINT M (1 2 3))',     'posicion'],
  ['POINT(NaN 1)',                               'numero',      6],
  ['POINT(1 -inf)',                              'numero',      8],
  ['POINT(1e999 0)',                             'numero',      6],
  ['CIRCULARSTRING(0 0, 1 1, 2 0)',              'tipo',        0],
  ['CURVEPOLYGON(CIRCULARSTRING(0 0, 1 1, 2 0, 1 -1, 0 0))', 'tipo'],
  ['GEOMETRYCOLLECTION(POINT(1 2), COMPOUNDCURVE((0 0, 1 1)))', 'tipo'],
  ['SRID=4326;POINT(1 2) SRID=3857;POINT(1 2)', 'crs'],
  ['POINT(1 2) SRID=4326;POINT(1 2)',           'crs'],
  ['SRID=4230;POINT(1 2)',                       'crs',         0],
  ['SRID=;POINT(1 2)',                           'sintaxis'],
]

for (const [texto, code, at] of ERRORES)
  test(`error ${code}: ${JSON.stringify(texto)}`, () => lanza(() => leer(texto), code, at))

test('lo que no es WKT es formato, con pista cuando parece WKB en hex', () => {
  assert.equal(lanza(() => leer('{"type":"Point","coordinates":[1,2]}'), 'formato', 0).hint, null)
  assert.equal(lanza(() => leer('0101000000000000000000F03F0000000000000040'), 'formato', 0).hint, 'wkb')
  assert.equal(lanza(() => leer(new Uint8Array([1, 1, 0, 0, 0])), 'formato', 0).hint, 'wkb')
})

test('opciones inválidas son entrada', () => {
  lanza(() => readWkt(42), 'entrada')
  lanza(() => readWkt(null), 'entrada')
  lanza(() => leer('POINT(1 2)', { maxDepth: 0 }), 'entrada')
  lanza(() => leer('POINT(1 2)', { maxDepth: 1.5 }), 'entrada')
  lanza(() => leer('POINT(1 2)', { crs: {} }), 'entrada')
})

// §2.5: sin CRS declarado manda `options.crs`; sin ninguno, WGS84 con el rango validado.
test('CRS: declarado, por opción y ausente', () => {
  assert.equal(leer('SRID=4326;POINT(-70 -33)').crs, 'EPSG:4326')
  assert.equal(leer('SRID=0;POINT(-70 -33)').crs, null)
  assert.equal(leer('SRID=4326;POINT(1 2);SRID=4326;POINT(3 4)').crs, 'EPSG:4326')
  assert.equal(leer('POINT(500000 6300000)', { crs: 32719 }).crs, 'EPSG:32719')
  assert.equal(leer('SRID=4326;POINT(1 2)', { crs: 32719 }).crs, 'EPSG:4326', 'la fuente gana')
  lanza(() => leer('POINT(500000 6300000)'), 'crs')
  assert.equal(leer('POINT(500000 6300000)', { crs: 'EPSG:32719' }).crs, 'EPSG:32719')
  const wgs84 = 'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]]'
  assert.equal(typeof leer('POINT(-70 -33)', { crs: wgs84 }).crs, 'string')
  lanza(() => leer('POINT(1 2)', { crs: 4230 }), 'crs')

  const merc = leer('SRID=3857;POINT(-7792364.36 -3964000)')
  assert.ok(Math.abs(merc.xy[0] - -70) < 1e-6, `lng ${merc.xy[0]}`)
  assert.ok(Math.abs(merc.xy[1] - -33.5) < 0.1, `lat ${merc.xy[1]}`)
})

// §2.2 y §5-4: paridad bit a bit con `Number(texto)`, incluida la frontera de 31 a 34 dígitos.
test('números exactos: paridad con Number(texto)', () => {
  const NUMEROS = [
    '0.1', '-0', '+3', '.5', '5.', '1e-7', '1E+2', '-.25e1', '9007199254740993', '0.30000000000000004',
    '1.7976931348623157e308', '4.9e-324', '2.2250738585072011e-308', '123.456789012345678901234567890',
    '1234567890123456789012345678901', '12345678901234567890123456789012', '123456789012345678901234567890123',
    '0.1234567890123456789012345678901234',
  ]
  const geo = leer(`SRID=4326;MULTIPOINT(${NUMEROS.map(n => `${n} 0`).join(', ')})`)
  NUMEROS.forEach((n, k) => assert.ok(Object.is(geo.xy[k * 2], Number(n)), `${n}: ${geo.xy[k * 2]} ≠ ${Number(n)}`))
})

test('las cuatro formas de entrada dan las mismas tablas', () => {
  const texto = 'GEOMETRYCOLLECTION(POINT Z (1 2 3), POLYGON((0 0, 1 0, 1 1, 0 0)))\nPOINT(5 6)'
  const bytes = new TextEncoder().encode(texto)
  cuatroFormas(bytes, texto).forEach(entrada => igualAlOraculo(leer(entrada), wktAGeoJson(texto)))
})

// §1.5: el anidamiento corta en `maxDepth` con 'profundidad', y una cota alta no desborda la pila
// porque las colecciones se recorren con una pila propia.
test('profundidad: 100 mil GEOMETRYCOLLECTION anidadas', () => {
  const n     = 100000
  const texto = 'GEOMETRYCOLLECTION('.repeat(n) + 'POINT(1 2)' + ')'.repeat(n)
  lanza(() => leer(texto), 'profundidad')
  lanza(() => leer('GEOMETRYCOLLECTION(GEOMETRYCOLLECTION(POINT(1 2)))', { maxDepth: 2 }), 'profundidad', 19)
  assert.equal(leer('GEOMETRYCOLLECTION(POINT(1 2))', { maxDepth: 2 }).geometryCount, 1)
  const geo = leer(texto, { maxDepth: n + 1 })
  assert.equal(geo.geometryCount, 1)
  assert.deepEqual([...geo.xy], [1, 2])
})

test('areasOf sirve sin cambios sobre una lectura de WKT', () => {
  const geo = leer('POINT(0 0)\nPOLYGON((0 0, 1 0, 1 1, 0 0), (0.2 0.2, 0.4 0.2, 0.4 0.4, 0.2 0.2))\nMULTIPOLYGON(((5 5, 6 5, 6 6, 5 5)), ((7 7, 8 7, 8 8, 7 7)))')
  const { rings, parts, owner } = areasOf(geo)
  assert.deepEqual([...parts], [1, 2, 3])
  assert.deepEqual([...rings], [1, 2, 3, 4])
  assert.deepEqual([...owner], [0, 1, 2, 2])
})

test('fuzz de mutación: sólo FormatError', () => {
  const corpus = Object.values(CORPUS).flat().map(([texto]) => new TextEncoder().encode(texto))
  assert.ok(fuzz(corpus, bytes => leer(bytes)) > 100)
})
