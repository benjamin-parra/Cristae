// La Source pendiente del elemento la adopta la capa de puntos: lo movido antes del alta cae sobre el dato inicial
// (después del set con `data`, después de la carga —o del primer fallo— con `url`), y el motor nunca la destruye: ni removeLayer ni
// attachSource, porque sobrevive al remontaje. Corre con: node --test test/engine/source-adoptada.test.mjs
import '../../test-helpers/engine-stub.mjs'
import { makeIconSet } from '../../test-helpers/engine-stub.mjs'
import { conNavegador, crearNavegador } from '../../test-helpers/navegador-falso.mjs'
import { coleccion, fetchFalso, hasta, motor, punto, retenida } from '../../test-helpers/datos-remotos.mjs'
import { after, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { readGeoJson } from '../../src/geojson/geojson.js'
import { itemsOf } from '../../src/engine/features.js'
import { createPendingSource, createSource } from '../../src/data/Source.js'

after(conNavegador(crearNavegador()))

const set = makeIconSet()
const accessors = { idOf: i => i.id, positionOf: i => ({ lat: i.lat, lng: i.lng }) }
const pos = (source, id) => { const p = source.accessors.positionOf(source.itemById(id)); return [p.lat, p.lng] }

test('con data: el move anterior al alta se aplica después del set', () => {
  const engine = motor()
  const pend = createPendingSource()
  pend.move('a', 9, 8)
  const h = engine.addPointLayer({ id: 'flota', accessors, source: pend, data: [{ id: 'a', lat: 1, lng: 2 }], iconSet: set })
  assert.equal(h.source, pend)
  assert.deepEqual(pos(pend, 'a'), [9, 8])
  engine.destroy()
})

test('con url: lo movido antes de ready cae sobre los ítems cargados, y no antes', async () => {
  const engine = motor()
  const pend = createPendingSource()
  const { soltar, rutaDe } = retenida()
  const fetch = fetchFalso({ 'f.geojson': rutaDe() })
  pend.move(0, 7, 6)
  const h = engine.addPointLayer({ id: 'flota', url: 'f.geojson', fetch, source: pend, iconSet: set })
  assert.equal(h.source, pend)
  assert.equal(pend.getSnapshot().length, 0)
  soltar(coleccion([punto(-70, -33), punto(-71, -34)]))
  await hasta(() => pend.getSnapshot().length === 2)
  assert.deepEqual(pos(pend, 0), [7, 6])
  assert.deepEqual(pos(pend, 1), [-34, -71])
  engine.destroy()
})

test('con url que falla también se suelta lo retenido, una vez', async () => {
  const engine = motor()
  const pend = createPendingSource()
  const errores = []
  engine.on('dataerror', d => errores.push(d))
  const esperada = mock.method(console, 'error', () => {})
  try {
    pend.set(itemsOf(readGeoJson(coleccion([punto(2, 1)])), 'point').items)
    engine.addPointLayer({ id: 'flota', url: 'falta.geojson', fetch: fetchFalso({}), source: pend, iconSet: set })
    assert.equal(pend.getSnapshot().length, 0, 'retenido mientras carga')
    await hasta(() => errores.length || esperada.mock.callCount())
    assert.equal(pend.getSnapshot().length, 1, 'el fallo suelta lo retenido')
  } finally { esperada.mock.restore() }
  engine.destroy()
})

test('url más source ajena sigue siendo TypeError; con la pendiente no', () => {
  const engine = motor()
  assert.throws(() => engine.addPointLayer({ id: 'a', url: 'f.geojson', source: createSource(accessors), iconSet: set }), /con url la Source es del motor/)
  assert.equal(engine.getLayer('a'), null)
  const pend = createPendingSource()
  assert.doesNotThrow(() => engine.addPointLayer({ id: 'b', url: 'f.geojson', fetch: fetchFalso({}), source: pend, iconSet: set }))
  engine.destroy()
})

test('removeLayer no destruye la Source adoptada, y un alta nueva con la misma la reusa', () => {
  const engine = motor()
  const pend = createPendingSource()
  engine.addPointLayer({ id: 'flota', accessors, source: pend, data: [{ id: 'a', lat: 1, lng: 2 }], iconSet: set })
  const destruir = mock.method(pend, 'destroy')
  assert.equal(engine.removeLayer('flota'), true)
  assert.equal(destruir.mock.callCount(), 0)
  assert.equal(pend.getSnapshot().length, 1, 'conserva sus ítems')
  const h = engine.addPointLayer({ id: 'flota', accessors, source: pend, iconSet: set })
  assert.equal(h.source, pend)
  assert.deepEqual(pos(pend, 'a'), [1, 2])
  engine.destroy()
  assert.equal(destruir.mock.callCount(), 0, 'ni destroy del motor')
})

test('attachSource no destruye la Source adoptada', () => {
  const engine = motor()
  const pend = createPendingSource()
  engine.addPointLayer({ id: 'flota', accessors, source: pend, data: [{ id: 'a', lat: 1, lng: 2 }], iconSet: set })
  const destruir = mock.method(pend, 'destroy')
  const otra = createSource(accessors)
  engine.attachSource('flota', otra)
  assert.equal(destruir.mock.callCount(), 0)
  engine.destroy()
  assert.equal(destruir.mock.callCount(), 0)
})

test('el handle de punto pasa el rumbo de move a la Source, sin tocar el rebuild', () => {
  const engine = motor()
  const h = engine.addPointLayer({ id: 'flota', accessors, data: [{ id: 'a', lat: 1, lng: 2 }], iconSet: { ...set, rotates: true } })
  h.move('a', 5, 6, 90)
  assert.deepEqual(pos(h.source, 'a'), [5, 6])
  assert.equal(h.source.accessors.headingOf(h.source.itemById('a')), 90)
  h.move('a', 7, 8)
  assert.equal(h.source.accessors.headingOf(h.source.itemById('a')), 90, 'un move sin rumbo conserva el anterior')
  engine.destroy()
})
