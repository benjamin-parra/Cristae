// El oráculo se prueba a sí mismo (DISENO-INTEROP §5-3bis): contra dos fixtures con las tablas escritas
// a mano desde la regla de §2.4 y las banderas de §3.6, no desde ninguna implementación.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { oraculo } from './oraculo.mjs'
import { compararTablas } from '../comun.mjs'

const fixture = nombre => readFileSync(new URL(`corpus/${nombre}`, import.meta.url), 'utf8')

const tablas = ({ geometryAt, partAt, ringAt, vertexAt, kinds, featureOf, closed, layerOf, xy, z = null }) => ({
  geometryAt : Uint32Array.from(geometryAt),
  partAt     : Uint32Array.from(partAt),
  ringAt     : Uint32Array.from(ringAt),
  vertexAt   : Uint32Array.from(vertexAt),
  kinds      : Uint8Array.from(kinds),
  featureOf  : Uint32Array.from(featureOf),
  closed     : Uint8Array.from(closed),
  layerOf    : Uint32Array.from(layerOf),
  xy         : Float64Array.from(xy),
  z          : z && Float64Array.from(z),

  featureCount  : geometryAt.length - 1,
  geometryCount : kinds.length,
  partCount     : ringAt.length - 1,
  ringCount     : vertexAt.length - 1,
  vertexCount   : xy.length / 2,
})

const A = [4, 4, 4, 6, 6, 6, 6, 4, 4, 4]                    // isla, horaria: exterior
const B = [0, 0, 0, 10, 10, 10, 10, 0, 0, 0]                // grande, horario: exterior
const C = [2, 2, 8, 2, 8, 8, 2, 8, 2, 2]                    // antihorario: hoyo de B (A no lo contiene)
const D = [4.5, 4.5, 5.5, 4.5, 5.5, 5.5, 4.5, 5.5, 4.5, 4.5] // antihorario: hoyo de A, el más chico que lo contiene

test('hoyos-anidados: cada hoyo al exterior más chico, partes en el orden de los exteriores', () => {
  compararTablas(oraculo(fixture('degenerados/hoyos-anidados.json')), tablas({
    geometryAt: [0, 1], partAt: [0, 2], ringAt: [0, 2, 4], vertexAt: [0, 5, 10, 15, 20],
    kinds: [6], featureOf: [0], closed: [1, 1, 1, 1], layerOf: [0],
    xy: [...A, ...D, ...B, ...C],
  }))
})

test('featureset-lineas: hasZ del FeatureSet, llegado después, decide la z de todos', () => {
  compararTablas(oraculo(fixture('felices/featureset-lineas.json')), tablas({
    geometryAt: [0, 1, 2], partAt: [0, 1, 3], ringAt: [0, 1, 2, 3], vertexAt: [0, 2, 4, 6],
    kinds: [3, 4], featureOf: [0, 1], closed: [0, 0, 0], layerOf: [0, 0],
    xy: [1, 1, 2, 2, 0, 0, 1, 0, 3, 3, 4, 4], z: [10, 20, 5, NaN, 7, 8],
  }))
})

test('el oráculo se planta fuera del contrato en vez de inventar', () => {
  assert.throws(() => oraculo('{}'), /oraculo/)
  assert.throws(() => oraculo('[]'), /oraculo/)
})
