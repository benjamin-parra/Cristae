// `clickAction` en las altas: 'fit' encuadra el ítem clicado (panTo en puntos, fitBounds por caja en polígonos y
// líneas) y 'follow' lo sigue; lo demás es TypeError, y sin `interactive` avisa y no se suscribe. El pick de GL no
// corre en node: el test reemplaza `resolveClick` de la capa, que el registro lee en cada clic, y dispara el clic
// real por el contenedor. Corre con: node --test test/engine/click-action.test.mjs
import '../../test-helpers/engine-stub.mjs'
import { makeEditGl, makeIconSet, makeLeaflet, makeMap } from '../../test-helpers/engine-stub.mjs'
import { conNavegador, crearNavegador } from '../../test-helpers/navegador-falso.mjs'
import { after, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { MapEngine } from '../../src/engine/MapEngine.js'
import { adoptLeafletHost } from '../../src/host/LeafletHost.js'

after(conNavegador(crearNavegador({ crearGl: () => makeEditGl() })))

const frame = () => new Promise(resolve => setTimeout(resolve, 5))
const puntos = { idOf: i => i.id, positionOf: i => ({ lat: i.lat, lng: i.lng }) }
const rings  = { idOf: i => i.id, ringsOf: i => i.rings }
const trazas = { idOf: i => i.id, pathOf: i => i.path }

const montar = () => {
  const map    = makeMap()
  const engine = new MapEngine({ host: adoptLeafletHost(map, { leaflet: makeLeaflet() }) })
  const camera = engine.camera
  const espiar = nombre => mock.method(camera, nombre, () => camera)
  return { engine, container: map.getContainer(), espiar }
}

// Hace que la capa `id` responda al próximo clic con el ítem `itemId`.
const respondeCon = (engine, id, itemId) => {
  engine.getLayer(id).layer.resolveClick = () => [{ ref: itemId, id: itemId, distancePx: 0 }]
}

const clickear = async (container, x = 400, y = 300) => {
  await frame()
  container.emitir('pointerdown', { clientX: x, clientY: y })
  container.emitir('pointerup', { clientX: x, clientY: y })
}

test('fit en un punto centra la cámara en su posición', async () => {
  const { engine, container, espiar } = montar()
  const panTo = espiar('panTo')
  engine.addPointLayer({ id: 'flota', accessors: puntos, data: [{ id: 'a', lat: 5, lng: 6 }], interactive: true, clickAction: 'fit', iconSet: makeIconSet() })
  respondeCon(engine, 'flota', 'a')
  await clickear(container)
  assert.deepEqual(panTo.mock.calls.map(c => c.arguments[0]), [{ lat: 5, lng: 6 }])
  engine.destroy()
})

test('fit en un polígono y en una línea encuadra la caja de su geometría', async () => {
  const { engine, container, espiar } = montar()
  const fitBounds = espiar('fitBounds')
  engine.addPolygonLayer({ id: 'predios', accessors: rings, data: [{ id: 'p', rings: [[[0, 0], [0, 2], [3, 2]]] }], clickAction: 'fit' })
  engine.addLineLayer({ id: 'rutas', accessors: trazas, data: [{ id: 'r', path: [[10, 10], [12, 14]] }], interactive: true, clickAction: 'fit' })

  respondeCon(engine, 'predios', 'p')
  await clickear(container)
  respondeCon(engine, 'rutas', 'r')
  engine.getLayer('predios').layer.resolveClick = () => []
  await clickear(container)

  assert.deepEqual(fitBounds.mock.calls.map(c => c.arguments[0]), [
    { south: 0, west: 0, north: 3, east: 2 },
    { south: 10, west: 10, north: 12, east: 14 },
  ])
  engine.destroy()
})

test('follow sigue el ítem clicado por su id', async () => {
  const { engine, container, espiar } = montar()
  const followPoint = espiar('followPoint')
  engine.addPointLayer({ id: 'flota', accessors: puntos, data: [{ id: 'a', lat: 5, lng: 6 }], interactive: true, clickAction: 'follow', iconSet: makeIconSet() })
  respondeCon(engine, 'flota', 'a')
  await clickear(container)
  assert.deepEqual(followPoint.mock.calls.map(c => c.arguments), [['flota', 'a']])
  engine.destroy()
})

test('un clic que cae en otra capa, encima, no actúa; y la baja suelta la suscripción', async () => {
  const { engine, container, espiar } = montar()
  const panTo = espiar('panTo')
  const config = { accessors: puntos, data: [{ id: 'a', lat: 5, lng: 6 }], interactive: true, iconSet: makeIconSet() }
  engine.addPointLayer({ id: 'abajo', ...config, clickAction: 'fit' })
  engine.addPointLayer({ id: 'arriba', ...config })
  respondeCon(engine, 'abajo', 'a')
  respondeCon(engine, 'arriba', 'a')
  await clickear(container)
  assert.equal(panTo.mock.callCount(), 0, 'el primer hit es el de la capa de arriba')

  engine.getLayer('arriba').layer.resolveClick = () => []
  await clickear(container)
  assert.equal(panTo.mock.callCount(), 1)

  engine.removeLayer('abajo')
  engine.getLayer('arriba').layer.resolveClick = () => [{ ref: 'a', id: 'a', distancePx: 0 }]
  await clickear(container)
  assert.equal(panTo.mock.callCount(), 1)
  engine.destroy()
})

test('un valor desconocido, y follow fuera de puntos, son TypeError sin dejar capa', () => {
  const { engine } = montar()
  const set = makeIconSet()
  assert.throws(() => engine.addPointLayer({ id: 'a', accessors: puntos, clickAction: 'zoom', iconSet: set }), TypeError)
  assert.throws(() => engine.addLineLayer({ id: 'b', accessors: trazas, clickAction: 'follow' }), /sólo va en capas de puntos/)
  assert.throws(() => engine.addPolygonLayer({ id: 'c', accessors: rings, clickAction: 'follow' }), TypeError)
  ;['a', 'b', 'c'].forEach(id => assert.equal(engine.getLayer(id), null))
  engine.destroy()
})

test('sin interactive avisa una vez y no se suscribe', async () => {
  const { engine, container, espiar } = montar()
  const panTo = espiar('panTo')
  const aviso = mock.method(console, 'warn', () => {})
  try {
    engine.addPointLayer({ id: 'flota', accessors: puntos, data: [{ id: 'a', lat: 5, lng: 6 }], clickAction: 'fit', iconSet: makeIconSet() })
    assert.equal(aviso.mock.callCount(), 1)
    assert.match(aviso.mock.calls[0].arguments[0], /sin interactive/)
    await clickear(container)
    assert.equal(panTo.mock.callCount(), 0)
  } finally { aviso.mock.restore() }
  engine.destroy()
})
