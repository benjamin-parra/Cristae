// La política de contextos (src/render/gl-budget.js) sobre superficies REALES (`EditSurface`) y un navegador falso que
// desaloja por último flush (test-helpers/navegador-falso.mjs), sin capas: cada superficie tiene una dueña de mentira que
// dice si tiene contenido, y un pane propio con su z y su visibilidad. Lo que se fija es lo que decide la política:
//
//   alta      una vacía abierta con `open` deja su marcador y se toma en un momento ocioso, de a una y por z; con contenido
//             antes, en esa tarea, aun en pleno gesto
//   reposo    nada se suelta por tiempo ni sin presión: oculta o vacía, conserva su contexto
//   presión   perder una necesaria suelta en el acto las prescindibles; una prescindible perdida queda soltada y vuelve
//             al verse o al recibir contenido
//   recuperar de a una por cuadro, la de mayor z primero, nunca en pleno gesto (y sin agendar cuadros mientras espera)
//   saturar   sin prescindibles, si tomar una propia hace perder otra —en el acto (H1) o por un ajeno que se rehace—, la de
//             menor z queda sin superficie, con su señal y un aviso, y no se insiste; vuelve ante una señal de cupo y en
//             dos reintentos espaciados
//   masiva    un reinicio de la GPU devuelve todas las necesarias de a una por cuadro, también en medio de una tanda
//   orden     tras cada adquisición de la política las necesarias renuevan su flush por z ascendente: cae primero la
//             prescindible y, entre las necesarias, la de menor z
//
// Y los hallazgos de la revisión de la etapa 2 que tocan a la política: H1 (sin relojes), H2 (quien quita la capa al oír la
// pérdida), H6 (tomada por fuera). Los cuadros, los ratos ociosos y los eventos del navegador los corre el test.
// Corre con: node --test test/render/gl-budget.test.mjs
import { afterEach, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { crearNavegador } from '../../test-helpers/navegador-falso.mjs'
import { EditSurface } from '../../src/render/EditSurface.js'
import { glBudget } from '../../src/render/gl-budget.js'

/* ── Harness: canvas con eventos, un gl mínimo, panes con z y visibilidad ── */

const MAX_TEXTURE_SIZE = 0x0D33
let navegador = null
let fallar    = 0                   // los próximos `fallar` canvas no consiguen WebGL2
let medidas   = 0                   // cuántas veces se leyó MAX_TEXTURE_SIZE

class Lienzo extends EventTarget {
  style      = {}
  width      = 0
  height     = 0
  className  = ''
  parentNode = null
  #sinGl     = fallar > 0 && fallar-- > 0
  getContext(kind, attrs) { return this.#sinGl ? null : navegador.getContext(this, kind, attrs) }
  replaceWith(nuevo) {
    const hijos = this.parentNode.hijos
    hijos[hijos.indexOf(this)] = nuevo
    nuevo.parentNode = this.parentNode
    this.parentNode  = null
  }
  remove() {
    this.parentNode?.hijos.splice(this.parentNode.hijos.indexOf(this), 1)
    this.parentNode = null
  }
}

globalThis.document = Object.assign(new EventTarget(), { createElement: () => new Lienzo(), visibilityState: 'visible' })

const glFalso = () => ({
  MAX_TEXTURE_SIZE,
  getContextAttributes : () => ({ stencil: true }),
  getExtension         : () => null,
  getParameter         : p => (p === MAX_TEXTURE_SIZE && medidas++, p === MAX_TEXTURE_SIZE ? 8192 : null),
  viewport() {}, flush() {}, finish() {},
})

const host = (() => {
  const panes = new Map()
  const pane  = name => panes.get(name) ?? panes.set(name, {
    nodeType: 1, className: `leaflet-${name}-pane`, style: {}, hijos: [],
    appendChild(hijo) { this.hijos.push(hijo); hijo.parentNode = this; return hijo },
  }).get(name)
  return {
    pane,
    camera  : { size: () => ({ x: 800, y: 600 }), frameOrigin: () => ({ x: 0, y: 0 }), zoom: () => 3, center: () => ({ lat: 0, lng: 0 }), on: () => () => {} },
    surface : { mount: pane, unmount() {}, zOf: name => (z => z ? +z : null)(panes.get(name)?.style.zIndex), followZoom() {} },
  }
})()

/* ── Cuadros y ratos ociosos a mano ── */

const agendados = new Map()
const ociosos   = []
let   serie     = 0
globalThis.requestAnimationFrame = cb => (agendados.set(++serie, cb), serie)
globalThis.cancelAnimationFrame  = id => agendados.delete(id)
globalThis.requestIdleCallback   = cb => (ociosos.push(cb), ociosos.length)

const cuadro = () => {
  const ahora = [...agendados.values()]
  agendados.clear()
  ahora.forEach(cb => cb(0))
}
const ocio = () => ociosos.splice(0).forEach(cb => cb({ didTimeout: false, timeRemaining: () => 50 }))
// Los avisos del navegador y lo que la política hace con ellos en el cuadro siguiente.
const asentar = (n = 1) => {
  for (let i = 0; i < n; i++) {
    navegador.vaciar()
    cuadro()
  }
}

/* ── Superficies ── */

const GESTO  = { nombre: 'un motor en pleno gesto' }
const vivas  = []
let   panes  = 0
const nuevoNavegador = (opciones = {}) => navegador = crearNavegador({ crearGl: glFalso, ...opciones })

// `contenido` es lo que dice su dueña; `perezosa` abre con `open` (avisa con `need`), si no con `acquire`.
const superficie = (nombre, { z = 0, contenido = true, perezosa = true, oculta = false, engaged = false } = {}) => {
  const pane  = `p${++panes}`
  const nodo  = host.pane(pane)
  nodo.style.zIndex     = String(z)
  nodo.style.visibility = oculta ? 'hidden' : ''
  const owner  = { hasContent: contenido, engaged, construidas: 0, buildGl() { this.construidas++ }, dropGl() {} }
  const s      = new EditSurface({ host, pane, owner })
  const avisos = []
  Object.assign(s, { nombre, owner, nodo, avisos })
  vivas.push(s)
  perezosa ? s.open(contenido) : s.acquire()
  s.onState = sup => avisos.push(sup.state)           // como el motor: la oye después del alta
  return s
}

const contextoDe = s => navegador.contextos.find(c => c.gl === s.gl)
const desalojar  = (...ss) => ss.forEach(s => navegador.desalojar(contextoDe(s)))
const estados    = (...ss) => ss.map(s => s.state)
const mostrar    = s => {
  s.nodo.style.visibility = ''
  return s.need()
}

// Ajenos de a uno hasta que cae una propia: el nombre de la primera en caer, entre `ss`.
const primeraVictima = (techo, ...ss) => {
  const ids = new Map(ss.map(s => [contextoDe(s).id, s.nombre]))
  for (let i = 0; navegador.victimas.length === 0 && i < techo; i++) navegador.ajeno()
  return ids.get(navegador.victimas[0])
}

// Un ajeno que se rehace cada vez que pierde su contexto: un widget que lo pide de nuevo.
const insistente = () => {
  const canvas = new Lienzo()
  canvas.addEventListener('webglcontextlost', insistente)
  return navegador.ajeno(canvas)
}

afterEach(() => {
  vivas.splice(0).forEach(s => s.destroy())
  glBudget.motion(GESTO, false)
  for (let i = 0; (agendados.size || ociosos.length) && i < 20; i++) {
    navegador?.vaciar()
    cuadro()
    ocio()
  }
  assert.equal(agendados.size + ociosos.length, 0, 'la política no quedó con nada agendado')
  fallar = 0
})

/* ── Alta ── */

test('mientras el realm no logró ningún contexto, una vacía lo toma al construirse: sin WebGL2, el alta lanza', () => {
  nuevoNavegador()
  fallar = 1
  assert.throws(() => superficie('sin WebGL2', { contenido: false }), /sin WebGL2/)
  vivas.pop().destroy()
  assert.equal(glBudget.capable, false)
  const primera = superficie('primera', { contenido: false })
  assert.equal(primera.state, 'live', 'todavía no se sabe si hay WebGL2: no se difiere')
  assert.equal(glBudget.capable, true)
})

test('una vacía abierta no toma contexto: deja su marcador en el pane y la toma un rato ocioso, de a una y la de mayor z primero', () => {
  nuevoNavegador()
  const c = superficie('c', { z: 20 })
  const a = superficie('a', { z: 10, contenido: false })
  const b = superficie('b', { z: 30, contenido: false })
  assert.equal(navegador.creados, 1, 'sólo la que tiene contenido toma el suyo al construirse')
  assert.deepEqual(estados(a, b, c), ['none', 'none', 'live'])
  assert.equal(a.canvas.parentNode, a.nodo, 'el marcador guarda su lugar en el pane')
  assert.equal(a.gl, null)
  const marcador = b.canvas

  ocio()
  assert.deepEqual(estados(a, b), ['none', 'live'], 'el primer rato ocioso toma la de mayor z')
  assert.equal(b.canvas, marcador, 'en el marcador mismo: ni un nodo más')
  ocio()
  assert.deepEqual(estados(a, b), ['live', 'live'])
  ocio()
  assert.equal(navegador.creados, 3)
  assert.deepEqual([a.avisos, b.avisos], [['live'], ['live']], 'tomarlo después del alta avisa')
})

test('con contenido antes del rato ocioso, la toma en esa tarea, aun en pleno gesto', () => {
  nuevoNavegador()
  const a = superficie('a', { contenido: false })
  glBudget.motion(GESTO, true)
  a.owner.hasContent = true
  assert.equal(a.need(), true)
  assert.equal(a.state, 'live')
  assert.equal(a.owner.construidas, 1, 'la dueña construye y sube lo que ya tiene')
  ocio()
  assert.equal(navegador.creados, 1, 'el rato ocioso no la toma otra vez')
})

test('el lado máximo de textura se mide una vez en el realm, con el primer contexto', () => {
  nuevoNavegador()
  superficie('a')
  superficie('b')
  assert.equal(glBudget.maxTexture, 8192)
  assert.equal(medidas, 1, 'ni una lectura por superficie')
})

/* ── Reposo ── */

test('oculta, o vacía con su contexto, lo conserva: nada se suelta por tiempo ni sin presión', () => {
  nuevoNavegador()
  const oculta = superficie('oculta', { oculta: true })
  const vacia  = superficie('vacía', { contenido: false })
  ocio()
  for (let i = 0; i < 10; i++) {
    asentar()
    ocio()
  }
  assert.deepEqual(estados(oculta, vacia), ['live', 'live'])
  assert.equal(navegador.liberados, 0)
})

/* ── Presión ── */

test('perder una necesaria suelta en el acto las prescindibles —vacía, oculta, la vacía que esperaba— y vuelve sin desalojar a nadie', () => {
  nuevoNavegador()
  const n       = superficie('necesaria', { z: 10 })
  const oculta  = superficie('oculta', { z: 20, oculta: true })
  const vacia   = superficie('vacía', { z: 30, contenido: false })
  ocio()
  const espera  = superficie('vacía que espera', { z: 40, contenido: false })
  const editor  = superficie('editor trazando', { z: 5, oculta: true, perezosa: false, engaged: true })
  const directa = superficie('vacía sin aviso', { z: 6, contenido: false, perezosa: false })

  desalojar(n)
  navegador.vaciar()
  assert.deepEqual(estados(n, oculta, vacia, espera), ['lost', 'released', 'released', 'released'])
  assert.deepEqual(estados(editor, directa), ['live', 'live'],
    'un editor trazando no se suelta aunque no se vea, ni una vacía que no avisa cuando recibe contenido')
  assert.equal(navegador.liberados, 2, 'las dos vivas devolvieron su cupo; la que esperaba no tenía')
  const creados = navegador.creados

  cuadro()
  assert.equal(n.state, 'live')
  assert.equal(navegador.creados, creados + 1)
  assert.equal(navegador.desalojados, 1, 'volver no desalojó a nadie')
  ocio()
  assert.equal(espera.state, 'released', 'la que esperaba un rato ocioso ya no se toma')
})

test('una prescindible perdida queda soltada, no se recupera, y vuelve al verse o al recibir contenido', () => {
  nuevoNavegador()
  const oculta = superficie('oculta', { oculta: true })
  const vacia  = superficie('vacía', { contenido: false })
  ocio()
  desalojar(oculta, vacia)
  asentar(3)
  assert.deepEqual(estados(oculta, vacia), ['released', 'released'])
  assert.deepEqual([oculta.avisos, vacia.avisos], [['released'], ['live', 'released']], 'una sola señal: la que queda')
  const creados = navegador.creados

  assert.equal(mostrar(oculta), true, 'al verse la toma en esa tarea')
  vacia.owner.hasContent = true
  assert.equal(vacia.need(), false, 'al recibir contenido en la misma tarea, espera el cuadro: una toma por tarea')
  assert.equal(navegador.creados, creados + 1)
  cuadro()
  assert.deepEqual(estados(oculta, vacia), ['live', 'live'])
  assert.equal(navegador.creados, creados + 2)
})

/* ── Recuperar ── */

test('las necesarias perdidas vuelven de a una por cuadro, la de mayor z primero, y nunca en pleno gesto', () => {
  nuevoNavegador()
  const a = superficie('a', { z: 10 })
  const b = superficie('b', { z: 30 })
  const c = superficie('c', { z: 20 })
  desalojar(a)
  glBudget.motion(GESTO, true)
  desalojar(b, c)
  navegador.vaciar()
  const creados = navegador.creados
  cuadro()
  assert.equal(navegador.creados, creados, 'en pleno gesto no toma nada')
  assert.equal(agendados.size, 0, 'ni agenda cuadros mientras espera')

  glBudget.motion(GESTO, false)
  cuadro()
  assert.deepEqual(estados(a, b, c), ['lost', 'live', 'lost'])
  cuadro()
  assert.deepEqual(estados(a, b, c), ['lost', 'live', 'live'])
  cuadro()
  assert.deepEqual(estados(a, b, c), ['live', 'live', 'live'])
  assert.equal(navegador.creados, creados + 3)
})

test('volver a tomar una soltada espera a que termine el gesto; el fin del gesto la toma en un cuadro', () => {
  nuevoNavegador()
  const oculta = superficie('oculta', { oculta: true })
  oculta.release()
  glBudget.motion(GESTO, true)
  assert.equal(mostrar(oculta), false)
  cuadro()
  assert.equal(oculta.state, 'released')
  glBudget.motion(GESTO, false)
  cuadro()
  assert.equal(oculta.state, 'live')
})

test('un gesto que nunca avisa su fin deja de contar a los diez segundos', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const reloj = performance.now
  let ahora = reloj.call(performance)
  performance.now = () => ahora
  try {
    nuevoNavegador()
    const a = superficie('a')
    glBudget.motion(GESTO, true)
    desalojar(a)
    asentar()
    assert.equal(a.state, 'lost')
    ahora += 10_001
    mock.timers.tick(10_000)
    cuadro()
    assert.equal(a.state, 'live')
  } finally {
    performance.now = reloj
    mock.timers.reset()
  }
})

/* ── Saturar ── */

test('H1: si tomar una propia desaloja a otra y no hay prescindibles, la de menor z queda sin superficie, con su señal y un aviso', () => {
  const warn = mock.method(console, 'warn', () => {})
  try {
    nuevoNavegador({ techo: 2 })
    const a = superficie('a', { z: 10 })
    const b = superficie('b', { z: 20 })
    const c = superficie('c', { z: 30 })                // el tercero desaloja a la de flush más viejo: a
    asentar()                                           // a vuelve, y al volver desaloja a b en el acto
    assert.deepEqual(navegador.victimas, [0, 1])
    asentar()                                           // b tiene más z que a: a cede su lugar, y b vuelve a él
    asentar(10)
    assert.deepEqual(estados(a, b, c), ['released', 'live', 'live'])
    assert.equal(navegador.creados, 5, 'una rotación: a y b otra vez, y nada más')
    assert.equal(navegador.desalojados, 2, 'b vuelve al cupo que soltó a: no desaloja a nadie')
    assert.deepEqual(a.avisos, ['lost', 'live', 'released'])
    assert.equal(warn.mock.callCount(), 1)
    assert.match(warn.mock.calls[0].arguments[0], /techo de contextos WebGL/)

    // Otra: d desaloja a b, que volvió en esta tanda; d tiene menos z y le devuelve el lugar. La señal sale, el aviso no.
    const d = superficie('d', { z: 5 })
    asentar(5)
    assert.deepEqual(estados(a, b, c, d), ['released', 'live', 'live', 'released'])
    assert.deepEqual(d.avisos, ['released'])
    assert.equal(warn.mock.callCount(), 1)
  } finally {
    warn.mock.restore()
  }
})

test('H1 sin relojes: con un getContext lento y tareas largas antes del aviso, no rota', () => {
  const reloj = performance.now
  let desfase = 0
  performance.now = () => reloj.call(performance) + desfase
  try {
    nuevoNavegador({ techo: 2, crearGl: () => (desfase += 1100, glFalso()) })
    superficie('a')
    superficie('b')
    superficie('c')
    const creados = navegador.creados
    for (let i = 0; i < 30; i++) {
      cuadro()
      desfase += 1100
      navegador.vaciar()
    }
    assert.ok(navegador.creados - creados <= 2, `re-adquirió ${navegador.creados - creados} veces en 30 cuadros`)
  } finally {
    performance.now = reloj
  }
})

test('un ajeno que se rehace al perder, con un rato ocioso entre la vuelta y la nueva pérdida: la misma rotación', () => {
  nuevoNavegador({ techo: 3 })
  const a = superficie('a', { z: 10 })
  const b = superficie('b', { z: 20 })
  insistente()
  contextoDe(b).gl.flush()
  insistente()                                          // el cuarto desaloja a a
  asentar()                                             // a vuelve y desaloja al primer ajeno
  ocio()                                                // la tanda no termina en un rato ocioso: sólo con una señal de cupo
  asentar(10)
  assert.deepEqual(estados(a, b), ['released', 'live'])
  assert.equal(navegador.creados, 7, 'ni a ni b se toman otra vez')
})

test('la primera vez que una capa toma su contexto no es una vuelta: perderlo sin falta de cupo se recupera', () => {
  nuevoNavegador()
  const n = superficie('n', { z: 20 })
  const e = superficie('vacía', { z: 10, contenido: false })
  ocio()
  e.owner.hasContent = true
  e.need()
  ocio()
  desalojar(e)
  asentar()
  assert.deepEqual(estados(n, e), ['live', 'live'])
})

test('a igual z no se cambia una por otra: la desalojada por la recuperación espera cupo', () => {
  nuevoNavegador({ techo: 2 })
  const [a, b, c] = ['a', 'b', 'c'].map(n => superficie(n))
  asentar(10)
  assert.deepEqual(estados(a, b, c), ['live', 'released', 'live'])
  assert.equal(navegador.creados, 4, 'un solo getContext de más')
})

test('H1c: con dos en cola y un cuadro antes del aviso, una sola recuperación', () => {
  nuevoNavegador({ techo: 3 })
  const capas = ['a', 'b', 'c', 'd', 'e'].map(n => superficie(n))
  navegador.vaciar()
  assert.deepEqual(estados(...capas), ['lost', 'lost', 'live', 'live', 'live'])
  const creados = navegador.creados
  cuadro()
  cuadro()
  asentar(5)
  assert.equal(navegador.creados - creados, 1)
  assert.equal(capas.filter(s => s.state === 'live').length, 3)
})

test('un ajeno que se rehace al perder: una rotación, y queda sin superficie la de menor z, sin bucle', () => {
  nuevoNavegador({ techo: 3 })
  const a = superficie('a', { z: 10 })
  const b = superficie('b', { z: 20 })
  insistente()
  contextoDe(b).gl.flush()                              // b se usó después del ajeno: él es más viejo
  insistente()                                          // el cuarto desaloja a a
  asentar()                                             // a vuelve y desaloja al primer ajeno, que se rehace y desaloja al otro…
  asentar(10)                                           // …que se rehace y desaloja a a, que ya volvió una vez
  assert.deepEqual(estados(a, b), ['released', 'live'])
  assert.equal(navegador.creados, 7, 'a, b, dos ajenos, a otra vez y los dos ajenos rehechos')
  assert.deepEqual(a.avisos, ['lost', 'live', 'released'])
})

test('en saturación, una que se vuelve a ver entra sólo en el lugar de una de menor z, sin desalojar a nadie', () => {
  nuevoNavegador({ techo: 2 })
  const baja = superficie('baja', { z: 5, oculta: true })
  const alta = superficie('alta', { z: 50, oculta: true })
  ;[baja, alta].forEach(s => s.release())
  const a = superficie('a', { z: 10 })
  const b = superficie('b', { z: 20 })
  const c = superficie('c', { z: 30 })
  asentar(10)
  assert.deepEqual(estados(a, b, c), ['released', 'live', 'live'], 'saturada')
  const { creados, desalojados } = navegador

  assert.equal(mostrar(baja), false, 'menos z que todas las vivas: espera cupo')
  assert.equal(baja.state, 'released')
  assert.equal(mostrar(alta), true, 'más z que b: b le cede su lugar')
  assert.deepEqual(estados(a, b, c, alta), ['released', 'released', 'live', 'live'])
  assert.deepEqual([navegador.creados, navegador.desalojados], [creados + 1, desalojados])
  asentar(5)
  assert.equal(navegador.creados, creados + 1)
})

test('una señal de cupo —una propia que se destruye, la pestaña que vuelve a verse— vuelve a intentar las que esperan cupo', () => {
  nuevoNavegador({ techo: 3 })
  const a     = superficie('a', { z: 10 })
  const b     = superficie('b', { z: 20 })
  const ajeno = navegador.ajeno()
  const c     = superficie('c', { z: 30 })              // desaloja a a, que vuelve y desaloja a b: a le cede el lugar
  asentar(10)
  assert.deepEqual(estados(a, b, c), ['released', 'live', 'live'])

  vivas.splice(vivas.indexOf(c), 1)
  c.destroy()                                           // devuelve un cupo
  cuadro()
  assert.deepEqual(estados(a, b), ['live', 'live'])

  ajeno.gl.flush()                                      // el ajeno dibuja: la de flush más viejo es a
  const d = superficie('d', { z: 40 })                  // y d la desaloja; volvió en esta tanda: no se insiste
  asentar(10)
  assert.deepEqual(estados(a, b, d), ['released', 'live', 'live'])
  navegador.desalojar(ajeno)                            // el widget ajeno se cierra, y nadie lo avisa
  asentar(5)
  assert.equal(a.state, 'released')
  document.dispatchEvent(new Event('visibilitychange'))
  asentar()
  assert.equal(a.state, 'live', 'la pestaña volvió a verse: lo intenta, y hay cupo')
})

test('en saturación, dos reintentos espaciados —5 s y 30 s—, de a lo sumo dos getContext cada uno, y nada más', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    nuevoNavegador({ techo: 3 })
    const a = superficie('a', { z: 10 })
    const b = superficie('b', { z: 20 })
    insistente()
    contextoDe(b).gl.flush()
    insistente()
    asentar(10)
    assert.equal(a.state, 'released')
    const creados = navegador.creados
    const propias = () => navegador.contextos.slice(creados).filter(c => !c.ajeno).length

    // Sin cupo, un reintento toma a la de menor z. Si desaloja a una propia —los ajenos dibujaron después—, ésta tiene más z
    // y vuelve a su lugar: dos. Si desaloja a un ajeno, el ajeno se rehace y la desaloja a ella: uno.
    mock.timers.tick(5000)
    asentar(10)
    assert.equal(propias(), 2, 'el primer reintento desaloja a b, que vuelve')
    assert.deepEqual(estados(a, b), ['released', 'live'])
    mock.timers.tick(30_000)
    asentar(10)
    assert.equal(propias(), 3, 'el segundo, a los 30 s, desaloja a un ajeno que se rehace')
    mock.timers.tick(600_000)
    asentar(10)
    assert.equal(propias(), 3, 'y no hay más')
    assert.deepEqual(estados(a, b), ['released', 'live'])
  } finally {
    mock.timers.reset()
  }
})

test('una señal de cupo cancela el reintento agendado: si la saturación vuelve, el siguiente es el de los 30 s, no el de los 5 s que quedaba', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    nuevoNavegador({ techo: 3 })
    const a = superficie('a', { z: 10 })
    const b = superficie('b', { z: 20 })
    insistente()
    contextoDe(b).gl.flush()
    insistente()
    asentar(10)
    assert.equal(a.state, 'released')
    mock.timers.tick(1000)
    glBudget.retry()                                    // la señal: a lo intenta, un ajeno se rehace y la satura de nuevo
    asentar(10)
    assert.equal(a.state, 'released')
    const creados = navegador.creados
    mock.timers.tick(4000)                              // donde vencía el reintento de los 5 s
    asentar(10)
    assert.equal(navegador.creados, creados, 'ningún getContext: el reintento viejo no quedó vivo')
    mock.timers.tick(30_000)
    asentar(10)
    assert.ok(navegador.creados > creados, 'el de los 30 s sí')
  } finally {
    mock.timers.reset()
  }
})

// Firefox no desaloja en la tarea del getContext que pasa el techo: `isContextLost()` sigue en falso y `webglcontextlost`
// llega ≈ 2,5 s después, cuando el rato ocioso (tope de 1 s) ya corrió (remota B, Firefox 153 con techo 8). Acá el techo no
// desaloja y el test desaloja después del rato ocioso, como Firefox.
test('desalojo avisado después del rato ocioso (Firefox): la saturación sigue con dos reintentos, no con uno cada 5 s', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const warn = mock.method(console, 'warn', () => {})
  try {
    nuevoNavegador()
    const a = superficie('a', { z: 10 })
    const b = superficie('b', { z: 20 })
    desalojar(b)
    asentar()                                           // b vuelve: la política la tomó
    desalojar(b)
    asentar()                                           // otra vez antes de una señal de cupo: satura y suelta a la de menor z
    assert.deepEqual(estados(a, b), ['released', 'live'])

    // Cada reintento toma a `a`; el aviso de que eso desalojó a `b` llega después del rato ocioso. `b` vuelve, y el aviso de
    // que eso desalojó a `a` también llega tarde: la saturación de nuevo.
    const tomas = []
    const ciclo = () => {
      const creados = navegador.creados
      asentar()
      if (navegador.creados === creados) return
      tomas.push(Date.now())
      ocio()
      desalojar(b)
      asentar(3)
      ocio()
      a.state === 'live' && desalojar(a)
      asentar(3)
      ocio()
    }
    for (let t = 0; t < 120_000; t += 1000) {
      mock.timers.tick(1000)
      ciclo()
    }
    assert.deepEqual(tomas, [5000, 35_000], 'los dos de la escalera, a los 5 s y 30 s después, y nada más')
    assert.deepEqual(estados(a, b), ['released', 'live'])
  } finally {
    warn.mock.restore()
    mock.timers.reset()
  }
})

/* ── Pérdida masiva ── */

test('un reinicio de la GPU devuelve todas las necesarias de a una por cuadro, por z, y la prescindible no', () => {
  nuevoNavegador()
  const a = superficie('a', { z: 10 })
  const b = superficie('b', { z: 30 })
  const c = superficie('c', { z: 20 })
  const v = superficie('vacía', { z: 40, contenido: false })
  ocio()
  desalojar(a, b, c, v)
  navegador.vaciar()
  assert.equal(v.state, 'released')
  cuadro()
  assert.deepEqual(estados(a, b, c), ['lost', 'live', 'lost'])
  cuadro()
  assert.deepEqual(estados(a, b, c), ['lost', 'live', 'live'])
  cuadro()
  asentar(5)
  assert.deepEqual(estados(a, b, c, v), ['live', 'live', 'live', 'released'])
  assert.equal(navegador.desalojados, 4, 'volver con los cupos libres no desaloja a nadie')
})

test('un reinicio de la GPU en medio de una tanda no se toma por un ciclo', () => {
  nuevoNavegador()
  const a = superficie('a', { z: 10 })
  const b = superficie('b', { z: 30 })
  desalojar(a)
  asentar()                                             // a vuelve: está en la tanda de la política
  desalojar(a, b)
  asentar(3)
  assert.deepEqual(estados(a, b), ['live', 'live'])
})

/* ── Orden de desalojo ── */

test('tras cada adquisición las necesarias renuevan su flush por z ascendente: cae la prescindible y después la de menor z', () => {
  nuevoNavegador({ techo: 5 })
  const n1 = superficie('n1', { z: 10 })
  const n2 = superficie('n2', { z: 30 })
  const n3 = superficie('n3', { z: 20 })
  const e  = superficie('vacía', { z: 50, contenido: false })
  ocio()
  ocio()
  const idE = contextoDe(e).id
  navegador.ajeno()                                     // el quinto: cabe
  navegador.ajeno()
  assert.deepEqual(navegador.victimas, [idE], 'cae la vacía, la de flush más viejo')
  asentar()
  assert.equal(e.state, 'released')
  navegador.ajeno()
  asentar(10)
  assert.deepEqual(estados(n1, n2, n3), ['released', 'live', 'live'], 'la de menor z es la que queda sin superficie')
})

test('sin presión en el realm, una alta que se ve no vacía ninguna cola, y poblar una vacía o mostrar una oculta sólo vacía las que quedan delante de la necesaria de menor z', () => {
  nuevoNavegador({ techo: 5 })
  const n      = superficie('n', { z: 10 })
  const vacia  = superficie('vacía', { z: 20, contenido: false })
  const oculta = superficie('oculta', { z: 40, oculta: true })
  ocio()
  assert.equal(vacia.state, 'live')
  const previos = navegador.contextos.length
  const usos    = () => navegador.contextos.slice(0, previos).map(c => c.ultimoUso).join()
  const antes   = usos()
  superficie('con contenido después', { z: 30 })      // se ve y toma el suyo al alta: nace como la más joven
  const diferida = superficie('diferida', { z: 35, contenido: false })
  diferida.owner.hasContent = true
  assert.equal(diferida.need(), true, 'toma su primer contexto con su dato: se ve, y nace como la más joven')
  assert.equal(usos(), antes, 'ni un flush: la primera espiral y su capa de patas no pagan nada')
  const flushes = [n, vacia, oculta].map(s => mock.method(s.gl, 'flush'))
  vacia.owner.hasContent = true
  assert.equal(vacia.need(), false)
  assert.equal(mostrar(oculta), false)
  for (let i = 0; i < 3; i++) {
    vacia.need()
    mostrar(oculta)
    ocio()
    cuadro()
  }
  assert.deepEqual(flushes.map(f => f.mock.callCount()), [0, 1, 1],
    'la oculta, que era la más vieja, y la vacía, que quedó delante de n: una vez cada una, y no en los avisos que siguen')
  assert.equal(n.state, 'live')
  assert.equal(primeraVictima(5, n, vacia, oculta), 'n')
})

test('N-A: antes de la primera pérdida, una vacía de z alto que tomó su contexto en un rato ocioso y recibe contenido no queda como la más vieja: un ajeno desaloja a la necesaria de menor z', () => {
  nuevoNavegador({ techo: 3 })
  const a = superficie('a', { z: 10 })
  const b = superficie('b', { z: 30, contenido: false })
  ocio()                                                // la política toma b, prescindible: renueva, y b queda la más vieja
  assert.deepEqual(estados(a, b), ['live', 'live'])
  const idA = contextoDe(a).id
  b.owner.hasContent = true
  b.need()                                              // pasa a necesaria
  ocio()
  navegador.ajeno()
  navegador.ajeno()                                     // techo 3: el segundo desaloja a la de flush más viejo
  assert.deepEqual(navegador.victimas, [idA], 'cae a, z10, y no b, z30')
  navegador.vaciar()
  assert.deepEqual(estados(a, b), ['lost', 'live'])
})

// Las sondas P1, P2, P3 y P5 de la revisión de la tanda 2c: la que pasa a necesaria tiene MENOS z que las necesarias, o
// llegan dos. Sin rato ocioso entre el aviso y los ajenos: el orden queda en la tarea del aviso.

test('P1: sin presión, una vacía de z bajo que recibe contenido es la primera en caer, no la necesaria de z más alto', () => {
  nuevoNavegador({ techo: 3 })
  const a = superficie('a', { z: 10 })
  const b = superficie('b', { z: 5, contenido: false })
  ocio()
  b.owner.hasContent = true
  b.need()
  assert.equal(primeraVictima(3, a, b), 'b')
})

test('P3: sin presión, una vacía de z bajo que recibe contenido cae antes que dos necesarias de z más alto', () => {
  nuevoNavegador({ techo: 4 })
  const a = superficie('a', { z: 20 })
  const x = superficie('x', { z: 30 })
  const b = superficie('b', { z: 10, contenido: false })
  ocio()
  b.owner.hasContent = true
  b.need()
  assert.equal(primeraVictima(4, a, x, b), 'b')
})

test('P2: sin presión, dos vacías que reciben contenido —una sobre la necesaria y otra debajo, en cualquier orden— dejan primera en caer a la de menor z', () => {
  for (const orden of ['la de z alto primero', 'la de z bajo primero']) {
    nuevoNavegador({ techo: 4 })
    const a = superficie('a', { z: 20 })
    const b = superficie('b', { z: 30, contenido: false })
    const c = superficie('c', { z: 10, contenido: false })
    ocio()
    ocio()
    assert.deepEqual(estados(b, c), ['live', 'live'])
    b.owner.hasContent = c.owner.hasContent = true
    ;(orden === 'la de z alto primero' ? [b, c] : [c, b]).forEach(s => s.need())
    assert.equal(primeraVictima(4, a, b, c), 'c', orden)
    vivas.splice(0).forEach(s => s.destroy())
  }
})

test('P5: sin presión, una oculta de z alto que se vuelve a ver no queda primera en caer', () => {
  nuevoNavegador({ techo: 3 })
  const a = superficie('a', { z: 10 })
  const b = superficie('b', { z: 30, oculta: true })
  ocio()
  mostrar(b)
  assert.equal(primeraVictima(3, a, b), 'a')
})

test('sin presión, una vacía que recibe contenido y no queda primera en caer no vacía ninguna cola: lo que tiene detrás sigue siendo una prescindible', () => {
  nuevoNavegador({ techo: 5 })
  const a = superficie('a', { z: 20 })
  const b = superficie('b', { z: 30, contenido: false })
  const c = superficie('c', { z: 10, contenido: false })
  ocio()
  ocio()
  const flushes = [a, b, c].map(s => mock.method(s.gl, 'flush'))
  c.owner.hasContent = true
  c.need()                                              // b, prescindible, sigue más vieja que todas: es la que cae
  assert.deepEqual(flushes.map(f => f.mock.callCount()), [0, 0, 0])
  assert.equal(primeraVictima(5, a, b, c), 'b')
})

test('M6 del banco sin presión: poblar en orden de z cuatro vacías que rodean a necesarias sólo paga, en la última, las que quedaron delante de la de menor z', () => {
  nuevoNavegador({ techo: 12 })
  const geo     = superficie('geo', { z: 400 })
  const veh     = superficie('veh', { z: 410 })
  const enlaces = superficie('enlaces', { z: 614 })
  const vacias  = [394, 395, 405, 406].map(z => superficie(`vacía ${z}`, { z, contenido: false }))
  for (let i = 0; i < 4; i++) ocio()
  assert.deepEqual(estados(...vacias), ['live', 'live', 'live', 'live'])
  const todas   = [geo, veh, enlaces, ...vacias]
  const flushes = todas.map(s => mock.method(s.gl, 'flush'))
  vacias.slice(0, 3).forEach(s => {
    s.owner.hasContent = true
    s.need()
  })
  assert.equal(flushes.reduce((n, f) => n + f.mock.callCount(), 0), 0, 'queda una prescindible más vieja que todas: cae ella')
  vacias[3].owner.hasContent = true
  vacias[3].need()
  assert.deepEqual(flushes.map(f => f.mock.callCount()), [0, 0, 0, 0, 1, 1, 1],
    'las tres vacías que se tomaron antes que la de z 394 vacían la suya: queda primera')
  assert.equal(primeraVictima(12, ...todas), 'vacía 394')
})

// Sin presión sólo el paso de prescindible a necesaria, avisado, acomoda el orden, una vez. Una oculta que se ve sin
// aviso queda en la cabeza del desalojo, delante de una necesaria de menor z: el aviso de OTRA necesaria —que no viene
// de entre las prescindibles, o que ya se acomodó— no la corrige. `antes` arma lo suyo antes de la renovación, y
// `despues` lo que pasa entre ésta y el aviso.
const sinAcomodar = {
  'una necesaria desde el alta': { despues: ({ a }) => [a] },
  'una oculta que se vio sin aviso y otra renovación dejó necesaria': {
    antes  : () => superficie('x', { z: 60, oculta: true }),
    despues: ({ x }) => {
      x.nodo.style.visibility = ''
      superficie('vacía', { z: 5, contenido: false })
      ocio()                                            // la toma: renueva, y x queda necesaria
      return [x]
    },
  },
  'una oculta que ya se acomodó al verse': {
    antes  : () => superficie('x', { z: 60, oculta: true }),
    despues: ({ x }) => (mostrar(x), [x]),
  },
  'una oculta que se soltó a mano y volvió a tomar el suyo al verse': {
    antes  : () => superficie('x', { z: 60, oculta: true }),
    despues: ({ x }) => {
      x.release()
      mostrar(x)
      cuadro()
      return [x]
    },
  },
}

test('sin presión, el aviso de una necesaria que no viene de entre las prescindibles no toca el orden, aunque la cabeza del desalojo no sea la de menor z', () => {
  for (const [caso, { antes, despues }] of Object.entries(sinAcomodar)) {
    nuevoNavegador({ techo: 10 })
    const a = superficie('a', { z: 30 })
    const h = superficie('oculta', { z: 50, oculta: true })
    const x = antes?.()
    ocio()                                              // altas que no se ven: renueva, y h queda la más vieja
    const avisan = despues({ a, x })
    h.nodo.style.visibility = ''                        // se ve sin aviso: la cabeza es una necesaria de más z que a
    const flushes = [a, h, ...avisan].map(s => mock.method(s.gl, 'flush'))
    avisan.forEach(s => s.need())
    ocio()
    assert.deepEqual(flushes.map(f => f.mock.callCount()), flushes.map(() => 0), caso)
    assert.equal(primeraVictima(10, ...vivas), 'oculta', caso)
    vivas.splice(0).forEach(s => s.destroy())
  }
})

test('sin presión, acomodar la cabeza vacía la cola de las necesarias que tiene delante y para en la primera prescindible, sin vaciar la suya', () => {
  nuevoNavegador({ techo: 10 })
  const a = superficie('a', { z: 10 })
  const h = superficie('oculta', { z: 50, oculta: true })
  const d = superficie('d', { z: 30, contenido: false })
  const e = superficie('e', { z: 20, contenido: false })
  for (let i = 0; i < 3; i++) ocio()                    // h al alta; d y e en ratos ociosos: la escalera es h, d, e
  h.nodo.style.visibility = ''                          // h se ve sin aviso
  const flushes = [a, h, d, e].map(s => mock.method(s.gl, 'flush'))
  d.owner.hasContent = true
  d.need()                                              // e, prescindible, es más joven: d vacía la suya; la cabeza es h
  assert.deepEqual(flushes.map(f => f.mock.callCount()), [0, 1, 1, 0], 'h la vacía, y e se queda como estaba')
  assert.equal(primeraVictima(10, a, h, d, e), 'e')
})

test('sin presión, acomodar la cabeza no salta a las de la escalera que ya vaciaron su cola', () => {
  nuevoNavegador({ techo: 10 })
  const a = superficie('a', { z: 10 })
  const x = superficie('x', { z: 30, contenido: false })
  const y = superficie('y', { z: 20, contenido: false })
  for (let i = 0; i < 3; i++) ocio()                    // la escalera: x, y
  const flushes = [a, x, y].map(s => mock.method(s.gl, 'flush'))
  x.owner.hasContent = y.owner.hasContent = true
  x.need()                                              // y es más joven: x vacía la suya
  y.need()                                              // la cabeza es y, y la de menor z es a: y vacía la suya
  assert.deepEqual(flushes.map(f => f.mock.callCount()), [0, 1, 1])
  assert.equal(primeraVictima(10, a, x, y), 'a')
})

test('sin presión, si la de menor z es una de la escalera que ya vació su cola, se acomoda con el registro entero', () => {
  nuevoNavegador({ techo: 10 })
  const a = superficie('a', { z: 20 })
  const q = superficie('q', { z: 30, oculta: true })
  const p = superficie('p', { z: 5, oculta: true })
  const r = superficie('r', { z: 40, contenido: false })
  for (let i = 0; i < 3; i++) ocio()                    // la escalera: q, p, r
  mostrar(p)                                            // r es más joven: p vacía la suya, y queda detrás de a
  r.owner.hasContent = true
  r.need()
  q.nodo.style.visibility = ''
  mostrar(r)                                            // nada: r ya se acomodó
  const flushes = [a, q, p, r].map(s => mock.method(s.gl, 'flush'))
  q.nodo.style.visibility = 'hidden'
  mostrar(q)                                            // la cabeza es q y la de menor z es p, que ya vació: hasta a
  assert.deepEqual(flushes.map(f => f.mock.callCount()), [1, 1, 0, 1])
  assert.equal(primeraVictima(10, a, q, p, r), 'p')
})

test('sin presión, acomodar la cabeza deja fuera a una alta de menor z: llega hasta la necesaria de menor z de la renovación', () => {
  nuevoNavegador({ techo: 10 })
  const a = superficie('a', { z: 30 })
  const h = superficie('oculta', { z: 50, oculta: true })
  const e = superficie('e', { z: 40, contenido: false })
  for (let i = 0; i < 2; i++) ocio()                    // la escalera: h, e
  h.nodo.style.visibility = ''
  const b = superficie('b', { z: 10 })                  // se ve: nace como la más joven
  const flushes = [a, h, e, b].map(s => mock.method(s.gl, 'flush'))
  e.owner.hasContent = true
  e.need()
  assert.deepEqual(flushes.map(f => f.mock.callCount()), [0, 1, 1, 0])
  assert.equal(primeraVictima(10, a, h, e, b), 'a')
})

test('S6 con dos necesarias: la de menor z de la renovación es la que queda primera, no la otra', () => {
  nuevoNavegador({ techo: 4 })
  const a = superficie('a', { z: 10 })
  const c = superficie('c', { z: 40 })
  const b = superficie('b', { z: 30, contenido: false })
  ocio()
  b.owner.hasContent = true
  b.need()
  assert.equal(primeraVictima(4, a, b, c), 'a')
})

// F1 de la revisión 2D-1: la vacía que todavía no tomó su contexto lo toma con su primer dato y nace como la más joven.
test('F1: sin presión, una vacía de z bajo que toma su primer contexto con su dato cae antes que las necesarias de más z', () => {
  nuevoNavegador({ techo: 5 })
  const s0 = superficie('s0', { z: 40 })
  const s1 = superficie('s1', { z: 30, contenido: false })
  const s2 = superficie('s2', { z: 20, contenido: false })
  ocio()                                                // toma s1, la de mayor z; s2 sigue sin contexto
  assert.deepEqual(estados(s1, s2), ['live', 'none'])
  s1.owner.hasContent = s2.owner.hasContent = true
  s1.need()
  assert.equal(s2.need(), true)
  assert.equal(primeraVictima(5, s0, s1, s2), 's2')
})

test('F1 sin renovación: la primera toma por aviso de una de z bajo, antes de cualquier rato ocioso, la deja primera en caer', () => {
  nuevoNavegador({ techo: 3 })
  const a = superficie('a', { z: 40 })
  const b = superficie('b', { z: 20, contenido: false })
  b.owner.hasContent = true
  assert.equal(b.need(), true)
  assert.equal(primeraVictima(3, a, b), 'b')
})

test('F1: la primera toma por aviso de una de z alto, o con una prescindible delante, no vacía ninguna cola', () => {
  nuevoNavegador({ techo: 6 })
  const a = superficie('a', { z: 20 })
  const h = superficie('oculta', { z: 50, oculta: true })
  ocio()                                                // h no se ve: renueva, y queda la más vieja
  const flushes = [a, h].map(s => mock.method(s.gl, 'flush'))
  const baja = superficie('baja', { z: 10, contenido: false })
  baja.owner.hasContent = true
  baja.need()                                           // la cabeza es h, prescindible: es la que cae
  const alta = superficie('alta', { z: 30, contenido: false })
  alta.owner.hasContent = true
  alta.need()
  assert.deepEqual(flushes.map(f => f.mock.callCount()), [0, 0])
  assert.equal(primeraVictima(6, a, h, baja, alta), 'oculta')
})

// Leer la z de un pane cuesta ≈ 1,5 µs en Chromium: cuenta las lecturas del pane de cada una de `ss`.
const lecturasDeZ = (...ss) => ss.map(s => {
  const cuenta = { n: 0 }
  let z        = s.nodo.style.zIndex
  Object.defineProperty(s.nodo.style, 'zIndex', { get: () => (cuenta.n++, z), set: v => z = v, configurable: true })
  return cuenta
})

test('sin presión, acomodar la primera en caer no lee la z de las que no hace falta comparar', () => {
  nuevoNavegador({ techo: 8 })
  const a = superficie('a', { z: 20 })
  const h = superficie('oculta', { z: 50, oculta: true })
  ocio()
  let lecturas = lecturasDeZ(a, h)
  const baja   = superficie('baja', { z: 10, contenido: false })
  baja.owner.hasContent = true
  baja.need()                                           // la cabeza es h, prescindible: no compara nada
  assert.deepEqual(lecturas.map(c => c.n), [0, 0], 'la primera toma con una prescindible delante')
  vivas.splice(0).forEach(s => s.destroy())

  const n = superficie('n', { z: 10 })
  const c = superficie('c', { z: 40 })
  const b = superficie('b', { z: 30, contenido: false })
  ocio()                                                // la escalera es b; la de menor z, n
  const tarde = superficie('tarde', { z: 60, contenido: false })
  tarde.owner.hasContent = true
  tarde.need()                                          // se toma necesaria después de la renovación, con b delante
  lecturas = lecturasDeZ(n, c, b)
  b.owner.hasContent = true
  b.need()                                              // la de menor z sigue siendo n: no se mira el registro entero
  assert.deepEqual(lecturas.map(l => l.n), [0, 0, 0], 'acomodar con la z de la renovación y la de la tomada después')
  assert.equal(primeraVictima(8, n, c, b, tarde), 'n')
  vivas.splice(0).forEach(s => s.destroy())

  const m = superficie('m', { z: 10 })
  const x = superficie('x', { z: 40, contenido: false })
  ocio()                                                // la escalera es x
  const oculta = superficie('después', { z: 60, contenido: false })
  oculta.owner.hasContent = true
  oculta.need()
  oculta.nodo.style.visibility = 'hidden'               // tomada necesaria y oculta después, sin aviso
  const p = superficie('p', { z: 50, oculta: true })    // alta que no se ve, más joven que m
  lecturas = lecturasDeZ(oculta, p)
  x.owner.hasContent = true
  x.need()                                              // la cabeza es x, necesaria: no compara a las prescindibles
  const debajo = superficie('debajo', { z: 5, contenido: false })
  debajo.owner.hasContent = true
  debajo.need()                                         // la cabeza es m, necesaria: el registro entero, sin ellas
  assert.deepEqual(lecturas.map(l => l.n), [0, 0], 'las prescindibles no entran en la cuenta de la menor z')
})

// Sondas de la revisión 2D-1, acotadas: desempate a igual z tras una renovación (R03), cabeza de la escalera soltada a
// mano (R07) y base oculta tras la renovación con la cabeza necesaria (R17).

test('a igual z, tras una renovación, cae primero la dada de alta antes', () => {
  for (const poblar of [false, true]) {
    nuevoNavegador({ techo: 6 })
    const a = superficie('a', { z: 10 })
    const b = superficie('b', { z: 10 })
    const c = superficie('c', { z: 20, contenido: false })
    ocio()
    ocio()
    c.owner.hasContent = poblar
    poblar && c.need()
    assert.equal(primeraVictima(6, a, b, c), poblar ? 'a' : 'c')
    vivas.splice(0).forEach(s => s.destroy())
  }
})

test('sin presión, si la cabeza de la escalera se soltó a mano, la cabeza es la siguiente: una necesaria que vacía su cola hasta la de menor z', () => {
  nuevoNavegador({ techo: 10 })
  const a = superficie('a', { z: 10 })
  const r = superficie('r', { z: 60, oculta: true })
  const h = superficie('h', { z: 50, oculta: true })
  const e = superficie('e', { z: 40, contenido: false })
  for (let i = 0; i < 3; i++) ocio()
  r.release()
  h.nodo.style.visibility = ''                          // se ve sin aviso
  e.owner.hasContent = true
  e.need()
  assert.equal(primeraVictima(10, a, h, e), 'a')
})

test('sin presión, si la base se ocultó tras la renovación, el registro entero no vacía la cola de la prescindible: sigue primera en caer', () => {
  nuevoNavegador({ techo: 10 })
  const a = superficie('a', { z: 10 })
  const b = superficie('b', { z: 30 })
  const h = superficie('h', { z: 50, oculta: true })
  const e = superficie('e', { z: 40, contenido: false })
  for (let i = 0; i < 3; i++) ocio()
  a.nodo.style.visibility = 'hidden'
  h.nodo.style.visibility = ''
  e.owner.hasContent = true
  e.need()
  assert.equal(primeraVictima(10, a, b, h, e), 'a')
})

// La regla, paso a paso, en mapas al azar: entre las propias vivas, si hay una prescindible cae una; si no, la necesaria
// de menor z y, a igual z, la dada de alta antes. La víctima se lee del navegador falso (el contexto vivo de flush más
// viejo) después de cada aviso, no sólo al final.
const azar        = semilla => n => Math.floor((semilla = (semilla * 1664525 + 1013904223) >>> 0) / 2 ** 32 * n)
const cabezaFalsa = ss => ss.filter(s => s.state === 'live').map(s => [contextoDe(s), s])
  .reduce((v, [c, s]) => !v || c.ultimoUso < v[0].ultimoUso ? [c, s] : v, null)?.[1]
const cumple      = ss => {
  const vivasYa = ss.filter(s => s.state === 'live')
  const cabeza  = cabezaFalsa(ss)
  if (vivasYa.some(s => !s.needed)) return !cabeza.needed
  return vivasYa.every(s => s === cabeza || s.z > cabeza.z || (s.z === cabeza.z && s.alta > cabeza.alta))
}

test('la regla por z, paso a paso, en 300 mapas al azar: con las vacías tomadas antes de poblarse o tomando su primer contexto con su dato', () => {
  const fallos = []
  for (const tomadas of [true, false]) {
    for (let semilla = 1; semilla <= 150; semilla++) {
      const pick = azar(semilla)
      const n    = 3 + pick(4)
      nuevoNavegador({ techo: n + 2 })
      const ss = []
      for (let i = 0; i < n; i++) {
        const tipo = pick(10) < 5 ? 'vacía' : pick(10) < 7 ? 'oculta' : 'llena'
        const z    = 10 * (1 + pick(5))
        const s    = superficie(`s${i} z${z} ${tipo}`, { z, contenido: tipo !== 'vacía', oculta: tipo === 'oculta' })
        ss.push(Object.assign(s, { tipo, alta: i }))
      }
      for (let i = 0; i < (tomadas ? n : 1); i++) ocio()
      const pendientes = ss.filter(s => s.tipo !== 'llena')
      const pasos      = []
      while (pendientes.length && !fallos.length) {
        pick(3) || (ocio(), pasos.push('ocio'))
        const s = pendientes.splice(pick(pendientes.length), 1)[0]
        s.tipo === 'vacía' ? s.owner.hasContent = true : s.nodo.style.visibility = ''
        pasos.push(`${s.nombre} (${s.state})`)
        s.need()
        cumple(ss) || fallos.push({ tomadas, semilla, pasos, cae: cabezaFalsa(ss).nombre })
        pick(4) || (ocio(), pasos.push('ocio'))
      }
      vivas.splice(0).forEach(s => s.destroy())
    }
  }
  assert.deepEqual(fallos, [], JSON.stringify(fallos))
})

test('la regla por z con altas a mitad de camino y varias renovaciones, en 80 mapas al azar', () => {
  const fallos = []
  for (let semilla = 1; semilla <= 80 && !fallos.length; semilla++) {
    const pick       = azar(semilla * 31 + 5)
    nuevoNavegador({ techo: 14 })
    const ss         = []
    const pendientes = []
    const alta       = (tipo = pick(2) ? 'vacía' : 'oculta') => {
      const z = 10 * (1 + pick(6))
      const s = superficie(`s${ss.length} z${z} ${tipo}`, { z, contenido: tipo !== 'vacía', oculta: tipo === 'oculta' })
      ss.push(Object.assign(s, { tipo, alta: ss.length }))
      tipo === 'llena' || pendientes.push(s)
    }
    for (let i = 2 + pick(3); i > 0; i--) alta('llena')
    alta()
    for (let paso = 0; paso < 12 && (pendientes.length || paso < 3); paso++) {
      if (!pick(3) && ss.length < 9) {
        alta()
        continue
      }
      for (let i = 0; i <= ss.length; i++) ocio()
      const listas = pendientes.filter(s => s.state === 'live')
      if (!listas.length) continue
      const s = listas[pick(listas.length)]
      pendientes.splice(pendientes.indexOf(s), 1)
      s.tipo === 'vacía' ? s.owner.hasContent = true : s.nodo.style.visibility = ''
      s.need()
      ss.some(x => x.state === 'none') || cumple(ss) || fallos.push({ semilla, paso, cae: cabezaFalsa(ss).nombre })
    }
    vivas.splice(0).forEach(s => s.destroy())
  }
  assert.deepEqual(fallos, [], JSON.stringify(fallos))
})

test('a igual z se recupera primero la dada de alta después, aunque avise antes', () => {
  nuevoNavegador({ techo: 10 })
  const [a, b, c] = ['a', 'b', 'c'].map(n => superficie(n, { z: 10 }))
  ;[a, b, c].forEach(s => s.release())
  assert.equal(c.need(), true, 'la primera toma por aviso es en la tarea')
  assert.equal(b.need(), false)
  assert.equal(a.need(), false)
  cuadro()
  assert.deepEqual(estados(a, b), ['released', 'live'])
})

test('sin presión, la que pasa a necesaria no queda detrás de una prescindible que la renovación dejó vieja: una ráfaga de ajenos se lleva antes a las dos prescindibles', () => {
  nuevoNavegador({ techo: 4 })
  const a = superficie('a', { z: 40 })
  const x = superficie('x', { z: 30, contenido: false })
  const y = superficie('y', { z: 20, contenido: false })
  const w = superficie('w', { z: 10, contenido: false })
  for (let i = 0; i < 3; i++) ocio()                    // de a una y por z: x, y, w; w es la más joven de las tres
  assert.deepEqual(estados(x, y, w), ['live', 'live', 'live'])
  const ids = new Map([a, x, y, w].map(s => [contextoDe(s).id, s.nombre]))
  y.owner.hasContent = true
  y.need()
  navegador.ajeno()
  navegador.ajeno()                                     // en la misma tarea: nadie llega a avisar entre los dos
  assert.deepEqual(navegador.victimas.map(id => ids.get(id)), ['x', 'w'])
})

test('desde la primera pérdida del realm, una viva que pasa a necesaria —recibe contenido o se vuelve a ver— renueva el orden en el próximo rato ocioso', () => {
  nuevoNavegador({ techo: 5 })
  const n      = superficie('n', { z: 10 })
  const vacia  = superficie('vacía', { z: 20, contenido: false })
  const otra   = superficie('otra vacía', { z: 30, contenido: false })
  const oculta = superficie('oculta', { z: 40, oculta: true })
  const previa = superficie('oculta que cae', { z: 50, oculta: true })
  ocio()
  ocio()
  assert.deepEqual(estados(vacia, otra), ['live', 'live'])
  desalojar(previa)                                     // la primera pérdida del realm: una prescindible, que queda soltada
  asentar()
  assert.equal(previa.state, 'released')
  vacia.owner.hasContent = true
  assert.equal(vacia.need(), false, 'ya tiene su contexto: no toma otro')
  assert.equal(mostrar(oculta), false)
  ocio()
  const uso = contextoDe(n).ultimoUso
  vacia.need()
  ocio()
  assert.equal(contextoDe(n).ultimoUso, uso, 'una que ya renovó no vuelve a pedirlo')

  const idOtra = contextoDe(otra).id
  navegador.ajeno()                                     // el quinto: cabe
  navegador.ajeno()
  assert.deepEqual(navegador.victimas.slice(1), [idOtra], 'cae la que sigue vacía, no la oculta que se mostró')
  asentar()
  assert.deepEqual(estados(n, vacia, otra, oculta), ['live', 'live', 'released', 'live'])
})

test('N11: la primera pérdida del realm rehace en el próximo rato ocioso el orden que no se cuidó: un ajeno desaloja después a la necesaria de menor z', () => {
  nuevoNavegador({ techo: 4 })
  const p    = superficie('oculta', { z: 50, oculta: true })
  ocio()
  const alta = superficie('alta', { z: 30 })
  const baja = superficie('baja', { z: 10 })            // nace después: la más joven, aunque tiene menos z
  ocio()
  desalojar(p)                                          // la primera pérdida: una prescindible, que queda soltada
  asentar()
  assert.equal(p.state, 'released')
  ocio()
  const idBaja = contextoDe(baja).id
  navegador.ajeno()
  navegador.ajeno()
  navegador.ajeno()                                     // techo 4: el tercero desaloja a la de flush más viejo
  assert.deepEqual(navegador.victimas.slice(1), [idBaja], 'cae baja, z10, y no alta, z30')
  navegador.vaciar()
  assert.deepEqual(estados(alta, baja), ['live', 'lost'])
})

test('desde la primera pérdida, recuperar una necesaria rehace el orden entero en el cuadro: una ráfaga de ajenos se lleva a las de menor z, en orden', () => {
  nuevoNavegador({ techo: 3 })
  const c = superficie('c', { z: 30 })
  const b = superficie('b', { z: 20 })
  const a = superficie('a', { z: 10 })                  // por alta, la más joven: el orden es c, b, a
  desalojar(a)
  asentar(2)                                            // la pierde y la recupera en un cuadro, sin rato ocioso
  assert.deepEqual(estados(a, b, c), ['live', 'live', 'live'])
  const ids = new Map([a, b, c].map(s => [contextoDe(s).id, s.nombre]))
  navegador.ajeno()
  navegador.ajeno()                                     // en la misma tarea: nadie llega a avisar entre los dos
  assert.deepEqual(navegador.victimas.slice(1).map(id => ids.get(id)), ['a', 'b'])
})

test('N14/N19: sin presión, una alta por su cuenta que no se ve hace que el rato ocioso ordene el desalojo una vez; la siguiente alta que se ve no lo repite', () => {
  nuevoNavegador({ techo: 4 })
  const n = superficie('n', { z: 10 })
  const h = superficie('oculta', { z: 20, oculta: true })   // la toma al construirse: nace más joven que n
  const f = mock.method(n.gl, 'flush')
  ocio()
  assert.equal(f.mock.callCount(), 1, 'n vacía su cola: la oculta queda como la más vieja')
  superficie('se ve', { z: 30 })
  ocio()
  assert.equal(f.mock.callCount(), 1, 'el rato ocioso ya olvidó a la oculta: una alta que se ve no rehace el orden')
  const idH = contextoDe(h).id
  navegador.ajeno()
  navegador.ajeno()                                     // techo 4: el segundo desaloja a la de flush más viejo
  assert.deepEqual(navegador.victimas, [idH], 'cae la oculta, no n')
})

test('N28: un reinicio de la GPU cuya primera pérdida avisada es una necesaria, con una prescindible también perdida, se lee como pérdida masiva: vuelve la que esperaba cupo', () => {
  const warn = mock.method(console, 'warn', () => {})
  try {
    nuevoNavegador({ techo: 2 })
    const a = superficie('a', { z: 10 })
    const b = superficie('b', { z: 20 })
    const c = superficie('c', { z: 30 })
    asentar(10)
    assert.deepEqual(estados(a, b, c), ['released', 'live', 'live'], 'a espera cupo')
    c.nodo.style.visibility = 'hidden'                  // c pasa a prescindible
    desalojar(b, c)                                     // el reinicio: b avisa primero, c todavía no
    asentar(10)
    assert.deepEqual(estados(a, b, c), ['live', 'live', 'released'], 'la pérdida de c sin aviso cuenta: a vuelve sin esperar un reintento')
  } finally {
    warn.mock.restore()
  }
})

/* ── Hallazgos de la etapa 2 ── */

test('H2: quien quita la capa al oír su pérdida no deja una superficie destruida en la espera', () => {
  nuevoNavegador()
  const a = superficie('a')
  const b = superficie('b')
  a.onState = s => s.state === 'lost' && s.destroy()
  desalojar(a)
  navegador.vaciar()
  assert.doesNotThrow(cuadro)
  desalojar(b)
  asentar()
  assert.equal(b.state, 'live', 'y la pérdida siguiente se recupera')
})

test('H6: tomada por fuera de la política mientras esperaba, su turno no toma nada ni cuenta como recuperación', () => {
  nuevoNavegador()
  const a = superficie('a')
  const b = superficie('b')
  desalojar(a)
  navegador.vaciar()
  a.acquire()
  const creados = navegador.creados
  cuadro()
  assert.equal(navegador.creados, creados)
  desalojar(b)
  asentar()
  assert.equal(b.state, 'live')
})

test('la que tira al tomarse queda soltada sin cupo, el error sale, y la que sigue conserva su turno', () => {
  nuevoNavegador()
  const a = superficie('a', { z: 20 })
  const b = superficie('b', { z: 10 })
  desalojar(a, b)
  navegador.vaciar()
  fallar = 1
  assert.throws(cuadro, /sin WebGL2/)
  assert.equal(a.state, 'released')
  cuadro()
  assert.equal(b.state, 'live')
})

/* ── Destruir en cada estado ── */

const ESTADOS = [
  ['vacía esperando un rato ocioso', () => superficie('x', { contenido: false })],
  ['viva',                           () => superficie('x')],
  ['perdida sin aviso',              () => (s => (desalojar(s), s))(superficie('x'))],
  ['perdida esperando su cuadro',    () => (s => (desalojar(s), navegador.vaciar(), s))(superficie('x'))],
  ['perdida esperando un gesto',     () => (s => (glBudget.motion(GESTO, true), desalojar(s), navegador.vaciar(), s))(superficie('x'))],
  ['prescindible soltada',           () => (s => (desalojar(s), navegador.vaciar(), s))(superficie('x', { oculta: true }))],
]

for (const [estado, llevar] of ESTADOS) {
  test(`destruir una ${estado} deja su contexto en 0 y nada la vuelve a tomar`, () => {
    nuevoNavegador()
    const testigo = superficie('testigo')
    const s       = llevar()
    const creados = navegador.creados
    vivas.splice(vivas.indexOf(s), 1)
    s.destroy()
    glBudget.motion(GESTO, false)
    for (let i = 0; i < 5; i++) {
      asentar()
      ocio()
    }
    assert.equal(navegador.creados, creados, 'ningún getContext después de destruir')
    assert.equal(navegador.vivos, 1, 'sólo el testigo')
    assert.equal(testigo.state, 'live')
  })
}

test('destruir una que la saturación dejó sin superficie la saca de la espera de cupo', () => {
  nuevoNavegador({ techo: 2 })
  const a = superficie('a', { z: 10 })
  superficie('b', { z: 20 })
  superficie('c', { z: 30 })
  asentar(10)
  assert.equal(a.state, 'released')
  vivas.splice(vivas.indexOf(a), 1)
  a.destroy()
  const creados = navegador.creados
  glBudget.retry()
  asentar(3)
  assert.equal(navegador.creados, creados)
})

/* ── Revisión de la tanda 2b (etapa3/REVISION.md) ── */

test('R1: tras un reinicio de la GPU, el dato de cada capa en una misma tarea no adelanta a las que esperan su cuadro: vuelven de a una, la de mayor z primero', () => {
  nuevoNavegador()
  const a = superficie('a', { z: 10 })
  const b = superficie('b', { z: 30 })
  const c = superficie('c', { z: 20 })
  desalojar(a, b, c)
  navegador.vaciar()
  const creados = navegador.creados
  assert.deepEqual([a, b, c].map(s => s.need()), [false, false, false])
  assert.equal(navegador.creados, creados, 'el dato no toma: la cola es de la recuperación')
  cuadro()
  assert.deepEqual(estados(a, b, c), ['lost', 'live', 'lost'])
  cuadro()
  assert.deepEqual(estados(a, b, c), ['lost', 'live', 'live'])
  cuadro()
  assert.deepEqual(estados(a, b, c), ['live', 'live', 'live'])
})

test('R1: igual con la pérdida todavía sin aviso: el dato concilia la pérdida y espera su cuadro', () => {
  nuevoNavegador()
  const a = superficie('a', { z: 10 })
  const b = superficie('b', { z: 30 })
  const c = superficie('c', { z: 20 })
  desalojar(a, b, c)
  const creados = navegador.creados
  assert.deepEqual([a, b, c].map(s => s.need()), [false, false, false])
  assert.equal(navegador.creados, creados)
  navegador.vaciar()                                    // los avisos viejos llegan después: ya se procesaron
  cuadro()
  assert.deepEqual(estados(a, b, c), ['lost', 'live', 'lost'], 'un reinicio de la GPU: la de mayor z primero')
  asentar(3)
  assert.deepEqual(estados(a, b, c), ['live', 'live', 'live'])
  assert.equal(navegador.creados, creados + 3)
})

test('R1/R4: mostrar en una misma tarea tres capas que la presión soltó toma una en esa tarea y las demás de a una por cuadro, por z', () => {
  nuevoNavegador()
  const n  = superficie('necesaria', { z: 50 })
  const h1 = superficie('host', { z: 10, oculta: true })
  const h2 = superficie('badge', { z: 11, oculta: true })
  const h3 = superficie('burbujas', { z: 12, oculta: true })
  desalojar(n)
  asentar(3)
  assert.deepEqual(estados(n, h1, h2, h3), ['live', 'released', 'released', 'released'])
  const creados = navegador.creados
  assert.deepEqual([h1, h2, h3].map(mostrar), [true, false, false], 'la primera pinta en esa tarea; las demás esperan su cuadro')
  assert.equal(navegador.creados, creados + 1)
  cuadro()
  assert.deepEqual(estados(h1, h2, h3), ['live', 'released', 'live'])
  cuadro()
  assert.deepEqual(estados(h1, h2, h3), ['live', 'live', 'live'])
  cuadro()
  assert.equal(mostrar(h1), false, 'una viva no toma otro')
  assert.equal(navegador.creados, creados + 3)
})

test('R1: una desalojada por una adquisición de la política que se vuelve a tomar a mano antes de su aviso no deja la anotación: perderla después es un accidente nuevo', () => {
  nuevoNavegador({ techo: 3 })
  const warn = mock.method(console, 'warn', () => {})
  try {
    const a = superficie('a', { z: 10 })
    const b = superficie('b', { z: 20 })
    const c = superficie('c', { z: 30 })
    ocio()
    navegador.ajeno()                                   // cae a, la de flush más viejo
    navegador.vaciar()
    cuadro()                                            // la política toma a y desaloja a b en el acto
    assert.deepEqual(estados(a, b, c), ['live', 'lost', 'live'])
    b.acquire()                                         // la toma su dueña por su cuenta, antes del aviso
    asentar(3)
    assert.deepEqual(estados(a, b, c), ['live', 'live', 'live'])
    glBudget.retry()                                    // una señal de cupo
    desalojar(b)                                        // otra pestaña le quita el suyo, sin pasarse del techo
    asentar(3)
    assert.deepEqual(estados(a, b, c), ['live', 'live', 'live'], 'hay cupo: b vuelve y nadie queda sin superficie')
    assert.equal(warn.mock.callCount(), 0, 'ningún aviso de techo lleno')
  } finally {
    warn.mock.restore()
  }
})

test('R4: mostrar una soltada cuando el navegador ya no da WebGL no lanza; queda soltada, el error sale por consola y no se insiste hasta que otro contexto se logre', () => {
  nuevoNavegador()
  const n      = superficie('n', { z: 50 })
  const oculta = superficie('oculta', { z: 10, oculta: true })
  desalojar(n)
  asentar(3)
  assert.equal(oculta.state, 'released')
  const error = mock.method(console, 'error', () => {})
  try {
    fallar = 5
    assert.equal(mostrar(oculta), false)
    assert.equal(oculta.state, 'released')
    assert.equal(error.mock.callCount(), 1)
    assert.equal(fallar, 4, 'un intento')
    cuadro()
    assert.equal(oculta.need(), false)
    asentar(3)
    assert.equal(fallar, 4, 'sin otro contexto logrado no vuelve a intentarlo, ni con datos ni en un cuadro')
    fallar = 0
    superficie('otra', { z: 60 })
    assert.equal(oculta.need(), true, 'con WebGL de vuelta, la toma')
  } finally {
    error.mock.restore()
  }
})

test('R5: una superficie cuyo documento se quedó sin ventana no es necesaria: perdida, no se recupera', () => {
  nuevoNavegador()
  const viva    = superficie('viva', { z: 10 })
  const cerrada = superficie('de la ventana cerrada', { z: 30 })
  cerrada.canvas.ownerDocument = { defaultView: null }  // la ventana se cerró y nadie quitó el mapa
  assert.equal(cerrada.needed, false)
  const creados = navegador.creados
  desalojar(cerrada)
  asentar(3)
  ocio()
  assert.deepEqual(estados(viva, cerrada), ['live', 'released'])
  assert.equal(navegador.creados, creados, 'ningún contexto para un documento sin ventana')
})

/* ── Huecos que dejaban vivir mutantes (etapa3/REVISION.md, «Tests que no prueban») ── */

test('una perdida que se oculta antes de su cuadro no se vuelve a tomar: queda soltada, y vuelve al verse', () => {
  nuevoNavegador()
  const a = superficie('a', { z: 10 })
  superficie('b', { z: 20 })
  desalojar(a)
  navegador.vaciar()
  assert.equal(a.state, 'lost')
  a.nodo.style.visibility = 'hidden'
  const creados = navegador.creados
  cuadro()
  assert.equal(navegador.creados, creados, 'ni un getContext por una capa que no se ve')
  assert.equal(a.state, 'released')
  assert.equal(mostrar(a), true)
  assert.equal(a.state, 'live')
})

test('un rato ocioso con una recuperación pendiente no toma una diferida: el cuadro es de la recuperación, y la diferida va después', () => {
  nuevoNavegador()
  const a = superficie('a', { z: 10 })
  desalojar(a)
  navegador.vaciar()
  const v = superficie('vacía', { z: 5, contenido: false })   // nace después de la presión: espera su rato ocioso
  const creados = navegador.creados
  ocio()
  assert.deepEqual(estados(a, v), ['lost', 'none'], 'ni la diferida en el rato ocioso antes del cuadro')
  assert.equal(navegador.creados, creados)
  cuadro()
  assert.deepEqual(estados(a, v), ['live', 'none'])
  ocio()
  assert.deepEqual(estados(a, v), ['live', 'live'])
})

test('el fin del gesto retoma las diferidas en el rato ocioso siguiente, sin esperar el plazo del gesto', () => {
  nuevoNavegador()
  superficie('a')
  glBudget.motion(GESTO, true)
  const v = superficie('vacía', { contenido: false })
  ocio()
  assert.equal(v.state, 'none', 'en pleno gesto no se toma')
  assert.equal(ociosos.length, 0, 'ni pide ratos ociosos mientras espera')
  glBudget.motion(GESTO, false)
  ocio()
  assert.equal(v.state, 'live')
})

test('una que esperaba cupo y se toma por fuera sale de la espera: después no hace lugar a costa de las vivas', () => {
  const warn = mock.method(console, 'warn', () => {})
  try {
    nuevoNavegador({ techo: 2 })
    const a = superficie('a', { z: 10 })
    const b = superficie('b', { z: 20 })
    const c = superficie('c', { z: 30 })
    asentar(10)
    assert.deepEqual(estados(a, b, c), ['released', 'live', 'live'])
    navegador.techo = 8                                 // hay cupo, sin una señal que la política oiga
    a.acquire()                                         // la toma su dueña, por su cuenta
    const d = superficie('d', { z: 40, contenido: false })
    d.owner.hasContent = true
    assert.equal(d.need(), true)
    asentar(3)
    assert.deepEqual(estados(a, b, c, d), ['live', 'live', 'live', 'live'], 'nadie queda sin superficie: no hay saturación')
  } finally {
    warn.mock.restore()
  }
})

test('R8: una vacía que toma su primer contexto en pleno zoom animado sigue la transición, como las que ya lo tenían', () => {
  nuevoNavegador()
  const oyentes = new Map()
  const camara  = {
    ...host.camera,
    on      : (ev, cb) => (oyentes.set(ev, [...(oyentes.get(ev) ?? []), cb]), () => {}),
    project : () => ({ x: 0, y: 0 }),
  }
  const h  = { ...host, camera: camara }
  const mk = (nombre, contenido) => {
    const pane = `r8-${nombre}`
    h.pane(pane).style.zIndex = '5'
    const owner = { hasContent: contenido, buildGl() {}, dropGl() {} }
    const s     = new EditSurface({ host: h, pane, owner })
    Object.assign(s, { nombre, owner })
    vivas.push(s)
    s.open(contenido)
    return s
  }
  const vieja = mk('vieja', true)
  const nueva = mk('nueva', false)
  glBudget.motion(GESTO, true)
  oyentes.get('zoomanim').forEach(cb => cb({ center: { lat: 0, lng: 0 }, zoom: 4 }))   // zoom 3 → 4, en curso
  nueva.owner.hasContent = true
  assert.equal(nueva.need(), true, 'la toma en esa tarea, aun en pleno gesto')
  assert.match(vieja.canvas.style.transform, /scale\(2\)/)
  assert.equal(nueva.canvas.style.transform, vieja.canvas.style.transform, 'las dos, en el mismo lugar durante la transición')
  oyentes.get('zoomend').forEach(cb => cb())
  assert.equal(nueva.canvas.style.transform, vieja.canvas.style.transform, 'y al terminar')
  assert.doesNotMatch(nueva.canvas.style.transform, /scale/)
})

test('E15: terminado un zoom animado, un canvas que nace después de un zoom sin animar no toma el transform de la transición vieja', () => {
  nuevoNavegador()
  const oyentes = new Map()
  let   zoom    = 3
  const camara  = {
    ...host.camera,
    zoom    : () => zoom,
    on      : (ev, cb) => (oyentes.set(ev, [...(oyentes.get(ev) ?? []), cb]), () => {}),
    project : () => ({ x: 0, y: 0 }),
  }
  const h     = { ...host, camera: camara }
  h.pane('e15').style.zIndex = '5'
  const owner = { hasContent: true, buildGl() {}, dropGl() {} }
  const s     = new EditSurface({ host: h, pane: 'e15', owner })
  vivas.push(s)
  s.open(true)
  oyentes.get('zoomanim').forEach(cb => cb({ center: { lat: 0, lng: 0 }, zoom: 4 }))
  zoom = 4
  oyentes.get('zoomend').forEach(cb => cb())
  zoom = 5                                              // un setZoom sin animación: no hay zoomanim
  navegador.desalojar(navegador.contextos.find(c => c.gl === s.gl))
  asentar(3)
  assert.equal(s.state, 'live')
  assert.doesNotMatch(s.canvas.style.transform, /scale/, 'anclado a la vista que hay, sin escala')
})
