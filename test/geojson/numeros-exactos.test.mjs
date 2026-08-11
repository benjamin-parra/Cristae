// Paridad bit a bit con `JSON.parse` en los números que NO entran en la mantisa de 2^53.
// El corpus no llegaba acá: ninguno de sus literales pasa de 31 dígitos significativos, así que el
// respaldo exacto no tenía cobertura. Las formas que importan son dos, y la segunda es la filosa:
// muchos dígitos con POCOS decimales —un decimal largo se delega por `dec > 22` y nunca lo ejercita—
// y el punto medio EXACTO entre dos doubles vecinos, que es donde se ve un desempate mal hecho.
import test from 'node:test'
import assert from 'node:assert/strict'
import { leer } from './lector.mjs'

const enc = new TextEncoder()

const comoPunto = literal => leer(enc.encode(`{"type":"Point","coordinates":[${literal},0]}`))

const bits = v => {
  const dv = new DataView(new ArrayBuffer(8))
  dv.setFloat64(0, v)
  return dv.getBigUint64(0)
}

const comparar = literal => {
  const dado     = comoPunto(literal).xy[0]
  const esperado = JSON.parse(`[${literal}]`)[0]
  assert.ok(Object.is(dado, esperado),
    `${literal}\n  esperado ${esperado} (${bits(esperado).toString(16)})\n  dado     ${dado} (${bits(dado).toString(16)})`)
}

// El punto medio entre dos doubles vecinos es binario, así que su decimal es finito: con BigInt sale
// exacto. Con magnitud grande queda ENTERO, que es la forma que llega al respaldo.
const puntoMedio = v => {
  const dv = new DataView(new ArrayBuffer(8))
  dv.setFloat64(0, Math.abs(v))
  const b    = dv.getBigUint64(0)
  const E    = Number((b >> 52n) & 0x7ffn)
  if (E === 0 || E === 0x7ff) return null
  const num = 2n * ((1n << 52n) | (b & 0xfffffffffffffn)) + 1n
  const k   = BigInt(E - 1075) - 1n
  return k >= 0n ? (v < 0 ? '-' : '') + (num << k).toString() : null
}

// Semillas fijas: la lista es reproducible y no depende de un PRNG.
const SEMILLAS = []
for (let e = 20; e <= 80; e += 4) SEMILLAS.push(10 ** e, 3 * 10 ** e, 7.5 * 10 ** e, -1.25 * 10 ** e)

const EMPATES = SEMILLAS.map(puntoMedio).filter(s => s && /^-?\d+$/.test(s))

// Muchos dígitos con pocos decimales, que es lo que el corpus no tenía.
const LARGOS = [
  '21269312932568905739976452748506824703',
  '12345678901234567890123456789012.5',
  '-98765432109876543210987654321098765.25',
  '1.2345678901234567890123456789012345',
  '-7.9999999999999999999999999999999999',
  '123456789012345678901234567890123456789012345678901234567890.125',
  '9007199254740993',
  '-9007199254740993',
  '18014398509481985',
]

test('los empates exactos entre doubles vecinos se redondean como JSON.parse', () => {
  assert.ok(EMPATES.length >= 12, `las semillas tienen que dar empates enteros, dieron ${EMPATES.length}`)
  EMPATES.forEach(comparar)
})

test('los literales de más de 31 dígitos significativos coinciden bit a bit', () => {
  LARGOS.forEach(comparar)
})

test('y todos ellos se contabilizan como números fuera del camino rápido', () => {
  const fuera = [...EMPATES, ...LARGOS].filter(l => comoPunto(l).stats.slowNumbers > 0)
  assert.equal(fuera.length, EMPATES.length + LARGOS.length, 'ninguno debería entrar por el camino rápido')
})

test('el camino rápido sigue cubriendo lo que emite JSON.stringify', () => {
  const emitidos = Array.from({ length: 400 }, (_, i) => String((i * 0.37 - 180) + i / 7919))
  emitidos.forEach(comparar)
})
