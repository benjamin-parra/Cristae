// Cargador y caché de tiles de altura (geometry/height-tiles.js), y su uso desde `terrain`: sin red, con el
// `fetch` sintético de test-helpers/terreno.mjs. Con caché, las medidas son las mismas bit a bit.
// Corre con: node --test test/geometry/height-tiles.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadHeightTile, createHeightTileCache, TILE_CACHE, HEIGHT_CACHE_BYTES } from '../../src/geometry/height-tiles.js'
import { terrain, relief, elevation } from '../../src/geometry/terrain.js'
import { distance } from '../../src/geometry/geodesic.js'
import { area } from '../../src/geometry/measure.js'
import { latDe, lngDe, mundo, respuesta } from '../../test-helpers/terreno.mjs'

const FUENTE = { url: 'https://t.test/{z}/{x}/{y}.png', encoding: 'terrarium', zoom: 14, tileSize: 64 }
const h      = (lat, lng) => 800 + 3000 * Math.sin(lat * 40) + 2000 * Math.cos(lng * 30)

const PX   = 4869 * 64 + 20
const PY   = 10007 * 64 + 20
const CAJA = { south: latDe(PY + 30), west: lngDe(PX - 10), north: latDe(PY - 30), east: lngDe(PX + 40) }
const ZONA = [[latDe(PY + 10), lngDe(PX)], [latDe(PY + 10), lngDe(PX + 25)], [latDe(PY - 12), lngDe(PX + 25)], [latDe(PY - 12), lngDe(PX)]]
const A    = [latDe(PY + 5), lngDe(PX + 3)]
const B    = [latDe(PY - 9), lngDe(PX + 20)]

test('HEIGHT_CACHE_BYTES son tres mosaicos de 2048² alturas de 4 B', () => {
  assert.equal(HEIGHT_CACHE_BYTES, 3 * 2048 * 2048 * 4)
})

test('loadHeightTile: el tile como alturas, y null con 404 o 204', async () => {
  const m      = mundo({ h })
  const values = await loadHeightTile(FUENTE, 14, 4869, 10007, { fetch: m.fetch })
  assert.ok(values instanceof Float32Array && values.length === 64 * 64)
  assert.deepEqual(m.urls, ['https://t.test/14/4869/10007.png'])
  const url = 'https://t.test/14/4869/10007.png'
  for (const status of [404, 204])
    assert.equal(await loadHeightTile(FUENTE, 14, 4869, 10007, { fetch: mundo({ estados: { [url]: status } }).fetch }), null)
})

test('loadHeightTile: la x se envuelve y un 401 lanza con status y el mensaje de siempre', async () => {
  const m = mundo()
  await loadHeightTile(FUENTE, 14, -1, 10007, { fetch: m.fetch })
  assert.equal(m.urls[0], 'https://t.test/14/16383/10007.png')
  const url = 'https://t.test/14/4869/10007.png'
  await assert.rejects(loadHeightTile(FUENTE, 14, 4869, 10007, { fetch: mundo({ estados: { [url]: 401 } }).fetch }),
    error => error.status === 401 && error.message === `[terrain] ${url} respondió 401`)
})

test('con caché, relief, area, distance y elevation son iguales bit a bit a los de sin caché', async () => {
  const cache = createHeightTileCache()
  const sin   = await terrain(FUENTE, CAJA, { fetch: mundo({ h }).fetch })
  const con   = await terrain(FUENTE, CAJA, { fetch: mundo({ h }).fetch, [TILE_CACHE]: cache })
  const otra  = await terrain(FUENTE, CAJA, { fetch: mundo({ h }).fetch, [TILE_CACHE]: cache })
  for (const t of [con, otra]) {
    assert.deepEqual(relief(t, ZONA, [5, 10]), relief(sin, ZONA, [5, 10]))
    assert.equal(area(t, ZONA), area(sin, ZONA))
    assert.equal(distance(t, A, B), distance(sin, A, B))
    assert.equal(elevation(t, A), elevation(sin, A))
  }
})

test('un segundo terrain() de la misma caja no hace fetch', async () => {
  const cache = createHeightTileCache()
  const m     = mundo({ h })
  await terrain(FUENTE, CAJA, { fetch: m.fetch, [TILE_CACHE]: cache })
  const pedidos = m.urls.length
  assert.ok(pedidos > 0)
  await terrain(FUENTE, CAJA, { fetch: m.fetch, [TILE_CACHE]: cache })
  assert.equal(m.urls.length, pedidos)
})

test('el 404 se guarda y el error no', async () => {
  const cache = createHeightTileCache()
  const url   = 'https://t.test/14/4869/10007.png'
  const m404  = mundo({ estados: { [url]: 404 } })
  assert.equal(await cache.get(FUENTE, 14, 4869, 10007, { fetch: m404.fetch }), null)
  assert.equal(await cache.get(FUENTE, 14, 4869, 10007, { fetch: m404.fetch }), null)
  assert.equal(m404.urls.length, 1)
  const falla = mundo({ estados: { [url]: 500 } })
  await assert.rejects(cache.get(FUENTE, 14, 4870, 10007, { fetch: () => Promise.resolve(respuesta(500, new Uint8Array(0))) }), { status: 500 })
  const ok = mundo()
  assert.ok((await cache.get(FUENTE, 14, 4870, 10007, { fetch: ok.fetch })) instanceof Float32Array)
  assert.equal(falla.urls.length, 0)
})

test('desalojo por bytes: lo menos usado sale primero, y leer renueva', async () => {
  const unTile = 64 * 64 * 4
  const cache  = createHeightTileCache({ maxBytes: 2 * unTile })
  const m      = mundo()
  const pedir  = x => cache.get(FUENTE, 14, x, 10007, { fetch: m.fetch })
  await pedir(1)
  await pedir(2)
  await pedir(1)
  await pedir(3)
  assert.equal(cache.size, 2)
  assert.equal(cache.bytes, 2 * unTile)
  const antes = m.urls.length
  await pedir(1)
  assert.equal(m.urls.length, antes, 'el 1 se renovó y quedó')
  await pedir(2)
  assert.equal(m.urls.length, antes + 1, 'el 2 se desalojó')
})

test('dos interesados en un tile en vuelo: abortar a uno no aborta el fetch, y abortar a los dos sí', { timeout: 5000 }, async () => {
  const cache  = createHeightTileCache()
  const senales = []
  const fetch  = (url, { signal }) => {
    senales.push(signal)
    return new Promise((_, rechazar) => signal.addEventListener('abort', () => rechazar(signal.reason), { once: true }))
  }
  const c1 = new AbortController()
  const c2 = new AbortController()
  const p1 = cache.get(FUENTE, 14, 4869, 10007, { fetch, signal: c1.signal })
  const p2 = cache.get(FUENTE, 14, 4869, 10007, { fetch, signal: c2.signal })
  assert.equal(senales.length, 1, 'un solo fetch para los dos')
  c1.abort(new Error('uno'))
  await assert.rejects(p1, { message: 'uno' })
  assert.equal(senales[0].aborted, false)
  c2.abort(new Error('dos'))
  await assert.rejects(p2, { message: 'dos' })
  assert.equal(senales[0].aborted, true)

  const real = mundo()
  assert.ok((await cache.get(FUENTE, 14, 4869, 10007, { fetch: real.fetch })) instanceof Float32Array, 'un pedido nuevo no hereda el abortado')
})

test('el tile en vuelo que completa llega a quien no abortó', async () => {
  const cache = createHeightTileCache()
  const m     = mundo()
  const c1    = new AbortController()
  const p1    = cache.get(FUENTE, 14, 4869, 10007, { fetch: m.fetch, signal: c1.signal })
  const p2    = cache.get(FUENTE, 14, 4869, 10007, { fetch: m.fetch })
  c1.abort(new Error('uno'))
  await assert.rejects(p1, { message: 'uno' })
  assert.ok((await p2) instanceof Float32Array)
  assert.equal(m.urls.length, 1)
})
