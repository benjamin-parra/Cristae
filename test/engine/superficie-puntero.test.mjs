// Fuera de la superficie (`Interaction`): un píxel que la cámara dice que no toca la superficie —fuera
// del disco del globo, o en el cielo con inclinación— no emite `pointer:move`, su click no resuelve hits
// ni despacha `click` ni llama a `onEmptyClick`, y un hover vigente se cierra como al salir del mapa. Sobre
// Leaflet todo píxel toca la superficie y nada cambia. Corre con:
//   node --test test/engine/superficie-puntero.test.mjs
//
// Importa el helper de stubs PRIMERO: instala el shim window/document que la carga del árbol toca.
import { makeLeaflet, makeMap } from '../../test-helpers/engine-stub.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { Interaction } from '../../src/engine/Interaction.js'
import { adoptLeafletHost } from '../../src/host/LeafletHost.js'

// Desde este x el píxel no toca la superficie (el borde del disco de la cámara doble).
const X_SIN_SUPERFICIE = 400

const makeRegistry = () => {
  const channels = []
  return { channels, resolveHits: channel => { channels.push(channel); return [] }, hasHitForChannels: () => false }
}

const makeBus = () => {
  const dispatched = []
  return { dispatched, dispatch: (kind, hits, base) => dispatched.push({ kind, hits, base }) }
}

const mount = ({ conSuperficie = true } = {}) => {
  const map       = makeMap()
  const container = map.getContainer()
  const bus       = makeBus()
  const registry  = makeRegistry()
  const calls     = []
  const host      = adoptLeafletHost(map, { leaflet: makeLeaflet() })
  const camera    = {
    containerPointToLatLng: ({ x, y }) => ({ lat: y, lng: x, onSurface: !conSuperficie || x <= X_SIN_SUPERFICIE, altitude: 0 }),
  }
  const puerta    = new Interaction({
    host, camera, registry, bus, pickLayers: () => [],
    onEmptyClick: latlng => calls.push(latlng),
  })
  return { container, bus, registry, calls, puerta }
}

const emitir  = (esc, tipo, x, y) => esc.container.emitir(tipo, { clientX: x, clientY: y })
const kinds   = (esc, kind) => esc.bus.dispatched.filter(d => d.kind === kind)
const pulsar  = (esc, x, y) => { emitir(esc, 'pointerdown', x, y); emitir(esc, 'pointerup', x, y) }

test('un movimiento sin superficie no emite pointer:move; con superficie sí', () => {
  const esc = mount()
  emitir(esc, 'pointermove', 500, 10)
  assert.equal(kinds(esc, 'pointer:move').length, 0)
  emitir(esc, 'pointermove', 100, 10)
  assert.deepEqual(kinds(esc, 'pointer:move').map(d => [d.base.x, d.base.y]), [[100, 10]])
})

test('una pulsación quieta sin superficie no emite click, ni onEmptyClick, ni resuelve hits', () => {
  const esc = mount()
  pulsar(esc, 500, 10)
  assert.equal(kinds(esc, 'click').length, 0)
  assert.deepEqual(esc.calls, [])
  assert.deepEqual(esc.registry.channels, [])
  pulsar(esc, 100, 10)
  assert.equal(kinds(esc, 'click').length, 1, 'con superficie el click sale')
  assert.deepEqual(esc.calls, [{ lat: 10, lng: 100 }])
})

test('el hover vigente se cierra una sola vez al cruzar a un píxel sin superficie', () => {
  const esc = mount()
  emitir(esc, 'pointermove', 100, 10)
  emitir(esc, 'pointermove', 500, 10)
  emitir(esc, 'pointermove', 510, 10)
  emitir(esc, 'pointermove', 520, 10)
  assert.equal(kinds(esc, 'hover:out').length, 1)
  emitir(esc, 'pointermove', 100, 10)
  emitir(esc, 'pointermove', 500, 10)
  assert.equal(kinds(esc, 'hover:out').length, 2, 'una nueva salida cierra de nuevo')
})

test('el click secundario sin superficie se despacha con hits vacíos', () => {
  const esc = mount()
  esc.container.emitir('contextmenu', { clientX: 500, clientY: 10 })
  assert.deepEqual(kinds(esc, 'secondary-click').map(d => d.hits), [[]])
  assert.deepEqual(esc.registry.channels, [])
})

test('con onSurface true en todo, nada cambia: no hay hover:out ni se pierde ningún evento', () => {
  const esc = mount({ conSuperficie: false })
  emitir(esc, 'pointermove', 500, 10)
  pulsar(esc, 500, 10)
  assert.equal(kinds(esc, 'pointer:move').length, 1)
  assert.equal(kinds(esc, 'hover:out').length, 0)
  assert.equal(kinds(esc, 'click').length, 1)
  assert.deepEqual(esc.calls, [{ lat: 10, lng: 500 }])
})
