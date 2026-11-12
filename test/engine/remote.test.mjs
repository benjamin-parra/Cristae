// Carga por url: resolución del formato (explícito, extensión, Content-Type, detección) y errores clasificados.
// Corre con: node --test test/engine/remote.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { loadRemote } from '../../src/engine/remote.js'
import { RemoteError } from '../../src/data/remote-fetch.js'
import { zip } from '../formats/kml/zip-de-prueba.mjs'
import { PUNTO } from '../formats/shapefile/fixtures.mjs'

const enc = new TextEncoder()
const bytesDe = x => typeof x === 'string' ? enc.encode(x) : x
const falso = (cuerpo, headers = {}) => async () => ({
  ok: true, status: 200,
  headers: { get: k => headers[k.toLowerCase()] ?? null },
  arrayBuffer: async () => { const b = bytesDe(cuerpo); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) },
})

const PUNTOS = readFileSync(new URL('../geojson/corpus/felices/08-feature-collection.geojson', import.meta.url))
const KML = readFileSync(new URL('../formats/kml/corpus/felices/punto-documento.kml', import.meta.url))

test('GeoJSON por extensión, con y sin query', async () => {
  for (const url of ['/d/flota.geojson', '/d/flota.json?v=3#x']) {
    const r = await loadRemote(url, { fetch: falso(PUNTOS) })
    assert.equal(r.format, 'geojson')
    assert.equal(r.read.featureCount, 2)
  }
})

test('KML por extensión y por format explícito', async () => {
  assert.equal((await loadRemote('/d/a.kml', { fetch: falso(KML) })).format, 'kml')
  const r = await loadRemote('/api/exportar', { format: 'kml', fetch: falso(KML) })
  assert.equal(r.format, 'kml')
  assert.ok(r.read.featureCount >= 1)
})

test('el format explícito gana a la extensión', async () => {
  const r = await loadRemote('/d/a.json', { format: 'kml', fetch: falso(KML) })
  assert.equal(r.format, 'kml')
})

test('Content-Type cuando no hay extensión', async () => {
  const r = await loadRemote('/api/x', { fetch: falso(KML, { 'content-type': 'application/vnd.google-earth.kml+xml; charset=utf-8' }) })
  assert.equal(r.format, 'kml')
  const g = await loadRemote('/api/x', { fetch: falso(PUNTOS, { 'content-type': 'application/geo+json' }) })
  assert.equal(g.format, 'geojson')
})

test('sin extensión ni Content-Type se detecta por los bytes', async () => {
  assert.equal((await loadRemote('/api/x', { fetch: falso(PUNTOS) })).format, 'geojson')
  assert.equal((await loadRemote('/api/x', { fetch: falso(KML, { 'content-type': 'text/plain' }) })).format, 'kml')
})

test('shapefile suelto se lee sin dbf', async () => {
  const r = await loadRemote('/d/a.shp', { fetch: falso(PUNTO) })
  assert.equal(r.format, 'shapefile')
  assert.equal(r.read.featureCount, 1)
})

test('zip con un kml se resuelve como kmz', async () => {
  const z = await zip([['doc.kml', KML, 8]])
  const r = await loadRemote('/d/a.zip', { fetch: falso(z) })
  assert.equal(r.format, 'kmz')
  assert.ok(r.read.featureCount >= 1)
})

test('zip sin shp ni kml es unsupported', async () => {
  const z = await zip([['leeme.txt', enc.encode('hola'), 0]])
  await assert.rejects(loadRemote('/d/a.zip', { fetch: falso(z) }), e => e instanceof RemoteError && e.code === 'unsupported')
})

test('formato no detectable es unsupported', async () => {
  await assert.rejects(loadRemote('/api/x', { fetch: falso('hola mundo') }), e => e.code === 'unsupported')
  await assert.rejects(loadRemote('/api/x', { format: 'inventado', fetch: falso(PUNTOS) }), e => e.code === 'unsupported')
})

test('un 404 es network con status', async () => {
  const fetch = async () => ({ ok: false, status: 404 })
  await assert.rejects(loadRemote('/d/a.geojson', { fetch }), e => e instanceof RemoteError && e.code === 'network' && e.status === 404)
})

test('basura con extensión conocida es format, con code y byte', async () => {
  await assert.rejects(loadRemote('/d/a.geojson', { fetch: falso('{"type": nope') }), e => {
    return e instanceof RemoteError && e.code === 'format' && e.url === '/d/a.geojson' && e.message.startsWith('/d/a.geojson: ')
  })
  await assert.rejects(loadRemote('/d/a.kml', { fetch: falso('<kml><Placemark>') }), e => e.code === 'format')
})

test('el aborto se propaga tal cual', async () => {
  const c = new AbortController()
  const fetch = async () => { c.abort(); throw Object.assign(new Error('abort'), { name: 'AbortError' }) }
  await assert.rejects(loadRemote('/d/a.geojson', { fetch, signal: c.signal }), e => e.name === 'AbortError')
})
