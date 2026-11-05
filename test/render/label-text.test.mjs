// La medida de los rótulos sin canvas: un contexto falso cuyo ancho depende de la fuente asignada y cuenta
// las mediciones. Fija la unidad (el grafema), la caché por fuente y `forget`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createMeasure } from '../../src/render/labelText.js'

// Cada punto de código mide el tamaño en px de la fuente vigente: un grafema de dos mide el doble.
const fakeCtx = () => {
  const ctx = {
    font        : '',
    calls       : 0,
    measureText : s => {
      ctx.calls++
      const px = Number(/(\d+)px/.exec(ctx.font)[1])
      return { width: px * [...s].length, fontBoundingBoxAscent: px * 0.8, fontBoundingBoxDescent: px * 0.2 }
    },
  }
  return ctx
}

const A = '700 10px Inter'
const B = '400 20px Inter'

test('É en NFD, una bandera y una familia con ZWJ son un grafema cada uno', () => {
  const m = createMeasure(fakeCtx())
  assert.deepEqual(m.glyphs(A, 'ÉB').units, ['É', 'B'])
  assert.equal(m.glyphs(A, '🇨🇱').units.length, 1)
  assert.equal(m.glyphs(A, '👨‍👩‍👧').units.length, 1)
  assert.equal(m.glyphs(A, 'ÉB').widths.length, 2)
})

test('anchos por grafema, total, ascenso y descenso', () => {
  const g = createMeasure(fakeCtx()).glyphs(A, 'ab')
  assert.deepEqual([...g.widths], [10, 10])
  assert.equal(g.total, 20)
  assert.equal(g.ascent, 8)
  assert.equal(g.descent, 2)
  assert.equal(g.text, 'ab')
  assert.ok(Object.isFrozen(g))
})

test('dos fuentes guardan anchos distintos para el mismo grafema', () => {
  const m = createMeasure(fakeCtx())
  assert.equal(m.glyphs(A, 'x').widths[0], 10)
  assert.equal(m.glyphs(B, 'x').widths[0], 20)
  assert.equal(m.glyphs(A, 'x').widths[0], 10)
})

test('la misma fuente y el mismo texto dan el mismo objeto sin volver a medir', () => {
  const ctx = fakeCtx()
  const m   = createMeasure(ctx)
  const g   = m.glyphs(A, 'ruta 5')
  const n   = ctx.calls
  assert.equal(m.glyphs(A, 'ruta 5'), g)
  assert.equal(ctx.calls, n)
})

test('un grafema repetido en otro texto de la misma fuente no se vuelve a medir suelto', () => {
  const ctx = fakeCtx()
  const m   = createMeasure(ctx)
  m.glyphs(A, 'ab')
  const n = ctx.calls
  m.glyphs(A, 'ba')
  assert.equal(ctx.calls, n + 1)                         // sólo el texto entero, por su caja
})

test('mide con la fuente pedida aunque el contexto haya quedado en otra', () => {
  const ctx = fakeCtx()
  const m   = createMeasure(ctx)
  ctx.font = B
  assert.equal(m.glyphs(A, 'q').widths[0], 10)
})

test('forget vacía sólo su fuente', () => {
  const ctx = fakeCtx()
  const m   = createMeasure(ctx)
  const a   = m.glyphs(A, 'abc')
  const b   = m.glyphs(B, 'abc')
  m.forget(A)
  const n = ctx.calls
  assert.equal(m.glyphs(B, 'abc'), b)
  assert.equal(ctx.calls, n)
  const again = m.glyphs(A, 'abc')
  assert.notEqual(again, a)
  assert.ok(ctx.calls > n)
})

test('sin caja de fuente en el contexto, el alto sale del tamaño de la fuente', () => {
  const ctx = { font: '', measureText: s => ({ width: s.length }) }
  const g   = createMeasure(ctx).glyphs('12px sans-serif', 'a')
  assert.ok(Math.abs(g.ascent + g.descent - 12) < 1e-9)
})
