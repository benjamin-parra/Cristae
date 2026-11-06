// El editor de geometría sobre una superficie que pierde su contexto, o lo suelta, y lo vuelve a tomar en otro:
// rehace su parte GL —textura y VBO de cada arena, programas, VAO, binding del atlas, picking y relleno— desde los
// espejos de CPU, dibuja lo mismo y no toca el contexto viejo. Con el navegador falso (test-helpers/navegador-falso.mjs),
// que desaloja como Chromium y lanza si un recurso de un contexto se usa en otro. Los cuadros los corre el test
// (`cuadro()`), y los eventos del navegador llegan con `navegador.vaciar()`. El resto del árbol (ChunkedPath, arena,
// capas, picking, puerta del puntero) es el REAL.
// Corre con: node --test test/render/edit-readquirir.test.mjs
import '../../test-helpers/engine-stub.mjs'
import { contadorNodos, decorarElementos, makeDragging, makeEditGl, makeMap, makePickSpy } from '../../test-helpers/engine-stub.mjs'
import { conNavegador, crearNavegador } from '../../test-helpers/navegador-falso.mjs'
import { after, afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { isDeepStrictEqual } from 'node:util'
import { Camera } from '../../src/engine/Camera.js'
import { Interaction } from '../../src/engine/Interaction.js'
import { HANDLE_NONE, HANDLE_OVER } from '../../src/events/events.js'
import { ROLE } from '../../src/geometry/ChunkedPath.js'
import { byDefault } from '../../src/geometry/geodesic.js'
import { adoptLeafletHost } from '../../src/host/LeafletHost.js'
import { LayerRegistry } from '../../src/interaction/LayerRegistry.js'
import { defineEditIconSet, editHandleChannels } from '../../src/render/EditHandleLayer.js'
import { EditableGeometry } from '../../src/render/EditableGeometry.js'

/* ── Cuadros a mano, y un reloj que avanza entre test y test ── */

const rafPrevio    = globalThis.requestAnimationFrame
const cancelPrevio = globalThis.cancelAnimationFrame
const agendados    = new Map()
let serie          = 0
globalThis.requestAnimationFrame = cb => (agendados.set(++serie, cb), serie)
globalThis.cancelAnimationFrame  = id => agendados.delete(id)

// Corre lo agendado hasta ahora: lo que se agenda durante el cuadro va al siguiente.
const cuadro = () => {
  const ahora = [...agendados.values()]
  agendados.clear()
  ahora.forEach(cb => cb(0))
}

// La política no recupera una pérdida que llega hasta un segundo después de otra recuperación: cada test empieza
// lejos de la del anterior.
const reloj   = performance.now.bind(performance)
let   desfase = 0
performance.now = () => reloj() + desfase
beforeEach(() => { desfase += 10_000 })

after(() => {
  globalThis.requestAnimationFrame = rafPrevio
  globalThis.cancelAnimationFrame  = cancelPrevio
  performance.now                  = reloj
})

/* ── Harness ── */

// Cada contexto anota lo que le piden, con los datos copiados en el momento: lo que viajó, no el espejo vivo. Las
// constantes que el doble no define (`gl.TRIANGLES`) le llegan como una función por contexto: se anotan como tales.
const copia  = v => (ArrayBuffer.isView(v) ? Array.from(v) : typeof v === 'function' ? 'enum' : v)
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

const P = 100                            // el harness proyecta lineal: un grado son 100 px de contenedor

// El canal del tile TRANSPARENTE, con el que el editor apaga un handle del visual y del pase a la vez.
const TILE_VACIO = editHandleChannels(defineEditIconSet()).tiles[ROLE.free]
// Los canvases que `sprite()` arma para el banco DOM salen del atlas, una vez por proceso: se adelantan para que los conteos de nodos midan el gesto.
;['off', 'vertex', 'midpoint', 'hover', 'grabbing'].forEach(v => defineEditIconSet().sprite(v))

const nuevoNavegador = (opciones = {}) => crearNavegador({
  crearGl: canvas => {
    const spy = makePickSpy()
    spy.tileVacio = TILE_VACIO
    return grabar(makeEditGl(spy, canvas))
  },
  ...opciones,
})

// Lo que cuenta como «dibujar lo mismo»: lo que se sube y lo que se dibuja.
const SUBIDAS  = new Set(['bufferData', 'texImage2D', 'texSubImage2D', 'drawArrays'])
const subidas  = contexto => contexto.gl.llamadas.filter(([m]) => SUBIDAS.has(m))

// Lo subido lleva texturas y buffers enteros: `deepEqual` armaría un diff de cientos de miles de números al fallar.
const iguales = (actual, esperado, mensaje) => assert.ok(isDeepStrictEqual(actual, esperado), mensaje)
const llamados = (contexto, metodo) => contexto.gl.llamadas.filter(([m]) => m === metodo)

// Los recursos que se crean y se enlazan, sin los datos: lo que un contexto nuevo tiene que volver a armar.
const ARMADO = /^(create|link|attach|bindAttrib|getUniformLocation|uniform1[if]|texParameteri|renderbufferStorage)/
const armado = contexto => contexto.gl.llamadas
  .filter(([m]) => ARMADO.test(m))
  .map(([m, ...args]) => [m, ...args.filter(a => typeof a !== 'object')].join(' '))
  .sort()

// Lo que quedó agendado corre antes de soltar el navegador: una recuperación que no corre deja a la política
// esperando un cuadro que no llega.
let soltar = null
afterEach(() => {
  for (let i = 0; agendados.size && i < 20; i++) cuadro()
  agendados.clear()
  soltar?.()
  soltar = null
})

const SQUARE   = [[0, 0], [0, 10], [10, 10], [10, 0]]
const HUECO    = [[2, 2], [2, 4], [4, 4], [4, 2]]
const DIAGONAL = Array.from({ length: 6 }, (_, i) => [i, 2 * i])

const montar = ({ navegador = nuevoNavegador(), kind = 'polygon', value = SQUARE, mode = 'edit', zoom } = {}) => {
  soltar ??= conNavegador(navegador)
  const dragging  = makeDragging()
  const map       = { ...makeMap({ zoom }), dragging }
  const container = map.getContainer()
  const changes   = [], commits = [], informes = [], alMapa = []
  const host      = adoptLeafletHost(map)
  const puerta    = new Interaction({ host, camera: new Camera({ host }), registry: new LayerRegistry(), bus: { dispatch() {} }, onEmptyClick: latlng => alMapa.push(latlng) })
  const ed = new EditableGeometry({
    host, join: participante => puerta.join(participante, 0, 0), pane: 'edit', kind, value, mode,
    onChange: leer => changes.push(leer()),
    onCommit: leer => commits.push(leer()),
    onHandleLevel: nivel => informes.push(nivel),
  })
  return {
    ed, map, container, dragging, changes, commits, informes, alMapa, navegador, punto: [0, 0],
    contexto : i => navegador.contextos[i],
    vivo     : () => navegador.contextos.find(c => c.gl === ed.surface.gl),     // el contexto que tiene hoy
  }
}

// Un contexto viejo intacto: ni una llamada después de perderse y ningún recurso suyo usado en otro.
const intacto = (navegador, i) => {
  assert.equal(navegador.contextos[i].llamadasTrasPerdida, 0, `ninguna llamada al contexto #${i} después de perderse`)
  assert.deepEqual(navegador.violaciones, [], 'ningún recurso de un contexto usado en otro')
}

const emitir = (esc, tipo, x, y) =>
  esc.container.emitir(tipo, { clientX: x, clientY: y, target: esc.container, pointerId: 1, pointerType: 'mouse' })

// Qué HAY bajo el puntero, no qué contesta el pase: se declara la entrada del arena y el doble de GL del contexto
// vivo sólo la devuelve si algún draw del trazo la cubrió y su tile la deja escribir.
const apuntar = (esc, ref, anillo = 0) => {
  const path = esc.ed.paths[anillo]
  const vivo = esc.vivo()
  vivo && (vivo.gl.spy.bajoElCursor = { obj: anillo + 1, entrada: ref, local: path.localOf(ref) })
  return esc
}

const refsDe = path => {
  const out = []
  path.forEachVertex((x, y, ref) => out.push(ref))
  return out
}

// La pulsación cae SOBRE el handle: el píxel queda anotado para el `pointerup`.
const pulsar = (esc, tipo, ref, anillo = 0) => {
  apuntar(esc, ref, anillo)
  const path = esc.ed.paths[anillo]
  esc.punto = [path.yAt(ref) * P, path.xAt(ref) * P]
  return emitir(esc, tipo, esc.punto[0], esc.punto[1])
}

const tomar  = (esc, ref, anillo = 0) => pulsar(esc, 'pointerdown', ref, anillo)
const mover  = (esc, lat, lng) => emitir(esc, 'pointermove', lng * P, lat * P)
const soltarPuntero = esc => emitir(esc, 'pointerup', esc.punto[0], esc.punto[1])

// Un hover RESUELTO: el pase de hover no bloquea, así que la primera muestra lo pide y la segunda lo cobra.
const posar = (esc, ref, anillo = 0) => {
  apuntar(esc, ref, anillo)
  const path = esc.ed.paths[anillo]
  const x = path.yAt(ref) * P, y = path.xAt(ref) * P
  emitir(esc, 'pointermove', x, y)
  emitir(esc, 'pointermove', x, y)
  return esc
}

/* ── T2.1 · adquirir → soltar → adquirir dibuja lo mismo ── */

const ESCENARIOS = [
  ['polygon de un anillo',   { kind: 'polygon', value: SQUARE }],
  ['polygon con un hueco',   { kind: 'polygon', value: [SQUARE, HUECO] }],
  ['polyline',               { kind: 'polyline', value: DIAGONAL }],
  ['point',                  { kind: 'point', value: [1, 2] }],
  ['rectangle',              { kind: 'rectangle', value: [[0, 0], [5, 8]] }],
  ['circle',                 { kind: 'circle', value: { center: [0, 0], radius: 100000 }, zoom: 10 }],
  ['ellipse',                { kind: 'ellipse', value: { center: [0, 0], radius: [100000, 60000] }, zoom: 10 }],
]

for (const [nombre, opciones] of ESCENARIOS) {
  test(`T2.1 ${nombre}: re-adquirido sube los mismos bytes y dibuja lo mismo, y el contexto viejo no se toca`, () => {
    const esc = montar(opciones)
    const { navegador } = esc
    const antes = subidas(esc.contexto(0))
    assert.ok(antes.some(([m]) => m === 'texImage2D') && antes.some(([m]) => m === 'drawArrays'), 'el alta subió y dibujó')

    assert.equal(esc.ed.surface.release(), true)
    assert.equal(navegador.vivos, 0, 'soltarlo devuelve el cupo en el acto')
    esc.ed.surface.acquire()
    iguales(subidas(esc.contexto(1)), antes, 'las mismas texturas, los mismos VBO y el mismo dibujo, en la misma tarea')

    // Lo que sigue va al contexto nuevo: el reasentado de la vista, un frame del zoom, un cambio de estilo.
    esc.map.fire('zoomend')
    esc.ed.setStyle({ weight: 5 })
    navegador.vaciar()                                    // el `webglcontextlost` que deja `loseContext`
    assert.equal(esc.ed.surface.state, 'live', 'el aviso de soltar no es una pérdida')
    assert.equal(navegador.creados, 2)
    intacto(navegador, 0)
    esc.ed.destroy()
  })
}

// Con curva el contorno es otro arena con su propio path: el mismo dibujo, sobre el stack que `setCurve` armó.
test('T2.1 polyline curva: re-adquirida dibuja los mismos segmentos, con el arena del contorno incluido', () => {
  const esc = montar({ kind: 'polyline', value: DIAGONAL })
  esc.ed.setCurve(byDefault)
  const ultimoCuadro = contexto => {
    const llamadas = contexto.gl.llamadas
    return llamadas.slice(llamadas.findLastIndex(([m]) => m === 'clear')).filter(([m]) => m === 'drawArrays')
  }
  const antes = ultimoCuadro(esc.contexto(0))
  assert.ok(antes.length > 1, 'dibujó el trazo curvo y los handles')

  esc.ed.surface.release()
  esc.ed.surface.acquire()
  assert.deepEqual(ultimoCuadro(esc.contexto(1)), antes)
  const posiciones = llamados(esc.contexto(1), 'texImage2D').filter(llamada => Array.isArray(llamada.at(-1)))
  assert.equal(posiciones.length, 2, 'las texturas de posiciones del arena de los handles y del arena del contorno')
  intacto(esc.navegador, 0)
  esc.ed.destroy()
})

// Sin contexto, cada camino que toca GL sale sin tocarlo: un valor nuevo, un estilo, un cambio de modo, el trazado con
// clicks, la curva, el reasentado y un frame del zoom. Lo de CPU sigue: al volver, sube el espejo con todo eso adentro,
// y es el mismo que deja editar con el contexto vivo (B edita vivo y se suelta después para rehacerse del espejo).
test('T2.1: lo que llega sin contexto queda en el espejo, y es el mismo que deja editar con él', () => {
  const navegador = nuevoNavegador()
  const A = montar({ navegador, kind: 'polyline', value: DIAGONAL.slice(0, 3) })
  const B = montar({ navegador, kind: 'polyline', value: DIAGONAL.slice(0, 3) })
  const editar = esc => {
    esc.ed.setMode('draw')
    esc.ed.handleMapClick({ lat: 7, lng: 3 })
    esc.ed.handleMapClick({ lat: 8, lng: 9 })
    esc.ed.setMode('freehand')                               // el dedo traza: la pulsación es del trazo, sin handles
    emitir(esc, 'pointerdown', 100, 100)
    for (let i = 1; i <= 8; i++) emitir(esc, 'pointermove', 100 + 12 * i, 100 + 7 * i)
    emitir(esc, 'pointerup', 196, 156)
    esc.ed.setMode('edit')
    esc.ed.setValue([...esc.ed.getValue(), [9, 1]])
    esc.ed.setCurve(byDefault)
    esc.ed.setStyle({ weight: 6, color: '#ff0000' })
    esc.map.fire('moveend')
    esc.map.fire('zoom', { pinch: true })
    esc.ed.setCurve(null)
  }

  A.ed.surface.release()
  const creados = navegador.creados
  editar(A)
  assert.equal(A.ed.surface.state, 'released')
  assert.equal(navegador.creados, creados, 'nada pidió un contexto')
  assert.equal(A.contexto(0).llamadasTrasPerdida, 0, 'ni una llamada al contexto soltado')

  editar(B)
  B.ed.surface.release()
  A.ed.surface.acquire()
  B.ed.surface.acquire()
  assert.deepEqual(A.ed.getValue(), B.ed.getValue())
  assert.deepEqual(A.ed.getValue().at(-1), [9, 1])
  assert.ok(A.ed.getValue().length > 6, 'el trazo a mano alzada también se registró sin contexto')
  assert.deepEqual(A.dragging.activo, true, 'y devolvió el arrastre del mapa')
  iguales(subidas(A.vivo()), subidas(B.vivo()), 'el mismo espejo en los dos, subido entero')
  assert.deepEqual(navegador.violaciones, [])
  A.ed.destroy()
  B.ed.destroy()
})

// Una forma tiene un arena más, el de su anillo, que también es de CPU mientras no hay contexto.
test('T2.1: una forma editada sin contexto deja el mismo espejo que editada con él, anillo incluido', () => {
  const navegador = nuevoNavegador()
  const A = montar({ navegador, kind: 'circle', value: { center: [0, 0], radius: 100000 }, zoom: 10 })
  const B = montar({ navegador, kind: 'circle', value: { center: [0, 0], radius: 100000 }, zoom: 10 })
  const editar = esc => {
    esc.ed.setValue({ center: [1, 2], radius: 250000 })
    esc.map.fire('zoomend')
    esc.ed.setStyle({ fillOpacity: 0.2 })
    esc.ed.setMode('draw')
    esc.ed.handleMapClick({ lat: 3, lng: 4 })              // el centro de una figura nueva
    esc.ed.handleMapClick({ lat: 3, lng: 5 })              // y su radio
    esc.ed.setMode('edit')
  }

  A.ed.surface.release()
  editar(A)
  assert.equal(A.contexto(0).llamadasTrasPerdida, 0, 'ni una llamada al contexto soltado')

  editar(B)
  B.ed.surface.release()
  A.ed.surface.acquire()
  B.ed.surface.acquire()
  assert.deepEqual(A.ed.getValue(), B.ed.getValue())
  assert.equal(A.ed.getValue().center[0], 3, 'la figura nueva quedó')
  iguales(subidas(A.vivo()), subidas(B.vivo()), 'el mismo espejo en los dos, subido entero')
  assert.deepEqual(navegador.violaciones, [])
  A.ed.destroy()
  B.ed.destroy()
})

// El tamaño de los handles va en px del buffer, y la escala se mide sobre el canvas que se tiene: el nuevo puede
// tener la misma resolución y otra caja (la ventana pasó a otro monitor mientras no había contexto).
test('T2.1: re-adquirido, la escala se mide sobre el canvas nuevo y los tamaños de los handles se recodifican', () => {
  const caja = { ancho: 400 }                             // 800 px de buffer en 400 px CSS: escala 2
  const esc  = montar()
  const sinCaja = decorarElementos((el, tag) => (tag === 'canvas' && Object.defineProperty(el, 'clientWidth', { get: () => caja.ancho }), el))
  try {
    // La entrada 0 de un polígono es su primer vértice, y su tamaño es el canal 6 de la entrada.
    const tamanio = contexto => llamados(contexto, 'bufferData').find(([, , src]) => Array.isArray(src))[2][6]
    assert.equal(tamanio(esc.contexto(0)), 12, 'el primero no tenía caja: escala 1')

    esc.ed.surface.release()
    esc.ed.surface.acquire()
    assert.equal(tamanio(esc.contexto(1)), 24, '12 px CSS son 24 del buffer')

    caja.ancho = 800                                      // el mismo buffer en otra caja
    esc.ed.surface.release()
    esc.ed.surface.acquire()
    assert.equal(tamanio(esc.contexto(2)), 12)
  } finally {
    sinCaja()
  }
  esc.ed.destroy()
})

/* ── T2.2 · programas en el contexto nuevo, y el estado fijo reaplicado ── */

for (const [nombre, opciones] of ESCENARIOS.filter(([, o]) => ['polygon', 'circle', 'polyline'].includes(o.kind))) {
  test(`T2.2 ${nombre}: el contexto nuevo arma los mismos recursos, programas y uniformes fijos que el primero`, () => {
    const esc = montar(opciones)
    esc.ed.surface.release()
    esc.ed.surface.acquire()
    const nuevo = esc.contexto(1)
    assert.deepEqual(armado(nuevo), armado(esc.contexto(0)))

    const rellena = opciones.kind !== 'polyline'
    const enlaces = llamados(nuevo, 'linkProgram').length
    const trazos  = esc.ed.paths.length || 1
    assert.equal(enlaces, (rellena ? 3 : 0) + 1 + 2 * trazos, 'el relleno (3), el del trazo (1) y el visual y el del pase de cada trazo')
    const nombres = llamados(nuevo, 'getUniformLocation').map(([, , n]) => n)
    assert.equal(nombres.filter(n => n === 'uPos').length, rellena ? 2 : 0, 'uPos del relleno, que se fija con el enlace')
    assert.equal(nombres.filter(n => n === 'uMaxIndex').length, 2 * trazos, 'las dimensiones del atlas, en cada programa que lo muestrea')
    esc.ed.destroy()
  })
}

/* ── E02 · el VAO de los handles se enlaza sobre el VBO del arena, que se arma antes ── */

// `EditableGeometry.buildGl` arma el arena de cada trazo (textura y VBO) ANTES que sus handles: el VAO de los handles
// se enlaza con `linkPointProgram(gl, arena.vbo)`, y con el VBO todavía en null el enlace queda sobre ningún buffer
// (`vertexAttribPointer` con offset sin ARRAY_BUFFER es INVALID_OPERATION): los handles no se ven ni se pican después
// de re-adquirir. El navegador falso no lanza acá para que el error se lea: sin violaciones y con `getError` limpio.
const sinErrorGl = (esc, i) => {
  const { navegador } = esc
  assert.deepEqual(navegador.violaciones, [], 'ningún vertexAttribPointer sin ARRAY_BUFFER enlazado')
  assert.equal(esc.contexto(i).gl.getError(), esc.contexto(i).gl.NO_ERROR, `el contexto #${i} no retiene ningún error`)
}

for (const [nombre, opciones] of ESCENARIOS) {
  test(`E02 ${nombre}: los handles enlazan su VAO sobre el VBO del arena, al construirse y re-adquirido`, () => {
    const esc = montar({ ...opciones, navegador: nuevoNavegador({ estricto: false }) })
    sinErrorGl(esc, 0)

    esc.ed.surface.release()
    esc.ed.surface.acquire()
    sinErrorGl(esc, 1)

    esc.navegador.desalojar(esc.vivo())                  // y desalojado, en el cuadro de la política
    esc.navegador.vaciar()
    cuadro()
    assert.equal(esc.ed.surface.state, 'live')
    sinErrorGl(esc, 2)
    esc.ed.destroy()
  })
}

// El arena del contorno es otro si la polilínea es curva, y se arma antes que su trazo.
test('E02 polyline curva: el contorno también arma su arena antes de enlazar nada', () => {
  const esc = montar({ kind: 'polyline', value: DIAGONAL, navegador: nuevoNavegador({ estricto: false }) })
  esc.ed.setCurve(byDefault)
  esc.ed.surface.release()
  esc.ed.surface.acquire()
  sinErrorGl(esc, 1)
  esc.ed.destroy()
})

/* ── T2.3 · un desalojo se re-adquiere y pinta en el cuadro siguiente ── */

test('T2.3: desalojado, se re-adquiere en el cuadro siguiente al aviso y pinta en ese mismo cuadro', () => {
  const esc = montar({ value: [SQUARE, HUECO] })
  const { navegador } = esc
  navegador.desalojar(esc.contexto(0))
  assert.equal(esc.ed.surface.state, 'lost', 'perdido en el acto')
  navegador.vaciar()
  assert.equal(navegador.creados, 1, 'no en la tarea del aviso')
  assert.equal(llamados(esc.contexto(0), 'drawArrays').length > 0, true)

  cuadro()
  assert.equal(navegador.creados, 2)
  assert.equal(esc.ed.surface.state, 'live')
  iguales(subidas(esc.contexto(1)), subidas(esc.contexto(0)), 'subió y dibujó lo mismo que el contexto perdido')
  assert.deepEqual([esc.contexto(0).eventoPerdida.defaultPrevented, esc.contexto(0).llamadasTrasPerdida], [false, 0], 'nadie cancela la pérdida')
  intacto(navegador, 0)
  esc.ed.destroy()
})

// El hover promovido es DOM sobre un mapa que ya no se ve: se suelta, y el cursor deja de decir que hay un handle.
test('T2.3: perdido con un vecindario promovido, lo suelta y vuelve a dejar el nivel en ninguno', () => {
  const nodos = contadorNodos()
  const esc   = montar()
  const base  = nodos.vivos
  posar(esc, refsDe(esc.ed.paths[0])[1])
  assert.deepEqual(esc.informes, [HANDLE_OVER])
  assert.equal(nodos.vivos, base + 3, 'el vértice y sus dos adyacentes, como nodos')

  esc.navegador.desalojar(esc.contexto(0))
  esc.navegador.vaciar()
  assert.deepEqual(esc.informes, [HANDLE_OVER, HANDLE_NONE])
  assert.equal(nodos.vivos, base, 'sin vecindario')
  cuadro()
  assert.equal(nodos.vivos, base, 'el canvas nuevo ocupa el lugar del marcador: ni uno más')
  esc.ed.destroy()
  assert.equal(nodos.vivos, 0, 'destroy devuelve todo')
})

// El gesto es del dedo, no del contexto: sigue y asienta, y el vértice tomado se ve en su lugar al volver.
test('T2.3: desalojado en pleno arrastre, el gesto sigue y asienta, y el contexto nuevo dibuja el vértice vivo', () => {
  const esc = montar()
  const v1  = refsDe(esc.ed.paths[0])[1]
  tomar(esc, v1)
  mover(esc, 5, 20)
  assert.deepEqual(esc.changes.at(-1)[1], [5, 20])

  esc.navegador.desalojar(esc.contexto(0))
  esc.navegador.vaciar()
  mover(esc, 6, 21)                                       // sin contexto: edita sin dibujar
  assert.deepEqual(esc.changes.at(-1)[1], [6, 21])
  assert.equal(esc.contexto(0).llamadasTrasPerdida, 0)

  cuadro()                                                // vuelve a tener contexto, con el gesto vivo
  assert.equal(esc.ed.surface.state, 'live')
  const vivo = esc.vivo()
  assert.ok(llamados(vivo, 'drawArrays').length > 0, 'pintó en el cuadro de la recuperación')
  mover(esc, 7, 22)
  soltarPuntero(esc)
  assert.deepEqual(esc.ed.getValue()[1], [7, 22])
  assert.equal(esc.commits.length, 1, 'asentó una sola vez')
  intacto(esc.navegador, 0)
  esc.ed.destroy()
})

/* ── T2.5 · nadie cancela la pérdida ── */

test('T2.5: ni el desalojo ni la liberación se cancelan con preventDefault', () => {
  const esc = montar()
  esc.navegador.desalojar(esc.contexto(0))
  esc.navegador.vaciar()
  cuadro()
  esc.ed.surface.release()
  esc.navegador.vaciar()
  assert.deepEqual([esc.contexto(0), esc.contexto(1)].map(c => c.eventoPerdida.defaultPrevented), [false, false])
  esc.ed.destroy()
})

/* ── T2.6 · destruirlo durante la pérdida o después deja 0 vivos ── */

test('T2.6: destruido mientras espera su turno, no se re-adquiere', () => {
  const nodos = contadorNodos()
  const esc   = montar({ value: [SQUARE, HUECO] })
  esc.navegador.desalojar(esc.contexto(0))
  esc.navegador.vaciar()
  esc.ed.destroy()
  cuadro()
  assert.deepEqual([esc.navegador.creados, esc.navegador.vivos], [1, 0])
  assert.equal(nodos.vivos, 0)
})

test('T2.6: destruido después de re-adquirir, devuelve el contexto nuevo sin borrar recurso por recurso', () => {
  const nodos = contadorNodos()
  const esc   = montar({ kind: 'circle', value: { center: [0, 0], radius: 100000 }, zoom: 10 })
  esc.navegador.desalojar(esc.contexto(0))
  esc.navegador.vaciar()
  cuadro()
  const antes = esc.vivo().gl.llamadas.length
  esc.ed.destroy()
  assert.deepEqual([esc.navegador.creados, esc.navegador.vivos, esc.navegador.liberados], [2, 0, 1])
  assert.equal(esc.contexto(1).gl.llamadas.slice(antes).filter(([m]) => /^delete/.test(m)).length, 0, 'loseContext libera todo de una vez')
  assert.equal(nodos.vivos, 0)
  intacto(esc.navegador, 0)
})

test('T2.6: soltado y destruido, no toca el contexto soltado ni vuelve a tomar uno', () => {
  const esc = montar()
  esc.ed.surface.release()
  esc.ed.destroy()
  cuadro()
  assert.deepEqual([esc.navegador.creados, esc.navegador.vivos], [1, 0])
  intacto(esc.navegador, 0)
})

/* ── T2.7 · el picking funciona en el contexto nuevo ── */

test('T2.7: re-adquirido, el hover resuelve y la pulsación toma el handle y lo arrastra en el contexto nuevo', () => {
  const esc = montar({ value: [SQUARE, HUECO] })
  esc.navegador.desalojar(esc.contexto(0))
  esc.navegador.vaciar()

  // Sin contexto no hay nada que picar: la pulsación sobre un handle es del mapa, que conserva su arrastre.
  tomar(esc, refsDe(esc.ed.paths[0])[0])
  assert.equal(esc.dragging.activo, true)
  soltarPuntero(esc)
  assert.equal(esc.changes.length, 0)
  posar(esc, refsDe(esc.ed.paths[0])[0])
  assert.deepEqual(esc.informes, [], 'y el hover no resuelve nada')

  cuadro()
  const hueco = refsDe(esc.ed.paths[1])[2]
  posar(esc, hueco, 1)
  assert.deepEqual(esc.informes.slice(-1), [HANDLE_OVER], 'el hover del segundo anillo resolvió sobre el contexto nuevo')

  const v1 = refsDe(esc.ed.paths[0])[1]
  tomar(esc, v1)
  assert.equal(esc.dragging.activo, false, 'la pulsación es del editor: el mapa le presta su arrastre')
  mover(esc, 5, 20)
  soltarPuntero(esc)
  assert.equal(esc.dragging.activo, true)
  assert.deepEqual(esc.ed.getValue()[0][1], [5, 20])
  assert.equal(esc.commits.length, 1)
  intacto(esc.navegador, 0)
  esc.ed.destroy()
})

// El pedido en vuelo murió con su contexto: no lo espera nadie y no queda marcado, así que el primer hover del
// contexto nuevo sale en el acto y el segundo lo cobra, como en régimen.
test('T2.7: el hover en vuelo cuando se pierde el contexto no resuelve, y el siguiente pica en el nuevo', () => {
  const esc  = montar()
  const ref  = refsDe(esc.ed.paths[0])[1]
  const path = esc.ed.paths[0]
  apuntar(esc, ref)
  emitir(esc, 'pointermove', path.yAt(ref) * P, path.xAt(ref) * P)     // pedido, en vuelo: el pase no se cobró
  esc.navegador.desalojar(esc.contexto(0))
  esc.navegador.vaciar()
  assert.deepEqual(esc.informes, [], 'nunca resolvió sobre el contexto viejo')

  cuadro()
  posar(esc, ref)
  assert.deepEqual(esc.informes, [HANDLE_OVER], 'resolvió sobre el contexto nuevo, a la segunda muestra')
  intacto(esc.navegador, 0)
  esc.ed.destroy()
})
