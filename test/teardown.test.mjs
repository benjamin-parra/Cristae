// Contrato de toUnsub: normaliza el teardown que devuelve un subscribe a una función de baja.
// Cubre las 4 formas de entrada (función | {unsubscribe} | {dispose} | void/null) y que el
// resultado SIEMPRE es invocable sin romper. Es el oráculo de move-equivalencia del eje 5:
// primero apuntó a Source.js (ubicación original), después a teardown.js (destino de la mudanza).
// Corre con: node --test test/teardown.test.mjs

import test from 'node:test'
import assert from 'node:assert/strict'

import { toUnsub } from '../src/data/teardown.js'

// ── Forma 1: función → se devuelve tal cual ──

test('una función se devuelve tal cual (misma referencia), sin envolver', () => {
  const fn = () => {}
  assert.equal(toUnsub(fn), fn)
})

test('la función devuelta es la baja: invocarla ejecuta el teardown una vez', () => {
  let bajas = 0
  const unsub = toUnsub(() => { bajas++ })
  assert.equal(bajas, 0)               // no se invoca al normalizar
  unsub()
  assert.equal(bajas, 1)
})

// ── Forma 2: objeto con unsubscribe() (RxJS) → wrapper que lo llama ──

test('objeto {unsubscribe} → devuelve un wrapper (no el método) que al llamarlo desuscribe', () => {
  let llamado = 0
  const sub = { unsubscribe() { llamado++ } }
  const unsub = toUnsub(sub)
  assert.equal(typeof unsub, 'function')
  assert.notEqual(unsub, sub.unsubscribe)   // no expone el método directo
  assert.equal(llamado, 0)
  unsub()
  assert.equal(llamado, 1)
})

test('el wrapper de {unsubscribe} conserva el this del objeto', () => {
  const sub = { marca: 'ok', visto: null, unsubscribe() { this.visto = this.marca } }
  toUnsub(sub)()
  assert.equal(sub.visto, 'ok')
})

// ── Forma 3: objeto con dispose() (Solid root) → wrapper que lo llama ──

test('objeto {dispose} → devuelve un wrapper que al llamarlo hace dispose', () => {
  let llamado = 0
  const root = { dispose() { llamado++ } }
  const unsub = toUnsub(root)
  assert.equal(typeof unsub, 'function')
  assert.notEqual(unsub, root.dispose)
  unsub()
  assert.equal(llamado, 1)
})

test('el wrapper de {dispose} conserva el this del objeto', () => {
  const root = { marca: 'z', visto: null, dispose() { this.visto = this.marca } }
  toUnsub(root)()
  assert.equal(root.visto, 'z')
})

// ── Forma 4: void / null / valores sin teardown → no-op invocable ──

test('void, null y undefined → devuelve una función invocable que no rompe', () => {
  for (const nada of [undefined, null]) {
    const unsub = toUnsub(nada)
    assert.equal(typeof unsub, 'function')
    assert.doesNotThrow(() => unsub())   // baja segura, sin efecto
  }
})

test('un objeto sin unsubscribe ni dispose cae al no-op', () => {
  for (const raro of [{}, { otro: 1 }, { unsubscribe: 42 }, { dispose: 'x' }, 0, '', false]) {
    const unsub = toUnsub(raro)
    assert.equal(typeof unsub, 'function')
    assert.doesNotThrow(() => unsub())
  }
})

// ── Precedencia: unsubscribe gana a dispose (orden de las ramas) ──

test('si el objeto trae unsubscribe Y dispose, se usa unsubscribe (dispose no se toca)', () => {
  const orden = []
  const sub = {
    unsubscribe() { orden.push('unsubscribe') },
    dispose() { orden.push('dispose') },
  }
  toUnsub(sub)()
  assert.deepEqual(orden, ['unsubscribe'])
})

// ── Invariante transversal: el resultado SIEMPRE es una función ──

test('sea cual sea la entrada, el resultado es siempre una función', () => {
  const entradas = [() => {}, { unsubscribe() {} }, { dispose() {} }, null, undefined, {}, 7, 'x']
  for (const e of entradas) assert.equal(typeof toUnsub(e), 'function')
})
