// El renderer `html` de `<cristae-labeled>` sobre el DOM stub, con la colocación real: reconciliación
// por id, contenido que se arma sólo cuando cambia, giro con `along`, una medida por contenido, la caja
// orientada que se pica y `interactive`. La cámara y la superficie son dobles: vista en (0, 0) a zoom 0
// sobre un contenedor de 800 × 600, así el punto (lat 0, lng 45) cae en el píxel (432, 300).
// Corre con: node --test test/render/label-html.test.mjs
import { flushRaf } from '../../test-helpers/dom-stub.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { createLabelHtml } from '../../src/render/LabelHtml.js'

// Cada div mide su contenido: 10 px por carácter de texto y 18 de alto, y cuenta cuántas veces se leyó.
const crear = document.createElement
document.createElement = tag => {
  const el = crear(tag)
  el.lecturas = 0
  Object.defineProperty(el, 'offsetWidth', { get() { el.lecturas++; return 10 * el.textContent.length } })
  Object.defineProperty(el, 'offsetHeight', { get: () => 18 })
  return el
}

// La cámara y la superficie del anfitrión, a mano: la vista se mueve con `emitir`.
const anfitrion = () => {
  const oyentes   = {}
  const estado    = { zoom: 0, origen: { x: 0, y: 0 }, origenes: 0 }
  const montados  = []
  const blindados = new Set()
  const camera    = {
    hasView     : () => true,
    center      : () => ({ lat: 0, lng: 0 }),
    size        : () => ({ x: 800, y: 600 }),
    zoom        : () => estado.zoom,
    frameOrigin : () => (estado.origenes++, { ...estado.origen }),
    on(names, fn) {
      names.split(' ').forEach(type => (oyentes[type] ??= []).push(fn))
      return () => names.split(' ').forEach(type => (oyentes[type] = oyentes[type].filter(f => f !== fn)))
    },
  }
  const surface = {
    mount(name, z, opts) {
      const pane = crear('div')
      montados.push({ name, z, opts, pane })
      return pane
    },
    unmount    : name => montados.push({ baja: name }),
    followZoom : el => (el.className += ' leaflet-zoom-animated'),
    shield(node) {
      blindados.add(node)
      return () => blindados.delete(node)
    },
  }
  const emitir = (type, detalle) => (oyentes[type] ?? []).forEach(fn => fn(detalle))
  return { host: { camera, surface }, estado, montados, blindados, emitir }
}

const OPTS = {
  repeat: null, offset: 0, orientation: 'auto', font: '12px sans-serif', color: '#0f172a', halo: '#ffffff',
  interactive: false, htmlOf: null,
}

// Un miembro como lo arma el motor. Los ítems son { id, text?, hash?, lng? } sobre puntos (`center`) o
// { id, text?, path } sobre líneas (`along`).
const miembro = (items, opts = {}, { kind = 'point', placement = 'center' } = {}) => {
  const m = {
    id: 'capa', kind, placement, version: 1, visible: true, curve: null,
    opts     : { ...OPTS, ...opts },
    items,
    llamadas : 0,
    alpha    : new Map(),
    hover    : null,
    forEach(fn, arg) { m.items.forEach(item => fn(arg, item, item.id, item.text ?? String(item.id))) },
    pathOf   : item => item.path,
    anchorOf(item, out) {
      out.lat = 0
      out.lng = item.lng ?? 0
      return out
    },
    htmlOf(item) {
      m.llamadas++
      return m.opts.htmlOf(item)
    },
    hashOf    : item => item.hash ?? String(item.id),
    alphaOf   : id => m.alpha.get(id) ?? 1,
    isHovered : id => id === m.hover,
    // Cambian los datos: sube la versión y avisa.
    cambiar(r, nuevos) {
      m.items = nuevos
      m.version++
      r.invalidate(m, 'data')
    },
  }
  return m
}
const linea = (items, opts) => miembro(items, opts, { kind: 'line', placement: 'along' })

const montar = (m = miembro([{ id: 1 }])) => {
  const a = anfitrion()
  const r = createLabelHtml({ host: a.host, pane: 'cristae-labels-html', zIndex: 1_000_123 })
  r.attach(m)
  const [{ pane }] = a.montados
  const raiz       = () => pane.children[0]
  const nodos      = () => raiz().children
  const hits       = (x, y, out = []) => r.hitsAt(m, { x, y }, out)
  return { ...a, r, m, pane, raiz, nodos, hits }
}

const giro = t => Number(/rotate\(([^)]+)rad\)/.exec(t)?.[1] ?? 0) * 180 / Math.PI

test('monta su pane con el z que recibe y sin puntero, y lo suelta al destruirse', async () => {
  const { r, montados, pane } = montar()
  await flushRaf()
  assert.deepEqual(montados[0].opts, { pointer: false })
  assert.equal(montados[0].z, 1_000_123)
  assert.equal(r.zIndex, 1_000_123)
  r.destroy()
  assert.deepEqual(montados.at(-1), { baja: 'cristae-labels-html' })
  assert.equal(pane.children.length, 0, 'sin el nodo del miembro')
})

test('reconcilia por id: el nodo de un ítem que sigue es el mismo, el que se va sale y el nuevo nace', async () => {
  const { r, m, nodos } = montar(miembro([{ id: 'a' }, { id: 'b' }]))
  await flushRaf()
  const [, b] = nodos()
  assert.deepEqual(nodos().map(n => n.textContent), ['a', 'b'])
  assert.match(b.className, /leaflet-zoom-animated/, 'acompaña la transición del zoom animado')

  m.cambiar(r, [{ id: 'b' }, { id: 'c' }])
  await flushRaf()
  assert.deepEqual(nodos().map(n => n.textContent), ['b', 'c'])
  assert.equal(nodos()[0], b, 'b conserva su nodo')
})

test('htmlOf se llama una vez por ítem y otra sólo si cambia su hash; el Node entra tal cual', async () => {
  const nodo = crear('span')
  const m    = miembro([{ id: 'a', hash: 'h1' }, { id: 'b' }], { htmlOf: item => item.id === 'a' ? nodo : `<b>${item.id}</b>` })
  const { r, nodos } = montar(m)
  await flushRaf()
  assert.equal(m.llamadas, 2)
  const [a, b] = nodos()
  assert.equal(a.children[0], nodo, 'el Node que devolvió, no una copia: sus listeners siguen')
  assert.equal(b.innerHTML, '<b>b</b>')

  m.cambiar(r, [{ id: 'a', hash: 'h1' }, { id: 'b' }])
  await flushRaf()
  assert.equal(m.llamadas, 2, 'con el mismo hash no se vuelve a pedir')

  m.cambiar(r, [{ id: 'a', hash: 'h2' }, { id: 'b' }])
  await flushRaf()
  assert.equal(m.llamadas, 3, 'otro hash, otra llamada')
  assert.equal(nodos()[0], a, 'en el mismo nodo')
})

test('textOf no interpreta HTML: el texto va por textContent, con el aspecto del halo en el miembro', async () => {
  const { raiz, nodos } = montar(miembro([{ id: 1, text: '<b>x</b>' }]))
  await flushRaf()
  const [n] = nodos()
  assert.equal(n.textContent, '<b>x</b>')
  assert.equal(n.innerHTML, undefined, 'nunca se asignó innerHTML')
  assert.equal(n.children.filter(h => h.tagName).length, 0, 'sin elementos hijos')
  assert.equal(raiz().style.font, OPTS.font)
  assert.equal(raiz().style.color, OPTS.color)
  assert.match(raiz().style.textShadow, /#ffffff/)
})

test('halo="none" apaga la sombra; con htmlOf el aspecto es del consumidor', async () => {
  const sin = montar(miembro([{ id: 1 }], { halo: 'none' }))
  const con = montar(miembro([{ id: 1 }], { htmlOf: () => '<i>x</i>' }))
  await flushRaf()
  assert.ok(!sin.raiz().style.textShadow, 'sin sombra')
  assert.ok(!con.raiz().style.font)
  assert.ok(!con.raiz().style.textShadow)
})

test('along gira el nodo según la tangente, derecho para quien lee salvo con orientation="path"', async () => {
  const path = [[0, 45], [0, -45]]                       // de derecha a izquierda: la tangente apunta a 180°
  const auto = montar(linea([{ id: 1, path }]))
  const tal  = montar(linea([{ id: 1, path }], { orientation: 'path' }))
  await flushRaf()
  const [a] = auto.nodos()
  const [t] = tal.nodos()
  assert.equal(a.style.transform, 'translate3d(400px, 300px, 0) translate(-50%, -50%)', 'auto: derecho, centrado en la mitad')
  assert.ok(Math.abs(Math.abs(giro(t.style.transform)) - 180) < 1e-3, 'path: la tangente tal cual')
  assert.equal(a.style.transformOrigin, '0 0', 'gira alrededor del ancla')
})

test('cada parte de un ítem es un nodo, y el contenido se mide una vez, no por pintado', async () => {
  const path = [[[0, -90], [0, -45]], [[0, 45], [0, 90]]]
  const { r, m, nodos, emitir } = montar(linea([{ id: 'ruta', path }]))
  await flushRaf()
  const [uno, dos] = nodos()
  assert.equal(nodos().length, 2)
  assert.equal(dos.textContent, 'ruta', 'la segunda parte lleva una copia')
  assert.equal(uno.lecturas + dos.lecturas, 1, 'se midió el primero, y la copia usa su medida')

  emitir('movestart')
  emitir('moveend')
  await flushRaf()
  m.alpha.set('ruta', 0.3)
  r.invalidate(m, 'focus')
  await flushRaf()
  assert.equal(uno.lecturas, 1, 'ni la vista ni el foco vuelven a medir')
  assert.equal(uno.style.opacity, '0.3')

  m.cambiar(r, [{ id: 'ruta', text: 'otra', path }])
  await flushRaf()
  assert.equal(uno.lecturas, 2, 'un texto nuevo sí')
  assert.equal(nodos()[0], uno)

  m.cambiar(r, [{ id: 'ruta', text: 'otra', path: path[0] }])
  await flushRaf()
  assert.deepEqual(nodos(), [uno], 'una parte menos, una copia menos')
})

test('la caja que se pica es la medida, orientada con el giro, y lleva el z del pane', async () => {
  // «rotulo» mide 60 × 18; sobre una línea norte-sur queda girado 90° alrededor de (400, 300).
  const { hits } = montar(linea([{ id: 'x', text: 'rotulo', path: [[30, 0], [-30, 0]] }]))
  await flushRaf()
  assert.deepEqual(hits(400, 325).map(({ id, zIndex }) => [id, zIndex]), [['x', 1_000_123]], 'a lo largo del giro')
  assert.deepEqual(hits(425, 300), [], 'donde estaría sin girar, no')
  const out = [{ otra: true }]
  assert.equal(hits(400, 300, out), out)
  assert.equal(out.length, 2, 'agrega a lo que ya traía, sin vaciarlo')
  assert.deepEqual(out[0], { otra: true })
})

test('con el marco corrido desde que se colocó, la caja se pica donde se ve, y en reposo no lee el origen', async () => {
  const { estado, emitir, hits } = montar(miembro([{ id: 'x', text: 'ab', lng: 45 }]))
  await flushRaf()
  const antes = estado.origenes
  assert.equal(hits(432, 300).length, 1)
  assert.equal(estado.origenes, antes, 'sin movimiento, ninguna lectura del origen: [0-alloc]')

  // Un paneo de 40 px a la izquierda: el pane se corre y el origen del marco crece 40.
  emitir('movestart')
  estado.origen = { x: 40, y: 0 }
  assert.equal(hits(432, 300).length, 0, 'el rótulo ya no está ahí')
  assert.equal(hits(392, 300).length, 1, 'está 40 px a la izquierda')
})

test('durante el zoom animado no se pica, y cada nodo va a su lugar en la vista destino', async () => {
  const { nodos, emitir, hits } = montar(miembro([{ id: 'x', lng: 45 }]))
  await flushRaf()
  assert.match(nodos()[0].style.transform, /^translate3d\(432px, 300px, 0\)/)
  emitir('zoomstart')
  emitir('zoomanim', { center: { lat: 0, lng: 0 }, zoom: 1 })
  assert.deepEqual(hits(432, 300), [])
  assert.match(nodos()[0].style.transform, /^translate3d\(464px, 300px, 0\)/, 'al doble del centro, sin esperar el cuadro')
})

test('dos avisos en un cuadro son un pintado; oculto no pinta ni pide contenido', async () => {
  const m = miembro([{ id: 1 }], { htmlOf: () => 'x' })
  const { r, raiz, hits } = montar(m)
  await flushRaf()
  let recorridos = 0
  const original = m.forEach
  m.forEach = (fn, arg) => {
    recorridos++
    original(fn, arg)
  }
  r.invalidate(m, 'data')
  r.invalidate(m, 'style')
  await flushRaf()
  assert.equal(recorridos, 2, 'una reconciliación y una colocación')

  m.visible = false
  m.cambiar(r, [{ id: 1, hash: 'otro' }])
  await flushRaf()
  assert.equal(raiz().style.display, 'none')
  assert.equal(m.llamadas, 1, 'oculto, no reconcilia')
  assert.deepEqual(hits(400, 300), [])

  m.visible = true
  r.invalidate(m, 'visibility')
  await flushRaf()
  assert.equal(raiz().style.display, '')
  assert.equal(m.llamadas, 2, 'al volver hace lo pendiente')
})

test('el hover sube el nodo; el orden de pintado es el de attach', async () => {
  const { r, m, pane, nodos } = montar(miembro([{ id: 'a' }, { id: 'b' }]))
  const otro = miembro([{ id: 'z' }])
  r.attach(otro)
  await flushRaf()
  assert.deepEqual(pane.children.map(raiz => raiz.children[0].textContent), ['a', 'z'])
  m.hover = 'b'
  r.invalidate(m, 'hover')
  await flushRaf()
  assert.deepEqual(nodos().map(n => n.style.zIndex), [undefined, '1'])
  r.detach(otro)
  assert.equal(pane.children.length, 1)
})

test('con interactive no hay partes: el nodo toma el puntero, blindado; apagarlo lo devuelve', async () => {
  const { r, m, raiz, blindados, hits } = montar(miembro([{ id: 'x' }], { interactive: true }))
  await flushRaf()
  assert.deepEqual(hits(400, 300), [])
  assert.equal(raiz().style.pointerEvents, 'auto')
  assert.ok(blindados.has(raiz()), 'lo que nace en sus nodos no es del mapa')

  m.opts = { ...m.opts, interactive: false }
  m.version++
  r.invalidate(m, 'style')
  await flushRaf()
  assert.equal(raiz().style.pointerEvents, 'none')
  assert.equal(blindados.size, 0)
  assert.equal(hits(400, 300).length, 1)
})
