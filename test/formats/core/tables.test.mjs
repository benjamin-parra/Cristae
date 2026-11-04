// Constructor de tablas del núcleo (DISENO-INTEROP §2.3, §2.4 y §7). El oráculo es `readGeoJson`: la
// misma geometría construida a mano con el constructor tiene que dar las mismas tablas y los mismos
// contadores (§1.1, «salida idéntica en forma»).

import test from 'node:test'
import assert from 'node:assert/strict'
import { createTables, CCW, CW } from '../../../src/formats/core/tables.js'
import { crsFromEpsg } from '../../../src/formats/core/crs.js'
import { readGeoJson, areasOf } from '../../../src/geojson/geojson.js'
import { compararTablas, invariantes, fallaCon, TABLAS } from '../comun.mjs'

const KIND = { Point: 1, MultiPoint: 2, LineString: 3, MultiLineString: 4, Polygon: 5, MultiPolygon: 6 }
const SIN_CAPAS = TABLAS.filter(k => k !== 'layerOf')

// Construye una geometría GeoJSON con el constructor, siguiendo la tabla tipo → partes y anillos de
// SPECS §17.1. Las colecciones se aplanan en profundidad.
const construir = (t, g) => {
  if (g === null) return
  if (g.type === 'GeometryCollection') return g.geometries.forEach(h => construir(t, h))

  const anillo = posiciones => {
    t.ring()
    posiciones.forEach(([x, y, z]) => t.vertex(x, y, z))
  }
  const c = g.coordinates
  t.geometry()
  if (g.type === 'Point') c.length && (t.part(), anillo([c]))
  else if (g.type === 'MultiPoint' || g.type === 'LineString') c.length && (t.part(), anillo(c))
  else if (g.type === 'Polygon') c.length && (t.part(), c.forEach(anillo))
  else if (g.type === 'MultiLineString') c.forEach(linea => (t.part(), anillo(linea)))
  else if (g.type === 'MultiPolygon') c.forEach(poligono => (t.part(), poligono.forEach(anillo)))
  t.close(KIND[g.type])
}

const leerConTablas = (features, opciones = {}) => {
  const t = createTables('prueba', opciones)
  features.forEach(f => {
    t.feature()
    construir(t, f.geometry)
  })
  return t.seal({ source: crsFromEpsg(4326) })
}

// `JSON.stringify` escribe −0 como 0: se marca y se restaura para que el oráculo lea el mismo −0.
const coleccion = features => JSON.stringify({ type: 'FeatureCollection', features }, (_, v) => Object.is(v, -0) ? '«-0»' : v)
  .replaceAll('"«-0»"', '-0')
const feature   = geometry => ({ type: 'Feature', properties: {}, geometry })

const CUADRADO = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]
const HOYO     = [[2, 2], [2, 3], [3, 3], [2, 2]]

const CASOS = {
  'punto'                          : [feature({ type: 'Point', coordinates: [1, 2] })],
  'punto 3D y 2D mezclados'        : [feature({ type: 'MultiPoint', coordinates: [[1, 2, 3], [4, 5]] })],
  'línea abierta'                  : [feature({ type: 'LineString', coordinates: [[0, 0], [1, 1], [2, 0]] })],
  'polígono con hoyo'              : [feature({ type: 'Polygon', coordinates: [CUADRADO, HOYO] })],
  'polígono horario (invertido)'   : [feature({ type: 'Polygon', coordinates: [[...CUADRADO].reverse()] })],
  'anillo corto y degenerado'      : [feature({ type: 'Polygon', coordinates: [[[0, 0], [1, 1], [0, 0]]] })],
  'multilínea'                     : [feature({ type: 'MultiLineString', coordinates: [[[0, 0], [1, 1]], [[2, 2], [3, 3], [4, 2]]] })],
  'multipolígono'                  : [feature({ type: 'MultiPolygon', coordinates: [[CUADRADO, HOYO], [[[20, 20], [21, 20], [21, 21], [20, 20]]]] })],
  'vacías (§17.9 y §17.3-14)'      : [
    feature({ type: 'Point', coordinates: [] }),
    feature({ type: 'Polygon', coordinates: [[]] }),
    feature({ type: 'MultiPolygon', coordinates: [[]] }),
    feature({ type: 'MultiLineString', coordinates: [] }),
  ],
  'geometry null'                  : [feature(null), feature({ type: 'Point', coordinates: [0, 0] })],
  'colección anidada'              : [feature({
    type: 'GeometryCollection',
    geometries: [{ type: 'Point', coordinates: [1, 1] }, { type: 'GeometryCollection', geometries: [{ type: 'LineString', coordinates: [[0, 0], [5, 5]] }] }],
  })],
  'z que vale −0 y NaN en el cierre': [feature({ type: 'Polygon', coordinates: [[[0, 0, -0], [1, 0, 1], [1, 1, 2], [0, 0, 0]]] })],
}

for (const [nombre, features] of Object.entries(CASOS))
  test(`mismas tablas y contadores que readGeoJson: ${nombre}`, () => {
    const propio = leerConTablas(features, { bounds: true })
    const geo    = readGeoJson(coleccion(features), { bounds: true })
    invariantes(propio)
    compararTablas(propio, geo, { campos: [...SIN_CAPAS, 'bounds'] })
    const { skippedGeometries, deletedRecords, orphanHoles, ...diez } = propio.stats
    assert.deepEqual(diez, geo.stats)
    assert.deepEqual([skippedGeometries, deletedRecords, orphanHoles], [0, 0, 0])
  })

test('areasOf sirve sin cambios sobre la salida del constructor (§1.1)', () => {
  const features = CASOS['multipolígono'].concat(CASOS['polígono con hoyo'], CASOS['línea abierta'])
  const a = areasOf(leerConTablas(features))
  const b = areasOf(readGeoJson(coleccion(features)))
  ;['rings', 'parts', 'owner', 'vertexAt', 'ringAt', 'closed', 'xy'].forEach(k => assert.deepEqual([...a[k]], [...b[k]], k))
})

test('los campos de §1.1: format, crs, layers y layerOf', () => {
  const t = createTables('kml')
  const doc     = t.layer('documento')
  const carpeta = t.layer(null, doc)
  t.feature(doc)
  t.feature(carpeta)
  t.layerName(carpeta, 'carpeta')
  const r = t.seal({ crs: 'EPSG:4326', source: crsFromEpsg(4326) })
  assert.equal(r.format, 'kml')
  assert.equal(r.crs, 'EPSG:4326')
  assert.deepEqual(r.layers, [{ name: 'documento', parent: -1 }, { name: 'carpeta', parent: 0 }])
  assert.deepEqual([...r.layerOf], [0, 1])
})

test('warn deja avisos no fatales en warnings, en orden, y no corta la lectura', () => {
  const t = createTables('shapefile')
  assert.equal(t.warn('codificacion', '.cpg "x"'), undefined)
  t.warn('codificacion')
  t.feature()
  const r = t.seal({ source: crsFromEpsg(4326) })
  assert.deepEqual(r.warnings, [{ code: 'codificacion', detail: '.cpg "x"' }, { code: 'codificacion', detail: null }])
  assert.deepEqual(createTables('kml').seal({ source: crsFromEpsg(4326) }).warnings, [])
})

test('sin layer() hay una capa implícita { name: null, parent: −1 }', () => {
  const t = createTables('gpx')
  t.feature()
  const r = t.seal({ source: crsFromEpsg(4326) })
  assert.deepEqual(r.layers, [{ name: null, parent: -1 }])
  assert.deepEqual([...r.layerOf], [0])
  assert.equal(r.crs, null)
})

test('attributes() después de la geometría; propertiesOf e idOf con la guarda de geojson.js', () => {
  const texto = 'xx{"a":1}yy"id-7"'
  const bytes = new TextEncoder().encode(texto)
  const t = createTables('esrijson')
  const f0 = t.feature()
  t.geometry()
  t.part()
  t.ring()
  t.vertex(1, 2)
  t.close(1)
  t.attributes(f0, 2, 9, 11, 17)
  t.feature()
  const json = (b, from, to) => JSON.parse(new TextDecoder().decode(b.subarray(from, to)))
  const r = t.seal({ bytes, properties: json, id: json, source: crsFromEpsg(4326) })

  assert.deepEqual(r.propertiesOf(0), { a: 1 })
  assert.equal(r.idOf(0), 'id-7')
  // Ausencia: par vacío ⇒ null. Fuera de rango ⇒ null, nunca el documento entero.
  assert.equal(r.propertiesOf(1), null)
  assert.equal(r.propertiesOf(2), null)
  assert.equal(r.propertiesOf(-1), null)
  assert.equal(r.propertiesOf(0.5), null)
  r.release()
  assert.equal(r.bytes, null)
  fallaCon(() => r.propertiesOf(0), 'liberado', 'esrijson')
})

test('un decodificador que lanza sale como FormatError(properties) con el offset', async () => {
  const t = createTables('topojson')
  const f = t.feature()
  t.attributes(f, 3, 5)
  const r = t.seal({ bytes: new Uint8Array(8), properties: () => { throw new SyntaxError('x') } })
  const e = await fallaCon(() => r.propertiesOf(0), 'properties', 'topojson')
  assert.equal(e.at, 3)
})

test('discard() deshace la geometría abierta, incluidos sus contadores y la reserva de z', () => {
  const t = createTables('kml')
  t.feature()
  t.geometry()
  t.part()
  t.ring()
  t.vertex(0, 0, 5)
  t.vertex(1, 1, 5)
  t.discard()
  t.stats.skippedGeometries++
  t.geometry()
  t.part()
  t.ring()
  t.vertex(3, 4)
  t.close(1)
  const r = t.seal({ source: crsFromEpsg(4326) })
  assert.deepEqual([...r.xy], [3, 4])
  assert.equal(r.z, null)
  assert.equal(r.stats.openRings, 0)
  assert.equal(r.stats.shortRings, 1)
  assert.equal(r.stats.skippedGeometries, 1)
  invariantes(r)
})

test('el orden obligatorio se hace cumplir con Error de programación, no FormatError', () => {
  const t = createTables('wkb')
  assert.throws(() => t.geometry(), e => !(e.name === 'FormatError') && /createTables/.test(e.message))
  t.feature()
  t.geometry()
  assert.throws(() => t.vertex(1, 1), /vertex\(\) sin anillo/)
  assert.throws(() => t.ring(), /ring\(\) sin parte/)
  assert.throws(() => t.seal(), /geometría abierta/)
  assert.throws(() => t.close(7), /kind/)
  assert.throws(() => t.feature(), /geometría abierta/)
})

test('capacityHint que no es entero ≥ 0 es FormatError(entrada); uno enorme no reserva de más', async () => {
  await fallaCon(() => createTables('wkt', { capacityHint: -1 }), 'entrada', 'wkt')
  await fallaCon(() => createTables('wkt', { capacityHint: 1.5 }), 'entrada', 'wkt')
  const t = createTables('wkt', { capacityHint: 2 ** 40 })
  t.feature()
  assert.equal(t.seal({ source: crsFromEpsg(4326) }).vertexCount, 0)
})

test('crece más allá de la pista sin perder vértices ni z', () => {
  const t = createTables('gpx', { capacityHint: 1 })
  t.feature()
  t.geometry()
  t.part()
  t.ring()
  for (let i = 0; i < 1000; i++) t.vertex(i % 180, i % 90, i === 500 ? 7 : NaN)
  t.close(3)
  const r = t.seal({ source: crsFromEpsg(4326) })
  assert.equal(r.vertexCount, 1000)
  assert.equal(r.xy[2 * 999], 999 % 180)
  assert.equal(r.z[500], 7)
  assert.ok(Number.isNaN(r.z[499]) && Number.isNaN(r.z[999]))
})

// ── §2.4: polígonos sin agrupar ─────────────────────────────────────────────────────────────────

// Exterior horario e interior antihorario, la convención de Shapefile y EsriJSON.
const EXT_CW  = [[0, 0], [0, 10], [10, 10], [10, 0], [0, 0]]
const HOYO_A  = [[1, 1], [2, 1], [2, 2], [1, 1]]
const ISLA_CW = [[3, 3], [3, 7], [7, 7], [7, 3], [3, 3]]
const HOYO_B  = [[4, 4], [5, 4], [5, 5], [4, 4]]          // dentro de la isla y del exterior
const LEJOS   = [[50, 50], [51, 50], [51, 51], [50, 50]]   // antihorario sin exterior: huérfano
const PLANO   = [[0, 0], [1, 1], [2, 2], [0, 0]]           // área 0

const agrupar = (anillos, orientation = CW) => {
  const t = createTables('shapefile', { orientation })
  t.feature()
  t.geometry()
  t.part()
  anillos.forEach(a => {
    t.ring()
    a.forEach(([x, y]) => t.vertex(x, y))
  })
  t.closeRings()
  const r = t.seal({ source: crsFromEpsg(4326) })
  invariantes(r)
  return r
}

const anillosDe = r => Array.from({ length: r.partCount }, (_, p) =>
  Array.from({ length: r.ringAt[p + 1] - r.ringAt[p] }, (_, k) => {
    const ring = r.ringAt[p] + k
    return Array.from({ length: r.vertexAt[ring + 1] - r.vertexAt[ring] }, (_, v) =>
      [r.xy[(r.vertexAt[ring] + v) * 2], r.xy[(r.vertexAt[ring] + v) * 2 + 1]])
  }))

test('closeRings: un exterior con su hoyo es Polygon', () => {
  const r = agrupar([EXT_CW, HOYO_A])
  assert.deepEqual([...r.kinds], [5])
  assert.deepEqual(anillosDe(r), [[EXT_CW, HOYO_A]])
  assert.equal(r.stats.reversedRings, 0)
  assert.equal(r.stats.orphanHoles, 0)
})

test('closeRings: el hoyo va al exterior MÁS CHICO que lo contiene, aunque llegue antes', () => {
  const r = agrupar([HOYO_B, EXT_CW, HOYO_A, ISLA_CW])
  assert.deepEqual([...r.kinds], [6])
  assert.deepEqual(anillosDe(r), [[EXT_CW, HOYO_A], [ISLA_CW, HOYO_B]])
})

test('closeRings: exteriores en orden inverso conservan el orden del archivo', () => {
  const r = agrupar([ISLA_CW, EXT_CW, HOYO_A])
  assert.deepEqual(anillosDe(r), [[ISLA_CW], [EXT_CW, HOYO_A]])
})

test('closeRings: un hoyo huérfano sale como exterior propio y cuenta en orphanHoles y reversedRings', () => {
  const r = agrupar([EXT_CW, LEJOS])
  assert.deepEqual(anillosDe(r), [[EXT_CW], [LEJOS]])
  assert.equal(r.stats.orphanHoles, 1)
  assert.equal(r.stats.reversedRings, r.stats.orphanHoles)
})

test('closeRings: un anillo de área 0 es exterior y suma degenerateRings', () => {
  const r = agrupar([PLANO, EXT_CW])
  assert.deepEqual(anillosDe(r), [[PLANO], [EXT_CW]])
  assert.equal(r.stats.degenerateRings, 1)
  assert.equal(r.stats.orphanHoles, 0)
})

test('closeRings: un hoyo con un vértice sobre el borde usa el siguiente vértice', () => {
  const tocando = [[0, 5], [1, 4], [1, 6], [0, 5]]  // antihorario, el primer vértice sobre el borde
  const r = agrupar([EXT_CW, tocando])
  assert.equal(r.partCount, 1)
  assert.equal(r.stats.orphanHoles, 0)
})

test('closeRings: sin anillos es un Polygon vacío, y z viaja con sus vértices', () => {
  const t = createTables('esrijson', { orientation: CW })
  t.feature()
  t.geometry()
  t.part()
  t.closeRings()
  t.feature()
  t.geometry()
  t.part()
  ;[HOYO_A, EXT_CW].forEach((a, k) => {
    t.ring()
    a.forEach(([x, y]) => t.vertex(x, y, k * 100 + x))
  })
  t.closeRings()
  const r = t.seal({ source: crsFromEpsg(4326) })
  assert.deepEqual([...r.kinds], [5, 5])
  assert.equal(r.stats.emptyGeometries, 1)
  assert.deepEqual([...r.z], [...EXT_CW.map(([x]) => 100 + x), ...HOYO_A.map(([x]) => x)])
})

test('closeRings con convención CCW: el antihorario es exterior', () => {
  const ccw = EXT_CW.slice().reverse(), hoyo = HOYO_A.slice().reverse()
  const r = agrupar([hoyo, ccw], CCW)
  assert.deepEqual(anillosDe(r), [[ccw, hoyo]])
  assert.equal(r.stats.reversedRings, 0)
})

test('closeRings exige una sola parte abierta', () => {
  const t = createTables('shapefile', { orientation: CW })
  t.feature()
  t.geometry()
  t.part()
  t.part()
  assert.throws(() => t.closeRings(), /una sola parte/)
})

// ── CRS en el sellado (§2.5) ──────────────────────────────────────────────────────────────────────

const unPunto = (x, y) => {
  const t = createTables('wkb', { bounds: true })
  t.feature()
  t.geometry()
  t.part()
  t.ring()
  t.vertex(x, y)
  t.close(1)
  return t
}

test('sin CRS de la fuente, una coordenada fuera del rango geográfico es crs', async () => {
  await fallaCon(() => unPunto(350000, 6300000).seal(), 'crs', 'wkb')
  assert.deepEqual([...unPunto(-70.5, -33.4).seal().xy], [-70.5, -33.4])
})

test('con source, la inversa va en sitio antes de bounds y crs es lo que se publica', () => {
  const r = unPunto(500000, 10000000).seal({ crs: 'EPSG:32719', source: crsFromEpsg(32719) })
  assert.equal(r.crs, 'EPSG:32719')
  assert.ok(Math.abs(r.xy[0] - -69) < 1e-12 && Math.abs(r.xy[1]) < 1e-12)
  assert.deepEqual([...r.bounds], [r.xy[0], r.xy[1], r.xy[0], r.xy[1]])
})
