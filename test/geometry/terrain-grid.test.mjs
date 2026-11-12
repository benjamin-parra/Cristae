// La marca GRID del terreno: la grilla que cargó, para quien dibuja el mismo terreno. Y que los entries no
// exportan la marca ni la opción interna de la caché.
// Corre con: node --test test/geometry/terrain-grid.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { terrain, relief, elevation } from '../../src/geometry/terrain.js'
import { GRID } from '../../src/geometry/geodesic.js'
import * as geometry from '../../src/geometry/index.js'
import { latDe, lngDe, mundo, terrariumDe } from '../../test-helpers/terreno.mjs'

const FUENTE = { url: 'https://t.test/{z}/{x}/{y}.png', encoding: 'terrarium', zoom: 14, tileSize: 64 }
const PX     = 4869 * 64 + 20
const PY     = 10007 * 64 + 20
const CAJA   = { south: latDe(PY + 30), west: lngDe(PX - 10), north: latDe(PY - 30), east: lngDe(PX + 40) }

test('GRID es Symbol.for(cristae.geometry.grid) y trae la grilla, congelada', async () => {
  assert.equal(GRID, Symbol.for('cristae.geometry.grid'))
  const t = await terrain(FUENTE, CAJA, { fetch: mundo({ h: lat => 100 + 1000 * lat }).fetch })
  const g = t[GRID]
  assert.ok(Object.isFrozen(g))
  assert.deepEqual(Object.keys(g), ['heights', 'W', 'H', 'px0', 'py0', 'N', 'size', 'zoom', 'ew', 'ns'])
  assert.equal(g.N, 64 * 2 ** 14)
  assert.equal(g.size, 64)
  assert.equal(g.zoom, 14)
  assert.ok(g.heights instanceof Float32Array && g.heights.length === g.W * g.H)
  assert.equal(g.ew.length, g.H)
  assert.equal(g.ns.length, g.H)
})

test('GRID coincide con la grilla, ew y ns de las mismas filas', async () => {
  const t = await terrain(FUENTE, CAJA, { fetch: mundo({ h: (lat, lng) => 500 + 200 * lat + 100 * lng }).fetch })
  const { heights, W, H, px0, py0, N, ew, ns } = t[GRID]
  assert.equal(px0, PX - 10 - 2)
  // Un píxel interior vale lo que el terreno lee en su centro.
  const i = Math.floor(W / 2)
  const j = Math.floor(H / 2)
  const lat = latDe(py0 + j + 0.5, N)
  const lng = lngDe(px0 + i + 0.5, N)
  assert.equal(elevation(t, [lat, lng]), heights[j * W + i])
  assert.ok(Math.abs(heights[j * W + i] - terrariumDe(500 + 200 * lat + 100 * lng)) < 1e-2)
  // ew y ns son los pasos de Horn de la fila: ancho de dos celdas y alto de dos, positivos y finitos.
  for (let r = 0; r < H; r++) assert.ok(ew[r] > 0 && ns[r] > 0 && Number.isFinite(ew[r] + ns[r]))
  assert.ok(Math.abs(ew[j] / ns[j] - 1) < 1e-2, 'Mercator conforme: celdas cuadradas')
  assert.ok(relief(t, [[latDe(PY + 5), lngDe(PX)], [latDe(PY + 5), lngDe(PX + 9)], [latDe(PY - 5), lngDe(PX + 9)]]).cells > 0)
})

test('el entry de geometría no exporta GRID ni TILE_CACHE', () => {
  for (const nombre of ['GRID', 'TILE_CACHE', 'loadHeightTile', 'createHeightTileCache']) assert.ok(!(nombre in geometry), nombre)
})
