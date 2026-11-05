// La política de contextos (src/render/gl-budget.js) en un mapa de elementos REALES (Lit + custom elements + Leaflet en jsdom),
// con el modelo de 13 capas del Mapa Geotáctico (test-helpers/modelo-capas.mjs) y el navegador falso, que desaloja por último
// flush y comparte el techo entre ventanas. Lo que la política decide con las capas de verdad:
//
//   T3.1  el montaje no toma contexto para las cuatro capas vacías, dos líneas del kit y la espiral y la sub-espiral del cluster:
//         las toma en ratos ociosos, de a una; una vacía que recibe su primer dato antes lo toma en esa tarea y pinta
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

// Escenarios de la política con un contexto por capa (techo de 16 con 13 capas y ajenos, rotaciones, una capa que cae sola).
// Con tramos el modelo de 13 es un contexto y esos escenarios no existen; los que siguen siendo contrato
// están reescritos sobre dos tramos en `tramos-recuperacion.test.mjs`.
const POR_CAPA = 'un contexto por capa: se rediseña sobre tramos'

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

// Las prescindibles del modelo son las capas sin contenido: las dos líneas que el kit monta «siempre, también vacías», y la
// espiral y la sub-espiral del cluster, que esperan una expansión. Se leen del motor apenas montado.
const vaciasDe   = engine => engine.surfaces().filter(s => !s.hasContent).map(s => s.layerId)
const superficie = (engine, id) => (r => (r.layer ?? r.editor).surface)(engine.getLayer(id))
const contextoDe = (navegador, engine, id) => navegador.contextos.find(c => c.gl === superficie(engine, id).gl)
const estados    = engine => Object.fromEntries(engine.surfaces().map(s => [s.layerId, s.state]))
const dibujos    = contexto => contexto.gl.llamadas.filter(([m]) => /^draw/.test(m)).length
const propias    = navegador => navegador.contextos.filter(c => !c.ajeno).length
// Las necesarias del modelo, de menor a mayor z: el orden en que quedan sin superficie cuando falta cupo.
const necesariasPorZ = engine => engine.surfaces().filter(s => s.hasContent).sort((a, b) => a.z - b.z).map(s => s.layerId)

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

// Con tramos, las cuatro vacías entran al tramo de las demás: no piden contexto, ni al montar ni en los ratos ociosos, y
// no se arman hasta tener contenido.
test('T3.1 el montaje toma un contexto para todo el modelo: las cuatro capas vacías entran al tramo sin armarse', async () => {
  await esperar(20)                                     // los ratos ociosos de los tests de antes ya pasaron
  const ociosos = []
  globalThis.requestIdleCallback = cb => ociosos.push(cb)
  try {
    const { map, navegador } = await armar(13, 'react', { crearGl, asentado: false })
    limpiar.push(() => map.remove())
    const { engine } = map
    const vacias = vaciasDe(engine)
    assert.equal(vacias.length, 4, 'las dos líneas del kit, y la espiral y la sub-espiral del cluster')
    assert.deepEqual([navegador.creados, navegador.vivos], [1, 1], 'un tramo, un contexto')
    vacias.forEach(id => assert.ok(superficie(engine, id).canvas.isConnected, `el marcador de ${id} guarda su lugar`))

    for (let i = 0; i < 5; i++) ociosos.splice(0).forEach(cb => cb({ didTimeout: false, timeRemaining: () => 50 }))
    assert.deepEqual([navegador.creados, navegador.vivos, navegador.desalojados], [1, 1, 0], 'los ratos ociosos no toman nada')
    assert.deepEqual(vacias.map(id => estados(engine)[id]), ['none', 'none', 'none', 'none'], 'vacías: sin armar en su tramo')
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
  test(`T3.5 13 capas + ${n} ajenos que dibujan: caen primero las prescindibles y, sin cupo, las necesarias de menor z`, { skip: POR_CAPA }, async () => {
    const { engine, navegador } = await montar()
    const orden   = necesariasPorZ(engine)
    const vacias  = vaciasDe(engine)
    const antes   = propias(navegador)
    const ajenos  = []
    for (let k = 0; k < n; k++) {
      ajenos.push(navegador.ajeno())
      asentarCuadros(navegador, ajenos)
      const e = estados(engine)
      vacias.some(id => e[id] === 'live') && orden.forEach(id =>
        assert.equal(e[id], 'live', `con una prescindible viva, ${id} no queda sin contexto (ajeno ${k + 1})`))
      assert.ok(Object.values(e).every(s => s !== 'lost'), `ninguna queda esperando una recuperación (ajeno ${k + 1})`)
    }

    const sinLugar   = 13 - (16 - n)
    const vaciasFuera = Math.min(vacias.length, sinLugar)
    const fuera      = Math.max(0, sinLugar - vacias.length)
    const e          = estados(engine)
    assert.equal(vacias.filter(id => e[id] === 'released').length, vaciasFuera)
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

test('T3.6 con ajenos que se rehacen al perder: una rotación, la de menor z queda sin superficie con su señal, y sin bucle', { skip: POR_CAPA }, async () => {
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
  const orden  = necesariasPorZ(engine)
  const vacias = vaciasDe(engine)

  navegador.ajeno()
  insistente()                                          // trece y dos ajenos
  navegador.desalojar(contextoDe(navegador, engine, 'enlaces'))
  asentarCuadros(navegador)                             // la presión suelta las vacías y enlaces vuelve: las propias, más jóvenes
  assert.deepEqual(vacias.map(id => estados(engine)[id]), ['released', 'released', 'released', 'released'])
  ;[1, 2, 3, 4, 5, 6, 7].forEach(insistente)           // el techo se llena y los ajenos se desalojan entre sí, y a una propia
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

test('T3.7 un mapa montado por portal en otra ventana comparte el registro: perder una necesaria en uno suelta las vacías del otro', { skip: POR_CAPA }, async () => {
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

test('T3.8 invalidateCanvas() vuelve a intentar lo que la saturación dejó sin superficie, y con cupo lo consigue', { skip: POR_CAPA }, async () => {
  const { engine, navegador } = await montar()
  const orden  = necesariasPorZ(engine)
  const ajenos = Array.from({ length: 8 }, () => navegador.ajeno())
  asentarCuadros(navegador, ajenos)
  assert.equal(estados(engine)[orden[0]], 'released', 'trece, menos cuatro vacías, más ocho ajenos: falta un lugar')

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
      assert.equal(superficie(engine, id).tramo.surface.state, 'live', 'el contexto del tramo vuelve en el cuadro siguiente')
      for (let i = 0; i < 20 && estados(engine)[id] !== 'live'; i++) cuadro()   // los miembros, en tandas de ≤ 8 ms
      assert.equal(estados(engine)[id], 'live')
      intactos(navegador)
    })
  }
}

test('quitar un mapa en pleno gesto cierra su gesto: los otros mapas del realm recuperan en el cuadro siguiente', async () => {
  const { map, navegador } = await armarVacio({ crearGl })
  limpiar.push(() => map.remove())
  const otro = document.createElement('cristae-map')
  otro.style.cssText = 'display:block;width:800px;height:600px'
  document.body.appendChild(otro)
  limpiar.push(() => otro.remove())
  await esperar(40)
  const linea = { id: 1, pts: [[0, 0], [1, 1]], color: '#00f', weight: 2, opacity: 1 }
  map.engine.addLineLayer({ id: 'aqui', accessors: LINEA, data: [linea] })
  otro.engine.addLineLayer({ id: 'alla', accessors: LINEA, data: [linea] })
  await esperar(40)
  cuadros()
  otro.engine.getLeafletMap().fire('movestart')
  navegador.desalojar(contextoDe(navegador, map.engine, 'aqui'))
  asentarCuadros(navegador)
  assert.equal(estados(map.engine).aqui, 'lost', 'el gesto del otro mapa frena la recuperación')
  otro.engine.destroy()
  cuadro()
  assert.equal(estados(map.engine).aqui, 'live', 'sin esperar el plazo de un gesto sin fin')
  intactos(navegador)
})

/* ── Quitar en cada estado de la política ── */

test('quitar una capa sin superficie por saturación, o una vacía que esperaba su rato ocioso, no toma nada', { skip: POR_CAPA }, async () => {
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
    const ajenos = Array.from({ length: 8 }, () => navegador.ajeno())   // nueve necesarias, dos vacías tomadas y ocho ajenos
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

/* ── Revisión de la tanda 2b (etapa3/REVISION.md) ── */

const linea = (id, k = 0) => ({ id, pts: [[0, 0], [1 + k, 1]], color: '#00f', weight: 2, opacity: 1 })

test('R1: tras un reinicio de la GPU, los datos de tres capas de líneas en un mismo cuadro no toman contexto en ese cuadro: vuelven de a una', async () => {
  const { map, navegador } = await armarVacio({ crearGl })
  limpiar.push(() => map.remove())
  const { engine } = map
  const handles = ['l1', 'l2', 'l3'].map((id, i) => engine.addLineLayer({ id, accessors: LINEA, data: [linea(1, i)] }))
  await esperar(40)
  await asentar(engine)
  cuadros()
  const vivas = navegador.contextos.filter(c => c.estado === 'vivo')
  assert.equal(vivas.length, 1, 'las tres líneas forman un tramo')
  vivas.forEach(c => navegador.desalojar(c))           // reinicio de la GPU
  navegador.vaciar()
  assert.deepEqual(Object.values(estados(engine)), ['lost', 'lost', 'lost'])

  // El cuadro de jsdom corre en una tarea los avisos de las tres Sources: una marca antes y otra después lo acotan.
  let antes = -1, despues = -1
  window.requestAnimationFrame(() => antes = navegador.creados)
  handles.forEach((h, i) => h.set([linea(1, i), linea(2, i)]))   // tiempo real: un dato nuevo a cada capa
  await esperar(1)
  window.requestAnimationFrame(() => despues = navegador.creados)
  await esperar(60)
  assert.ok(antes >= 0 && despues >= 0)
  assert.equal(despues - antes, 0, 'el dato no adelanta a la recuperación, que va de a una por cuadro')
  const creados = navegador.creados
  cuadro()
  assert.equal(navegador.creados, creados + 1, 'el cuadro de la política toma el del tramo')
  for (let i = 0; i < 20 && Object.values(estados(engine)).some(e => e !== 'live'); i++) cuadro()   // tandas de ≤ 8 ms
  assert.deepEqual(Object.values(estados(engine)), ['live', 'live', 'live'])
  assert.equal(navegador.creados, creados + 1, 'las tres sobre ese contexto')
})

test('R4: habilitar el host de vehículos tras una presión que soltó sus capas toma un contexto en el clic y las demás en los cuadros siguientes', { skip: POR_CAPA }, async () => {
  const { engine, navegador } = await montar()
  engine.setLayerEnabled('veh', false)
  asentarCuadros(navegador)
  navegador.ajeno()
  navegador.desalojar(contextoDe(navegador, engine, 'enlaces'))   // presión: una necesaria pierde el suyo
  asentarCuadros(navegador)
  assert.equal(estados(engine).veh, 'released')
  const desde = navegador.creados
  engine.setLayerEnabled('veh', true)                  // un clic: una tarea
  assert.equal(navegador.creados - desde, 1, 'una adquisición por tarea, nunca varias (ORACULO §5.5)')
  asentarCuadros(navegador)
  const vacias = vaciasDe(engine)
  const e      = estados(engine)
  assert.deepEqual(Object.keys(e).filter(id => e[id] !== 'live'), vacias, 'las demás vuelven en los cuadros siguientes; las vacías siguen soltadas')
  intactos(navegador)
})

test('R4: mostrar una capa que la presión soltó no lanza aunque el navegador ya no dé WebGL', { skip: POR_CAPA }, async () => {
  const { engine, navegador } = await montar()
  engine.setLayerVisibility('lugares', false)
  asentarCuadros(navegador)
  navegador.ajeno()
  navegador.desalojar(contextoDe(navegador, engine, 'enlaces'))
  asentarCuadros(navegador)
  assert.equal(estados(engine).lugares, 'released')
  const original = navegador.getContext
  navegador.getContext = () => null                    // Chromium bloquea WebGL a la página tras varios reinicios de la GPU
  const error = mock.method(console, 'error', () => {})
  try {
    assert.doesNotThrow(() => engine.setLayerVisibility('lugares', true))
    assert.equal(error.mock.callCount(), 1, 'el error sale por consola')
  } finally {
    navegador.getContext = original
    error.mock.restore()
  }
  const fila = engine.surfaces().find(s => s.layerId === 'lugares')
  assert.deepEqual([fila.visible, fila.state], [true, 'released'])
})

test('R5: el registro del realm no vuelve a tomar contextos para un mapa cuya ventana se cerró sin quitarlo', async () => {
  const { map, navegador } = await armarVacio({ crearGl })
  limpiar.push(() => map.remove())
  const segunda = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
  instalarNavegador(segunda.window, { navegador })
  const docB = segunda.window.document
  limpiar.push(() => navegador.desinstalar(docB))
  const otro = document.createElement('cristae-map')
  otro.style.cssText = 'display:block;width:800px;height:600px'
  docB.body.appendChild(otro)
  await esperar(40)
  map.engine.addLineLayer({ id: 'aqui', accessors: LINEA, data: [linea(1)] })
  ;['b1', 'b2', 'b3'].forEach((id, i) => otro.engine.addLineLayer({ id, accessors: LINEA, data: [linea(1, i)] }))
  await esperar(40)
  await asentar(otro.engine)
  cuadros()
  const enB = () => navegador.contextos.filter(c => c.estado === 'vivo' && c.paneEl?.ownerDocument === docB)
  assert.equal(enB().length, 1, 'las tres líneas de B forman un tramo: un contexto')

  // En Chromium el documento de una ventana cerrada queda sin ventana con sus nodos colgados (sin disconnectedCallback); jsdom
  // los desconectaría en close(), así que se simula: sin `defaultView`, y el proceso suelta sus contextos.
  Object.defineProperty(docB, 'defaultView', { configurable: true, get: () => null })
  limpiar.push(() => {
    delete docB.defaultView
    otro.remove()
  })
  enB().forEach(c => navegador.desalojar(c))
  const desde = navegador.creados
  asentarCuadros(navegador, [], 6)
  navegador.desalojar(contextoDe(navegador, map.engine, 'aqui'))   // y en la ventana viva un ajeno le quita el suyo a la de A
  asentarCuadros(navegador, [], 6)
  const zombis = navegador.contextos.slice(desde).filter(c => (c.paneEl ?? c.canvas.parentNode)?.ownerDocument === docB)
  assert.equal(zombis.length, 0, 'ningún contexto para un documento sin ventana')
  assert.equal(estados(map.engine).aqui, 'live', 'la de la ventana viva vuelve')
  assert.deepEqual(Object.values(estados(otro.engine)), ['released', 'released', 'released'])
})
