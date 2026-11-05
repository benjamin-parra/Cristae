// Planificador puro de tramos (PLAN-C-MINIMO §8, pieza 2): P1 corridas, P2 altas y partidos, P3 orden por z.

import test from 'node:test'
import assert from 'node:assert/strict'
import { SEPARATOR as S, orderByZ, planTramos } from '../../src/render/tramo-plan.js'

// tokens y prev como arrays planos; devuelve [ids, próximo libre]
const plan = (tokens, prev, nextId) => {
  const out  = new Int32Array(tokens.length).fill(99)
  const next = planTramos(Int32Array.from(tokens), tokens.length, Int32Array.from(prev), nextId, out)
  return [Array.from(out), next]
}

test('P1 corridas y separadores: ids conservados, separadores en -1', () => {
  assert.equal(S, -1)
  assert.deepEqual(plan([0, 1, S, 2, 3], [5, 5, 7, 7], 10), [[5, 5, -1, 7, 7], 10])
  assert.deepEqual(plan([S, 0, S, S, 1, S], [3, 4], 10), [[-1, 3, -1, -1, 4, -1], 10], 'separadores en los bordes y corrida vacía')
  assert.deepEqual(plan([0, 1], [300, 300], 301), [[300, 300], 301], 'un id que no entra en la memoria auxiliar')
  assert.deepEqual(plan([], [], 4), [[], 4])
})

test('P2 altas: abajo, si no arriba, si no un id fresco compartido por corrida', () => {
  assert.deepEqual(plan([0, 1, 2], [3, -1, 4], 10), [[3, 3, 4], 10], 'entre dos segmentos toma el de abajo')
  assert.deepEqual(plan([0, 1, 2], [-1, -1, 4], 10), [[4, 4, 4], 10], 'sin abajo toma el de arriba')
  assert.deepEqual(plan([0, 1, S, 2], [-1, -1, -1], 10), [[10, 10, -1, 11], 12], 'corridas sin viejos: uno fresco por corrida')
  assert.deepEqual(plan([0, 1, 2], [3, -1, 3], 10), [[3, 3, 3], 10], 'un nuevo intercalado no corta el segmento')
})

test('P2 partidos: el de menor K conserva el id, nunca se funde', () => {
  assert.deepEqual(plan([0, 1, S, 2, 3], [3, 3, 3, 3], 10), [[3, 3, -1, 10, 10], 11], 'partir: fresco arriba')
  assert.deepEqual(plan([0, 1, 2, 3], [3, 4, -1, 3], 10), [[3, 4, 4, 10], 11], 'A,B,A: fresco a la segunda A')
  assert.deepEqual(plan([0, 1], [3, 4], 10), [[3, 4], 10], 'se fue el separador: adyacentes siguen separados')
  assert.deepEqual(plan([0, S, 1, 2, S, 3], [3, 3, 3, 3], 10), [[3, -1, 10, 10, -1, 11], 12], 'un fresco por segmento')
  assert.deepEqual(plan([0, S, 1, 2], [3, -1, 3], 10), [[3, -1, 10, 10], 11], 'el nuevo de arriba toma el id resuelto, no el prev')
})

test('P3 orderByZ: estable con empates, z negativas y cero', () => {
  const out = new Int32Array(5)
  assert.equal(orderByZ([0, -2, 0, 5, -2], 5, out), out)
  assert.deepEqual(Array.from(out), [1, 4, 0, 2, 3])
  assert.deepEqual(Array.from(orderByZ([7, 7, 7], 3, new Int32Array(3))), [0, 1, 2])
})
