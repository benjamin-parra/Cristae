// PRESUPUESTO DE NODOS DOM — la contraparte barata y automática del banco de medición.
//
// Congela cuántos NODOS DOM cuesta cada capa: los que deja VIVOS (lo que el navegador mantiene mientras
// la pantalla está abierta) y los que CREA y DESTRUYE para llegar ahí (el trabajo de DOM del gesto).
// Corre en `npm test`, sin navegador y en milisegundos: el banco dice cuánto TARDA, esto dice cuánto
// OCUPA, y sólo el segundo puede correr en CI por cada commit.
//
// La unidad es el NODO, no el `L.marker` creado. El contador se alimenta por igual del `document` del
// harness y de los dobles de Leaflet (ver `contadorNodos`), así que cuando una capa cambie sus handles
// de `L.marker` a nodos propios —o a GPU— sigue midiendo lo mismo. Contando marcadores, en cambio, el 0
// llegaría solo con el remake y el guard se volvería decorativo justo cuando empieza a importar.
//
// Los DOS ejes hacen falta: crear y tirar 800 nodos por edición deja `vivos` clavado y cuesta igual que
// tener 800 vivos —sólo el flujo lo ve—, y 800 vivos que nadie recrea son invisibles al flujo.
//
// 🔴 El test NO juzga si el número es bueno: lo CONGELA. Un remake que baje una polilínea editable de
// 799 nodos a 2 tiene que EDITAR el aserto, y esa línea del diff es la prueba de que el remake sirvió.
// A la inversa, un cambio que suba un número sin tocar el test lo rompe — que es exactamente el punto.
//
// Línea base de HOY (previa al remake GPU de las capas que se portaron "de limpieza"):
//
//   polilínea editable ·    400 vértices  →   799 nodos vivos  (400 vértices + 399 midpoints)
//   · insertar UN vértice                 →   801 vivos y 1.600 ops de DOM (799 bajas + 801 altas)
//   polígono editable  ·    400 vértices  →   800 nodos vivos  (400 vértices + 400 midpoints, anillo cerrado)
//   capa de polígonos  ·    200 features  →   200 nodos vivos  (los "200 paths + 0 markers" de la unidad vieja)
//   capa de círculos   ·    200 features  →   200 nodos vivos  (ídem)
//   capa de puntos     · 10.000 ítems     →     0 nodos vivos, 1 capa GL   ← BLINDA lo que ya está bien
//
// El presupuesto de la capa de polígonos NO depende de los vértices de cada feature (es un path por
// feature): lo que escala con la geometría es el reindex O(n·vértices) por flush, y eso lo mide el
// banco, no este archivo.

import '../../test-helpers/engine-stub.mjs'
import { makeMap, makeLeaflet, makeGlify, makeIconSet, contadorNodos } from '../../test-helpers/engine-stub.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { createSource } from '../../src/data/Source.js'
import { EditableGeometry } from '../../src/render/EditableGeometry.js'
import { PolygonLayer } from '../../src/render/PolygonLayer.js'
import { CircleLayer } from '../../src/render/CircleLayer.js'
import { PointLayer } from '../../src/render/PointLayer.js'

const VERTICES = 400        // un recorrido real; es la unidad de N de `editable` en el banco
const FEATURES = 200        // geocercas de una operación mediana
const PUNTOS   = 10_000     // flota grande en vivo

// La Source real emite en rAF (defer:'raf' → setTimeout(0) bajo el shim); un macrotask lo vacía, así
// el conteo se toma sobre el montaje ya asentado y no a mitad de camino.
const flush = () => new Promise(r => globalThis.setTimeout(r, 0))

// El presupuesto depende de la CANTIDAD de vértices, no de la forma; una diagonal determinista deja
// el test leyéndose igual en cualquier corrida.
const trazo    = n => Array.from({ length: n }, (_, i) => [i * 0.01, i * 0.02])
const cuadrado = (lat, lng) => [[lat - 1, lng - 1], [lat - 1, lng + 1], [lat + 1, lng + 1], [lat + 1, lng - 1]]

// Monta una capa reactiva sobre una Source ya asentada. El contador se abre ANTES de construirla: mide
// los nodos de la capa, no los que el harness ya tenía puestos.
const montar = async (crear, accessors, items) => {
  const L = makeLeaflet()
  const contador = contadorNodos()
  const source = createSource(accessors)
  source.set(items)
  await flush()
  const capa = crear({ L, map: makeMap(), pane: 'p', source })
  await flush()
  return { capa, contador }
}

/* ── Geometría editable: un nodo por vértice MÁS uno por segmento ── */

test('polilínea editable de 400 vértices → 799 nodos DOM vivos', () => {
  const L = makeLeaflet()
  const contador = contadorNodos()
  const ed = new EditableGeometry({ L, map: makeMap(), pane: 'edit', kind: 'polyline', value: trazo(VERTICES) })

  assert.equal(contador.vivos, 799, 'LÍNEA BASE — 400 vértices + 399 midpoints, un nodo cada uno')
  assert.equal(contador.creados, 799, 'y ni uno de más: el montaje no pasa por un rebuild de cortesía')

  ed.destroy()
  assert.equal(contador.vivos, 0, 'destroy no deja nodos colgando del navegador')
})

test('insertar UN vértice recrea los 801 handles (el editor no tiene camino incremental)', () => {
  const L = makeLeaflet()
  const contador = contadorNodos()
  const ed = new EditableGeometry({ L, map: makeMap(), pane: 'edit', kind: 'polyline', value: trazo(VERTICES) })

  // Los midpoints son los handles no-draggable; clickear el del segmento 0 promueve ese punto a vértice.
  const midpoint0 = L.log.markers.find(m => !m.opts.draggable)
  const clears = L.log.clearLayers
  contador.marcar()
  midpoint0.fire('click', {})

  assert.equal(contador.vivos, 801, 'LÍNEA BASE — un vértice de más deja 801 nodos vivos')
  assert.equal(contador.destruidos, 799, 'LÍNEA BASE — pero se tiran los 799 previos…')
  assert.equal(contador.creados, 801, '…y se montan 801 de cero: 1.600 ops de DOM por UN vértice')
  assert.equal(L.log.clearLayers - clears, 1, 'las 799 bajas van de una sola vez')

  ed.destroy()
})

test('polígono editable de 400 vértices → 800 nodos vivos (el anillo cierra, hay un segmento más)', () => {
  const L = makeLeaflet()
  const contador = contadorNodos()
  const ed = new EditableGeometry({ L, map: makeMap(), pane: 'edit', kind: 'polygon', value: trazo(VERTICES) })

  assert.equal(contador.vivos, 800, 'LÍNEA BASE — 400 vértices + 400 midpoints')

  ed.destroy()
})

/* ── Capas vectoriales de Leaflet: un path SVG por feature ── */

test('capa de polígonos de 200 features → 200 nodos vivos', async () => {
  const items = Array.from({ length: FEATURES }, (_, i) => ({ id: i, rings: cuadrado(i * 0.5, i * 0.5) }))
  const { capa, contador } = await montar(
    opciones => new PolygonLayer(opciones),
    { idOf: it => it.id, ringsOf: it => it.rings },
    items,
  )

  assert.equal(capa.count, FEATURES, 'los 200 features quedaron montados')
  assert.equal(contador.vivos, 200, 'LÍNEA BASE — un nodo por feature: los 4 vértices viajan DENTRO del path')
  assert.equal(contador.creados, 200, 'sin churn: montó una vez, no rebuildeó')
})

test('capa de círculos de 200 features → 200 nodos vivos', async () => {
  const items = Array.from({ length: FEATURES }, (_, i) => ({ id: i, lat: i * 0.5, lng: i * 0.5, radio: 5000 }))
  const { contador } = await montar(
    opciones => new CircleLayer(opciones),
    { idOf: it => it.id, positionOf: it => ({ lat: it.lat, lng: it.lng }), radiusMetersOf: it => it.radio },
    items,
  )

  assert.equal(contador.vivos, 200, 'LÍNEA BASE — un nodo por feature: el radio en metros lo reproyecta el path')
  assert.equal(contador.creados, 200, 'sin churn: montó una vez, no rebuildeó')
})

/* ── Puntos GL: el passthrough que la librería promete, blindado ── */

test('capa de puntos de 10.000 ítems → 0 nodos DOM y UNA capa GL', async () => {
  const L = makeLeaflet()
  const contador = contadorNodos()
  const glify = makeGlify()
  const source = createSource({ idOf: it => it.id, positionOf: it => ({ lat: it.lat, lng: it.lng }) })
  source.set(Array.from({ length: PUNTOS }, (_, i) => ({ id: i, lat: i * 0.001, lng: i * 0.002 })))
  await flush()

  // Se le PASA un `L` que su contrato no pide: el aserto es que no lo usa para NADA. Si un remake le
  // colgara un nodo por ítem —por `L` o por su cuenta—, el contador lo delata en vez de dejarlo entrar.
  const capa = new PointLayer({ L, glify, map: makeMap(), pane: 'p', source, iconSet: makeIconSet() })
  await flush()

  assert.equal(capa.count, PUNTOS, 'los 10.000 entraron de verdad')
  assert.equal(contador.vivos, 0, 'LÍNEA BASE — cero nodos que el navegador tenga que mantener')
  assert.equal(contador.creados, 0, 'y ninguno transitorio: no hay churn escondido')
  assert.equal(glify.layers.length, 1, 'los 10.000 viajan en UNA capa GL: un buffer, un draw')

  capa.destroy()
})
