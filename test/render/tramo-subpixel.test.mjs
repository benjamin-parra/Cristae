// Subpíxel tras recuperar (`PLAN-C-MINIMO.md` §11): ¿con DPR 2 y un origen fraccional, la composición de un miembro que no
// redibuja queda a 1 px de dispositivo o más de donde lo deja su redibujo tras perder y recuperar el contexto?
// Tramo real, cámara con la aritmética de Leaflet (origen de píxeles entero, pane del mapa en posición fraccional, centro
// exacto hasta el primer movimiento y derivado del origen después) y un compositor doble que anota lo que compondría el real.
// La posición en pantalla se calcula con el `viewTransform` real y la regla de muestreo del fragment shader.
// Corre con: node --test test/render/tramo-subpixel.test.mjs
import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { GlTramo, TramoSlot } from '../../src/render/GlTramo.js'
import { viewTransform } from '../../src/render/gl-compositor.js'
import { readView } from '../../src/render/project.js'

const DPR = 2
// El redondeo del desplazamiento entero de la composición: medio px de dispositivo, más el ruido de coma flotante.
const MEDIO_PX = 0.5 + 1e-9

/* ── DOM mínimo, con un gl falso por canvas ── */

class Nodo {
  constructor(tag) {
    this.tagName = tag
    this.parentNode = null
    this.hijos = []
    this.style = {}
    this.ownerDocument = documento
    this.oyentes = {}
  }
  get firstChild()  { return this.hijos[0] ?? null }
  get nextSibling() { return this.parentNode?.hijos[this.parentNode.hijos.indexOf(this) + 1] ?? null }
  appendChild(n) { n.remove(); n.parentNode = this; this.hijos.push(n); return n }
  remove() {
    const p = this.parentNode
    if (!p) return
    p.hijos.splice(p.hijos.indexOf(this), 1)
    this.parentNode = null
  }
  after(n) { n.remove(); const p = this.parentNode; p.hijos.splice(p.hijos.indexOf(this) + 1, 0, n); n.parentNode = p }
  replaceWith(n) { n.remove(); const p = this.parentNode; p.hijos[p.hijos.indexOf(this)] = n; n.parentNode = p; this.parentNode = null }
  addEventListener(tipo, cb) { (this.oyentes[tipo] ??= []).push(cb) }
  emit(tipo) { this.oyentes[tipo]?.forEach(cb => cb(new Event(tipo))) }
  getContext(_kind, attrs) {
    const canvas = this
    const gl = {
      perdido: false, canvas,
      getContextAttributes : () => ({ ...attrs }),
      isContextLost        : () => gl.perdido,
      viewport             : () => {},
      flush                : () => {},
      getParameter         : () => 4096,
      getExtension         : n => n === 'WEBGL_lose_context' ? { loseContext: () => { gl.perdido = true }, restoreContext() {} } : null,
      get drawingBufferWidth()  { return canvas.width },
      get drawingBufferHeight() { return canvas.height },
    }
    return gl
  }
}
const documento = { defaultView: {}, createElement: tag => new Nodo(tag) }
globalThis.document = documento
globalThis.requestAnimationFrame ??= () => 1
globalThis.cancelAnimationFrame  ??= () => {}

const drenar = async () => { for (let i = 0; i < 4; i++) await null }

/* ── Cámara con la aritmética de Leaflet, en px world0 ── */

const D = Math.PI / 180
const lngDe = x => (x / 256 - 0.5) * 360
const latDe = y => (2 * Math.atan(Math.exp((0.5 - y / 256) * 2 * Math.PI)) - Math.PI / 2) / D

// `setView` fija el centro exacto y el origen de píxeles entero (`_getNewPixelOrigin(...).round()`); `pane` mueve el
// pane del mapa (un arrastre, posiblemente fraccional) y `invalidar` suelta el centro exacto, como `invalidateSize`.
// Después de cualquiera de los dos, el centro sale del origen: (origen + frameOrigin + tamaño/2) / 2^zoom.
const makeHost = () => {
  const oyentes = new Map()
  const panes   = new Map()
  const v = { zoom: 11, size: { x: 801, y: 601 }, po: { x: 0, y: 0 }, mapa: { x: 0, y: 0 }, exacto: null }
  const k = () => 2 ** v.zoom
  const camera = {
    on(nombres, fn) {
      const tipos = nombres.split(' ')
      tipos.forEach(t => (oyentes.get(t) ?? oyentes.set(t, new Set()).get(t)).add(fn))
      return () => tipos.forEach(t => oyentes.get(t).delete(fn))
    },
    zoom        : () => v.zoom,
    size        : () => v.size,
    frameOrigin : () => ({ x: -v.mapa.x, y: -v.mapa.y }),
    center() {
      const c = v.exacto ?? { x: (v.po.x - v.mapa.x + v.size.x / 2) / k(), y: (v.po.y - v.mapa.y + v.size.y / 2) / k() }
      return { lng: lngDe(c.x), lat: latDe(c.y) }
    },
    project     : (ll, z) => ({ x: ll.lng * 2 ** z, y: ll.lat * 2 ** z }),
  }
  const surface = {
    mount(nombre) { return (panes.get(nombre) ?? panes.set(nombre, new Nodo('div')).get(nombre)) },
    unmount() {}, zOf: () => null, followZoom: () => {},
  }
  const setView = c => {
    v.exacto = c
    v.mapa   = { x: 0, y: 0 }
    v.po     = { x: Math.round(c.x * k() - v.size.x / 2), y: Math.round(c.y * k() - v.size.y / 2) }
  }
  const pane     = (x, y) => { v.mapa = { x, y }; v.exacto = null }
  const invalidar = () => { v.exacto = null }
  // Dónde cae, en px de dispositivo del contenedor, un punto world0: lo que hacen los tiles y los marcadores.
  const verdad = w => ({ x: DPR * (w.x * k() - v.po.x + v.mapa.x), y: DPR * (w.y * k() - v.po.y + v.mapa.y) })
  return { camera, surface, v, setView, pane, invalidar, verdad }
}

/* ── Compositor doble: anota la vista viva y la pintada de cada entrada ── */

const copia = view => ({ zoom: view.zoom, center: { ...view.center }, size: { ...view.size } })
const makeCompositor = log => () => ({
  bind(target, w, h) { target.fbo ??= {}; target.texture ??= {}; target.width = w; target.height = h; return target },
  drop(target) { target.fbo = target.texture = null; target.width = target.height = 0 },
  compose(list, count, now, dpr) {
    const entradas = []
    for (let i = 0; i < count; i++) entradas.push({ target: list[i].target, painted: copia(list[i].painted), h: list[i].target.height })
    log.push({ now: copia(now), dpr, entradas })
    return count
  },
  destroy() {},
})

const makeCola = () => {
  const cola = { pendientes: [] }
  cola.start = (items, count, build, after) => {
    cola.pendientes = items.slice(0, count)
    while (cola.pendientes.length) build(cola.pendientes.shift())
    after()
  }
  cola.cancel = () => { cola.pendientes = [] }
  return cola
}

/* ── Una capa que pinta con la vista viva y recuerda dónde dejó su punto y con qué ancla ── */

const W = { x: 140.3713, y: 101.2291 }   // un vértice de la capa, en px world0

const makeCapa = (host, hooks, pane) => {
  const capa = { hasContent: true, view: { zoom: 0, center: { x: 0, y: 0 }, size: { x: 0, y: 0 } } }
  capa.dibujar = () => {
    const view = readView(host.camera, capa.view)
    capa.pintado = { x: DPR * ((W.x - view.center.x) * 2 ** view.zoom + view.size.x / 2),
                     y: DPR * ((W.y - view.center.y) * 2 ** view.zoom + view.size.y / 2) }
    capa.ancla   = host.camera.frameOrigin()
    capa.slot.begin()
    capa.slot.end(view)
  }
  capa.buildGl = () => capa.dibujar()
  capa.dropGl  = () => {}
  capa.slot    = new TramoSlot({ host, pane, owner: capa, cssZoom: pane === 'puntos' ? false : true }, hooks)
  return capa
}

// Dónde queda el vértice en pantalla tras componer, en px de dispositivo: el fragment shader lee el texel
// floor((gl_FragCoord − tr) / s) del framebuffer (origen abajo-izquierda); con s = 1 el texel t sale en la fila
// t + ceil(tr − ½). En y se pasa a filas del framebuffer y se vuelve.
const compuesto = (capa, registro, H) => {
  const e  = registro.entradas.find(x => x.target === capa.slot.target)
  const tr = viewTransform(e.painted, registro.now, registro.dpr, new Float64Array(3))
  assert.equal(tr[0], 1, 'sin zoom de por medio')
  const trY = H - tr[0] * e.h - tr[2]
  return { x: capa.pintado.x + Math.ceil(tr[1] - 0.5), y: H - ((H - capa.pintado.y) + Math.ceil(trY - 0.5)) }
}

const tramos = []
afterEach(() => tramos.splice(0).forEach(t => t.destroy()))

const montar = () => {
  globalThis.devicePixelRatio = DPR
  const host  = makeHost()
  const log   = []
  const tramo = new GlTramo({ host, pane: 'cristae-tramo-0', compositor: makeCompositor(log), queue: makeCola() })
  tramos.push(tramo)
  const lista = []
  const hooks = {
    place : slot => { lista.push(slot); tramo.setMembers(lista, lista.length) },
    remove: slot => { lista.splice(lista.indexOf(slot), 1); tramo.setMembers(lista, lista.length) },
  }
  return { host, log, tramo, hooks }
}

// Un caso: la línea pinta con la vista inicial, el mapa cambia (`cambio`), los puntos se reasientan y componen, y la línea
// queda desplazada sin redibujar. Después se pierde el contexto y se recupera: la línea redibuja con la vista viva.
// Devuelve, en px de dispositivo, el error contra la verdad antes y después, el salto, y el salto que daría trasladar por
// la diferencia de anclas.
const caso = async (fraccion, cambio) => {
  const { host, log, tramo, hooks } = montar()
  host.setView({ x: (Math.floor(W.x * 2 ** 11) + 400.5 + fraccion.x) / 2 ** 11, y: (Math.floor(W.y * 2 ** 11) + 300.5 + fraccion.y) / 2 ** 11 })
  const linea  = makeCapa(host, hooks, 'linea')
  const puntos = makeCapa(host, hooks, 'puntos')
  linea.slot.open(true)
  puntos.slot.open(true)
  await drenar()

  cambio(host)
  puntos.slot.resetCanvasReference()
  puntos.dibujar()
  await drenar()
  const H      = tramo.surface.canvas.height
  const ancla  = tramo.surface.canvas.style.transform
  const antes  = compuesto(linea, log.at(-1), H)
  const real   = host.verdad(W)
  const anclaN = host.camera.frameOrigin()
  const porAncla = { x: linea.pintado.x + Math.round(DPR * (linea.ancla.x - anclaN.x)), y: linea.pintado.y + Math.round(DPR * (linea.ancla.y - anclaN.y)) }

  const viejo = tramo.surface.canvas
  tramo.gl.perdido = true
  viejo.emit('webglcontextlost')
  await drenar()
  tramo.surface.acquire()
  await drenar()
  const despues = compuesto(linea, log.at(-1), H)
  assert.equal(tramo.surface.canvas.style.transform, ancla, 'el canvas nuevo queda en el mismo ancla')

  const d = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y))
  return { error: d(antes, real), errorTras: d(despues, real), salto: d(despues, antes), saltoPorAncla: d(despues, porAncla) }
}

const barrido = async cambio => {
  const peor = { error: 0, errorTras: 0, salto: 0, saltoPorAncla: 0 }
  for (let i = 0; i < 10; i++) {
    const r = await caso({ x: i / 10 + 0.013, y: (9 - i) / 10 + 0.027 }, cambio(i))
    for (const k in peor) peor[k] = Math.max(peor[k], r[k])
  }
  return peor
}

test('centro exacto que pasa a derivado (invalidateSize) sin paneo: el salto tras recuperar es < 1 px de dispositivo', async () => {
  const peor = await barrido(() => host => host.invalidar())
  assert.ok(peor.errorTras < 1e-6, 'recuperada: la línea cae donde los tiles')
  assert.ok(peor.salto <= MEDIO_PX, `antes de perder, a ≤ ½ px de dispositivo de la verdad: ${peor.salto}`)
  assert.ok(peor.saltoPorAncla > MEDIO_PX, `trasladar por la diferencia de anclas la dejaría donde pintó: ${peor.saltoPorAncla}`)
})

test('arrastre a un origen fraccional: el salto tras recuperar es < 1 px de dispositivo', async () => {
  const peor = await barrido(i => host => host.pane(-37.3 - i * 0.071, 12.6 + i * 0.113))
  assert.ok(peor.errorTras < 1e-6, 'recuperada: la línea cae donde los tiles')
  assert.ok(peor.salto <= MEDIO_PX, `antes de perder, a ≤ ½ px de dispositivo de la verdad: ${peor.salto}`)
})
