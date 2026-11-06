// `hasContent` de `engine.surfaces()`: una capa tiene contenido si su Source le entrega algún ítem —pasado el `where` o el
// filtro de la capa y ANTES de la supresión del cluster—, haya o no algo que dibujar ahora. Es lo que decide si una capa vale
// un contexto WebGL: un host entero bajo burbujas no está vacío, y el zoom que las deshace le pide el contexto en pleno gesto.
// El mismo criterio vale para puntos, overlays, líneas, polígonos y editores. Corre con:
//   node --test test/engine/superficies-contenido.test.mjs
import '../../test-helpers/engine-stub.mjs'
import { makeIconSet, makeLeaflet, makeMap } from '../../test-helpers/engine-stub.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MapEngine } from '../../src/engine/MapEngine.js'
import { adoptLeafletHost } from '../../src/host/LeafletHost.js'

const flush = () => new Promise(r => setTimeout(r, 5))

const puntos = { idOf: it => it.id, positionOf: it => ({ lat: it.lat, lng: it.lng }) }
const lineas = { idOf: r => r.id, pathOf: r => r.path }
const zonas  = { idOf: z => z.id, ringsOf: z => z.anillos }
const juntos = n => Array.from({ length: n }, (_, i) => ({ id: i + 1, lat: i * 1e-4, lng: i * 1e-4, badge: true }))

const montar = () => new MapEngine({ host: adoptLeafletHost(makeMap(), { leaflet: makeLeaflet() }) })
const tiene  = (engine, id) => engine.surfaces().find(s => s.layerId === id).hasContent

test('puntos: sin ítems no tiene contenido, con ítems sí, y al vaciarla deja de tenerlo', async () => {
  const engine = montar()
  const flota  = engine.addPointLayer({ id: 'flota', accessors: puntos, iconSet: makeIconSet() })
  assert.equal(tiene(engine, 'flota'), false)

  flota.set(juntos(3))
  await flush()
  assert.equal(tiene(engine, 'flota'), true)

  flota.set([])
  await flush()
  assert.equal(tiene(engine, 'flota'), false)
  engine.destroy()
})

test('puntos: cuenta los ítems que pasan el `where` de la capa, y un `where` que los rechaza a todos la deja vacía', async () => {
  const engine = montar()
  const flota  = engine.addPointLayer({ id: 'flota', accessors: puntos, iconSet: makeIconSet(), data: juntos(3), where: () => false })
  await flush()
  assert.equal(tiene(engine, 'flota'), false, 'tres ítems en la Source, ninguno para esta capa')

  flota.setWhere(it => it.id === 2)
  assert.equal(tiene(engine, 'flota'), true)
  engine.destroy()
})

test('puntos: un host entero bajo burbujas tiene contenido aunque no dibuje un solo punto', async () => {
  const engine = montar()
  engine.addPointLayer({ id: 'flota', accessors: puntos, iconSet: makeIconSet(), data: juntos(5) })
  engine.addClusterFold([{ id: 'flota' }], { radius: 80, maxZoom: 18, minPoints: 2 })
  await flush()
  assert.equal(engine.getLayer('flota').suppressed.size, 5, 'el cluster los suprime a todos')
  assert.equal(engine.getLayer('flota').layer.count, 0, 'no hay nada en el buffer')
  assert.equal(tiene(engine, 'flota'), true, 'pero la Source se los entrega, y el zoom que deshaga el cluster los muestra')
  engine.destroy()
})

test('overlays: el badge cuenta lo que pasa su `where` y el del host, antes de la supresión del cluster', async () => {
  const engine = montar()
  const flota  = engine.addPointLayer({ id: 'flota', accessors: puntos, iconSet: makeIconSet(), data: juntos(5) })
  const badge  = engine.addOverlay({ id: 'badge', hostId: 'flota', iconSet: makeIconSet(), where: it => it.id > 9 })
  await flush()
  assert.equal(tiene(engine, 'badge'), false, 'ningún ítem lleva badge')

  badge.setWhere(it => it.id === 3)
  assert.equal(tiene(engine, 'badge'), true)

  flota.setWhere(it => it.id === 1)                  // la membresía del host se compone con la propia: el 3 ya no pasa
  assert.equal(tiene(engine, 'badge'), false)
  flota.setWhere(null)

  engine.addClusterFold([{ id: 'flota' }], { radius: 80, maxZoom: 18, minPoints: 2 })
  await flush()
  assert.equal(badge.layer.count, 0, 'todo clusterizado: el overlay no dibuja nada')
  assert.equal(tiene(engine, 'badge'), true, 'y sigue teniendo contenido')
  engine.destroy()
})

test('líneas: tiene contenido si la Source le entrega algún ítem, tenga o no tramos que dibujar', async () => {
  const engine = montar()
  const rutas  = engine.addLineLayer({ id: 'rutas', accessors: lineas })
  assert.equal(tiene(engine, 'rutas'), false)

  rutas.source.set([{ id: 'r', path: [[0, 0], [0, 1]] }])
  await flush()
  assert.equal(tiene(engine, 'rutas'), true)

  rutas.source.set([{ id: 'vacia', path: [] }])
  await flush()
  assert.equal(tiene(engine, 'rutas'), true, 'un ítem sin recorrido sigue siendo un ítem de la Source')

  rutas.source.set([])
  await flush()
  assert.equal(tiene(engine, 'rutas'), false)
  engine.destroy()
})

test('polígonos: tiene contenido si la Source le entrega algún ítem, tenga o no anillos que dibujar', async () => {
  const engine = montar()
  const zona   = engine.addPolygonLayer({ id: 'zonas', accessors: zonas })
  assert.equal(tiene(engine, 'zonas'), false)

  zona.source.set([{ id: 'z', anillos: [[[0, 0], [0, 1], [1, 1]]] }])
  await flush()
  assert.equal(tiene(engine, 'zonas'), true)

  zona.source.set([{ id: 'sin-anillos', anillos: [] }])
  await flush()
  assert.equal(tiene(engine, 'zonas'), true, 'un ítem sin anillos sigue siendo un ítem de la Source')

  zona.source.set([])
  await flush()
  assert.equal(tiene(engine, 'zonas'), false)
  engine.destroy()
})

test('editores: tienen contenido si su valor tiene vértices, o si están trazando', async () => {
  const engine  = montar()
  const punto   = engine.addEditableLayer({ id: 'punto', kind: 'point', mode: 'edit' })
  const caja    = engine.addEditableLayer({ id: 'caja', kind: 'rectangle', mode: 'edit' })
  const recorre = engine.addEditableLayer({ id: 'recorrido', kind: 'polyline', mode: 'edit' })
  assert.deepEqual(['punto', 'caja', 'recorrido'].map(id => tiene(engine, id)), [false, false, false])

  punto.setValue([1, 2])
  caja.setValue([[0, 0], [1, 1]])
  recorre.setValue([[0, 0], [1, 1]])
  assert.deepEqual(['punto', 'caja', 'recorrido'].map(id => tiene(engine, id)), [true, true, true])

  recorre.setValue([])
  assert.equal(tiene(engine, 'recorrido'), false, 'sin vértices no hay nada que mostrar')
  recorre.setMode('draw')
  assert.equal(tiene(engine, 'recorrido'), true, 'trazando, el editor ya tiene qué dibujar')
  engine.destroy()
})
