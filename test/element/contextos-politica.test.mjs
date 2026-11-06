// La política de contextos (src/render/gl-budget.js) en un mapa de elementos REALES (Lit + custom elements + Leaflet en jsdom)
// y el navegador falso, que desaloja por último flush y comparte el techo entre ventanas. La política ve una superficie por
// tramo (SPECS §10.1): el modelo de 13 capas del Mapa Geotáctico (test-helpers/modelo-capas.mjs) es un solo tramo, así que
// lo que depende del techo corre sobre seis tramos separados por etiquetas (`montarTramos`). Lo que la política decide:
//
//   T3.1  el montaje toma un contexto para el modelo de 13: sus cuatro capas vacías entran al tramo sin armarse; una vacía
//         que recibe su primer dato toma el contexto en esa tarea y pinta
//   T3.2  una capa oculta conserva su contexto: alternarla no toma ni suelta nada
//   T3.5  con ajenos que dibujan, caen primero los tramos prescindibles, ningún necesario queda sin contexto mientras quede
//         un prescindible vivo, y sin cupo quedan sin superficie los de menor z, con una rotación como mucho
//   T3.6  con ajenos que se rehacen al perder: una rotación, el tramo de menor z queda sin superficie con su señal, y sin bucle
//   T3.7  un mapa montado por portal en otra ventana del mismo realm comparte el registro: la presión en uno suelta los
//         tramos prescindibles del otro
//   H5    ningún tramo vuelve a tomar su contexto en pleno gesto del motor —zoom, pellizco, vuelo, arrastre—, tampoco el de
//         las capas de puntos, que no siguen la transición del zoom
//
// T3.8 (`invalidateCanvas()` como señal de cupo) y R4 con WebGL bloqueado están en `tramos-recuperacion.test.mjs`.
//
// Los cuadros y los ratos ociosos los corre el test (`cuadro()`, `ocio()`), y los eventos del navegador llegan con
// `navegador.vaciar()`. Entre cuadro y cuadro hay un rato ocioso, como en un navegador con el hilo libre.
// Corre con: node --test test/element/contextos-politica.test.mjs
//
// El harness va PRIMERO: window, customElements y lo que Lit toca al evaluar.
import { armar, armarVacio, asentar, esperar, fuente, iconSet, LINEA, POLI } from '../../test-helpers/modelo-capas.mjs'
import { instalarNavegador } from '../../test-helpers/navegador-falso.mjs'
import { window } from '../../test-helpers/jsdom-elementos.mjs'
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

// Las prescindibles del modelo son las capas sin contenido: las dos líneas que el kit monta «siempre, también vacías», y la
// espiral y la sub-espiral del cluster, que esperan una expansión. Se leen del motor apenas montado.
const vaciasDe   = engine => engine.surfaces().filter(s => !s.hasContent).map(s => s.layerId)
const superficie = (engine, id) => (r => (r.layer ?? r.editor).surface)(engine.getLayer(id))
const contextoDe = (navegador, engine, id) => navegador.contextos.find(c => c.gl === superficie(engine, id).gl)
const estados    = engine => Object.fromEntries(engine.surfaces().map(s => [s.layerId, s.state]))
const dibujos    = contexto => contexto.gl.llamadas.filter(([m]) => /^draw/.test(m)).length
const propias    = navegador => navegador.contextos.filter(c => !c.ajeno).length

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

/* ── Seis tramos ── */

// Cada tramo se nombra por una de sus capas. Los necesarios, de menor a mayor z: el orden en que quedan sin superficie
// cuando falta cupo. Los vacíos tienen una sola línea sin datos, y son los prescindibles del modelo.
const MIEMBROS   = {
  geo:      ['geo', 'ruta'],
  veh:      ['veh', 'veh:badge'],
  medicion: ['medicion'],
  lugares:  ['lugares', 'busqueda'],
  rutas:    ['rutas'],
  enlaces:  ['enlaces', 'marcas'],
}
const NECESARIOS = ['geo', 'veh', 'lugares', 'enlaces']
const VACIOS     = ['medicion', 'rutas']
const TRAMOS     = NECESARIOS.length + VACIOS.length

const tramoDe       = (engine, id) => engine.getLayer(id) ? superficie(engine, id).tramo : null
const estadoTramos  = engine => Object.fromEntries(Object.keys(MIEMBROS).map(id => [id, tramoDe(engine, id)?.surface.state]))
// La fila de cada capa sigue a su tramo; la línea vacía de un tramo vivo no se arma.
const filasDe       = tramos => Object.fromEntries(Object.entries(MIEMBROS).flatMap(([id, capas]) =>
  capas.map(c => [c, tramos[id] === 'live' && VACIOS.includes(id) ? 'none' : tramos[id]])))
const tramosListos  = engine => Object.keys(MIEMBROS).every(id => tramoDe(engine, id).surface.state !== 'none')
  && engine.surfaces().every(s => !s.hasContent || s.state === 'live')

// Seis tramos, separados por etiquetas: cuatro con contenido y dos miembros cada uno —el host de vehículos con su
// overlay en uno—, y dos con una línea vacía, que toman su contexto en un rato ocioso. `asentado: false` no lo espera.
const montarTramos = async ({ asentado = true, ...opciones } = {}) => {
  const { map, navegador } = await armarVacio({ crearGl, ...opciones })
  limpiar.push(() => map.remove())
  const { engine } = map
  const linea = { id: 1, pts: [[0, 0], [1, 1]], color: '#00f', weight: 2, opacity: 1 }
  engine.addPolygonLayer({ id: 'geo', accessors: POLI, data: [{ id: 'z1' }], z: 400 })
  engine.addLineLayer({ id: 'ruta', accessors: LINEA, data: [linea], z: 405 })
  engine.addLabelLayer({ id: 'sep1', z: 410 })
  engine.addPointLayer({ id: 'veh', source: fuente(3), iconSet, z: 420 })
  engine.addOverlay({ id: 'veh:badge', hostId: 'veh', iconSet })
  engine.addLabelLayer({ id: 'sep2', z: 440 })
  engine.addLineLayer({ id: 'medicion', accessors: LINEA, data: [], z: 450 })
  engine.addLabelLayer({ id: 'sep3', z: 455 })
  engine.addPointLayer({ id: 'lugares', source: fuente(2), iconSet, z: 460 })
  engine.addPointLayer({ id: 'busqueda', source: fuente(1), iconSet, z: 465 })
  engine.addLabelLayer({ id: 'sep4', z: 470 })
  engine.addLineLayer({ id: 'rutas', accessors: LINEA, data: [], z: 480 })
  engine.addLabelLayer({ id: 'sep5', z: 485 })
  engine.addLineLayer({ id: 'enlaces', accessors: LINEA, data: [linea], z: 490 })
  engine.addPointLayer({ id: 'marcas', source: fuente(2), iconSet, z: 495 })
  await esperar(40)
  for (let t = Date.now(); asentado && !tramosListos(engine) && Date.now() - t < 2000;) await esperar(10)
  cuadros()

  const tramos = new Set(Object.values(MIEMBROS).map(capas => {
    const [primera, ...resto] = capas.map(c => tramoDe(engine, c))
    resto.forEach(t => assert.equal(t, primera, `${capas} comparten tramo`))
    return primera
  }))
  assert.equal(tramos.size, TRAMOS, 'seis tramos')
  asentado && assert.deepEqual([navegador.creados, navegador.vivos], [TRAMOS, TRAMOS], 'un contexto por tramo')
  asentado && assert.deepEqual(estados(engine), filasDe(estadoTramos(engine)))
  return { engine, navegador }
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

// Seis tramos y un techo de 16: con 10 ajenos no cae nada, con 12 caen los dos vacíos y con 14 también los dos necesarios
// de menor z.
for (const n of [10, 12, 14]) {
  test(`T3.5 seis tramos + ${n} ajenos que dibujan: caen primero los prescindibles y, sin cupo, los necesarios de menor z`, async () => {
    const { engine, navegador } = await montarTramos()
    const warn   = mock.method(console, 'warn', () => {})
    limpiar.push(() => warn.mock.restore())
    const antes  = propias(navegador)
    const ajenos = []
    for (let k = 0; k < n; k++) {
      ajenos.push(navegador.ajeno())
      asentarCuadros(navegador, ajenos)
      const e = estadoTramos(engine)
      VACIOS.some(id => e[id] === 'live') && NECESARIOS.forEach(id =>
        assert.equal(e[id], 'live', `con un prescindible vivo, el tramo de ${id} no queda sin contexto (ajeno ${k + 1})`))
      assert.ok(Object.values(estados(engine)).every(s => s !== 'lost'), `ninguna capa queda esperando una recuperación (ajeno ${k + 1})`)
    }

    const sinLugar    = TRAMOS - (16 - n)
    const vaciosFuera = Math.max(0, Math.min(VACIOS.length, sinLugar))
    const fuera       = Math.max(0, sinLugar - VACIOS.length)
    const e           = estadoTramos(engine)
    assert.equal(VACIOS.filter(id => e[id] === 'released').length, vaciosFuera)
    assert.deepEqual(NECESARIOS.map(id => e[id]), NECESARIOS.map((_, i) => i < fuera ? 'released' : 'live'),
      `sin superficie quedan los ${fuera} necesarios de menor z`)
    assert.deepEqual(estados(engine), filasDe(e), 'cada capa sigue a su tramo')
    assert.equal(navegador.vivos, 16)
    assert.ok(propias(navegador) - antes <= 2, `una rotación como mucho: ${propias(navegador) - antes} getContext propios`)
    assert.equal(warn.mock.callCount(), fuera ? 1 : 0, 'la saturación avisa una vez por consola')
    const quietos = navegador.creados
    asentarCuadros(navegador, ajenos, 10)
    assert.equal(navegador.creados, quietos, 'y nada más después')
    intactos(navegador)
  })
}

/* ── T3.6 · ajenos que se rehacen al perder ── */

test('T3.6 con ajenos que se rehacen al perder: una rotación, el tramo de menor z queda sin superficie con su señal, y sin bucle', async () => {
  const { engine, navegador } = await montarTramos()
  const avisos = []
  engine.on('surfacechange', d => avisos.push([d.layerId, d.state]))
  const warn = mock.method(console, 'warn', () => {})
  limpiar.push(() => warn.mock.restore())
  const insistente = () => {
    const canvas = document.createElement('canvas')
    canvas.addEventListener('webglcontextlost', insistente)
    navegador.ajeno(canvas)
  }

  navegador.ajeno()
  insistente()                                          // seis tramos y dos ajenos
  navegador.desalojar(contextoDe(navegador, engine, 'lugares'))
  asentarCuadros(navegador)                             // la presión suelta los vacíos y lugares vuelve: los propios, más jóvenes
  assert.deepEqual(VACIOS.map(id => estadoTramos(engine)[id]), ['released', 'released'])
  assert.equal(estadoTramos(engine).lugares, 'live')
  for (let i = 0; i < 12; i++) insistente()             // el techo se llena y los ajenos se desalojan entre sí, y a un propio
  asentarCuadros(navegador, [], 10)

  const e   = estadoTramos(engine)
  const sin = NECESARIOS.filter(id => e[id] !== 'live')
  assert.deepEqual(sin, ['geo'], 'uno solo sin superficie, y es el de menor z')
  assert.equal(e.geo, 'released')
  assert.deepEqual(estados(engine), filasDe(e), 'sus dos capas con él')
  MIEMBROS.geo.forEach(id =>
    assert.deepEqual(avisos.filter(([c]) => c === id).at(-1), [id, 'released'], `con su señal en ${id}`))
  assert.ok(warn.mock.callCount() <= 1, 'y un aviso por consola como mucho')
  const quietos = navegador.creados
  asentarCuadros(navegador, [], 20)
  assert.equal(navegador.creados, quietos, 'sin bucle')
  intactos(navegador)
})

/* ── T3.7 · dos ventanas, un realm ── */

test('T3.7 un mapa montado por portal en otra ventana comparte el registro: perder un tramo necesario en uno suelta los vacíos del otro', async () => {
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
  otro.engine.addLineLayer({ id: 'alla', accessors: LINEA, data: [linea], z: 400 })
  otro.engine.addLabelLayer({ id: 'sep', z: 410 })       // la vacía, en un tramo aparte: si no, no tiene contexto propio
  otro.engine.addLineLayer({ id: 'vacia', accessors: LINEA, data: [], z: 420 })
  await esperar(40)
  const vacia = tramoDe(otro.engine, 'vacia')
  for (let t = Date.now(); vacia.surface.state === 'none' && Date.now() - t < 2000;) await esperar(10)
  cuadros()
  assert.notEqual(vacia, tramoDe(otro.engine, 'alla'))
  assert.equal(vacia.surface.canvas.ownerDocument, segunda.window.document)
  assert.deepEqual([estados(map.engine).aqui, estados(otro.engine).alla, vacia.surface.state], ['live', 'live', 'live'])
  assert.equal(navegador.vivos, 3, 'un contexto por tramo, en las dos ventanas')

  navegador.desalojar(contextoDe(navegador, map.engine, 'aqui'))
  navegador.vaciar()
  assert.equal(vacia.surface.state, 'released', 'el tramo vacío de la otra ventana devolvió su cupo')
  assert.equal(estados(otro.engine).vacia, 'released')
  cuadro()
  assert.equal(estados(map.engine).aqui, 'live')
  assert.equal(estados(otro.engine).alla, 'live')
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

test('quitar un tramo sin superficie por saturación, miembro por miembro, o uno vacío que esperaba su rato ocioso, no toma nada', async () => {
  const ociosos = []
  await esperar(20)
  globalThis.requestIdleCallback = cb => ociosos.push(cb)
  try {
    const { engine, navegador } = await montarTramos({ asentado: false })
    assert.equal(tramoDe(engine, 'rutas').surface.state, 'none', 'el vacío espera su rato ocioso')
    const alta = navegador.creados
    engine.removeLayer('rutas')
    ociosos.splice(0).forEach(cb => cb({ didTimeout: false, timeRemaining: () => 50 }))
    ociosos.splice(0).forEach(cb => cb({ didTimeout: false, timeRemaining: () => 50 }))
    assert.equal(navegador.creados - alta, 1, 'los ratos ociosos toman sólo el otro vacío')
    const ajenos = Array.from({ length: 13 }, () => navegador.ajeno())  // cuatro necesarios, un vacío tomado y trece ajenos
    asentarCuadros(navegador, ajenos)
    assert.equal(estadoTramos(engine).geo, 'released')
    const creados = navegador.creados
    engine.removeLayer('geo')                           // el tramo sigue sin superficie, con ruta
    asentarCuadros(navegador, ajenos, 6)
    assert.equal(estados(engine).ruta, 'released')
    assert.equal(navegador.creados, creados, 'ningún getContext al quitar un miembro')
    engine.removeLayer('ruta')                          // y se va con el último
    asentarCuadros(navegador, ajenos, 6)
    assert.equal(navegador.creados, creados, 'ningún getContext')
    assert.ok(!engine.surfaces().some(s => ['rutas', 'geo', 'ruta'].includes(s.layerId)))
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

test('R4: habilitar el host de vehículos tras una presión que soltó su tramo toma un contexto en el clic y lo arma entero en los cuadros siguientes', async () => {
  const { engine, navegador } = await montarTramos()
  engine.setLayerEnabled('veh', false)                 // el host y su overlay se ocultan: su tramo queda prescindible
  asentarCuadros(navegador)
  navegador.ajeno()
  navegador.desalojar(contextoDe(navegador, engine, 'lugares'))   // presión: un tramo necesario pierde el suyo
  asentarCuadros(navegador)
  assert.equal(estadoTramos(engine).veh, 'released')
  assert.deepEqual([estados(engine).veh, estados(engine)['veh:badge']], ['released', 'released'])
  const desde = navegador.creados
  engine.setLayerEnabled('veh', true)                  // un clic: una tarea
  assert.equal(navegador.creados - desde, 1, 'una adquisición por tarea, y una por tramo: no una por capa (ORACULO §5.5)')
  assert.equal(estadoTramos(engine).veh, 'live')
  asentarCuadros(navegador)
  const e = estados(engine)
  assert.deepEqual(Object.keys(e).filter(id => e[id] !== 'live'), VACIOS,
    'el host y su overlay, armados en los cuadros siguientes; los vacíos siguen soltados')
  assert.equal(navegador.creados - desde, 1)
  intactos(navegador)
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
