// Las superficies GL de un mapa de elementos REALES (Lit + custom elements + Leaflet en jsdom) cuando el navegador les quita el
// contexto o lo sueltan ellas, y lo vuelven a tomar en un canvas nuevo. Es el cierre transversal de la etapa 2: cada clase ya
// prueba su propia conversión (test/render/*-readquirir.test.mjs) sobre un doble; acá se prueba lo que sólo se ve con todas
// juntas, sobre un DOM de verdad y el techo de contextos de Chromium (test-helpers/navegador-falso.mjs).
//
//   T2.4  Varias clases en un pane compartido y en panes separados: el z-index de los panes y el orden de sus hijos son
//         los mismos antes y después de soltar, perder y re-adquirir. El canvas nuevo ocupa el lugar del marcador.
//   T2.6  `destroy` durante la pérdida o después deja 0 vivos, en cada clase: quitar la capa, y desmontar el mapa.
//   13    El modelo de 13 capas del Mapa Geotáctico con contextos ajenos que se crean después del montaje: toda capa
//         necesaria desalojada vuelve a pintar dentro del cupo, una por cuadro y la de mayor z primero, las prescindibles
//         (las cuatro capas vacías: dos líneas y la espiral y la sub-espiral del cluster) quedan soltadas, y ninguna llamada va a
//         un `gl` viejo. La política con más ajenos, el ping-pong y la saturación están en `contextos-politica`.
//
// Los cuadros los corre el test (`cuadro()`), así «una por cuadro» es determinista. Los eventos del navegador llegan con
// `navegador.vaciar()`. Corre con: node --test test/element/contextos-readquirir.test.mjs
//
// El harness va PRIMERO: window, customElements y lo que Lit toca al evaluar.
import { armar, armarVacio, asentar, esperar, ACC, LINEA, POLI, iconSet, items } from '../../test-helpers/modelo-capas.mjs'
import { makeEditGl, makePickSpy } from '../../test-helpers/engine-stub.mjs'
import { afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { createSource } from '../../src/data/index.js'

/* ── Cuadros a mano, y un reloj que avanza entre test y test ── */

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

// Un reloj que avanza entre test y test: nada de la política depende de él, y así lo fija.
const reloj   = performance.now.bind(performance)
let   desfase = 0
performance.now = () => reloj() + desfase
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

// Un mapa del modelo de `capas` capas (8 o 13) con los cuadros a mano.
const montar = async (capas = 13, opciones = {}) => {
  const { map, navegador } = await armar(capas, 'react', { crearGl, ...opciones })
  mapa = map
  await esperar(40)                              // lo que jsdom agendó al montar corre con su rAF, no con el del test
  cuadros()
  return { map, engine: map.engine, navegador }
}

const registro   = (engine, id) => engine.getLayer(id)
const superficie = (engine, id) => (r => (r.layer ?? r.editor).surface)(registro(engine, id))
const contextoDe = (navegador, engine, id) => navegador.contextos.find(c => c.gl === superficie(engine, id).gl)
const estados    = engine => Object.fromEntries(engine.surfaces().map(s => [s.layerId, s.state]))
const dibujos    = contexto => contexto.gl.llamadas.filter(([m]) => /^draw/.test(m)).length

// Ningún contexto perdido recibió una llamada después de perderse y ningún recurso de uno se usó en otro.
const intactos = navegador => {
  const tocados = navegador.contextos.filter(c => c.llamadasTrasPerdida).map(c => `#${c.id} ${c.pane}: ${c.llamadasTrasPerdida}`)
  assert.deepEqual(tocados, [], 'ninguna llamada a un contexto después de perderse')
  assert.deepEqual(navegador.violaciones, [], 'ningún recurso de un contexto usado en otro')
}

const ajenos = (navegador, n) => Array.from({ length: n }, () => navegador.ajeno())

// Las capas por z descendente, que es el orden en que la política las recupera.
const porZ = (engine, ids) => {
  const z = Object.fromEntries(engine.surfaces().map(s => [s.layerId, s.z]))
  assert.equal(new Set(ids.map(id => z[id])).size, ids.length, 'sin empates de z')
  return [...ids].sort((p, q) => z[q] - z[p])
}
// Las prescindibles del modelo son las capas sin contenido: las dos líneas que el kit monta «siempre, también vacías», y la
// espiral y la sub-espiral del cluster, que esperan una expansión.
const vaciasDe = engine => engine.surfaces().filter(s => !s.hasContent).map(s => s.layerId)

/* ── El modelo de 13 capas con contextos ajenos ── */

test('13 capas + 3 ajenos caben en el techo: una ráfaga de pérdidas suelta las vacías y vuelve a pintar de a una por cuadro, por z', async () => {
  const { engine, navegador } = await montar()
  const VACIAS = vaciasDe(engine)
  ajenos(navegador, 3)
  assert.equal(navegador.vivos, 16)
  assert.equal(navegador.desalojados, 0, 'trece más tres son el techo: nadie cae')

  const avisos = []
  engine.on('surfacechange', detail => avisos.push([detail.layerId, detail.state]))
  const perdidas = ['geo', 'lugares', 'enlaces', 'veh']
  perdidas.forEach(id => assert.equal(navegador.desalojar(contextoDe(navegador, engine, id)), true))
  navegador.vaciar()
  const creados = navegador.creados

  assert.deepEqual(perdidas.map(id => estados(engine)[id]), ['lost', 'lost', 'lost', 'lost'])
  assert.deepEqual(VACIAS.map(id => estados(engine)[id]), VACIAS.map(() => 'released'), 'bajo presión se sueltan las prescindibles')
  assert.equal(navegador.creados, creados, 'recuperar espera al cuadro: el evento no toma contexto')

  const orden = porZ(engine, perdidas)
  orden.forEach((id, i) => {
    cuadro()
    assert.equal(navegador.creados, creados + i + 1, `el cuadro ${i + 1} toma exactamente un contexto`)
    assert.equal(estados(engine)[id], 'live', `${id} vuelve en su cuadro, la de mayor z primero`)
    orden.slice(i + 1).forEach(otra => assert.equal(estados(engine)[otra], 'lost', `${otra} espera su turno`))
    assert.ok(dibujos(contextoDe(navegador, engine, id)) > 0, `${id} pinta en el mismo cuadro en que vuelve`)
  })

  cuadro()
  assert.equal(navegador.creados, creados + 4, 'con la cola vacía, un cuadro más no toma nada')
  assert.equal(navegador.desalojados, 4, 'sólo cayeron las cuatro que pidió el test: recuperarlas no desalojó a nadie')
  assert.equal(navegador.vivos, 12, 'las nueve necesarias y los tres ajenos')
  assert.deepEqual(avisos.filter(([, e]) => e !== 'released'), [...perdidas.map(id => [id, 'lost']), ...orden.map(id => [id, 'live'])],
    'cada una avisó perderse, con el evento, y volver, con su cuadro')
  assert.deepEqual(avisos.filter(([, e]) => e === 'released').map(([id]) => id).sort(), [...VACIAS].sort())
  intactos(navegador)
})

test('13 capas + 4 ajenos pasan el techo por una: cae una vacía, que queda soltada, y no se recupera nada', async () => {
  const { engine, navegador } = await montar()
  const VACIAS = vaciasDe(engine)
  const avisos = []
  engine.on('surfacechange', detail => avisos.push([detail.layerId, detail.state]))
  const creados = navegador.creados

  ajenos(navegador, 4)                                  // el cuarto pasa de 16: cae la capa de flush más viejo
  navegador.vaciar()
  for (let i = 0; i < 5; i++) cuadro()
  assert.equal(avisos.length, 1)
  const [[caida, estado]] = avisos
  assert.ok(VACIAS.includes(caida), `cae una prescindible, la de flush más viejo (cayó ${caida})`)
  assert.equal(estado, 'released')
  assert.equal(navegador.creados, creados + 4, 'ni un getContext propio')
  assert.equal(navegador.vivos, 16)
  intactos(navegador)
})

test('un reinicio de la GPU les quita el contexto a las trece: vuelven las nueve necesarias de a una por cuadro, y pintan', async () => {
  const { engine, navegador } = await montar()
  const VACIAS = vaciasDe(engine)
  ajenos(navegador, 3)
  const ids = engine.surfaces().map(s => s.layerId)
  assert.equal(ids.length, 13)
  const necesarias = ids.filter(id => !VACIAS.includes(id))

  const viejos = ids.map(id => contextoDe(navegador, engine, id))
  viejos.forEach(contexto => navegador.desalojar(contexto))
  navegador.vaciar()
  assert.equal(navegador.vivos, 3, 'sólo quedan los ajenos')
  const creados = navegador.creados

  necesarias.forEach((_, i) => {
    cuadro()
    assert.equal(navegador.creados, creados + i + 1, `el cuadro ${i + 1} toma un contexto`)
    const vuelta = necesarias.filter(id => estados(engine)[id] === 'live')
    assert.equal(vuelta.length, i + 1)
  })
  necesarias.forEach(id => assert.ok(dibujos(contextoDe(navegador, engine, id)) > 0, `${id} pinta al volver`))
  cuadro()
  assert.equal(navegador.creados, creados + 9)
  assert.deepEqual(VACIAS.map(id => estados(engine)[id]), VACIAS.map(() => 'released'), 'las vacías no vuelven hasta tener contenido')
  assert.equal(navegador.desalojados, 13, 'recuperar nueve con los trece cupos libres no desaloja a ninguna')
  assert.equal(navegador.vivos, 12)
  viejos.forEach(contexto => assert.equal(contexto.llamadasTrasPerdida, 0, `#${contexto.id} ${contexto.pane}: intacto`))
  intactos(navegador)
})

/* ── T2.4 · el lugar de cada canvas en su pane no cambia con soltar, perder y re-adquirir ── */

const SQUARE = [[0, 0], [0, 10], [10, 10], [10, 0]]
const forma  = { idOf: f => f.id, positionOf: f => f.center, radiusOf: f => f.radius }

// Una capa de cada clase que dibuja con WebGL. `pane` las junta en uno solo; sin él, cada una tiene el suyo.
const CLASES = ['punto', 'linea', 'poligono', 'forma', 'editor']
const clases = async (engine, pane) => {
  const en = { ...(pane && { pane, z: 450 }) }
  engine.addPointLayer({ id: 'punto', accessors: ACC, iconSet, data: items(2), interactive: true, ...en })
  engine.addLineLayer({ id: 'linea', accessors: LINEA, data: [{ id: 1, pts: [[0, 0], [1, 1]], color: '#00f', weight: 2, opacity: 1 }], ...en })
  engine.addPolygonLayer({ id: 'poligono', accessors: POLI, data: [{ id: 'z1' }], ...en })
  engine.addShapeLayer({ id: 'forma', accessors: forma, data: [{ id: 1, center: [0, 0], radius: 1e5 }], ...en })
  engine.addEditableLayer({ id: 'editor', kind: 'polygon', value: SQUARE, mode: 'edit', ...en })
  await esperar(40)       // los datos entran por la Source, que avisa en el cuadro de jsdom y no en los que corre el test
  await asentar(engine)   // y el primero le pide su contexto a la capa que nació vacía
  return CLASES
}

// Dónde está cada cosa: por pane, su z-index y sus hijos en orden —un canvas, por el id de su capa—. Los panes, además,
// son los mismos nodos.
const foto = (engine, ids) => {
  const capa  = new Map(ids.map(id => [superficie(engine, id).canvas, id]))
  const panes = [...new Set(ids.map(id => superficie(engine, id).canvas.parentNode))]
  return {
    panes,
    detalle: panes.map(pane => ({
      z     : pane.style.zIndex,
      hijos : [...pane.children].map(hijo => capa.get(hijo) ?? `dom:${hijo.className}`),
    })),
  }
}

for (const [nombre, pane] of [['en un pane compartido', 'comun'], ['en panes separados', undefined]]) {
  test(`T2.4 cinco clases ${nombre}: z-index y orden del DOM idénticos antes y después de soltar, perder y re-adquirir`, async () => {
    const { map, navegador } = await armarVacio({ crearGl })
    mapa = map
    cuadros()
    const { engine } = map
    const ids  = await clases(engine, pane)
    const base = foto(engine, ids)
    const igual = paso => assert.deepEqual(foto(engine, ids), base, paso)
    pane
      ? assert.deepEqual(base.detalle[0].hijos.filter(h => !h.startsWith('dom:')), ids, 'comparten un pane, en el orden del alta')
      : assert.equal(base.panes.length, 5, 'cada una tiene el suyo')
    const canvasInicial = ids.map(id => superficie(engine, id).canvas)

    // Una por una: soltada es un marcador en su lugar, y volver a tomar la contexto pone el canvas nuevo ahí.
    ids.forEach(id => {
      superficie(engine, id).release()
      igual(`${id} soltada`)
      assert.equal(superficie(engine, id).state, 'released')
      superficie(engine, id).acquire()
      igual(`${id} vuelta a tomar`)
    })

    // Una por una, perdida por el navegador y recuperada por la política en el cuadro siguiente.
    ids.forEach(id => {
      navegador.desalojar(contextoDe(navegador, engine, id))
      igual(`${id} desalojada, antes del evento`)
      navegador.vaciar()
      igual(`${id} perdida`)
      cuadro()
      igual(`${id} recuperada`)
      assert.equal(superficie(engine, id).state, 'live')
    })

    // Todas juntas: se sueltan y vuelven en el orden contrario al del alta.
    ids.forEach(id => superficie(engine, id).release())
    igual('todas soltadas')
    ;[...ids].reverse().forEach(id => {
      superficie(engine, id).acquire()
      igual(`${id} vuelta a tomar, en orden inverso`)
    })

    // Un reinicio de la GPU las pierde a todas; la política las recupera de a una, la de mayor z primero (el editor, la última
    // dada de alta), y entre medio hay las que ya volvieron, las que esperan y la que se suelta a mano.
    ids.forEach(id => navegador.desalojar(contextoDe(navegador, engine, id)))
    navegador.vaciar()
    igual('todas perdidas')
    cuadro()
    igual('la primera recuperada, las demás perdidas')
    assert.deepEqual(ids.map(id => superficie(engine, id).state), ['lost', 'lost', 'lost', 'lost', 'live'])
    superficie(engine, 'punto').release()                        // la que espera su turno se suelta: sale de la política
    igual('una perdida que se suelta')
    for (let i = 0; i < ids.length - 1; i++) {
      cuadro()
      igual(`recuperación ${i + 2}`)
    }
    cuadro()
    assert.deepEqual(ids.map(id => superficie(engine, id).state), ['released', 'live', 'live', 'live', 'live'], 'la soltada no vuelve sola')
    superficie(engine, 'punto').acquire()
    igual('y vuelve a mano')

    assert.deepEqual(ids.map(id => superficie(engine, id).state), Array(5).fill('live'))
    ids.forEach((id, i) => {
      assert.notEqual(superficie(engine, id).canvas, canvasInicial[i], `${id} tiene un canvas nuevo`)
      assert.equal(canvasInicial[i].isConnected, false, `y el viejo ya no está en el documento`)
    })
    assert.deepEqual(foto(engine, ids).panes, base.panes, 'los panes son los mismos nodos')
    intactos(navegador)
  })
}

/* ── T2.6 · destruir durante la pérdida o después deja 0 vivos, en cada clase ── */

// En qué estado está la superficie de la capa cuando se la destruye. `contexto` es el que tenía antes.
const ESTADOS = [
  ['viva',                                          () => {}],
  ['perdida, antes de que llegue el evento',        (n, s, c) => n.desalojar(c)],
  ['perdida, esperando su cuadro',                  (n, s, c) => (n.desalojar(c), n.vaciar())],
  ['recuperada',                                    (n, s, c) => (n.desalojar(c), n.vaciar(), cuadro())],
  ['soltada',                                       (n, s) => s.release()],
]

// Después de destruir, nada se resucita: ni el evento que deja el `loseContext`, ni los cuadros de la política.
const sinResucitar = navegador => {
  const creados = navegador.creados
  navegador.vaciar()
  for (let i = 0; i < 5; i++) cuadro()
  navegador.vaciar()
  assert.equal(navegador.creados, creados, 'ningún getContext después de destruir')
  assert.equal(agendados.size, 0, 'y nada agendado')
}

for (const clase of CLASES) {
  for (const [estado, llevar] of ESTADOS) {
    test(`T2.6 ${clase} ${estado}: removeLayer deja sus contextos en 0 y no la resucita`, async () => {
      const { map, navegador } = await armarVacio({ crearGl })
      mapa = map
      cuadros()
      const { engine } = map
      const ids = await clases(engine)
      const otras = ids.filter(id => id !== clase)
      assert.equal(navegador.vivos, 5)

      const original = contextoDe(navegador, engine, clase)
      const antes    = navegador.creados
      llevar(navegador, superficie(engine, clase), original)
      const propios = [original, ...navegador.contextos.slice(antes)]      // el que tenía y, si ya volvió, el nuevo
      const canvas  = superficie(engine, clase).canvas                      // el vivo o, sin contexto, el marcador
      engine.removeLayer(clase)
      assert.equal(canvas.isConnected, false, 'el canvas, o el marcador, se va del documento')

      assert.equal(navegador.vivos, 4, 'sólo quedan las otras cuatro')
      assert.deepEqual(propios.map(c => c.estado), propios.map(() => 'perdido'), 'ningún contexto de la capa sigue vivo')
      assert.deepEqual(otras.map(id => superficie(engine, id).state), Array(4).fill('live'), 'las otras no se enteraron')
      assert.equal(engine.surfaces().length, 4)
      sinResucitar(navegador)
      assert.equal(navegador.vivos, 4)
      intactos(navegador)
    })
  }
}

// El mapa entero, con el modelo de 13 capas: lo que desmonta `map.remove()` en cada momento de la recuperación.
const CUATRO     = ['geo', 'lugares', 'enlaces', 'veh']
const perderCuatro = (navegador, engine) => CUATRO.forEach(id => navegador.desalojar(contextoDe(navegador, engine, id)))
const MOMENTOS = [
  ['con cuatro capas perdidas, antes de que lleguen los eventos', perderCuatro],
  ['con cuatro perdidas esperando su cuadro',                     (n, e) => (perderCuatro(n, e), n.vaciar())],
  ['con dos de cuatro recuperadas y dos esperando',               (n, e) => (perderCuatro(n, e), n.vaciar(), cuadro(), cuadro())],
  ['con las cuatro recuperadas',                                  (n, e) => (perderCuatro(n, e), n.vaciar(), [1, 2, 3, 4].forEach(cuadro))],
  ['con tres capas soltadas',                                     (n, e) => ['geo', 'veh', 'rutas'].forEach(id => superficie(e, id).release())],
]

for (const [momento, llevar] of MOMENTOS) {
  test(`T2.6 modelo de 13 capas ${momento}: map.remove() deja 0 vivos y no resucita nada`, async () => {
    const { map, engine, navegador } = await montar()
    llevar(navegador, engine)
    const hasta = navegador.creados
    mapa = null
    map.remove()

    assert.equal(navegador.vivos, 0, `quedaron contextos: ${navegador.resumen()}`)
    sinResucitar(navegador)
    assert.equal(navegador.creados, hasta, 'destruir no toma ningún contexto')
    assert.equal(navegador.vivos, 0)
    intactos(navegador)
  })
}

/* ── Una capa oculta conserva su contexto; perdido, no lo vuelve a tomar hasta que se muestra, y entonces pinta ── */

for (const clase of ['punto', 'linea', 'poligono', 'forma']) {
  test(`${clase} oculta: conserva su contexto; desalojada queda soltada, y al mostrarla lo toma y pinta en la misma tarea`, async () => {
    const { map, navegador } = await armarVacio({ crearGl })
    mapa = map
    cuadros()
    const { engine } = map
    await clases(engine)

    engine.setLayerVisibility(clase, false)
    for (let i = 0; i < 3; i++) cuadro()
    assert.equal(superficie(engine, clase).state, 'live', 'ocultarla no suelta nada')
    const creados = navegador.creados
    navegador.desalojar(contextoDe(navegador, engine, clase))
    navegador.vaciar()
    for (let i = 0; i < 3; i++) cuadro()
    assert.equal(superficie(engine, clase).state, 'released', 'prescindible: no se recupera mientras no se vea')
    assert.equal(navegador.creados, creados, 'ni un getContext')

    engine.setLayerVisibility(clase, true)
    const nuevo = contextoDe(navegador, engine, clase)
    assert.equal(superficie(engine, clase).state, 'live')
    assert.equal(navegador.creados, creados + 1)
    assert.equal(superficie(engine, clase).canvas.style.display, '')
    assert.ok(dibujos(nuevo) > 0, 'al mostrarla, pinta en el acto')
    intactos(navegador)
  })
}

/* ── El recambio de source de una capa que no tiene contexto ── */

for (const [estado, llevar] of [
  ['perdida, antes de que llegue el evento', (n, s, c) => n.desalojar(c)],
  ['perdida, esperando su cuadro',           (n, s, c) => (n.desalojar(c), n.vaciar())],
  ['soltada',                                (n, s) => s.release()],
]) {
  test(`attachSource de una capa ${estado}: la capa nueva toma un contexto, ocupa el lugar de la vieja y la política no la duplica`, async () => {
    const { map, navegador } = await armarVacio({ crearGl })
    mapa = map
    cuadros()
    const { engine } = map
    const fuente = () => (s => (s.set(items(2)), s))(createSource(ACC))
    ;['a', 'b', 'c'].forEach(id => engine.addPointLayer({ id, source: fuente(), iconSet, pane: 'comun', z: 450 }))
    const orden = () => (hijos => ['a', 'b', 'c'].sort((p, q) =>
      hijos.indexOf(superficie(engine, p).canvas) - hijos.indexOf(superficie(engine, q).canvas)))([...superficie(engine, 'a').canvas.parentNode.children])
    assert.deepEqual(orden(), ['a', 'b', 'c'])

    llevar(navegador, superficie(engine, 'b'), contextoDe(navegador, engine, 'b'))
    const creados = navegador.creados
    engine.attachSource('b', fuente())

    assert.equal(navegador.creados, creados + 1, 'la capa nueva toma el suyo')
    assert.deepEqual(orden(), ['a', 'b', 'c'], 'en el lugar de la vieja')
    assert.equal(navegador.vivos, 3)
    assert.deepEqual(Object.values(estados(engine)), ['live', 'live', 'live'])

    navegador.vaciar()                                   // el evento que dejó la vieja ya no es de nadie
    for (let i = 0; i < 4; i++) cuadro()
    assert.equal(navegador.creados, creados + 1, 'y nada la recupera por segunda vez')
    assert.deepEqual(orden(), ['a', 'b', 'c'])
    intactos(navegador)
  })
}
