// Fija el despacho de defineIconSet: `icons` arma el set de imágenes, la mezcla con las claves de
// canvas se rechaza, y la forma canvas de siempre sigue construyendo el IconSet clásico.
import test from 'node:test'
import assert from 'node:assert/strict'
import { instalarCanvas2d } from '../../test-helpers/canvas-2d.mjs'
import { defineIconSet, IconSet } from '../../src/atlas/IconSet.js'

instalarCanvas2d()

const describe = () => ({ shape: 'a' })
const renderers = { a: () => {} }

test('icons junto a describe lanza TypeError', () => {
  assert.throws(() => defineIconSet({ icons: { a: 'a.svg' }, describe }), TypeError)
})

test('icons junto a renderers lanza TypeError', () => {
  assert.throws(() => defineIconSet({ icons: { a: 'a.svg' }, renderers }), TypeError)
})

test('icons devuelve un IconSet', () => {
  const set = defineIconSet({ icons: { camion: 'camion.svg', grua: 'grua.svg' }, fetch: async () => { throw new Error('sin red') } })
  assert.ok(set instanceof IconSet)
  assert.ok(set.ready instanceof Promise)
})

test('la forma canvas de hoy no cambia', () => {
  const set = defineIconSet({ variants: ['a'], describe, renderers })
  assert.ok(set instanceof IconSet)
  assert.equal(set.resolve('a'), 0)
})
