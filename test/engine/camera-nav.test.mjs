// Navegación MÚLTIPLE de Camera: followBounds encuadra el SUBCONJUNTO de ids (no toda la capa),
// y followPoints/focusPoints delega según mode. El engine-stub se importa PRIMERO (instala el shim
// window/document) — acá sólo reusamos makeMap/makeLeaflet y los completamos con lo que la Camera
// toca (fitBounds/setZoom en el map; latLngBounds en L), más una Source REAL de 3 puntos.
import '../../test-helpers/engine-stub.mjs'
import { makeMap, makeLeaflet } from '../../test-helpers/engine-stub.mjs'
import { createSource } from '../../src/data/Source.js'
import { Camera } from '../../src/engine/Camera.js'
import test from 'node:test'
import assert from 'node:assert/strict'

// latLngBounds mínimo e invertible: extend acumula el rango; isValid = tiene al menos un punto.
const makeBounds = () => {
  let minLat = Infinity, minLng = Infinity, maxLat = -Infinity, maxLng = -Infinity
  return {
    extend([lat, lng]) { minLat = Math.min(minLat, lat); minLng = Math.min(minLng, lng); maxLat = Math.max(maxLat, lat); maxLng = Math.max(maxLng, lng); return this },
    isValid() { return minLat <= maxLat },
    get box() { return { minLat, minLng, maxLat, maxLng } },
  }
}

// Map + L reales del stub, completados con lo que Camera usa en esta ruta y spies de lo que asertamos.
const setup = ({ zoom = 5 } = {}) => {
  const map = makeMap({ zoom })
  const calls = { fitBounds: [], setZoom: [] }
  map.fitBounds = (bounds, padding) => { calls.fitBounds.push({ bounds, padding }); return map }
  map.setView = () => map
  map.setZoom = (z) => { calls.setZoom.push(z); map._zoom = z; return map }

  const L = makeLeaflet()
  L.latLngBounds = () => makeBounds()

  // Source real de 3 puntos con posiciones conocidas.
  const source = createSource({ idOf: (o) => o.id, positionOf: (o) => o.pos })
  source.set([
    { id: 1, pos: { lat: 10, lng: 10 } },
    { id: 2, pos: { lat: 20, lng: 20 } },
    { id: 3, pos: { lat: 90, lng: 90 } },   // el "3ro" que NO debe entrar al encuadre de 2 ids
  ])

  const camera = new Camera({ map, L, resolveSource: () => source })
  return { map, L, source, camera, calls }
}

test('followBounds encuadra SÓLO los ids pedidos (no el resto de la capa)', () => {
  const { camera, calls } = setup()
  camera.followBounds('flota', [1, 2])
  assert.equal(calls.fitBounds.length, 1)
  assert.deepEqual(calls.fitBounds[0].bounds.box, { minLat: 10, minLng: 10, maxLat: 20, maxLng: 20 })
})

test('followBounds respeta maxZoom cuando el zoom actual lo excede', () => {
  const { camera, calls } = setup({ zoom: 12 })
  camera.followBounds('flota', [1, 2], { maxZoom: 8 })
  assert.deepEqual(calls.setZoom, [8])
})

test('followBounds con ids vacíos no rompe ni mueve la cámara', () => {
  const { camera, calls } = setup()
  camera.followBounds('flota', [])
  assert.equal(calls.fitBounds.length, 0)
})

test('followBounds con ids sin posición finita no encuadra', () => {
  const { camera, calls } = setup()
  camera.followBounds('flota', [999])   // id inexistente en la Source
  assert.equal(calls.fitBounds.length, 0)
})

test('followBounds sin capa resuelta es no-op', () => {
  const { map, L } = setup()
  const camera = new Camera({ map, L, resolveSource: () => null })
  assert.equal(camera.followBounds('nope', [1, 2]), camera)   // devuelve this, no rompe
})

test('followPoints mode "fit" (default) encuadra el set (followBounds)', () => {
  const { camera, calls } = setup()
  camera.followPoints('flota', [1, 2])
  assert.equal(calls.fitBounds.length, 1)
  assert.deepEqual(calls.fitBounds[0].bounds.box, { minLat: 10, minLng: 10, maxLat: 20, maxLng: 20 })
})

test('followPoints mode "track" con UN id sigue vivo (followPoint), no encuadra', () => {
  const { camera, calls } = setup()
  camera.followPoints('flota', [2], { mode: 'track' })
  assert.equal(calls.fitBounds.length, 0)   // followPoint hace setView, no fitBounds
  camera.stopFollow()
})

test('followPoints mode "track" con VARIOS ids cae a encuadrar (fit)', () => {
  const { camera, calls } = setup()
  camera.followPoints('flota', [1, 2], { mode: 'track' })
  assert.equal(calls.fitBounds.length, 1)
})

test('focusPoints es alias de followPoints', () => {
  const { camera, calls } = setup()
  camera.focusPoints('flota', [1, 2])
  assert.equal(calls.fitBounds.length, 1)
  assert.deepEqual(calls.fitBounds[0].bounds.box, { minLat: 10, minLng: 10, maxLat: 20, maxLng: 20 })
})

test('las acciones devuelven this (contrato imperativo)', () => {
  const { camera } = setup()
  assert.equal(camera.followBounds('flota', [1]), camera)
  assert.equal(camera.followPoints('flota', [1]), camera)
  assert.equal(camera.focusPoints('flota', [1]), camera)
})
