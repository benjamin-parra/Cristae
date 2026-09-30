// Caracteriza la captura de coordenada en un click al VACÍO: cuando `Interaction` procesa un click
// del mapa y el registro NO resuelve ningún hit, invoca el callback inyectado `onEmptyClick(latlng)`.
// Cuando SÍ hay un hit, el click se enruta por el bus y `onEmptyClick` NO corre. Es el camino de
// captura de latlng para el editor de geometría / colocar un punto. Corre con:
//   node --test test/engine/interaction-mapclick.test.mjs
//
// Importa el helper de stubs PRIMERO: instala el shim window/document que la carga del árbol de
// Cristae toca por top-level. Se usan `makeMap` (contenedor + `on`/`fire` + proyección) y el `L` doble
// con el que la cámara construye el LatLng que proyecta.
import { makeLeaflet, makeMap } from '../../test-helpers/engine-stub.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { Camera } from '../../src/engine/Camera.js'
import { Interaction } from '../../src/engine/Interaction.js'

// Registro mínimo: resolveHits devuelve una lista fija (vacía = click al vacío; con un elemento = hit).
// Registra el CANAL con que se lo consultó: el click al vacío debe resolverse por el canal 'click' (no
// 'hover') — si se consultara otro canal, el empty-click dispararía SOBRE features, el bug que este test guarda.
// Guarda también la muestra que recibió, que es la que leen los resolvers de cada capa.
const makeRegistry = (hits) => {
  const channels = []
  const samples  = []
  return { channels, samples, resolveHits: (channel, sample) => { channels.push(channel); samples.push(sample); return hits } }
}

// Bus mínimo: sólo registra los dispatch para poder afirmar que el click SIEMPRE se enruta.
const makeBus = () => {
  const dispatched = []
  return { dispatched, dispatch: (kind, hits, base) => dispatched.push({ kind, hits, base }) }
}

const mount = (hits) => {
  const map = makeMap()
  const bus = makeBus()
  const registry = makeRegistry(hits)
  const calls = []
  const interaction = new Interaction({
    map,
    camera: new Camera({ map, L: makeLeaflet() }),
    registry,
    bus,
    pickLayers: () => [],
    onEmptyClick: (latlng) => calls.push(latlng),
  })
  return { map, bus, calls, registry, interaction }
}

test('click al vacío (sin hits) → onEmptyClick(latlng)', () => {
  const { map, bus, calls, registry } = mount([])
  const latlng = { lat: 12, lng: 34 }

  map.fire('click', { latlng, originalEvent: {} })

  assert.equal(calls.length, 1, 'onEmptyClick se llamó una vez')
  assert.deepEqual(calls[0], latlng, 'recibió el latlng del evento')
  assert.deepEqual(registry.channels, ['click'], 'el vacío se resolvió por el canal click (no otro)')
  // El click igual se enrutó por el bus (comportamiento existente intacto).
  assert.ok(bus.dispatched.some(d => d.kind === 'click'), 'el click se despachó por el bus')
})

test('click sobre una feature (con hit) → onEmptyClick NO se llama', () => {
  const hit = { layerId: 'flota', id: 7 }
  const { map, bus, calls } = mount([hit])

  map.fire('click', { latlng: { lat: 1, lng: 2 }, originalEvent: {} })

  assert.equal(calls.length, 0, 'onEmptyClick no se llama cuando hay hit')
  const click = bus.dispatched.find(d => d.kind === 'click')
  assert.ok(click, 'el click se despachó por el bus')
  assert.deepEqual(click.hits, [hit], 'con el hit resuelto')
})

test('onEmptyClick opcional: sin el callback un click al vacío no rompe', () => {
  const map = makeMap()
  const bus = makeBus()
  const interaction = new Interaction({ map, camera: new Camera({ map, L: makeLeaflet() }), registry: makeRegistry([]), bus, pickLayers: () => [] })

  assert.doesNotThrow(() => map.fire('click', { latlng: { lat: 0, lng: 0 }, originalEvent: {} }))
  assert.ok(bus.dispatched.some(d => d.kind === 'click'), 'el click se despachó igual')
})

// El píxel de este click no es la proyección de su posición: así se ve de dónde sale cada campo.
test('los resolvers reciben la muestra del puntero y el bus, el evento del DOM', () => {
  const { map, bus, registry, calls } = mount([])
  const dom                           = { type: 'click' }

  map.fire('click', { latlng: { lat: 1, lng: 2 }, containerPoint: { x: 5, y: 6 }, originalEvent: dom })
  map.fire('click', { latlng: { lat: 3, lng: 4 } })

  assert.deepEqual(registry.samples, [
    { lat: 1, lng: 2, x: 5, y: 6 },
    { lat: 3, lng: 4, ...map.latLngToContainerPoint({ lat: 3, lng: 4 }) },
  ], 'la posición es la del click; el píxel, el suyo o, si no trae, la proyección de la cámara')
  assert.deepEqual(calls, [{ lat: 1, lng: 2 }, { lat: 3, lng: 4 }])
  assert.deepEqual(bus.dispatched.map(d => d.base), [dom, null], 'un click sin evento del DOM sale con null')
})
