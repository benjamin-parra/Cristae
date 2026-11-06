// Las ayudas de `comun.mjs` se prueban a sí mismas (DISENO-INTEROP §5-3bis): un arnés que no ve la falla
// pasa igual de verde que uno que funciona.

import test from 'node:test'
import assert from 'node:assert/strict'
import { FormatError } from '../../../src/formats/core/error.js'
import { asBytes } from '../../../src/formats/core/input.js'
import { createTables } from '../../../src/formats/core/tables.js'
import { crsFromEpsg } from '../../../src/formats/core/crs.js'
import { compararTablas, formasTexto, fuzz, invariantes, mutante } from '../comun.mjs'

const enc = new TextEncoder()

// Un lector de juguete: cada byte '1'..'9' es un punto. Sirve para ver que el arnés detecta lo que debe.
const juguete = (sobre = b => b) => input => {
  const bytes = sobre(input)
  const t = createTables('juguete')
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] < 49 || bytes[i] > 57) throw new FormatError('juguete', 'sintaxis', i)
    t.feature()
    t.geometry()
    t.part()
    t.ring()
    t.vertex(bytes[i] - 48, 0)
    t.close(1)
  }
  return t.seal({ source: crsFromEpsg(4326) })
}

test('mutante es determinista y cambia la entrada', () => {
  const base = enc.encode('123456789')
  assert.deepEqual(mutante(base, 1, 5), mutante(base, 1, 5))
  assert.ok(Array.from({ length: 20 }, (_, n) => mutante(base, 1, n)).some(m => m.join() !== base.join()))
})

test('fuzz pasa con un lector correcto y cuenta leídos y rechazados', async () => {
  const { leidos, rechazados } = await fuzz(juguete(), [['nueve', enc.encode('123456789')]], { casos: 60, formato: 'juguete' })
  assert.equal(leidos + rechazados, 60)
  assert.ok(leidos > 0 && rechazados > 0)
})

test('fuzz detecta una excepción cruda', async () => {
  const crudo = input => {
    if (input.length < 9) throw new RangeError('fuera de rango')
    return juguete()(input)
  }
  await assert.rejects(fuzz(crudo, [['nueve', enc.encode('123456789')]], { casos: 60 }), /excepción cruda/)
})

test('fuzz detecta al lector que ignora el byteOffset y lee la orla', async () => {
  const sinOffset = juguete(b => new Uint8Array(b.buffer, 0, b.length))
  await assert.rejects(fuzz(sinOffset, [['nueve', enc.encode('123456789')]], { casos: 30 }))
})

test('compararTablas ve −0 contra 0 y NaN contra NaN como manda Object.is', () => {
  const a = { xy: Float64Array.of(-0), z: Float64Array.of(NaN), featureCount: 0 }
  assert.throws(() => compararTablas(a, { ...a, xy: Float64Array.of(0) }, { campos: ['xy'] }))
  compararTablas(a, { ...a }, { campos: ['xy'] })
})

test('invariantes acepta una lectura sana y rechaza una cola corrida', () => {
  const r = juguete()(enc.encode('123'))
  invariantes(r)
  assert.throws(() => invariantes({ ...r, vertexAt: Uint32Array.of(0, 1, 2, 2) }))
})

test('formasTexto entrega string, ArrayBuffer, Uint8Array y Buffer pooled con el mismo contenido', () => {
  const formas = formasTexto('12')
  assert.deepEqual(formas.map(([n]) => n), ['string', 'Uint8Array', 'ArrayBuffer', 'Buffer'])
  formas.forEach(([, f]) => compararTablas(juguete(asBytes)(f), juguete()(enc.encode('12')), { campos: ['xy'] }))
})
