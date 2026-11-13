// Las opciones de los rótulos: la mezcla (`undefined` no cambia, `null` vuelve al defecto), cada
// `TypeError` que depende sólo de las props, lo que `gl` admite y la colocación por tipo de capa.
import test from 'node:test'
import assert from 'node:assert/strict'
import { LABEL_DEFAULTS, mergeLabelOptions, resolvePlacement } from '../../src/render/labelOptions.js'

const paint = () => {}

test('los defectos: canvas, auto, sin repetir, texto con halo y congelados', () => {
  const o = mergeLabelOptions(null, {})
  assert.equal(o.renderer, 'canvas')
  assert.equal(o.placement, 'auto')
  assert.equal(o.repeat, null)
  assert.equal(o.offset, 0)
  assert.equal(o.orientation, 'auto')
  assert.equal(o.color, '#0f172a')
  assert.equal(o.halo, '#ffffff')
  assert.equal(o.paint, null)
  assert.equal(o.interactive, false)
  assert.equal(o.visible, true)
  assert.ok(Object.isFrozen(LABEL_DEFAULTS))
})

test('undefined no cambia; null vuelve al defecto; devuelve otro objeto', () => {
  const a = mergeLabelOptions(null, { placement: 'along', repeat: 240, offset: 6 })
  const b = mergeLabelOptions(a, { offset: undefined, repeat: null })
  assert.notEqual(a, b)
  assert.equal(b.offset, 6)
  assert.equal(b.repeat, null)
  assert.equal(a.repeat, 240)
  assert.equal(mergeLabelOptions(b, { placement: null }).placement, 'auto')
})

test('las claves que no son opciones se ignoran', () => {
  assert.equal(mergeLabelOptions(null, { hostId: 'rutas' }).hostId, undefined)
})

test('renderer sale de htmlOf si no se declaró, y lo declarado gana', () => {
  const htmlOf = () => 'x'
  const a = mergeLabelOptions(null, { htmlOf })
  assert.equal(a.renderer, 'html')
  assert.equal(mergeLabelOptions(a, { htmlOf: null }).renderer, 'canvas')
  const b = mergeLabelOptions(null, { renderer: 'html' })
  assert.equal(mergeLabelOptions(b, { htmlOf: null }).renderer, 'html')
  assert.equal(mergeLabelOptions(b, { renderer: null }).renderer, 'canvas')
})

test('gl vale con lo que no pide trazo ni canvas ni html, y el defecto sigue en canvas', () => {
  const o = mergeLabelOptions(null, { renderer: 'gl', placement: 'below', offset: 4, font: '12px serif', color: 'red', halo: 'none' })
  assert.equal(o.renderer, 'gl')
  ;['center', 'above', 'below', 'right', 'auto'].forEach(placement => assert.equal(mergeLabelOptions(o, { placement }).renderer, 'gl'))
  assert.equal(mergeLabelOptions(o, { renderer: null }).renderer, 'canvas')
  assert.equal(mergeLabelOptions(null, {}).renderer, 'canvas')
})

test('gl con paint, htmlOf o interactive lanza el TypeError de siempre, y along dice que está pendiente; nada cambia', () => {
  const prev = mergeLabelOptions(null, { renderer: 'gl' })
  const copy = { ...prev }
  const cases = [
    [{ paint }, /paint pide renderer 'canvas', no 'gl'/],
    [{ htmlOf: () => 'x' }, /htmlOf pide renderer 'html', no 'gl'/],
    [{ interactive: true }, /interactive pide renderer 'html', no 'gl'/],
    [{ placement: 'along' }, /'along' con renderer 'gl' está pendiente/],
    [{ repeat: 240 }, /'along' con renderer 'gl' está pendiente/],
    [{ orientation: 'path' }, /'along' con renderer 'gl' está pendiente/],
  ]
  cases.forEach(([patch, message]) => assert.throws(() => mergeLabelOptions(prev, patch), { name: 'TypeError', message }, JSON.stringify(patch)))
  assert.throws(() => mergeLabelOptions(null, { placement: 'along', renderer: 'gl' }), /pendiente/, 'también al declararlos juntos')
  assert.deepEqual({ ...prev }, copy)
})

test('resolvePlacement: auto que resuelve a along con gl lanza pendiente; center sobre la línea vale', () => {
  const gl = mergeLabelOptions(null, { renderer: 'gl' })
  ;['line', 'polygon'].forEach(kind => assert.equal(resolvePlacement(kind, mergeLabelOptions(gl, { placement: 'center' })), 'center'))
  assert.throws(() => resolvePlacement('line', gl), { name: 'TypeError', message: /pendiente/ })
  assert.equal(resolvePlacement('polygon', gl), 'center')
  assert.equal(resolvePlacement('text', gl), 'center')
})

test('cada TypeError de las props, y el estado previo no cambia', () => {
  const prev = mergeLabelOptions(null, { offset: 3 })
  const copy = { ...prev }
  const cases = [
    { renderer: 'svg' },
    { placement: 'start' },
    { orientation: 'left' },
    { repeat: 0 },
    { repeat: -5 },
    { repeat: Infinity },
    { offset: NaN },
    { offset: Infinity },
    { htmlOf: () => 'x', renderer: 'canvas' },
    { interactive: true },
    { interactive: true, renderer: 'canvas' },
    { paint, renderer: 'html' },
    { paint, placement: 'below' },
    { paint, placement: 'along' },
    { placement: 'center', repeat: 100 },
    { placement: 'below', orientation: 'path' },
    { textOf: 'codigo' },
    { font: 12 },
    { visible: 'false' },
  ]
  cases.forEach(patch => assert.throws(() => mergeLabelOptions(prev, patch), TypeError, JSON.stringify(patch)))
  assert.deepEqual({ ...prev }, copy)
})

test('lo que sí vale: along con repeat y path; auto con repeat; html con interactive; paint con center', () => {
  assert.doesNotThrow(() => mergeLabelOptions(null, { placement: 'along', repeat: 240, orientation: 'path', offset: -8 }))
  assert.doesNotThrow(() => mergeLabelOptions(null, { repeat: 240, orientation: 'path' }))
  assert.doesNotThrow(() => mergeLabelOptions(null, { htmlOf: () => 'x', interactive: true }))
  assert.doesNotThrow(() => mergeLabelOptions(null, { renderer: 'html', interactive: true }))
  assert.doesNotThrow(() => mergeLabelOptions(null, { paint, placement: 'center' }))
  assert.doesNotThrow(() => mergeLabelOptions(null, { halo: 'none' }))
})

test('resolvePlacement: auto da la natural de cada capa', () => {
  const auto = mergeLabelOptions(null, {})
  const got  = Object.fromEntries(['point', 'html', 'bubble', 'line', 'polygon', 'shape'].map(k => [k, resolvePlacement(k, auto)]))
  assert.deepEqual(got, { point: 'below', html: 'below', bubble: 'below', line: 'along', polygon: 'center', shape: 'center' })
})

test('resolvePlacement: auto con paint es center en todas', () => {
  const o = mergeLabelOptions(null, { paint })
  ;['point', 'html', 'bubble', 'line', 'polygon', 'shape'].forEach(k => assert.equal(resolvePlacement(k, o), 'center', k))
})

test('resolvePlacement: cada explícito admitido pasa y cada uno no admitido lanza', () => {
  const admits = {
    point   : ['center', 'above', 'below', 'right'],
    html    : ['center', 'above', 'below', 'right'],
    bubble  : ['center', 'above', 'below', 'right'],
    line    : ['along', 'center'],
    polygon : ['along', 'center'],
    shape   : ['center'],
  }
  const all = ['along', 'center', 'above', 'below', 'right']
  Object.entries(admits).forEach(([kind, ok]) => all.forEach(placement => {
    const o = mergeLabelOptions(null, { placement })
    ok.includes(placement)
      ? assert.equal(resolvePlacement(kind, o), placement)
      : assert.throws(() => resolvePlacement(kind, o), { name: 'TypeError', message: new RegExp(kind) }, `${placement} sobre ${kind}`)
  }))
})

test('resolvePlacement: una capa que no se rotula lanza', () => {
  ;['heat', 'image', 'editable'].forEach(kind => assert.throws(() => resolvePlacement(kind, LABEL_DEFAULTS), TypeError))
})
