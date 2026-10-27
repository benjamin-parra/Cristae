// El lado máximo de textura del realm (`glBudget.maxTexture`), que se mide con el primer contexto, es el tope de una capa que
// todavía no tuvo contexto: una vacía diferida arma su store en CPU contra él, y lo que no cabe lanza ya, como con contexto.
// Y una capa de polígonos vacía que recibe geometría pide su contexto en esa tarea. Archivo propio: el realm mide su tope
// una sola vez por proceso, y acá el primer contexto declara uno chico.
// Corre con: node --test test/render/tope-del-realm.test.mjs
import '../../test-helpers/engine-stub.mjs'
import { makeEditGl, makeLeaflet, makeMap, makePickSpy } from '../../test-helpers/engine-stub.mjs'
import { conNavegador, crearNavegador } from '../../test-helpers/navegador-falso.mjs'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { adoptLeafletHost } from '../../src/host/LeafletHost.js'
import { LineGpuLayer } from '../../src/render/LineGpuLayer.js'
import { PolygonGpuLayer } from '../../src/render/PolygonGpuLayer.js'
import { glBudget } from '../../src/render/gl-budget.js'

const TOPE             = 16
const MAX_TEXTURE_SIZE = 0x0D33
const conTope = gl => new Proxy(gl, {
  get: (t, p) => (p === 'MAX_TEXTURE_SIZE' ? MAX_TEXTURE_SIZE
    : p === 'getParameter' ? q => (q === MAX_TEXTURE_SIZE ? TOPE : t.getParameter(q))
    : t[p]),
})

const navegador = crearNavegador({ crearGl: canvas => conTope(makeEditGl(makePickSpy(), canvas)) })
const soltar    = conNavegador(navegador)
const capas     = []
after(() => {
  capas.forEach(c => c.destroy())
  soltar()
})

const host     = () => adoptLeafletHost(makeMap(), { leaflet: makeLeaflet() })
const cuadrado = (lng, lat, r) => [[lng - r, lat - r], [lng + r, lat - r], [lng + r, lat + r], [lng - r, lat + r], [lng - r, lat - r]]
const tablas   = anillos => {
  const xy = [], vertexAt = [0]
  anillos.forEach(a => {
    a.forEach(([lng, lat]) => xy.push(lng, lat))
    vertexAt.push(xy.length / 2)
  })
  return {
    xy        : Float64Array.from(xy),
    vertexAt  : Uint32Array.from(vertexAt),
    ringAt    : Uint32Array.from(anillos.map((_, i) => i).concat(anillos.length)),
    closed    : Uint8Array.from(anillos.map(() => 1)),
    ringCount : anillos.length,
    partCount : anillos.length,
  }
}
const poligonos = (geometry = tablas([])) => {
  const capa = new PolygonGpuLayer({ host: host(), pane: `p${capas.length}`, geometry })
  capas.push(capa)
  return capa
}

test('el primer contexto del realm fija el tope', () => {
  const viva = poligonos(tablas([cuadrado(0, 0, 0.05)]))
  assert.equal(viva.surface.state, 'live')
  assert.equal(glBudget.maxTexture, TOPE)
})

test('una capa de polígonos que nunca tuvo contexto se dimensiona con el tope del realm', () => {
  const vacia = poligonos()
  assert.equal(vacia.surface.state, 'none')
  assert.equal(vacia.maxVertices, TOPE ** 2)
})

test('una capa de polígonos vacía que recibe geometría toma su contexto en esa tarea y la sube', () => {
  const vacia = poligonos()
  assert.equal(vacia.surface.state, 'none')
  vacia.setGeometry(tablas([cuadrado(0, 0, 0.05)]))
  assert.equal(vacia.surface.state, 'live', 'no espera a su rato ocioso')
})

test('una capa de líneas que nunca tuvo contexto arma su store contra el tope del realm: lo que no cabe lanza ya', () => {
  const lista = []
  const source = { accessors: { idOf: r => r.id, pathOf: r => r.path }, getSnapshot: () => lista, subscribe: () => () => {} }
  const capa = new LineGpuLayer({ host: host(), pane: 'lineas', source })
  capas.push(capa)
  assert.equal(capa.surface.state, 'none')
  lista.push({ id: 1, path: Array.from({ length: 70_000 }, (_, i) => [i * 0.001, i * 0.001]) })
  assert.throws(() => capa.refresh(), /no entran en una textura de 16×16/)
})
