// La imagen fija de un tramo (K3): al soltar el contexto por decisión propia el tramo compone una vez más, copia esa
// imagen a un canvas 2D y la deja en el lugar del suyo mientras espera. La copia sigue al paneo corto, se va con un zoom
// o un paneo largo, y al volver el contexto tapa el canvas nuevo hasta la composición con todos los miembros armados,
// en la que se va. Una pérdida involuntaria no copia. Con un DOM mínimo, un gl falso por canvas y el compositor y la
// cola inyectados como dobles que registran (los de `gl-tramo.test.mjs`).
// Corre con: node --test test/render/tramo-imagen-fija.test.mjs
import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { GlTramo, TramoSlot } from '../../src/render/GlTramo.js'
import { frameTransform } from '../../src/render/frame.js'
import { projX0 } from '../../src/render/project.js'
import { STILL_CLASS, STILL_MAX_SHIFT } from '../../src/render/tramo-still.js'

/* ── DOM mínimo: un gl falso por canvas WebGL y un 2D que anota lo que copia ── */

const copias = []

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
  getContext(kind, attrs) {
    const canvas = this
    if (kind === '2d') return { drawImage: (fuente, x, y) => copias.push({ destino: canvas, fuente, x, y, w: fuente.width, h: fuente.height }) }
    const gl = {
      perdido              : false,
      canvas,
      getContextAttributes : () => ({ ...attrs }),
      isContextLost        : () => gl.perdido,
      viewport             : () => {},
      flush                : () => {},
      getParameter         : () => 4096,
      getExtension         : n => n === 'WEBGL_lose_context' ? { loseContext: () => { gl.perdido = true }, restoreContext: () => {} } : null,
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

const drenar = async () => {
  for (let i = 0; i < 4; i++) await null
}

/* ── Anfitrión falso: cámara con vista mutable y panes por nombre ── */

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
    fire        : (tipo, e) => [...(oyentes.get(tipo) ?? [])].forEach(fn => fn(e)),
    oyentes     : tipo => oyentes.get(tipo)?.size ?? 0,
    zoom        : () => vista.zoom,
    center      : () => vista.center,
    size        : () => vista.size,
    frameOrigin : () => ({ x: 0, y: 0 }),
    project     : (ll, z) => ({ x: ll.lng * 2 ** z, y: ll.lat * 2 ** z }),
  }
  const surface = {
    mount(nombre) {
      return (panes.get(nombre) ?? panes.set(nombre, new Nodo('div')).get(nombre))
    },
    unmount    : () => {},
    zOf        : () => null,
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
    return target
  },
  drop(target) {
    target.fbo = target.texture = null
    target.width = target.height = 0
  },
  compose(list, count) {
    log.push(['compose', list.slice(0, count).map(e => e.target)])
    return count
  },
  destroy() {},
})

// La primera tanda arma uno solo, en el acto; `tanda()` arma el siguiente.
const makeCola = () => {
  const cola = { pendientes: [], build: null, after: null }
  cola.start = (items, count, build, after) => {
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

// La capa: buildGl pinta en el acto (begin + end), como las capas GL.
const makeCapa = (nombre, { contenido = true } = {}) => {
  const capa = {
    nombre, log: [], hasContent: contenido, slot: null,
    buildGl: () => {
      capa.log.push(['buildGl'])
      capa.slot.begin()
      capa.slot.end({ zoom: 10, center: { x: 128, y: 128 }, size: { x: 800, y: 600 } })
    },
    dropGl: () => capa.log.push(['dropGl']),
  }
  return capa
}

const tramos = []
afterEach(() => {
  tramos.splice(0).forEach(t => t.destroy())
  copias.length = 0
})

// Un tramo con los miembros dados, armados y compuestos.
const montar = async (nombres = ['a', 'b'], opciones = {}) => {
  const host  = makeHost()
  const log   = []
  const cola  = makeCola()
  const tramo = new GlTramo({ host, pane: 'cristae-tramo-0', compositor: makeCompositor(log), queue: cola })
  tramos.push(tramo)
  const lista = []
  const hooks = {
    place: slot => {
      lista.push(slot)
      tramo.setMembers(lista, lista.length)
    },
    remove: slot => {
      lista.splice(lista.indexOf(slot), 1)
      tramo.setMembers(lista, lista.length)
    },
  }
  const capas = nombres.map(nombre => {
    const capa = makeCapa(nombre, opciones)
    capa.slot  = new TramoSlot({ host, pane: `capa-${nombre}`, owner: capa }, hooks)
    capa.slot.open(capa.hasContent)
    return capa
  })
  await drenar()
  const composiciones = () => log.filter(([m]) => m === 'compose')
  return { host, log, cola, tramo, capas, composiciones }
}

/* ── Desalojo ── */

test('soltar con el contexto vivo compone en el acto, copia esa imagen y la deja justo después del canvas, con su ancla', async () => {
  const { tramo, capas: [a, b], composiciones } = await montar()
  const canvas = tramo.surface.canvas
  const antes  = composiciones().length
  const targets = [a.slot.target, b.slot.target]

  tramo.surface.release()
  assert.equal(composiciones().length, antes + 1, 'una composición más, en la tarea en que suelta')
  assert.deepEqual(composiciones().at(-1)[1], targets, 'con los dos miembros: todavía tenían su textura')
  const still = tramo.still
  assert.ok(still, 'queda la imagen fija')
  assert.equal(still.className, STILL_CLASS)
  assert.equal(canvas.nextSibling, still, 'justo después del canvas del tramo')
  assert.deepEqual(copias.map(c => [c.destino, c.fuente, c.x, c.y, c.w, c.h]), [[still, canvas, 0, 0, 800, 600]], 'copia el canvas entero')
  assert.deepEqual([still.width, still.height, still.style.width, still.style.height], [800, 600, '800px', '600px'])
  assert.equal(still.style.transform, canvas.style.transform, 'anclada donde estaba el canvas')
  assert.equal(still.style.pointerEvents, 'none')
  assert.deepEqual([a, b].map(c => c.log.at(-1)), [['dropGl'], ['dropGl']], 'después los miembros sueltan lo suyo')

  await drenar()
  assert.equal(tramo.still, still, 'sigue mientras espera')
  assert.equal(tramo.surface.state, 'released')
})

/* ── Mientras espera ── */

test('un paneo corto traslada la imagen con la vista; uno de más de STILL_MAX_SHIFT de la vista la quita', async () => {
  const { host, tramo } = await montar()
  tramo.surface.release()
  const still = tramo.still

  host.vista.center = { lat: 0, lng: 0.1 }
  host.camera.fire('move')
  const dx = (projX0(0) - projX0(0.1)) * 2 ** 10
  assert.ok(Math.abs(dx) < STILL_MAX_SHIFT * 800, 'el paneo es corto')
  assert.equal(still.style.transform, frameTransform(dx, 0), 'se traslada lo que se movió la vista')
  assert.equal(tramo.still, still)

  host.vista.center = { lat: 0, lng: 0 }
  host.camera.fire('moveend')
  assert.equal(still.style.transform, frameTransform(0, 0), 'y vuelve con ella')

  host.vista.center = { lat: 0, lng: 0.5 }
  host.camera.fire('move')
  assert.ok(Math.abs((projX0(0) - projX0(0.5)) * 2 ** 10) > STILL_MAX_SHIFT * 800)
  assert.equal(tramo.still, null, 'un paneo largo la quita')
  assert.deepEqual([still.parentNode, still.width, still.height], [null, 0, 0], 'fuera del DOM y sin memoria')
  assert.deepEqual([host.camera.oyentes('move'), host.camera.oyentes('zoomstart')], [0, 0], 'y deja de oír la vista')
})

for (const [caso, cambiar] of [
  ['zoomstart', host => host.camera.fire('zoomstart')],
  ['zoomanim', host => host.camera.fire('zoomanim', { center: { lat: 0, lng: 0 }, zoom: 11 })],
  ['un move con otro zoom', host => (host.vista.zoom = 11, host.camera.fire('move'))],
  ['un cambio de tamaño', host => (host.vista.size = { x: 600, y: 600 }, host.camera.fire('resize'))],
]) {
  test(`${caso} quita la imagen: ya no corresponde`, async () => {
    const { host, tramo } = await montar()
    tramo.surface.release()
    assert.ok(tramo.still)
    cambiar(host)
    assert.equal(tramo.still, null)
  })
}

test('ocultar, atenuar o sacar un miembro quita la imagen: mostraría lo que ya no está', async () => {
  const { tramo, capas: [a, b] } = await montar()
  tramo.surface.release()
  a.slot.setVisible(false)
  assert.equal(tramo.still, null, 'ocultar')

  a.slot.setVisible(true)
  tramo.surface.acquire()
  await drenar()
  tramo.surface.release()
  assert.ok(tramo.still)
  b.slot.setOpacity(0.5)
  assert.equal(tramo.still, null, 'atenuar')

  tramo.surface.acquire()
  await drenar()
  tramo.surface.release()
  assert.ok(tramo.still)
  b.slot.destroy()
  assert.equal(tramo.still, null, 'sacar')
})

/* ── La vuelta ── */

test('al volver, el canvas nuevo queda oculto bajo la imagen y ésta se va en la tarea en que el tramo compone con todos', async () => {
  const { tramo, cola, capas: [a, b], composiciones } = await montar()
  tramo.surface.release()
  const still = tramo.still

  tramo.surface.acquire()                               // la primera tanda arma a b, el de mayor K
  const nuevo = tramo.surface.canvas
  assert.equal(nuevo.style.visibility, 'hidden', 'el canvas nuevo, oculto')
  assert.equal(nuevo.nextSibling, still, 'con la imagen encima')
  await drenar()
  assert.deepEqual(composiciones().at(-1)[1], [b.slot.target], 'compone a medias')
  assert.equal(tramo.still, still, 'y la imagen sigue: a espera su tanda')
  assert.equal(nuevo.style.visibility, 'hidden')

  cola.tanda()
  assert.equal(tramo.still, still, 'en la tarea, antes de componer, sigue')
  await drenar()                                        // sólo microtareas: la misma tarea
  assert.deepEqual(composiciones().at(-1)[1], [a.slot.target, b.slot.target], 'compone con los dos')
  assert.equal(tramo.still, null, 'y en esa composición se va la imagen')
  assert.equal(nuevo.style.visibility, '', 'y se ve el canvas')
  assert.equal(still.parentNode, null)
  assert.equal(copias.length, 1, 'volver no copia')
})

test('con un solo miembro la primera tanda lo arma: la imagen se va en la composición de esa misma tarea', async () => {
  const { tramo, capas: [a] } = await montar(['a'])
  tramo.surface.release()
  tramo.surface.acquire()
  assert.equal(a.log.at(-1)[0], 'buildGl', 'armado y pintado en el acquire')
  assert.ok(tramo.still, 'la imagen sigue hasta componer')
  assert.equal(tramo.surface.canvas.style.visibility, 'hidden')
  await drenar()
  assert.equal(tramo.still, null)
  assert.equal(tramo.surface.canvas.style.visibility, '')
})

/* ── Sin copia ── */

test('una pérdida involuntaria no copia: con el contexto se fue la imagen', async () => {
  const { tramo, composiciones } = await montar()
  const antes = composiciones().length
  tramo.gl.perdido = true
  tramo.surface.canvas.emit('webglcontextlost')
  assert.equal(tramo.still, null)
  assert.equal(copias.length, 0)
  assert.equal(composiciones().length, antes, 'ni compone sobre el perdido')

  tramo.surface.acquire()
  await drenar()
  tramo.gl.perdido = true                               // perdido sin aviso todavía, y la política lo suelta
  tramo.surface.release()
  assert.equal(tramo.still, null)
  assert.equal(copias.length, 0)
})

test('sin contenido, o en pleno zoom animado, soltar no copia', async () => {
  const vacio = await montar(['a'], { contenido: false })
  vacio.tramo.surface.acquire()
  vacio.tramo.surface.release()
  assert.equal(vacio.tramo.still, null, 'un tramo prescindible no tiene nada que mostrar')

  const { tramo } = await montar()
  tramo.renderAtView(11, { lat: 0, lng: 0 })
  tramo.surface.release()
  assert.equal(tramo.still, null, 'el zoomend la quitaría')
  assert.equal(copias.length, 0)
})

test('destroy quita la imagen', async () => {
  const { tramo, host } = await montar()
  tramo.surface.release()
  const still = tramo.still
  tramo.destroy()
  tramos.splice(tramos.indexOf(tramo), 1)
  assert.deepEqual([still.parentNode, host.camera.oyentes('move')], [null, 0])
})

test('una copia que falla no impide soltar: el contexto se suelta igual y el tramo espera sin imagen', async () => {
  const { tramo } = await montar()
  const crear = documento.createElement
  documento.createElement = tag => Object.assign(crear(tag), { getContext: () => { throw new Error('sin 2D') } })
  try {
    const gl = tramo.gl
    assert.equal(tramo.surface.release(), true)
    assert.deepEqual([tramo.surface.state, gl.perdido, tramo.still], ['released', true, null])
  } finally {
    documento.createElement = crear
  }
})

test('un resize que no cambia el tamaño de la vista la conserva', async () => {
  const { host, tramo } = await montar()
  tramo.surface.release()
  const still = tramo.still
  host.camera.fire('resize')
  assert.equal(tramo.still, still)
})
