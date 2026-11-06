// Lector de números del núcleo (DISENO-INTEROP §2.2 y §5-4): gramáticas JSON y decimal, y paridad bit a
// bit con `Number(texto)`, incluida la frontera de 31 a 34 dígitos de SPECS §17.5.

import test from 'node:test'
import assert from 'node:assert/strict'
import { scanNumber, joinLimbs, JSON_GRAMMAR, DECIMAL_GRAMMAR } from '../../../src/formats/core/number.js'

const enc = new TextEncoder()
const out = new Float64Array(2)

const scan = (texto, grammar, from = 0, to = texto.length) => {
  const next = scanNumber(enc.encode(texto), from, to, grammar, out)
  return { next, value: out[0], slow: out[1] }
}

// Igual que Number(texto) con la semántica de Object.is: −0 cuenta.
const paridad = (texto, grammar) => {
  const { next, value } = scan(texto, grammar)
  assert.equal(next, texto.length, `${texto}: no consumió el token`)
  assert.ok(Object.is(value, Number(texto)), `${texto}: ${value} contra ${Number(texto)}`)
}

test('JSON: RFC 8259 §6 acepta y rechaza lo que manda', () => {
  ;['0', '-0', '1', '-1.5', '0.25', '1e3', '1E-3', '-12.5e+2', '123456789'].forEach(t => paridad(t, JSON_GRAMMAR))
  ;['+1', '.5', '5.', '01', '-', '1e', '1e+', 'NaN', 'Infinity', '', '-.5'].forEach(t =>
    assert.equal(scan(t, JSON_GRAMMAR).next, -1, t))
})

test('decimal: xsd:double y WKT admiten signo +, .5 y 5.', () => {
  ;['+1', '.5', '5.', '-.5', '+.5e3', '007', '0', '-0', '1.', '3.25E2'].forEach(t => paridad(t, DECIMAL_GRAMMAR))
  ;['.', '+', '-', '+.', 'e5', '1e', 'abc'].forEach(t => assert.equal(scan(t, DECIMAL_GRAMMAR).next, -1, t))
})

test('los no finitos son −2 en las dos gramáticas, también NaN e INF de la decimal', () => {
  ;['1e999', '-1e400'].forEach(t => {
    assert.equal(scan(t, JSON_GRAMMAR).next, -2, t)
    assert.equal(scan(t, DECIMAL_GRAMMAR).next, -2, t)
  })
  ;['NaN', 'nan', 'INF', '-INF', '+inf', 'Infinity', '-Infinity'].forEach(t => assert.equal(scan(t, DECIMAL_GRAMMAR).next, -2, t))
  // Un identificador que sólo empieza como INF no es un no finito: no es número.
  assert.equal(scan('INFO', DECIMAL_GRAMMAR).next, -1)
})

test('se detiene en el primer byte que no es del número y no pasa de `end`', () => {
  assert.equal(scan('12.5,3', DECIMAL_GRAMMAR).next, 4)
  assert.equal(scan('12.5 3', JSON_GRAMMAR).next, 4)
  assert.equal(scan('x-7.25]', JSON_GRAMMAR, 1).next, 6)
  const { next, value } = scan('123456', DECIMAL_GRAMMAR, 0, 3)
  assert.equal(next, 3)
  assert.equal(value, 123)
  // `1e` cortado por `end` no es número: el exponente no tiene dígitos dentro del rango.
  assert.equal(scan('1e5', JSON_GRAMMAR, 0, 2).next, -1)
})

test('out[1] marca el respaldo: corto exacto 0, limbos o Number 1', () => {
  assert.equal(scan('-70.123456', JSON_GRAMMAR).slow, 0)
  assert.equal(scan('0.12345678901234567', JSON_GRAMMAR).slow, 1)
  assert.equal(scan('1e5', JSON_GRAMMAR).slow, 1)
})

// Generador determinista de mantisas de n dígitos con el punto en cualquier lugar.
const azar = semilla => () => (semilla = (Math.imul(semilla, 1103515245) + 12345) >>> 0) / 2 ** 32

test('paridad bit a bit con Number(texto) en 1..40 dígitos significativos', () => {
  const r = azar(7)
  for (let digitos = 1; digitos <= 40; digitos++)
    for (let k = 0; k < 150; k++) {
      let mantisa = String(1 + Math.floor(r() * 9))
      while (mantisa.length < digitos) mantisa += Math.floor(r() * 10)
      const punto = Math.floor(r() * (digitos + 1))
      const texto = (r() < 0.5 ? '-' : '') + (punto === 0 ? '0.' + mantisa : mantisa.slice(0, punto) + (punto < digitos ? '.' + mantisa.slice(punto) : ''))
      paridad(texto, JSON_GRAMMAR)
      paridad(texto, DECIMAL_GRAMMAR)
    }
})

test('paridad en la frontera de 31 a 34 dígitos (SPECS §17.5) y en los casos difíciles de redondeo', () => {
  ;[
    '0.1234567890123456789012345678901', '0.12345678901234567890123456789012',
    '0.123456789012345678901234567890123', '0.1234567890123456789012345678901234',
    '-33.4488897000000000000000000000001', '9007199254740993', '9007199254740993.0000000000000001',
    '2.2250738585072011e-308', '0.000000000000000000000000000001', '179769313486231570000000000000000000000',
    '-70.64827000000000000000000000000049999', '1.00000000000000011102230246251565404236316680908203125',
  ].forEach(t => {
    paridad(t, JSON_GRAMMAR)
    paridad(t, DECIMAL_GRAMMAR)
  })
})

test('joinLimbs es el de geojson.js: mismo valor que Number para a·10^nb + b sobre 10^dec', () => {
  // 12345678901234 · 10^5 + 67890 = 1234567890123467890, sobre 10^10.
  assert.ok(Object.is(joinLimbs(12345678901234, 67890, 5, 10, false), Number('123456789.0123467890')))
  assert.ok(Object.is(joinLimbs(12345678901234, 67890, 5, 10, true), Number('-123456789.0123467890')))
})
