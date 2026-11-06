// La recuperación sobre tramos (PLAN-C-MINIMO §10): los escenarios de un contexto por capa de `contextos-readquirir` y
// `contextos-politica` que siguen siendo contrato con «léase tramo» (SPECS §9 y §10.1), sobre un mapa de dos tramos.
// Abajo `a` (puntos) y `b` (líneas); una etiqueta los separa de `c` (puntos) y `d` (polígono), arriba. Cuadros a mano y el
// navegador falso que cuenta los contextos.
//
// El harness va PRIMERO: window, customElements y lo que Lit toca al evaluar.
import { ACC, LINEA, POLI, armarVacio, asentar, esperar, iconSet, items } from '../../test-helpers/modelo-capas.mjs'
import { makeEditGl, makePickSpy } from '../../test-helpers/engine-stub.mjs'
import { afterEach, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { createSource } from '../../src/data/index.js'
import { STILL_CLASS } from '../../src/render/tramo-still.js'

/* ── Cuadros a mano ── */

const rafPrevio    = globalThis.requestAnimationFrame
const cancelPrevio = globalThis.cancelAnimationFrame
const agendados    = new Map()
const ociosos      = []
let serie          = 3_000_000                  // lejos de los ids del rAF de jsdom, que se cancelan por el mismo nombre
const cuadros = () => {
  globalThis.requestAnimationFrame = cb => (agendados.set(++serie, cb), serie)
  globalThis.cancelAnimationFrame  = id => agendados.delete(id)
  globalThis.requestIdleCallback   = cb => (ociosos.push(cb), ociosos.length)
}
const cuadro = () => {
  const ahora = [...agendados.values()]
  agendados.clear()
  ahora.forEach(cb => cb(0))
}
const ocio = () => ociosos.splice(0).forEach(cb => cb({ didTimeout: false, timeRemaining: () => 50 }))

let mapa = null
afterEach(() => {
  mapa?.remove()
  mapa = null
  for (let i = 0; (agendados.size || ociosos.length) && i < 30; i++) {
    cuadro()
    ocio()
  }
  agendados.clear()
  globalThis.requestAnimationFrame = rafPrevio
  globalThis.cancelAnimationFrame  = cancelPrevio
  delete globalThis.requestIdleCallback
  mock.restoreAll()
  document.body.replaceChildren()
})

/* ── Harness ── */

const grabar = base => {
  const llamadas = []
  return new Proxy(base, {
    get: (t, p) => {
      if (p === 'llamadas') return llamadas
      const v = t[p]
      return typeof v === 'function' ? (...args) => (llamadas.push([p, ...args]), v(...args)) : v
    },
  })
}
const crearGl = canvas => grabar(makeEditGl(makePickSpy(), canvas))

const fuente = n => (s => (s.set(items(n)), s))(createSource(ACC))
const linea  = { id: 1, pts: [[0, 0], [1, 1]], color: '#00f', weight: 2, opacity: 1 }

// Dos tramos: { a, b } y { c, d }, con la etiqueta `sep` entre ellos.
const montar = async (opciones = {}) => {
  const { map, navegador } = await armarVacio({ crearGl, ...opciones })
  mapa = map
  const engine  = map.engine
  const fuentes = { a: fuente(2), c: fuente(2) }
  engine.addPointLayer({ id: 'a', source: fuentes.a, iconSet, z: 400 })
  engine.addLineLayer({ id: 'b', accessors: LINEA, data: [linea], z: 410 })
  engine.addLabelLayer({ id: 'sep', z: 420 })
  engine.addPointLayer({ id: 'c', source: fuentes.c, iconSet, z: 430 })
  engine.addPolygonLayer({ id: 'd', accessors: POLI, data: [{ id: 'z1' }], z: 440 })
  await asentar(engine)
  await esperar(40)
  cuadros()
  assert.equal(tramoDe(engine, 'a'), tramoDe(engine, 'b'))
  assert.equal(tramoDe(engine, 'c'), tramoDe(engine, 'd'))
  assert.notEqual(tramoDe(engine, 'a'), tramoDe(engine, 'c'))
  assert.equal(navegador.vivos, 2, 'un contexto por tramo')
  return { engine, navegador, fuentes }
}

const tramoDe    = (engine, id) => engine.getLayer(id)?.layer?.surface?.tramo ?? null
const contextoDe = (navegador, engine, id) => navegador.contextos.find(c => c.gl === tramoDe(engine, id)?.gl)
const estados    = engine => Object.fromEntries(engine.surfaces().map(s => [s.layerId, s.state]))
const dibujos    = contexto => contexto.gl.llamadas.filter(([m]) => /^draw/.test(m)).length

const intactos = navegador => {
  const tocados = navegador.contextos.filter(c => c.llamadasTrasPerdida).map(c => `#${c.id} ${c.pane}: ${c.llamadasTrasPerdida}`)
  assert.deepEqual(tocados, [], 'ninguna llamada a un contexto después de perderse')
  assert.deepEqual(navegador.violaciones, [], 'ningún recurso de un contexto usado en otro')
}

const sinResucitar = navegador => {
  const creados = navegador.creados
  navegador.vaciar()
  for (let i = 0; i < 5; i++) cuadro()
  navegador.vaciar()
  assert.equal(navegador.creados, creados, 'ningún getContext después de quitar')
}

// Lo que el navegador avisó, y unos cuadros de la política con su rato ocioso. Los ajenos dibujan en cada cuadro.
const asentarCuadros = (navegador, ajenos = [], n = 4) => {
  for (let i = 0; i < n; i++) {
    ajenos.forEach(a => a.estado === 'vivo' && a.gl.flush())
    navegador.vaciar()
    cuadro()
    ocio()
  }
}

/* ── Reinicio de la GPU ── */

test('un reinicio de la GPU les quita el contexto a los dos tramos: vuelven de a uno por cuadro, el de mayor z primero, y pintan', async () => {
  const { engine, navegador } = await montar()
  const viejos  = [contextoDe(navegador, engine, 'a'), contextoDe(navegador, engine, 'c')]
  viejos.forEach(c => navegador.desalojar(c))
  navegador.vaciar()
  assert.equal(navegador.vivos, 0)
  const creados = navegador.creados

  cuadro()
  assert.equal(navegador.creados, creados + 1, 'un contexto en el primer cuadro')
  assert.equal(tramoDe(engine, 'c').surface.state, 'live', 'el de mayor z primero')
  for (let i = 0; i < 10 && Object.values(estados(engine)).some(s => s !== 'live'); i++) cuadro()
  assert.equal(navegador.creados, creados + 2, 'uno por tramo, nunca uno por capa')
  assert.deepEqual(estados(engine), { a: 'live', b: 'live', c: 'live', d: 'live' })
  await esperar(0)
  ;['a', 'c'].forEach(id => assert.ok(dibujos(contextoDe(navegador, engine, id)) > 0, `el tramo de ${id} pinta al volver`))
  viejos.forEach(c => assert.equal(c.llamadasTrasPerdida, 0))
  intactos(navegador)
})

/* ── removeLayer ── */

test('removeLayer de un miembro no suelta el contexto compartido; el del último lo suelta y nada lo resucita', async () => {
  const { engine, navegador } = await montar()
  const compartido = contextoDe(navegador, engine, 'b')
  const marcador   = engine.getLayer('a').layer.surface.canvas
  engine.removeLayer('a')
  assert.equal(marcador.isConnected, false, 'el marcador se va del documento')
  assert.equal(compartido.estado, 'vivo', 'el tramo sigue vivo con b')
  assert.equal(estados(engine).b, 'live')
  sinResucitar(navegador)

  engine.removeLayer('b')
  await esperar(0)                                      // el tramo vacío se va al final de la microtarea
  assert.equal(compartido.estado, 'perdido', 'el último miembro se lleva el contexto')
  assert.equal(navegador.vivos, 1, 'queda el del otro tramo')
  assert.deepEqual(estados(engine), { c: 'live', d: 'live' })
  sinResucitar(navegador)
  assert.equal(navegador.vivos, 1)
  intactos(navegador)
})

/* ── Una capa oculta: su tramo prescindible ── */

test('un tramo con sus capas ocultas, desalojado, queda soltado; mostrar una lo toma y pinta en la misma tarea', async () => {
  const { engine, navegador } = await montar()
  engine.setLayerVisibility('c', false)
  engine.setLayerVisibility('d', false)
  for (let i = 0; i < 3; i++) cuadro()
  assert.equal(tramoDe(engine, 'c').surface.state, 'live', 'ocultarlas no suelta nada')
  const creados = navegador.creados
  navegador.desalojar(contextoDe(navegador, engine, 'c'))
  navegador.vaciar()
  for (let i = 0; i < 3; i++) cuadro()
  assert.equal(tramoDe(engine, 'c').surface.state, 'released', 'prescindible: no se recupera mientras no se vea')
  assert.equal(navegador.creados, creados, 'ni un getContext')

  engine.setLayerVisibility('c', true)
  assert.equal(navegador.creados, creados + 1, 'mostrarla toma el contexto en la tarea')
  assert.equal(estados(engine).c, 'live')
  await esperar(0)
  assert.ok(dibujos(contextoDe(navegador, engine, 'c')) > 0, 'y pinta')
  intactos(navegador)
})

test('una capa que se vacía deja a su tramo prescindible: bajo presión se suelta él y no el de una capa con contenido', async () => {
  const { engine, navegador, fuentes } = await montar()
  fuentes.c.set([])                                     // la capa se vacía después de haberse armado
  engine.removeLayer('d')
  await esperar(40)                                     // la Source avisa en su propio cuadro
  for (let i = 0; i < 3; i++) cuadro()
  assert.equal(engine.surfaces().find(s => s.layerId === 'c').hasContent, false)
  navegador.ajeno()
  navegador.desalojar(contextoDe(navegador, engine, 'a'))   // presión: el tramo con contenido pierde el suyo
  asentarCuadros(navegador)
  assert.equal(tramoDe(engine, 'c').surface.state, 'released', 'el tramo vacío se suelta')
  assert.deepEqual([estados(engine).a, estados(engine).b], ['live', 'live'], 'y el de contenido vuelve')
  intactos(navegador)
})

/* ── attachSource sobre un tramo sin contexto ── */

for (const [estado, llevar] of [
  ['perdido, antes de que llegue el evento', (n, c) => n.desalojar(c)],
  ['perdido, esperando su cuadro',           (n, c) => (n.desalojar(c), n.vaciar())],
]) {
  test(`attachSource de una capa con su tramo ${estado}: el tramo vuelve una vez, con la nueva en el lugar de la vieja`, async () => {
    const { map, navegador } = await armarVacio({ crearGl })
    mapa = map
    cuadros()
    const { engine } = map
    ;['p', 'q', 'r'].forEach(id => engine.addPointLayer({ id, source: fuente(2), iconSet, pane: 'comun', z: 450 }))
    await asentar(engine)
    const orden = () => (hijos => ['p', 'q', 'r'].sort((x, y) =>
      hijos.indexOf(engine.getLayer(x).layer.surface.canvas) - hijos.indexOf(engine.getLayer(y).layer.surface.canvas)))(
      [...engine.getLayer('p').layer.surface.canvas.parentNode.children])
    assert.deepEqual(orden(), ['p', 'q', 'r'])
    assert.equal(navegador.vivos, 1)

    llevar(navegador, contextoDe(navegador, engine, 'q'))
    const creados = navegador.creados
    engine.attachSource('q', fuente(3))
    assert.deepEqual(orden(), ['p', 'q', 'r'], 'en el lugar de la vieja')
    for (let i = 0; i < 6; i++) {
      navegador.vaciar()
      cuadro()
    }
    assert.equal(navegador.creados, creados + 1, 'el tramo vuelve una vez')
    assert.equal(navegador.vivos, 1)
    assert.deepEqual(estados(engine), { p: 'live', q: 'live', r: 'live' })
    assert.equal(tramoDe(engine, 'q'), tramoDe(engine, 'p'), 'la nueva queda en el mismo tramo')
    intactos(navegador)
  })
}

/* ── R4 y T3.8: WebGL bloqueado y saturación ── */

test('R4 mostrar una capa cuyo tramo soltó la presión no lanza aunque el navegador ya no dé WebGL', async () => {
  const { engine, navegador } = await montar()
  engine.setLayerVisibility('c', false)
  engine.setLayerVisibility('d', false)
  asentarCuadros(navegador)
  navegador.ajeno()
  navegador.desalojar(contextoDe(navegador, engine, 'a'))
  asentarCuadros(navegador)
  assert.equal(estados(engine).c, 'released')
  const original = navegador.getContext
  navegador.getContext = () => null                    // Chromium bloquea WebGL a la página tras varios reinicios de la GPU
  const error = mock.method(console, 'error', () => {})
  try {
    assert.doesNotThrow(() => engine.setLayerVisibility('c', true))
    assert.equal(error.mock.callCount(), 1, 'el error sale por consola')
  } finally {
    navegador.getContext = original
  }
  const fila = engine.surfaces().find(s => s.layerId === 'c')
  assert.deepEqual([fila.visible, fila.state], [true, 'released'])
})

test('T3.8 saturada, la de menor z queda sin superficie con un aviso; invalidateCanvas() lo reintenta y con cupo pinta', async () => {
  const { engine, navegador } = await montar({ techo: 3 })
  const warn = mock.method(console, 'warn', () => {})
  const ajenos = [navegador.ajeno(), navegador.ajeno()]
  asentarCuadros(navegador, ajenos, 8)
  assert.equal(tramoDe(engine, 'a').surface.state, 'released', 'dos tramos y dos ajenos en un techo de tres: cae el de menor z')
  assert.equal(tramoDe(engine, 'c').surface.state, 'live')
  assert.equal(warn.mock.callCount(), 1, 'un solo aviso por consola')

  navegador.desalojar(ajenos[0])                        // un ajeno se cierra, y nadie lo avisa
  asentarCuadros(navegador, ajenos.slice(1))
  assert.equal(tramoDe(engine, 'a').surface.state, 'released', 'sin una señal no se intenta')
  engine.invalidateCanvas()
  asentarCuadros(navegador, ajenos.slice(1))
  assert.equal(tramoDe(engine, 'a').surface.state, 'live')
  assert.deepEqual([estados(engine).a, estados(engine).b], ['live', 'live'])
  await esperar(0)
  assert.ok(dibujos(contextoDe(navegador, engine, 'a')) > 0, 'y pinta')
  assert.equal(warn.mock.callCount(), 1)
  intactos(navegador)
})

/* ── K3 y los reintentos de la saturación sobre tramos ── */

// jsdom no maqueta: el contenedor mide 800 × 600 para que el canvas del tramo tenga algo que copiar.
const medir = (engine, id) => {
  const contenedor = tramoDe(engine, id).surface.canvas.closest('.leaflet-container')
  Object.defineProperties(contenedor, { clientWidth: { value: 800, configurable: true }, clientHeight: { value: 600, configurable: true } })
  engine.syncSize()
}

// Un widget ajeno que se rehace cada vez que lo desalojan, en un canvas nuevo.
const insistente = (navegador, lista) => {
  const canvas = document.createElement('canvas')
  canvas.addEventListener('webglcontextlost', () => insistente(navegador, lista))
  lista.push(navegador.ajeno(canvas))
}

// Como `asentarCuadros`, con la pérdida que causa un cuadro avisada antes del rato ocioso, como en el navegador: el
// evento es una tarea que el desalojo encola, y el rato ocioso llega después.
const cuadrosEnOrden = (navegador, ajenos, n = 4) => {
  for (let i = 0; i < n; i++) {
    ajenos.forEach(a => a.estado === 'vivo' && a.gl.flush())
    navegador.vaciar()
    cuadro()
    navegador.vaciar()
    ocio()
  }
}

const microtareas = async () => {
  for (let i = 0; i < 8; i++) await null
}

// Dos pérdidas seguidas del tramo de arriba con un ajeno que llena el techo: la segunda es saturación, y la política
// suelta por voluntad propia al de abajo, que tiene menos z, para devolverle el cupo al de arriba.
const saturarAbajo = async ajenos => {
  const { engine, navegador } = await montar({ techo: 3 })
  medir(engine, 'a')
  await esperar(300)                                    // lo que Leaflet avisa del tamaño nuevo, antes de copiar
  mock.method(console, 'warn', () => {})
  insistente(navegador, ajenos)
  cuadrosEnOrden(navegador, ajenos, 3)
  navegador.desalojar(contextoDe(navegador, engine, 'c'))
  cuadrosEnOrden(navegador, ajenos, 3)
  assert.deepEqual([tramoDe(engine, 'a').surface.state, tramoDe(engine, 'c').surface.state], ['live', 'live'], 'la primera vuelve')
  navegador.desalojar(contextoDe(navegador, engine, 'c'))
  navegador.vaciar()
  return { engine, navegador }
}

test('K3 el tramo que la saturación suelta por voluntad propia queda con su imagen fija; vuelve y la quita en la tarea en que compone', async () => {
  const ajenos = []
  const { engine, navegador } = await saturarAbajo(ajenos)
  const abajo  = tramoDe(engine, 'a')
  const viejo  = abajo.surface.canvas
  assert.equal(abajo.surface.state, 'released', 'la segunda pérdida suelta al de abajo')
  const still = abajo.still
  assert.ok(still, 'con su imagen fija')
  assert.equal(still.className, STILL_CLASS)
  assert.equal(viejo.nextSibling, still, 'en el lugar de su canvas')
  assert.equal(tramoDe(engine, 'c').still, null, 'el de arriba perdió el suyo sin aviso: no copia')
  cuadrosEnOrden(navegador, ajenos, 3)
  await microtareas()
  assert.equal(tramoDe(engine, 'c').surface.state, 'live', 'el de arriba vuelve')
  assert.equal(abajo.still, still, 'y el de abajo sigue con su imagen')

  engine.invalidateCanvas()                             // una señal de cupo: hay lugar
  navegador.vaciar()
  cuadro()
  assert.equal(abajo.surface.state, 'live')
  assert.notEqual(abajo.surface.canvas, viejo)
  assert.equal(abajo.surface.canvas.style.visibility, 'hidden', 'el canvas nuevo, oculto bajo la imagen hasta componer')
  assert.equal(abajo.still, still)
  await microtareas()                                   // la misma tarea
  assert.equal(abajo.still, null, 'compuso: la imagen se va')
  assert.equal(abajo.surface.canvas.style.visibility, '')
  assert.equal(still.isConnected, false)
  assert.ok(dibujos(contextoDe(navegador, engine, 'a')) > 0, 'y el tramo pinta')
  intactos(navegador)
})
