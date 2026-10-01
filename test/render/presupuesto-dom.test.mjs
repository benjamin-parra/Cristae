// PRESUPUESTO DE NODOS DOM — la contraparte barata y automática del banco de medición.
//
// Congela cuántos NODOS DOM cuesta cada capa: los que deja VIVOS (lo que el navegador mantiene mientras
// la pantalla está abierta) y los que CREA y DESTRUYE para llegar ahí (el trabajo de DOM del gesto).
// Corre en `npm test`, sin navegador y en milisegundos: el banco dice cuánto TARDA, esto dice cuánto
// OCUPA, y sólo el segundo puede correr en CI por cada commit.
//
// La unidad es el NODO, no el objeto de la capa que lo cuelga. El contador se alimenta del `document`
// del harness (ver `contadorNodos`), así que cuando una capa cambie cómo arma sus nodos —propios o en
// GPU— sigue midiendo lo mismo. Contando objetos de la capa, en cambio, el 0 llegaría solo con el
// remake y el guard se volvería decorativo justo cuando empieza a importar.
//
// Los DOS ejes hacen falta: crear y tirar 800 nodos por edición deja `vivos` clavado y cuesta igual que
// tener 800 vivos —sólo el flujo lo ve—, y 800 vivos que nadie recrea son invisibles al flujo.
//
// 🔴 El test NO juzga si el número es bueno: lo CONGELA. Un remake que baje una polilínea editable de
// 799 nodos a 6 tiene que EDITAR el aserto, y esa línea del diff es la prueba de que el remake sirvió.
// A la inversa, un cambio que suba un número sin tocar el test lo rompe — que es exactamente el punto.
//
// Línea base de HOY:
//
//   polilínea editable ·    400 vértices  →     1 nodo vivo    (era 799: 400 vértices + 399 midpoints)
//   · agregar UN vértice                  →     1 vivo y CERO ops de DOM  (eran 1.600: 799 bajas + 801 altas)
//   polígono editable  ·    400 vértices  →     1 nodo vivo    (era 800, con el midpoint del cierre)
//   atlas de handles   ·      N editores  →     5 nodos vivos  (era 5 POR editor)
//   capa de polígonos  ·    200 features  →     1 nodo vivo    (era 200: un path SVG por feature; ahora el canvas GPU)
//   capa de círculos   ·    200 features  →     1 nodo vivo    (era 200: un `L.circle` por círculo; ahora el canvas GPU)
//   capa de marcadores HTML · 200 marcas  →   401 nodos vivos  (la raíz + envoltorio e icono por marca)
//   capa de puntos     · 10.000 ítems     →     0 nodos vivos, 1 capa GL   ← BLINDA lo que ya está bien
//
// El único nodo de la geometría editable es CONSTANTE —no escala con el trazo, ni con los anillos—: el
// canvas de la superficie WebGL2; los vértices y los midpoints son puntos de un VBO. Los cinco tiles del
// atlas de sprites de los handles (off / vertex / midpoint / hover / grabbing) no son del editor sino de su
// CONFIGURACIÓN: se rasterizan una vez por proceso y los comparten todos los editores.
//
// Este archivo mide el REPOSO, que es lo que el navegador mantiene con la pantalla abierta. Los ÚNICOS
// nodos que el editor monta además son los ≤ 3 del vecindario bajo el cursor mientras dura el gesto: el
// banco `EditHandleDom` los caracteriza aislado y `editable-geometry.test.mjs` mide su CABLEADO —que el
// hover los monte y que salir y `destroy` los devuelvan—, que es lo que este presupuesto no puede ver.
//
// El presupuesto de la capa de polígonos NO depende de las features ni de sus vértices (es el canvas de
// su superficie): lo que escala con la geometría es rehacer el store en cada cambio del Source, y eso lo
// mide el banco, no este archivo.

import '../../test-helpers/engine-stub.mjs'
import { makeMap, makeLeaflet, makeEditGl, makeGlify, makeIconSet, conGlDeEdicion, contadorNodos, decorarElementos } from '../../test-helpers/engine-stub.mjs'
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { createSource } from '../../src/data/Source.js'
import { defineEditIconSet } from '../../src/render/EditHandleLayer.js'
import { EditableGeometry } from '../../src/render/EditableGeometry.js'
import { adoptLeafletHost } from '../../src/host/LeafletHost.js'
import { PolygonGpuLayer } from '../../src/render/PolygonGpuLayer.js'
import { CircleLayer } from '../../src/render/CircleLayer.js'
import { PointLayer } from '../../src/render/PointLayer.js'
import { HtmlLayer } from '../../src/render/HtmlLayer.js'

const VERTICES = 400        // un recorrido real; es la unidad de N de `editable` en el banco
const FEATURES = 200        // geocercas de una operación mediana
const PUNTOS   = 10_000     // flota grande en vivo
const EDITABLE = 1          // el costo CONSTANTE de UN editor: el canvas de su superficie
const ATLAS    = 5          // los tiles del atlas de handles: uno por CONFIGURACIÓN, y nunca cuelgan del documento

// El atlas se rasteriza en el primer `defineEditIconSet` del proceso y de ahí en más se comparte, así que
// se adelanta acá: cada presupuesto mide entonces lo que cuesta SU editor y no el azar de cuál corrió
// primero. Que sean cinco y una sola vez lo aserta el test del atlas, más abajo.
defineEditIconSet()

// La geometría editable abre su propia superficie WebGL2 (con stencil) sobre un canvas propio, y el
// `document` del harness devuelve un contexto no-op. La costura del harness se lo enchufa: el canvas lo
// sigue creando el shim, así que el contador mide exactamente igual.
let glVigente = null

after(conGlDeEdicion(() => glVigente))

// Sin puerta del puntero: lo que se mide no depende de él.
const editor = cfg => {
  glVigente = makeEditGl()
  return new EditableGeometry({ host: adoptLeafletHost(makeMap()), join: () => () => {}, pane: 'edit', ...cfg })
}

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
  const contador = contadorNodos()
  const source = createSource(accessors)
  source.set(items)
  await flush()
  const capa = crear({ map: makeMap(), pane: 'p', source })
  await flush()
  return { capa, contador }
}

/* ── La costura del harness ── */

// Todo lo que este archivo mide sale de `document.createElement`, y para enchufarle un WebGL2 al canvas de
// la superficie hay que decorarlo. Un parche a un global que nadie deshace se lo lleva puesto quien venga
// después, así que la costura tiene que devolver la fábrica original.
test('decorar la fábrica de elementos es reversible: la costura devuelve la del shim', () => {
  const original  = document.createElement
  const restaurar = decorarElementos(el => el)

  assert.notEqual(document.createElement, original, 'mientras dura, la fábrica está decorada')
  restaurar()
  assert.equal(document.createElement, original, 'y al soltarla vuelve exactamente la de antes')
})

/* ── Geometría editable: los vértices son puntos de un VBO, no nodos ── */

test('polilínea editable de 400 vértices → 1 nodo DOM vivo', () => {
  const contador = contadorNodos()
  const ed = editor({ kind: 'polyline', value: trazo(VERTICES) })

  assert.equal(contador.vivos, EDITABLE, 'LÍNEA BASE — el canvas de la superficie, y nada más')
  assert.equal(contador.creados, EDITABLE, 'y ni uno más: los 400 vértices y sus 399 midpoints no cuelgan nada')

  ed.destroy()
  assert.equal(contador.vivos, 0, 'destroy devuelve el canvas: en reposo el editor no deja nodo propio')
})

// El atlas de los handles se instanciaba por EDITOR, y sus canvas viven tanto como el atlas que los guarda:
// abrir y cerrar la edición N veces dejaba 5·N nodos que nadie soltaba. Memoizado por configuración, el
// costo es de una sola vez para todo el proceso.
test('el atlas de handles es UNO por configuración: N editores no lo vuelven a rasterizar', () => {
  const contador = contadorNodos()
  const eds = Array.from({ length: 20 }, () => editor({ kind: 'polygon', value: trazo(4) }))

  assert.equal(contador.creados, 20 * EDITABLE, 'LÍNEA BASE — veinte superficies y ni un tile de más')

  eds.forEach(ed => ed.destroy())
  assert.equal(contador.vivos, 0, 'y montar y destruir editores no acumula nada')

  contador.marcar()
  defineEditIconSet({ color: '#123456' })                 // otra configuración: ésta sí se rasteriza
  assert.equal(contador.creados, ATLAS, 'lo que cuesta una vez son los cinco tiles de CADA configuración')
})

test('agregar UN vértice no toca el DOM: la edición es incremental en el espejo GPU', () => {
  const contador = contadorNodos()
  const ed = editor({ kind: 'polyline', value: trazo(VERTICES), mode: 'draw' })
  contador.marcar()

  ed.handleMapClick({ lat: 9, lng: 9 })                 // el mismo `insertAfter` que promueve un midpoint

  assert.equal(contador.vivos, EDITABLE, 'el presupuesto no se mueve con un vértice de más')
  assert.deepEqual({ creados: contador.creados, destruidos: contador.destruidos }, { creados: 0, destruidos: 0 },
    'LÍNEA BASE — CERO ops de DOM por edición: el trazo sube por el arena, no se rehace')

  ed.destroy()
})

test('polígono editable de 400 vértices → el mismo 1 (el anillo que cierra no agrega nodos)', () => {
  const contador = contadorNodos()
  const ed = editor({ kind: 'polygon', value: trazo(VERTICES) })

  assert.equal(contador.vivos, EDITABLE, 'LÍNEA BASE — el midpoint del cierre tampoco es un nodo')

  ed.destroy()
})

// El costo es del EDITOR, no del trazo: la superficie es una sola y la comparten todos los anillos. Sin
// este aserto, «1» podría ser «1 por anillo» y el presupuesto no se enteraría.
test('un polígono de CUATRO anillos cuesta el mismo 1: el presupuesto no escala con los trazos', () => {
  const contador = contadorNodos()
  const ed = editor({ kind: 'polygon', value: Array.from({ length: 4 }, () => trazo(VERTICES)) })

  assert.equal(contador.vivos, EDITABLE, 'LÍNEA BASE — 1.600 vértices en 4 anillos, el mismo nodo')

  ed.destroy()
})

/* ── Capas vectoriales de la GPU: un canvas, no un nodo por feature ── */

// Los 200 polígonos son anillos de UNA superficie, y el único nodo es su canvas: no escala con la cantidad
// de features ni con los vértices de cada uno.
test('capa de polígonos de 200 features → 1 nodo DOM vivo', async () => {
  const items = Array.from({ length: FEATURES }, (_, i) => ({ id: i, rings: cuadrado(i * 0.5, i * 0.5) }))
  glVigente = makeEditGl()
  const { capa, contador } = await montar(
    opciones => new PolygonGpuLayer({ host: adoptLeafletHost(opciones.map), ...opciones }),
    { idOf: it => it.id, ringsOf: it => it.rings },
    items,
  )

  assert.equal(contador.vivos, EDITABLE, 'LÍNEA BASE — el canvas de la superficie, y nada más')
  assert.equal(contador.creados, EDITABLE, 'sin churn: montó una vez, no rebuildeó')

  capa.destroy()
  assert.equal(contador.vivos, 0, 'destroy devuelve el canvas')
})

// Los 200 círculos son anillos de UNA textura, y el único nodo es el canvas de su superficie: no escala
// con la cantidad ni con los segmentos de cada uno.
test('capa de círculos de 200 features → 1 nodo DOM vivo', async () => {
  const items = Array.from({ length: FEATURES }, (_, i) => ({ id: i, lat: i * 0.5, lng: i * 0.5, radio: 5000 }))
  glVigente = makeEditGl()
  const { capa, contador } = await montar(
    opciones => new CircleLayer({ host: adoptLeafletHost(opciones.map), ...opciones }),
    { idOf: it => it.id, positionOf: it => ({ lat: it.lat, lng: it.lng }), radiusMetersOf: it => it.radio },
    items,
  )

  assert.equal(contador.vivos, EDITABLE, 'LÍNEA BASE — el canvas de la superficie, y nada más')
  assert.equal(contador.creados, EDITABLE, 'sin churn: montó una vez, no rebuildeó')

  capa.destroy()
  assert.equal(contador.vivos, 0, 'destroy devuelve el canvas')
})

// Cada marca es un envoltorio (posición, foco) con su icono (clase y tamaño del consumidor), más la raíz de
// la capa. Un tick de datos con las mismas marcas reconcilia por id y no crea ni tira ningún nodo.
test('capa de marcadores HTML de 200 marcas → 401 nodos vivos y sin churn al reconciliar', async () => {
  const items = Array.from({ length: FEATURES }, (_, i) => ({ id: i, lat: i * 0.5, lng: i * 0.5 }))
  const contador = contadorNodos()
  const source = createSource({ idOf: it => it.id, positionOf: it => ({ lat: it.lat, lng: it.lng }), htmlOf: () => '<b></b>' })
  source.set(items)
  await flush()
  const capa = new HtmlLayer({ host: adoptLeafletHost(makeMap()), pane: 'p', source })

  assert.equal(contador.vivos, 2 * FEATURES + 1, 'LÍNEA BASE — la raíz y dos nodos por marca')

  contador.marcar()
  source.set(items.map(it => ({ ...it })))
  await flush()
  assert.equal(contador.creados, 0, 'reconciliar por id reutiliza los nodos: ni altas...')
  assert.equal(contador.destruidos, 0, '...ni bajas')

  capa.destroy()
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
