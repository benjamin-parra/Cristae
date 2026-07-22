// Move-equivalencia de render/color.js: fija el comportamiento ACTUAL de las tres funciones de color
// (toRGBA, toColorObj, withAlpha) antes y después de mudarlas a su módulo. El MISMO oráculo debe
// pasar contra la ubicación vieja (LineLayer/LabelLayer) y la nueva (color.js).
import test from 'node:test'
import assert from 'node:assert/strict'

// Import al módulo nuevo tras la mudanza. En el paso 1 el oráculo corrió contra la ubicación ACTUAL
// (toRGBA/toColorObj/DEFAULT_COLOR desde LineLayer.js; withAlpha extraído verbatim de LabelLayer.js,
// no importable en node porque LabelLayer acopla leaflet). Los mismos asserts deben seguir verdes acá.
import { toRGBA, toColorObj, DEFAULT_COLOR, withAlpha } from '../../src/render/color.js'

const hasNaN = (arr) => arr.some((n) => Number.isNaN(n))

test('toRGBA: #RGB corto expande cada nibble', () => {
  assert.deepEqual(toRGBA('#f00'), [1, 0, 0, 1])
  assert.deepEqual(toRGBA('#0f0'), [0, 1, 0, 1])
  // El alpha por defecto es 1; el param alpha se usa cuando el hex no trae alpha propio.
  assert.deepEqual(toRGBA('#f00', 0.5), [1, 0, 0, 0.5])
})

test('toRGBA: acepta hex sin # (regex ^#? opcional) y recorta espacios', () => {
  assert.deepEqual(toRGBA('f00'), [1, 0, 0, 1])
  assert.deepEqual(toRGBA('  #f00  '), [1, 0, 0, 1])
})

test('toRGBA: #RRGGBB usa el alpha del parámetro', () => {
  assert.deepEqual(toRGBA('#2563eb'), [0x25 / 255, 0x63 / 255, 0xeb / 255, 1])
  assert.deepEqual(toRGBA('#2563eb', 0.35), [0x25 / 255, 0x63 / 255, 0xeb / 255, 0.35])
})

test('toRGBA: #RRGGBBAA toma su propio alpha e IGNORA el parámetro', () => {
  // #ff000080 → alpha 0x80/255, aunque se pase alpha=0.5.
  assert.deepEqual(toRGBA('#ff000080', 0.5), [1, 0, 0, 0x80 / 255])
})

test('toRGBA: #RGBA corto expande a 8 y saca su propio alpha', () => {
  // #f008 → ff000088 → alpha 0x88/255.
  assert.deepEqual(toRGBA('#f008'), [1, 0, 0, 0x88 / 255])
})

test('toRGBA: array pasa r,g,b tal cual y completa el alpha faltante con el param', () => {
  assert.deepEqual(toRGBA([0.1, 0.2, 0.3]), [0.1, 0.2, 0.3, 1])
  assert.deepEqual(toRGBA([0.1, 0.2, 0.3], 0.7), [0.1, 0.2, 0.3, 0.7])
  assert.deepEqual(toRGBA([0.1, 0.2, 0.3, 0.4]), [0.1, 0.2, 0.3, 0.4])
})

test('toRGBA: color inválido cae a DEFAULT_COLOR y NUNCA produce NaN', () => {
  for (const bad of ['nope', '#12345', '12', null, undefined, 42, {}]) {
    const out = toRGBA(bad)
    assert.deepEqual(out, [0.4, 0.4, 0.4, 1])
    assert.equal(hasNaN(out), false, `NaN en fallback de ${String(bad)}`)
  }
})

test('toRGBA: el fallback devuelve una COPIA fresca de DEFAULT_COLOR (no la constante compartida)', () => {
  // Contrato uniforme: toda rama devuelve un [r,g,b,a] nuevo. El fallback vale por CONTENIDO pero NO es
  // la ref compartida — así un caller que mute el resultado no corrompe el default global (bug corregido).
  assert.deepEqual(toRGBA('nope'), DEFAULT_COLOR)
  assert.notStrictEqual(toRGBA('nope'), DEFAULT_COLOR)
  assert.notStrictEqual(toRGBA('nope'), toRGBA('otro-invalido'))
})

test('toColorObj: envuelve el resultado de toRGBA como {r,g,b,a}', () => {
  assert.deepEqual(toColorObj('#f00', 1), { r: 1, g: 0, b: 0, a: 1 })
  assert.deepEqual(toColorObj([0.1, 0.2, 0.3, 0.4]), { r: 0.1, g: 0.2, b: 0.3, a: 0.4 })
})

test('toColorObj: inválido hereda el DEFAULT_COLOR de toRGBA', () => {
  assert.deepEqual(toColorObj('nope', 0.5), { r: 0.4, g: 0.4, b: 0.4, a: 1 })
})

test('withAlpha: #RRGGBB → string rgba() con canales 0..255', () => {
  assert.equal(withAlpha('#2563eb', 0.35), 'rgba(37, 99, 235, 0.35)')
  assert.equal(withAlpha('#FFFFFF', 1), 'rgba(255, 255, 255, 1)')     // case-insensitive
})

test('withAlpha: acepta los MISMOS formatos hex que toRGBA (#RGB/#RGBA/#RRGGBBAA, con o sin #)', () => {
  // Divergencia con toRGBA resuelta: comparten el mismo HEX. El alpha SIEMPRE es el del parámetro,
  // así que un #RRGGBBAA ignora su alpha propio (withAlpha aplica el que se le pasa).
  assert.equal(withAlpha('#f00', 0.5), 'rgba(255, 0, 0, 0.5)')       // #RGB corto expande
  assert.equal(withAlpha('#ff000080', 0.5), 'rgba(255, 0, 0, 0.5)')  // #RRGGBBAA → usa el alpha del parámetro
  assert.equal(withAlpha('f00', 0.5), 'rgba(255, 0, 0, 0.5)')        // sin # (como toRGBA)
})

test('withAlpha: lo que NO es hex se devuelve sin tocar (nombres CSS, rgb(), null)', () => {
  assert.equal(withAlpha('red', 0.5), 'red')
  assert.equal(withAlpha('rgb(1,2,3)', 0.5), 'rgb(1,2,3)')
  assert.equal(withAlpha(null, 0.5), null)
})
