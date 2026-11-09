// El medidor de asignaciones (`test-helpers/asignaciones.mjs`) contra asignaciones conocidas: si un V8 lo
// dejara ciego, los tests de rótulos pasarían sin medir. Va primero en el orden de lectura de los demás.
import test from 'node:test'
import assert from 'node:assert/strict'
import { bytesPorLlamada } from '../test-helpers/asignaciones.mjs'

const sumidero = { v: null }

test('el medidor ve cero en lo que no asigna', () => {
  let acc = 0
  const bytes = bytesPorLlamada(i => { acc += i & 3 }, 20_000, { calentar: 100_000 })
  assert.ok(bytes < 1, `${bytes} bytes por llamada`)
  assert.ok(acc > 0)
})

test('el medidor ve un objeto y un arreglo', () => {
  const objeto = bytesPorLlamada(i => { sumidero.v = { i } }, 20_000, { calentar: 100_000 })
  assert.ok(objeto >= 16, `objeto: ${objeto}`)
  const arreglo = bytesPorLlamada(i => { sumidero.v = [i, i] }, 20_000, { calentar: 100_000 })
  assert.ok(arreglo >= 32, `arreglo: ${arreglo}`)
})

test('el medidor ve una asignación esporádica (un objeto cada 16 llamadas)', () => {
  const bytes = bytesPorLlamada(i => { if ((i & 15) === 0) sumidero.v = { i } }, 20_000, { calentar: 100_000 })
  assert.ok(bytes >= 1.5, `${bytes} bytes por llamada`)
})

test('un arreglo grande obliga a pasar por las tandas más cortas', () => {
  const bytes = bytesPorLlamada(() => { sumidero.v = new Array(1000).fill(0) }, 4_000, { calentar: 1_000 })
  assert.ok(bytes >= 8000, `${bytes} bytes por llamada`)
})
