// Contrato de PointLayer: qué entra al buffer y cuándo el path incremental cae al rebuild O(n).
// La capa recibe glify/Leaflet POR CONSTRUCTOR, así que se monta en node contra stubs: el GL stub
// sólo tiene que existir (la capa no lee nada de vuelta salvo el buffer de vértices), y el glify
// stub cuenta los setData — que es exactamente la señal del rebuild.
import test from 'node:test'
import assert from 'node:assert/strict'
import { PointLayer } from '../src/render/PointLayer.js'

/* ── Stubs ── */

const makeGl = () => ({
  ARRAY_BUFFER: 1, DYNAMIC_DRAW: 2, TEXTURE_2D: 3, RGBA: 4, UNSIGNED_BYTE: 5, TEXTURE0: 6,
  LINEAR: 7, CLAMP_TO_EDGE: 8, TEXTURE_MIN_FILTER: 9, TEXTURE_MAG_FILTER: 10,
  TEXTURE_WRAP_S: 11, TEXTURE_WRAP_T: 12, CURRENT_PROGRAM: 13,
  createTexture: () => ({}), deleteTexture() {}, bindTexture() {}, texParameteri() {},
  texImage2D() {}, texSubImage2D() {}, activeTexture() {}, getParameter: () => null,
  useProgram() {}, getUniformLocation: () => ({}), uniform1i() {}, uniform1f() {},
  createBuffer: () => ({}), bindBuffer() {}, bufferData() {}, bufferSubData() {},
})

// Cuenta rebuilds (setData) y expone el array de posiciones vivo que la capa mantiene.
const makeGlify = () => {
  const log = { create: 0, setData: 0, redraw: 0, data: null }
  const glify = {
    log,
    points({ data }) {
      log.create++
      log.data = data
      const layer = {
        gl: makeGl(),
        bytes: 7,
        program: {},
        typedVertices: new Float32Array(Math.max(data.length, 1) * 7),
        mapMatrix: { array: new Float32Array(16) },
        mapCenterPixels: { x: 0, y: 0 },
        getBuffer: () => ({}),
        setData(next) {
          log.setData++
          log.data = next
          layer.typedVertices = new Float32Array(Math.max(next.length, 1) * 7)
        },
        layer: { redraw() { log.redraw++ }, _reset() {} },
        remove() {},
      }
      return layer
    },
  }
  return glify
}

const makeIconSet = () => ({
  rotates: true,
  defaultSize: 24,
  atlas: {
    count: 1, cols: 1, rows: 1, tileSize: 2, capacity: 4,
    tileChannel: () => 0,
    cellOf: () => ({ col: 0, row: 0 }),
    tileAt: () => new Uint8Array(2 * 2 * 4),
  },
  resolve: () => 0,
  tileScale: () => 1,
})

const mapStub = { latLngToContainerPoint: () => ({ x: 0, y: 0 }) }

// Source manual: notify SÍNCRONO (sin rAF) y acumuladores controlados por el test, con la misma
// semántica de ventana que la Source de la casa (se limpian tras el emit).
const makeSource = (items, accessors) => {
  const subs = new Set()
  const moveDirty = new Set()
  const structDirty = new Set()
  return {
    accessors,
    getSnapshot: () => items,
    subscribe: (cb) => { subs.add(cb); return () => subs.delete(cb) },
    itemById: (id) => items.find(it => accessors.idOf(it) === id),
    moveDirtyIds: () => moveDirty,
    dirtyIds: () => structDirty,
    emitMove(...ids) { ids.forEach(id => moveDirty.add(id)); this.flush() },
    emitDirty(...ids) { ids.forEach(id => structDirty.add(id)); this.flush() },
    flush() { subs.forEach(cb => cb()); moveDirty.clear(); structDirty.clear() },
  }
}

const idOf = (it) => it.id
const positionOf = (it) => it.pos

const mount = (items, accessors, opts = {}) => {
  const glify = makeGlify()
  const source = makeSource(items, accessors)
  const layer = new PointLayer({ glify, map: mapStub, pane: 'p', source, iconSet: makeIconSet(), ...opts })
  return { glify, source, layer, log: glify.log }
}

/* ── P5: el camino incremental tiene que sobrevivir al cluster ── */

test('P5 — move de un punto SUPRIMIDO por el cluster no dispara rebuild', () => {
  const items = [1, 2, 3, 4, 5].map(id => ({ id, pos: { lat: id, lng: id } }))
  const { source, layer, log } = mount(items, { idOf, positionOf })

  layer.suppressed = new Set([2, 3, 4, 5])
  layer.refresh()
  assert.equal(layer.count, 1, 'sólo el no suprimido queda en el buffer')

  const before = log.setData
  source.emitMove(2)
  source.emitMove(3, 4, 5)
  assert.equal(log.setData, before, 'los moves de clusterizados no rebuildean')
})

test('P5 — move de un punto sin posición finita tampoco dispara rebuild', () => {
  const items = [
    { id: 1, pos: { lat: 1, lng: 1 } },
    { id: 2, pos: { lat: NaN, lng: NaN } },   // sin fix GPS
    { id: 3, pos: null },                      // sin posición
  ]
  const { source, layer, log } = mount(items, { idOf, positionOf })
  assert.equal(layer.count, 1)

  const before = log.setData
  source.emitMove(2)
  source.emitDirty(3)
  assert.equal(log.setData, before)
})

test('P5 — ítem ajeno a la capa (`where`) no dispara rebuild', () => {
  const items = [{ id: 1, pos: { lat: 1, lng: 1 }, badge: true }, { id: 2, pos: { lat: 2, lng: 2 }, badge: false }]
  const { source, layer, log } = mount(items, { idOf, positionOf }, { where: (it) => it.badge })
  assert.equal(layer.count, 1)

  const before = log.setData
  source.emitMove(2)
  source.emitDirty(2)
  assert.equal(log.setData, before)
})

test('P5 — un id DESCONOCIDO sigue cayendo al rebuild (la red de seguridad no se pierde)', () => {
  const items = [{ id: 1, pos: { lat: 1, lng: 1 } }]
  const { source, log } = mount(items, { idOf, positionOf })

  const before = log.setData
  source.emitMove(99)
  assert.equal(log.setData, before + 1, 'id fuera del snapshot → el buffer no está al día → rebuild')
})

test('P5 — el ítem que RECUPERA posición finita vuelve al buffer', () => {
  const items = [{ id: 1, pos: { lat: 1, lng: 1 } }, { id: 2, pos: null }]
  const { source, layer, log } = mount(items, { idOf, positionOf })
  assert.equal(layer.count, 1)

  items[1].pos = { lat: 2, lng: 2 }
  const before = log.setData
  source.emitDirty(2)
  assert.equal(log.setData, before + 1, 'la omisión se reevalúa, no se cachea')
  assert.equal(layer.count, 2)
})

test('P5 — el move de un punto presente sigue siendo incremental', () => {
  const items = [{ id: 1, pos: { lat: 1, lng: 1 } }]
  const { source, log } = mount(items, { idOf, positionOf })

  const before = log.setData
  items[0].pos = { lat: 5, lng: 6 }
  source.emitMove(1)
  assert.equal(log.setData, before, 'sin cambio de membresía no hay setData')
  assert.deepEqual(log.data[0], [5, 6])
})

/* ── El objeto de `positionOf` no se retiene entre callbacks del consumidor ── */

// `variantOf` que mira la posición de OTRO ítem (variante por cercanía): si la capa retuviera el
// objeto de `positionOf`, el scratch del consumidor ya estaría pisado al leerlo.
const scratchAccessors = (items) => {
  const scratch = { lat: 0, lng: 0 }
  const a = {
    idOf,
    positionOf: (it) => { scratch.lat = it.lat; scratch.lng = it.lng; return scratch },
    variantOf: (it) => (a.positionOf(items[items.length - 1]).lat < 0 ? 'sur' : 'norte'),
  }
  return a
}

test('rebuild — `positionOf` que reusa el objeto no intercambia coordenadas', () => {
  const items = [{ id: 1, lat: 10, lng: 20 }, { id: 2, lat: -30, lng: -40 }]
  const { log } = mount(items, scratchAccessors(items))

  assert.deepEqual(log.data[0], [10, 20], 'el punto 1 conserva SU posición')
  assert.deepEqual(log.data[1], [-30, -40])
})

test('writeSlot — `positionOf` que reusa el objeto no contamina el patch', () => {
  const items = [{ id: 1, lat: 10, lng: 20 }, { id: 2, lat: -30, lng: -40 }]
  const { source, log } = mount(items, scratchAccessors(items))

  items[0].lat = 11
  items[0].lng = 21
  source.emitDirty(1)
  assert.deepEqual(log.data[0], [11, 21])
})
