// Contrato de src/data/filters.js: las dos factories diminutas del núcleo.
//
// La forma de lo que devuelven NO es cosmética: `filter.f` lo lee el Store posicionalmente
// (addFilter / patch / regenerados) y `listener.callback` lo lee safeDispatch. Un rename
// rompe a ambos EN SILENCIO —el filtro simplemente deja de aplicar o el fan-out no llama a
// nadie—, así que acá se congela el nombre exacto, la identidad de la función envuelta y el
// hecho de que los consumidores reales siguen leyendo por esos nombres.
// Corre con: node --test test/filters.test.mjs

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { makeFilter, makeListener, createSource } from '../src/data/index.js'
import { safeDispatch } from '../src/data/safe.js'

const raiz = (rel) => fileURLToPath(new URL(`../${rel}`, import.meta.url))

// ── Forma exacta del objeto devuelto ──

test('makeFilter devuelve exactamente { id, f } y nada más', () => {
  const pred = (x) => x > 1
  const f = makeFilter('mayores', pred)
  assert.deepEqual(Object.keys(f), ['id', 'f'])
  assert.equal(f.id, 'mayores')
  assert.equal(f.f, pred)                                   // la misma función, sin wrapper
  assert.equal(Object.getPrototypeOf(f), Object.prototype)  // objeto plano, no instancia de clase
})

test('makeListener devuelve exactamente { id, callback } y nada más', () => {
  const cb = () => {}
  const l = makeListener('vista', cb)
  assert.deepEqual(Object.keys(l), ['id', 'callback'])
  assert.equal(l.id, 'vista')
  assert.equal(l.callback, cb)
  assert.equal(Object.getPrototypeOf(l), Object.prototype)
})

test('cada llamada devuelve un objeto fresco, sin memoización compartida', () => {
  const pred = () => true
  assert.notEqual(makeFilter('a', pred), makeFilter('a', pred))
  const cb = () => {}
  assert.notEqual(makeListener('a', cb), makeListener('a', cb))
})

test('el id se guarda tal cual: los falsy que no son null/undefined son válidos', () => {
  // La guarda es `id == null`, no `!id`: 0, '' y false son ids legítimos.
  for (const id of [0, '', false, NaN]) {
    assert.equal(makeFilter(id, () => true).id, id)
    assert.equal(makeListener(id, () => {}).id, id)
  }
  const sim = Symbol('capa')
  assert.equal(makeFilter(sim, () => true).id, sim)
})

// ── Entrada inválida: TypeError con el prefijo del factory ──

test('makeFilter lanza TypeError si falta el id o el predicate no es función', () => {
  for (const id of [null, undefined])
    assert.throws(() => makeFilter(id, () => true), TypeError, `id=${String(id)} debió lanzar`)
  for (const p of [undefined, null, 'nope', 42, {}, [], Symbol('x')])
    assert.throws(() => makeFilter('ok', p), TypeError, `predicate=${String(p)} debió lanzar`)
  assert.throws(() => makeFilter(), TypeError)
})

test('makeListener lanza TypeError si falta el id o el callback no es función', () => {
  for (const id of [null, undefined])
    assert.throws(() => makeListener(id, () => {}), TypeError, `id=${String(id)} debió lanzar`)
  for (const cb of [undefined, null, 'nope', 42, {}, []])
    assert.throws(() => makeListener('ok', cb), TypeError, `callback=${String(cb)} debió lanzar`)
  assert.throws(() => makeListener(), TypeError)
})

test('el mensaje de error nombra al factory e interpola el id, incluso si es un Symbol', () => {
  // El mensaje usa String(id): interpolar el symbol directo tiraría otro TypeError y taparía el real.
  assert.throws(() => makeFilter(undefined, () => true), /\[makeFilter\].*id=undefined/)
  assert.throws(() => makeListener(null, () => {}), /\[makeListener\].*id=null/)
  assert.throws(() => makeFilter(Symbol('capa'), 'no-fn'), /id=Symbol\(capa\)/)
  assert.throws(() => makeListener(Symbol('vista'), 'no-fn'), /id=Symbol\(vista\)/)
})

// ── Los nombres se leen posicionalmente desde los consumidores reales ──

const flota = () => {
  const src = createSource({ idOf: (it) => it.id, positionOf: (it) => it })
  src.set([
    { id: 1, lat: 0, lng: 0, activo: true },
    { id: 2, lat: 1, lng: 1, activo: false },
    { id: 3, lat: 2, lng: 2, activo: true },
  ])
  return src
}

test('el Store aplica el filtro leyendo .f y lo da de baja leyendo .id', () => {
  const src = flota()
  src.addFilter(makeFilter('solo-activos', (it) => it.activo))
  assert.deepEqual(src.getSnapshot().map(it => it.id), [1, 3])
  src.removeFilter('solo-activos')
  assert.deepEqual(src.getSnapshot().map(it => it.id), [1, 2, 3])
  src.destroy()
})

test('un objeto con la función en otra propiedad NO funciona como filtro', () => {
  // Evidencia directa de que el nombre `f` es load-bearing: el Store no valida ni adapta.
  const src = flota()
  assert.throws(() => src.addFilter({ id: 'roto', predicate: (it) => it.activo }), TypeError)
  src.destroy()
})

test('safeDispatch invoca al listener leyendo .callback', () => {
  const vistos = []
  const datos = [{ id: 1 }]
  safeDispatch([makeListener('a', (d) => vistos.push(['a', d])), makeListener('b', (d) => vistos.push(['b', d]))],
    datos, () => assert.fail('onError no debía invocarse'))
  assert.deepEqual(vistos.map(v => v[0]), ['a', 'b'])
  assert.equal(vistos[0][1], datos)   // la misma referencia, sin copia
})

test('un objeto con la función en otra propiedad NO funciona como listener', () => {
  let onError = null
  safeDispatch([{ id: 'roto', cb: () => assert.fail('no debía llamarse') }], null, (e) => { onError = e })
  assert.ok(onError instanceof TypeError)
})

// ── types/core.d.ts declara los MISMOS nombres de campo que el runtime ──

const dts = readFileSync(raiz('types/core.d.ts'), 'utf8')

// Miembros declarados en una `export interface` del .d.ts. El nombre va ANCLADO (`\s*[<{]`):
// con `indexOf` casaba por PREFIJO y un rename CristaeListener → CristaeListenerX seguía
// encontrando la interfaz, así que el test no se enteraba de nada.
const miembrosDts = (nombre) => {
  const m = dts.match(new RegExp(String.raw`export interface ${nombre}\s*[<{]`))
  assert.ok(m, `types/core.d.ts no declara ${nombre}`)
  const abre = dts.indexOf('{', m.index)
  let prof = 0, fin = abre
  for (; fin < dts.length; fin++) {
    if (dts[fin] === '{') prof++
    else if (dts[fin] === '}' && --prof === 0) break
  }
  return [...dts.slice(abre + 1, fin).matchAll(/^ *(\w+)\??\s*[(:]/gm)].map(m => m[1]).sort()
}

test('el .d.ts declara los campos { id, f } y { id, callback } con esos nombres', () => {
  // Literales A MANO: el test de abajo cruza el .d.ts contra el runtime, pero deriva el lado
  // esperado del propio módulo bajo prueba → un rename COORDINADO en ambos lados pasaría sin
  // ruido. Esto ancla el lado del tipo por su cuenta (igual que el ['id','f'] literal de arriba
  // ancla el lado del runtime: ninguno de los dos es redundante, no borrarlos).
  assert.deepEqual(miembrosDts('CristaeFilter'), ['f', 'id'])
  assert.deepEqual(miembrosDts('CristaeListener'), ['callback', 'id'])
})

test('CristaeFilter y CristaeListener del .d.ts calzan campo a campo con lo devuelto', () => {
  assert.deepEqual(miembrosDts('CristaeFilter'), Object.keys(makeFilter('x', () => true)).sort())
  assert.deepEqual(miembrosDts('CristaeListener'), Object.keys(makeListener('x', () => {})).sort())
})
