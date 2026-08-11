// Contrato del banco de nodos DOM: existen el vértice promovido y sus DOS adyacentes, y nada más. El
// vecindario sale de la lista del trazo —de ahí los tres casos de vecindad—, muestra los MISMOS píxeles
// del sprite que la capa apaga, y despromover lo devuelve entero: al soltar no queda un solo nodo vivo.
//
// El presupuesto se mide con el MISMO instrumento que el de CI (`contadorNodos`), así que el número de
// acá y el de `presupuesto-dom.test.mjs` son comparables: 799 nodos para 400 vértices contra 3.
//
// El harness va primero: instala los globals de módulo que el árbol toca al evaluarse.
import { decorarElementos, makeGl, makeMap, contadorNodos } from '../../test-helpers/engine-stub.mjs'
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { ChunkedPath } from '../../src/geometry/ChunkedPath.js'
import { EditArena } from '../../src/render/EditArena.js'
import { defineEditIconSet, editHandleChannels } from '../../src/render/EditHandleLayer.js'
import { EditHandleDom } from '../../src/render/EditHandleDom.js'

// El banco no expone sus nodos, y lo que hay que caracterizar de ellos —que no enganchan un solo listener
// y qué tile dibujan— no se ve desde afuera. La costura del harness los instrumenta al salir de la
// fábrica: el elemento lo sigue creando el shim, así que el contador de nodos mide igual.
const espia = { listeners: 0, pintadas: [] }

const ctxEspia = el => new Proxy({
  drawImage: tile => espia.pintadas.push({ el, tile }),
}, { get: (t, p) => t[p] ?? (() => {}), set: () => true })

after(decorarElementos(el => {
  el.addEventListener = () => espia.listeners++
  el.getContext       = () => ctxEspia(el)
  return el
}))

// cap 31 · siete vértices por chunk al ingerir: el trazo cruza de chunk con pocos puntos, igual que en
// producción, y así el vecino de un anillo cae en el chunk más lejano del arena.
const BITS = 5
const SIZE = { x: 800, y: 600 }
const W0   = 256 / 360                   // el planeta entero mide 256 px a z0

const project = (lat, lng, out) => {
  out[0] = (lng + 180) * W0
  out[1] = (90 - lat) * W0
}

const puntos = n => Array.from({ length: n }, (_, i) => [-33.45 + i * 0.0007, -70.66 + i * 0.0011])

// El stub deja el origen del contenedor en (0,0), donde punto de capa y de contenedor son
// indistinguibles; con el origen corrido, uno de los dos deja de dar.
const mapaEn = (x, y) => ({ ...makeMap(), containerPointToLayerPoint: () => ({ x, y }) })

const montar = (n, { closed = false, map = makeMap(), zoom = 8 } = {}) => {
  const posiciones = []
  const L       = { DomUtil: { setPosition: (el, punto) => posiciones.push({ el, x: punto.x, y: punto.y }) } }
  const path    = new ChunkedPath({ points: puntos(n), localBits: BITS, closed })
  const iconSet = defineEditIconSet()
  const arena   = new EditArena({ gl: makeGl(), path, project, ...editHandleChannels(iconSet) })
  const banco   = new EditHandleDom({ L, map, pane: 'edit', path, arena, project, iconSet })
  return { path, arena, iconSet, banco, posiciones, vista: { zoom, center: { ...arena.anchor }, size: SIZE } }
}

const refs = path => {
  const out = []
  path.forEachVertex((x, y, ref) => out.push(ref))
  return out
}

// Reposiciona y devuelve lo que el banco escribió, en orden de trazo.
const colocar = m => {
  m.posiciones.length = 0
  m.banco.layout(m.vista)
  return m.posiciones
}

const coords  = m => colocar(m).map(p => [p.x, p.y])
const nodosDe = m => colocar(m).map(p => p.el)

// El punto de capa que le toca a una posición rel-ancla. Copia DELIBERADA de la aritmética del banco: es
// el oráculo del reposicionado, y si una de las dos cambia sin la otra el test lo dice.
const punto = ({ arena, vista }, x, y) => {
  const scale = 2 ** vista.zoom
  return [
    (arena.anchor.x - vista.center.x) * scale + vista.size.x / 2 + x * scale,
    (arena.anchor.y - vista.center.y) * scale + vista.size.y / 2 + y * scale,
  ]
}

const esperado = (m, ...vecindario) => vecindario.map(ref => punto(m, m.arena.relX(ref), m.arena.relY(ref)))

const xy = new Float64Array(2)
const puntoLatLng = (m, lat, lng) => {
  project(lat, lng, xy)
  return punto(m, xy[0] - m.arena.anchor.x, xy[1] - m.arena.anchor.y)
}

/* ── 1. Los tres casos de vecindad ── */

test('en el medio del trazo el vecindario son TRES nodos: el promovido y sus dos adyacentes', () => {
  const m = montar(23)
  const v = refs(m.path)[3]

  m.banco.promote(v)

  assert.equal(m.banco.count, 3)
  assert.deepEqual(coords(m), esperado(m, m.path.prevVertex(v), v, m.path.nextVertex(v)),
    'en orden de trazo, y cada uno donde la capa apagó su sprite')
})

test('en un trazo ABIERTO el primero no tiene anterior y el último no tiene siguiente: DOS nodos', () => {
  const m       = montar(23)
  const primero = m.path.firstVertex
  const ultimo  = m.path.lastVertex

  m.banco.promote(primero)
  assert.equal(m.banco.count, 2)
  assert.deepEqual(coords(m), esperado(m, primero, m.path.nextVertex(primero)))

  m.banco.promote(ultimo)
  assert.equal(m.banco.count, 2)
  assert.deepEqual(coords(m), esperado(m, m.path.prevVertex(ultimo), ultimo))
})

test('en un anillo CERRADO el anterior del primero es el último: TRES nodos igual', () => {
  const m = montar(23, { closed: true })
  const v = m.path.firstVertex
  assert.equal(m.path.prevVertex(v), m.path.lastVertex)
  assert.notEqual(m.path.chunkOf(m.path.lastVertex), m.path.chunkOf(v),
    'y vive en el chunk más lejano del arena: el vecindario tiene que salir de la LISTA')

  m.banco.promote(v)

  assert.equal(m.banco.count, 3)
  assert.deepEqual(coords(m), esperado(m, m.path.lastVertex, v, m.path.nextVertex(v)))
})

// Dentro de un chunk el adyacente está a dos entradas, y en el borde vive en OTRO chunk: es el caso que
// distingue preguntarle a la lista de hacer aritmética sobre el ref.
test('con el promovido en el borde del chunk, el anterior sale del chunk vecino', () => {
  const m = montar(23)
  const v = refs(m.path).find(ref => m.path.localOf(ref) === m.path.chunkFirst(m.path.chunkOf(ref))
    && m.path.prevVertex(ref) >= 0)
  const prev = m.path.prevVertex(v)
  assert.notEqual(m.path.chunkOf(prev), m.path.chunkOf(v))

  m.banco.promote(v)

  assert.equal(m.banco.count, 3)
  assert.deepEqual(coords(m), esperado(m, prev, v, m.path.nextVertex(v)))
})

test('un anillo de DOS hace coincidir anterior y siguiente: dos nodos, no uno apilado sobre el otro', () => {
  const m = montar(2, { closed: true })
  const v = m.path.firstVertex
  assert.equal(m.path.prevVertex(v), m.path.nextVertex(v))

  m.banco.promote(v)

  assert.equal(m.banco.count, 2)
  assert.deepEqual(coords(m), esperado(m, m.path.lastVertex, v))
})

// `setClosed` no mueve una sola entrada —no es edición estructural— y sin embargo le ESTRENA vecino al
// primer vértice. La capa le abre el agujero igual, así que sin este camino el handle nuevo quedaría
// apagado en GPU y sin nodo que lo reponga: invisible.
test('cerrar el trazo le estrena anterior al primer vértice, y el banco lo monta sin re-promover', () => {
  const m = montar(23)
  const v = m.path.firstVertex
  m.banco.promote(v)
  assert.equal(m.banco.count, 2, 'abierto: el primer vértice no tiene anterior')

  m.path.setClosed(true)

  assert.deepEqual(coords(m), esperado(m, m.path.lastVertex, v, m.path.nextVertex(v)))
  assert.equal(m.banco.count, 3, 'el reposicionado lo toma por la revisión de ESCRITURA, no por la estructural')
})

/* ── 2. El banco no acumula ── */

test('despromover no deja NINGÚN nodo vivo, y destruir tampoco', () => {
  const m        = montar(23)
  const contador = contadorNodos()

  m.banco.promote(refs(m.path)[3]).layout(m.vista)
  assert.equal(contador.vivos, 3)

  m.banco.promote(-1)
  assert.equal(m.banco.count, 0)
  assert.equal(contador.vivos, 0, 'al soltar el banco le devuelve al navegador hasta el último nodo')

  m.banco.promote(refs(m.path)[3])
  assert.equal(contador.vivos, 3, 'y vuelve a montarlos al promover de nuevo')

  m.banco.destroy()
  assert.equal(contador.vivos, 0)
})

test('promover dos veces seguidas RE-APUNTA el banco: ni un nodo de más', () => {
  const m  = montar(23)
  const rs = refs(m.path)
  m.banco.promote(rs[3]).layout(m.vista)

  const contador = contadorNodos()
  m.banco.promote(rs[8])

  assert.equal(m.banco.count, 3)
  assert.deepEqual({ creados: contador.creados, destruidos: contador.destruidos },
    { creados: 0, destruidos: 0 }, 'los tres nodos se re-apuntan, no se rehacen')
  assert.deepEqual(coords(m), esperado(m, rs[7], rs[8], rs[9]), 'y quedan sobre el vecindario NUEVO')

  m.posiciones.length = 0
  m.banco.promote(rs[8])
  assert.deepEqual({ creados: contador.creados, escrituras: m.posiciones.length },
    { creados: 0, escrituras: 0 }, 'promover al MISMO no toca nada, ni siquiera reposiciona')
})

// De tres adyacentes a dos: el banco encoge de verdad, no deja el sobrante escondido. Si no, «cuántos
// nodos hay» dejaría de ser «cuántos adyacentes tiene el promovido» y el presupuesto mediría de más.
test('el banco encoge cuando el vecindario encoge: del medio a un extremo quedan DOS', () => {
  const m = montar(23)
  m.banco.promote(refs(m.path)[3]).layout(m.vista)
  const contador = contadorNodos()

  m.banco.promote(m.path.firstVertex)

  assert.equal(m.banco.count, 2)
  assert.equal(contador.destruidos, 1, 'el tercero se da de baja, no se esconde')
  assert.deepEqual(coords(m), esperado(m, m.path.firstVertex, m.path.nextVertex(m.path.firstVertex)))
})

/* ── 3. Afordancia pura, con los píxeles de la capa ── */

test('los nodos son afordancia pura: `pointer-events: none` y CERO listeners', () => {
  const m = montar(23)
  espia.listeners = 0

  m.banco.promote(refs(m.path)[3])
  const nodos = nodosDe(m)

  assert.equal(nodos.length, 3)
  assert.ok(nodos.every(el => el.style.pointerEvents === 'none'), 'no se comen el gesto del mapa')
  assert.equal(espia.listeners, 0, 'el gesto lo posee la capa GL: acá no se escucha nada')
})

test('cada nodo muestra los MISMOS píxeles del sprite que la capa apaga', () => {
  const m = montar(23)
  espia.pintadas.length = 0

  m.banco.promote(refs(m.path)[3])
  const tiles = new Map(espia.pintadas.map(p => [p.el, p.tile]))

  assert.deepEqual(nodosDe(m).map(el => tiles.get(el)),
    ['vertex', 'hover', 'vertex'].map(variante => m.iconSet.sprite(variante)),
    'el adyacente conserva su variante; el promovido toma la que la GPU no dibuja')
})

test('`grab` repinta SÓLO al promovido: de `hover` a `grabbing` y de vuelta', () => {
  const m = montar(23)
  m.banco.promote(refs(m.path)[3])
  const promovido = nodosDe(m)[1]

  espia.pintadas.length = 0
  m.banco.grab()
  assert.equal(espia.pintadas.length, 1, 'los adyacentes no se repintan: su variante no cambió')
  assert.equal(espia.pintadas[0].el, promovido)
  assert.equal(espia.pintadas[0].tile, m.iconSet.sprite('grabbing'))

  espia.pintadas.length = 0
  m.banco.grab(false)
  assert.equal(espia.pintadas.length, 1)
  assert.equal(espia.pintadas[0].tile, m.iconSet.sprite('hover'))
})

/* ── 4. El reposicionado ── */

test('el arrastre mueve SÓLO al promovido, y no pasa por el arena', () => {
  const m   = montar(23)
  const v   = refs(m.path)[3]
  m.banco.promote(v)
  const antes = coords(m)
  const rel   = [m.arena.relX(v), m.arena.relY(v)]

  m.banco.live(-33.0, -70.0)
  const despues = coords(m)

  assert.deepEqual([despues[0], despues[2]], [antes[0], antes[2]], 'los adyacentes siguen donde los dejó el arena')
  assert.deepEqual(despues[1], puntoLatLng(m, -33.0, -70.0), 'y el promovido va a la posición viva')
  assert.deepEqual([m.arena.relX(v), m.arena.relY(v)], rel, 'el espejo GPU no se tocó: el commit es al soltar')
})

test('el nodo va al punto de CAPA: el origen del contenedor entra en la cuenta', () => {
  const base   = montar(23)
  const movido = montar(23, { map: mapaEn(7, -11) })
  const v      = refs(base.path)[3]

  base.banco.promote(v)
  movido.banco.promote(v)

  assert.deepEqual(coords(movido), coords(base).map(([x, y]) => [x + 7, y - 11]))
})

test('a un zoom más, la distancia al centro del viewport se duplica', () => {
  const m = montar(23)
  m.banco.promote(refs(m.path)[3])
  const cerca = coords(m)

  m.vista = { ...m.vista, zoom: m.vista.zoom + 1 }

  assert.deepEqual(coords(m), cerca.map(([x, y]) =>
    [(x - SIZE.x / 2) * 2 + SIZE.x / 2, (y - SIZE.y / 2) * 2 + SIZE.y / 2]))
})

/* ── 5. El presupuesto ── */

test('el vecindario de una polilínea de 400 vértices cuesta TRES nodos, no 799', () => {
  const m        = montar(400)
  const contador = contadorNodos()

  m.banco.promote(refs(m.path)[200]).layout(m.vista)

  assert.equal(contador.vivos, 3, 'PRESUPUESTO — el banco no escala con el trazo: prev, v y next')
  assert.equal(contador.creados, 3, 'y ni uno de más: el vecindario se monta, no se rebuildea')

  m.banco.promote(-1)
  assert.equal(contador.vivos, 0, 'al soltar, CERO')
})
