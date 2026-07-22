// Contrato de LayerRegistry.resolveHits / #present / #resolveParts: el pipeline que corre por
// frame de hover y desambigua qué feature está bajo el puntero. Se ejercita con resolvers FAKE
// (sin Leaflet ni HitResolver real): cada entrada trae su par resolveClick/resolveHover, su
// zIndex, orden de declaración y máscara de canales, igual que las entradas reales del registro.
// Corre con: node --test test/interaction/resolve-hits.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { LayerRegistry } from '../../src/interaction/LayerRegistry.js'
import { EVENT_CLICK, EVENT_HOVER, EVENT_SECONDARY } from '../../src/events/events.js'

// Construye una entrada como la que consume upsertResolver (API pública). Por default la capa es
// visible y sólo demanda hover; los tests que miden gating u orden pisan lo que necesitan.
const entry = ({
  layerId,
  kind = 'test',
  zIndex = 0,
  declOrder = 0,
  activeMask = EVENT_HOVER,
  visible = true,
  resolveClick,
  resolveHover,
  capture,
  presentAs,
}) => ({ layerId, kind, zIndex, declOrder, activeMask, visible, resolveClick, resolveHover, capture, presentAs })

// Resolver fake: devuelve siempre las partes dadas, ignorando el baseEvent.
const parts = (...arr) => () => arr

test('resolveHits ordena top-first: zIndex desc, luego declOrder asc, luego distancePx asc', () => {
  const reg = new LayerRegistry({})
  reg.upsertResolver(entry({ layerId: 'A', zIndex: 10, declOrder: 0, resolveHover: parts({ ref: {}, distancePx: 5 }) }))
  reg.upsertResolver(entry({ layerId: 'B', zIndex: 20, declOrder: 1, resolveHover: parts({ ref: {}, distancePx: 1 }) }))
  reg.upsertResolver(entry({ layerId: 'C', zIndex: 10, declOrder: 1, resolveHover: parts({ ref: {}, distancePx: 2 }) }))

  const hits = reg.resolveHits('hover', {})
  assert.deepEqual(hits.map(h => h.layerId), ['B', 'A', 'C'])
})

test('distancePx desempata las partes de una misma capa; ausente cuenta como infinito (al fondo)', () => {
  const reg = new LayerRegistry({})
  reg.upsertResolver(entry({
    layerId: 'multi', zIndex: 5, declOrder: 0,
    resolveHover: parts(
      { ref: {}, tag: 'lejos', distancePx: 8 },
      { ref: {}, tag: 'sin' },                 // sin distancePx → debe quedar último
      { ref: {}, tag: 'cerca', distancePx: 2 },
    ),
  }))

  const hits = reg.resolveHits('hover', {})
  assert.deepEqual(hits.map(h => h.tag), ['cerca', 'lejos', 'sin'])
  assert.equal(hits[2].distancePx, Number.POSITIVE_INFINITY)
})

test('resolveHits omite las capas no visibles', () => {
  const reg = new LayerRegistry({})
  reg.upsertResolver(entry({ layerId: 'hidden', visible: false, resolveHover: parts({ ref: {}, distancePx: 0 }) }))
  reg.upsertResolver(entry({ layerId: 'shown', declOrder: 1, resolveHover: parts({ ref: {}, distancePx: 0 }) }))

  assert.deepEqual(reg.resolveHits('hover', {}).map(h => h.layerId), ['shown'])
})

test('#resolveParts: hover y click se gatean por su propio bit y usan su propio resolver', () => {
  const reg = new LayerRegistry({})
  reg.upsertResolver(entry({
    layerId: 'L', activeMask: EVENT_CLICK | EVENT_HOVER,
    resolveClick: parts({ ref: {}, tag: 'click' }),
    resolveHover: parts({ ref: {}, tag: 'hover' }),
  }))

  assert.deepEqual(reg.resolveHits('hover', {}).map(h => h.tag), ['hover'])
  assert.deepEqual(reg.resolveHits('click', {}).map(h => h.tag), ['click'])
  // Demanda sin EVENT_SECONDARY → el click contextual no resuelve nada.
  assert.deepEqual(reg.resolveHits('secondary-click', {}), [])
})

test('#resolveParts: secondary-click comparte resolveClick y se gatea por EVENT_SECONDARY', () => {
  const reg = new LayerRegistry({})
  reg.upsertResolver(entry({
    layerId: 'S', activeMask: EVENT_SECONDARY,
    resolveClick: parts({ ref: {}, tag: 'click' }),
    resolveHover: parts({ ref: {}, tag: 'hover' }),
  }))

  assert.deepEqual(reg.resolveHits('secondary-click', {}).map(h => h.tag), ['click'])
  // Sólo EVENT_SECONDARY demandado → ni hover ni click primario resuelven.
  assert.deepEqual(reg.resolveHits('hover', {}), [])
  assert.deepEqual(reg.resolveHits('click', {}), [])
})

test('#resolveParts: un tipo de evento desconocido cae en el canal de hover (default de la tabla)', () => {
  const reg = new LayerRegistry({})
  reg.upsertResolver(entry({
    layerId: 'U', activeMask: EVENT_HOVER,
    resolveClick: parts({ ref: {}, tag: 'click' }),
    resolveHover: parts({ ref: {}, tag: 'hover' }),
  }))

  assert.deepEqual(reg.resolveHits('pointer:move', {}).map(h => h.tag), ['hover'])
  // Un nombre de método heredado como tipo (p.ej. 'toString') NO debe resolver por el prototipo
  // del objeto tabla: cae al default de hover, igual que cualquier otro tipo desconocido.
  assert.deepEqual(reg.resolveHits('toString', {}).map(h => h.tag), ['hover'])
})

test('#present: una capa capture ocluye todo lo que queda debajo de ella', () => {
  const reg = new LayerRegistry({})
  const hit0 = parts({ ref: {}, distancePx: 0 })
  reg.upsertResolver(entry({ layerId: 'top', zIndex: 30, declOrder: 0, resolveHover: hit0 }))
  reg.upsertResolver(entry({ layerId: 'shield', zIndex: 20, declOrder: 1, resolveHover: hit0, capture: true }))
  reg.upsertResolver(entry({ layerId: 'bottom', zIndex: 10, declOrder: 2, resolveHover: hit0 }))

  const hits = reg.resolveHits('hover', {})
  assert.deepEqual(hits.map(h => h.layerId), ['top', 'shield'])   // 'bottom' queda ocluido
})

test('#present: una capa presentAs antepone su hit reetiquetado y ocluye lo de abajo', () => {
  const reg = new LayerRegistry({})
  const hit0 = parts({ ref: {}, distancePx: 0 })
  const proxyHit = (hit) => ({ ...hit, layerId: 'proxy', proxied: true })
  reg.upsertResolver(entry({ layerId: 'top', zIndex: 30, declOrder: 0, resolveHover: hit0 }))
  reg.upsertResolver(entry({ layerId: 'lens', zIndex: 20, declOrder: 1, resolveHover: hit0, presentAs: proxyHit }))
  reg.upsertResolver(entry({ layerId: 'bottom', zIndex: 10, declOrder: 2, resolveHover: hit0 }))

  const hits = reg.resolveHits('hover', {})
  assert.deepEqual(hits.map(h => h.layerId), ['proxy', 'top', 'lens'])
  assert.equal(hits[0].proxied, true)
})

test('hasHitForChannels corta al primer acierto de una capa visible con demanda del canal pedido', () => {
  const reg = new LayerRegistry({})
  reg.upsertResolver(entry({ layerId: 'a', activeMask: EVENT_HOVER, resolveHover: parts() }))
  reg.upsertResolver(entry({ layerId: 'b', declOrder: 1, activeMask: EVENT_CLICK, resolveHover: parts({ ref: {} }) }))

  // Canal CLICK (cursor de affordance): 'b' demanda click y su hover-pick da un hit → true.
  assert.equal(reg.hasHitForChannels(EVENT_CLICK, {}), true)
  // Canal HOVER: 'a' demanda hover pero no da hit; 'b' no demanda hover → false.
  assert.equal(reg.hasHitForChannels(EVENT_HOVER, {}), false)
})
