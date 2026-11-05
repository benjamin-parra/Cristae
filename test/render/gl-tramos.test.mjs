// Gestor de tramos (G1–G6 de PLAN-C-MINIMO §7): reparto de altas en corridas, lugar del pane del tramo, recambio,
// partir y separador pegajoso. Con un Tramo y un slot falsos que registran lo que el gestor les pide, y un DOM mínimo
// de panes: la composición, los contextos y la recuperación son de GlTramo y del motor.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTramos } from '../../src/render/gl-tramos.js'

// ── DOM mínimo: lo que el gestor toca de los panes (children, after, nextSibling, estilo inline y computado) ──
const vista = { getComputedStyle: node => ({ zIndex: node.cssZ ?? 'auto' }) }
const documento = { defaultView: vista }

class Nodo {
  constructor(tag, nombre = '') {
    this.tag           = tag
    this.nombre        = nombre
    this.children      = []
    this.parentNode    = null
    this.style         = {}
    this.ownerDocument = documento
  }
  get nextSibling() {
    const hermanos = this.parentNode?.children
    return hermanos?.[hermanos.indexOf(this) + 1] ?? null
  }
  appendChild(node) {
    node.remove()
    node.parentNode = this
    this.children.push(node)
    return node
  }
  after(node) {
    node.remove()
    node.parentNode = this.parentNode
    this.parentNode.children.splice(this.parentNode.children.indexOf(this) + 1, 0, node)
  }
  remove() {
    const hermanos = this.parentNode?.children
    hermanos && hermanos.splice(hermanos.indexOf(this), 1)
    this.parentNode = null
  }
}

// ── Anfitrión: `host.surface` como el de LeafletHost (mount crea al final de la raíz; z inline) ──
const anfitrion = () => {
  const raiz  = new Nodo('div', 'mapPane')
  const panes = new Map()
  const log   = []
  const surface = {
    mount(name, z, { pointer } = {}) {
      const node = panes.get(name) ?? raiz.appendChild(new Nodo('div', name))
      panes.set(name, node)
      z != null && (node.style.zIndex = String(z))
      log.push(['mount', name, z, pointer])
      return node
    },
    unmount(name) {
      log.push(['unmount', name])
      panes.get(name)?.remove()
      panes.delete(name)
    },
    setZ(name, z) {
      log.push(['setZ', name, z])
      panes.get(name).style.zIndex = String(z)
    },
  }
  // Un pane nativo de Leaflet: sin z inline, la toma de la hoja de estilo.
  const nativo = (name, z) => {
    const node = raiz.appendChild(new Nodo('div', name))
    node.cssZ = String(z)
    panes.set(name, node)
    return node
  }
  return { host: { surface }, raiz, panes, log, nativo, pane: (name, z) => surface.mount(name, z) }
}

// ── Tramo falso: registra lo que pide el gestor y escribe slot.tramo como GlTramo ──
const crearFalsos = () => {
  const hechos = []
  const orden  = []                // setMembers de todos los tramos, en orden de llamada
  class Tramo {
    constructor({ pane, solo, onForeign }) {
      Object.assign(this, { pane, solo, onForeign })
      this.members   = []
      this.vigilados = []
      this.touches   = 0
      this.vistas    = []
      this.destruido = false
      this.surface   = { canvas: solo ? new Nodo('canvas', 'tramo') : null }
      hechos.push(this)
    }
    setMembers(list, count) {
      const nuevos = list.slice(0, count)
      this.members.forEach(slot => nuevos.includes(slot) || slot.tramo !== this || (slot.tramo = null))
      nuevos.forEach(slot => slot.tramo = this)
      this.members = nuevos
      orden.push([this, nuevos.map(slot => slot.nombre)])
    }
    watch(nodes, count) { this.vigilados = nodes.slice(0, count) }
    touch() { this.touches++ }
    renderAtView(zoom, center) { this.vistas.push([zoom, center]) }
    destroy() { this.destruido = true }
  }
  return { Tramo, hechos, orden }
}

// Slot falso: deja su marcador al final del pane al abrir y avisa; al destruir avisa y saca el marcador.
const crearSlot = (ctx, gestor) => (nombre, pane, extra = {}) => {
  const slot = gestor.surface({ host: ctx.host, pane, ...extra })
  slot.nombre = nombre
  return slot
}
class Slot {
  constructor(opts, hooks) {
    this.opts   = opts
    this.hooks  = hooks
    this.pane   = opts.pane
    this.marker = new Nodo('canvas', 'marcador')
    this.tramo  = null
  }
  open() {
    this.opts.host.surface.mount(this.pane).appendChild(this.marker)
    this.hooks.place(this)
    return this
  }
  destroy() {
    this.hooks.remove(this)
    this.marker.remove()
  }
}

const montar = () => {
  const ctx    = anfitrion()
  const falsos = crearFalsos()
  const gestor = createTramos({ host: ctx.host, Tramo: falsos.Tramo, Slot })
  return { ...ctx, ...falsos, gestor, slot: crearSlot(ctx, gestor) }
}
const nombres = tramo => tramo.members.map(slot => slot.nombre)
const microtarea = () => new Promise(resolve => queueMicrotask(resolve))

test('G1: una ráfaga de altas contiguas toma un tramo; nativo vacío no separa y con hijos sí', () => {
  const { gestor, slot, pane, nativo, hechos } = montar()
  nativo('tilePane', 200).appendChild(new Nodo('img'))
  pane('a', 400)
  const vacio = nativo('markerPane', 405)
  pane('b', 410)
  const lleno = nativo('shadowPane', 415)
  pane('c', 420)
  pane('d', 430)

  const a = slot('a', 'a').open()
  const b = slot('b', 'b').open()
  assert.equal(hechos.length, 1, 'el segundo entra al tramo vivo del primero')
  assert.equal(b.tramo, a.tramo)
  assert.deepEqual(nombres(a.tramo), ['a', 'b'])
  assert.deepEqual(a.tramo.vigilados, [vacio], 'el nativo vacío del rango queda vigilado')

  lleno.appendChild(new Nodo('canvas'))
  const c = slot('c', 'c').open()
  const d = slot('d', 'd').open()
  assert.equal(hechos.length, 2)
  assert.equal(c.tramo, d.tramo)
  assert.notEqual(c.tramo, a.tramo, 'el nativo con hijos separa')
  assert.equal(gestor.size, 2)
})

test('G1: un separador declarado vacío separa; un pane mixto deja a su miembro solo', () => {
  const { gestor, slot, pane, hechos, panes } = montar()
  pane('a', 400)
  const etiquetas = pane('etiquetas', 405)
  pane('b', 410)
  const mixto = pane('m', 420)
  mixto.appendChild(new Nodo('div', 'ajeno'))
  pane('c', 430)

  gestor.separator(etiquetas)
  const a = slot('a', 'a').open()
  const b = slot('b', 'b').open()
  const m = slot('m', 'm').open()
  const c = slot('c', 'c').open()

  assert.notEqual(a.tramo, b.tramo, 'el declarado vacío separa')
  assert.equal(m.tramo.solo, true)
  assert.equal(m.tramo.pane, 'm', 'el solo vive en el pane de su miembro')
  assert.deepEqual(nombres(m.tramo), ['m'])
  assert.notEqual(c.tramo, b.tramo, 'el solo separa a sus vecinos')
  assert.notEqual(c.tramo, m.tramo)
  assert.equal(hechos.length, 4)
  assert.equal([...panes.keys()].filter(n => n.startsWith('cristae-tramo-')).length, 3, 'el solo no monta pane')

  // El canvas del tramo solo, junto al marcador, no cuenta como ajeno: sin el ajeno, el pane deja de ser mixto.
  mixto.appendChild(m.tramo.surface.canvas)
  mixto.children.find(n => n.nombre === 'ajeno').remove()
  gestor.replan()
  assert.equal(m.tramo.solo, false, 'un id reusado que cambia de tipo es un tramo fresco')
})

test('G2: el pane del tramo va después del de su menor K, con su z; se mueve y compone si se va o cambia de z', () => {
  const { gestor, slot, pane, raiz, log, hechos } = montar()
  const pa = pane('a', 400)
  const pb = pane('b', 410)
  pane('c', 420)
  const a = slot('a', 'a').open()
  slot('b', 'b').open()
  slot('c', 'c').open()
  const tramo = hechos[0]
  const nodo  = raiz.children.find(n => n.nombre === tramo.pane)

  assert.equal(pa.nextSibling, nodo)
  assert.equal(nodo.style.zIndex, '400')
  assert.deepEqual(log.find(e => e[1] === tramo.pane && e[0] === 'mount'), ['mount', tramo.pane, 400, false])
  assert.equal(tramo.touches, 0)

  a.destroy()
  assert.deepEqual(nombres(tramo), ['b', 'c'])
  assert.equal(pb.nextSibling, nodo, 'se fue el de menor K: el pane pasa tras el siguiente')
  assert.equal(nodo.style.zIndex, '410')
  assert.equal(tramo.touches, 1)

  pb.style.zIndex = '415'
  gestor.replan()
  assert.equal(nodo.style.zIndex, '415')
  assert.equal(tramo.touches, 2)

  gestor.replan()
  assert.equal(tramo.touches, 2, 'replanificar sin cambios no compone')
})

test('G3: recambio en la misma tarea reusa el tramo; uno vacío se destruye al final de la microtarea', async () => {
  const { gestor, slot, pane, hechos, log } = montar()
  pane('a', 400)
  const a = slot('a', 'a').open()
  const tramo = hechos[0]

  a.destroy()
  const a2 = slot('a2', 'a').open()
  assert.equal(hechos.length, 1, 'ningún Tramo nuevo')
  assert.equal(a2.tramo, tramo)
  await microtarea()
  assert.equal(tramo.destruido, false)

  a2.destroy()
  assert.equal(gestor.size, 1, 'sigue hasta la microtarea')
  await microtarea()
  assert.equal(tramo.destruido, true)
  assert.equal(gestor.size, 0)
  assert.ok(log.some(e => e[0] === 'unmount' && e[1] === tramo.pane))
})

test('G4: un separador declarado dentro de un tramo vivo lo parte; los de arriba salen antes de entrar al nuevo', () => {
  const { gestor, slot, pane, hechos, orden } = montar()
  pane('a', 400)
  pane('b', 410)
  const sep = pane('html', 415)
  pane('c', 420)
  pane('d', 430)
  const a = slot('a', 'a').open()
  slot('b', 'b').open()
  const c = slot('c', 'c').open()
  slot('d', 'd').open()
  const viejo = a.tramo
  assert.deepEqual(nombres(viejo), ['a', 'b', 'c', 'd'])

  orden.length = 0
  const retirar = gestor.separator(sep)
  const nuevo = c.tramo
  assert.notEqual(nuevo, viejo)
  assert.deepEqual(nombres(viejo), ['a', 'b'], 'el id queda abajo')
  assert.deepEqual(nombres(nuevo), ['c', 'd'])
  assert.deepEqual(orden.map(([t, n]) => [t === viejo ? 'viejo' : 'nuevo', n]), [['viejo', ['a', 'b']], ['nuevo', ['c', 'd']]])
  assert.equal(hechos.length, 2)

  retirar()
  assert.notEqual(c.tramo, a.tramo, 'nunca se funde')
})

test('G5: replan tras cambiar la z de un pane muda al miembro', () => {
  const { gestor, slot, pane, nativo } = montar()
  const pa = pane('a', 400)
  pane('b', 410)
  nativo('overlayPane', 415).appendChild(new Nodo('canvas'))
  pane('c', 420)
  const a = slot('a', 'a').open()
  const b = slot('b', 'b').open()
  const c = slot('c', 'c').open()
  const bajo = a.tramo
  assert.equal(b.tramo, bajo)

  pa.style.zIndex = '430'
  gestor.replan()
  assert.deepEqual(nombres(bajo), ['b'])
  assert.notEqual(a.tramo, bajo)
  assert.notEqual(a.tramo, c.tramo, 'llega a la corrida de c pero no se funde con su tramo')
  assert.deepEqual(nombres(a.tramo), ['a'])
  assert.deepEqual(nombres(c.tramo), ['c'])
})

test('G6: onForeign deja el pane como separador pegajoso y replanifica en una microtarea', async () => {
  const { slot, pane, nativo } = montar()
  pane('a', 400)
  pane('b', 410)
  const nat = nativo('overlayPane', 415)
  pane('c', 420)
  const a = slot('a', 'a').open()
  slot('b', 'b').open()
  const c = slot('c', 'c').open()
  const tramo = a.tramo
  assert.deepEqual(tramo.vigilados, [nat])

  const hijo = nat.appendChild(new Nodo('canvas'))
  tramo.onForeign(nat)
  assert.equal(c.tramo, tramo, 'no replanifica en la tarea')
  await microtarea()
  assert.notEqual(c.tramo, tramo)
  assert.deepEqual(nombres(tramo), ['a', 'b'])

  // Sin hijos sigue separando: una alta sobre él ya no entra al tramo de abajo.
  hijo.remove()
  c.destroy()
  await microtarea()
  const c2 = slot('c2', 'c').open()
  assert.notEqual(c2.tramo, tramo)
})

test('renderAtView llega a cada tramo vivo y destroy los retira a todos', () => {
  const { gestor, slot, pane, nativo, hechos } = montar()
  pane('a', 400)
  nativo('overlayPane', 405).appendChild(new Nodo('canvas'))
  pane('b', 410)
  slot('a', 'a').open()
  slot('b', 'b').open()
  const centro = { lat: 1, lng: 2 }
  gestor.renderAtView(7, centro)
  assert.deepEqual(hechos.map(t => t.vistas), [[[7, centro]], [[7, centro]]])

  gestor.destroy()
  assert.ok(hechos.every(t => t.destruido))
  assert.equal(gestor.size, 0)
})
