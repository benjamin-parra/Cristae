// Tablas de un lector → ítems por geometría.
// Corre con: node --test test/engine/features.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { readGeoJson, GeoJsonKind } from '../../src/geojson/geojson.js'
import { readKml } from '../../src/formats/kml.js'
import { itemsOf, URL_ACCESSORS, FEATURE, POSITION, PATH, RINGS } from '../../src/engine/features.js'

const feat = (geometry, properties = {}) => ({ type: 'Feature', properties, geometry })
const leer = features => readGeoJson(JSON.stringify({ type: 'FeatureCollection', features }))

test('los códigos locales coinciden con GeoJsonKind', () => {
  const r = leer([feat({ type: 'MultiPolygon', coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]]]] })])
  assert.equal(r.kinds[0], GeoJsonKind.MultiPolygon)
  assert.equal(itemsOf(r, 'polygon').items.length, 1)
})

test('puntos: posición {lat,lng} desde [lng,lat] y properties conservadas', () => {
  const r = leer([feat({ type: 'Point', coordinates: [-70.5, -33.25] }, { patente: 'AB12', n: 3 })])
  const { items, skipped } = itemsOf(r, 'point')
  assert.equal(skipped, 0)
  assert.equal(items.length, 1)
  assert.equal(items[0].patente, 'AB12')
  assert.equal(items[0].n, 3)
  assert.deepEqual(items[0][POSITION], { lat: -33.25, lng: -70.5 })
  assert.equal(items[0][FEATURE], 0)
  assert.deepEqual(Object.keys(items[0]), ['patente', 'n'])
})

test('la posición es el mismo objeto en cada lectura del ítem', () => {
  const [it] = itemsOf(leer([feat({ type: 'Point', coordinates: [1, 2] })]), 'point').items
  assert.equal(URL_ACCESSORS.point.positionOf(it), URL_ACCESSORS.point.positionOf(it))
  assert.equal(URL_ACCESSORS.point.idOf(it), 0)
})

test('MultiPoint toma el primer vértice', () => {
  const r = leer([feat({ type: 'MultiPoint', coordinates: [[10, 20], [30, 40]] })])
  assert.deepEqual(itemsOf(r, 'point').items[0][POSITION], { lat: 20, lng: 10 })
})

test('líneas: LineString y MultiLineString como path anidado [lat,lng]', () => {
  const r = leer([
    feat({ type: 'LineString', coordinates: [[0, 1], [2, 3]] }),
    feat({ type: 'MultiLineString', coordinates: [[[0, 1], [2, 3]], [[4, 5], [6, 7]]] }),
  ])
  const { items } = itemsOf(r, 'line')
  assert.deepEqual(items[0][PATH], [[[1, 0], [3, 2]]])
  assert.deepEqual(items[1][PATH], [[[1, 0], [3, 2]], [[5, 4], [7, 6]]])
  assert.equal(URL_ACCESSORS.line.pathOf(items[1]), items[1][PATH])
  assert.equal(items[1][FEATURE], 1)
})

test('polígonos: una parte es [exterior, hoyos…] y varias, partes anidadas', () => {
  const ext = [[0, 0], [4, 0], [4, 4], [0, 0]], hoyo = [[1, 1], [2, 1], [2, 2], [1, 1]], otro = [[8, 8], [9, 8], [9, 9], [8, 8]]
  const r = leer([
    feat({ type: 'Polygon', coordinates: [ext, hoyo] }),
    feat({ type: 'MultiPolygon', coordinates: [[ext, hoyo], [otro]] }),
  ])
  const { items } = itemsOf(r, 'polygon')
  assert.equal(items[0][RINGS].length, 2)
  assert.equal(items[1][RINGS].length, 2, 'dos partes')
  assert.equal(items[1][RINGS][0].length, 2, 'la primera con su hoyo')
  assert.deepEqual(items[1][RINGS][1][0], [[8, 8], [8, 9], [9, 9], [8, 8]])
  assert.equal(URL_ACCESSORS.polygon.ringsOf(items[0]), items[0][RINGS])
})

test('mixto: el kind ajeno y el feature sin geometría se cuentan en skipped', () => {
  const r = leer([
    feat({ type: 'Point', coordinates: [1, 1] }),
    feat({ type: 'LineString', coordinates: [[0, 0], [1, 1]] }),
    feat(null),
    feat({ type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }),
  ])
  const p = itemsOf(r, 'point')
  assert.equal(p.items.length, 1)
  assert.equal(p.skipped, 3)
  assert.equal(itemsOf(r, 'line').skipped, 3)
  assert.equal(itemsOf(r, 'polygon').skipped, 3)
  assert.equal(itemsOf(r, 'line').items[0][FEATURE], 1)
})

test('properties vacías dan ítem vacío con sus claves internas', () => {
  const r = leer([feat({ type: 'Point', coordinates: [1, 2] }, {})])
  const [it] = itemsOf(r, 'point').items
  assert.deepEqual(Object.keys(it), [])
  assert.deepEqual(it[POSITION], { lat: 2, lng: 1 })
})

test('un MultiGeometry de KML aporta cada kind a su capa', () => {
  const kml = '<kml xmlns="http://www.opengis.net/kml/2.2"><Placemark><name>x</name><MultiGeometry><Point><coordinates>1,1</coordinates></Point><LineString><coordinates>0,0 1,1</coordinates></LineString></MultiGeometry></Placemark></kml>'
  const r = readKml(kml)
  assert.equal(itemsOf(r, 'point').items.length, 1)
  assert.equal(itemsOf(r, 'line').items.length, 1)
  assert.equal(itemsOf(r, 'polygon').items.length, 0)
})

test('un kind desconocido es un error de programación', () => {
  assert.throws(() => itemsOf(leer([]), 'cosa'), TypeError)
})

test('cada ítem lleva una revisión creciente, y es el hashOf de los accessors de url', async () => {
  const { REVISION } = await import('../../src/engine/features.js')
  const a = itemsOf(leer([feat({ type: 'Point', coordinates: [1, 2] }), feat({ type: 'Point', coordinates: [3, 4] })]), 'point').items
  const b = itemsOf(leer([feat({ type: 'Point', coordinates: [1, 2] })]), 'point').items
  assert.ok(a[0][REVISION] < a[1][REVISION])
  assert.ok(a[1][REVISION] < b[0][REVISION], 'la lectura siguiente sella un número nuevo')
  assert.equal(typeof a[0][REVISION], 'number')
  assert.deepEqual(Object.keys(a[0]), [], 'la revisión no se ve al enumerar')
  for (const k of ['point', 'line', 'polygon']) assert.equal(URL_ACCESSORS[k].hashOf(a[0]), a[0][REVISION])
})
