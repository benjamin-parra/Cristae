// Lector de WKB/EWKB (DISENO-INTEROP §3.4): diferencial contra el oráculo de GeoJSON con bytes del
// generador, fixtures a mano, errores con código, CRS, formas de entrada, `areasOf` y fuzz.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readWkb } from '../../../src/formats/wkb.js'
import { areasOf } from '../../../src/geojson/geojson.js'
import { escribirWkb, hex, en2D } from './generador.mjs'
import { FIXTURES } from './fixtures.mjs'
import { lanza, igualAlOraculo, coleccion, cuatroFormas, fuzz } from '../wkt/comun-wkt.mjs'

const leer = (entrada, opciones) => readWkb(entrada, opciones)
const bytesDe = texto => Uint8Array.from(Buffer.from(texto, 'hex'))

const anillo = (d, z = 0) => [[d, d, z], [d + 1, d, z], [d + 1, d + 1, z], [d, d + 1, z], [d, d, z]]

const GEOMETRIAS = [
  { type: 'Point', coordinates: [1, 2, 3] },
  { type: 'Point', coordinates: [] },
  { type: 'LineString', coordinates: [[0, 0, 1], [1, 1, 2], [2, 0, 3]] },
  { type: 'LineString', coordinates: [] },
  { type: 'Polygon', coordinates: [anillo(0), [[0.2, 0.2, 0], [0.2, 0.4, 0], [0.4, 0.4, 0], [0.4, 0.2, 0], [0.2, 0.2, 0]]] },
  { type: 'Polygon', coordinates: [] },
  { type: 'Polygon', coordinates: [[]] },
  { type: 'MultiPoint', coordinates: [[1, 2, 3], [4, 5, 6]] },
  { type: 'MultiPoint', coordinates: [] },
  { type: 'MultiLineString', coordinates: [[[0, 0, 0], [1, 1, 1]], [], [[2, 2, 2], [3, 3, 3]]] },
  { type: 'MultiPolygon', coordinates: [[anillo(0)], [], [anillo(5), anillo(5.2)]] },
  { type: 'GeometryCollection', geometries: [] },
  {
    type       : 'GeometryCollection',
    geometries : [
      { type: 'Point', coordinates: [1, 2, 3] },
      { type: 'GeometryCollection', geometries: [{ type: 'LineString', coordinates: [[0, 0, 0], [1, 1, 1]] }] },
      { type: 'MultiPolygon', coordinates: [[anillo(9)]] },
    ],
  },
]

const ORDENES = { le: 'le', be: 'be', alternado: p => p % 2 ? 'be' : 'le' }

// Diferencial: cada geometría en cada orden, dimensión y sabor da las tablas del oráculo.
for (const g of GEOMETRIAS)
  for (const [nombreOrden, orden] of Object.entries(ORDENES))
    for (const dims of ['xy', 'xyz', 'xym', 'xyzm'])
      for (const sabor of ['iso', 'ewkb'])
        test(`${g.type} ${JSON.stringify(g.coordinates ?? g.geometries.length).slice(0, 30)} ${nombreOrden} ${dims} ${sabor}`, () => {
          const bytes = escribirWkb(g, { orden, dims, sabor })
          igualAlOraculo(leer(bytes), coleccion([dims.includes('z') ? g : en2D(g)]), hex(bytes))
        })

test('fixtures a mano: punto, línea Z big endian y EWKB con SRID', () => {
  igualAlOraculo(leer(FIXTURES.puntoLE), coleccion([{ type: 'Point', coordinates: [1, 2] }]))
  igualAlOraculo(leer(FIXTURES.lineaZBE), coleccion([{ type: 'LineString', coordinates: [[1, 2, 3], [4, 5, 6]] }]))
  const ewkb = leer(FIXTURES.puntoEwkbSrid)
  igualAlOraculo(ewkb, coleccion([{ type: 'Point', coordinates: [1, 2] }]))
  assert.equal(ewkb.crs, 'EPSG:4326')
})

test('POINT EMPTY es NaN NaN: geometría de 0 partes', () =>
  igualAlOraculo(leer(FIXTURES.puntoVacio), coleccion([{ type: 'Point', coordinates: [] }])))

test('un punto vacío dentro de un MultiPoint no aporta vértice', () =>
  igualAlOraculo(leer(FIXTURES.multipuntoConVacio), coleccion([{ type: 'MultiPoint', coordinates: [[1, 2]] }])))

test('Triangle es Polygon y TIN es MultiPolygon', () => {
  const tri = [[0, 0], [1, 0], [0, 1], [0, 0]]
  igualAlOraculo(leer(FIXTURES.triangulo), coleccion([{ type: 'Polygon', coordinates: [tri] }]))
  igualAlOraculo(leer(FIXTURES.tin), coleccion([{ type: 'MultiPolygon', coordinates: [[tri]] }]))
})

test('PolyhedralSurface (15) con hijos Polygon es MultiPolygon', () => {
  const bytes = escribirWkb({ type: 'MultiPolygon', coordinates: [[anillo(0)]] }, { dims: 'xyz' })
  bytes[1] = 0xf7          // 1006 → 1015, PolyhedralSurface Z
  igualAlOraculo(leer(bytes), coleccion([{ type: 'MultiPolygon', coordinates: [[anillo(0)]] }]))
})

test('estadísticas: la M se cuenta por posición; una raíz', () => {
  const geo = leer(escribirWkb({ type: 'LineString', coordinates: [[0, 0], [1, 1], [2, 2]] }, { dims: 'xym' }))
  assert.equal(geo.stats.extraOrdinates, 3)
  assert.equal(geo.stats.roots, 1)
  assert.equal(leer(FIXTURES.puntoLE).stats.extraOrdinates, 0)
})

test('salida: formato, capa única, sin atributos, release', () => {
  const geo = leer(FIXTURES.puntoLE)
  assert.equal(geo.format, 'wkb')
  assert.equal(geo.crs, null)
  assert.deepEqual(geo.layers, [{ name: null, parent: -1 }])
  assert.equal(geo.propertiesOf(0), null)
  assert.equal(geo.idOf(0), null)
  assert.equal(geo.bytes.length, 21, 'retiene los bytes binarios, también si llegó en hex')
  geo.release()
  assert.equal(geo.bytes, null)
})

test('hex en mayúsculas y minúsculas; las cuatro formas de entrada dan lo mismo', () => {
  const g     = GEOMETRIAS[12]
  const bytes = escribirWkb(g, { orden: ORDENES.alternado, dims: 'xyz' })
  const texto = hex(bytes)
  const esperado = coleccion([g])
  cuatroFormas(bytes, texto).forEach(entrada => igualAlOraculo(leer(entrada), esperado))
  igualAlOraculo(leer(texto.toLowerCase()), esperado)
})

// Un número de tipo, un conteo o una cola que mienten se leen como error con offset, nunca como
// excepción cruda ni como reserva por la cuenta declarada (§1.6-1, §1.6-2).
const ERRORES = [
  ['vacío',                         '',                                                              'truncado',    0],
  ['orden inválido',                '0201000000',                                                    'formato',     0],
  ['cabecera cortada',              '010100',                                                        'truncado'],
  ['coordenada cortada',            '0101000000000000000000F03F00000000',                             'truncado'],
  ['CircularString',                '0108000000',                                                    'tipo',        0],
  ['CurvePolygon Z',                '01F2030000',                                                    'tipo'],
  ['Geometry (0)',                  '0100000000',                                                    'tipo'],
  ['miles fuera de rango',          '01A00F0000',                                                    'tipo'],
  ['numPoints que miente',          '0102000000FFFFFFFF',                                            'truncado'],
  ['numRings que miente',           '0103000000FFFFFFFF',                                            'truncado'],
  ['numGeometries que miente',      '0107000000FFFFFF7F',                                            'truncado'],
  ['MultiPoint con hijo línea',     '010400000001000000010200000000000000',                           'estructura',  9],
  ['MultiPolygon con hijo punto',   '010600000001000000' + FIXTURES.puntoLE,                          'estructura',  9],
  ['TIN con hijo Polygon',          '011000000001000000010300000000000000',                           'estructura',  9],
  ['orden inválido en un hijo',     '010700000001000000' + '05' + FIXTURES.puntoLE.slice(2),          'estructura',  9],
  ['bytes de más',                  FIXTURES.puntoLE + '00',                                         'estructura', 21],
  ['x NaN e y no',                  '0101000000000000000000F87F0000000000000040',                     'numero',      5],
  ['y infinito en una línea',       '010200000001000000000000000000F03F000000000000F07F',              'numero',      9],
  ['z NaN',                         '01E9030000000000000000F03F0000000000000040000000000000F87F',      'numero',      5],
]

for (const [nombre, texto, code, at] of ERRORES)
  test(`error ${code}: ${nombre}`, () => lanza(() => leer(bytesDe(texto)), code, at))

test('lo que parece WKT es formato con pista', () =>
  assert.equal(lanza(() => leer(new TextEncoder().encode('POINT(1 2)')), 'formato', 0).hint, 'wkt'))

test('hex inválido y opciones inválidas son entrada', () => {
  lanza(() => leer('0'), 'entrada')
  lanza(() => leer('01G1000000'), 'entrada')
  lanza(() => leer(42), 'entrada')
  lanza(() => leer(FIXTURES.puntoLE, { maxDepth: 0 }), 'entrada')
})

test('CRS: SRID de EWKB, SRID en conflicto, sin SRID fuera de rango avisa y options.crs', () => {
  const srid = (g, s) => escribirWkb(g, { sabor: 'ewkb', srid: s })
  const utm  = { type: 'Point', coordinates: [500000, 6300000] }
  assert.equal(leer(srid(utm, 32719)).crs, 'EPSG:32719')
  assert.equal(leer(escribirWkb(utm), { crs: 32719 }).crs, 'EPSG:32719')
  const fuera = leer(escribirWkb(utm))
  assert.equal(fuera.crs, 'EPSG:4326')
  assert.deepEqual(fuera.warnings.map(w => w.code), ['crs'])
  lanza(() => leer(srid({ type: 'Point', coordinates: [1, 2] }, 4230)), 'crs', 0)

  // GeometryCollection con SRID 4326 cuyo hijo declara 3857.
  const hijo = srid({ type: 'Point', coordinates: [1, 2] }, 3857)
  const gc   = Uint8Array.from([...bytesDe('0107000020E610000001000000'), ...hijo])
  lanza(() => leer(gc), 'crs', 13)
})

// §1.5: 9 bytes por nivel de GeometryCollection; 100 mil niveles no desbordan la pila.
test('profundidad: 100 mil GeometryCollection anidadas', () => {
  const n     = 100000
  const nivel = bytesDe('010700000001000000')
  const punto = bytesDe(FIXTURES.puntoLE)
  const bytes = new Uint8Array(n * 9 + punto.length)
  for (let k = 0; k < n; k++) bytes.set(nivel, k * 9)
  bytes.set(punto, n * 9)
  lanza(() => leer(bytes), 'profundidad')
  lanza(() => leer(bytes.subarray((n - 2) * 9), { maxDepth: 2 }), 'profundidad', 9)
  const geo = leer(bytes, { maxDepth: n + 1 })
  assert.equal(geo.geometryCount, 1)
  assert.deepEqual([...geo.xy], [1, 2])
})

test('areasOf sirve sin cambios sobre una lectura de WKB', () => {
  const geo = leer(escribirWkb(GEOMETRIAS[12], { dims: 'xyz' }))
  const { rings, parts, owner } = areasOf(geo)
  assert.deepEqual([...parts], [2])
  assert.deepEqual([...rings], [2])
  assert.deepEqual([...owner], [0, 0, 0])
})

test('fuzz de mutación: sólo FormatError', () => {
  const corpus = [
    ...GEOMETRIAS.map(g => escribirWkb(g, { orden: ORDENES.alternado, dims: 'xyzm', sabor: 'ewkb', srid: 4326 })),
    ...Object.values(FIXTURES).map(bytesDe),
  ]
  assert.ok(fuzz(corpus, bytes => leer(bytes)) > 100)
})
