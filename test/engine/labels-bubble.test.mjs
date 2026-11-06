// Los rótulos de las burbujas de un cluster (DISENO-ROTULOS §2.7): `addLabels` sobre la capa de burbujas.
// Lo que recibe `textOf`, cuándo se resuelven las hojas, el click que expande y el `slot="bubble"` de
// rótulo, que no se rotula. Corre con:
//   node --test test/engine/labels-bubble.test.mjs
import { decorarElementos, makeEditGl, makeIconSet, makeLeaflet, makeMap } from '../../test-helpers/engine-stub.mjs'
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { MapEngine } from '../../src/engine/MapEngine.js'
import { adoptLeafletHost } from '../../src/host/LeafletHost.js'

const frame = () => new Promise(resolve => setTimeout(resolve, 5))

const fills = []
const ctx2d = new Proxy({
  measureText : text => ({ width: 7 * [...text].length }),
  fillText    : text => fills.push(text),
}, { get: (t, p) => t[p] ?? (() => {}), set: () => true })
after(decorarElementos((el, tag) => {
  if (tag === 'canvas') el.getContext = kind => (kind === '2d' ? ctx2d : makeEditGl())
  return el
}))

// Cinco puntos juntos cerca de (0, 0): a zoom 3 son una burbuja de 5.
const FLOTA = [
  { id: 1, lat: 0, lng: 0 }, { id: 2, lat: 0, lng: 0.0001 }, { id: 3, lat: 0.0001, lng: 0 },
  { id: 4, lat: 0.0001, lng: 0.0001 }, { id: 5, lat: 0, lng: 0.0002 },
]
const puntos = { idOf: v => v.id, positionOf: v => ({ lat: v.lat, lng: v.lng }) }

const mount = (foldOpts = {}) => {
  const map    = makeMap()
  const engine = new MapEngine({ host: adoptLeafletHost(map, { leaflet: makeLeaflet() }) })
  engine.addPointLayer({ id: 'flota', accessors: puntos, iconSet: makeIconSet(), data: FLOTA })
  const control = engine.addClusterFold([{ id: 'flota' }], { radius: 80, maxZoom: 18, minPoints: 2, ...foldOpts }).handle.control
  return { map, engine, control, bubbleId: control.bubbleLayerId }
}

const textos = member => {
  const out = []
  member.forEach((acc, item, id, text) => acc.push(text), out)
  return out
}

test('textOf recibe la burbuja: su conteo y, al leerse, sus hojas', () => {
  const { engine, bubbleId } = mount()
  const vistas = []
  engine.addLabels({ hostId: bubbleId, textOf: b => (vistas.push(b), `${b.count} camiones`) })
  const member = engine.getLayer(bubbleId).labels.links[0].member

  assert.deepEqual(textos(member), ['5 camiones'])
  const [b] = vistas
  assert.ok(Object.isFrozen(b))
  assert.equal(b.count, 5)
  assert.deepEqual(b.leaves.map(v => v.id).sort(), [1, 2, 3, 4, 5], 'los ítems de la Source del host')
  assert.equal(b.leaves[0], FLOTA.find(v => v.id === b.leaves[0].id), 'los mismos objetos')
  assert.equal(member.kind, 'bubble')
  assert.equal(member.placement, 'below', '`auto` deja el texto bajo la burbuja')
  engine.destroy()
})

test('textOf por defecto es el conteo', () => {
  const { engine, bubbleId } = mount()
  engine.addLabels({ hostId: bubbleId })
  assert.deepEqual(textos(engine.getLayer(bubbleId).labels.links[0].member), ['5'])
  engine.destroy()
})

test('las hojas no se resuelven si nadie las lee', () => {
  const { engine, control, bubbleId } = mount()
  const leavesOf = control.leavesOf
  let pedidas = 0
  control.leavesOf = id => (pedidas++, leavesOf(id))
  engine.addLabels({ hostId: bubbleId, textOf: b => b.count })
  textos(engine.getLayer(bubbleId).labels.links[0].member)
  assert.equal(pedidas, 0)
  engine.destroy()
})

test('con la espiral abierta, las hojas son las del snapshot que se ve', () => {
  const { engine, control, bubbleId } = mount()
  const bubble = () => engine.getLayer(bubbleId).source.getSnapshot()[0]
  control.expand(bubble().id)
  const vistas = []
  engine.addLabels({ hostId: bubbleId, textOf: b => (vistas.push(b.leaves.map(v => v.id).sort()), b.count) })
  textos(engine.getLayer(bubbleId).labels.links[0].member)
  assert.deepEqual(vistas, [[1, 2, 3, 4, 5]])
  assert.deepEqual(control.leavesOf('no-existe'), [], 'un id que no es de este cuadro no tiene hojas')
  engine.destroy()
})

test('el hash de una burbuja es su id con su conteo', () => {
  const { engine, bubbleId } = mount()
  engine.addLabels({ hostId: bubbleId })
  const member = engine.getLayer(bubbleId).labels.links[0].member
  const b      = engine.getLayer(bubbleId).source.getSnapshot()[0]
  assert.equal(member.hashOf(b), `${b.id}:5`)
  engine.destroy()
})

test('click en el rótulo de una burbuja la expande', async () => {
  const { map, engine, bubbleId } = mount()
  engine.addLabels({ hostId: bubbleId })
  const expandidas = []
  engine.on('cluster:expand', e => expandidas.push(e))
  await frame()
  assert.ok(fills.includes('5'), 'el rótulo se pintó')

  // La burbuja mide 43 px: el texto va 21,5 + 4 px bajo su centro (400, 300), y su caja mide 10,5 px.
  const container = map.getContainer()
  container.emitir('pointerdown', { clientX: 400, clientY: 331 })
  container.emitir('pointerup', { clientX: 400, clientY: 331 })
  assert.equal(expandidas.length, 1)
  assert.equal(expandidas[0].count, 5)
  engine.destroy()
})

test('los rótulos de las burbujas van sobre ellas y bajo la espiral, en un canvas del cluster', () => {
  const { map, engine, bubbleId } = mount()
  engine.addLabels({ hostId: bubbleId })
  const z = name => Number(map.getPane(name)?.style.zIndex)
  const rotulos = z(`${bubbleId}-labels-canvas`)
  assert.equal(rotulos, z(bubbleId.replace(':clusters', '-bubbles')) + 1)
  assert.ok(rotulos < engine.getLayer(bubbleId.replace(':clusters', ':spider')).zIndex)
  assert.equal(map.getPane('cristae-labels'), null, 'no usa el canvas compartido del plano')
  engine.destroy()
  assert.equal(map.getPane(`${bubbleId}-labels-canvas`), null, 'y se va con el cluster')
})

// Avisan dos claves: el retiro de la burbuja de rótulo, al montarla, y que no se rotula, al pedírselo.
test('con slot="bubble" de rótulo, las burbujas no se rotulan y cada aviso sale una vez', () => {
  const avisos = []
  const warn   = console.warn
  console.warn = (...args) => avisos.push(args.join(' '))
  try {
    const { engine, bubbleId } = mount({ bubble: { kind: 'label' } })
    assert.equal(engine.addLabels({ hostId: bubbleId }), null)
    assert.equal(engine.addLabels({ hostId: bubbleId }), null)
    assert.equal(avisos.length, 2)
    assert.match(avisos[0], /bubble: \{ kind: 'label' \}\) se retira en v0\.40\.0: .*<cristae-labeled> por fuera del cluster/)
    assert.match(avisos[1], /no se rotulan: se retiran en v0\.40\.0/)
    engine.destroy()
  } finally {
    console.warn = warn
  }
})
