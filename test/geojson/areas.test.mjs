// `areasOf`: de un documento mixto, qué anillos y qué partes son de área. Devuelve la selección de
// índices; las tablas de geometría se pasan tal cual, sin copiar un vértice.
import test from 'node:test'
import assert from 'node:assert/strict'
import { leer, areasDe } from './lector.mjs'

const doc = valor => new TextEncoder().encode(JSON.stringify(valor))

const feature = geometry => ({ type: 'Feature', properties: {}, geometry })
const anillo  = d => [[d, d], [d + 1, d], [d + 1, d + 1], [d, d + 1], [d, d]]

const MIXTO = doc({
  type: 'FeatureCollection',
  features: [
    feature({ type: 'Point', coordinates: [0, 0] }),
    feature({ type: 'Polygon', coordinates: [anillo(10), anillo(10.2)] }),
    feature({ type: 'LineString', coordinates: [[1, 1], [2, 2], [3, 3]] }),
    feature({ type: 'MultiPolygon', coordinates: [[anillo(20)], [anillo(30)]] }),
    feature({ type: 'MultiPoint', coordinates: [[4, 4], [5, 5]] }),
  ],
})

test('sólo Polygon y MultiPolygon aportan anillos y partes', () => {
  const geo = leer(MIXTO)
  const { rings, parts } = areasDe(geo)
  // Polygon: 1 parte con 2 anillos. MultiPolygon: 2 partes con 1 anillo cada una.
  assert.equal(parts.length, 3)
  assert.equal(rings.length, 4)
  // Ningún anillo seleccionado puede ser el del punto (1 vértice) ni el de la línea (sin cerrar).
  rings.forEach(r => assert.ok(geo.vertexAt[r + 1] - geo.vertexAt[r] >= 4, `anillo ${r} no es un área`))
  // Los kinds 5 y 6 son Polygon y MultiPolygon.
  parts.forEach(p => assert.ok([5, 6].includes(geo.kinds[geo.geometryOf(p)]), `parte ${p} no es de área`))
})

test('las tablas se pasan tal cual: la selección no copia geometría', () => {
  const geo = leer(MIXTO)
  const g   = areasDe(geo)
  assert.equal(g.xy, geo.xy)
  assert.equal(g.vertexAt, geo.vertexAt)
  assert.equal(g.ringAt, geo.ringAt)
  assert.equal(g.closed, geo.closed)
})

test('un documento de puros polígonos selecciona todo', () => {
  const geo = leer(doc({
    type: 'FeatureCollection',
    features: [feature({ type: 'Polygon', coordinates: [anillo(0)] }), feature({ type: 'Polygon', coordinates: [anillo(5)] })],
  }))
  const { rings, parts } = areasDe(geo)
  assert.deepEqual([...rings], [0, 1])
  assert.deepEqual([...parts], [0, 1])
})

test('un documento sin áreas no selecciona nada', () => {
  const geo = leer(doc({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [1, 2] } }))
  const { rings, parts } = areasDe(geo)
  assert.equal(rings.length, 0)
  assert.equal(parts.length, 0)
})
