// El generador se contrasta contra fixtures hex escritas a mano campo por campo (DISENO-INTEROP
// §5-3bis): si compartiera un error con el lector, el diferencial no lo vería.
import test from 'node:test'
import assert from 'node:assert/strict'
import { escribirWkb, hex } from './generador.mjs'
import { FIXTURES } from './fixtures.mjs'

test('POINT(1 2), little endian, ISO', () =>
  assert.equal(hex(escribirWkb({ type: 'Point', coordinates: [1, 2] })), FIXTURES.puntoLE))

test('LINESTRING Z (1 2 3, 4 5 6), big endian, ISO 1002', () =>
  assert.equal(hex(escribirWkb({ type: 'LineString', coordinates: [[1, 2, 3], [4, 5, 6]] }, { orden: 'be', dims: 'xyz' })), FIXTURES.lineaZBE))

test('SRID=4326;POINT(1 2), EWKB', () =>
  assert.equal(hex(escribirWkb({ type: 'Point', coordinates: [1, 2] }, { sabor: 'ewkb', srid: 4326 })), FIXTURES.puntoEwkbSrid))

test('MULTIPOINT M con órdenes mezclados: cada hijo lleva su byte de orden', () =>
  assert.equal(
    hex(escribirWkb({ type: 'MultiPoint', coordinates: [[1, 2]] }, { orden: p => p ? 'be' : 'le', dims: 'xym', m: 3 })),
    FIXTURES.multipuntoMMezclado,
  ))
