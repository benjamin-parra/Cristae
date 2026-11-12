// Fija el re-rasterizado interno del IconSet (REBAKE/RECONFIGURE): atlas de identidad nueva con índices
// estables, aviso a onAtlasRefresh una sola vez por microtarea, descarte de lo adelantado y mutación de
// las propiedades públicas. El harness shimea el canvas: se prueba direccionamiento, no píxeles.
import '../../test-helpers/engine-stub.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { defineIconSet, REBAKE, RECONFIGURE } from '../../src/atlas/IconSet.js'
import { readFileSync } from 'node:fs'


const makeSet = (extra = {}) => {
  const conteo = new Map()
  const set = defineIconSet({
    describe: v => ({ shape: 'g', variant: v }),
    renderers: { g: (_c, _s, d) => conteo.set(d.variant, (conteo.get(d.variant) ?? 0) + 1) },
    ...extra,
  })
  return { set, conteo }
}

test('REBAKE: identidad nueva, índices conservados, un aviso por microtarea', async () => {
  const { set, conteo } = makeSet()
  await set.ready
  const a = set.resolve('a'), b = set.resolve('b')
  let avisos = 0
  set.onAtlasRefresh(() => avisos++)
  const prev = set.atlas

  set[REBAKE](); set[REBAKE](); set[REBAKE]()
  assert.equal(avisos, 0, 'nada síncrono: se coalesce en una microtarea')
  await Promise.resolve()

  assert.equal(avisos, 1)
  assert.notEqual(set.atlas, prev)
  assert.equal(set.atlas.generation, prev.generation + 1)
  assert.equal(set.resolve('a'), a)
  assert.equal(set.resolve('b'), b)
  assert.equal(conteo.get('a'), 2, 're-rasterizó lo resuelto')

  set[REBAKE]()
  await Promise.resolve()
  assert.equal(avisos, 2, 'un pedido en otro turno es otro re-rasterizado')
})

test('REBAKE descarta lo adelantado (#prepared): se rasteriza de nuevo al usarlo', async () => {
  const { set, conteo } = makeSet({ variants: ['x', 'y'] })
  await set.ready
  set.resolve('x')                                  // arma el adelanto
  await new Promise(r => setTimeout(r, 120))        // el adelanto deja 'y' preparada
  const antes = conteo.get('y') ?? 0
  assert.equal(antes, 1, 'y quedó adelantada')
  set[REBAKE]()
  await Promise.resolve()
  set.resolve('y')
  assert.equal(conteo.get('y'), 2, 'lo adelantado no sobrevive: se rasteriza otra vez')
})

test('RECONFIGURE refleja rotates y defaultSize y cambia lo que se dibuja', async () => {
  const { set, conteo } = makeSet()
  await set.ready
  set.resolve('a')
  assert.equal(set.rotates, false)
  let avisos = 0
  set.onAtlasRefresh(() => avisos++)

  let nuevo = 0
  set[RECONFIGURE]({ rotates: true, defaultSize: 48, describe: v => ({ shape: 'h', variant: v }), renderers: { h: () => nuevo++ } })
  assert.equal(set.rotates, true)
  assert.equal(set.defaultSize, 48)
  await Promise.resolve()
  assert.equal(nuevo, 1)
  assert.equal(avisos, 1)
  assert.equal(conteo.get('a'), 1)
})

test('REBAKE y RECONFIGURE no se reexportan en src/index.js', () => {
  const indice = readFileSync(new URL('../../src/index.js', import.meta.url), 'utf8')
  assert.doesNotMatch(indice, /\bREBAKE\b|\bRECONFIGURE\b/)
})
