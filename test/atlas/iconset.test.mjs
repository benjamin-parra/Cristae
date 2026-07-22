// Fija la LÓGICA PURA del IconSet: la LUT de clusters (variantForCount O(1), bordes de bucket, `plus`
// derivado de la topología), el round-trip describe ⇄ marked/expandedVariant, y la normalización de
// `scale` (footprint) que expone tileScale. El IconSet rasteriza a <canvas>; en node no hay DOM → stub
// mínimo cuyo getContext basta porque el `draw`/renderer de prueba ignora el contexto: probamos
// direccionamiento y derivación, NO el pixel rasterizado.
import test from 'node:test'
import assert from 'node:assert/strict'
import { defineClusterIconSet, defineIconSet } from '../../src/atlas/IconSet.js'

// Canvas de utilería: #rasterize hace createElement('canvas').getContext('2d') y le asigna width/height;
// un objeto vacío que acepta esas escrituras y devuelve un ctx cualquiera alcanza. Se instala una vez.
globalThis.document = { createElement: () => ({ getContext: () => ({}) }) }

test('variantForCount: piso por bucket (mayor threshold ≤ count) con clamp en 0 y en top', async () => {
  const set = defineClusterIconSet({ buckets: [2, 3, 10], draw: () => {} })
  await set.ready
  // values = [2, 3, 10], top = 10.
  assert.equal(set.variantForCount(-9), '2')     // negativo → clamp a 0 → menor bucket
  assert.equal(set.variantForCount(0), '2')
  assert.equal(set.variantForCount(1), '2')
  assert.equal(set.variantForCount(2), '2')      // borde exacto
  assert.equal(set.variantForCount(3), '3')      // borde exacto del siguiente
  assert.equal(set.variantForCount(9), '3')      // 3 ≤ 9 < 10
  assert.equal(set.variantForCount(10), '10')    // borde = top
  assert.equal(set.variantForCount(9999), '10')  // clamp techo
})

test('variantForCount: strings estables para el mismo bucket (indexa la LUT, no concatena)', async () => {
  const set = defineClusterIconSet({ buckets: [2, 5], draw: () => {} })
  await set.ready
  assert.equal(set.variantForCount(6), set.variantForCount(9))    // ambos → bucket 5
  assert.strictEqual(set.variantForCount(5), set.variantForCount(500))
})

test('buckets: vacío o todo-negativo lanza (no hay bucket válido)', () => {
  assert.throws(() => defineClusterIconSet({ buckets: [], draw: () => {} }), /no puede quedar vacío/)
  assert.throws(() => defineClusterIconSet({ buckets: [-5, -1], draw: () => {} }), /no puede quedar vacío/)
})

test('buckets: [10, 2, 5, 5, 2] se normaliza a [2, 5, 10] (dedup + orden ascendente)', async () => {
  const set = defineClusterIconSet({ buckets: [10, 2, 5, 5, 2], draw: () => {} })
  await set.ready
  assert.equal(set.variantForCount(2), '2')
  assert.equal(set.variantForCount(5), '5')
  assert.equal(set.variantForCount(10), '10')
})

test('describe (round-trip vía draw): las variantes plain derivan `plus` de la topología de buckets', async () => {
  const calls = []
  const set = defineClusterIconSet({
    buckets: [2, 3, 10],
    draw: (_ctx, _size, count, plus, dim, marked) => calls.push({ count, plus, dim, marked }),
  })
  await set.ready                                 // siembra '2','3','10' en orden ascendente
  assert.deepEqual(calls, [
    { count: 2,  plus: false, dim: false, marked: false },   // 3 es bucket ⇒ 2 es exacto, sin '+'
    { count: 3,  plus: true,  dim: false, marked: false },   // 4 no es bucket ⇒ '+'
    { count: 10, plus: true,  dim: false, marked: false },   // 11 no es bucket ⇒ '+'
  ])
})

test('describe (round-trip): marked/expandedVariant prenden su flag sin alterar count ni plus', async () => {
  const calls = []
  const set = defineClusterIconSet({
    buckets: [2, 3, 10],
    draw: (_ctx, _size, count, plus, dim, marked) => calls.push({ count, plus, dim, marked }),
  })
  await set.ready
  calls.length = 0                                // descartar la siembra

  set.resolve(set.markedVariant(3))               // 'm3' → prefijo 'm'
  assert.deepEqual(calls.at(-1), { count: 3, plus: true, dim: false, marked: true })

  set.resolve(set.expandedVariant(3))             // 'd3' → prefijo 'd'
  assert.deepEqual(calls.at(-1), { count: 3, plus: true, dim: true, marked: false })
})

test('DEFAULT_CLUSTER_BUCKETS (tabla+flatMap): conserva los 3 tramos 2–99·1 / 100–990·10 / 1000–2000·100', async () => {
  const set = defineClusterIconSet({ draw: () => {} })  // buckets por defecto
  await set.ready
  assert.equal(set.variantForCount(1), '2')       // piso
  assert.equal(set.variantForCount(2), '2')
  assert.equal(set.variantForCount(99), '99')     // último del tramo 1
  assert.equal(set.variantForCount(100), '100')   // primero del tramo 2
  assert.equal(set.variantForCount(105), '100')   // 100 ≤ 105 < 110
  assert.equal(set.variantForCount(110), '110')
  assert.equal(set.variantForCount(1000), '1000') // primero del tramo 3
  assert.equal(set.variantForCount(1050), '1000') // 1000 ≤ 1050 < 1100
  assert.equal(set.variantForCount(2000), '2000') // tope inclusivo
  assert.equal(set.variantForCount(50000), '2000')// clamp techo
})

test('tileScale: refleja el `scale` del descriptor normalizado (ausente o ≤ 0 → 1)', async () => {
  const scalePor = { a: 2, b: 0, c: -3, d: undefined }
  const set = defineIconSet({
    variants: ['a', 'b', 'c', 'd'],
    describe: (v) => ({ shape: 'dot', scale: scalePor[v] }),
    renderers: { dot: () => {} },
  })
  await set.ready
  assert.equal(set.tileScale(set.resolve('a')), 2)   // > 0 pasa tal cual
  assert.equal(set.tileScale(set.resolve('b')), 1)   // 0 → 1
  assert.equal(set.tileScale(set.resolve('c')), 1)   // negativo → 1
  assert.equal(set.tileScale(set.resolve('d')), 1)   // ausente → 1
  assert.equal(set.tileScale(999), 1)                // índice sin scale registrado → 1
})
