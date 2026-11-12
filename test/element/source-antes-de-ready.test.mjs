// `el.source` de <cristae-point-layer> existe desde la construcción: antes de ready encola move/set/append y la capa los
// aplica al montar, con `data` o con `url`; es la misma Source que `controls.source`; una Source del consumidor sigue
// ganando. Elementos reales (Lit + jsdom) sobre el navegador falso.
// Corre con: node --test test/element/source-antes-de-ready.test.mjs
import { window } from '../../test-helpers/jsdom-elementos.mjs'
import { instalarNavegador } from '../../test-helpers/navegador-falso.mjs'
import { makeIconSet } from '../../test-helpers/engine-stub.mjs'
import { coleccion, fetchFalso, punto, retenida } from '../../test-helpers/datos-remotos.mjs'
import test, { after, mock } from 'node:test'
import assert from 'node:assert/strict'
import '../../src/index.js'
import { createSource } from '../../src/data/index.js'

const ACC     = { idOf: v => v.id, positionOf: v => ({ lat: v.lat, lng: v.lng }) }
const iconSet = makeIconSet()
const esperar = ms => new Promise(r => setTimeout(r, ms))
const pos     = (source, id) => { const p = source.accessors.positionOf(source.itemById(id)); return [p.lat, p.lng] }

const mapa = () => {
  document.body.replaceChildren()
  const map = document.createElement('cristae-map')
  map.style.cssText = 'display:block;width:800px;height:600px'
  return map
}
const capa = (props = {}) => Object.assign(document.createElement('cristae-point-layer'), { id: 'p', iconSet, ...props })

after(() => document.body.replaceChildren())

test('el.source existe recién creado, sin mapa, y es estable', () => {
  const el = document.createElement('cristae-point-layer')
  assert.ok(el.source)
  assert.equal(typeof el.source.move, 'function')
  assert.equal(el.source, el.source)
})

test('con data: un move anterior a ready se aplica después del set, y es controls.source', async t => {
  instalarNavegador(window)
  const map = mapa()
  document.body.appendChild(map)
  await esperar(40)
  t.after(() => map.remove())

  const el = capa({ accessors: ACC })
  const propia = el.source
  propia.move(1, 9, 8, 90)
  el.data = [{ id: 1, lat: 1, lng: 2 }, { id: 2, lat: 3, lng: 4 }]
  map.appendChild(el)
  await esperar(40)

  assert.equal(el.source, el.controls.source, 'la misma Source que el handle')
  assert.equal(el.source, propia, 'la identidad no cambia al montar')
  assert.deepEqual(pos(el.source, 1), [9, 8])
  assert.deepEqual(pos(el.source, 2), [3, 4])
  assert.equal(el.source.accessors.headingOf(el.source.itemById(1)), 90)
})

test('con url: lo movido antes de ready aparece aplicado tras la carga', async t => {
  instalarNavegador(window)
  const map = mapa()
  document.body.appendChild(map)
  await esperar(40)
  t.after(() => map.remove())

  const { soltar, rutaDe } = retenida()
  const el = capa({ url: 'f.geojson', fetch: fetchFalso({ 'f.geojson': rutaDe() }) })
  el.source.move(0, 7, 6, 45)
  map.appendChild(el)
  await esperar(40)
  assert.equal(el.source.getSnapshot().length, 0, 'retenido mientras carga')

  soltar(coleccion([punto(-70, -33), punto(-71, -34)]))
  await esperar(60)
  assert.equal(el.source.getSnapshot().length, 2)
  assert.deepEqual(pos(el.source, 0), [7, 6])
  assert.equal(el.source.accessors.headingOf(el.source.itemById(0)), 45)
  assert.equal(el.source, el.controls.source)
})

test('set y move antes de ready se encolan y se aplican al montar', async t => {
  instalarNavegador(window)
  const map = mapa()
  document.body.appendChild(map)
  await esperar(40)
  t.after(() => map.remove())

  const el = capa({ accessors: ACC })
  el.source.set([{ id: 1, lat: 1, lng: 1 }])
  el.source.move(1, 5, 5)
  map.appendChild(el)
  await esperar(40)
  assert.equal(el.source.getSnapshot().length, 1)
  assert.deepEqual(pos(el.source, 1), [5, 5])
})

test('una Source del consumidor sigue ganando y avisa por -of como hasta ahora', async t => {
  instalarNavegador(window)
  const aviso = mock.method(console, 'warn', () => {})
  const map = mapa()
  document.body.appendChild(map)
  await esperar(40)
  t.after(() => { map.remove(); aviso.mock.restore() })

  const propia = createSource(ACC)
  propia.set([{ id: 1, lat: 1, lng: 1 }])
  const el = capa({ source: propia })
  el.setAttribute('variant-of', 'tipo')
  map.appendChild(el)
  await esperar(40)
  assert.equal(el.source, propia)
  assert.equal(el.controls.source, propia)
  assert.ok(aviso.mock.calls.some(c => /variantOf se ignora con 'source'/.test(String(c.arguments[0]))), 'avisa que el -of se ignora')
})

test('desmontar y montar conserva la identidad de la Source propia', async t => {
  instalarNavegador(window)
  const map = mapa()
  document.body.appendChild(map)
  await esperar(40)
  t.after(() => map.remove())

  const el = capa({ accessors: ACC, data: [{ id: 1, lat: 1, lng: 1 }] })
  const propia = el.source
  map.appendChild(el)
  await esperar(40)
  el.remove()
  map.appendChild(el)
  await esperar(40)
  assert.equal(el.source, propia)
  assert.equal(el.controls.source, propia)
})

test('data reactivo: A, B y otra vez A aplica cada cambio, también el valor con que montó', async t => {
  instalarNavegador(window)
  const map = mapa()
  document.body.appendChild(map)
  await esperar(40)
  t.after(() => map.remove())

  const A = [{ id: 1, lat: 1, lng: 1 }]
  const B = [{ id: 2, lat: 2, lng: 2 }, { id: 3, lat: 3, lng: 3 }]
  const el = capa({ accessors: ACC, data: A })
  map.appendChild(el)
  await esperar(40)
  assert.deepEqual(el.source.getSnapshot().map(i => i.id), [1])
  el.data = B
  await esperar(40)
  assert.deepEqual(el.source.getSnapshot().map(i => i.id), [2, 3])
  el.data = A
  await esperar(40)
  assert.deepEqual(el.source.getSnapshot().map(i => i.id), [1])
})

test('remontar conserva la Source propia con los accessors del primer montaje', async t => {
  instalarNavegador(window)
  const map = mapa()
  document.body.appendChild(map)
  await esperar(40)
  t.after(() => map.remove())

  const el = capa({ accessors: ACC, data: [{ id: 1, lat: 1, lng: 1 }] })
  const propia = el.source
  map.appendChild(el)
  await esperar(40)
  const idOf = propia.accessors.idOf
  el.remove()
  el.accessors = { idOf: v => `otro-${v.id}`, positionOf: ACC.positionOf }
  map.appendChild(el)
  await esperar(40)
  assert.equal(el.source, propia)
  assert.equal(propia.accessors.idOf, idOf, 'los accessors quedan fijados en el primer montaje')
  assert.equal(propia.getSnapshot().length, 1, 'conserva los ítems que ya tenía')
})
