// Anuncio de deprecación del vocabulario de `tile` y de `noWrap` (sin cambiar comportamiento): una clave fuera de
// las seis que se prometen avisa una vez por página, `worldCopies` del motor equivale a `noWrap` invertido y el
// anfitrión recibe lo mismo que antes.
// Corre con: node --test test/engine/tile-vocabulario.test.mjs
import '../../test-helpers/engine-stub.mjs'
import { makeLeaflet, makeMap } from '../../test-helpers/engine-stub.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { MapEngine } from '../../src/engine/MapEngine.js'
import { adoptLeafletHost } from '../../src/host/LeafletHost.js'
import { TILE_KEYS } from '../../src/tiles/vocabulario.js'

const montar = (options = {}) => {
  const host = adoptLeafletHost(makeMap(), { leaflet: makeLeaflet() })
  const dado = []
  host.tiles.setProvider = tile => { dado.push(tile) }   // se observa lo que llega al anfitrión
  return { engine: new MapEngine({ host, ...options }), dado }
}

const avisar = t => {
  const avisos = []
  t.mock.method(console, 'warn', m => { avisos.push(m) })
  return avisos
}

test('las seis claves prometidas no avisan', t => {
  const avisos = avisar(t)
  const { engine, dado } = montar()
  const tile = { url: 'https://t.test/{s}/{z}/{x}/{y}{r}.png', subdomains: 'abc', minZoom: 1, maxZoom: 20, maxNativeZoom: 18, attribution: 'P' }
  assert.deepEqual(Object.keys(tile), TILE_KEYS)
  engine.setTileProvider(tile)
  engine.setTileProvider('osm')
  engine.setTileProvider('cartoDark')
  assert.deepEqual(avisos, [])
  assert.equal(dado[0], tile, 'el objeto llega tal cual')
  engine.destroy()
})

test('una clave fuera de la lista avisa una vez por clave y por página, y sigue llegando al anfitrión', t => {
  const avisos = avisar(t)
  const a = montar(), b = montar()
  const tile = { url: 'https://t.test/{z}/{x}/{y}.png', tileSize: 512, tms: true }
  a.engine.setTileProvider(tile)
  a.engine.setTileProvider({ ...tile })
  b.engine.setTileProvider({ ...tile, referrerPolicy: 'no-referrer' })
  assert.equal(avisos.length, 3)
  assert.match(avisos[0], /tile\.tileSize está deprecado y se retira con el anfitrión GL.*url, subdomains, minZoom, maxZoom, maxNativeZoom, attribution/)
  assert.match(avisos[1], /tile\.tms /)
  assert.match(avisos[2], /tile\.referrerPolicy /)
  assert.equal(a.dado[0], tile)
  assert.deepEqual(b.dado[0], { ...tile, referrerPolicy: 'no-referrer' })
  a.engine.destroy()
  b.engine.destroy()
})

test('noWrap avisa una vez, nombra worldCopies y pasa tal cual al anfitrión', t => {
  const avisos = avisar(t)
  const { engine, dado } = montar()
  const tile = { url: 'https://t.test/{z}/{x}/{y}.png', noWrap: true }
  engine.setTileProvider(tile)
  engine.setTileProvider({ ...tile, noWrap: false })
  assert.equal(avisos.length, 1)
  assert.match(avisos[0], /tile\.noWrap está deprecado.*worldCopies.*world-copies/)
  assert.equal(dado[0], tile)
  assert.equal(dado[1].noWrap, false)
  engine.destroy()
})

test('worldCopies del motor equivale a noWrap invertido, y sin él el anfitrión no recibe noWrap', t => {
  avisar(t)
  const url = 'https://t.test/{z}/{x}/{y}.png'
  const sin = montar()
  sin.engine.setTileProvider({ url })
  assert.deepEqual(sin.dado, [{ url }], 'por defecto repite: nada que agregar')
  sin.engine.destroy()

  const una = montar({ worldCopies: false })
  una.engine.setTileProvider({ url })
  una.engine.setTileProvider('osm')
  assert.equal(una.dado[0].noWrap, true)
  assert.equal(una.dado[1].noWrap, true)
  una.engine.destroy()

  const repite = montar({ worldCopies: true })
  repite.engine.setTileProvider({ url })
  assert.equal(repite.dado[0].noWrap, false)
  repite.engine.destroy()

  // Contra el reemplazo deprecado: el anfitrión recibe lo mismo con `noWrap: true` que con `worldCopies: false`.
  const viejo = montar()
  viejo.engine.setTileProvider({ noWrap: true, url })
  assert.deepEqual({ ...viejo.dado[0] }, { ...una.dado[0] })
  viejo.engine.destroy()
})

test('el worldCopies de la llamada gana al de las opciones, y un noWrap propio gana a ambos', t => {
  avisar(t)
  const url = 'https://t.test/{z}/{x}/{y}.png'
  const { engine, dado } = montar({ worldCopies: true })
  engine.setTileProvider({ url }, { worldCopies: false })
  engine.setTileProvider({ url, noWrap: true }, { worldCopies: true })
  assert.equal(dado[0].noWrap, true)
  assert.equal(dado[1].noWrap, true)
  engine.destroy()
})

test('un nombre desconocido sigue lanzando TypeError y no avisa por claves', t => {
  const avisos = avisar(t)
  const { engine, dado } = montar({ worldCopies: false })
  assert.throws(() => engine.setTileProvider('x'), TypeError)
  assert.equal(dado.length, 0)
  assert.deepEqual(avisos, [])
  engine.destroy()
})
