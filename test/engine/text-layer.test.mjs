// `addTextLayer` en el motor (docs/text-layer.md): una capa base de texto suelto con Source propia, que pinta
// con los renderers de los rótulos y no pide contexto WebGL. Se pinta con el canvas real sobre un contexto 2D
// que mide 7 px por grafema; el miembro se lee por `record.labels`, como en labels.test.mjs. Corre con:
//   node --test test/engine/text-layer.test.mjs
import { decorarElementos, makeEditGl, makeLeaflet, makeMap } from '../../test-helpers/engine-stub.mjs'
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { MapEngine } from '../../src/engine/MapEngine.js'
import { adoptLeafletHost } from '../../src/host/LeafletHost.js'
import { createSource } from '../../src/data/index.js'

const frame = () => new Promise(resolve => setTimeout(resolve, 5))

// Lo que pinta el canvas de los rótulos, en orden, y cada contexto que se pide.
const fills   = []
const pedidos = []
const ctx2d   = new Proxy({
  measureText  : text => ({ width: 7 * [...text].length }),
  getImageData : (_x, _y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),   // el atlas rasteriza al primer uso
  fillText     : text => fills.push(text),
}, { get: (t, p) => t[p] ?? (() => {}), set: () => true })
after(decorarElementos((el, tag) => {
  if (tag === 'canvas') el.getContext = kind => (pedidos.push(kind), kind === '2d' ? ctx2d : makeEditGl())
  return el
}))

const LABEL_PLANE = 2_000_400

const puntos   = { idOf: c => c.id, positionOf: c => ({ lat: c.lat, lng: c.lng }) }
const CIUDADES = [{ id: 'scl', nombre: 'Santiago', lat: 0, lng: 0 }, { id: 'lim', nombre: 'Lima', lat: 30, lng: 30 }]

const motor = () => {
  const map    = makeMap()
  const engine = new MapEngine({ host: adoptLeafletHost(map, { leaflet: makeLeaflet() }) })
  return { map, engine, container: map.getContainer() }
}

const miembro = (engine, id) => engine.getLayer(id).labels.links[0].member
const textos  = member => {
  const out = []
  member.forEach((acc, item, id, text) => acc.push(text), out)
  return out
}

const clickear = (container, x, y) => {
  container.emitir('pointerdown', { clientX: x, clientY: y })
  container.emitir('pointerup', { clientX: x, clientY: y })
}

test('el texto va sobre su punto por defecto y admite above, below y right; sin textOf es el id', () => {
  const { engine } = motor()
  const capa   = engine.addTextLayer({ id: 'ciudades', accessors: puntos, data: CIUDADES })
  const member = miembro(engine, 'ciudades')
  assert.deepEqual([engine.getLayer('ciudades').kind, member.kind, member.placement], ['text', 'text', 'center'])
  assert.deepEqual(textos(member), ['scl', 'lim'])

  ;['above', 'below', 'right', 'center'].forEach(placement => {
    capa.update({ placement })
    assert.equal(member.placement, placement)
  })
  capa.update({ textOf: c => c.nombre })
  assert.deepEqual(textos(member), ['Santiago', 'Lima'])
  engine.destroy()
})

test('lo inválido lanza TypeError sin registrar nada; un update inválido no cambia nada', () => {
  const { engine, map } = motor()
  assert.throws(() => engine.addTextLayer({ id: 't', accessors: puntos, placement: 'along' }), TypeError)
  assert.throws(() => engine.addTextLayer({ id: 't', accessors: puntos, renderer: 'gl' }), /pendiente/)
  assert.throws(() => engine.addTextLayer({ id: 't', accessors: puntos, placement: 'center', repeat: 240 }), TypeError)
  assert.throws(() => engine.addTextLayer({ id: 't', accessors: { idOf: c => c.id } }), TypeError)
  assert.equal(engine.getLayer('t'), null)
  assert.equal(map.getPane('cristae-labels'), null, 'ni canvas')

  const capa   = engine.addTextLayer({ id: 't', accessors: puntos, data: CIUDADES, offset: 4 })
  const member = miembro(engine, 't')
  const antes  = member.opts
  assert.throws(() => capa.update({ placement: 'along' }), TypeError)
  assert.throws(() => capa.update({ paint: () => null, renderer: 'html' }), TypeError)
  assert.equal(member.opts, antes)
  engine.destroy()
})

test('canvas y html no piden contexto WebGL', async () => {
  const { engine, map } = motor()
  pedidos.length = 0
  engine.addTextLayer({ id: 'a', accessors: puntos, data: CIUDADES })
  engine.addTextLayer({ id: 'b', accessors: puntos, data: CIUDADES, htmlOf: c => `<b>${c.nombre}</b>` })
  await frame()
  assert.ok(pedidos.length > 0 && pedidos.every(kind => kind === '2d'), `pedidos: ${pedidos}`)
  assert.ok(map.getPane('cristae-labels'), 'canvas: el compartido')
  assert.ok(Number(map.getPane('cristae-labels-html-b').style.zIndex) > LABEL_PLANE, 'html: un pane propio sobre él')
  engine.destroy()
})

test('pinta en el canvas compartido, y setVisible lo oculta sin desmontar', async () => {
  const { engine, map } = motor()
  const capa   = engine.addTextLayer({ id: 'ciudades', accessors: puntos, data: CIUDADES, textOf: c => c.nombre })
  const member = miembro(engine, 'ciudades')
  fills.length = 0
  await frame()
  assert.ok(fills.includes('Santiago'))

  const pinta = () => {
    fills.length = 0
    map.fire('moveend')
    return fills.includes('Santiago')
  }
  capa.setVisible(false)
  assert.equal(member.visible, false)
  assert.equal(pinta(), false)
  capa.setVisible(true)
  assert.equal(pinta(), true)
  engine.destroy()
})

test('los datos llegan por set y por la Source; attachSource pasa a otra y deja de oír la vieja', () => {
  const { engine } = motor()
  const capa   = engine.addTextLayer({ id: 't', accessors: puntos, data: CIUDADES })
  const member = miembro(engine, 't')
  capa.set([CIUDADES[1]])
  assert.deepEqual(textos(member), ['lim'])

  const vieja = engine.getLayer('t').source
  const nueva = createSource(puntos)
  nueva.set([{ id: 'bog', lat: 4, lng: -74 }])
  engine.attachSource('t', nueva)
  assert.deepEqual(textos(member), ['bog'])
  const v = member.version
  vieja.set?.(CIUDADES)
  assert.equal(member.version, v, 'la vieja ya no avisa')

  const propia = createSource(puntos)
  propia.set(CIUDADES)
  engine.addTextLayer({ id: 'u', source: propia })
  assert.deepEqual(textos(miembro(engine, 'u')), ['scl', 'lim'], 'con la Source del consumidor')
  engine.destroy()
})

test('interactiva: un click en el texto es un click de la capa de texto; sin interactive cae al vacío', async () => {
  const { engine, container } = motor()
  engine.addTextLayer({ id: 'ciudades', accessors: puntos, data: CIUDADES, interactive: true })
  engine.addTextLayer({ id: 'mudas', accessors: puntos, data: [{ id: 'x', lat: 0, lng: 0 }] })
  const vistos = []
  const vacios = []
  engine.on('click', hits => vistos.push(hits))
  engine.on('map:click', e => vacios.push(e))
  await frame()

  clickear(container, 400, 300)
  const [hit] = vistos.at(-1)
  assert.deepEqual([hit.layerId, hit.kind, hit.id, hit.zIndex], ['ciudades', 'text', 'scl', LABEL_PLANE])

  engine.removeLayer('ciudades')
  clickear(container, 400, 300)
  assert.equal(vacios.length, 1, 'la capa sin interactive no se pica')
  engine.destroy()
})

test('el foco atenúa el texto con su kind o con label; la baja suelta el canvas', () => {
  const { engine, map } = motor()
  engine.addTextLayer({ id: 't', accessors: puntos, data: CIUDADES })
  const member = miembro(engine, 't')
  engine.focus(['otra'], { kinds: ['text'] })
  assert.equal(member.alphaOf('scl'), 0.3)
  engine.focus(['otra'], { kinds: ['point'] })
  assert.equal(member.alphaOf('scl'), 1)
  engine.focus(['t'])
  assert.equal(member.alphaOf('scl'), 1, 'la capa enfocada queda plena')
  engine.unfocusAll()
  engine.setLayerFocus('t', ['lim'])
  assert.deepEqual([member.alphaOf('scl'), member.alphaOf('lim')], [0.3, 1])

  engine.removeLayer('t')
  assert.equal(map.getPane('cristae-labels'), null)
  assert.equal(engine.getLayer('t'), null)
  engine.destroy()
})
