// Lectores de atributos del terreno (src/element/terrainAttrs.js): puros, sin DOM.
// Corre con: node --test test/element/terrain-attrs.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseSlopeBreaks, parseSlopeColors, parseElevationRange, parseDem, hillshadeAttr,
} from '../../src/element/terrainAttrs.js'

const grados = r => Math.atan(r) * 180 / Math.PI

test('parseSlopeBreaks — porcentaje a razón m/m', () => {
  assert.deepEqual(parseSlopeBreaks('15% 30%'), [0.15, 0.3])
  assert.ok(Math.abs(grados(0.15) - 8.53) < 0.01)   // 15 % ≈ 8,5°
  assert.ok(Math.abs(grados(0.3) - 16.7) < 0.01)    // 30 % ≈ 16,7°
})
test('parseSlopeBreaks — 100 % = 45° (tan 45° = 1)', () => {
  assert.equal(parseSlopeBreaks('100%')[0], 1)
  assert.ok(Math.abs(parseSlopeBreaks('45°')[0] - 1) < 1e-15)
  assert.ok(Math.abs(parseSlopeBreaks('45deg')[0] - 1) < 1e-15)
})
test('parseSlopeBreaks — grados y razón, unidades mezcladas, coma o espacio', () => {
  const r = parseSlopeBreaks('17°, 30% 0.8 25deg')
  assert.equal(r.length, 4)
  assert.equal(r[0], Math.tan(17 * Math.PI / 180))
  assert.equal(r[1], 0.3)
  assert.equal(r[2], 0.8)
  assert.equal(r[3], Math.tan(25 * Math.PI / 180))
  assert.deepEqual(parseSlopeBreaks('0.3'), [0.3])
})
test('parseSlopeBreaks — arreglo pasa tal cual', () => {
  const a = [0.1, 0.4]
  assert.equal(parseSlopeBreaks(a), a)
})
test('parseSlopeBreaks — basura da null', () => {
  for (const x of ['', '  ', 'abc', '15% x', '-5%', '90°', '100°', '%', '1e3', null, undefined, 5, [], [0.1, 'a'], [NaN]])
    assert.equal(parseSlopeBreaks(x), null, String(x))
})

test('parseSlopeColors — tokens sin partir rgb()', () => {
  assert.deepEqual(parseSlopeColors('#a6d96a rgb(253, 174, 97) #d7191c'), ['#a6d96a', 'rgb(253, 174, 97)', '#d7191c'])
  assert.deepEqual(parseSlopeColors('red, green'), ['red', 'green'])
})
test('parseSlopeColors — arreglo y basura', () => {
  const a = ['red', 'blue']
  assert.equal(parseSlopeColors(a), a)
  for (const x of ['', '   ', [], [''], [1], null, undefined, 3]) assert.equal(parseSlopeColors(x), null, String(x))
})

test('parseElevationRange — cadena, coma, negativos y par', () => {
  assert.deepEqual(parseElevationRange('200 600'), [200, 600])
  assert.deepEqual(parseElevationRange('-10, 40.5'), [-10, 40.5])
  const p = [0, 100]
  assert.deepEqual(parseElevationRange(p), [0, 100])
})
test('parseElevationRange — basura da null', () => {
  for (const x of ['', '200', '1 2 3', 'a b', [1], [1, 2, 3], [1, 'x'], [1, NaN], null, undefined, 7])
    assert.equal(parseElevationRange(x), null, String(x))
})

test('parseDem — nombre, JSON y objeto', () => {
  assert.equal(parseDem('aws'), 'aws')
  assert.equal(parseDem('  aws '), 'aws')
  assert.deepEqual(parseDem('{"url":"https://x/{z}/{x}/{y}.png","encoding":"terrarium"}'), { url: 'https://x/{z}/{x}/{y}.png', encoding: 'terrarium' })
  const o = { url: 'u' }
  assert.equal(parseDem(o), o)
})
test('parseDem — JSON inválido o ajeno da null sin lanzar', () => {
  for (const x of ['{', '{url:1}', '{"a":1', '[1,2]', '', '  ', null, undefined, 4, ['a']])
    assert.doesNotThrow(() => parseDem(x))
  for (const x of ['{', '{url:1}', '{"a":1', '', null, undefined, 4, ['a']]) assert.equal(parseDem(x), null, String(x))
})

test('hillshadeAttr — tres estados', () => {
  assert.equal(hillshadeAttr(undefined), undefined)
  assert.equal(hillshadeAttr(null), undefined)
  assert.equal(hillshadeAttr('false'), false)
  assert.equal(hillshadeAttr('0'), false)
  assert.equal(hillshadeAttr(false), false)
  assert.equal(hillshadeAttr(''), true)
  assert.equal(hillshadeAttr('true'), true)
  assert.equal(hillshadeAttr(true), true)
})
