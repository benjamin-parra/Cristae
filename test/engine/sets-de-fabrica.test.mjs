// Los sets de fábrica en el motor: una capa de puntos sin `iconSet` monta con `dot`, los nombres de forma
// ('dot', 'pin', 'circle', 'arrow') se resuelven sin registrarlos, `arrow` rota, un set registrado con ese nombre
// gana y un nombre desconocido sigue siendo error. Corre con: node --test test/engine/sets-de-fabrica.test.mjs
import '../../test-helpers/engine-stub.mjs'
import { makeEditGl, makeIconSet, makeLeaflet, makeMap } from '../../test-helpers/engine-stub.mjs'
import { conNavegador, crearNavegador } from '../../test-helpers/navegador-falso.mjs'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { MapEngine } from '../../src/engine/MapEngine.js'
import { adoptLeafletHost } from '../../src/host/LeafletHost.js'

after(conNavegador(crearNavegador({ crearGl: () => makeEditGl() })))

const motor  = () => new MapEngine({ host: adoptLeafletHost(makeMap(), { leaflet: makeLeaflet() }) })
const puntos = { idOf: i => i.id, positionOf: i => ({ lat: i.lat, lng: i.lng }) }
const alta   = (engine, id, extra = {}) => engine.addPointLayer({ id, accessors: puntos, data: [{ id: 'a', lat: 0, lng: 0 }], ...extra })

test('sin iconSet monta con dot: tiene set, no rota y resuelve variantes', () => {
  const engine = motor()
  alta(engine, 'flota')
  const set = engine.getLayer('flota').iconSet
  assert.ok(set, 'la capa tiene set')
  assert.equal(set.rotates, false)
  assert.equal(typeof set.resolve(''), 'number')
  assert.notEqual(set.resolve('#ff0000'), set.resolve(''))
  engine.destroy()
})

test('el set de fábrica nace una vez por motor y lo comparten sus capas', () => {
  const uno = motor()
  const dos = motor()
  alta(uno, 'a')
  alta(uno, 'b')
  alta(dos, 'a')
  assert.equal(uno.getLayer('a').iconSet, uno.getLayer('b').iconSet)
  assert.notEqual(uno.getLayer('a').iconSet, dos.getLayer('a').iconSet)
  uno.destroy()
  dos.destroy()
})

test('pin, circle y arrow se piden por nombre sin registrarlos; sólo arrow rota', () => {
  const engine = motor()
  const rota = nombre => (alta(engine, nombre, { iconSet: nombre }), engine.getLayer(nombre).iconSet.rotates)
  assert.deepEqual(['pin', 'circle', 'arrow'].map(rota), [false, false, true])
  engine.destroy()
})

test('un set registrado con el nombre de una forma gana al de fábrica, antes y después del primer uso', () => {
  const engine = motor()
  const propio = makeIconSet()
  engine.registerIconSet('dot', propio)
  alta(engine, 'a')
  assert.equal(engine.getLayer('a').iconSet, propio)

  const otro = motor()
  alta(otro, 'a')
  otro.registerIconSet('dot', propio)
  alta(otro, 'b')
  assert.equal(otro.getLayer('b').iconSet, propio)
  engine.destroy()
  otro.destroy()
})

test('un nombre que no es forma ni está registrado es error, como antes', () => {
  const engine = motor()
  assert.throws(() => alta(engine, 'a', { iconSet: 'camion' }), /iconSet 'camion' no registrado/)
  assert.equal(engine.getLayer('a'), null)
  engine.destroy()
})

test('una instancia de IconSet pasa tal cual', () => {
  const engine = motor()
  const propio = makeIconSet()
  alta(engine, 'a', { iconSet: propio })
  assert.equal(engine.getLayer('a').iconSet, propio)
  engine.destroy()
})
