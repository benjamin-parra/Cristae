// El refresh de una capa por `url` aplica la diferencia: el segundo refresh con un punto movido interpola entre las dos
// lecturas y no reconstruye la capa, y quitar la capa a mitad no deja cuadros pendientes. Cuadros y reloj falsos, el
// fetch de datos-remotos. Corre con: node --test test/engine/refresh-interpolado.test.mjs
import '../../test-helpers/engine-stub.mjs'
import { makeEditGl, makeIconSet } from '../../test-helpers/engine-stub.mjs'
import { conNavegador, crearNavegador } from '../../test-helpers/navegador-falso.mjs'
import { coleccion, fetchFalso, motor, punto } from '../../test-helpers/datos-remotos.mjs'
import { after, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { REFRESH_TWEEN_MS } from '../../src/engine/refresh.js'

const gls = []
after(conNavegador(crearNavegador({ crearGl: () => { const gl = makeEditGl(); gls.push(gl); return gl } })))

const set = makeIconSet()
const pos = (h, id) => { const p = h.source.accessors.positionOf(h.source.itemById(id)); return [p.lat, p.lng] }

// Cuadros a mano: el motor los toma de los globales al dar de alta la capa, así que se instalan sólo durante el alta.
const conCuadros = alta => {
  const rAF = globalThis.requestAnimationFrame, cAF = globalThis.cancelAnimationFrame
  const reloj = { t: 0, cola: new Map(), n: 0 }
  globalThis.requestAnimationFrame = cb => { reloj.cola.set(++reloj.n, cb); return reloj.n }
  globalThis.cancelAnimationFrame  = h => reloj.cola.delete(h)
  try { reloj.resultado = alta() } finally { globalThis.requestAnimationFrame = rAF; globalThis.cancelAnimationFrame = cAF }
  reloj.cuadro = t => {
    reloj.t = t
    const pendientes = [...reloj.cola]
    reloj.cola.clear()
    pendientes.forEach(([, cb]) => cb())
  }
  return reloj
}

const espera = () => new Promise(r => setTimeout(r, 10))

test('el segundo refresh con un punto movido interpola y no reconstruye la capa', async () => {
  const engine = motor()
  const rutas = { 'f.geojson': coleccion([punto(10, 0, { n: 'a' }), punto(20, 0, { n: 'b' })]) }
  const reloj = conCuadros(() => engine.addPointLayer({ id: 'flota', url: 'f.geojson', fetch: fetchFalso(rutas), iconSet: set }))
  const h = reloj.resultado
  const ahora = mock.method(performance, 'now', () => reloj.t)
  try {
    await h.reload()
    await espera()
    const capa = gls.at(-1).spy
    const reconstruidas = capa.bufferDatas.length
    assert.ok(reconstruidas > 0, 'la carga inicial sí construye')
    const parches = capa.bufferSubDatas.length

    rutas['f.geojson'] = coleccion([punto(10, 0, { n: 'a' }), punto(20, 10, { n: 'b' })])   // sólo b se mueve en latitud
    await h.reload()
    await espera()
    assert.deepEqual(pos(h, 1), [0, 20], 'arranca donde estaba')
    assert.equal(reloj.cola.size, 1, 'queda un cuadro de interpolación')

    reloj.cuadro(REFRESH_TWEEN_MS / 2)
    await espera()
    assert.deepEqual(pos(h, 1), [5, 20], 'a mitad de camino')
    assert.deepEqual(pos(h, 0), [0, 10], 'el que no se movió no se toca')

    reloj.cuadro(REFRESH_TWEEN_MS)
    assert.deepEqual(pos(h, 1), [10, 20], 'llega exacto')
    assert.equal(reloj.cola.size, 0, 'y no pide más cuadros')
    await espera()
    assert.equal(capa.bufferDatas.length, reconstruidas, 'ni una reconstrucción')
    assert.ok(capa.bufferSubDatas.length > parches, 'sólo parches del buffer')
  } finally { ahora.mock.restore() }
  engine.destroy()
})

test('removeLayer a mitad de la interpolación no deja cuadros ni timers', async () => {
  const engine = motor()
  const rutas = { 'f.geojson': coleccion([punto(10, 0)]) }
  const reloj = conCuadros(() => engine.addPointLayer({ id: 'flota', url: 'f.geojson', fetch: fetchFalso(rutas), refresh: 60000, iconSet: set }))
  const h = reloj.resultado
  await h.reload()
  rutas['f.geojson'] = coleccion([punto(10, 10)])
  await h.reload()
  assert.equal(reloj.cola.size, 1)
  engine.removeLayer('flota')
  assert.equal(reloj.cola.size, 0, 'el cuadro pendiente se canceló')
  assert.equal(engine.getLayer('flota'), null)
  engine.destroy()
})
