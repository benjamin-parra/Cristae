// Contrato de PolygonLayer: reactiva a un Source y con FAST-PATH incremental. La aserción central es
// que un `patch` de UN id sobre un set del mismo tamaño re-estila SÓLO ese `L.polygon` (setStyle),
// sin `clearLayers` ni recreación de los demás — a diferencia del addPolygonLayer imperativo previo.
//
// Se importa el harness PRIMERO (shimea window/document + requestAnimationFrame, que la Source real
// usa para coalescer su emit a rAF). Reusamos makeMap y makeLeaflet del harness; sobre-escribimos
// `layerGroup` y `polygon` por versiones que REGISTRAN setStyle/setLatLngs/clearLayers/addLayer — el
// stub base del harness (pensado para el fold de cluster) no instrumenta esas llamadas.
import { makeMap, makeLeaflet } from '../../test-helpers/engine-stub.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { PolygonLayer } from '../../src/render/PolygonLayer.js'
import { createSource } from '../../src/data/Source.js'

// La Source real emite en rAF (defer:'raf' → setTimeout(0) bajo el shim); un macrotask lo vacía.
const flush = () => new Promise(r => globalThis.setTimeout(r, 0))

// L instrumentado: reusa el harness y sólo cambia layerGroup + polygon para contar las llamadas.
const makeRecordingL = () => {
  const log = { polygons: [], clearLayers: 0, addLayer: 0 }
  return {
    ...makeLeaflet(),
    layerGroup() {
      const g = {
        _layers: [],
        addTo() { return g },
        addLayer(l) { log.addLayer++; g._layers.push(l); return g },
        clearLayers() { log.clearLayers++; g._layers.length = 0; return g },
        remove() {},
      }
      return g
    },
    polygon(latlngs, opts) {
      const p = {
        latlngs, opts,
        styleCalls: 0, latLngCalls: 0, lastStyle: opts,
        setStyle(s) { p.styleCalls++; p.lastStyle = s; return p },
        setLatLngs(ll) { p.latLngCalls++; p.latlngs = ll; return p },
        addTo(g) { g.addLayer(p); return p },
      }
      log.polygons.push(p)
      return p
    },
    log,
  }
}

// Cuadrado unitario centrado en (lat,lng): anillo simple [[lat,lng], ...].
const square = (lat, lng) => [[lat - 1, lng - 1], [lat - 1, lng + 1], [lat + 1, lng + 1], [lat + 1, lng - 1]]

const accessors = {
  idOf: (it) => it.id,
  ringsOf: (it) => it.rings,
  styleOf: (it) => ({ color: it.color, fillColor: it.color, weight: 2 }),
}

// Source MANUAL y síncrono para morder la red de seguridad del fast-path aislada del Store real:
// emite exactamente el trío (snapshot, dirtyIds, itemById) que se quiera, sin rAF ni reindex del Store.
// La Source real nunca produce «id sucio montado pero ausente del Source» a igual cardinalidad (su
// tracking no marca sucio un id que desaparece sin cambiar el tamaño); acá se fuerza a mano para probar
// que `#patch` devuelve false —y deja rebuildear— en vez de estilar sobre un `L.polygon` inexistente.
const makeManualSource = (items) => {
  let snap = items
  let dirty = new Set()
  let byId = new Map(items.map(it => [it.id, it]))
  let notify = () => {}
  return {
    accessors,
    subscribe(cb) { notify = cb; return () => {} },
    getSnapshot: () => snap,
    dirtyIds: () => dirty,
    itemById: (id) => byId.get(id) ?? null,
    // Driver de test: reemplaza el trío y dispara la notificación (síncrona → #onChange corre ya).
    emitir(nextSnap, nextDirty, nextById) { snap = nextSnap; dirty = nextDirty; byId = nextById; notify() },
  }
}

const mount = async () => {
  const L = makeRecordingL()
  const map = makeMap()
  const source = createSource(accessors)
  source.set([
    { id: 'a', color: '#111111', rings: square(0, 0) },
    { id: 'b', color: '#222222', rings: square(10, 10) },
  ])
  await flush()                                          // deja pasar el emit inicial del set()
  const layer = new PolygonLayer({ L, map, pane: 'p', source, interactive: true })
  await flush()                                          // vacía cualquier emit pendiente pre-montaje
  return { L, map, source, layer }
}

test('patch de UN polígono re-estila SÓLO ese L.polygon (no clearLayers, no rebuild de los demás)', async () => {
  const { L, source, layer } = await mount()

  assert.equal(layer.count, 2, 'los 2 polígonos quedaron montados')
  assert.equal(L.log.polygons.length, 2, 'sólo se crearon 2 instancias L.polygon')

  const [pa, pb] = L.log.polygons
  const baseline = { clearLayers: L.log.clearLayers, polys: L.log.polygons.length, sa: pa.styleCalls, sb: pb.styleCalls }

  // Muta el estilo de 'a' y patchea SÓLO su id.
  const snap = source.getSnapshot()
  snap.find(it => it.id === 'a').color = '#ff0000'
  source.patch(snap, new Set(['a']))
  await flush()

  assert.equal(L.log.clearLayers, baseline.clearLayers, 'el patch NO llamó clearLayers')
  assert.equal(L.log.polygons.length, baseline.polys, 'el patch NO creó nuevas instancias L.polygon')
  assert.equal(pa.styleCalls, baseline.sa + 1, "sólo el polígono 'a' se re-estiló")
  assert.equal(pb.styleCalls, baseline.sb, "el polígono 'b' quedó intacto")
  assert.deepEqual(pa.lastStyle, { color: '#ff0000', fillColor: '#ff0000', weight: 2 }, 'el nuevo estilo llegó a setStyle')
})

test('agregar un polígono (cambia el tamaño) cae a rebuild total (clearLayers + recreación)', async () => {
  const { L, source } = await mount()
  const baseClear = L.log.clearLayers
  const baseCreated = L.log.polygons.length

  source.set([
    { id: 'a', color: '#111111', rings: square(0, 0) },
    { id: 'b', color: '#222222', rings: square(10, 10) },
    { id: 'c', color: '#333333', rings: square(20, 20) },
  ])
  await flush()

  assert.equal(L.log.clearLayers, baseClear + 1, 'el cambio de membresía dispara clearLayers')
  assert.equal(L.log.polygons.length, baseCreated + 3, 'rebuild total recreó los 3 polígonos')
})

test('swap de MISMA cardinalidad (quita a, agrega c) cae a rebuild pese a coincidir el tamaño', async () => {
  // El set nuevo tiene el mismo tamaño (2) que el montado, así que #onChange ENTRA al fast-path; la red
  // de seguridad debe detectarlo porque el id sucio 'c' no tiene `L.polygon` montado y forzar rebuild.
  const { L, source, layer } = await mount()
  const baseClear = L.log.clearLayers
  const baseCreated = L.log.polygons.length

  source.set([
    { id: 'b', color: '#222222', rings: square(10, 10) },
    { id: 'c', color: '#333333', rings: square(20, 20) },
  ])
  await flush()

  assert.equal(L.log.clearLayers, baseClear + 1, 'el swap a igual tamaño igual cae a rebuild (clearLayers)')
  assert.equal(L.log.polygons.length, baseCreated + 2, 'rebuild recreó los 2 polígonos del nuevo set')
  assert.equal(layer.count, 2, 'quedan 2 polígonos montados')
  // El picking prueba que el rebuild fue real (no un patch a medias): 'a' desapareció, 'c' entró.
  assert.equal(layer.resolveClick({ latlng: { lat: 0, lng: 0 } }).length, 0, "'a' ya no pica: fue removido")
  assert.deepEqual(layer.resolveClick({ latlng: { lat: 20, lng: 20 } }).map(h => h.id), ['c'], "'c' entró al índice")
})

test('id sucio SIN polígono montado (misma cardinalidad) cae a rebuild, no estila sobre un poly inexistente', () => {
  // Fast-path entrado (tamaño coincide) pero el id sucio no está en #byId → clause `!byId.has(id)`.
  const L = makeRecordingL()
  const source = makeManualSource([
    { id: 'a', color: '#111111', rings: square(0, 0) },
    { id: 'b', color: '#222222', rings: square(10, 10) },
  ])
  const layer = new PolygonLayer({ L, map: makeMap(), pane: 'p', source, interactive: true })
  const baseClear = L.log.clearLayers
  assert.equal(layer.count, 2)

  // Nuevo snapshot de igual tamaño donde 'z' es sucio pero jamás se montó su polígono.
  const z = { id: 'z', color: '#444444', rings: square(30, 30) }
  const b = { id: 'b', color: '#222222', rings: square(10, 10) }
  source.emitir([b, z], new Set(['z']), new Map([['b', b], ['z', z]]))

  assert.equal(L.log.clearLayers, baseClear + 1, 'la red de seguridad forzó rebuild')
  assert.deepEqual(layer.resolveClick({ latlng: { lat: 30, lng: 30 } }).map(h => h.id), ['z'], "'z' quedó montado por el rebuild")
})

test('id sucio MONTADO pero ausente del Source (itemById null) cae a rebuild, no crashea con item null', () => {
  // Fast-path entrado (tamaño coincide) y el id sucio SÍ está en #byId, pero desapareció del Source →
  // clause `itemById(id) == null`. Sin ese guard, `styleOf(null)`/`ringsOf(null)` reventarían.
  const L = makeRecordingL()
  const source = makeManualSource([
    { id: 'a', color: '#111111', rings: square(0, 0) },
    { id: 'b', color: '#222222', rings: square(10, 10) },
  ])
  const layer = new PolygonLayer({ L, map: makeMap(), pane: 'p', source, interactive: true })
  const baseClear = L.log.clearLayers

  // 'a' sigue montado (está en #byId) y se marca sucio, pero el itemById nuevo ya no lo trae.
  const b = { id: 'b', color: '#222222', rings: square(10, 10) }
  const c = { id: 'c', color: '#333333', rings: square(20, 20) }
  assert.doesNotThrow(() =>
    source.emitir([b, c], new Set(['a']), new Map([['b', b], ['c', c]])),
    'el guard evita estilar con item null'
  )

  assert.equal(L.log.clearLayers, baseClear + 1, 'la red de seguridad forzó rebuild')
  assert.equal(layer.count, 2, 'quedó el set nuevo (b, c) tras el rebuild')
  assert.equal(layer.resolveClick({ latlng: { lat: 0, lng: 0 } }).length, 0, "'a' ya no está en el índice")
})

test('refresh() reconstruye desde el snapshot vigente (uso externo, con guard de grupo)', async () => {
  const { L, layer } = await mount()
  const baseClear = L.log.clearLayers
  layer.refresh()
  assert.equal(L.log.clearLayers, baseClear + 1, 'refresh fuerza un rebuild total')
  assert.equal(layer.count, 2, 'el set vigente se remonta')
})

test('resolveClick devuelve el id del polígono que contiene el punto', async () => {
  const { layer } = await mount()

  const inA = layer.resolveClick({ latlng: { lat: 0, lng: 0 } })
  assert.deepEqual(inA.map(h => h.id), ['a'], 'el click dentro de a lo pica')

  const inB = layer.resolveClick({ latlng: { lat: 10, lng: 10 } })
  assert.deepEqual(inB.map(h => h.id), ['b'])

  const outside = layer.resolveClick({ latlng: { lat: 50, lng: 50 } })
  assert.equal(outside.length, 0, 'fuera de todo polígono no pica nada')
})

/* ── Eje focus: atenúa por FEATURE y sobrevive a los ticks de datos ── */

test('applyFocus atenúa sólo los NO enfocados, modulando la opacidad de su estilo', async () => {
  const { L, layer } = await mount()
  const [a, b] = L.log.polygons

  assert.equal(layer.applyFocus(new Set(['a']), 0.25), true, 'declara que resolvió el foco por feature')
  assert.equal(a.lastStyle.opacity, undefined, 'el enfocado conserva su estilo intacto (no se le pisa opacidad)')
  assert.equal(b.lastStyle.opacity, 0.25, 'el resto se atenúa')
  assert.equal(b.lastStyle.fillOpacity, 0.2 * 0.25, 'y también su relleno (default 0.2 de Leaflet)')
  assert.equal(b.lastStyle.color, '#222222', 'conserva el resto del estilo del accessor')

  layer.applyFocus(null)
  assert.equal(b.lastStyle.opacity ?? 1, 1, 'sin foco vuelve a pleno')
})

test('el foco sobrevive a un rebuild sin re-aplicarlo a mano', async () => {
  const { L, source, layer } = await mount()
  layer.applyFocus(new Set(['a']), 0.25)

  source.set([
    { id: 'a', color: '#111111', rings: square(0, 0) },
    { id: 'b', color: '#222222', rings: square(10, 10) },
    { id: 'c', color: '#333333', rings: square(20, 20) },
  ])
  await flush()

  const nuevo = L.log.polygons.at(-1)
  assert.equal(nuevo.opts.opacity, 0.25, 'un feature nuevo nace ya atenuado (el rebuild pliega el foco)')
})
