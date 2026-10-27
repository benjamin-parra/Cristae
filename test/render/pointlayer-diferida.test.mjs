// La capa de puntos que nace vacía no toma su contexto al construirse: deja su marcador en el pane y la política se lo da en un
// rato ocioso, o en la tarea en que recibe su primer dato. Es lo que vuelve prescindibles a la espiral y a la sub-espiral del
// cluster, y evita el getContext síncrono del montaje de toda capa que recibe sus datos por la Source del motor. Con el
// navegador falso (test-helpers/navegador-falso.mjs), que desaloja como Chromium. Los cuadros y los ratos ociosos los corre el
// test (`cuadro()`, `ocio()`), y los eventos del navegador llegan con `navegador.vaciar()`.
//
//   alta      vacía —o con una Source que el `where` deja sin ítems— deja el marcador y no toma contexto; con ítems, lo toma ya
//   dato      el primero lo pide antes de codificar, en esa tarea: sube una vez y con la escala del canvas; una viva que pasa
//             a tener contenido rehace el orden de desalojo
//   presión   vacía es prescindible: perder una necesaria la suelta, y vuelve al llegarle un dato
//
// Corre con: node --test test/render/pointlayer-diferida.test.mjs
import '../../test-helpers/engine-stub.mjs'
import { decorarElementos, makeEditGl, makeIconSet, makeLeaflet, makeMap, makePickSpy } from '../../test-helpers/engine-stub.mjs'
import { conNavegador, crearNavegador } from '../../test-helpers/navegador-falso.mjs'
import { after, afterEach, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { PointLayer } from '../../src/render/PointLayer.js'
import { adoptLeafletHost } from '../../src/host/LeafletHost.js'

/* ── Cuadros y ratos ociosos a mano, y un reloj que avanza entre test y test ── */

const rafPrevio    = globalThis.requestAnimationFrame
const cancelPrevio = globalThis.cancelAnimationFrame
const agendados    = new Map()
const ociosos      = []
let serie          = 0
globalThis.requestAnimationFrame = cb => (agendados.set(++serie, cb), serie)
globalThis.cancelAnimationFrame  = id => agendados.delete(id)
globalThis.requestIdleCallback   = cb => ociosos.push(cb)

const cuadro = () => {
  const ahora = [...agendados.values()]
  agendados.clear()
  ahora.forEach(cb => cb(0))
}
const ocio = () => ociosos.splice(0).forEach(cb => cb({ didTimeout: false, timeRemaining: () => 50 }))

const reloj   = performance.now.bind(performance)
let   desfase = 0
performance.now = () => reloj() + desfase
beforeEach(() => { desfase += 10_000 })

after(() => {
  globalThis.requestAnimationFrame = rafPrevio
  globalThis.cancelAnimationFrame  = cancelPrevio
  delete globalThis.requestIdleCallback
  performance.now                  = reloj
})

/* ── Harness ── */

const copia  = v => (ArrayBuffer.isView(v) ? Array.from(v) : v)
const grabar = base => {
  const llamadas = []
  return new Proxy(base, {
    get: (t, p) => {
      if (p === 'llamadas') return llamadas
      const v = t[p]
      return typeof v === 'function' ? (...args) => (llamadas.push([p, ...args.map(copia)]), v(...args)) : v
    },
  })
}

const SIZE     = 6                       // layout de los sprites: [x, y, tile, angle, b, a, size]
const llamados = (contexto, metodo) => contexto.gl.llamadas.filter(([m]) => m === metodo)

let soltar = null
let panes  = 0
afterEach(() => {
  for (let i = 0; (agendados.size || ociosos.length) && i < 20; i++) {
    cuadro()
    ocio()
  }
  agendados.clear()
  ociosos.length = 0
  soltar?.()
  soltar = null
})

const accessors = { idOf: it => it.id, positionOf: it => it.pos }
const items     = n => Array.from({ length: n }, (_, i) => ({ id: `P${i}`, pos: { lat: i, lng: i } }))

// Source manual de snapshot mutable: `poner` lo reemplaza y avisa, como el emit coalescido de la Source del motor.
const makeSource = lista => {
  const subs = new Set()
  return {
    accessors,
    getSnapshot  : () => lista,
    subscribe    : cb => (subs.add(cb), () => subs.delete(cb)),
    itemById     : id => lista.find(it => it.id === id),
    moveDirtyIds : () => new Set(),
    dirtyIds     : () => new Set(),
    poner(nueva) {
      lista = nueva
      subs.forEach(cb => cb())
    },
  }
}

const nuevoNavegador = () => crearNavegador({ crearGl: canvas => grabar(makeEditGl(makePickSpy(), canvas)) })

// Un host propio por mapa: cada capa tiene su pane. `navegador` se comparte para probar la presión entre dos capas.
const montar = ({ navegador = nuevoNavegador(), datos = [], ...opciones } = {}) => {
  soltar ??= conNavegador(navegador)
  const host   = adoptLeafletHost(makeMap(), { leaflet: makeLeaflet() })
  const source = makeSource(datos)
  const layer  = new PointLayer({ host, pane: `p${++panes}`, source, iconSet: makeIconSet(), ...opciones })
  return { layer, source, navegador, contexto: i => navegador.contextos[i] }
}

// Hasta que el realm logra un contexto, una vacía lo toma ya —sin WebGL2 el alta tiene que lanzar, y quien la pidió degrada—.
// Estos tests son del realm con WebGL2 andando: un contexto logrado y devuelto antes de empezar.
before(() => {
  const previa = montar({ datos: items(1) })
  previa.layer.destroy()
  soltar()
  soltar = null
})

/* ── Alta ── */

test('vacía al construirse: deja su marcador, no toma contexto, y la política se lo da en un rato ocioso', () => {
  const { layer, navegador } = montar()
  assert.equal(navegador.creados, 0, 'ni un getContext al construirse')
  assert.equal(layer.surface.state, 'none')
  assert.equal(layer.hasContent, false)
  assert.ok(layer.surface.canvas, 'deja su marcador: el lugar en el pane lo guarda un canvas sin contexto')
  assert.equal(agendados.size, 0, 'y no agenda cuadros')

  const marcador = layer.surface.canvas
  ocio()
  assert.equal(navegador.creados, 1, 'el rato ocioso se lo da')
  assert.equal(layer.surface.state, 'live')
  assert.equal(layer.surface.canvas, marcador, 'en el marcador mismo: ni un nodo más')
  assert.equal(layer.hasContent, false, 'sigue sin contenido: es prescindible')
  layer.destroy()
})

test('con ítems al construirse toma el contexto ya, como antes, y sube y pinta en el primer cuadro', () => {
  const { layer, navegador, contexto } = montar({ datos: items(3) })
  assert.equal(navegador.creados, 1)
  assert.equal(layer.surface.state, 'live')
  assert.equal(layer.hasContent, true)
  cuadro()
  assert.equal(llamados(contexto(0), 'bufferData').length, 1)
  assert.deepEqual(llamados(contexto(0), 'drawArrays').at(-1).slice(1), [0, 0, 3])
  layer.destroy()
})

test('una Source con ítems que el `where` rechaza a todos nace vacía, y con uno que lo pasa, con contexto', () => {
  const navegador = nuevoNavegador()
  const sin = montar({ navegador, datos: items(3), where: () => false })
  assert.equal(sin.navegador.creados, 0)
  assert.equal(sin.layer.surface.state, 'none')
  assert.equal(sin.layer.hasContent, false)
  sin.layer.destroy()

  const con = montar({ navegador, datos: items(3), where: it => it.id === 'P2' })
  assert.equal(con.navegador.creados, 1)
  assert.equal(con.layer.hasContent, true)
  con.layer.destroy()
})

test('interactiva y sin contexto: un pick no toca GL ni tira', () => {
  const { layer, navegador } = montar({ interactive: true })
  assert.deepEqual(layer.resolveClick({ x: 10, y: 10 }), [])
  assert.equal(layer.requestHoverHit({ x: 10, y: 10 }), false)
  assert.equal(navegador.creados, 0)
  layer.destroy()
})

/* ── El primer dato ── */

// El tamaño de los sprites va en px del buffer, y la escala se mide sobre el canvas que se tiene: el contexto va ANTES de
// codificar, o habría que recodificar todo (un segundo rebuild O(n)) con los tamaños de la escala que recién se midió.
test('el primer dato toma el contexto en esa tarea, antes de codificar: sube una vez, con la escala del canvas', () => {
  const caja    = { ancho: 400 }                       // 800 px de buffer en 400 px CSS: escala 2
  const sinCaja = decorarElementos((el, tag) => (tag === 'canvas' && Object.defineProperty(el, 'clientWidth', { get: () => caja.ancho }), el))
  try {
    let lecturas  = 0
    const contando = { ...accessors, positionOf: it => (lecturas++, it.pos) }
    const { layer, source, navegador, contexto } = montar({ accessors: contando })
    const previos = navegador.creados                  // vacía y sin contexto: la escala es la de antes de medirla, 1
    source.poner(items(3))
    assert.equal(lecturas, 3, 'y se codifica una vez: pedirlo después obligaría a un segundo rebuild O(n)')

    assert.equal(navegador.creados, previos + 1, 'lo tomó en la tarea del dato')
    const nuevo = contexto(previos)
    assert.equal(layer.surface.state, 'live')
    assert.equal(llamados(nuevo, 'bufferData').length, 1, 'el espejo se sube una vez: no hubo que recodificar')
    assert.equal(llamados(nuevo, 'bufferData')[0][2][SIZE], 48, '24 px CSS son 48 del buffer')
    cuadro()
    assert.deepEqual(llamados(nuevo, 'drawArrays').at(-1).slice(1), [0, 0, 3])
    assert.equal(llamados(nuevo, 'bufferData').length, 1, 'y el cuadro no vuelve a subir')
    layer.destroy()
  } finally {
    sinCaja()
  }
})

test('el primer dato de una vacía que ningún rato ocioso tomó pide el contexto en esa tarea, y el rato ocioso no lo toma de nuevo', () => {
  const { layer, source, navegador, contexto } = montar()
  source.poner(items(2))
  assert.equal(navegador.creados, 1)
  assert.equal(layer.surface.state, 'live')
  assert.equal(layer.hasContent, true)
  cuadro()
  assert.equal(llamados(contexto(0), 'drawArrays').at(-1)[3], 2, 'pinta los dos')
  ocio()
  assert.equal(navegador.creados, 1, 'el rato ocioso que quedaba no toma otro')
  layer.destroy()
})

test('sin presión en el realm, una viva que estaba vacía y recibe su primer dato no vacía ninguna cola (M6 del banco)', () => {
  const { layer, source, contexto } = montar()
  ocio()                                               // vacía y viva: prescindible, no se renueva
  const flushes = () => llamados(contexto(0), 'flush').length
  assert.equal(flushes(), 0)
  source.poner(items(2))
  for (let i = 0; i < 3; i++) {
    cuadro()
    ocio()
  }
  assert.equal(flushes(), 0, 'lejos del techo el orden de desalojo no se usa: ni en la tarea del dato ni en un rato ocioso')
  assert.equal(layer.surface.state, 'live')
  layer.destroy()
})

/* ── Presión ── */

test('vacía es prescindible: perder una necesaria la suelta, y vuelve a tomar su contexto al llegarle un dato', () => {
  const navegador = nuevoNavegador()
  const necesaria = montar({ navegador, datos: items(2) })
  const vacia     = montar({ navegador })
  ocio()
  cuadro()
  assert.deepEqual([necesaria.layer.surface.state, vacia.layer.surface.state], ['live', 'live'])

  navegador.desalojar(necesaria.contexto(0))
  navegador.vaciar()
  assert.equal(vacia.layer.surface.state, 'released', 'la vacía devolvió su cupo en el acto')
  assert.equal(necesaria.layer.surface.state, 'lost')
  cuadro()
  assert.equal(necesaria.layer.surface.state, 'live', 'y la necesaria vuelve en el cuadro siguiente')
  assert.equal(vacia.layer.surface.state, 'released', 'la vacía no vuelve sola')

  const creados = navegador.creados
  vacia.source.poner(items(4))
  assert.equal(navegador.creados, creados + 1, 'con contenido pide su contexto en la tarea del dato')
  assert.equal(vacia.layer.surface.state, 'live')
  cuadro()
  assert.deepEqual(llamados(navegador.contextos.at(-1), 'drawArrays').at(-1).slice(1), [0, 0, 4])
  necesaria.layer.destroy()
  vacia.layer.destroy()
})

test('destruida sin haber tomado nunca el contexto: no toma nada, y el rato ocioso que esperaba no la resucita', () => {
  const { layer, navegador } = montar()
  layer.destroy()
  ocio()
  cuadro()
  assert.equal(navegador.creados, 0)
  assert.equal(navegador.vivos, 0)
})
