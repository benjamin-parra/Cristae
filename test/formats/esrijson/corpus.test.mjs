// Corpus de EsriJSON contra el oráculo (DISENO-INTEROP §5-1, §5-2 y §5-5): cada fixture válido da las
// tablas del oráculo y las invariantes CSR en las cuatro formas de entrada; cada adversario, su código.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { readEsriJson } from '../../../src/formats/esrijson.js'
import { oraculo } from './oraculo.mjs'
import { ESPERADO } from './esperado.mjs'
import { compararTablas, fallaCon, formasTexto, invariantes } from '../comun.mjs'

const raiz    = new URL('corpus/', import.meta.url)
const nombres = readdirSync(raiz).flatMap(d => readdirSync(new URL(`${d}/`, raiz)).map(f => `${d}/${f}`))

test('cada fixture tiene su entrada en esperado.mjs, y al revés', () => {
  assert.deepEqual([...nombres].sort(), Object.keys(ESPERADO).sort())
})

nombres.forEach(nombre => {
  const { error, hint, detalle, aviso, cita } = ESPERADO[nombre] ?? {}
  const texto = readFileSync(new URL(nombre, raiz), 'utf8')

  test(`${nombre} — ${cita}`, async () => {
    if (error) {
      const e = await fallaCon(() => readEsriJson(texto), error, 'esrijson')
      hint === undefined || assert.equal(e.hint, hint)
      detalle === undefined || assert.ok(e.message.endsWith(`: ${detalle}`), e.message)
      return
    }
    const esperado = oraculo(texto)
    formasTexto(texto).forEach(([forma, entrada]) => {
      const leido = readEsriJson(entrada)
      invariantes(leido)
      compararTablas(leido, esperado)
      assert.deepEqual(leido.layers, [{ name: null, parent: -1 }], forma)
      assert.equal(leido.format, 'esrijson')
      assert.ok(leido.crs === null || leido.crs === 'EPSG:4326', leido.crs)
      assert.deepEqual(leido.warnings.map(w => w.code), aviso ? [aviso] : [], forma)
    })
  })
})
