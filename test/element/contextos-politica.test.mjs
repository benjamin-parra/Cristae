// La política de contextos (src/render/gl-budget.js) en un mapa de elementos REALES (Lit + custom elements + Leaflet en jsdom),
// con el modelo de 13 capas del Mapa Geotáctico (test-helpers/modelo-capas.mjs) y el navegador falso, que desaloja por último
// flush y comparte el techo entre ventanas. Lo que la política decide con las capas de verdad:
//
//   T3.1  el montaje no toma contexto para las dos líneas vacías del kit: las toma en ratos ociosos, de a una; una vacía que
//         recibe su primer dato antes lo toma en esa tarea y pinta
//   T3.2  una capa oculta conserva su contexto: alternarla no toma ni suelta nada
//   T3.5  con 4, 8 y 12 ajenos que dibujan, caen primero las prescindibles, ninguna necesaria queda sin contexto mientras
//         quede una prescindible viva, y sin cupo quedan sin superficie las de menor z, con una rotación como mucho
//   T3.6  con ajenos que se rehacen al perder: una rotación, la de menor z queda sin superficie con su señal, y sin bucle
//   T3.7  un mapa montado por portal en otra ventana del mismo realm comparte el registro: la presión en uno suelta las
//         prescindibles del otro
//   T3.8  `invalidateCanvas()` es una señal de cupo: lo que la saturación dejó sin superficie vuelve si hay lugar
//   H5    ninguna capa vuelve a tomar su contexto en pleno gesto del motor —zoom, pellizco, vuelo, arrastre—, tampoco las de
//         puntos, que no siguen la transición del zoom
//
// Los cuadros y los ratos ociosos los corre el test (`cuadro()`, `ocio()`), y los eventos del navegador llegan con
// `navegador.vaciar()`. Entre cuadro y cuadro hay un rato ocioso, como en un navegador con el hilo libre.
// Corre con: node --test test/element/contextos-politica.test.mjs
//
// El harness va PRIMERO: window, customElements y lo que Lit toca al evaluar.
import { armar, armarVacio, asentar, esperar, LINEA } from '../../test-helpers/modelo-capas.mjs'
import { instalarNavegador } from '../../test-helpers/navegador-falso.mjs'
import { makeEditGl, makePickSpy } from '../../test-helpers/engine-stub.mjs'
import { afterEach, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'

/* ── Cuadros a mano ── */

const rafPrevio    = globalThis.requestAnimationFrame
const cancelPrevio = globalThis.cancelAnimationFrame
const agendados    = new Map()
const ociosos      = []
let serie          = 2_000_000                  // lejos de los ids del rAF de jsdom, que se cancelan por el mismo nombre
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

// Se quita el mapa antes de correr lo agendado: quitar una viva es una señal de cupo, y el cuadro que agenda tiene que correr
// acá, con nada que tomar, o la política lo esperaría en el test siguiente.
const limpiar = []
afterEach(() => {
  limpiar.splice(0).forEach(fn => fn())
  for (let i = 0; (agendados.size || ociosos.length) && i < 30; i++) {
    cuadro()
    ocio()
  }
  agendados.clear()
  globalThis.requestAnimationFrame = rafPrevio
  globalThis.cancelAnimationFrame  = cancelPrevio
  delete globalThis.requestIdleCallback
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

const montar = async (opciones = {}) => {
  const { map, navegador } = await armar(13, 'react', { crearGl, ...opciones })
  limpiar.push(() => map.remove())
  await esperar(40)
  cuadros()
  return { map, engine: map.engine, navegador }
}

const VACIAS     = ['medicion', 'rutas']                // las dos líneas que el kit monta «siempre, también vacías»
const superficie = (engine, id) => (r => (r.layer ?? r.editor).surface)(engine.getLayer(id))
const contextoDe = (navegador, engine, id) => navegador.contextos.find(c => c.gl === superficie(engine, id).gl)
const estados    = engine => Object.fromEntries(engine.surfaces().map(s => [s.layerId, s.state]))
const dibujos    = contexto => contexto.gl.llamadas.filter(([m]) => /^draw/.test(m)).length
const propias    = navegador => navegador.contextos.filter(c => !c.ajeno).length
// Las necesarias del modelo, de menor a mayor z: el orden en que quedan sin superficie cuando falta cupo.
const necesariasPorZ = engine => engine.surfaces().filter(s => !VACIAS.includes(s.layerId)).sort((a, b) => a.z - b.z).map(s => s.layerId)

const intactos = navegador => {
  const tocados = navegador.contextos.filter(c => c.llamadasTrasPerdida).map(c => `#${c.id} ${c.pane}: ${c.llamadasTrasPerdida}`)
  assert.deepEqual(tocados, [], 'ninguna llamada a un contexto después de perderse')
  assert.deepEqual(navegador.violaciones, [], 'ningún recurso de un contexto usado en otro')
}

// Un paso: lo que el navegador avisó, y unos cuadros de la política con su rato ocioso. Los ajenos dibujan en cada cuadro,
// y dibujar con flush es lo que renueva un contexto en Chromium.
const asentarCuadros = (navegador, ajenos = [], n = 4) => {
  for (let i = 0; i < n; i++) {
    ajenos.forEach(a => a.estado === 'vivo' && a.gl.flush())
    navegador.vaciar()
    cuadro()
    ocio()
  }
}

/* ── T3.1 · el alta difiere las vacías ── */

test('T3.1 el montaje no toma contexto para las dos líneas vacías: las toma en ratos ociosos, de a una, y creados == vivos', async () => {
  await esperar(20)                                     // los ratos ociosos de los tests de antes ya pasaron
  const ociosos = []
  globalThis.requestIdleCallback = cb => ociosos.push(cb)
  try {
    const { map, navegador } = await armar(13, 'react', { crearGl, asentado: false })
    limpiar.push(() => map.remove())
    const { engine } = map
    assert.deepEqual(VACIAS.map(id => estados(engine)[id]), ['none', 'none'], 'las vacías sólo dejaron su marcador')
    assert.deepEqual([navegador.creados, navegador.vivos], [11, 11])
    VACIAS.forEach(id => assert.ok(superficie(engine, id).canvas.isConnected, `el marcador de ${id} guarda su lugar`))

    const tomadas = []
    for (let i = 0; i < 3; i++) {
      ociosos.splice(0).forEach(cb => cb({ didTimeout: false, timeRemaining: () => 50 }))
      tomadas.push(navegador.creados)
    }
    assert.deepEqual(tomadas, [12, 13, 13], 'una por rato ocioso')
    assert.deepEqual([navegador.creados, navegador.vivos, navegador.desalojados], [13, 13, 0])
    const z = Object.fromEntries(engine.surfaces().map(s => [s.layerId, s.z]))
    const primera = navegador.contextos[11].pane
    assert.equal(primera, `cristae-line-${z.rutas > z.medicion ? 'rutas' : 'medicion'}`, 'la de mayor z primero')
    VACIAS.forEach(id => assert.equal(dibujos(contextoDe(navegador, engine, id)), 0, `${id} no dibuja: no tiene qué`))
    intactos(navegador)
  } finally {
    delete globalThis.requestIdleCallback
  }
})

test('T3.1 una vacía que recibe su primer dato antes del rato ocioso toma el contexto en esa tarea y pinta', async () => {
  await esperar(20)
  const ociosos = []
  globalThis.requestIdleCallback = cb => ociosos.push(cb)
  try {
    const { map, navegador } = await armarVacio({ crearGl })
    limpiar.push(() => map.remove())
    const handle = map.engine.addLineLayer({ id: 'ruta', accessors: LINEA, data: [] })
    await esperar(40)
    assert.equal(navegador.creados, 0)
    handle.set([{ id: 1, pts: [[0, 0], [1, 1]], color: '#00f', weight: 2, opacity: 1 }])
    await esperar(40)                                   // la Source avisa en el cuadro de jsdom
    assert.equal(estados(map.engine).ruta, 'live')
    assert.equal(navegador.creados, 1)
    assert.ok(dibujos(navegador.contextos[0]) > 0, 'y pintó')
    ociosos.splice(0).forEach(cb => cb({ didTimeout: false, timeRemaining: () => 50 }))
    assert.equal(navegador.creados, 1, 'el rato ocioso no la toma de nuevo')
  } finally {
    delete globalThis.requestIdleCallback
  }
})

/* ── T3.2 · oculta conserva su contexto ── */

test('T3.2 una capa oculta conserva su contexto: diez alternancias no toman ni sueltan nada, y mostrarla pinta', async () => {
  const { engine, navegador } = await montar()
  const { creados, liberados } = navegador
  const contexto = contextoDe(navegador, engine, 'enlaces')
  for (let i = 0; i < 10; i++) {
    engine.setLayerVisibility('enlaces', false)
    cuadro()
    engine.setLayerVisibility('enlaces', true)
    cuadro()
  }
  assert.deepEqual([navegador.creados, navegador.liberados], [creados, liberados])
  assert.equal(contextoDe(navegador, engine, 'enlaces'), contexto, 'el mismo contexto de siempre')
  assert.ok(dibujos(contexto) > 10)
})

/* ── T3.5 · ajenos que dibujan ── */

for (const n of [4, 8, 12]) {
  test(`T3.5 13 capas + ${n} ajenos que dibujan: caen primero las prescindibles y, sin cupo, las necesarias de menor z`, async () => {
    const { engine, navegador } = await montar()
    const orden   = necesariasPorZ(engine)
    const antes   = propias(navegador)
    const ajenos  = []
    for (let k = 0; k < n; k++) {
      ajenos.push(navegador.ajeno())
      asentarCuadros(navegador, ajenos)
      const e = estados(engine)
      VACIAS.some(id => e[id] === 'live') && orden.forEach(id =>
        assert.equal(e[id], 'live', `con una prescindible viva, ${id} no queda sin contexto (ajeno ${k + 1})`))
      assert.ok(Object.values(e).every(s => s !== 'lost'), `ninguna queda esperando una recuperación (ajeno ${k + 1})`)
    }

    const sinLugar   = 13 - (16 - n)
    const vaciasFuera = Math.min(2, sinLugar)
    const fuera      = Math.max(0, sinLugar - 2)
    const e          = estados(engine)
    assert.equal(VACIAS.filter(id => e[id] === 'released').length, vaciasFuera)
    assert.deepEqual(orden.map(id => e[id]), orden.map((_, i) => i < fuera ? 'released' : 'live'),
      `sin superficie quedan las ${fuera} necesarias de menor z`)
    assert.equal(navegador.vivos, 16)
    assert.ok(propias(navegador) - antes <= 2, `una rotación como mucho: ${propias(navegador) - antes} getContext propios`)
    const quietos = navegador.creados
    asentarCuadros(navegador, ajenos, 10)
    assert.equal(navegador.creados, quietos, 'y nada más después')
    intactos(navegador)
  })
}

/* ── T3.6 · ajenos que se rehacen al perder ── */

test('T3.6 con ajenos que se rehacen al perder: una rotación, la de menor z queda sin superficie con su señal, y sin bucle', async () => {
  const { engine, navegador } = await montar()
  const avisos = []
  engine.on('surfacechange', d => avisos.push([d.layerId, d.state]))
  const warn = mock.method(console, 'warn', () => {})
  limpiar.push(() => warn.mock.restore())
  const insistente = () => {
    const canvas = document.createElement('canvas')
    canvas.addEventListener('webglcontextlost', insistente)
    navegador.ajeno(canvas)
  }
  const orden = necesariasPorZ(engine)

  navegador.ajeno()
  insistente()                                          // trece y dos ajenos
  navegador.desalojar(contextoDe(navegador, engine, 'enlaces'))
  asentarCuadros(navegador)                             // la presión suelta las vacías y enlaces vuelve: las propias, más jóvenes
  assert.deepEqual(VACIAS.map(id => estados(engine)[id]), ['released', 'released'])
  ;[1, 2, 3, 4, 5].forEach(insistente)                  // el techo se llena y los ajenos se desalojan entre sí, y a una propia
  asentarCuadros(navegador, [], 10)

  const e = estados(engine)
  const sin = orden.filter(id => e[id] !== 'live')
  assert.deepEqual(sin, [orden[0]], 'una sola sin superficie, y es la de menor z')
  assert.equal(e[orden[0]], 'released')
  assert.deepEqual(avisos.filter(([id]) => id === orden[0]).at(-1), [orden[0], 'released'], 'con su señal')
  assert.ok(warn.mock.callCount() <= 1, 'y un aviso por consola como mucho')
  const quietos = navegador.creados
  asentarCuadros(navegador, [], 20)
  assert.equal(navegador.creados, quietos, 'sin bucle')
  intactos(navegador)
})

/* ── T3.7 · dos ventanas, un realm ── */

test('T3.7 un mapa montado por portal en otra ventana comparte el registro: perder una necesaria en uno suelta las vacías del otro', async () => {
  const { map, navegador } = await armarVacio({ crearGl })
  limpiar.push(() => map.remove())
  const segunda = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
  instalarNavegador(segunda.window, { navegador })      // el mismo proceso de render: un techo para las dos
  limpiar.push(() => navegador.desinstalar(segunda.window.document))
  const otro = document.createElement('cristae-map')    // lo crea el JS de esta ventana y lo cuelga en la otra, como un portal
  otro.style.cssText = 'display:block;width:800px;height:600px'
  segunda.window.document.body.appendChild(otro)
  limpiar.push(() => otro.remove())
  await esperar(40)

  const linea = { id: 1, pts: [[0, 0], [1, 1]], color: '#00f', weight: 2, opacity: 1 }
  map.engine.addLineLayer({ id: 'aqui', accessors: LINEA, data: [linea] })
  otro.engine.addLineLayer({ id: 'alla', accessors: LINEA, data: [linea] })
  otro.engine.addLineLayer({ id: 'vacia', accessors: LINEA, data: [] })
  await esperar(40)
  await asentar(otro.engine)
  cuadros()
  assert.equal(superficie(otro.engine, 'vacia').canvas.ownerDocument, segunda.window.document)
  assert.deepEqual([estados(map.engine).aqui, estados(otro.engine).alla, estados(otro.engine).vacia], ['live', 'live', 'live'])

  navegador.desalojar(contextoDe(navegador, map.engine, 'aqui'))
  navegador.vaciar()
  assert.equal(estados(otro.engine).vacia, 'released', 'la vacía de la otra ventana devolvió su cupo')
  cuadro()
  assert.equal(estados(map.engine).aqui, 'live')
  assert.equal(estados(otro.engine).alla, 'live')
  intactos(navegador)
})

/* ── T3.8 · invalidateCanvas es una señal de cupo ── */

test('T3.8 invalidateCanvas() vuelve a intentar lo que la saturación dejó sin superficie, y con cupo lo consigue', async () => {
  const { engine, navegador } = await montar()
  const orden  = necesariasPorZ(engine)
  const ajenos = Array.from({ length: 6 }, () => navegador.ajeno())
  asentarCuadros(navegador, ajenos)
  assert.equal(estados(engine)[orden[0]], 'released', 'trece, menos dos vacías, más seis ajenos: falta un lugar')

  navegador.desalojar(ajenos[0])                        // un ajeno se cierra, y nadie lo avisa
  asentarCuadros(navegador, ajenos.slice(1))
  assert.equal(estados(engine)[orden[0]], 'released', 'sin una señal no se intenta')
  engine.invalidateCanvas()
  asentarCuadros(navegador, ajenos.slice(1))
  assert.equal(estados(engine)[orden[0]], 'live')
  assert.ok(dibujos(contextoDe(navegador, engine, orden[0])) > 0, 'y pinta')
  intactos(navegador)
})

/* ── H5 · nada vuelve en pleno gesto del motor ── */

for (const [gesto, abre, cierra] of [
  ['un zoom animado o un pellizco', 'zoomstart', 'zoomend'],
  ['un vuelo o un arrastre',        'movestart', 'moveend'],
]) {
  for (const id of ['lugares', 'geo']) {
    test(`H5 ${id} perdida en ${gesto} espera a que el motor diga que terminó, y vuelve en el cuadro siguiente`, async () => {
      const { engine, navegador } = await montar()
      const leaflet = engine.getLeafletMap()
      leaflet.fire(abre)
      navegador.desalojar(contextoDe(navegador, engine, id))
      asentarCuadros(navegador)
      assert.equal(estados(engine)[id], 'lost', 'en pleno gesto no toma nada')
      assert.equal(agendados.size, 0, 'ni agenda cuadros')
      leaflet.fire(cierra)
      cuadro()
      assert.equal(estados(engine)[id], 'live')
      intactos(navegador)
    })
  }
}

/* ── Quitar en cada estado de la política ── */

test('quitar una capa sin superficie por saturación, o una vacía que esperaba su rato ocioso, no toma nada', async () => {
  const ociosos = []
  await esperar(20)
  globalThis.requestIdleCallback = cb => ociosos.push(cb)
  try {
    const { engine, navegador } = await montar({ asentado: false })
    const orden  = necesariasPorZ(engine)
    assert.equal(estados(engine).rutas, 'none')
    engine.removeLayer('rutas')
    ociosos.splice(0).forEach(cb => cb({ didTimeout: false, timeRemaining: () => 50 }))
    ociosos.splice(0).forEach(cb => cb({ didTimeout: false, timeRemaining: () => 50 }))
    const ajenos = Array.from({ length: 6 }, () => navegador.ajeno())   // once necesarias, una vacía y seis ajenos
    asentarCuadros(navegador, ajenos)
    assert.equal(estados(engine)[orden[0]], 'released')
    const creados = navegador.creados
    engine.removeLayer(orden[0])
    asentarCuadros(navegador, ajenos, 6)
    assert.equal(navegador.creados, creados, 'ningún getContext')
    assert.ok(!engine.surfaces().some(s => s.layerId === 'rutas' || s.layerId === orden[0]))
    intactos(navegador)
  } finally {
    delete globalThis.requestIdleCallback
  }
})
