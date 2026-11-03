// El oráculo de WKT se prueba a sí mismo (DISENO-INTEROP §5-3bis): contra tablas escritas a mano con
// la regla de §17.1, no contra el lector. Si compartiera un error con el lector, lo volvería invisible.
import test from 'node:test'
import assert from 'node:assert/strict'
import { oraculo } from '../../geojson/oraculo.mjs'
import { wktAGeoJson } from './oraculo-wkt.mjs'

const tablas = texto => {
  const o = oraculo(wktAGeoJson(texto))
  return {
    geometryAt : [...o.geometryAt], partAt : [...o.partAt], ringAt  : [...o.ringAt],
    vertexAt   : [...o.vertexAt],   kinds  : [...o.kinds],  closed  : [...o.closed],
    xy         : [...o.xy],         z      : o.z && [...o.z],
  }
}

test('Polygon con hoyo: una parte, dos anillos (§17.1)', () =>
  assert.deepEqual(tablas('POLYGON((0 0, 1 0, 1 1, 0 0), (0.2 0.2, 0.4 0.2, 0.4 0.4, 0.2 0.2))'), {
    geometryAt : [0, 1],
    partAt     : [0, 1],
    ringAt     : [0, 2],
    vertexAt   : [0, 4, 8],
    kinds      : [5],
    closed     : [1, 1],
    xy         : [0, 0, 1, 0, 1, 1, 0, 0, 0.2, 0.2, 0.4, 0.2, 0.4, 0.4, 0.2, 0.2],
    z          : null,
  }))

test('colección con MULTILINESTRING de una línea vacía y un punto M: la M no llega a z', () =>
  assert.deepEqual(tablas('GEOMETRYCOLLECTION(POINT M (1 2 9), MULTILINESTRING((0 0, 1 1), EMPTY))'), {
    geometryAt : [0, 2],
    partAt     : [0, 1, 3],
    ringAt     : [0, 1, 2, 3],
    vertexAt   : [0, 1, 3, 3],
    kinds      : [1, 4],
    closed     : [0, 0, 0],
    xy         : [1, 2, 0, 0, 1, 1],
    z          : null,
  }))

test('dos raíces y un MULTIPOINT con punto vacío; la Z sin modificador se conserva', () =>
  assert.deepEqual(tablas('MULTIPOINT(EMPTY, 1 2 3)\nPOINT EMPTY'), {
    geometryAt : [0, 1, 2],
    partAt     : [0, 1, 1],
    ringAt     : [0, 1],
    vertexAt   : [0, 1],
    kinds      : [2, 1],
    closed     : [0],
    xy         : [1, 2],
    z          : [3],
  }))
