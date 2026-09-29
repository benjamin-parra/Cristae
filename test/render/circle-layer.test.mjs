// Contrato de CircleLayer: un círculo en metros se pinta con L.circle y el picking CPU point-in-circle
// distingue un latlng DENTRO del radio de uno FUERA. Además la capa es REACTIVA con fast-path
// incremental: consume las DOS clases de suciedad de la Source —structs (dirtyIds, cambios de
// posición/radio/estilo) y moves (moveDirtyIds, reubicaciones O(1) por `source.move()`)— sin recrear
// el L.circle ni rebuildear el grupo. Se monta en node contra el harness compartido (shimea
// window/document + Leaflet + requestAnimationFrame, que la Source real usa para coalescer su emit a
// rAF) — importado PRIMERO —, cuyo `L.circle` ya cuenta sus instancias en `L.log.paths` y sus
// llamadas set* por instancia, que es como se distingue el fast-path del rebuild total. Source REAL
// vía createSource.
import '../../test-helpers/engine-stub.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { makeMap, makeLeaflet } from '../../test-helpers/engine-stub.mjs'
import { createSource } from '../../src/data/Source.js'
import { CircleLayer } from '../../src/render/CircleLayer.js'

// La Source real emite en rAF (defer:'raf' → setTimeout(0) bajo el shim); un macrotask lo vacía.
const flush = () => new Promise(r => globalThis.setTimeout(r, 0))

const accessors = {
  idOf: (d) => d.id,
  positionOf: (d) => ({ lat: d.lat, lng: d.lng }),
  radiusMetersOf: (d) => d.radius,
  styleOf: (d) => ({ color: d.color ?? '#3388ff' }),
}

// Monta la capa sobre L instrumentado con 2 círculos y drena los emits pendientes → baseline limpio.
const mount = async () => {
  const L = makeLeaflet()
  const map = makeMap()
  const source = createSource(accessors)
  source.set([
    { id: 1, lat: 0, lng: 0, radius: 100000, color: '#111111' },   // 100 km en (0,0)
    { id: 2, lat: 10, lng: 10, radius: 50000, color: '#222222' },  // 50 km en (10,10)
  ])
  await flush()
  const layer = new CircleLayer({ L, map, pane: 'p', source, interactive: true })
  await flush()
  return { L, map, source, layer }
}

test('un latlng DENTRO del radio pica; uno FUERA no', () => {
  const L = makeLeaflet()
  const map = makeMap()
  const source = createSource(accessors)
  source.set([{ id: 1, lat: 0, lng: 0, radius: 100000 }])   // 100 km de radio en el (0,0)

  const layer = new CircleLayer({ L, map, pane: 'p', source, interactive: true })

  // (0.5, 0.5) ≈ 78 km del centro → DENTRO
  const dentro = layer.resolveClick({ latlng: { lat: 0.5, lng: 0.5 } })
  assert.equal(dentro.length, 1, 'un latlng dentro del radio debe picar')
  assert.equal(dentro[0].id, 1)
  assert.equal(dentro[0].ref, 1)

  // (2, 2) ≈ 314 km del centro → FUERA
  const fuera = layer.resolveClick({ latlng: { lat: 2, lng: 2 } })
  assert.equal(fuera.length, 0, 'un latlng fuera del radio no debe picar')

  layer.destroy()
})

// `L.circle` pone el borde norte a `radio / Earth.R` radianes del centro, con Earth.R = 6 371 000 m. El
// pick mide con la esfera por defecto de `distance`, a 1,4 ppm de ésa: un milésimo adentro del
// borde pica y un milésimo afuera no. Con el radio ecuatorial, 0,11 % más largo, el de adentro no picaría.
test('el pick coincide con el borde que dibuja L.circle', () => {
  const L = makeLeaflet()
  const map = makeMap()
  const source = createSource(accessors)
  const [lat, lng] = [-33.4489, -70.6693]
  source.set([{ id: 1, lat, lng, radius: 1000 }])
  const layer = new CircleLayer({ L, map, pane: 'p', source, interactive: true })
  const latR  = 1000 / 6371000 * 180 / Math.PI
  const picks = dLat => layer.resolveClick({ latlng: { lat: lat + dLat, lng } }).length

  assert.equal(picks(latR * 0.999), 1, 'un milésimo adentro pica')
  assert.equal(picks(-latR * 0.999), 1, 'también al sur')
  assert.equal(picks(latR * 1.001), 0, 'un milésimo afuera no')

  layer.destroy()
})

// El latlng del puntero llega sin envolver (lng 289 sobre la copia de al lado) y `L.circle` se dibuja
// una sola vez, en la copia de su centro: la distancia es periódica, el dibujo no.
test('sólo pica en la copia del mundo donde el círculo está dibujado', () => {
  const L = makeLeaflet()
  const map = makeMap()
  const source = createSource(accessors)
  source.set([
    { id: 'A', lat: -33.45, lng: -70.66, radius: 5000 },
    { id: 'B', lat: 0, lng: 179.99, radius: 10000 },     // Leaflet lo dibuja hasta pasado el 180
  ])
  const layer = new CircleLayer({ L, map, pane: 'p', source, interactive: true })
  const picks = (lat, lng) => layer.resolveClick({ latlng: { lat, lng } }).map(h => h.id).join()

  assert.equal(picks(-33.45, -70.66), 'A')
  assert.equal(picks(-33.45, -70.66 + 360), '', 'la copia de la derecha no tiene círculo')
  assert.equal(picks(-33.45, -70.66 - 360), '', 'la de la izquierda tampoco')
  assert.equal(picks(0, 180.05), 'B', 'pasado el 180, en la misma copia, sí')
  assert.equal(picks(0, -179.95), '', 'en el borde opuesto del mundo no')

  layer.destroy()
})

// Como en los polígonos: el `interactive: false` de `pathStyle` (render/focus.js) llega al constructor y a
// cada `setStyle`. Cada paso anota [setStyle recibidos, interactive vigente].
test('el L.circle no es interactivo para Leaflet ni al nacer, ni en el patch, ni en el foco', async () => {
  const L      = makeLeaflet()
  const source = createSource({ ...accessors, styleOf: () => ({ interactive: true }) })
  const items  = [{ id: 1, lat: 0, lng: 0, radius: 1000 }, { id: 2, lat: 10, lng: 10, radius: 1000 }]
  source.set(items)
  await flush()
  const layer  = new CircleLayer({ L, map: makeMap(), pane: 'p', source, interactive: true })
  const estado = () => L.log.paths.map(p => [p.setStyleCalls, p.opts.interactive])
  assert.deepEqual(estado(), [[0, false], [0, false]], 'al nacer')
  source.patch(items, new Set([1]))
  await flush()
  assert.deepEqual(estado(), [[1, false], [0, false]], 'el patch reestila sólo el sucio')
  layer.applyFocus(new Set([1]))
  assert.deepEqual(estado(), [[2, false], [1, false]], 'el foco reestila todos')
})

test('patch que reestila (setStyle/setRadius) toca SÓLO ese círculo, sin recrear ni rebuildear', async () => {
  const { L, source } = await mount()
  const baseClear = L.log.clearLayers
  const baseCreated = L.log.paths.length
  const [c1, c2] = L.log.paths

  const snap = source.getSnapshot()
  const it = snap.find(d => d.id === 1)
  it.color = '#ff0000'
  it.radius = 200000
  source.patch(snap, new Set([1]))
  await flush()

  assert.equal(L.log.clearLayers, baseClear, 'el patch NO rebuildeó (sin clearLayers)')
  assert.equal(L.log.paths.length, baseCreated, 'el patch NO creó nuevos L.circle')
  assert.ok(c1.setStyleCalls >= 1, 'el círculo 1 se re-estiló')
  assert.ok(c1.setRadiusCalls >= 1, 'el círculo 1 cambió su radio')
  assert.equal(c1.radius, 200000, 'el nuevo radio llegó a setRadius')
  assert.equal(c1.style.color, '#ff0000', 'el nuevo color llegó a setStyle')
  assert.equal(c2.setStyleCalls, 0, 'el círculo 2 quedó intacto (patch quirúrgico)')
})

// MUERDE el bug 1: source.move() marca moveDirtyIds pero NO dirtyIds; si onChange sólo leyera
// dirtyIds, el centro quedaría clavado y setLatLng nunca se llamaría con la posición nueva.
test('source.move() reubica el centro (setLatLng) — sin recrear, sin retocar radio ni estilo', async () => {
  const { L, source, layer } = await mount()
  const baseClear = L.log.clearLayers
  const baseCreated = L.log.paths.length
  const c1 = L.log.paths[0]
  const styleBefore = c1.setStyleCalls
  const radiusBefore = c1.setRadiusCalls

  source.move(1, 5, 5)
  await flush()

  assert.equal(L.log.clearLayers, baseClear, 'el move NO rebuildeó')
  assert.equal(L.log.paths.length, baseCreated, 'el move NO creó nuevos L.circle')
  assert.ok(c1.setLatLngCalls >= 1, 'el move llamó setLatLng')
  assert.deepEqual(c1.latlng, { lat: 5, lng: 5 }, 'el centro se movió al nuevo latlng (bug 1)')
  assert.equal(c1.setStyleCalls, styleBefore, 'el move no re-estila')
  assert.equal(c1.setRadiusCalls, radiusBefore, 'el move no cambia el radio')

  // El picking CPU sigue al centro movido: (5,5) antes caía FUERA del círculo en (0,0), ahora es su centro.
  const hit = layer.resolveClick({ latlng: { lat: 5, lng: 5 } })
  assert.deepEqual(hit.map(h => h.id), [1], 'el hit CPU sigue al centro movido')
})

test('un ítem que pasa a no-finito no corrompe el círculo (guard: sin setLatLng con NaN)', async () => {
  const { L, source } = await mount()
  const c1 = L.log.paths[0]
  const latLngBefore = c1.latlng
  const callsBefore = c1.setLatLngCalls

  const snap = source.getSnapshot()
  snap.find(d => d.id === 1).lat = NaN
  source.patch(snap, new Set([1]))
  await flush()

  assert.equal(c1.setLatLngCalls, callsBefore, 'no se llamó setLatLng con un centro no-finito')
  assert.deepEqual(c1.latlng, latLngBefore, 'el círculo conservó su último centro finito')
})
