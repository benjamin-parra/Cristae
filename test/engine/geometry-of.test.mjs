// geometryOf(id) en los handles de punto, línea y polígono, y los multipolígonos por url agrupados por parte.
// Corre con: node --test test/engine/geometry-of.test.mjs
import '../../test-helpers/engine-stub.mjs'
import { conGlDeEdicion, makeEditGl, makeIconSet } from '../../test-helpers/engine-stub.mjs'
import { conNavegador, crearNavegador } from '../../test-helpers/navegador-falso.mjs'
import { coleccion, fetchFalso, hasta, motor, punto, traza } from '../../test-helpers/datos-remotos.mjs'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { deflateSync } from 'node:zlib'
import { terrain, relief } from '../../src/geometry/terrain.js'
import { area } from '../../src/geometry/measure.js'
import { tablesFromRings } from '../../src/render/PolygonGpuLayer.js'

after(conNavegador(crearNavegador()))
after(conGlDeEdicion(() => makeEditGl()))

const set = makeIconSet()

// Coordenadas GeoJSON [lng, lat]: un cuadrado de lado `d` grados con esquina suroeste en (lng, lat).
const cuadro = (lng, lat, d) => [[lng, lat], [lng + d, lat], [lng + d, lat + d], [lng, lat + d], [lng, lat]]
const EXT_A = cuadro(-73, -37, 0.004), HUECO = cuadro(-72.999, -36.999, 0.001), EXT_B = cuadro(-72.99, -37, 0.004)
const feature = (geometry, properties = {}) => ({ type: 'Feature', properties, geometry })

const FEATURES = coleccion([
  feature({ type: 'Polygon', coordinates: [EXT_A, HUECO] }, { n: 'simple' }),
  feature({ type: 'MultiPolygon', coordinates: [[EXT_A, HUECO], [EXT_B]] }, { n: 'multi' }),
])

const cargar = async () => {
  const engine = motor()
  const cargas = []
  engine.on('dataload', d => cargas.push(d))
  const handle = engine.addPolygonLayer({ id: 'predios', url: 'predios.geojson', fetch: fetchFalso({ 'predios.geojson': FEATURES }), fields: { id: 'n' } })
  await hasta(() => cargas.length)
  return { engine, handle }
}

test('un polígono por url conserva [exterior, agujeros…] y un multipolígono, las partes anidadas, en [lat, lng]', async () => {
  const { engine, handle } = await cargar()
  const simple = handle.geometryOf('simple')
  const multi  = handle.geometryOf('multi')

  assert.equal(simple.length, 2)
  assert.deepEqual(simple[0][0], [-37, -73], '[lat, lng], no [lng, lat]')
  assert.equal(multi.length, 2, 'dos partes')
  assert.equal(multi[0].length, 2, 'la primera con su agujero')
  assert.equal(multi[1].length, 1, 'la segunda sin agujeros')
  assert.deepEqual(multi[1][0][0], [-37, -72.99])
  engine.destroy()
})

test('la capa dibuja las dos piezas como partes propias, no como un agujero', async () => {
  const { engine, handle } = await cargar()
  const items = handle.source.getSnapshot()
  const tablas = tablesFromRings(items, handle.source.accessors.ringsOf)
  assert.equal(tablas.partCount, 3, 'el simple una parte y el multi dos')
  assert.equal(tablas.ringCount, 5)
  assert.deepEqual([...tablas.owner], [0, 1, 1])
  engine.destroy()
})

test('area() suma las dos piezas con su agujero restado', async () => {
  const { engine, handle } = await cargar()
  const [a, b] = handle.geometryOf('multi')
  const pieza  = p => area(p)
  assert.ok(pieza(a) > 0 && pieza(b) > 0)
  assert.equal(area(handle.geometryOf('multi')), pieza(a) + pieza(b))
  assert.ok(area(handle.geometryOf('simple')) < pieza([a[0]]), 'el agujero resta')
  engine.destroy()
})

// Un PNG Terrarium de 64 × 64 de altura constante 500 m, el mismo para todo tile.
const crc = bytes => {
  let c = ~0
  for (const v of bytes) { c ^= v; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1 }
  return ~c >>> 0
}
const trozo = (tipo, datos) => {
  const out = Buffer.alloc(12 + datos.length)
  out.writeUInt32BE(datos.length, 0)
  out.write(tipo, 4, 'latin1')
  out.set(datos, 8)
  out.writeUInt32BE(crc(out.subarray(4, 8 + datos.length)), 8 + datos.length)
  return out
}
const planoPng = () => {
  const lado = 64, raw = Buffer.alloc(lado * (1 + lado * 3))
  for (let y = 0; y < lado; y++) for (let x = 0; x < lado; x++) raw.set([129, 244, 0], y * (1 + lado * 3) + 1 + x * 3)
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(lado, 0)
  ihdr.writeUInt32BE(lado, 4)
  ihdr.set([8, 2, 0, 0, 0], 8)
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), trozo('IHDR', ihdr),
    trozo('IDAT', deflateSync(raw)), trozo('IEND', Buffer.alloc(0))])
}

test('relief() sobre lo que devuelve geometryOf mide las dos piezas', async () => {
  const { engine, handle } = await cargar()
  const png   = planoPng()
  const fetch = async () => ({ ok: true, status: 200, arrayBuffer: async () => png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) })
  const fuente = { url: 'https://t.test/{z}/{x}/{y}.png', encoding: 'terrarium', zoom: 14, tileSize: 64 }
  const t = await terrain(fuente, { south: -37.01, west: -73.01, north: -36.98, east: -72.97 }, { fetch })
  const [a, b] = handle.geometryOf('multi')
  const total  = relief(t, handle.geometryOf('multi'))
  const ra = relief(t, a), rb = relief(t, b)
  assert.ok(total.cells > 0, 'el relieve cuenta celdas')
  assert.equal(total.cells, ra.cells + rb.cells, 'las dos piezas suman, no se restan')
  engine.destroy()
})

test('punto y línea: [lat, lng] de positionOf y el path de pathOf', async () => {
  const engine = motor()
  const cargas = []
  engine.on('dataload', d => cargas.push(d))
  const fetch = fetchFalso({
    'flota.geojson' : coleccion([punto(-70, -33, { n: 'a' })]),
    'rutas.geojson' : coleccion([traza([[-70, -33], [-71, -34]], { n: 'r' })]),
  })
  const p = engine.addPointLayer({ id: 'flota', url: 'flota.geojson', fetch, iconSet: set, fields: { id: 'n' } })
  const l = engine.addLineLayer({ id: 'rutas', url: 'rutas.geojson', fetch, fields: { id: 'n' } })
  await hasta(() => cargas.length === 2)

  assert.deepEqual(p.geometryOf('a'), [-33, -70])
  assert.deepEqual(l.geometryOf('r'), [[[-33, -70], [-34, -71]]])
  assert.equal(p.geometryOf('no-existe'), null)
  assert.equal(l.geometryOf('no-existe'), null)
  engine.destroy()
})

test('la ruta geometry no tiene Source: geometryOf da null', () => {
  const engine = motor()
  const h = engine.addPolygonLayer({ id: 'z', geometry: tablesFromRings([{}], () => [[0, 0], [0, 1], [1, 1], [0, 0]]) })
  assert.equal(h.geometryOf('z'), null)
  engine.destroy()
})
