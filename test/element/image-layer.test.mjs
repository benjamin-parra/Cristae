// <cristae-image-layer>: el montaje espera la fuente y la caja, el alta recibe lo declarado, los cambios
// llegan por el handle sin recargar lo que no cambió y la carga sale como evento del elemento. Sin DOM real
// ni customElements: el código REAL se presta del prototipo sobre un `this` falso, como
// label-visible.test.mjs.
import '../../test-helpers/element-stub.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { defaultConverter } from 'lit'
import { CristaeImageLayer } from '../../src/element/CristaeImageLayer.js'

const CAJA = { south: -34, west: -72, north: -32, east: -70 }

const motorFalso = () => {
  const llamadas = []
  const anotar   = nombre => valor => llamadas.push([nombre, valor])
  const handle   = {
    id         : 'radar',
    setUrl     : anotar('setUrl'),
    setImage   : anotar('setImage'),
    setBounds  : anotar('setBounds'),
    setCorners : anotar('setCorners'),
    setOpacity : anotar('setOpacity'),
    setVisible : anotar('setVisible'),
  }
  return { llamadas, cfg: null, addImageLayer(cfg) { this.cfg = cfg; return handle }, removeLayer() {} }
}

const capa = (props = {}) => {
  const el     = Object.create(CristaeImageLayer.prototype)
  const evts   = []
  Object.assign(el, {
    id: 'radar', opacity: 1, interactive: false, visible: true,
    _handle: null, _engine: null,
    _enclosingModifier: () => null,
    closest: () => null,
    dispatchEvent: ev => evts.push(ev),
  }, props)
  return { el, evts }
}

// Lo que Lit entrega en `updated`: las claves que cambiaron.
const cambios = (...claves) => new Map(claves.map(k => [k, undefined]))

test('sin url o sin caja no monta; con las dos, monta en el próximo ciclo', () => {
  const engine = motorFalso()
  const { el } = capa({ bounds: CAJA, _engine: engine })
  assert.equal(el.mountReady(), false)
  el.updated(cambios('bounds'))
  assert.equal(el._handle, null)

  el.url = 'radar.png'
  el.updated(cambios('url'))
  assert.ok(el._handle)
  assert.equal(engine.cfg.url, 'radar.png')
  assert.equal(engine.cfg.bounds, CAJA)
  assert.deepEqual(engine.llamadas, [], 'el diff inicial no recarga lo que el alta ya llevó')
})

test('el alta lleva lo declarado; image y corners mandan sobre url y bounds', () => {
  const engine  = motorFalso()
  const lienzo  = {}
  const corners = [[0, 0], [0, 1], [-1, 1], [-1, 0]]
  const { el }  = capa({ url: 'x.png', image: lienzo, bounds: CAJA, corners, opacity: 0.7, interactive: true, crossOrigin: 'anonymous', alt: 'radar', z: 3 })
  el.mountLayer(engine)
  const { onLoad, onError, ...cfg } = engine.cfg
  assert.deepEqual(cfg, {
    id: 'radar', pane: undefined, z: 3, url: undefined, image: lienzo, bounds: undefined, corners,
    opacity: 0.7, interactive: true, visible: true, crossOrigin: 'anonymous', alt: 'radar',
  })
  assert.equal(typeof onLoad, 'function')
  assert.equal(typeof onError, 'function')
})

test('opacity, bounds, url, image y visible llegan en vivo por el handle', () => {
  const engine = motorFalso()
  const { el } = capa({ url: 'a.png', bounds: CAJA })
  el._handle   = el.mountLayer(engine)

  const otra = { ...CAJA, north: -31 }
  Object.assign(el, { opacity: 0.2, bounds: otra })
  el.updated(cambios('opacity', 'bounds'))
  el.url = 'b.png'
  el.updated(cambios('url'))
  const lienzo = {}
  el.image = lienzo
  el.updated(cambios('image'))
  el.image = null
  el.updated(cambios('image'))
  el.corners = [[0, 0], [0, 1], [-1, 1], [-1, 0]]
  el.updated(cambios('corners'))
  el.visible = false
  el.updated(cambios('visible'))

  assert.deepEqual(engine.llamadas, [
    ['setBounds', otra], ['setOpacity', 0.2],
    ['setUrl', 'b.png'],
    ['setImage', lienzo],
    ['setUrl', 'b.png'],
    ['setCorners', el.corners],
    ['setVisible', false],
  ])
})

test('la carga sale como cristae:load y cristae:error, burbujeando y compuesta', () => {
  const engine = motorFalso()
  const { el, evts } = capa({ url: 'a.png', bounds: CAJA })
  el.mountLayer(engine)
  engine.cfg.onLoad({ url: 'a.png' })
  engine.cfg.onError({ url: 'b.png' })
  assert.deepEqual(evts.map(e => [e.type, e.detail.url, e.bubbles, e.composed]), [
    ['cristae:load', 'a.png', true, true],
    ['cristae:error', 'b.png', true, true],
  ])
})

test('el atributo bounds se lee como JSON y cross-origin con guión', () => {
  const { bounds, crossOrigin } = CristaeImageLayer.properties
  assert.deepEqual(defaultConverter.fromAttribute('{"south":-34,"west":-72,"north":-32,"east":-70}', bounds.type), CAJA)
  assert.equal(crossOrigin.attribute, 'cross-origin')
})

test('la firma es una hoja que produce image', () => {
  assert.deepEqual(CristaeImageLayer.cristaeSignature, { consumes: [], produces: ['image'], combine: null, arity: 'leaf' })
})
