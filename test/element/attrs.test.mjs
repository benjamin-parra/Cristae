// Coerción de atributos de custom-element (src/element/attrs.js): parsePair, parseTokens,
// fitFromAttribute, boolDefaultOn, boolOff, finitePos. Funciones puras → sin DOM ni Leaflet.
// El gotcha que cubren: con asignación por PROPIEDAD el converter de Lit NO corre, así que cada
// helper debe aceptar la forma CRUDA (string del atributo) Y la ya parseada (array/valor). Cada
// caso testea ambas ramas. Corre con: node --test test/element/attrs.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parsePair, parseTokens, fitFromAttribute, boolDefaultOn, boolOff, finitePos,
} from '../../src/element/attrs.js'

// ── parsePair: par numérico desde string ("[8,12]" / "8,12") o array ya parseado ──
test('parsePair — array crudo pasa tal cual (forma por propiedad)', () => {
  const arr = [8, 12]
  assert.equal(parsePair(arr), arr)            // misma referencia, sin re-parsear
})
test('parsePair — string "[8,12]" (forma cruda de atributo)', () => {
  assert.deepEqual(parsePair('[8,12]'), [8, 12])
})
test('parsePair — string "8,12" sin corchetes', () => {
  assert.deepEqual(parsePair('8,12'), [8, 12])
})
test('parsePair — negativos y decimales', () => {
  assert.deepEqual(parsePair('-3.5, 4'), [-3.5, 4])
})
test('parsePair — 3+ números toma los dos primeros', () => {
  assert.deepEqual(parsePair('8,12,15'), [8, 12])
})
test('parsePair — un solo número → null', () => {
  assert.equal(parsePair('8'), null)
})
test('parsePair — string vacío / null / undefined → null', () => {
  assert.equal(parsePair(''), null)
  assert.equal(parsePair(null), null)
  assert.equal(parsePair(undefined), null)
})

// ── parseTokens: lista de tokens desde string ("flip shift clip") o array ya parseado ──
test('parseTokens — array crudo pasa tal cual (forma por propiedad)', () => {
  const arr = ['flip', 'shift']
  assert.equal(parseTokens(arr), arr)
})
test('parseTokens — string "flip shift clip" (forma cruda de atributo)', () => {
  assert.deepEqual(parseTokens('flip shift clip'), ['flip', 'shift', 'clip'])
})
test('parseTokens — colapsa espacios y recorta', () => {
  assert.deepEqual(parseTokens('  flip   shift '), ['flip', 'shift'])
})
test('parseTokens — un token', () => {
  assert.deepEqual(parseTokens('flip'), ['flip'])
})
test('parseTokens — vacío / null / undefined → [] (nil-safe)', () => {
  assert.deepEqual(parseTokens(''), [])
  assert.deepEqual(parseTokens('   '), [])
  assert.deepEqual(parseTokens(null), [])
  assert.deepEqual(parseTokens(undefined), [])
})

// ── fitFromAttribute: converter de `fit` — removido/vacío ⇒ null (camino legacy) ──
test('fitFromAttribute — string con tokens → array', () => {
  assert.deepEqual(fitFromAttribute('flip shift'), ['flip', 'shift'])
})
test('fitFromAttribute — un token', () => {
  assert.deepEqual(fitFromAttribute('flip'), ['flip'])
})
test('fitFromAttribute — array ya parseado (forma por propiedad)', () => {
  const arr = ['clip']
  assert.equal(fitFromAttribute(arr), arr)     // parseTokens devuelve el array tal cual
})
test('fitFromAttribute — null / undefined (atributo removido) → null', () => {
  assert.equal(fitFromAttribute(null), null)
  assert.equal(fitFromAttribute(undefined), null)
})
test('fitFromAttribute — vacío / solo espacios / array vacío → null', () => {
  assert.equal(fitFromAttribute(''), null)
  assert.equal(fitFromAttribute('   '), null)
  assert.equal(fitFromAttribute([]), null)
})

// ── boolDefaultOn: converter booleano "presente = ON, default ON" (fromAttribute) ──
test('boolDefaultOn — "false"/"0" → OFF', () => {
  assert.equal(boolDefaultOn.fromAttribute('false'), false)
  assert.equal(boolDefaultOn.fromAttribute('0'), false)
})
test('boolDefaultOn — ausente (null) o vacío → ON', () => {
  assert.equal(boolDefaultOn.fromAttribute(null), true)   // Lit pasa null si el atributo está ausente
  assert.equal(boolDefaultOn.fromAttribute(''), true)
})
test('boolDefaultOn — cualquier otro string → ON', () => {
  assert.equal(boolDefaultOn.fromAttribute('true'), true)
  assert.equal(boolDefaultOn.fromAttribute('yes'), true)
})

// ── boolOff: lectura del booleano "default ON" en el punto de uso (property-safe) ──
test('boolOff — ausente (undefined/null) → false (queda ON)', () => {
  assert.equal(boolOff(undefined), false)
  assert.equal(boolOff(null), false)
})
test('boolOff — falsy explícito (false, 0, "") → true (OFF)', () => {
  assert.equal(boolOff(false), true)
  assert.equal(boolOff(0), true)
  assert.equal(boolOff(''), true)
})
test('boolOff — strings "false"/"0" del converter → true (OFF)', () => {
  assert.equal(boolOff('false'), true)
  assert.equal(boolOff('0'), true)
})
test('boolOff — truthy (true, 1, otro string) → false (ON)', () => {
  assert.equal(boolOff(true), false)
  assert.equal(boolOff(1), false)
  assert.equal(boolOff('anything'), false)
})

// ── finitePos: guard de posición → { lat, lng } numéricos, o null ──
test('finitePos — objeto numérico → misma posición', () => {
  assert.deepEqual(finitePos({ lat: 1, lng: 2 }), { lat: 1, lng: 2 })
})
test('finitePos — strings numéricos (forma serializada por backend) → coacciona', () => {
  assert.deepEqual(finitePos({ lat: '1.5', lng: '2.5' }), { lat: 1.5, lng: 2.5 })
})
test('finitePos — cero es válido', () => {
  assert.deepEqual(finitePos({ lat: 0, lng: 0 }), { lat: 0, lng: 0 })
})
test('finitePos — no finito (NaN, Infinity) → null', () => {
  assert.equal(finitePos({ lat: 'abc', lng: 2 }), null)
  assert.equal(finitePos({ lat: Infinity, lng: 2 }), null)
  assert.equal(finitePos({}), null)
})
test('finitePos — null / undefined → null', () => {
  assert.equal(finitePos(null), null)
  assert.equal(finitePos(undefined), null)
})
