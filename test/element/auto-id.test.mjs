// makeAutoId (src/element/autoId.js): id incremental por KIND. Centraliza el `let seq = 0` que cada
// elemento declarativo repetía, así que el contrato a preservar es el de esos contadores: `<kind>-1`,
// `<kind>-2`, … y kinds independientes entre sí. Función pura (sin DOM ni Leaflet). El estado del Map
// persiste dentro del archivo, así que cada test usa un kind propio para arrancar su secuencia en 1.
// Corre con: node --test test/element/auto-id.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { makeAutoId } from '../../src/element/autoId.js'

test('el primer id de un kind es `<kind>-1`', () => {
  assert.equal(makeAutoId('alpha'), 'alpha-1')
})

test('incrementa por llamada dentro de un mismo kind', () => {
  assert.equal(makeAutoId('beta'), 'beta-1')
  assert.equal(makeAutoId('beta'), 'beta-2')
  assert.equal(makeAutoId('beta'), 'beta-3')
})

test('cada kind lleva su propia secuencia (independientes)', () => {
  assert.equal(makeAutoId('uno'), 'uno-1')
  assert.equal(makeAutoId('dos'), 'dos-1')   // el contador de 'uno' no lo arrastra
  assert.equal(makeAutoId('uno'), 'uno-2')
  assert.equal(makeAutoId('dos'), 'dos-2')
})

test('el kind se usa literal como prefijo (incluye guiones)', () => {
  assert.equal(makeAutoId('cluster-marker'), 'cluster-marker-1')
  assert.equal(makeAutoId('cluster-marker'), 'cluster-marker-2')
})
