// El oráculo se prueba a sí mismo (DISENO-INTEROP §5-3bis): contra dos fixtures con las tablas escritas
// a mano, derivadas de la especificación y no de ninguna implementación.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { oraculo } from './oraculo.mjs'
import { compararTablas } from '../comun.mjs'

const fixture = nombre => readFileSync(new URL(`corpus/${nombre}`, import.meta.url), 'utf8')

// Las cuatro tablas de un documento sin z, con sus conteos.
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

test('poligonos-compartidos: delta, escala, traslación y el arco común recorrido al revés', () => {
  // §2.1.2: (2,0)+(0,2) → (2,2); x·0,5 + 10, y·2 + 20. Izquierdo: arco 0 y arco 1 sin su primera
  // posición. Derecho: arco 2 y ~0 = arco 0 invertido sin su primera posición.
  const esperado = tablas({
    geometryAt: [0, 1, 2], partAt: [0, 1, 2], ringAt: [0, 1, 2], vertexAt: [0, 5, 10],
    kinds: [5, 5], featureOf: [0, 1], closed: [1, 1], layerOf: [0, 0],
    xy: [11, 20, 11, 24, 10, 24, 10, 20, 11, 20, 11, 20, 12, 20, 12, 24, 11, 24, 11, 20],
  })
  const leido = oraculo(fixture('felices/poligonos-compartidos.json'))
  compararTablas(leido, esperado)
  assert.deepEqual(leido.layers, [{ name: 'parcelas', parent: -1 }])
})

test('orden-de-miembros: MultiLineString con ~0 y un Point con z, cada objeto su capa', () => {
  const esperado = tablas({
    geometryAt: [0, 1, 2], partAt: [0, 2, 3], ringAt: [0, 1, 2, 3], vertexAt: [0, 3, 6, 7],
    kinds: [4, 1], featureOf: [0, 1], closed: [0, 0, 0], layerOf: [0, 1],
    xy: [0, 0, 1, 0, 1, 1, 1, 1, 1, 0, 0, 0, 5, 6], z: [NaN, NaN, NaN, NaN, NaN, NaN, 7],
  })
  const leido = oraculo(fixture('especificacion/orden-de-miembros.json'))
  compararTablas(leido, esperado)
  assert.deepEqual(leido.layers.map(l => l.name), ['vias', 'punto'])
})

test('el oráculo se planta fuera del contrato en vez de inventar', () => {
  assert.throws(() => oraculo('{"type":"FeatureCollection"}'), /oraculo/)
  assert.throws(() => oraculo('{"type":"Topology","objects":{"a":{"type":"LineString","arcs":[3]}},"arcs":[]}'), /oraculo/)
})
