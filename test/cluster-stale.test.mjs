// Manejo de clusterId STALE en las consultas públicas de Cluster. expandCluster / collapseCluster /
// isClusterExpanded / contents materializan la staleness (Supercluster.getLeaves lanza sobre un id
// retenido de otra generación) a su fallback documentado, SIN propagar la excepción. Es la guarda de
// #leavesOf: quitarle el try/catch hace lanzar al menos uno de estos casos. Y el camino feliz sigue
// intacto tras consolidar los 5 try/catch en un solo punto. Corre con: node --test test/cluster-stale.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { Cluster } from '../src/cluster/Cluster.js'

const idOf = p => p.id
const posOf = p => ({ lat: p.lat, lng: p.lng })
// Dos pares bien separados: a z3 cada par clusteriza por su lado (mismo layout que marked-bubble).
const FLOTA = [
  { id: 1, lat: 0, lng: 0 }, { id: 2, lat: 0, lng: 1e-4 },        // burbuja A
  { id: 3, lat: 20, lng: 60 }, { id: 4, lat: 20, lng: 60.0001 },  // burbuja B
]
const STALE = 123456789   // id ajeno a la generación viva de #sc → getLeaves lanza

const armar = () => {
  const c = new Cluster({ radius: 80, maxZoom: 18, minPoints: 2 })
  c.index(FLOTA, idOf, posOf)
  c.recluster(3)
  return c
}
const burbujaA = c => c.bubbles.find(b => Math.abs(b.lat - 0) < 0.01).id

test('id stale nunca propaga la excepción de getLeaves (fallback por método)', () => {
  const c = armar()
  assert.equal(c.expandCluster(STALE), null, 'expandCluster stale → null')
  assert.equal(c.isClusterExpanded(STALE), false, 'isClusterExpanded stale → false')
  assert.equal(c.contents(STALE), null, 'contents stale → null')
  assert.equal(c.collapseCluster(STALE), null, 'collapseCluster stale (sin sesión) → null')
})

test('con una sesión abierta, collapseCluster de un id stale no la cierra', () => {
  const c = armar()
  const a = burbujaA(c)
  assert.ok(c.expandCluster(a), 'se abre la sesión sobre la burbuja A')
  c.recluster(3)
  assert.equal(c.collapseCluster(STALE), null, 'un id stale no colapsa la sesión ajena')
  assert.equal(c.isClusterExpanded(a), true, 'y la burbuja A sigue expandida')
})

test('la consolidación no rompe el camino feliz (contents/expand/collapse sobre id vivo)', () => {
  const c = armar()
  const a = burbujaA(c)
  assert.deepEqual([...c.contents(a)].sort((x, y) => x - y), [1, 2], 'contents del id vivo → sus hojas')
  const res = c.expandCluster(a)
  assert.ok(res && res.ids.length === 2, 'expandCluster vivo abre con sus ids')
  assert.equal(c.isClusterExpanded(a), true, 'queda expandida')
  assert.equal(c.collapseAll(), true, 'collapseAll cierra la sesión abierta')
})
