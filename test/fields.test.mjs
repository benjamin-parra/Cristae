// `fields`: lectores totales, par de posición y precedencia frente a accessors.
// Corre con: node --test test/fields.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { fieldReader, positionReader, accessorsFromFields } from '../src/data/fields.js'
import { createSource } from '../src/data/index.js'

test('un campo simple y uno anidado se leen por ruta', () => {
  assert.equal(fieldReader('a', 'x')({ a: 3 }), 3)
  assert.equal(fieldReader('a.b.c', 'x')({ a: { b: { c: 7 } } }), 7)
})

test('cada canal es total con null, ítem null y campo ausente', () => {
  const esperado = { id: '', variant: '', heading: 0, text: '', height: undefined }
  for (const [canal, neutro] of Object.entries(esperado)) {
    for (const path of ['f', 'a.b']) {
      const read = fieldReader(path, canal)
      assert.equal(read(null), neutro, `${canal} null`)
      assert.equal(read(undefined), neutro)
      assert.equal(read({}), neutro, `${canal} ausente`)
      assert.equal(read({ a: null }), neutro)
      const nulo = read({ f: null, a: { b: null } })
      assert.ok(canal === 'height' ? nulo == null : nulo === neutro)
    }
  }
})

test('coacción por canal', () => {
  assert.equal(fieldReader('f', 'id')({ f: 0 }), 0)
  assert.equal(fieldReader('f', 'variant')({ f: 5 }), '5')
  assert.equal(fieldReader('f', 'text')({ f: false }), 'false')
  assert.equal(fieldReader('f', 'heading')({ f: 90 }), 90)
  assert.equal(fieldReader('f', 'heading')({ f: NaN }), 0)
  assert.equal(fieldReader('f', 'heading')({ f: 'x' }), 0)
  assert.equal(fieldReader('f', 'heading')({ f: '90' }), 90, 'una cadena numérica vale su número')
  assert.equal(fieldReader('f', 'heading')({ f: '' }), 0)
  assert.equal(fieldReader('f', 'heading')({ f: 'Infinity' }), 0)
  assert.equal(fieldReader('f', 'text')({ f: { a: 1 } }), '', 'un objeto no es «[object Object]»')
  assert.equal(fieldReader('f', 'text')({ f: [1, 2] }), '')
  assert.equal(fieldReader('f', 'height')({ f: 12 }), 12)
})

test('el par de posición arma {lat,lng} y es estable entre llamadas', () => {
  const read = positionReader(['lat', 'lng'])
  const it = { lat: -33, lng: -70 }
  const p = read(it)
  assert.deepEqual(p, { lat: -33, lng: -70 })
  assert.equal(read(it), p)
  assert.notEqual(read({ lat: -33, lng: -70 }), p)
  assert.equal(read(null), undefined)
  it.lat = -34
  assert.deepEqual(read(it), { lat: -34, lng: -70 })
})

test('un nombre solo devuelve {lat,lng} tal cual o convierte [lat,lng] con caché', () => {
  const read = positionReader('pos')
  const obj = { lat: 1, lng: 2 }
  assert.equal(read({ pos: obj }), obj)
  const it = { pos: [3, 4] }
  const p = read(it)
  assert.deepEqual(p, { lat: 3, lng: 4 })
  assert.equal(read(it), p)
  assert.equal(read({ pos: 'x' }), undefined)
  assert.equal(read({}), undefined)
  assert.equal(read(null), undefined)
})

test('accessorsFromFields: gana la función y avisa una vez por clave, sin mutar', () => {
  const avisos = []
  const heading = () => 1
  const accessors = { headingOf: heading, extra: 1 }
  const fields = { heading: 'rumbo', variant: 'tipo' }
  const out = accessorsFromFields(fields, accessors, { warn: k => avisos.push(k) })
  assert.equal(out.headingOf, heading)
  assert.equal(out.variantOf({ tipo: 'a' }), 'a')
  assert.deepEqual(avisos, ['heading'])
  assert.deepEqual(Object.keys(accessors), ['headingOf', 'extra'])
  assert.deepEqual(fields, { heading: 'rumbo', variant: 'tipo' })
  assert.notEqual(out, accessors)
})

test('accessorsFromFields: el fallback tiene la precedencia más baja', () => {
  const fb = { idOf: () => 'fb', positionOf: () => 'fbpos' }
  const out = accessorsFromFields({ id: 'codigo' }, { positionOf: () => 'mia' }, { fallback: fb })
  assert.equal(out.idOf({ codigo: 'x' }), 'x')
  assert.equal(out.positionOf(), 'mia')
  assert.equal(accessorsFromFields({}, {}, { fallback: fb }).idOf(), 'fb')
})

test('createSource con fields: set, patch y move', () => {
  const src = createSource({ fields: { id: 'codigo', position: ['lat', 'lng'] } })
  src.set([{ codigo: 'a', lat: 1, lng: 2 }, { codigo: 'b', lat: 3, lng: 4 }])
  const { idOf, positionOf } = src.accessors
  assert.equal(idOf(src.itemById('a')), 'a')
  assert.deepEqual(positionOf(src.itemById('b')), { lat: 3, lng: 4 })
  const nuevo = { codigo: 'a', lat: 5, lng: 6 }
  src.patch([nuevo, { codigo: 'b', lat: 3, lng: 4 }], new Set(['a']))
  assert.deepEqual(positionOf(src.itemById('a')), { lat: 5, lng: 6 })
  src.move('b', 9, 9)
  assert.deepEqual(positionOf(src.itemById('b')), { lat: 9, lng: 9 })
  src.destroy()
})

test('createSource con fields sin id sigue lanzando el TypeError', () => {
  assert.throws(() => createSource({ fields: { variant: 'tipo' } }), TypeError)
})

test('accessorsFromFields: una clave propia en undefined o null no pisa lo que dio fields ni el fallback', () => {
  const positionOf = () => ({ lat: 0, lng: 0 })
  const fallback = { idOf: i => i.k }
  const out = accessorsFromFields({ variant: 'tipo' }, { positionOf, variantOf: undefined, idOf: null }, { fallback })
  assert.equal(out.positionOf, positionOf)
  assert.equal(out.variantOf({ tipo: 'a' }), 'a')
  assert.equal(out.idOf({ k: 7 }), 7)
})
