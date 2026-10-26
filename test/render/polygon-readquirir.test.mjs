// La capa de polígonos y la de formas sobre una superficie que pierde su contexto, o lo suelta, y lo vuelve a tomar
// en otro: el `RingStore` sube su espejo a una textura nueva, los pases enlazan sus programas en el contexto nuevo y
// la capa pinta lo mismo, sin tocar el contexto viejo. Con el navegador falso (test-helpers/navegador-falso.mjs),
// que desaloja como Chromium y lanza si un recurso de un contexto se usa en otro. Los cuadros los corre el test
// (`cuadro()`), y los eventos del navegador llegan con `navegador.vaciar()`.
// Corre con: node --test test/render/polygon-readquirir.test.mjs
import '../../test-helpers/engine-stub.mjs'
import { makeEditGl, makeLeaflet, makeMap, makePickSpy } from '../../test-helpers/engine-stub.mjs'
import { conNavegador, crearNavegador } from '../../test-helpers/navegador-falso.mjs'
import { after, afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { createSource } from '../../src/data/Source.js'
import { byDefault } from '../../src/geometry/geodesic.js'
import { adoptLeafletHost } from '../../src/host/LeafletHost.js'
import { PolygonGpuLayer } from '../../src/render/PolygonGpuLayer.js'
import { RingStore } from '../../src/render/RingStore.js'
import { ShapeLayer } from '../../src/render/ShapeLayer.js'

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

// El lado máximo de textura que declara el contexto, como uno real.
const MAX_TEXTURE_SIZE = 0x0D33
const conTope = (gl, cap) => new Proxy(gl, {
  get: (t, p) => (p === 'MAX_TEXTURE_SIZE' ? MAX_TEXTURE_SIZE
    : p === 'getParameter' ? q => (q === MAX_TEXTURE_SIZE ? cap : t.getParameter(q))
    : t[p]),
})

// Lo que cuenta como «dibujar lo mismo»: lo que se sube, el recorte, los colores, la matriz y los dibujos. Se
// comparan los números y los arreglos copiados; los recursos (ubicaciones de uniform) son de su contexto, y las
// constantes que el doble no define son una función nueva en cada lectura.
const DIBUJO = new Set(['texImage2D', 'scissor', 'uniform4f', 'uniform4fv', 'uniformMatrix4fv', 'drawArrays'])
const comparable = a => Array.isArray(a) || (typeof a !== 'object' && typeof a !== 'function')
const datos      = ([m, ...args]) => [m, ...args.filter(comparable)]
const dibujo   = contexto => contexto.gl.llamadas.filter(([m]) => DIBUJO.has(m)).map(datos)
const llamados = (contexto, metodo) => contexto.gl.llamadas.filter(([m]) => m === metodo)
const dibujos  = contexto => llamados(contexto, 'drawArrays')

// Lo que quedó agendado corre antes de soltar el navegador: una recuperación que no corre deja a la política
// esperando un cuadro que no llega.
let soltar = null
afterEach(() => {
  for (let i = 0; agendados.size && i < 20; i++) cuadro()
  agendados.clear()
  soltar?.()
  soltar = null
})

// `topes` declara el lado máximo de cada contexto, en el orden en que el navegador los crea; el último se repite.
const nuevoNavegador = ({ topes = [2048], ...opciones } = {}) => {
  let n = 0
  return crearNavegador({
    crearGl: canvas => grabar(conTope(makeEditGl(makePickSpy(), canvas), topes[Math.min(n++, topes.length - 1)])),
    ...opciones,
  })
}

// Un contexto viejo intacto: ni una llamada después de perderse y ningún recurso suyo usado en otro.
const intacto = (navegador, i) => {
  assert.equal(navegador.contextos[i].llamadasTrasPerdida, 0, `ninguna llamada al contexto #${i} después de perderse`)
  assert.deepEqual(navegador.violaciones, [], 'ningún recurso de un contexto usado en otro')
}

/* ── Geometría: las tablas CSR del lector, sin pasar por el lector ── */

// Anillo cuadrado CERRADO —el último vértice repite al primero— en [lng, lat], orden del RFC.
const square = (lng, lat, r) => [[lng - r, lat - r], [lng + r, lat - r], [lng + r, lat + r], [lng - r, lat + r], [lng - r, lat - r]]

const tables = (rings, agrupacion = rings.map(() => 1)) => {
  const xy = [], vertexAt = [0], closed = []
  rings.forEach(ring => {
    ring.forEach(([lng, lat]) => xy.push(lng, lat))
    vertexAt.push(xy.length / 2)
    const [head, tail] = [ring[0], ring.at(-1)]
    closed.push(head[0] === tail[0] && head[1] === tail[1] ? 1 : 0)
  })
  const ringAt = [0]
  agrupacion.forEach(n => ringAt.push(ringAt.at(-1) + n))
  return {
    xy        : Float64Array.from(xy),
    vertexAt  : Uint32Array.from(vertexAt),
    ringAt    : Uint32Array.from(ringAt),
    closed    : Uint8Array.from(closed),
    ringCount : rings.length,
    partCount : agrupacion.length,
  }
}

const UNO  = () => tables([square(0, 0, 0.05)])
const DOS  = () => tables([square(0, 0, 0.05), square(0.1, 0, 0.05)])

const montar = ({ navegador = nuevoNavegador(), geometry = UNO(), ...opciones } = {}) => {
  soltar ??= conNavegador(navegador)
  const host  = adoptLeafletHost(makeMap(), { leaflet: makeLeaflet() })
  const layer = new PolygonGpuLayer({ host, pane: 'p', geometry, ...opciones })
  return { layer, navegador, host, contexto: i => navegador.contextos[i] }
}

/* ── RingStore: el espejo de CPU sube a la textura del contexto que haya ── */

// Un doble de GL mínimo: lo que se sube y qué se borra, con las texturas marcadas por el contexto que las creó.
const glDoble = (max = 2048) => {
  const gl = {
    subidas: [], borradas: [], MAX_TEXTURE_SIZE: MAX_TEXTURE_SIZE, R32F: 'R32F', RG32F: 'RG32F', RG: 'RG', RED: 'RED',
    getParameter  : p => (p === MAX_TEXTURE_SIZE ? max : undefined),
    createTexture : () => ({ de: gl }),
    bindTexture   : () => {},
    texParameteri : () => {},
    deleteTexture : t => gl.borradas.push(t),
    texImage2D    : (_t, _l, formato, width, height, _b, _f, _tipo, datos) => gl.subidas.push({ formato, width, height, datos }),
  }
  return gl
}

const proyecto = (lat, lng, out) => {
  out[0] = (lng + 180) * 256 / 360
  out[1] = (90 - lat) * 256 / 360
}

test('RingStore sin contexto: nace en CPU con el mismo espejo y lo sube igual con buildGl', () => {
  const gl      = glDoble()
  const conGl   = new RingStore({ gl, project: proyecto, rings: DOS() })
  const sinGl   = new RingStore({ project: proyecto, rings: DOS() })
  const destino = glDoble()

  assert.equal(sinGl.texture, null, 'sin contexto no hay textura')
  assert.equal(sinGl.viewOf(1).texture, null)
  assert.deepEqual([sinGl.ringCount, sinGl.vertexCount, sinGl.textureWidth], [conGl.ringCount, conGl.vertexCount, conGl.textureWidth])

  assert.equal(sinGl.buildGl(destino), sinGl)
  assert.deepEqual(destino.subidas, gl.subidas, 'sube los mismos bytes y las mismas dimensiones')
  assert.equal(sinGl.texture.de, destino, 'la textura es del contexto nuevo')
  assert.deepEqual(sinGl.anchorOf(1), conGl.anchorOf(1))
  assert.deepEqual(sinGl.worldBoxOf(1, new Float64Array(4)), conGl.worldBoxOf(1, new Float64Array(4)))
})

test('RingStore: dropGl olvida las texturas sin tocar el contexto, y buildGl las rehace en otro con las mismas vistas', () => {
  const viejo = glDoble()
  const store = new RingStore({ gl: viejo, project: proyecto, rings: DOS() })
  const vista = store.viewOf(1)
  assert.ok(store.arcTexture, 'la de arcos se arma al primer pedido')
  assert.equal(viejo.subidas.length, 2)

  assert.equal(store.dropGl(), store)
  assert.deepEqual([store.texture, store.arcTexture, vista.texture, vista.arcTexture], [null, null, null, null])
  assert.equal(viejo.borradas.length, 0, 'nada se borra en un contexto que se va')

  const nuevo = glDoble()
  store.buildGl(nuevo)
  assert.equal(store.viewOf(1), vista, 'la vista de cada anillo es la misma')
  assert.equal(vista.texture, store.texture)
  assert.equal(nuevo.subidas.length, 1, 'las posiciones')
  assert.ok(vista.arcTexture, 'y los arcos, otra vez al primer pedido')
  assert.deepEqual(nuevo.subidas.map(s => s.formato), ['RG32F', 'R32F'])
  assert.deepEqual(nuevo.subidas[1].datos, viejo.subidas[1].datos, 'con los mismos largos acumulados')

  store.destroy()
  assert.deepEqual([nuevo.borradas.length, viejo.borradas.length], [2, 0], 'destroy borra lo suyo en el contexto vivo')
})

test('RingStore soltado: destroy no borra nada', () => {
  const gl    = glDoble()
  const store = new RingStore({ gl, project: proyecto, rings: DOS() })
  store.dropGl().destroy()
  assert.equal(gl.borradas.length, 0)
})

test('RingStore sin contexto se dimensiona con el tope que se le da, y lo que no cabe lanza como con contexto', () => {
  const tabla = tables([square(0, 0, 1), square(1, 1, 1)])             // 10 vértices, 8 sin los de cierre
  assert.throws(() => new RingStore({ max: 2, project: proyecto, rings: tabla }), /no entran en una textura de 2×2/)
  const holgado = new RingStore({ max: 4, project: proyecto, rings: tabla })
  assert.equal(holgado.textureWidth, 4)

  // El contexto que lo sube tiene su propio tope: uno menor que el dimensionado lanza y no deja una textura mala.
  assert.throws(() => holgado.buildGl(glDoble(2)), /no entran/)
  assert.equal(holgado.texture, null)
  holgado.buildGl(glDoble(4))
  assert.ok(holgado.texture)
})

/* ── T2.1 · adquirir → soltar → adquirir dibuja lo mismo ── */

// El tercer valor son las texturas que sube el alta: la de posiciones, y la de arcos si el contorno lleva trazos.
const VARIANTES = [
  ['relleno y contorno', {}, 1],
  ['con contorno de trazos', { styleOf: () => ({ dash: [6, 3] }), interactive: true }, 2],
  ['sólo relleno', { stroke: false }, 1],
  ['sólo contorno', { fill: false }, 1],
]

for (const [nombre, opciones, texturas] of VARIANTES)
  test(`T2.1 ${nombre}: re-adquirida sube los mismos bytes y dibuja lo mismo, y el contexto viejo no se toca`, () => {
    const { layer, navegador, contexto } = montar({ geometry: DOS(), ...opciones })
    const antes = dibujo(contexto(0))
    assert.ok(dibujos(contexto(0)).length >= 2, 'el alta dibuja: paridad de cada anillo y cobertura, o el contorno de cada uno')
    assert.equal(llamados(contexto(0), 'texImage2D').length, texturas)

    assert.equal(layer.surface.release(), true)
    assert.equal(navegador.vivos, 0, 'soltarla devuelve el cupo en el acto')
    assert.equal(layer.redraw(), false, 'sin contexto no dibuja')
    layer.surface.acquire()
    assert.deepEqual(dibujo(contexto(1)), antes, 'las mismas texturas y el mismo dibujo, en la misma tarea')

    // Lo que sigue va al contexto nuevo: el reasentado de la vista y el repintado.
    const n = dibujos(contexto(1)).length
    assert.equal(layer.resetCanvasReference(), true)
    assert.equal(dibujos(contexto(1)).length, 2 * n)
    navegador.vaciar()                                    // el `webglcontextlost` que deja `loseContext`
    assert.equal(layer.surface.state, 'live', 'el aviso de soltar no es una pérdida')
    assert.equal(navegador.creados, 2)
    intacto(navegador, 0)
    layer.destroy()
  })

// La capa tipada no interactiva no retiene sus tablas: la única copia de los anillos es el espejo del store.
test('T2.1: una capa tipada no interactiva se rehace entera desde el espejo del store, varias veces', () => {
  const { layer, navegador, contexto } = montar({ geometry: DOS() })
  assert.equal(layer.curvable, false, 'no retiene las tablas: no hay de dónde re-ingerir')
  const antes = dibujo(contexto(0))
  for (let i = 1; i <= 3; i++) {
    layer.surface.release()
    layer.surface.acquire()
    assert.deepEqual(dibujo(contexto(i)), antes, `la vuelta ${i}`)
  }
  intacto(navegador, 0)
  layer.destroy()
})


// Sin contexto, cada camino que toca GL sale sin tocarlo: la geometría que llega, el estilo, el foco, el reasentado y el
// repintado. Lo de CPU sigue: al volver, sube el store nuevo con todo eso adentro.
const ultimoCuadro = contexto => {
  const llamadas = contexto.gl.llamadas
  return llamadas.slice(llamadas.findLastIndex(([m]) => m === 'clear')).filter(([m]) => DIBUJO.has(m)).map(datos)
}

test('T2.1: lo que llega sin contexto queda en CPU y sube entero, con su estilo, al volver a tener uno', () => {
  const { layer, navegador, contexto } = montar({ interactive: true })
  const fresca = montar({ navegador, geometry: DOS(), interactive: true, fillColor: '#00ff00', fillOpacity: 0.5, styleOf: () => ({ weight: 5 }) })
  fresca.layer.applyFocus(new Set([0]), 0.2)
  layer.surface.release()

  layer.setGeometry(DOS())
  layer.style({ fillColor: '#00ff00', fillOpacity: 0.5 })
  layer.applyFocus(new Set([0]), 0.2)
  layer.setStyleOf(() => ({ weight: 5 }))
  layer.refresh()
  layer.setVisible(false)
  layer.setVisible(true)
  assert.equal(layer.resetCanvasReference(), false)
  assert.equal(layer.redraw(), false)
  assert.equal(layer.ringCount, 2, 'la geometría nueva entró al store')
  assert.equal(agendados.size, 0, 'sin contexto no se agenda ningún cuadro')

  layer.surface.acquire()

  // La misma capa hecha de cero con todo eso (el contexto #1) dibuja lo mismo que la que lo rehízo (el #2).
  assert.deepEqual(llamados(contexto(2), 'texImage2D').map(datos), llamados(contexto(1), 'texImage2D').map(datos), 'las posiciones nuevas')
  assert.deepEqual(ultimoCuadro(contexto(2)), ultimoCuadro(contexto(1)), 'el dibujo, con el estilo y el foco')
  assert.ok(ultimoCuadro(contexto(2)).length > 0)
  intacto(navegador, 0)
  layer.destroy()
  fresca.layer.destroy()
})

test('T2.1: una Source que emite sin contexto se arma en CPU y se sube al volver', () => {
  const subs = new Set()
  let lista = [{ id: 'A', rings: [[[0, 0], [0, 0.1], [0.1, 0.1], [0, 0]]] }]
  const source = {
    accessors   : { idOf: it => it.id, ringsOf: it => it.rings },
    getSnapshot : () => lista,
    subscribe   : cb => (subs.add(cb), () => subs.delete(cb)),
  }
  const { layer, navegador, contexto } = montar({ geometry: null, source, interactive: true })
  layer.surface.release()
  lista = [...lista, { id: 'B', rings: [[[1, 1], [1, 1.1], [1.1, 1.1], [1, 1]]] }]
  subs.forEach(cb => cb())
  assert.equal(layer.ringCount, 2, 'el store nuevo se armó sin contexto')
  assert.deepEqual(layer.resolveClick({ lat: 1.05, lng: 1.08 }).map(h => h.id), ['B'], 'y el picking ya lo ve')

  layer.surface.acquire()
  assert.equal(llamados(contexto(1), 'texImage2D')[0][4], 8, 'dos anillos de tres vértices en una textura de 8 de ancho')
  assert.ok(dibujos(contexto(1)).length > 0)
  intacto(navegador, 0)
  layer.destroy()
})

test('setGeometry con contexto borra la textura del store anterior; sin contexto no hay nada que borrar', () => {
  const { layer, navegador, contexto } = montar()
  layer.setGeometry(DOS())
  assert.equal(llamados(contexto(0), 'deleteTexture').length, 1, 'la del store que se reemplaza')

  layer.surface.release()
  layer.setGeometry(UNO())
  assert.equal(llamados(contexto(0), 'deleteTexture').length, 1, 'el store sin textura no borra en el contexto que se fue')
  layer.surface.acquire()
  layer.setGeometry(DOS())
  assert.equal(llamados(contexto(1), 'deleteTexture').length, 1)
  intacto(navegador, 0)
  layer.destroy()
})

/* ── T2.2 · programas en el contexto nuevo, con su estado fijo ── */

for (const [nombre, opciones, programas] of [
  ['relleno y contorno', {}, 4],
  ['sólo relleno', { stroke: false }, 3],
  ['sólo contorno', { fill: false }, 1],
])
  test(`T2.2 ${nombre}: enlaza sus programas en el contexto nuevo, con el sampler de posiciones`, () => {
    const { layer, contexto } = montar(opciones)
    layer.surface.release()
    layer.surface.acquire()
    const nuevo = contexto(1)
    assert.equal(llamados(nuevo, 'linkProgram').length, programas, 'paridad, vivas y cobertura del relleno; el contorno')
    assert.equal(llamados(nuevo, 'getUniformLocation').filter(([, , n]) => n === 'uPos').length, opciones.fill === false ? 0 : 2,
      'la unidad de posiciones, en cada programa que muestrea')
    assert.equal(llamados(nuevo, 'createVertexArray').length, opciones.fill === false || opciones.stroke === false ? 1 : 2, 'el VAO de cada pase')
    assert.equal(llamados(nuevo, 'texImage2D').length, 1, 'la textura de posiciones, de nuevo')
    layer.destroy()
  })

/* ── T2.3 · un desalojo se re-adquiere y pinta en el cuadro siguiente ── */

test('T2.3: desalojada, se re-adquiere en el cuadro siguiente al aviso y pinta en ese mismo cuadro', () => {
  const { layer, navegador, contexto } = montar({ geometry: DOS() })
  navegador.desalojar(contexto(0))
  assert.equal(layer.surface.state, 'lost', 'perdida en el acto')
  navegador.vaciar()
  assert.equal(navegador.creados, 1, 'no en la tarea del aviso')
  assert.equal(layer.redraw(), false, 'y entre tanto no dibuja')

  cuadro()
  assert.equal(navegador.creados, 2)
  assert.equal(layer.surface.state, 'live')
  assert.deepEqual(dibujo(contexto(1)), dibujo(contexto(0)))
  intacto(navegador, 0)
  layer.destroy()
})

test('T2.3: oculta, se re-adquiere y sube sin dibujar; mostrarla pinta en el acto', () => {
  const { layer, navegador, contexto } = montar({ geometry: DOS() })
  layer.setVisible(false)
  navegador.desalojar(contexto(0))
  navegador.vaciar()
  cuadro()
  assert.equal(layer.surface.state, 'live')
  assert.equal(llamados(contexto(1), 'texImage2D').length, 1)
  assert.equal(dibujos(contexto(1)).length, 0)
  assert.equal(layer.canvas.style.display, 'none', 'el canvas nuevo hereda que está oculta')

  assert.equal(layer.setVisible(true), true)
  assert.deepEqual(dibujo(contexto(1)).filter(([m]) => m === 'drawArrays'), dibujo(contexto(0)).filter(([m]) => m === 'drawArrays'))
  assert.equal(layer.canvas.style.display, '')
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

test('T2.6: destruida después de re-adquirir, devuelve el contexto nuevo sin borrar nada uno por uno', () => {
  const { layer, navegador, contexto } = montar()
  navegador.desalojar(contexto(0))
  navegador.vaciar()
  cuadro()
  layer.destroy()
  assert.deepEqual([navegador.creados, navegador.vivos, navegador.liberados], [2, 0, 1])
  assert.equal(llamados(contexto(1), 'deleteTexture').length, 0, 'loseContext libera todo de una vez')
  intacto(navegador, 0)
})

test('T2.6: destruida soltada, no toca el contexto que ya no tiene', () => {
  const { layer, navegador } = montar()
  layer.surface.release()
  layer.destroy()
  assert.deepEqual([navegador.creados, navegador.vivos, navegador.liberados], [1, 0, 1])
  intacto(navegador, 0)
})

/* ── T2.7 · el picking es de CPU: contesta lo mismo con y sin contexto ── */

test('T2.7: el picking contesta lo mismo con el contexto, sin él y con el nuevo, y sigue la geometría que llegó entre medio', () => {
  const { layer, navegador } = montar({ geometry: DOS(), interactive: true })
  const dentro = { lat: 0, lng: 0.1 }
  const hits   = () => layer.resolveClick(dentro).map(({ id, ref }) => [id, ref])
  assert.deepEqual(hits(), [[1, 1]])

  layer.surface.release()
  assert.deepEqual(hits(), [[1, 1]], 'sin contexto no hay GPU que picar, y no hace falta')
  layer.setGeometry(UNO())
  assert.deepEqual(hits(), [], 'la geometría que llegó sin contexto ya es la que pica')
  layer.setGeometry(DOS())

  layer.surface.acquire()
  assert.deepEqual(hits(), [[1, 1]])
  assert.deepEqual(layer.resolveHover(dentro).map(h => h.id), [1])
  intacto(navegador, 0)
  layer.destroy()
})

/* ── El tope de textura sobrevive al contexto ── */

test('el tope de textura es el último medido: vale sin contexto y se mide de nuevo en el contexto nuevo', () => {
  const navegador = nuevoNavegador({ topes: [16, 8] })
  const { layer } = montar({ navegador })
  assert.equal(layer.maxVertices, 256)
  layer.surface.release()
  assert.equal(layer.maxVertices, 256, 'sin contexto rige el último')
  assert.throws(() => layer.setGeometry(tables(Array.from({ length: 80 }, (_, k) => square(k, 5, 0.1)))), /no entran en una textura de 16×16/)
  layer.surface.acquire()
  assert.equal(layer.maxVertices, 64, 'el contexto nuevo declara otro')
  layer.destroy()
})

test('un contexto nuevo con un tope menor que el de la geometría lanza al tomarlo, y la política lo suelta', () => {
  const navegador = nuevoNavegador({ topes: [16, 2] })
  const { layer } = montar({ navegador, geometry: DOS() })
  layer.surface.release()
  assert.throws(() => layer.surface.acquire(), /no entran en una textura de 2×2/)
  assert.equal(layer.surface.release(), true, 'queda tomada sin dibujar: la política la suelta')
  assert.equal(navegador.vivos, 0)
  layer.destroy()
})

/* ── Capa de formas: hereda la superficie re-adquirible de la capa de polígonos ── */

const flush = () => new Promise(r => globalThis.setTimeout(r, 0))

const accessorsFormas = {
  idOf       : d => d.id,
  positionOf : d => ({ lat: d.center[0], lng: d.center[1] }),
  radiusOf   : d => d.radius,
}

const montarFormas = async (items, { navegador = nuevoNavegador(), zoom = 12, ...opciones } = {}) => {
  soltar ??= conNavegador(navegador)
  const source = createSource(accessorsFormas)
  source.set(items)
  await flush()
  const map   = makeMap({ zoom })
  const layer = new ShapeLayer({ host: adoptLeafletHost(map, { leaflet: makeLeaflet() }), pane: 'p', source, model: byDefault, interactive: true, ...opciones })
  return { layer, source, map, navegador, contexto: i => navegador.contextos[i] }
}

const UNA = { id: 1, center: [0, 0], radius: 500 }
const OTRA = { id: 2, center: [0.02, 0.02], radius: 300 }
const picar = (layer, [lat, lng]) => layer.resolveClick({ lat, lng }).map(h => h.id)
const posiciones = contexto => llamados(contexto, 'texImage2D').map(datos).at(-1)

test('ShapeLayer T2.1: soltada y vuelta a tomar dibuja las mismas formas y pica lo mismo', async () => {
  const { layer, navegador, contexto } = await montarFormas([UNA, OTRA])
  const antes = ultimoCuadro(contexto(0))
  assert.deepEqual(picar(layer, [0, 0]), [1])
  assert.ok(antes.some(([m]) => m === 'drawArrays'), 'las formas están a la vista')

  assert.equal(layer.surface.release(), true)
  assert.deepEqual(picar(layer, [0, 0]), [1], 'el picking es de CPU')
  assert.equal(layer.hasContent, true)
  layer.surface.acquire()
  assert.deepEqual(ultimoCuadro(contexto(1)), antes)
  assert.deepEqual(posiciones(contexto(1)), posiciones(contexto(0)))
  assert.deepEqual(picar(layer, [0, 0]), [1])
  intacto(navegador, 0)
  layer.destroy()
})

test('ShapeLayer T2.1: lo que cambia en la Source sin contexto se arma en CPU y se sube al volver', async () => {
  const navegador = nuevoNavegador({ techo: 16 })
  const { layer, source, contexto } = await montarFormas([UNA], { navegador })
  const fresca = await montarFormas([UNA, OTRA], { navegador })
  layer.surface.release()
  const dibujosAntes = dibujos(contexto(0)).length

  source.set([UNA, OTRA])
  await flush()
  assert.deepEqual(picar(layer, [0.02, 0.02]), [2], 'la forma nueva ya pica')
  assert.ok(layer.bounds.north > 0.02, 'y encuadra')
  assert.equal(dibujos(contexto(0)).length, dibujosAntes, 'el contexto viejo no recibió nada')

  layer.surface.acquire()
  assert.deepEqual(posiciones(contexto(2)), posiciones(fresca.contexto(1)), 'sube lo mismo que una capa nueva')
  assert.deepEqual(ultimoCuadro(contexto(2)), ultimoCuadro(fresca.contexto(1)))
  intacto(navegador, 0)
  layer.destroy()
  fresca.layer.destroy()
})

test('ShapeLayer T2.3: desalojada, un zoom que pide otros segmentos se arma en CPU y se pinta en el cuadro del recupero', async () => {
  const navegador = nuevoNavegador({ techo: 16 })
  const { layer, map, contexto } = await montarFormas([UNA], { navegador })
  const fresca = await montarFormas([UNA], { navegador, zoom: 18 })
  navegador.desalojar(contexto(0))
  navegador.vaciar()

  map.setZoomForTest(18).fire('zoomend')
  cuadro()
  assert.equal(layer.surface.state, 'live')
  assert.deepEqual(posiciones(contexto(2)), posiciones(fresca.contexto(1)), 'los 256 segmentos que pide el zoom nuevo')
  assert.deepEqual(ultimoCuadro(contexto(2)).filter(([m]) => m === 'drawArrays').length > 0, true)
  intacto(navegador, 0)
  layer.destroy()
  fresca.layer.destroy()
})

test('ShapeLayer T2.6: destruida soltada o con la recuperación pendiente deja 0 contextos vivos', async () => {
  const navegador = nuevoNavegador({ techo: 16 })
  const a = await montarFormas([UNA], { navegador })
  const b = await montarFormas([UNA], { navegador })
  a.layer.surface.release()
  a.layer.destroy()
  assert.deepEqual([navegador.vivos, navegador.liberados], [1, 1])

  navegador.desalojar(b.contexto(1))
  navegador.vaciar()
  b.layer.destroy()
  cuadro()
  assert.deepEqual([navegador.creados, navegador.vivos], [2, 0])
})
