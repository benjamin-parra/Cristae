// Contrato de src/data/safe.js: los dos únicos try/catch del hot-path.
//
// De este aislamiento depende TODO el fan-out de Store.notifyChanges: si un listener que
// lanza cortara el recorrido, los consumidores registrados después de él quedarían mudos
// sin ningún síntoma. Se congela el aislamiento, la firma de onError (error, arg) y las
// consecuencias observables del recorrido por índice.
// Corre con: node --test test/safe.test.mjs

import test from 'node:test'
import assert from 'node:assert/strict'

import { safe, safeDispatch } from '../src/data/safe.js'
import { Store } from '../src/data/Store.js'

// Listener mínimo con la forma que lee safeDispatch.
const oyente = (id, fn) => ({ id, callback: fn })
// Recolector de llamadas a onError: guarda los argumentos COMPLETOS (para verificar la aridad).
const colector = () => { const args = []; const fn = (...a) => args.push(a); fn.args = args; return fn }

// ── safe: aísla una llamada ──

test('safe devuelve el valor de la función y no toca onError cuando no hay error', () => {
  const onError = colector()
  assert.equal(safe((x) => x * 2, 21, onError), 42)
  assert.equal(onError.args.length, 0)
})

test('safe pasa el arg tal cual, una sola vez', () => {
  const arg = { id: 1 }
  const vistos = []
  safe((a) => vistos.push(a), arg, () => assert.fail('no debía haber error'))
  assert.equal(vistos.length, 1)
  assert.equal(vistos[0], arg)
})

test('safe devuelve undefined y reporta (error, arg) cuando la función lanza', () => {
  const onError = colector()
  const arg = { id: 7 }
  const boom = new Error('boom')
  assert.equal(safe(() => { throw boom }, arg, onError), undefined)
  assert.equal(onError.args.length, 1)
  assert.deepEqual(onError.args[0].length, 2)   // exactamente (error, arg): ni más ni menos
  assert.equal(onError.args[0][0], boom)
  assert.equal(onError.args[0][1], arg)
})

test('safe reporta el valor lanzado tal cual aunque no sea un Error', () => {
  // El catch no normaliza: un `throw 'texto'` o `throw undefined` llega crudo a onError.
  for (const lanzado of ['texto', undefined, null, 0, { code: 'X' }]) {
    const onError = colector()
    safe(() => { throw lanzado }, null, onError)
    assert.equal(onError.args.length, 1)
    assert.equal(onError.args[0][0], lanzado)
  }
})

// ── safeDispatch: fan-out aislado ──

test('un listener que lanza no detiene a los demás', () => {
  const llamados = []
  const onError = colector()
  const err2 = new Error('dos'), err4 = new Error('cuatro')
  safeDispatch([
    oyente('a', () => llamados.push('a')),
    oyente('b', () => { llamados.push('b'); throw err2 }),
    oyente('c', () => llamados.push('c')),
    oyente('d', () => { llamados.push('d'); throw err4 }),
    oyente('e', () => llamados.push('e')),
  ], null, onError)
  assert.deepEqual(llamados, ['a', 'b', 'c', 'd', 'e'])
  assert.deepEqual(onError.args.map(a => a[0]), [err2, err4])
})

test('el fan-out respeta el orden del array y entrega el MISMO dato a todos', () => {
  const datos = [{ id: 1 }, { id: 2 }]
  const recibidos = []
  safeDispatch(
    ['a', 'b', 'c'].map(id => oyente(id, (d) => recibidos.push([id, d]))),
    datos,
    () => assert.fail('sin errores esperados'),
  )
  assert.deepEqual(recibidos.map(r => r[0]), ['a', 'b', 'c'])
  for (const [, d] of recibidos) assert.equal(d, datos)   // sin copia por listener
})

test('onError recibe el mismo dato del emit como segundo argumento', () => {
  const datos = [{ id: 9 }]
  const onError = colector()
  safeDispatch([oyente('a', () => { throw new Error('x') })], datos, onError)
  assert.equal(onError.args[0][1], datos)
})

test('una lista vacía no lanza ni reporta nada', () => {
  const onError = colector()
  safeDispatch([], { any: true }, onError)
  assert.equal(onError.args.length, 0)
})

test('todos los listeners que lanzan se reportan, uno por cada throw', () => {
  const onError = colector()
  safeDispatch(Array.from({ length: 5 }, (_, i) => oyente(i, () => { throw new Error(`e${i}`) })), null, onError)
  assert.deepEqual(onError.args.map(a => a[0].message), ['e0', 'e1', 'e2', 'e3', 'e4'])
})

// ── Consecuencias del recorrido por índice (length releída en cada vuelta) ──

test('un listener agregado al mismo array durante el fan-out recibe ese emit', () => {
  const llamados = []
  const lista = [oyente('a', () => {
    llamados.push('a')
    lista.push(oyente('tardio', () => llamados.push('tardio')))
  })]
  safeDispatch(lista, null, () => assert.fail('sin errores esperados'))
  assert.deepEqual(llamados, ['a', 'tardio'])
})

test('quitar del mismo array durante el fan-out saltea al siguiente listener', () => {
  // Store.removeListener REASIGNA el array (filter) en vez de mutarlo, así que el fan-out en
  // curso trabaja sobre la copia vieja y no sufre este corrimiento de índice.
  const llamados = []
  const lista = [
    oyente('a', () => { llamados.push('a'); lista.splice(0, 1) }),
    oyente('b', () => llamados.push('b')),
    oyente('c', () => llamados.push('c')),
  ]
  safeDispatch(lista, null, () => assert.fail('sin errores esperados'))
  assert.deepEqual(llamados, ['a', 'c'])
})

test('un onError que lanza propaga y aborta el fan-out', () => {
  // No hay red debajo de la red: onError debe ser una ref estable de módulo que no falle.
  const llamados = []
  const lista = [
    oyente('a', () => { llamados.push('a'); throw new Error('primero') }),
    oyente('b', () => llamados.push('b')),
  ]
  assert.throws(() => safeDispatch(lista, null, () => { throw new Error('onError roto') }), /onError roto/)
  assert.deepEqual(llamados, ['a'])
})

// ── Cableado real: Store.notifyChanges hereda el aislamiento y emite el FILTRADO ──

// Store CON un filtro activo. Sin filtros, el dato base y el filtrado son el mismo array y
// ningún aserto sobre el contenido del emit puede distinguirlos: el fixture tapaba el emit
// del dato SIN filtrar. El Store lee `.f` / `.id` posicionalmente (ver filters.test.mjs).
const FLOTA = [{ id: 1, activo: true }, { id: 2, activo: false }, { id: 3, activo: true }]
const storeFiltrado = () => new Store([]).addFilter({ id: 'activos', f: (it) => it.activo })

test('Store.notifyChanges aísla al listener que lanza y sigue con el resto', () => {
  const errores = []
  const original = console.error
  console.error = (...a) => errores.push(a)
  try {
    const recibidos = []
    const store = storeFiltrado()
    store.addListener(oyente('roto', () => { throw new Error('listener roto') }))
    store.addListener(oyente('vivo', (d) => recibidos.push(d)))
    store.update(FLOTA)
    assert.equal(recibidos.length, 1)
    assert.equal(errores.length, 1)                       // el error se reporta, no se traga
    store.destroy()
  } finally {
    console.error = original
  }
})

test('el emit lleva el snapshot FILTRADO, no el dato base', () => {
  const recibidos = []
  const store = storeFiltrado()
  store.addListener(oyente('vista', (d) => recibidos.push(d)))
  store.update(FLOTA)
  assert.deepEqual(recibidos[0].map(it => it.id), [1, 3])   // el id 2 no pasa el filtro
  assert.equal(recibidos[0], store.filtered)                // la ref viva del Store, sin copia
  store.destroy()
})

test('dos emits sin cambio de dato entregan la MISMA referencia de array', () => {
  // Refs estables entre flushes: el consumidor compara por identidad para saltear trabajo.
  // Una copia por emit (`filtered.slice()`) es indistinguible por contenido y rompe eso.
  const recibidos = []
  const store = storeFiltrado()
  store.update(FLOTA)
  store.addListener(oyente('vista', (d) => recibidos.push(d)))
  store.notifyChanges()
  store.notifyChanges()
  assert.equal(recibidos.length, 2)
  assert.equal(recibidos[0], recibidos[1])
  assert.equal(recibidos[0], store.filtered)
  store.destroy()
})
