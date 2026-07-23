// Contrato de CircleLayer: un círculo en metros se pinta con L.circle y el picking CPU point-in-circle
// distingue un latlng DENTRO del radio de uno FUERA. Además la capa es REACTIVA con fast-path
// incremental: consume las DOS clases de suciedad de la Source —structs (dirtyIds, cambios de
// posición/radio/estilo) y moves (moveDirtyIds, reubicaciones O(1) por `source.move()`)— sin recrear
// el L.circle ni rebuildear el grupo. Se monta en node contra el harness compartido (shimea
// window/document + Leaflet + requestAnimationFrame, que la Source real usa para coalescer su emit a
// rAF) — importado PRIMERO — al que se le añade el único factory que le falta: `L.circle` (el harness
// cubre polyline/polygon, no circle). Source REAL vía createSource.
import '../../test-helpers/engine-stub.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { makeMap, makeLeaflet } from '../../test-helpers/engine-stub.mjs'
import { createSource } from '../../src/data/Source.js'
import { CircleLayer } from '../../src/render/CircleLayer.js'

// La Source real emite en rAF (defer:'raf' → setTimeout(0) bajo el shim); un macrotask lo vacía.
const flush = () => new Promise(r => globalThis.setTimeout(r, 0))

// L.circle stub liviano: recuerda centro/radio/estilo y responde a set*/getters. Sirve al test de
// picking, que sólo necesita construir la capa y leer hits.
const withCircle = () => {
  const L = makeLeaflet()
  L.circle = (latlng, opts = {}) => {
    const c = {
      _latlng: latlng, _radius: opts.radius, _style: { ...opts },
      setLatLng(ll) { c._latlng = ll; return c },
      setRadius(r) { c._radius = r; return c },
      setStyle(s) { Object.assign(c._style, s); return c },
      getLatLng: () => c._latlng,
      getRadius: () => c._radius,
      addTo(g) { g.addLayer?.(c); return c },
      remove() {},
    }
    return c
  }
  return L
}

// L instrumentado: cuenta clearLayers (¿rebuild?), instancias creadas (¿recreación?) y las llamadas
// set* de cada círculo, para distinguir el fast-path incremental del rebuild total.
const makeRecordingL = () => {
  const log = { created: [], clearLayers: 0 }
  const L = {
    ...makeLeaflet(),
    layerGroup() {
      const g = {
        _layers: [],
        addTo() { return g },
        addLayer(l) { g._layers.push(l); return g },
        clearLayers() { log.clearLayers++; g._layers.length = 0; return g },
        remove() {},
      }
      return g
    },
    circle(latlng, opts = {}) {
      const c = {
        _latlng: latlng, _radius: opts.radius, _style: { ...opts },
        setLatLngCalls: 0, setRadiusCalls: 0, setStyleCalls: 0,
        setLatLng(ll) { c.setLatLngCalls++; c._latlng = ll; return c },
        setRadius(r) { c.setRadiusCalls++; c._radius = r; return c },
        setStyle(s) { c.setStyleCalls++; Object.assign(c._style, s); return c },
        getLatLng: () => c._latlng,
        getRadius: () => c._radius,
        addTo(g) { g.addLayer?.(c); return c },
        remove() {},
      }
      log.created.push(c)
      return c
    },
    log,
  }
  return L
}

const accessors = {
  idOf: (d) => d.id,
  positionOf: (d) => ({ lat: d.lat, lng: d.lng }),
  radiusMetersOf: (d) => d.radius,
  styleOf: (d) => ({ color: d.color ?? '#3388ff' }),
}

// Monta la capa sobre L instrumentado con 2 círculos y drena los emits pendientes → baseline limpio.
const mount = async () => {
  const L = makeRecordingL()
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
  const L = withCircle()
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

test('patch que reestila (setStyle/setRadius) toca SÓLO ese círculo, sin recrear ni rebuildear', async () => {
  const { L, source } = await mount()
  const baseClear = L.log.clearLayers
  const baseCreated = L.log.created.length
  const [c1, c2] = L.log.created

  const snap = source.getSnapshot()
  const it = snap.find(d => d.id === 1)
  it.color = '#ff0000'
  it.radius = 200000
  source.patch(snap, new Set([1]))
  await flush()

  assert.equal(L.log.clearLayers, baseClear, 'el patch NO rebuildeó (sin clearLayers)')
  assert.equal(L.log.created.length, baseCreated, 'el patch NO creó nuevos L.circle')
  assert.ok(c1.setStyleCalls >= 1, 'el círculo 1 se re-estiló')
  assert.ok(c1.setRadiusCalls >= 1, 'el círculo 1 cambió su radio')
  assert.equal(c1._radius, 200000, 'el nuevo radio llegó a setRadius')
  assert.equal(c1._style.color, '#ff0000', 'el nuevo color llegó a setStyle')
  assert.equal(c2.setStyleCalls, 0, 'el círculo 2 quedó intacto (patch quirúrgico)')
})

// MUERDE el bug 1: source.move() marca moveDirtyIds pero NO dirtyIds; si onChange sólo leyera
// dirtyIds, el centro quedaría clavado y setLatLng nunca se llamaría con la posición nueva.
test('source.move() reubica el centro (setLatLng) — sin recrear, sin retocar radio ni estilo', async () => {
  const { L, source, layer } = await mount()
  const baseClear = L.log.clearLayers
  const baseCreated = L.log.created.length
  const c1 = L.log.created[0]
  const styleBefore = c1.setStyleCalls
  const radiusBefore = c1.setRadiusCalls

  source.move(1, 5, 5)
  await flush()

  assert.equal(L.log.clearLayers, baseClear, 'el move NO rebuildeó')
  assert.equal(L.log.created.length, baseCreated, 'el move NO creó nuevos L.circle')
  assert.ok(c1.setLatLngCalls >= 1, 'el move llamó setLatLng')
  assert.deepEqual(c1._latlng, [5, 5], 'el centro se movió al nuevo latlng (bug 1)')
  assert.equal(c1.setStyleCalls, styleBefore, 'el move no re-estila')
  assert.equal(c1.setRadiusCalls, radiusBefore, 'el move no cambia el radio')

  // El picking CPU sigue al centro movido: (5,5) antes caía FUERA del círculo en (0,0), ahora es su centro.
  const hit = layer.resolveClick({ latlng: { lat: 5, lng: 5 } })
  assert.deepEqual(hit.map(h => h.id), [1], 'el hit CPU sigue al centro movido')
})

test('un ítem que pasa a no-finito no corrompe el círculo (guard: sin setLatLng con NaN)', async () => {
  const { L, source } = await mount()
  const c1 = L.log.created[0]
  const latLngBefore = c1._latlng
  const callsBefore = c1.setLatLngCalls

  const snap = source.getSnapshot()
  snap.find(d => d.id === 1).lat = NaN
  source.patch(snap, new Set([1]))
  await flush()

  assert.equal(c1.setLatLngCalls, callsBefore, 'no se llamó setLatLng con un centro no-finito')
  assert.deepEqual(c1._latlng, latLngBefore, 'el círculo conservó su último centro finito')
})
