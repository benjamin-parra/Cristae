// Caracterización del FOLD de cluster de MapEngine (addClusterFold): fija su comportamiento OBSERVABLE
// —burbujas + supresión, eventos cluster:expand/update/dismiss/marked, la espiral, y el reindex por
// enabled— antes de extraer ClusterFold a su propio módulo. Es el oráculo de MOVE-EQUIVALENCIA de esa
// extracción: los mismos asserts deben seguir verdes contra el fold extraído. Cubre lo que Cluster.js
// (puro) NO cubre: la orquestación del motor por encima del clustering. Corre con:
//   node --test test/engine/cluster-fold.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { makeGlify, makeIconSet, makeMap, makeLeaflet, installCanvasStub } from '../../test-helpers/engine-stub.mjs'
import { MapEngine } from '../../src/engine/MapEngine.js'

installCanvasStub()

// Cinco puntos MUY juntos cerca de (0,0): a zoom 3 agrupan en UNA burbuja (count 5), pocos para que
// al expandir sean hojas directas (sin sub-clusters: 5 ≤ splitThreshold 16).
const FLOTA = [
  { id: 1, lat: 0,      lng: 0 },
  { id: 2, lat: 0,      lng: 0.0001 },
  { id: 3, lat: 0.0001, lng: 0 },
  { id: 4, lat: 0.0001, lng: 0.0001 },
  { id: 5, lat: 0,      lng: 0.0002 },
]
const accessors = { idOf: v => v.id, positionOf: v => ({ lat: v.lat, lng: v.lng }) }
const orden = a => [...a].sort((x, y) => x - y)

const mount = ({ data = FLOTA, zoom = 3, foldOpts = {} } = {}) => {
  const engine = new MapEngine({ leaflet: makeLeaflet(), glify: makeGlify(), map: makeMap({ zoom }) })
  const host = engine.addPointLayer({ id: 'flota', data, accessors, iconSet: makeIconSet(), interactive: false })
  const fold = engine.addClusterFold([{ id: 'flota' }], { radius: 80, maxZoom: 18, minPoints: 2, ...foldOpts })
  const control = fold.handle.control

  const events = { expand: [], update: [], dismiss: [], marked: [] }
  engine.on('cluster:expand', e => events.expand.push(e))
  engine.on('cluster:update', e => events.update.push(e))
  engine.on('cluster:dismiss', e => events.dismiss.push(e))
  engine.on('cluster:marked', e => events.marked.push(e))

  const spiderId = control.bubbleLayerId.replace(':clusters', ':spider')
  return {
    engine, host, map: engine.getLeafletMap(), fold, control, events,
    bubbles: () => engine.getLayer(control.bubbleLayerId).source.getSnapshot(),
    spider: () => engine.getLayer(spiderId)?.source?.getSnapshot() ?? [],
    suppressed: () => engine.getLayer('flota').suppressed,
  }
}

test('mount: los 5 puntos agrupan en 1 burbuja y quedan suprimidos en el host', () => {
  const { bubbles, suppressed } = mount()
  const bs = bubbles()
  assert.equal(bs.length, 1, 'una sola burbuja')
  assert.equal(bs[0].count, 5, 'con el conteo de la flota')
  assert.deepEqual(orden(suppressed()), [1, 2, 3, 4, 5], 'los 5 suprimidos en el host (se dibujan en la burbuja)')
})

test('expand(burbuja): emite cluster:expand con el payload y despliega las 5 hojas en la espiral', () => {
  const { control, events, bubbles, spider } = mount()
  control.expand(bubbles()[0].id)

  assert.equal(events.expand.length, 1, 'un único cluster:expand')
  const e = events.expand[0]
  assert.equal(e.count, 5, 'count = flota')
  assert.equal(e.entities.length, 5, 'entities = las 5 hojas')
  assert.deepEqual(orden(e.entities.map(x => x.id)), [1, 2, 3, 4, 5], 'con sus ids de dato')
  assert.ok(e.entities.every(x => x.layerId === 'flota'), 'cada entity resuelve a su capa host')
  assert.deepEqual(e.groups, [], 'flota chica: base plano, sin sub-grupos')
  assert.equal(spider().length, 5, 'la espiral proyecta las 5 hojas')
})

test('setMarked: una burbuja con un id marcado oculto emite cluster:marked con su colocación', () => {
  const { control, events } = mount()
  control.setMarked([1])
  assert.equal(events.marked.length, 1, 'un cluster:marked')
  const m = events.marked[0]
  assert.equal(m.hidden.length, 1, 'un oculto')
  assert.equal(m.hidden[0].id, 1, 'el id marcado')
  assert.equal(m.hidden[0].layerId, 'flota', 'con su capa host resuelta')
  assert.ok(m.hidden[0].center, 'y el centro de la burbuja contenedora')
})

test('collapseAll tras expand emite un único cluster:dismiss (reason "collapse")', () => {
  const { control, events, bubbles } = mount()
  control.expand(bubbles()[0].id)
  assert.equal(events.dismiss.length, 0, 'expandido: aún sin dismiss')
  control.collapseAll()
  assert.equal(events.dismiss.length, 1, 'colapsar emite dismiss')
  assert.equal(events.dismiss[0].reason, 'collapse', 'razón collapse')
  assert.equal(events.dismiss[0].id, events.expand[0].id, 'mismo id-ancla que el expand (casa la sesión)')
})

test('un zoomstart del mapa colapsa la sesión abierta y marca el dismiss como "zoom"', () => {
  const { control, events, bubbles, map } = mount()
  control.expand(bubbles()[0].id)
  map.fire('zoomstart')
  assert.equal(events.dismiss.length, 1, 'el zoom colapsa')
  assert.equal(events.dismiss[0].reason, 'zoom', 'razón zoom (no collapse)')
})

test('deshabilitar el único host reindexa el fold: sin hosts vivos no hay burbujas; rehabilitar las restaura', () => {
  const { engine, bubbles } = mount()
  assert.equal(bubbles().length, 1, 'arranca con la burbuja')
  engine.setLayerEnabled('flota', false)
  assert.equal(bubbles().length, 0, 'host deshabilitado ⇒ el cluster reindexa sin sus puntos ⇒ sin burbujas')
  engine.setLayerEnabled('flota', true)
  assert.equal(bubbles().length, 1, 'rehabilitar restaura la burbuja')
})

test('getSession refleja la sesión abierta (paridad imperativa con el evento) y null al colapsar', () => {
  const { control, bubbles } = mount()
  assert.equal(control.getSession(), null, 'sin expansión: null')
  control.expand(bubbles()[0].id)
  const s = control.getSession()
  assert.equal(s.count, 5, 'count de la sesión')
  assert.equal(s.entities.length, 5, 'sus entidades')
  control.collapseAll()
  assert.equal(control.getSession(), null, 'colapsada: null')
})

test('con la sesión abierta, una baja real de un miembro emite cluster:update (no dismiss)', () => {
  const { host, control, events, bubbles } = mount()
  control.expand(bubbles()[0].id)
  assert.equal(events.expand[0].count, 5, 'abre con 5')
  host.remove(5)          // id 5 es el más lejano del centroide → NO es el ancla: encoge sin colapsar
  control.reindex()       // reindex sincrónico lee el snapshot ya reducido (la baja actualiza el store al toque)
  assert.equal(events.dismiss.length, 0, 'una baja parcial NO colapsa la sesión')
  assert.equal(events.update.length, 1, 'emite un cluster:update')
  assert.equal(events.update.at(-1).count, 4, 'con el conteo reducido')
})

// Flota grande en un solo bucket: al expandir, el base se particiona en sub-clusters (count > splitThreshold 16),
// así que el payload trae `groups` (sub-burbujas de la espiral) en vez de hojas directas.
const FLOTA_GRANDE = Array.from({ length: 25 }, (_, i) => ({
  id: 100 + i, lat: (i % 5) * 1e-4, lng: ((i / 5) | 0) * 1e-4,
}))

test('base grande (> splitThreshold): expand particiona en sub-grupos y el payload trae groups', () => {
  const { control, events, bubbles } = mount({ data: FLOTA_GRANDE })
  assert.equal(bubbles()[0].count, 25, 'una burbuja de 25')
  control.expand(bubbles()[0].id)
  const e = events.expand.at(-1)
  assert.equal(e.count, 25, 'count = 25')
  assert.equal(e.entities.length, 25, 'todas las entidades planas')
  assert.ok(e.groups.length >= 2, 'se particiona en ≥2 sub-grupos')
  assert.equal(e.groups.reduce((n, g) => n + g.count, 0), 25, 'los sub-grupos cubren las 25 sin perder ni duplicar')
  assert.ok(e.groups.every(g => g.entities.length === g.count), 'cada sub-grupo trae sus entidades')
})
