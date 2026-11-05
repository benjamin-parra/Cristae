// El tramo: un contexto compartido por una corrida de capas GL, con retención por miembro. Cada miembro dibuja en su
// textura y el tramo compone en la microtarea; visibilidad y opacidad son de la composición; perder el contexto lo
// rehace entero en un canvas nuevo, de mayor a menor K, en tandas. Con un DOM mínimo, un gl falso por canvas, y el
// compositor y la cola inyectados como dobles que registran.
// Corre con: node --test test/render/gl-tramo.test.mjs
import { afterEach, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { GlTramo, TramoSlot } from '../../src/render/GlTramo.js'
import { glBudget } from '../../src/render/gl-budget.js'
import { projX0, projY0 } from '../../src/render/project.js'

/* ── DOM mínimo, con el gl falso de cada canvas ── */

const espia = { contextos: [], restaurados: 0 }

class Nodo {
  constructor(tag) {
    this.tagName       = tag
    this.parentNode    = null
    this.hijos         = []
    this.style         = {}
    this.className     = ''
    this.ownerDocument = documento
    this.oyentes       = {}
  }
  get firstChild()  { return this.hijos[0] ?? null }
  get nextSibling() { return this.parentNode?.hijos[this.parentNode.hijos.indexOf(this) + 1] ?? null }
  appendChild(n) {
    n.remove()
    n.parentNode = this
    this.hijos.push(n)
    return n
  }
  remove() {
    const p = this.parentNode
    if (!p) return
    p.hijos.splice(p.hijos.indexOf(this), 1)
    this.parentNode = null
  }
  after(n) {
    n.remove()
    const p = this.parentNode
    p.hijos.splice(p.hijos.indexOf(this) + 1, 0, n)
    n.parentNode = p
  }
  replaceWith(n) {
    n.remove()
    const p = this.parentNode
    p.hijos[p.hijos.indexOf(this)] = n
    n.parentNode    = p
    this.parentNode = null
  }
  addEventListener(tipo, cb) { (this.oyentes[tipo] ??= []).push(cb) }
  emit(tipo) { this.oyentes[tipo]?.forEach(cb => cb(new Event(tipo, { cancelable: true }))) }
  getContext(_kind, attrs) {
    const canvas = this
    const gl = {
      perdido              : false,
      canvas,
      getContextAttributes : () => ({ ...attrs }),
      isContextLost        : () => gl.perdido,
      viewport             : () => {},
      flush                : () => {},
      getParameter         : () => 4096,
      getExtension         : n => n === 'WEBGL_lose_context'
        ? { loseContext: () => { gl.perdido = true }, restoreContext: () => { espia.restaurados++ } }
        : null,
      get drawingBufferWidth()  { return canvas.width },
      get drawingBufferHeight() { return canvas.height },
    }
    espia.contextos.push(gl)
    return gl
  }
}

const documento = { defaultView: {}, createElement: tag => new Nodo(tag) }
globalThis.document = documento

// La política agenda cuadros al perder un contexto: acá no corren, el test llama a `acquire` como lo haría ella.
globalThis.requestAnimationFrame ??= () => 1
globalThis.cancelAnimationFrame  ??= () => {}

const drenar = async () => {
  for (let i = 0; i < 4; i++) await null
}

/* ── Anfitrión falso: cámara con vista mutable y panes por nombre con conteo de montajes ── */

const makeHost = () => {
  const oyentes = new Map()
  const panes   = new Map()
  const vista   = { zoom: 10, center: { lat: 0, lng: 0 }, size: { x: 800, y: 600 } }
  const camera  = {
    on(nombres, fn) {
      const tipos = nombres.split(' ')
      tipos.forEach(t => (oyentes.get(t) ?? oyentes.set(t, new Set()).get(t)).add(fn))
      return () => tipos.forEach(t => oyentes.get(t).delete(fn))
    },
    fire        : (tipo, e) => oyentes.get(tipo)?.forEach(fn => fn(e)),
    oyentes     : tipo => oyentes.get(tipo)?.size ?? 0,
    zoom        : () => vista.zoom,
    center      : () => vista.center,
    size        : () => vista.size,
    frameOrigin : () => ({ x: 0, y: 0 }),
    project     : (ll, z) => ({ x: ll.lng * 2 ** z, y: ll.lat * 2 ** z }),
  }
  const surface = {
    mount(nombre) {
      const p = panes.get(nombre) ?? panes.set(nombre, { nodo: new Nodo('div'), montajes: 0, z: null }).get(nombre)
      p.montajes++
      return p.nodo
    },
    unmount    : nombre => { panes.get(nombre).montajes-- },
    zOf        : nombre => panes.get(nombre)?.z ?? null,
    followZoom : () => {},
  }
  return { camera, surface, vista, pane: nombre => panes.get(nombre) }
}

/* ── Dobles del compositor y de la cola ── */

const makeCompositor = log => gl => ({
  gl,
  bind(target, w, h) {
    target.fbo   ??= {}
    target.width   = w
    target.height  = h
    log.push(['bind', target])
    return target
  },
  drop(target) {
    log.push(['drop', target])
    target.fbo = target.texture = null
    target.width = target.height = 0
  },
  compose(list, count, now, dpr) {
    const entradas = []
    for (let i = 0; i < count; i++) entradas.push({ target: list[i].target, opacity: list[i].opacity })
    log.push(['compose', entradas, { zoom: now.zoom, x: now.center.x, y: now.center.y }, dpr])
    return count
  },
  destroy() {},
})

// La primera tanda arma uno solo, en el acto; `tanda()` arma el siguiente. `after` tras cada tanda.
const makeCola = () => {
  const cola = { starts: [], pendientes: [], build: null, after: null }
  cola.start = (items, count, build, after) => {
    cola.starts.push(items.slice(0, count))
    cola.pendientes = items.slice(0, count)
    cola.build = build
    cola.after = after
    count && cola.tanda()
  }
  cola.tanda  = () => {
    cola.pendientes.length && cola.build(cola.pendientes.shift())
    cola.after()
  }
  cola.cancel = () => { cola.pendientes = [] }
  return cola
}

/* ── Capas falsas y un gestor mínimo: un solo tramo, miembros en orden de alta ── */

// La capa: anota buildGl/dropGl/dibujos; buildGl pinta en el acto (begin + end), como las capas GL.
const makeCapa = (nombre, { contenido = true } = {}) => {
  const capa = {
    nombre, log: [], hasContent: contenido, slot: null,
    buildGl: gl => {
      capa.log.push(['buildGl', gl])
      capa.dibujar()
    },
    dropGl  : () => capa.log.push(['dropGl']),
    dibujar : (vista = { zoom: 10, center: { x: 128, y: 128 }, size: { x: 800, y: 600 } }) => {
      capa.log.push(['dibujo'])
      capa.slot.begin()
      capa.slot.end(vista)
    },
  }
  return capa
}

const tramos = []
afterEach(() => {
  tramos.splice(0).forEach(t => t.destroy())
  mock.restoreAll()
})

const montar = ({ solo = false } = {}) => {
  const host   = makeHost()
  const log    = []
  const cola   = makeCola()
  const avisos = []
  const tramo  = new GlTramo({
    host, pane: solo ? 'capa-0' : 'cristae-tramo-0', solo, compositor: makeCompositor(log), queue: cola,
    onForeign: nodo => avisos.push(nodo),
  })
  tramos.push(tramo)
  const lista    = []
  const quitados = []
  const hooks = {
    place: slot => {
      lista.push(slot)
      tramo.setMembers(lista, lista.length)
    },
    remove: slot => {
      quitados.push(slot)
      lista.splice(lista.indexOf(slot), 1)
      tramo.setMembers(lista, lista.length)
    },
  }
  // Un miembro nuevo, en su pane: K crece con el orden de alta.
  const miembro = (nombre, opciones) => {
    const capa = makeCapa(nombre, opciones)
    capa.slot  = new TramoSlot({ host, pane: solo ? 'capa-0' : `capa-${nombre}`, owner: capa, cssZoom: opciones?.cssZoom }, hooks)
    return capa
  }
  const composiciones = () => log.filter(([m]) => m === 'compose')
  return { host, log, cola, tramo, miembro, composiciones, avisos, quitados }
}

const dibujos = capa => capa.log.filter(([m]) => m === 'dibujo' || m === 'buildGl').length

/* ── T1 retención ── */

test('T1 retención: A pinta y se compone una vez en la microtarea; B no recibe dibujo ni buildGl', async () => {
  const { tramo, miembro, composiciones, log } = montar()
  const a = miembro('a')
  const b = miembro('b')
  const gl = a.slot.open(true)
  b.slot.open(true)
  assert.ok(gl, 'con contenido el miembro queda armado y recibe el contexto del tramo')
  assert.equal(b.slot.gl, gl, 'un contexto para los dos')
  await drenar()
  log.length = 0
  const antesB = dibujos(b)

  a.dibujar()
  a.dibujar()
  assert.equal(composiciones().length, 0, 'componer se difiere a la microtarea')
  await drenar()

  const [compose, ...resto] = composiciones()
  assert.equal(resto.length, 0, 'dos dibujos en una tarea: una composición')
  assert.deepEqual(compose[1].map(e => e.target), [a.slot.target, b.slot.target], 'en orden K, B con su textura de antes')
  assert.equal(dibujos(b), antesB, 'B no se redibuja')
  assert.equal(log.filter(([m, t]) => m === 'bind' && t === b.slot.target).length, 0, 'ni se enlaza su FBO')
  assert.equal(tramo.members.length, 2)
})

/* ── T2 visibilidad y opacidad ── */

test('T2 setVisible y setOpacity: repetidos no componen; un cambio compone una vez sin dibujar a nadie', async () => {
  const { miembro, composiciones, log } = montar()
  const a = miembro('a')
  const b = miembro('b')
  a.slot.open(true)
  b.slot.open(true)
  await drenar()
  log.length = 0
  const antes = dibujos(a) + dibujos(b)

  assert.equal(a.slot.setVisible(true), false, 'el mismo valor no hace nada')
  assert.equal(a.slot.setOpacity(1), false)
  await drenar()
  assert.equal(composiciones().length, 0, 'repetir no compone')

  assert.equal(a.slot.setVisible(false), true)
  await drenar()
  assert.equal(composiciones().length, 1, 'un cambio compone una vez')
  assert.deepEqual(composiciones()[0][1].map(e => e.target), [b.slot.target], 'el oculto sale de la lista')

  b.slot.setOpacity(0.5)
  b.slot.setOpacity(0.5)
  await drenar()
  assert.equal(composiciones().length, 2)
  assert.deepEqual(composiciones()[1][1], [{ target: b.slot.target, opacity: 0.5 }], 'con su opacidad')

  b.slot.setOpacity(0)
  await drenar()
  assert.deepEqual(composiciones()[2][1], [], 'opacidad 0 no se compone')
  assert.equal(dibujos(a) + dibujos(b), antes, 'ningún miembro dibujó')
})

test('T2 el tramo solo compone con opacidad 1: la pone el CSS del pane', async () => {
  const { miembro, composiciones, log, host, tramo } = montar({ solo: true })
  const a = miembro('a')
  a.slot.open(true)
  await drenar()
  log.length = 0
  a.slot.setOpacity(0.3)
  await drenar()
  assert.deepEqual(composiciones()[0][1], [{ target: a.slot.target, opacity: 1 }])
  const hijos = host.pane('capa-0').nodo.hijos
  assert.deepEqual(hijos, [a.slot.marker, tramo.surface.canvas], 'el canvas del tramo va justo después del marcador')
})

/* ── T3 pérdida y recuperación ── */

test('T3 pérdida: dropGl de los armados, canvas nuevo sin restoreContext, mayor K primero y composición tras cada tanda', async () => {
  const { tramo, miembro, composiciones, log, cola } = montar()
  const a = miembro('a')
  const b = miembro('b')
  const c = miembro('c', { contenido: false })
  a.slot.open(true)
  b.slot.open(true)
  c.slot.open(false)
  await drenar()
  const viejo       = tramo.surface.canvas
  const pane        = viejo.parentNode
  const contextos   = espia.contextos.length
  const restaurados = espia.restaurados

  tramo.gl.perdido = true
  viejo.emit('webglcontextlost')
  assert.deepEqual([a, b].map(x => x.log.at(-1)), [['dropGl'], ['dropGl']], 'los armados olvidan su parte GL')
  assert.equal(c.log.length, 0, 'el vacío no estaba armado')
  assert.deepEqual([a.slot.target.fbo, a.slot.target.width, b.slot.target.fbo], [null, 0, null], 'texturas a cero sin borrarlas')
  assert.equal(log.filter(([m]) => m === 'drop').length, 0, 'sin drop: el contexto perdido ya no tiene nada')
  assert.notEqual(a.slot.state, 'live')

  await drenar()
  log.length = 0
  const gl = tramo.surface.acquire()
  assert.equal(espia.contextos.length, contextos + 1, 'un contexto nuevo')
  assert.notEqual(tramo.surface.canvas, viejo, 'en un canvas nuevo')
  assert.equal(tramo.surface.canvas.parentNode, pane, 'en el lugar del viejo')
  assert.equal(espia.restaurados, restaurados, 'sin restoreContext')
  assert.deepEqual(cola.starts.at(-1), [b.slot, a.slot], 'los wanted de mayor a menor K; el vacío no')
  assert.equal(b.log.at(-2)[1], gl, 'la primera tanda arma a B, en el acto')
  assert.equal(a.slot.state, 'lost', 'A espera su tanda')

  await drenar()
  assert.deepEqual(composiciones().map(([, e]) => e.map(x => x.target)), [[b.slot.target]], 'se compone tras la primera tanda')
  cola.tanda()
  assert.equal(a.slot.state, 'live')
  await drenar()
  assert.deepEqual(composiciones().at(-1)[1].map(x => x.target), [a.slot.target, b.slot.target], 'y tras la segunda, en orden K')
  assert.equal(c.log.length, 0, 'el vacío sigue sin armarse')
})

/* ── T4 TramoSlot ── */

test('T4 TramoSlot: open, need, acquire, state por miembro, onState a cada uno, sin registro y destroy', async () => {
  const registrados = []
  const original    = glBudget.register
  mock.method(glBudget, 'register', s => {
    registrados.push(s)
    return original(s)
  })
  const { host, tramo, miembro, quitados } = montar()
  const a = miembro('a')
  const gl = a.slot.open(true)
  assert.equal(a.slot.state, 'live')

  const x = miembro('x')
  assert.equal(x.slot.open(true), gl, 'con el tramo vivo open(true) arma y devuelve gl')
  assert.equal(x.log[0][0], 'buildGl')

  const y = miembro('y', { contenido: false })
  assert.equal(y.slot.open(false), null, 'open(false) no arma')
  assert.deepEqual([y.log.length, y.slot.state, y.slot.gl], [0, 'none', null])
  assert.equal(y.slot.need(), false, 'need() sin contenido (se volvió a ver) no lo arma')
  y.hasContent = true
  assert.equal(y.slot.need(), true, 'need() con contenido lo arma')
  assert.deepEqual([y.log[0][0], y.slot.state, y.slot.gl], ['buildGl', 'live', gl])
  assert.equal(y.slot.need(), false, 'ya armado no vuelve a armar')

  const z = miembro('z')
  assert.equal(z.slot.acquire(), gl, 'acquire síncrono')
  assert.equal(z.log[0][0], 'buildGl')

  // La forma de EditSurface que ven las capas y el motor.
  assert.equal(z.slot.canvas, z.slot.marker)
  assert.equal(z.slot.canvas.className, 'cristae-edit-canvas')
  assert.deepEqual([z.slot.attached, z.slot.contextLost, z.slot.cssZoom, z.slot.z, z.slot.needed], [true, false, true, 0, true])
  assert.equal(z.slot.release(), true)
  assert.deepEqual([z.slot.state, z.slot.gl, z.log.at(-1)], ['released', null, ['dropGl']], 'state por miembro')
  assert.equal(z.slot.release(), false)

  const avisos = []
  ;[a, x, y].forEach(c => { c.slot.onState = s => avisos.push(s) })
  tramo.surface.release()
  assert.deepEqual(avisos, [a.slot, x.slot, y.slot], 'onState llega a cada miembro')
  assert.deepEqual([a, x, y].map(c => c.slot.state), ['released', 'released', 'released'])

  assert.deepEqual(registrados, [tramo.surface], 'gl-budget registra la superficie del tramo y ningún slot')
  const otro = montar()
  otro.miembro('w').slot.open(true)
  assert.deepEqual(registrados, [tramo.surface, otro.tramo.surface], 'un tramo nuevo, una superficie más')

  const marcador = x.slot.marker
  const pane     = host.pane('capa-x')
  x.slot.destroy()
  assert.equal(marcador.parentNode, null, 'destroy saca el marcador')
  assert.equal(pane.montajes, 0, 'y desmonta su pane')
  assert.deepEqual(quitados, [x.slot], 'y avisa al gestor')
  assert.equal(x.slot.tramo, null, 'que lo saca del tramo')
  assert.equal(x.slot.canvas, null)
})

/* ── T5 reasentar y vista inyectada ── */

test('T5 componer reasienta el canvas; renderAtView inyecta la vista hasta zoomend o el sync de unos puntos', async () => {
  const { host, tramo, miembro, composiciones, log } = montar()
  const a = miembro('a', { cssZoom: false })
  const l = miembro('l')
  a.slot.open(true)
  l.slot.open(true)
  await drenar()
  log.length = 0

  host.vista.size = { x: 400, y: 300 }
  tramo.touch()
  await drenar()
  assert.deepEqual([tramo.surface.canvas.width, tramo.surface.canvas.height], [400, 300], 'componer reasienta')
  assert.equal(composiciones().at(-1)[2].zoom, 10, 'con la vista viva')

  tramo.renderAtView(12, { lat: 10, lng: 20 })
  await drenar()
  assert.deepEqual(composiciones().at(-1)[2], { zoom: 12, x: projX0(20), y: projY0(10) }, 'la vista inyectada')
  tramo.touch()
  await drenar()
  assert.equal(composiciones().at(-1)[2].zoom, 12, 'sigue inyectada')
  host.camera.fire('zoomend')
  await drenar()
  assert.equal(composiciones().at(-1)[2].zoom, 10, 'zoomend la suelta')

  tramo.renderAtView(13, { lat: 0, lng: 0 })
  l.slot.resetCanvasReference()
  l.dibujar()
  await drenar()
  assert.equal(composiciones().at(-1)[2].zoom, 13, 'una línea que redibuja en pleno zoom no la suelta')
  a.slot.resetCanvasReference()
  await drenar()
  assert.equal(composiciones().at(-1)[2].zoom, 10, 'el sync de unos puntos sí')
  assert.equal(composiciones().length, 6, 'una composición por tarea')
})

test('T5 un miembro oculto que reasienta no compone; varios que reasienten en una tarea, una composición sin reanclar de nuevo', async () => {
  const { tramo, miembro, composiciones } = montar()
  const a = miembro('a', { cssZoom: false })
  const b = miembro('b', { cssZoom: false })
  a.slot.open(true)
  b.slot.open(true)
  await drenar()
  const veces = composiciones().length

  a.slot.setVisible(false)
  await drenar()
  assert.equal(composiciones().length, veces + 1, 'ocultar compone una vez')
  for (let i = 0; i < 5; i++) {
    a.slot.resetCanvasReference()
    await drenar()
  }
  assert.equal(composiciones().length, veces + 1, 'el oculto que reasienta en cada move no hace componer a su tramo')

  const reset = mock.method(tramo.surface, 'resetCanvasReference')
  a.slot.setVisible(true)
  a.slot.resetCanvasReference()
  b.slot.resetCanvasReference()
  await drenar()
  assert.equal(composiciones().length, veces + 2, 'una composición')
  assert.equal(reset.mock.callCount(), 2, 'un reasiento por miembro que reasienta, ninguno al componer')
})

/* ── T6 pane vigilado ── */

test('T6 un pane vigilado que recibe un hijo avisa onForeign una sola vez', async () => {
  const { tramo, miembro, avisos } = montar()
  miembro('a').slot.open(true)
  const vacio = new Nodo('div')
  tramo.watch([vacio], 1)
  tramo.touch()
  await drenar()
  assert.equal(avisos.length, 0, 'vacío no avisa')

  vacio.appendChild(new Nodo('svg'))
  tramo.touch()
  await drenar()
  tramo.touch()
  await drenar()
  assert.deepEqual(avisos, [vacio], 'con hijos avisa una vez')
})
