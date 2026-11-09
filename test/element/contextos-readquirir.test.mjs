// Las superficies GL de un mapa de elementos REALES (Lit + custom elements + Leaflet en jsdom) cuando el navegador les quita el
// contexto o lo sueltan ellas, y lo vuelven a tomar en un canvas nuevo, sobre tramos (SPECS §10 y §10.1): las capas GL
// contiguas en z comparten el contexto de su tramo y cada una dibuja en su FBO; un editor tiene el suyo. La política ve una
// superficie por tramo. Cada clase ya prueba su propia conversión (test/render/*-readquirir.test.mjs) sobre un doble; acá se
// prueba lo que sólo se ve con todas juntas, sobre un DOM de verdad y el techo de contextos de Chromium
// (test-helpers/navegador-falso.mjs).
//
//   Pila  Siete tramos separados por etiquetas, cinco con contenido y dos de capas vacías, con contextos ajenos: un tramo
//         desalojado vuelve dentro del cupo, uno por cuadro y el de mayor z primero, los prescindibles quedan soltados y
//         ninguna llamada va a un `gl` viejo. La política con más ajenos, el ping-pong y la saturación están en
//         `contextos-politica`; la recuperación de dos tramos, en `tramos-recuperacion`.
//   13    El modelo de 13 capas del Mapa Geotáctico es un tramo: un reinicio de la GPU lo vuelve con un contexto, rearma
//         las nueve con contenido de mayor a menor z y deja sin armar las cuatro vacías.
//   T2.4  Varias clases en un pane compartido y en panes separados: el lugar de cada pane, su z-index y el orden de sus
//         hijos —marcadores y canvases— son los mismos antes y después de soltar, perder y re-adquirir.
//   T2.6  `removeLayer` en cada estado del tramo deja al resto armado sin rearmar a la quitada, y quitar todo el tramo, o
//         el editor, deja sus contextos en 0; `map.remove()` en cada momento de la recuperación, 0 vivos.
//
// Los cuadros los corre el test (`cuadro()`), así «uno por cuadro» es determinista. Los eventos del navegador llegan con
// `navegador.vaciar()`. El reloj es falso: el tiempo pasa sólo con `pasar()`, y ni la carga de la máquina ni lo que
// tarda un rearme cambian el resultado. Corre con: node --test test/element/contextos-readquirir.test.mjs
//
// El harness va PRIMERO: window, customElements y lo que Lit toca al evaluar.
import { armar, armarVacio, asentar, ACC, LINEA, POLI, iconSet, items } from '../../test-helpers/modelo-capas.mjs'
import { makeEditGl, makePickSpy } from '../../test-helpers/engine-stub.mjs'
import { afterEach, beforeEach, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { createSource } from '../../src/data/index.js'

/* ── Un reloj que avanza sólo cuando el test lo avanza ── */

// setTimeout, setInterval (el rAF de jsdom) y Date. `performance.now`, que mide el tope de cada tanda de la cola de
// reconstrucción, los sigue: dentro de una tarea no avanza.
mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })

// Avanza el reloj de a 1 ms; entre paso y paso corren las microtareas y lo que agendó el paso.
const pasar = async ms => {
  for (let i = 0; i < ms; i++) {
    mock.timers.tick(1)
    await new Promise(r => setImmediate(r))
  }
}

// Lo que duerme con el reloj (los helpers de montaje) despierta a medida que se lo avanza.
const conReloj = async (promesa, tope = 60_000) => {
  let fin = false
  promesa.then(() => { fin = true }, () => { fin = true })
  for (let t = 0; t < tope && !fin; t++) await pasar(1)
  assert.ok(fin, `sigue esperando tras ${tope} ms del reloj`)
  return promesa
}

const montarVacio = () => conReloj(armarVacio({ crearGl }))

/* ── Cuadros a mano, y un desfase que crece entre test y test ── */

const rafPrevio    = globalThis.requestAnimationFrame
const cancelPrevio = globalThis.cancelAnimationFrame
const agendados    = new Map()
let serie          = 1_000_000                  // lejos de los ids del rAF de jsdom, que se cancelan por el mismo nombre
const cuadros = () => {
  globalThis.requestAnimationFrame = cb => (agendados.set(++serie, cb), serie)
  globalThis.cancelAnimationFrame  = id => agendados.delete(id)
}

// Corre lo agendado hasta ahora: lo que se agenda durante el cuadro va al siguiente.
const cuadro = () => {
  const ahora = [...agendados.values()]
  agendados.clear()
  ahora.forEach(cb => cb(0))
}

// La composición de un tramo corre en la microtarea de la tarea en que algo pintó: esperarla no cambia de tarea.
const microtarea = () => Promise.resolve()

// Nada de la política depende del valor de `performance.now`, y el desfase lo fija.
let desfase = 0
performance.now = () => Date.now() + desfase
beforeEach(() => { desfase += 10_000 })

// Se quita el mapa antes de correr lo agendado: quitar una viva es una señal de cupo, y el cuadro que agenda tiene que correr
// acá, con nada que tomar, o la política lo esperaría en el test siguiente.
let mapa = null
afterEach(() => {
  mapa?.remove()
  mapa = null
  for (let i = 0; agendados.size && i < 30; i++) cuadro()
  agendados.clear()
  globalThis.requestAnimationFrame = rafPrevio
  globalThis.cancelAnimationFrame  = cancelPrevio
  document.body.replaceChildren()
})

/* ── Harness ── */

// Cada contexto anota lo que le piden, con los datos copiados en el momento.
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

// La superficie que ve la capa: el `TramoSlot` de un miembro, o la `EditSurface` de un editor. Su dueña es la que tiene el
// contexto: la del tramo, o la misma.
const superficie = (engine, id) => (r => (r.layer ?? r.editor).surface)(engine.getLayer(id))
const duena      = (engine, id) => (s => s.tramo?.surface ?? s)(superficie(engine, id))
const contextoDe = (navegador, engine, id) => navegador.contextos.find(c => c.gl === duena(engine, id).gl)
const estados    = engine => Object.fromEntries(engine.surfaces().map(s => [s.layerId, s.state]))
const dibujos    = contexto => contexto.gl.llamadas.filter(([m]) => /^draw/.test(m)).length
const idDe       = (engine, slot) => engine.surfaces().map(s => s.layerId).find(id => superficie(engine, id) === slot)
const miembros   = (engine, id) => (t => t ? t.members.map(m => idDe(engine, m)) : [id])(superficie(engine, id).tramo)

// Ningún contexto perdido recibió una llamada después de perderse y ningún recurso de uno se usó en otro.
const intactos = navegador => {
  const tocados = navegador.contextos.filter(c => c.llamadasTrasPerdida).map(c => `#${c.id} ${c.pane}: ${c.llamadasTrasPerdida}`)
  assert.deepEqual(tocados, [], 'ninguna llamada a un contexto después de perderse')
  assert.deepEqual(navegador.violaciones, [], 'ningún recurso de un contexto usado en otro')
}

const ajenos = (navegador, n) => Array.from({ length: n }, () => navegador.ajeno())

// Corre cuadros hasta que `listo()` o el tope: la cola de reconstrucción de un tramo rearma en tandas por cuadro.
const cuadrosHasta = (listo, tope = 10) => {
  for (let i = 0; i < tope && !listo(); i++) cuadro()
  return listo()
}

// Avanza el reloj hasta que `listo()` o el tope: lo que se toma en ratos ociosos, sin requestIdleCallback en jsdom.
const hasta = async (listo, tope = 2000) => {
  for (let t = 0; t < tope && !listo(); t++) await pasar(1)
  return listo()
}

// Cuenta cada vez que el dueño de una capa rearma su parte GL sobre un contexto.
const rearmes = (engine, id) => {
  const s      = superficie(engine, id)
  const cuenta = { n: 0 }
  const previo = s.buildGl
  s.buildGl = gl => (cuenta.n++, previo(gl))
  return cuenta
}

/* ── Datos ── */

const SQUARE = [[0, 0], [0, 10], [10, 10], [10, 0]]
const forma  = { idOf: f => f.id, positionOf: f => f.center, radiusOf: f => f.radius }
const fuente = n => (s => (s.set(items(n)), s))(createSource(ACC))
const linea  = { id: 1, pts: [[0, 0], [1, 1]], color: '#00f', weight: 2, opacity: 1 }

// Una capa de cada clase que dibuja con WebGL, por su nombre. `vacia` y `vacio` nacen sin contenido.
const ALTA = {
  punto    : (e, id, en) => e.addPointLayer({ id, source: fuente(2), iconSet, interactive: true, ...en }),
  linea    : (e, id, en) => e.addLineLayer({ id, accessors: LINEA, data: [linea], ...en }),
  poligono : (e, id, en) => e.addPolygonLayer({ id, accessors: POLI, data: [{ id: 'z1' }], ...en }),
  forma    : (e, id, en) => e.addShapeLayer({ id, accessors: forma, data: [{ id: 1, center: [0, 0], radius: 1e5 }], ...en }),
  editor   : (e, id, en) => e.addEditableLayer({ id, kind: 'polygon', value: SQUARE, mode: 'edit', ...en }),
  vacia    : (e, id, en) => e.addLineLayer({ id, accessors: LINEA, data: [], ...en }),
  vacio    : (e, id, en) => e.addPointLayer({ id, source: createSource(ACC), iconSet, ...en }),
}

/* ── Una pila de siete tramos con contextos ajenos ── */

// Las etiquetas (los números, su z) separan los tramos. Cinco tienen contenido; los dos de capas vacías, como las líneas
// que el kit monta «siempre, también vacías» y la espiral y la sub-espiral del cluster, son prescindibles.
const PILA = [
  ['geo', 'poligono', 400], ['veh', 'punto', 410], 415,
  ['lugares', 'punto', 420], ['busqueda', 'punto', 430], 435,
  ['medicion', 'vacia', 440], ['rutas', 'vacia', 450], 455,
  ['marcas', 'punto', 460], ['enlaces', 'linea', 470], 475,
  ['zona', 'forma', 480], 485,
  ['espiral', 'vacio', 490], ['subespiral', 'vacio', 500], 505,
  ['burbujas', 'punto', 510],
]
const VACIAS = ['medicion', 'rutas', 'espiral', 'subespiral']

// Las etiquetas van antes que las capas: un separador que aparece después parte un tramo vivo.
const montarPila = async () => {
  const { map, navegador } = await montarVacio()
  mapa = map
  const { engine } = map
  PILA.filter(x => typeof x === 'number').forEach((z, i) => engine.addLabelLayer({ id: `sep${i}`, z }))
  PILA.filter(x => typeof x !== 'number').forEach(([id, clase, z]) => ALTA[clase](engine, id, { z }))
  assert.ok(await hasta(() => engine.surfaces().every(s => duena(engine, s.layerId).state === 'live')),
    'los tramos vacíos toman el suyo en un rato ocioso')
  await pasar(40)
  cuadros()
  assert.equal(new Set(engine.surfaces().map(s => duena(engine, s.layerId))).size, 7, 'siete tramos')
  assert.equal(navegador.vivos, 7, 'un contexto por tramo')
  return { engine, navegador }
}

// Los tramos por la z de su miembro más alto, descendente: el orden en que la política los recupera.
const porZ = (engine, ids) => {
  const z = id => duena(engine, id).z
  assert.equal(new Set(ids.map(z)).size, ids.length, 'sin empates de z')
  return [...ids].sort((p, q) => z(q) - z(p))
}

test('siete tramos + 9 ajenos caben en el techo: una ráfaga de pérdidas suelta los prescindibles y vuelve de a un tramo por cuadro, por z', async () => {
  const { engine, navegador } = await montarPila()
  ajenos(navegador, 9)
  assert.equal(navegador.vivos, 16)
  assert.equal(navegador.desalojados, 0, 'siete más nueve son el techo: nadie cae')

  const avisos = []
  engine.on('surfacechange', detail => avisos.push([detail.layerId, detail.state]))
  const perdidos = ['geo', 'lugares', 'marcas', 'burbujas']              // un miembro de cada tramo que cae
  const caidas   = perdidos.flatMap(id => miembros(engine, id))
  perdidos.forEach(id => assert.equal(navegador.desalojar(contextoDe(navegador, engine, id)), true))
  navegador.vaciar()
  const creados = navegador.creados

  assert.deepEqual(caidas.map(id => estados(engine)[id]), caidas.map(() => 'lost'), 'cada miembro de un tramo perdido')
  assert.deepEqual(VACIAS.map(id => estados(engine)[id]), VACIAS.map(() => 'released'), 'bajo presión se sueltan los prescindibles')
  assert.equal(estados(engine).zona, 'live', 'el tramo que no cayó no se entera')
  assert.equal(navegador.creados, creados, 'recuperar espera al cuadro: el evento no toma contexto')

  const orden = porZ(engine, perdidos)
  assert.deepEqual(orden, ['burbujas', 'marcas', 'lugares', 'geo'])
  for (const [i, id] of orden.entries()) {
    cuadro()
    assert.equal(navegador.creados, creados + i + 1, `el cuadro ${i + 1} toma exactamente un contexto`)
    assert.equal(duena(engine, id).state, 'live', `el tramo de ${id} vuelve en su cuadro, el de mayor z primero`)
    orden.slice(i + 1).forEach(otro => assert.equal(duena(engine, otro).state, 'lost', `el de ${otro} espera su turno`))
    await microtarea()
    assert.ok(dibujos(contextoDe(navegador, engine, id)) > 0, `el tramo de ${id} compone en la tarea en que vuelve`)
  }
  assert.ok(cuadrosHasta(() => caidas.every(id => estados(engine)[id] === 'live')), 'y sus miembros terminan de rearmarse')

  cuadro()
  assert.equal(navegador.creados, creados + 4, 'con la cola vacía, un cuadro más no toma nada')
  assert.equal(navegador.desalojados, 4, 'sólo cayeron los cuatro que pidió el test: recuperarlos no desalojó a nadie')
  assert.equal(navegador.vivos, 14, 'los cinco tramos con contenido y los nueve ajenos')
  const vueltas   = orden.flatMap(id => miembros(engine, id))
  const sinSoltar = avisos.filter(([, e]) => e !== 'released')
  assert.deepEqual(sinSoltar.filter(([, e]) => e === 'lost').map(([id]) => id).sort(), [...caidas].sort(),
    'cada miembro avisó perderse, con el evento')
  assert.deepEqual([...new Set(sinSoltar.filter(([, e]) => e === 'live').map(([id]) => id))], vueltas,
    'y volver, con su tramo y en su orden')
  assert.ok(sinSoltar.findIndex(([, e]) => e === 'live') > sinSoltar.findLastIndex(([, e]) => e === 'lost'))
  assert.deepEqual([...new Set(avisos.filter(([, e]) => e === 'released').map(([id]) => id))].sort(), [...VACIAS].sort())
  intactos(navegador)
})

test('siete tramos + 10 ajenos pasan el techo por uno: cae un tramo prescindible, que queda soltado, y no se recupera nada', async () => {
  const { engine, navegador } = await montarPila()
  const avisos = []
  engine.on('surfacechange', detail => avisos.push([detail.layerId, detail.state]))
  const creados = navegador.creados

  ajenos(navegador, 10)                                  // el décimo pasa de 16: cae el contexto de flush más viejo
  navegador.vaciar()
  for (let i = 0; i < 5; i++) cuadro()
  const caido = miembros(engine, avisos[0]?.[0] ?? 'geo')
  assert.ok(caido.every(id => VACIAS.includes(id)), `cae un tramo prescindible, el de flush más viejo (cayó ${caido})`)
  assert.deepEqual(avisos, caido.map(id => [id, 'released']), 'sus dos miembros quedan soltados, y nadie más se entera')
  assert.equal(navegador.creados, creados + 10, 'ni un getContext propio')
  assert.equal(navegador.vivos, 16)
  intactos(navegador)
})

/* ── El modelo de 13 capas: un tramo ── */

test('un reinicio de la GPU le quita el contexto al modelo de 13 capas: vuelve con uno, rearma las nueve con contenido por z y pinta', async () => {
  const { map, navegador } = await conReloj(armar(13, 'react', { crearGl, asentado: false }))
  mapa = map
  const { engine } = map
  await hasta(() => duena(engine, 'geo').state === 'live' && engine.surfaces().every(s => s.state !== 'none' || !s.hasContent))
  await pasar(40)
  cuadros()
  const ids = engine.surfaces().map(s => s.layerId)
  assert.equal(ids.length, 13)
  assert.equal(new Set(ids.map(id => duena(engine, id))).size, 1, 'las trece en un tramo')
  const vacias     = engine.surfaces().filter(s => !s.hasContent).map(s => s.layerId)
  const necesarias = ids.filter(id => !vacias.includes(id))
  assert.equal(vacias.length, 4)
  ajenos(navegador, 3)

  const orden = []
  necesarias.forEach(id => {
    const s      = superficie(engine, id)
    const previo = s.buildGl
    s.buildGl = gl => (orden.push(id), previo(gl))
  })
  const viejo = contextoDe(navegador, engine, 'geo')
  navegador.desalojar(viejo)
  navegador.vaciar()
  assert.equal(navegador.vivos, 3, 'sólo quedan los ajenos')
  assert.deepEqual(ids.map(id => estados(engine)[id]), ids.map(() => 'lost'), 'el tramo entero en blanco')
  const creados = navegador.creados

  cuadro()
  assert.equal(navegador.creados, creados + 1, 'un contexto en el primer cuadro')
  assert.ok(cuadrosHasta(() => necesarias.every(id => estados(engine)[id] === 'live')), 'las nueve con contenido vuelven')
  assert.equal(navegador.creados, creados + 1, 'uno por tramo, nunca uno por capa')
  const z = id => engine.surfaces().find(s => s.layerId === id).z
  assert.deepEqual(orden, [...necesarias].sort((p, q) => z(q) - z(p)), 'rearmadas de mayor a menor z, cada una una vez')
  assert.deepEqual(vacias.map(id => estados(engine)[id]), vacias.map(() => 'none'), 'las vacías no se arman hasta tener contenido')
  await microtarea()
  necesarias.forEach(id => assert.ok(superficie(engine, id).hasPainted, `${id} pinta al volver`))
  assert.ok(dibujos(contextoDe(navegador, engine, 'geo')) > 0, 'y el tramo compone')
  cuadro()
  assert.equal(navegador.creados, creados + 1)
  assert.equal(navegador.desalojados, 1, 'recuperarlo con cupo libre no desaloja a nadie')
  assert.equal(navegador.vivos, 4)
  assert.equal(viejo.llamadasTrasPerdida, 0)
  intactos(navegador)
})

/* ── T2.4 · el lugar de cada canvas no cambia con soltar, perder y re-adquirir ── */

// Una capa de cada clase que dibuja con WebGL. `pane` las junta en uno solo; sin él, cada una tiene el suyo.
const CLASES = ['punto', 'linea', 'poligono', 'forma', 'editor']
const GL     = CLASES.slice(0, 4)                        // las que van en tramos: el editor tiene su contexto
const clases = async (engine, pane) => {
  const en = { ...(pane && { pane, z: 450 }) }
  CLASES.forEach(clase => ALTA[clase](engine, clase, en))
  await pasar(40)                   // los datos entran por la Source, que avisa en el cuadro de jsdom y no en los que corre el test
  await conReloj(asentar(engine))   // y el primero le pide su contexto a la capa que nació vacía
  return CLASES
}

const montarClases = async pane => {
  const { map, navegador } = await montarVacio()
  mapa = map
  cuadros()
  const ids = await clases(map.engine, pane)
  return { engine: map.engine, navegador, ids }
}

// Las superficies con contexto, sin repetir, en el orden de alta de su primer miembro.
const duenas = (engine, ids) => [...new Set(ids.map(id => duena(engine, id)))]

// Dónde está cada cosa: los panes de la raíz del mapa en orden, con su z-index y sus hijos —el marcador de un miembro, el
// canvas de un tramo por sus miembros, el de un editor—; lo demás por su clase. Los panes, además, son los mismos nodos.
const foto = (engine, ids) => {
  const nombre = new Map()
  ids.forEach(id => {
    const s = superficie(engine, id)
    if (!s.tramo) return nombre.set(s.canvas, `editor:${id}`)
    nombre.set(s.canvas, `marcador:${id}`)
    nombre.set(s.tramo.surface.canvas, `tramo:${miembros(engine, id).join('+')}`)
  })
  const panes = [...superficie(engine, ids[0]).canvas.parentNode.parentNode.children]
  return {
    panes,
    detalle: panes.map(pane => ({
      z     : pane.style.zIndex,
      hijos : [...pane.children].map(hijo => nombre.get(hijo) ?? `dom:${hijo.className}`),
    })),
  }
}

for (const [nombre, pane] of [['en un pane compartido', 'comun'], ['en panes separados', undefined]]) {
  test(`T2.4 cinco clases ${nombre}: panes, z-index y orden del DOM idénticos antes y después de soltar, perder y re-adquirir`, async () => {
    const { engine, navegador, ids } = await montarClases(pane)
    const base  = foto(engine, ids)
    const igual = paso => assert.deepEqual(foto(engine, ids), base, paso)
    const todas = duenas(engine, ids)
    if (pane) {
      // El pane del editor separa: cada capa del pane compartido va en un tramo solo, con su canvas detrás de su marcador.
      assert.equal(todas.length, 5, 'un contexto por capa')
      const hijos = base.detalle.find(d => d.hijos.includes('marcador:punto')).hijos.filter(h => !h.startsWith('dom:'))
      assert.deepEqual(hijos, [...GL.flatMap(id => [`marcador:${id}`, `tramo:${id}`]), 'editor:editor'], 'en el orden del alta')
    } else {
      assert.equal(todas.length, 2, 'las cuatro GL comparten un tramo; el editor tiene el suyo')
      assert.ok(base.detalle.some(d => d.hijos.includes(`tramo:${GL.join('+')}`)))
    }
    const canvasInicial = todas.map(s => s.canvas)

    // Cada capa, soltada y vuelta a tomar: un miembro suelta lo suyo sin tocar el DOM; el editor deja su marcador.
    ids.forEach(id => {
      superficie(engine, id).release()
      igual(`${id} soltada`)
      assert.equal(superficie(engine, id).state, 'released')
      superficie(engine, id).acquire()
      igual(`${id} vuelta a tomar`)
      assert.equal(superficie(engine, id).state, 'live')
    })

    // Cada contexto, perdido por el navegador y recuperado por la política en el cuadro siguiente.
    todas.forEach((s, i) => {
      navegador.desalojar(navegador.contextos.find(c => c.gl === s.gl))
      igual(`contexto ${i} desalojado, antes del evento`)
      navegador.vaciar()
      igual(`contexto ${i} perdido`)
      cuadrosHasta(() => ids.every(id => superficie(engine, id).state === 'live'))
      igual(`contexto ${i} recuperado`)
      assert.equal(s.state, 'live')
    })

    // Todos juntos: se sueltan y vuelven en el orden contrario.
    todas.forEach(s => s.release())
    igual('todos soltados')
    assert.deepEqual(ids.map(id => superficie(engine, id).state), Array(5).fill('released'))
    ;[...todas].reverse().forEach((s, i) => {
      s.acquire()
      igual(`contexto ${todas.length - 1 - i} vuelto a tomar, en orden inverso`)
    })
    assert.ok(cuadrosHasta(() => ids.every(id => superficie(engine, id).state === 'live')))

    // Un reinicio de la GPU los pierde a todos; la política los recupera de a uno, el de mayor z primero (el editor, el
    // último dado de alta), y entre medio hay los que ya volvieron, los que esperan y el que se suelta a mano.
    todas.forEach(s => navegador.desalojar(navegador.contextos.find(c => c.gl === s.gl)))
    navegador.vaciar()
    igual('todos perdidos')
    cuadro()
    igual('el primero recuperado, los demás perdidos')
    const editor = duena(engine, 'editor')
    assert.deepEqual(todas.map(s => s.state), todas.map(s => s === editor ? 'live' : 'lost'))
    const espera = duena(engine, 'punto')
    espera.release()                                     // el que espera su turno se suelta: sale de la política
    igual('uno perdido que se suelta')
    for (let i = 0; i < todas.length + 4; i++) {
      cuadro()
      igual(`recuperación ${i + 2}`)
    }
    assert.deepEqual(todas.map(s => s.state), todas.map(s => s === espera ? 'released' : 'live'), 'el soltado no vuelve solo')
    espera.acquire()
    igual('y vuelve a mano')
    assert.ok(cuadrosHasta(() => ids.every(id => superficie(engine, id).state === 'live')))

    todas.forEach((s, i) => {
      assert.notEqual(s.canvas, canvasInicial[i], `el contexto ${i} tiene un canvas nuevo`)
      assert.equal(canvasInicial[i].isConnected, false, 'y el viejo ya no está en el documento')
    })
    assert.deepEqual(foto(engine, ids).panes, base.panes, 'los panes son los mismos nodos')
    intactos(navegador)
  })
}

/* ── T2.6 · quitar en cada estado del tramo ── */

// En qué estado está la superficie cuando se quita la capa. `s` es la que ve la capa, `d` su dueña y `c` su contexto.
const ESTADOS = [
  ['viva',                                   () => {}],
  ['perdida, antes de que llegue el evento', (n, s, d, c) => n.desalojar(c)],
  ['perdida, esperando su cuadro',           (n, s, d, c) => (n.desalojar(c), n.vaciar())],
  ['recuperada',                             (n, s, d, c) => (n.desalojar(c), n.vaciar(), cuadrosHasta(() => d.state === 'live'))],
  ['soltada',                                (n, s) => s.release()],
]

// Después de quitar, nada se resucita: ni el evento que deja el `loseContext`, ni los cuadros de la política.
const sinResucitar = navegador => {
  const creados = navegador.creados
  navegador.vaciar()
  for (let i = 0; i < 5; i++) cuadro()
  navegador.vaciar()
  assert.equal(navegador.creados, creados, 'ningún getContext después de quitar')
  assert.equal(agendados.size, 0, 'y nada agendado')
}

const llevarA = (navegador, engine, id, llevar) => {
  const original = contextoDe(navegador, engine, id)
  const antes    = navegador.creados
  llevar(navegador, superficie(engine, id), duena(engine, id), original)
  return { original, antes }
}

for (const clase of GL) {
  for (const [estado, llevar] of ESTADOS) {
    test(`T2.6 ${clase} ${estado}: removeLayer la saca de su tramo, que sigue con las otras tres y no la rearma`, async () => {
      const { engine, navegador, ids } = await montarClases()
      const otras = GL.filter(id => id !== clase)
      assert.equal(navegador.vivos, 2, 'el tramo de las cuatro y el editor')
      const tramo = superficie(engine, clase).tramo
      const { original, antes } = llevarA(navegador, engine, clase, llevar)
      const perdida  = original.estado === 'perdido'
      const rearmada = rearmes(engine, clase)
      const marcador = superficie(engine, clase).canvas
      engine.removeLayer(clase)
      assert.equal(marcador.isConnected, false, 'su marcador se va del documento')

      navegador.vaciar()
      assert.ok(cuadrosHasta(() => otras.every(id => estados(engine)[id] === 'live')), 'las otras tres quedan armadas')
      await microtarea()
      assert.equal(superficie(engine, otras[0]).tramo, tramo, 'en el mismo tramo')
      assert.deepEqual(miembros(engine, otras[0]), otras)
      assert.equal(rearmada.n, 0, 'la quitada no se rearma')
      assert.equal(navegador.creados, antes + (perdida ? 1 : 0), perdida ? 'el tramo vuelve una vez' : 'sin tomar nada')
      assert.equal(navegador.vivos, 2)
      assert.equal(estados(engine).editor, 'live', 'el editor no se entera')
      assert.equal(engine.surfaces().length, ids.length - 1)
      sinResucitar(navegador)
      intactos(navegador)
    })
  }
}

for (const [estado, llevar] of ESTADOS) {
  test(`T2.6 un tramo ${estado}: quitar sus cuatro capas deja sus contextos en 0 y no lo resucita`, async () => {
    const { engine, navegador } = await montarClases()
    const tramo = superficie(engine, 'punto').tramo
    const { original, antes } = llevarA(navegador, engine, 'punto', (n, s, d, c) => llevar(n, d, d, c))
    const propios = [original, ...navegador.contextos.slice(antes)]       // el que tenía y, si ya volvió, el nuevo
    const canvas  = [...GL.map(id => superficie(engine, id).canvas), tramo.surface.canvas]
    GL.forEach(id => engine.removeLayer(id))
    await microtarea()                                   // el tramo vacío se va al final de la microtarea
    assert.deepEqual(canvas.map(c => c.isConnected), canvas.map(() => false), 'los marcadores y el canvas del tramo se van')
    assert.equal(tramo.surface.state, 'none', 'el tramo se destruyó')

    assert.equal(navegador.vivos, 1, 'sólo queda el del editor')
    assert.deepEqual(propios.map(c => c.estado), propios.map(() => 'perdido'), 'ningún contexto del tramo sigue vivo')
    assert.equal(estados(engine).editor, 'live', 'el editor no se enteró')
    sinResucitar(navegador)
    assert.equal(navegador.vivos, 1)
    intactos(navegador)
  })

  test(`T2.6 editor ${estado}: removeLayer deja sus contextos en 0 y no lo resucita`, async () => {
    const { engine, navegador } = await montarClases()
    const { original, antes } = llevarA(navegador, engine, 'editor', llevar)
    const propios = [original, ...navegador.contextos.slice(antes)]
    const canvas  = superficie(engine, 'editor').canvas                  // el vivo o, sin contexto, el marcador
    engine.removeLayer('editor')
    assert.equal(canvas.isConnected, false, 'el canvas, o el marcador, se va del documento')

    assert.equal(navegador.vivos, 1, 'sólo queda el del tramo')
    assert.deepEqual(propios.map(c => c.estado), propios.map(() => 'perdido'), 'ningún contexto del editor sigue vivo')
    assert.deepEqual(GL.map(id => estados(engine)[id]), Array(4).fill('live'), 'las otras no se enteraron')
    assert.equal(engine.surfaces().length, 4)
    sinResucitar(navegador)
    assert.equal(navegador.vivos, 1)
    intactos(navegador)
  })
}

// El mapa entero, con el modelo de 13 capas en un tramo: lo que desmonta `map.remove()` en cada momento de la recuperación.
const montar13 = async () => {
  const { map, navegador } = await conReloj(armar(13, 'react', { crearGl }))
  mapa = map
  await pasar(40)                                // lo que jsdom agendó al montar corre con su rAF, no con el del test
  cuadros()
  return { map, engine: map.engine, navegador }
}
const perder   = (navegador, engine) => navegador.desalojar(contextoDe(navegador, engine, 'geo'))
const MOMENTOS = [
  ['con el tramo perdido, antes de que llegue el evento', perder],
  ['con el tramo perdido esperando su cuadro',            (n, e) => (perder(n, e), n.vaciar())],
  ['con el tramo vuelto y sus capas a medio rearmar',     (n, e) => (perder(n, e), n.vaciar(), cuadro())],
  ['con el tramo recuperado',                             (n, e) => (perder(n, e), n.vaciar(), [1, 2, 3, 4].forEach(cuadro))],
  ['con tres capas soltadas',                             (n, e) => ['geo', 'veh', 'rutas'].forEach(id => superficie(e, id).release())],
]

for (const [momento, llevar] of MOMENTOS) {
  test(`T2.6 modelo de 13 capas ${momento}: map.remove() deja 0 vivos y no resucita nada`, async () => {
    const { map, engine, navegador } = await montar13()
    llevar(navegador, engine)
    const creados = navegador.creados
    mapa = null
    map.remove()

    assert.equal(navegador.vivos, 0, `quedaron contextos: ${navegador.resumen()}`)
    sinResucitar(navegador)
    assert.equal(navegador.creados, creados, 'destruir no toma ningún contexto')
    assert.equal(navegador.vivos, 0)
    intactos(navegador)
  })
}

/* ── Una capa sola en su tramo, oculta: conserva el contexto; perdido, no lo vuelve a tomar hasta que se muestra ── */

// Cada clase GL en su tramo, separadas por etiquetas.
const clasesSeparadas = async engine => {
  GL.forEach((clase, i) => {
    i && engine.addLabelLayer({ id: `sep-${clase}`, z: 395 + i * 10 })
    ALTA[clase](engine, clase, { z: 400 + i * 10 })
  })
  await pasar(40)
  await conReloj(asentar(engine))
}

for (const clase of GL) {
  test(`${clase} oculta, sola en su tramo: conserva el contexto; desalojado queda soltado, y al mostrarla lo toma y pinta en la misma tarea`, async () => {
    const { map, navegador } = await montarVacio()
    mapa = map
    cuadros()
    const { engine } = map
    await clasesSeparadas(engine)
    assert.equal(duenas(engine, GL).length, 4, 'un tramo por clase')
    const otras = GL.filter(id => id !== clase)

    engine.setLayerVisibility(clase, false)
    for (let i = 0; i < 3; i++) cuadro()
    assert.equal(superficie(engine, clase).state, 'live', 'ocultarla no suelta nada')
    const creados = navegador.creados
    navegador.desalojar(contextoDe(navegador, engine, clase))
    navegador.vaciar()
    for (let i = 0; i < 3; i++) cuadro()
    assert.equal(superficie(engine, clase).state, 'released', 'prescindible: no se recupera mientras no se vea')
    assert.equal(navegador.creados, creados, 'ni un getContext')
    assert.deepEqual(otras.map(id => estados(engine)[id]), otras.map(() => 'live'), 'los otros tramos no se enteran')

    engine.setLayerVisibility(clase, true)
    assert.equal(superficie(engine, clase).state, 'live')
    assert.equal(navegador.creados, creados + 1, 'mostrarla toma el contexto en la tarea')
    await microtarea()
    assert.ok(superficie(engine, clase).hasPainted, 'pinta')
    assert.ok(dibujos(contextoDe(navegador, engine, clase)) > 0, 'y el tramo compone en la misma tarea')
    intactos(navegador)
  })
}

/* ── El recambio de source de una capa soltada ── */

// La pérdida del tramo durante el recambio está en `tramos-recuperacion`.
for (const [estado, soltar, tomados] of [
  ['soltada en su tramo vivo', (engine, id) => superficie(engine, id).release(), 0],
  ['con su tramo soltado',     (engine, id) => duena(engine, id).release(),      1],
]) {
  test(`attachSource de una capa ${estado}: la nueva se arma en el lugar de la vieja, en el mismo tramo, y nada la duplica`, async () => {
    const { map, navegador } = await montarVacio()
    mapa = map
    cuadros()
    const { engine } = map
    ;['a', 'b', 'c'].forEach(id => engine.addPointLayer({ id, source: fuente(2), iconSet, pane: 'comun', z: 450 }))
    await conReloj(asentar(engine))
    const orden = () => (hijos => ['a', 'b', 'c'].sort((p, q) =>
      hijos.indexOf(superficie(engine, p).canvas) - hijos.indexOf(superficie(engine, q).canvas)))([...superficie(engine, 'a').canvas.parentNode.children])
    assert.deepEqual(orden(), ['a', 'b', 'c'])
    assert.equal(navegador.vivos, 1, 'las tres en un tramo')
    const tramo = superficie(engine, 'a').tramo

    soltar(engine, 'b')
    const creados = navegador.creados
    engine.attachSource('b', fuente(3))

    assert.equal(navegador.creados, creados + tomados, tomados ? 'el tramo vuelve a tomar el suyo en la tarea' : 'el tramo vivo no toma nada')
    assert.deepEqual(orden(), ['a', 'b', 'c'], 'en el lugar de la vieja')
    assert.equal(superficie(engine, 'b').tramo, tramo, 'en el mismo tramo')
    assert.equal(navegador.vivos, 1)
    assert.deepEqual(estados(engine), { a: 'live', b: 'live', c: 'live' })

    navegador.vaciar()                                   // el evento que dejó soltar el tramo ya no es de nadie
    for (let i = 0; i < 4; i++) cuadro()
    assert.equal(navegador.creados, creados + tomados, 'y nada lo toma por segunda vez')
    assert.deepEqual(orden(), ['a', 'b', 'c'])
    assert.deepEqual(estados(engine), { a: 'live', b: 'live', c: 'live' })
    intactos(navegador)
  })
}
