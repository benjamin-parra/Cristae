// La clase de pendiente que calcula el shader, contra la de relief(). El gemelo emula en Math.fround cada
// operación del fragmento (alturas y pasos de fila en float32, el orden de la expresión de eachCell) y su
// clase, por celda de una ventana de 40 × 40, tiene que ser la que da relief() sobre el polígono de esa
// sola celda. Si una celda distinta cae a menos de 2^-20 relativo de un corte, la prueba la lista: es el
// caso donde el paso adopta el respaldo (la clase en CPU con el mismo kernel, subida como R8UI).
// Corre con: node --test test/render/terrain-clases.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { terrain, relief } from '../../src/geometry/terrain.js'
import { GRID } from '../../src/geometry/geodesic.js'
import { claseGemela } from '../../test-helpers/clase-gemela.mjs'
import { latDe, lngDe, mundo, TESELA_REAL, URL_TESELA_REAL } from '../../test-helpers/terreno.mjs'

const R    = 6371008.8
const RAD  = Math.PI / 180
const LADO = 40
const CERCA = 2 ** -20

const FUENTE = { url: 'https://t.test/{z}/{x}/{y}.png', encoding: 'terrarium', zoom: 14, tileSize: 64 }
const REAL   = { url: 'https://t.test/{z}/{x}/{y}.png', encoding: 'terrarium', zoom: 12, tileSize: 256 }
const PX     = 4869 * 64 + 20
const PY     = 10007 * 64 + 20
const LAT0   = latDe(PY + 0.5)
const LNG0   = lngDe(PX + 0.5)

const rect   = (south, west, north, east) => [[south, west], [south, east], [north, east], [north, west]]
const celdas = (x0, y0, x1, y1, n) => rect(latDe(y1, n), lngDe(x0, n), latDe(y0, n), lngDe(x1, n))

const CASOS = [[0.15, 0.3], [0.05, 0.1, 0.2, 0.5], []]

const verifica = async (nombre, fuente, caja, ventana, mundoDe, n) => {
  const t = await terrain(fuente, caja, { fetch: mundoDe.fetch })
  const grid = t[GRID]
  for (const cortes of CASOS) {
    const distintas = []
    let comparadas = 0
    for (let y = ventana.y; y < ventana.y + LADO; y++)
      for (let x = ventana.x; x < ventana.x + LADO; x++) {
        const gemela = claseGemela(grid, x - grid.px0, y - grid.py0, cortes)
        const r      = relief(t, celdas(x, y, x + 1, y + 1, n), cortes)
        const areas  = r.slope.areas
        const k      = areas.findIndex(a => a > 0)
        const esperada = r.cells ? k : -1
        comparadas++
        if (gemela.clase !== esperada) distintas.push({ x, y, gemela: gemela.clase, esperada, p: gemela.p })
      }
    const cercanas = distintas.filter(d => cortes.some(c => Math.abs(d.p - c) <= CERCA * c))
    assert.equal(comparadas, LADO * LADO)
    assert.equal(distintas.length, 0,
      `${nombre} cortes [${cortes}]: ${distintas.length} celdas distintas (${cercanas.length} a menos de 2^-20 de un corte): `
      + JSON.stringify(distintas.slice(0, 5)))
  }
}

const rampaDe = s => mundo({ h: lat => 1000 + s * R * (lat - LAT0) * RAD })
const cajaVentana = (v, n) => ({ south: latDe(v.y + LADO + 1, n), west: lngDe(v.x - 1, n), north: latDe(v.y - 1, n), east: lngDe(v.x + LADO + 1, n) })

for (const s of [0.05, 0.15, 0.167, 0.3])
  test(`rampa de ${s * 100} %: la clase del gemelo es la de relief() en cada celda`, async () => {
    const v = { x: PX, y: PY }
    await verifica(`rampa ${s}`, FUENTE, cajaVentana(v, 64 * 2 ** 14), v, rampaDe(s), 64 * 2 ** 14)
  })

test('un cono: la clase del gemelo es la de relief() en cada celda', async () => {
  const v  = { x: PX, y: PY }
  const k  = 0.4
  const m  = mundo({ h: (lat, lng) => 800 - k * R * Math.hypot((lat - LAT0) * RAD, (lng - LNG0) * RAD * Math.cos(LAT0 * RAD)) })
  await verifica('cono', FUENTE, cajaVentana(v, 64 * 2 ** 14), v, m, 64 * 2 ** 14)
})

test('la tesela de referencia: la clase del gemelo es la de relief() en cada celda', async () => {
  const n = 256 * 2 ** 12
  const v = { x: 1217 * 256 + 100, y: 2501 * 256 + 100 }
  const m = mundo({ bytes: { [URL_TESELA_REAL]: TESELA_REAL } })
  await verifica('tesela real', REAL, cajaVentana(v, n), v, m, n)
})

test('una celda sin dato en su vecindad no tiene clase en el gemelo ni en relief()', async () => {
  const v = { x: PX, y: PY }
  const t = await terrain(FUENTE, cajaVentana(v, 64 * 2 ** 14), { fetch: mundo({ h: lat => 1000 + 0.1 * R * (lat - LAT0) * RAD }).fetch })
  const grid = t[GRID]
  const i = PX - grid.px0 + 5
  const j = PY - grid.py0 + 5
  grid.heights[(j + 1) * grid.W + i + 1] = NaN
  assert.equal(claseGemela(grid, i, j, [0.1]).clase, -1)
  const r = relief(t, celdas(PX + 5, PY + 5, PX + 6, PY + 6, 64 * 2 ** 14), [0.1])
  assert.equal(r.cells, 0)
})
