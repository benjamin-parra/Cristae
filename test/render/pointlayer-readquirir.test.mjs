// La capa de puntos sobre una superficie que pierde su contexto, o lo suelta, y lo vuelve a tomar en otro: rehace
// su parte GL desde los espejos de CPU y dibuja lo mismo, sin tocar el contexto viejo. Con el navegador falso
// (test-helpers/navegador-falso.mjs), que desaloja como Chromium y lanza si un recurso de un contexto se usa en
// otro. Los cuadros los corre el test (`cuadro()`), y los eventos del navegador llegan con `navegador.vaciar()`.
// Corre con: node --test test/render/pointlayer-readquirir.test.mjs
import '../../test-helpers/engine-stub.mjs'
import { decorarElementos, makeEditGl, makeIconSet, makeLeaflet, makeMap, makePickSpy } from '../../test-helpers/engine-stub.mjs'
import { conNavegador, crearNavegador } from '../../test-helpers/navegador-falso.mjs'
import { after, afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { PointLayer } from '../../src/render/PointLayer.js'
import { packTag } from '../../src/render/Picking.js'
import { adoptLeafletHost } from '../../src/host/LeafletHost.js'

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

// Cada contexto anota lo que le piden, con los datos copiados en el momento: lo que viajó, no el espejo vivo.
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

const FLOATS = 7                         // layout de los sprites: [x, y, tile, angle, b, a, size]
const SIZE   = 6

// Lo que cuenta como «dibujar lo mismo»: lo que se sube y lo que se dibuja.
const SUBIDAS = new Set(['bufferData', 'texImage2D', 'texSubImage2D', 'drawArrays'])
const subidas = contexto => contexto.gl.llamadas.filter(([m]) => SUBIDAS.has(m))
const llamados = (contexto, metodo) => contexto.gl.llamadas.filter(([m]) => m === metodo)

// Lo que quedó agendado corre antes de soltar el navegador: una recuperación que no corre deja a la política
// esperando un cuadro que no llega.
let soltar = null
afterEach(() => {
  for (let i = 0; agendados.size && i < 20; i++) cuadro()
  agendados.clear()
  soltar?.()
  soltar = null
})

const accessors = { idOf: it => it.id, positionOf: it => it.pos }
const items     = ['A', 'B', 'C'].map((id, i) => ({ id, pos: { lat: i, lng: i } }))

// Source manual con notify síncrono, como la de pointlayer.test.
const makeSource = lista => {
  const subs = new Set(), moves = new Set()
  return {
    accessors,
    getSnapshot  : () => lista,
    subscribe    : cb => (subs.add(cb), () => subs.delete(cb)),
    itemById     : id => lista.find(it => it.id === id),
    moveDirtyIds : () => moves,
    dirtyIds     : () => new Set(),
    mover(id, lat, lng) {
      lista.find(it => it.id === id).pos = { lat, lng }
      moves.add(id)
      subs.forEach(cb => cb())
      moves.clear()
    },
  }
}

const nuevoNavegador = (opciones = {}) => crearNavegador({ crearGl: canvas => grabar(makeEditGl(makePickSpy(), canvas)), ...opciones })

const montar = ({ navegador = nuevoNavegador(), ...opciones } = {}) => {
  soltar ??= conNavegador(navegador)
  const host   = adoptLeafletHost(makeMap(), { leaflet: makeLeaflet() })
  const source = makeSource(items.map(it => ({ ...it })))
  const layer  = new PointLayer({ host, pane: 'p', source, iconSet: makeIconSet(), ...opciones })
  return { layer, source, navegador, contexto: i => navegador.contextos[i] }
}

// Un contexto viejo intacto: ni una llamada después de perderse y ningún recurso suyo usado en otro.
const intacto = (navegador, i) => {
  assert.equal(navegador.contextos[i].llamadasTrasPerdida, 0, `ninguna llamada al contexto #${i} después de perderse`)
  assert.deepEqual(navegador.violaciones, [], 'ningún recurso de un contexto usado en otro')
}

/* ── T2.1 · adquirir → soltar → adquirir dibuja lo mismo ── */

for (const interactive of [false, true]) {
  test(`T2.1 ${interactive ? 'interactiva' : 'no interactiva'}: re-adquirida sube los mismos bytes y dibuja los mismos vértices, y el contexto viejo no se toca`, () => {
    const { layer, navegador, contexto } = montar({ interactive })
    cuadro()                                              // el primer dibujo: sube el atlas y dibuja
    const antes = subidas(contexto(0))
    assert.deepEqual(antes.map(([m]) => m), ['bufferData', 'texImage2D', 'texSubImage2D', 'drawArrays'])

    assert.equal(layer.surface.release(), true)
    assert.equal(navegador.vivos, 0, 'soltarla devuelve el cupo en el acto')
    layer.surface.acquire()
    assert.deepEqual(subidas(contexto(1)), antes, 'el mismo VBO, el mismo atlas y el mismo dibujo, en la misma tarea')

    // Lo que sigue va al contexto nuevo: un dato que llega, un repintado, el reasentado de la vista.
    layer.resetCanvasReference()
    cuadro()
    navegador.vaciar()                                    // el `webglcontextlost` que deja `loseContext`
    cuadro()
    assert.equal(layer.surface.state, 'live', 'el aviso de soltar no es una pérdida')
    assert.equal(navegador.creados, 2)
    intacto(navegador, 0)
    layer.destroy()
  })
}

// Sin contexto, cada camino que toca GL sale sin tocarlo: un dato, un foco, el reasentado, un cuadro del zoom, un
// repintado, mostrarla y un pick. Lo de CPU sigue: al volver, sube el espejo con todo eso adentro.
test('T2.1: lo que llega sin contexto queda en el espejo y sube entero al volver a tenerlo', () => {
  const { layer, source, navegador, contexto } = montar({ interactive: true })
  cuadro()
  layer.surface.release()
  source.mover('B', 5, 5)
  layer.applyFocus(new Set(['A']))
  layer.resetCanvasReference()
  layer.renderAtView(4, { lat: 0, lng: 0 })
  layer.redraw()
  layer.setVisible(false)
  layer.setVisible(true)
  assert.deepEqual(layer.resolveClick({ x: 10, y: 10 }), [])
  assert.equal(layer.requestHoverHit({ x: 10, y: 10 }), false)
  assert.equal(agendados.size, 0, 'sin contexto no se agenda ningún cuadro')

  layer.surface.acquire()
  const [[, , subido]] = llamados(contexto(1), 'bufferData')
  const [[, , previo]] = llamados(contexto(0), 'bufferData')
  assert.equal(subido.length, previo.length)
  assert.notDeepEqual(subido.slice(FLOATS, 2 * FLOATS), previo.slice(FLOATS, 2 * FLOATS), 'el punto movido')
  assert.deepEqual([0, 1, 2].map(slot => Math.sign(subido[slot * FLOATS + SIZE])), [1, -1, -1], 'y el foco')
  assert.deepEqual(llamados(contexto(1), 'drawArrays').at(-1).slice(1), [0, 0, 3])
  intacto(navegador, 0)
  layer.destroy()
})

// El tamaño de los sprites va en px del buffer, y la escala se mide sobre el canvas que se tiene: el nuevo puede
// tener la misma resolución y otra caja (la ventana pasó a otro monitor mientras no había contexto).
test('T2.1: re-adquirida, la escala se mide sobre el canvas nuevo y los tamaños se recodifican', () => {
  const caja = { ancho: 400 }                             // 800 px de buffer en 400 px CSS: escala 2
  const { layer, contexto } = montar()
  const sinCaja = decorarElementos((el, tag) => (tag === 'canvas' && Object.defineProperty(el, 'clientWidth', { get: () => caja.ancho }), el))
  try {
    layer.surface.release()
    layer.surface.acquire()                               // el primero no tenía caja: escala 1
    const tamanio = i => llamados(contexto(i), 'bufferData').at(-1)[2][SIZE]
    assert.equal(tamanio(1), 48, '24 px CSS son 48 del buffer')

    caja.ancho = 800                                      // el mismo buffer en otra caja
    layer.surface.release()
    layer.surface.acquire()
    assert.equal(tamanio(2), 24)
  } finally {
    sinCaja()
  }
  layer.destroy()
})

// Con otra escala la capa recodifica los tamaños, y no por eso pinta más tarde: el contexto nace en blanco y el
// contrato es «pintada en la misma tarea». Un solo bufferData, un solo dibujo y ningún cuadro agendado.
test('H3: re-adquirida con otra escala, pinta en la misma tarea, sube una vez y no deja un cuadro agendado', () => {
  const caja = { ancho: 400 }                             // 800 px de buffer en 400 px CSS: escala 2
  const { layer, contexto } = montar()
  cuadro()
  const sinCaja = decorarElementos((el, tag) => (tag === 'canvas' && Object.defineProperty(el, 'clientWidth', { get: () => caja.ancho }), el))
  try {
    layer.surface.release()
    layer.surface.acquire()                               // el primero no tenía caja: escala 1
    const nuevo = contexto(1)
    assert.equal(llamados(nuevo, 'bufferData').at(-1)[2][SIZE], 48, 'los tamaños con la escala nueva')
    assert.deepEqual(subidas(nuevo).map(([m]) => m), ['bufferData', 'texImage2D', 'texSubImage2D', 'drawArrays'], 'sube y dibuja en la tarea del acquire')
    assert.equal(llamados(nuevo, 'bufferData').length, 1, 'el espejo se sube una vez')
    assert.deepEqual(llamados(nuevo, 'drawArrays').at(-1).slice(1), [0, 0, 3])
    assert.equal(agendados.size, 0, 'el cuadro que agenda el rebuild se cancela: nada queda por pintar')

    cuadro()
    assert.equal(llamados(nuevo, 'drawArrays').length, 1, 'y el cuadro siguiente no repite el dibujo')
  } finally {
    sinCaja()
  }
  layer.destroy()
})

test('H3: oculta y re-adquirida con otra escala, sube recodificado y no pinta; mostrarla sí', () => {
  const caja = { ancho: 400 }
  const { layer, contexto } = montar()
  cuadro()
  layer.setVisible(false)
  const sinCaja = decorarElementos((el, tag) => (tag === 'canvas' && Object.defineProperty(el, 'clientWidth', { get: () => caja.ancho }), el))
  try {
    layer.surface.release()
    layer.surface.acquire()
    const nuevo = contexto(1)
    assert.equal(llamados(nuevo, 'bufferData').at(-1)[2][SIZE], 48)
    assert.equal(llamados(nuevo, 'drawArrays').length, 0)
    assert.equal(agendados.size, 0, 'oculta no agenda cuadros')
    assert.equal(layer.setVisible(true), true)
    assert.equal(llamados(nuevo, 'drawArrays').length, 1)
  } finally {
    sinCaja()
  }
  layer.destroy()
})

/* ── T2.2 · programas en el contexto nuevo, profundidad y atlas reaplicados ── */

for (const interactive of [false, true]) {
  test(`T2.2 ${interactive ? 'interactiva' : 'no interactiva'}: enlaza sus programas en el contexto nuevo, con la profundidad y el atlas`, () => {
    const { layer, contexto } = montar({ interactive })
    cuadro()
    layer.surface.release()
    layer.surface.acquire()
    const nuevo     = contexto(1)
    const programas = interactive ? 2 : 1
    assert.equal(llamados(nuevo, 'linkProgram').length, programas, interactive ? 'el visual y el del picking' : 'el visual')
    assert.equal(llamados(nuevo, 'depthFunc').length, 1, 'banda igual → gana el último, también en el contexto nuevo')
    const dims = llamados(nuevo, 'getUniformLocation').filter(([, , nombre]) => nombre === 'uMaxIndex')
    assert.equal(dims.length, programas, 'las dimensiones del atlas, en cada programa que lo muestrea')
    assert.equal(llamados(nuevo, 'texImage2D').length, 1, 'la textura del atlas, de nuevo')
    layer.destroy()
  })
}

/* ── T2.3 · un desalojo se re-adquiere y pinta en el cuadro siguiente ── */

test('T2.3: desalojada, se re-adquiere en el cuadro siguiente al aviso y pinta en ese mismo cuadro', () => {
  const { layer, navegador, contexto } = montar()
  cuadro()
  navegador.desalojar(contexto(0))
  assert.equal(layer.surface.state, 'lost', 'perdida en el acto')
  navegador.vaciar()
  assert.equal(navegador.creados, 1, 'no en la tarea del aviso')

  cuadro()
  assert.equal(navegador.creados, 2)
  assert.equal(layer.surface.state, 'live')
  assert.deepEqual(subidas(contexto(1)), subidas(contexto(0)))
  intacto(navegador, 0)
  layer.destroy()
})

test('T2.3: oculta, se re-adquiere y sube sin dibujar; mostrarla pinta en el acto', () => {
  const { layer, navegador, contexto } = montar({ visible: false })
  navegador.desalojar(contexto(0))
  navegador.vaciar()
  cuadro()
  assert.equal(layer.surface.state, 'live')
  assert.equal(llamados(contexto(1), 'bufferData').length, 1)
  assert.equal(llamados(contexto(1), 'drawArrays').length, 0)
  assert.equal(layer.setVisible(true), true)
  assert.equal(llamados(contexto(1), 'drawArrays').length, 1)
  layer.destroy()
})

/* ── T2.5 · nadie cancela la pérdida ── */

test('T2.5: ni el desalojo ni la liberación se cancelan con preventDefault', () => {
  const { layer, navegador, contexto } = montar()
  navegador.desalojar(contexto(0))
  navegador.vaciar()
  cuadro()
  layer.surface.release()
  navegador.vaciar()
  assert.deepEqual([contexto(0), contexto(1)].map(c => c.eventoPerdida.defaultPrevented), [false, false])
  layer.destroy()
})

/* ── T2.6 · destruirla durante la pérdida o después deja 0 vivos ── */

test('T2.6: destruida mientras espera su turno, no se re-adquiere', () => {
  const { layer, navegador, contexto } = montar()
  navegador.desalojar(contexto(0))
  navegador.vaciar()
  layer.destroy()
  cuadro()
  assert.deepEqual([navegador.creados, navegador.vivos], [1, 0])
})

test('T2.6: destruida después de re-adquirir, devuelve el contexto nuevo', () => {
  const { layer, navegador, contexto } = montar()
  navegador.desalojar(contexto(0))
  navegador.vaciar()
  cuadro()
  layer.destroy()
  assert.deepEqual([navegador.creados, navegador.vivos, navegador.liberados], [2, 0, 1])
})

/* ── T2.7 · el picking funciona en el contexto nuevo ── */

const PATCH  = 6
const CENTRO = (PATCH >> 1) * PATCH + (PATCH >> 1)

// Pinta el texel del cursor como lo escribe el fragment del pase, con los canales del slot que la capa subió.
const pintar = (spy, slot, obj) => {
  const tag = packTag(obj, 0)
  const b   = spy.array.datos[slot * FLOATS + 4], a = spy.array.datos[slot * FLOATS + 5]
  const i   = CENTRO * 4
  spy.frame[i]     = Math.round((b + tag[0]) * 255)
  spy.frame[i + 1] = Math.round(a * 255)
  spy.frame[i + 2] = Math.round(tag[1] * 255)
  spy.frame[i + 3] = Math.round(tag[2] * 255)
}

test('T2.7: re-adquirida, el click y el hover pican en el contexto nuevo', () => {
  const { layer, navegador, contexto } = montar({ interactive: true })
  layer.pickObject = 7
  cuadro()
  navegador.desalojar(contexto(0))
  navegador.vaciar()
  assert.deepEqual(layer.resolveClick({ x: 10, y: 10 }), [], 'sin contexto no hay nada que picar')
  assert.equal(layer.requestHoverHit({ x: 10, y: 10 }), false)
  cuadro()

  const spy = contexto(1).gl.spy
  pintar(spy, 2, 7)
  assert.deepEqual(layer.resolveClick({ x: 10, y: 10 }).map(p => p.id), ['C'])
  const muestra = { x: 10, y: 10 }
  assert.equal(layer.requestHoverHit(muestra), true)
  assert.equal(layer.collectHoverHit(), muestra)
  assert.deepEqual(layer.resolveHover(muestra).map(p => p.id), ['C'])
  intacto(navegador, 0)
  layer.destroy()
})

test('T2.7: un hover en vuelo cuando se pierde el contexto sale vacío, el encolado no sale, y el siguiente pica en el nuevo', () => {
  const { layer, navegador, contexto } = montar({ interactive: true })
  layer.pickObject = 7
  cuadro()
  const enVuelo = { x: 10, y: 10 }
  assert.equal(layer.requestHoverHit(enVuelo), true)
  assert.equal(layer.requestHoverHit({ x: 20, y: 20 }), true, 'otro detrás, encolado')
  navegador.desalojar(contexto(0))
  navegador.vaciar()
  assert.equal(layer.collectHoverHit(), enVuelo, 'la sesión de hover que lo espera cierra')
  assert.deepEqual(layer.resolveHover(enVuelo), [])
  assert.equal(layer.collectHoverHit(), null, 'y el encolado murió con su contexto')
  assert.equal(layer.hasPendingPick, false)

  cuadro()
  pintar(contexto(1).gl.spy, 0, 7)
  const muestra = { x: 10, y: 10 }
  assert.equal(layer.requestHoverHit(muestra), true)
  assert.equal(layer.collectHoverHit(), muestra)
  assert.deepEqual(layer.resolveHover(muestra).map(p => p.id), ['A'])
  intacto(navegador, 0)
  layer.destroy()
})

/* ── P01 · un repintado pendiente al perder el contexto no deja a la capa sin repintar ── */

// `dropGl` cancela el cuadro agendado y lo pone en 0. Si el id viejo quedara, `redraw()` creería que hay uno en pie y
// no agendaría nada: tras re-adquirir, la capa no repintaría datos, foco ni atlas hasta que la vista se moviera.
for (const [como, perder, enPie] of [
  ['soltada',    ({ layer }) => layer.surface.release(), 0],
  ['desalojada', ({ navegador, contexto }) => { navegador.desalojar(contexto(0)); navegador.vaciar() }, 1],
]) {
  test(`P01 ${como} con un repintado agendado: el cuadro se cancela y, re-adquirida, un dato nuevo se repinta en el cuadro siguiente`, () => {
    const h = montar()
    const { layer, source, contexto } = h
    cuadro()
    assert.ok(layer.redraw(), 'agendó un repintado')
    assert.equal(agendados.size, 1)

    perder(h)
    assert.equal(agendados.size, enPie, enPie ? 'dropGl cancela el repintado; sólo queda el cuadro de la recuperación' : 'dropGl cancela el repintado')
    layer.surface.state === 'released' ? layer.surface.acquire() : cuadro()           // la política la recupera en el cuadro siguiente
    assert.equal(layer.surface.state, 'live')
    assert.equal(llamados(contexto(1), 'drawArrays').length, 1, 'la re-adquisición pinta en el acto')
    assert.equal(agendados.size, 0)

    source.mover('B', 5, 5)
    assert.equal(agendados.size, 1, 'un repintado nuevo SÍ se agenda')
    cuadro()
    assert.equal(llamados(contexto(1), 'drawArrays').length, 2, 'y pinta el dato nuevo')
    layer.destroy()
  })
}

test('P01: el foco y el atlas que llegan tras re-adquirir también se repintan', () => {
  const { layer, contexto } = montar()
  cuadro()
  layer.redraw()
  layer.surface.release()
  layer.surface.acquire()
  layer.applyFocus(new Set(['A']))
  assert.equal(agendados.size, 1, 'el foco agenda su cuadro')
  cuadro()
  assert.equal(llamados(contexto(1), 'drawArrays').length, 2)
  layer.destroy()
})

// La imagen que una capa oculta conserva es la del contexto que tenía. El contexto nuevo nace en blanco, y por muy
// quieta que haya estado, mostrarla tiene que pintar.
for (const [como, perder] of [
  ['soltada',    ({ layer }) => layer.surface.release()],
  ['desalojada', ({ navegador, contexto }) => { navegador.desalojar(contexto(0)); navegador.vaciar() }],
]) {
  test(`mostrar: oculta con la imagen al día y ${como} mientras tanto, mostrarla pinta en el contexto nuevo`, () => {
    const h = montar()
    const { layer, contexto } = h
    cuadro()
    layer.setVisible(false)
    assert.equal(layer.setVisible(true), false, 'quieta, mostrarla no cuesta')
    layer.setVisible(false)

    perder(h)
    layer.surface.state === 'released' ? layer.surface.acquire() : cuadro()
    assert.equal(layer.surface.state, 'live')
    assert.equal(llamados(contexto(1), 'drawArrays').length, 0, 'oculta, no pinta al re-adquirir')

    assert.equal(layer.setVisible(true), true, 'el canvas nuevo está en blanco: pinta')
    assert.equal(llamados(contexto(1), 'drawArrays').length, 1)
    assert.equal(layer.setVisible(true), false)
    layer.destroy()
  })
}

/* ── La política: una por cuadro, y sin ciclos cuando no hay cupo ── */

test('dos desalojadas se re-adquieren de a una por cuadro', () => {
  const navegador = nuevoNavegador()
  const a = montar({ navegador })
  const b = montar({ navegador })
  navegador.desalojar(navegador.contextos[0])
  navegador.desalojar(navegador.contextos[1])
  navegador.vaciar()
  cuadro()
  assert.equal(navegador.creados, 3, 'un getContext por cuadro')
  cuadro()
  assert.equal(navegador.creados, 4)
  assert.deepEqual([a.layer.surface.state, b.layer.surface.state], ['live', 'live'])
  a.layer.destroy()
  b.layer.destroy()
})

// Techo 3: dos capas y un ajeno lo llenan, y un segundo ajeno desaloja a la más vieja. Recuperarla desaloja a la
// otra capa: no hay cupo, y la política para ahí en vez de rotar.
test('si recuperar una desaloja a otra propia, la otra se queda sin contexto', () => {
  const navegador = nuevoNavegador({ techo: 3 })
  const a = montar({ navegador })
  const b = montar({ navegador })
  navegador.ajeno()
  navegador.ajeno()
  navegador.vaciar()
  assert.equal(a.layer.surface.state, 'lost')

  cuadro()
  navegador.vaciar()
  for (let i = 0; i < 5; i++) { cuadro(); navegador.vaciar() }
  assert.deepEqual([a.layer.surface.state, b.layer.surface.state], ['live', 'lost'])
  assert.equal(navegador.creados, 5, 'una sola re-adquisición')
  a.layer.destroy()
  b.layer.destroy()
})

// Un ajeno que se rehace al perder su contexto (un widget que lo pide de nuevo) desaloja a una capa cada vez que
// una recuperación lo desaloja a él. Sin la ventana, ping-pong para siempre.
test('con un ajeno que se rehace al perder, una rotación y para', () => {
  const navegador = nuevoNavegador({ techo: 3 })
  const insistente = () => {
    const canvas = document.createElement('canvas')
    canvas.addEventListener('webglcontextlost', insistente)
    navegador.ajeno(canvas)
  }
  const a = montar({ navegador })
  const b = montar({ navegador })
  insistente()
  navegador.contextos[1].gl.flush()                       // la B se usó después del ajeno: él es más viejo
  insistente()                                            // el cuarto desaloja a la A
  navegador.vaciar()

  for (let i = 0; i < 10; i++) { cuadro(); navegador.vaciar() }
  assert.equal(a.layer.surface.state, 'live', 'la A se recuperó')
  assert.equal(b.layer.surface.state, 'lost', 'y la B, que cayó en la ventana, no')
  assert.equal(navegador.creados, 6, 'A, B, dos ajenos, la A otra vez y el ajeno rehecho: nada más')
  a.layer.destroy()
  b.layer.destroy()
})
