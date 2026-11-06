// `addImageLayer` en el motor: alta y baja con su pane, la caja con que la cámara la encuadra, el z por
// defecto bajo las etiquetas, la visibilidad del alta y una configuración inválida que lanza sin dejar el
// pane montado.

import '../../test-helpers/engine-stub.mjs'
import { decorarElementos, makeMap, makeLeaflet } from '../../test-helpers/engine-stub.mjs'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { MapEngine } from '../../src/engine/MapEngine.js'
import { adoptLeafletHost } from '../../src/host/LeafletHost.js'

// Un <img> que carga cuando el test lo dice.
const imagenes = []
after(decorarElementos((el, tag) => {
  if (tag !== 'img') return el
  const oyentes = {}
  el.addEventListener    = (tipo, fn) => (oyentes[tipo] = fn)
  el.removeEventListener = tipo => delete oyentes[tipo]
  el.cargar              = () => oyentes.load?.()
  imagenes.push(el)
  return el
}))

const CAJA = { south: -34, west: -72, north: -32, east: -70 }

const motor = () => {
  const map    = makeMap()
  const engine = new MapEngine({ host: adoptLeafletHost(map, { leaflet: makeLeaflet() }) })
  return { map, engine }
}

test('el alta monta su pane y la baja lo suelta', () => {
  const { map, engine } = motor()
  const handle = engine.addImageLayer({ id: 'radar', url: 'radar.png', bounds: CAJA })
  assert.deepEqual(Object.keys(handle), ['id', 'setUrl', 'setImage', 'setBounds', 'setCorners', 'setOpacity', 'setVisible'])
  assert.ok(map.getPane('cristae-image-radar'))
  assert.equal(engine.getLayer('radar').kind, 'image')
  assert.equal(engine.removeLayer('radar'), true)
  assert.equal(map.getPane('cristae-image-radar'), null)
})

test('fitToLayer encuadra la caja de las esquinas sin una Source', () => {
  const { map, engine } = motor()
  const cajas = []
  map.fitBounds = ([sw, ne]) => { cajas.push([...sw, ...ne]); return map }
  engine.addImageLayer({ id: 'radar', url: 'radar.png', corners: [[-32, -72], [-32, -70], [-34, -69], [-34, -73]] })
  engine.camera.fitToLayer('radar')
  assert.deepEqual(cajas, [[-34, -73, -32, -69]])
})

test('el z por defecto va con el orden de declaración, bajo la banda de las etiquetas', () => {
  const { map, engine } = motor()
  engine.addImageLayer({ id: 'a', url: 'a.png', bounds: CAJA })
  engine.addImageLayer({ id: 'b', url: 'b.png', bounds: CAJA })
  engine.addImageLayer({ id: 'c', url: 'c.png', bounds: CAJA, z: 7 })
  assert.equal(map.getPane('cristae-image-a').style.zIndex, '400')
  assert.equal(map.getPane('cristae-image-b').style.zIndex, '410')
  assert.equal(map.getPane('cristae-image-c').style.zIndex, '7')
})

test('visible: false oculta el pane en el alta y setVisible lo alterna', () => {
  const { map, engine } = motor()
  const handle = engine.addImageLayer({ id: 'radar', url: 'radar.png', bounds: CAJA, visible: false })
  const pane   = map.getPane('cristae-image-radar')
  assert.equal(pane.style.visibility, 'hidden')
  handle.setVisible(true)
  assert.equal(pane.style.visibility, '')
})

test('una configuración inválida lanza TypeError y no deja el pane ni el registro', () => {
  const { map, engine } = motor()
  const malas = {
    'sin caja'          : { url: 'a.png' },
    'caja invertida'    : { url: 'a.png', bounds: { ...CAJA, south: -30 } },
    'url con image'     : { url: 'a.png', image: document.createElement('div'), bounds: CAJA },
    'bounds con corners': { url: 'a.png', bounds: CAJA, corners: [[0, 0], [0, 1], [1, 1], [1, 0]] },
    'opacidad no finita': { url: 'a.png', bounds: CAJA, opacity: NaN },
  }
  Object.entries(malas).forEach(([nombre, cfg]) => {
    assert.throws(() => engine.addImageLayer({ id: 'mala', ...cfg }), TypeError, nombre)
    assert.equal(map.getPane('cristae-image-mala'), null, nombre)
    assert.equal(engine.getLayer('mala'), null, nombre)
  })
})

test('con interactive el click dentro del cuadrilátero sale por el bus de la capa, y sin él no', () => {
  const { map, engine } = motor()
  const recibido = []
  // El stub proyecta px = grados·100: la caja cae entre (200, 100) y (500, 300) del contenedor.
  const caja = { south: 1, west: 2, north: 3, east: 5 }
  engine.addImageLayer({ id: 'radar', url: 'radar.png', bounds: caja, interactive: true })
  engine.addImageLayer({ id: 'muda', url: 'muda.png', bounds: caja })
  imagenes.slice(-2).forEach(img => img.cargar())
  engine.on('click', 'radar', hits => recibido.push(hits.map(h => [h.kind, h.id])))
  engine.on('click', 'muda', hits => recibido.push(['muda', hits.length]))
  const clickear = (x, y) => ['pointerdown', 'pointerup'].forEach(tipo => map.getContainer().emitir(tipo, { clientX: x, clientY: y }))
  clickear(300, 200)
  clickear(600, 200)
  assert.deepEqual(recibido, [[['image', 'radar']]])
  engine.destroy()
})
