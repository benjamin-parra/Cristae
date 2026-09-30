// Navegación de Camera: followBounds encuadra el SUBCONJUNTO de ids (no toda la capa), followPoints/
// focusPoints delega según mode, y el seguimiento sobrevive a lo que no mueve la cámara. El engine-stub
// se importa PRIMERO (instala el shim window/document) — acá reusamos makeMap/makeLeaflet y sólo
// completamos el map con lo que Camera toca en esta ruta (fitBounds/setView/setZoom, con spies de lo que
// asertamos; Camera le pasa a Leaflet la caja como par de esquinas), más una Source REAL de 3 puntos.
import '../../test-helpers/engine-stub.mjs'
import { makeMap, makeLeaflet } from '../../test-helpers/engine-stub.mjs'
import { createSource } from '../../src/data/Source.js'
import { Camera } from '../../src/engine/Camera.js'
import test from 'node:test'
import assert from 'node:assert/strict'

const setup = ({ zoom = 5 } = {}) => {
  const map = makeMap({ zoom })
  const calls = { fitBounds: [], setView: [], setZoom: [] }
  map.fitBounds = (bounds, padding) => { calls.fitBounds.push({ bounds, padding }); return map }
  map.setView = center => { calls.setView.push([center.lat, center.lng]); return map }
  map.setZoom = (z) => { calls.setZoom.push(z); map._zoom = z; return map }

  const L = makeLeaflet()

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
  assert.deepEqual(calls.fitBounds[0].bounds, [[10, 10], [20, 20]])
})

test('followBounds respeta maxZoom cuando el zoom actual lo excede', () => {
  const { camera, calls } = setup({ zoom: 12 })
  camera.followBounds('flota', [1, 2], { maxZoom: 8 })
  assert.deepEqual(calls.setZoom, [8])
})

test('followBounds con ids vacíos no rompe ni mueve la cámara, tampoco el zoom de maxZoom', () => {
  const { camera, calls } = setup({ zoom: 12 })
  camera.followBounds('flota', [], { maxZoom: 8 })
  assert.equal(calls.fitBounds.length, 0)
  assert.deepEqual(calls.setZoom, [], 'sin caja no hay encuadre que acotar')
})

test('fitToLayer sin ninguna posición válida no mueve la cámara, tampoco el zoom de maxZoom', () => {
  const { map, L, calls } = setup({ zoom: 12 })
  const sinLugar = createSource({ idOf: o => o.id, positionOf: o => o.pos })
  sinLugar.set([{ id: 1, pos: { lat: 95, lng: 0 } }])
  new Camera({ map, L, resolveSource: () => sinLugar }).fitToLayer('capa', { maxZoom: 8 })
  assert.equal(calls.fitBounds.length, 0)
  assert.deepEqual(calls.setZoom, [])
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
  assert.deepEqual(calls.fitBounds[0].bounds, [[10, 10], [20, 20]])
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
  assert.deepEqual(calls.fitBounds[0].bounds, [[10, 10], [20, 20]])
})

test('las acciones devuelven this (contrato imperativo)', () => {
  const { camera } = setup()
  assert.equal(camera.followBounds('flota', [1]), camera)
  assert.equal(camera.followPoints('flota', [1]), camera)
  assert.equal(camera.focusPoints('flota', [1]), camera)
})

// Una capa de un punto que se mueve a mano: `mover` cambia la posición y avisa como el Source.
const capaViva = pos => {
  const item   = { id: 1, pos }
  let avisar   = null
  const source = {
    accessors : { positionOf: o => o.pos },
    itemById  : id => (id === item.id ? item : undefined),
    subscribe : cb => { avisar = cb; return () => { avisar = null } },
  }
  return { source, mover: p => { item.pos = p; avisar?.() } }
}

test('lo que no es una caja no corta el seguimiento', () => {
  const { map, L, calls } = setup()
  const { source, mover } = capaViva({ lat: 10, lng: 10 })
  const camera            = new Camera({ map, L, resolveSource: () => source })

  camera.followPoint('flota', 1)
  camera.fitBounds(null)
  camera.fitBounds({ south: 20, west: 0, north: 10, east: 5 })   // invertida
  mover({ lat: 12, lng: 14 })

  assert.equal(calls.fitBounds.length, 0)
  assert.deepEqual(calls.setView, [[10, 10], [12, 14]], 'el follow siguió al punto')
})

test('revealPoint y el seguimiento no enfocan una posición que no es un lugar', () => {
  const { map, L, calls } = setup()
  const { source, mover } = capaViva({ lat: 95, lng: 10 })
  const camera            = new Camera({ map, L, resolveSource: () => source })

  camera.revealPoint('flota', 1)
  camera.followPoint('flota', 1)
  assert.deepEqual(calls.setView, [], 'la latitud 95 no es un lugar')

  mover({ lat: 12, lng: 14 })
  assert.deepEqual(calls.setView, [[12, 14]], 'el follow sigue vivo y centra la primera posición válida')
})
