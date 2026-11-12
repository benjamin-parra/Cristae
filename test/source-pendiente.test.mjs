// La Source pendiente (interna): existe antes de su capa, encola lo que se le escribe y, al ligarse, se
// vuelve la Source real SOBRE EL MISMO objeto. Corre con: node --test test/source-pendiente.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { createPendingSource, createSource, BIND } from '../src/data/Source.js'
import * as core from '../src/data/index.js'
import { bytesPorLlamada } from '../test-helpers/asignaciones.mjs'

const idOf       = it => it.id
const positionOf = it => ({ lat: it.lat, lng: it.lng })
const accessors  = { idOf, positionOf, pathOf: it => it.path }
const flush      = () => new Promise(r => setTimeout(r, 10))
const it         = (id, lat = 0, lng = 0, path = [[0, 0]]) => ({ id, lat, lng, path })

test('no sale por el entry del núcleo', () => {
  assert.equal(core.createPendingSource, undefined)
  assert.equal(core.BIND, undefined)
})

test('sin ligar, las lecturas dan el neutro y es estable', () => {
  const p = createPendingSource()
  assert.equal(p.getSnapshot().length, 0)
  assert.ok(Object.isFrozen(p.getSnapshot()))
  assert.equal(p.getSnapshot(), p.getSnapshot())
  assert.equal(p.version(), 0)
  assert.equal(p.itemById(1), undefined)
  assert.equal(p.dirtyIds().size, 0)
  assert.equal(p.dirtyIds(), p.dirtyIds())
  assert.equal(p.moveDirtyIds().size, 0)
})

test('las ops encoladas se aplican en orden al ligarse', () => {
  const p = createPendingSource()
  p.set([it(1), it(2)])
  p.remove(1)
  p.addFilter({ id: 'f', predicate: x => x.id === 2 })
  p.move(2, 7, 8, 30)
  assert.equal(p.getSnapshot().length, 0, 'nada se aplica antes')
  p[BIND](accessors)
  assert.deepEqual(p.getSnapshot().map(idOf), [2])
  assert.equal(p.accessors.positionOf(p.itemById(2)).lat, 7)
  assert.equal(p.accessors.headingOf(p.itemById(2)), 30)
})

test('los moves de un mismo id entre dos ops que no son move colapsan en el último', () => {
  const p = createPendingSource()
  p.set([it(1), it(2)])
  p.move(1, 1, 1, 10)
  p.move(2, 2, 2)
  p.move(1, 3, 3)
  p.move(1, 4, 4, 50)
  p.patch([it(1), it(2)], new Set([]))   // corta la corrida
  p.move(1, 5, 5)
  const vistos = []
  const real = p[BIND](accessors, undefined, { hold: true })
  assert.equal(p.getSnapshot().length, 0)
  p.subscribe(() => vistos.push(1))
  real()
  const pos = p.accessors.positionOf(p.itemById(1))
  assert.equal(pos.lat, 5)
  assert.equal(p.accessors.headingOf(p.itemById(1)), 50, 'el rumbo del colapsado sobrevive al move sin rumbo')
})

test('el colapso acota la cola', () => {
  const p = createPendingSource()
  p.set([it(1)])
  for (let i = 0; i < 1000; i++) p.move(1, i, i)
  let moves = 0
  p.subscribe(() => {})
  p[BIND](accessors)
  assert.equal(p.accessors.positionOf(p.itemById(1)).lat, 999)
  assert.equal(p.version(), 2, 'un set y un solo move: dos commits')
  void moves
})

test('hold retiene la cola hasta release, que la reproduce una sola vez', () => {
  const p = createPendingSource()
  p.set([it(1)])
  const release = p[BIND](accessors, undefined, { hold: true })
  assert.equal(p.getSnapshot().length, 0)
  release()
  assert.equal(p.getSnapshot().length, 1)
  p.set([])
  release()
  assert.equal(p.getSnapshot().length, 0, 'el segundo release no reproduce')
})

test('la identidad no cambia y los miembros pasan a ser los de la Source real', () => {
  const p  = createPendingSource()
  const sn = p.getSnapshot
  const ref = p
  p[BIND](accessors, ['a'])
  assert.equal(p, ref)
  assert.notEqual(p.getSnapshot, sn)
  assert.deepEqual(p.variants, ['a'])
  assert.equal(typeof p.append, 'function')
})

test('un suscriptor previo recibe el emit y su teardown sigue valiendo', async () => {
  const p = createPendingSource()
  let a = 0
  let b = 0
  const offA = p.subscribe(() => a++)
  p.subscribe(() => b++)
  p[BIND](accessors)
  p.set([it(1)])
  await flush()
  assert.equal(a, 1)
  assert.equal(b, 1)
  offA()
  p.set([it(1), it(2)])
  await flush()
  assert.equal(a, 1)
  assert.equal(b, 2)
})

test('un teardown previo al BIND impide la ligadura de ese suscriptor', async () => {
  const p = createPendingSource()
  let a = 0
  p.subscribe(() => a++)()
  p[BIND](accessors)
  p.set([it(1)])
  await flush()
  assert.equal(a, 0)
})

test('BIND repetido no religa: los accessors quedan fijados', () => {
  const p = createPendingSource()
  p.set([it(1)])
  p[BIND](accessors)
  const snap = p.getSnapshot
  const release = p[BIND]({ idOf: x => x.otro, positionOf }, ['x'])
  assert.equal(p.getSnapshot, snap)
  assert.equal(p.variants, undefined)
  assert.equal(typeof release, 'function')
  assert.doesNotThrow(release)
})

test('una op que lanza no corta el resto de la cola', () => {
  const p = createPendingSource()
  p.append(99, [1, 1])   // id ausente: RangeError al reproducir
  p.set([it(1)])
  assert.doesNotThrow(() => p[BIND](accessors))
  assert.equal(p.getSnapshot().length, 1)
})

test('ya ligada, move cuesta lo de una Source real', () => {
  const real = createSource(accessors)
  const p    = createPendingSource()
  real.set([it(1)])
  p.set([it(1)])
  p[BIND](accessors)
  real.move(1, 0, 0, 0)
  p.move(1, 0, 0, 0)
  const medir = fn => bytesPorLlamada(fn, 2_000, { calentar: 20_000 })
  const base = medir(i => real.move(1, i, i, i & 255))
  const lig  = medir(i => p.move(1, i, i, i & 255))
  assert.ok(lig - base < 1, `real ${base} bytes por llamada, ligada ${lig}`)
})

test('varios set antes de ligar retienen sólo el último, con los filtros', async () => {
  const p = createPendingSource()
  p.addFilter({ id: 'f', f: x => x.id !== 2 })
  p.set([it(1)])
  p.move(1, 9, 9)
  p.set([it(1, 1, 1), it(2), it(3)])
  p[BIND](accessors)
  await flush()
  assert.deepEqual(p.getSnapshot().map(x => x.id), [1, 3], 'el filtro sobrevive y el set vigente es el último')
  const { lat, lng } = p.accessors.positionOf(p.itemById(1))
  assert.deepEqual([lat, lng], [1, 1], 'el move anterior al último set no vuelve')
})
