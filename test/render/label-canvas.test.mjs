// El canvas compartido de los rótulos (`createLabelCanvas`): cuándo recoloca, cuándo repinta, en qué orden
// pinta y qué pica. Corre sobre un anfitrión de mentira —una cámara quieta y una superficie que anota— y
// un contexto 2D espía que lleva el estado como uno de verdad (`save`/`restore` incluidos). La colocación
// es la real (labelLayout); dónde cae cada glifo lo fijan sus tests. Corre con:
//   node --test test/render/label-canvas.test.mjs
import { decorarElementos } from '../../test-helpers/engine-stub.mjs'
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { createLabelCanvas } from '../../src/render/LabelCanvas.js'
import { LABEL_DEFAULTS } from '../../src/render/labelOptions.js'
import { drawLabel } from '../../src/render/LabelLayer.js'

const frame = () => new Promise(resolve => setTimeout(resolve, 5))

// Un 2D que anota en `log` lo que pinta, con el estado vigente. Cada grafema mide `ancho` px.
const STATE = ['font', 'textAlign', 'textBaseline', 'globalAlpha', 'lineWidth', 'fillStyle', 'strokeStyle', 'lineJoin']
const spyCtx = () => {
  const ctx = {
    log    : null,
    ancho  : 7,
    medidas: 0,
    stack  : [],
    t      : [1, 0, 0, 1, 0, 0],
    font   : '', textAlign: 'start', textBaseline: 'alphabetic', globalAlpha: 1, lineWidth: 1,
    fillStyle: '', strokeStyle: '', lineJoin: 'miter',
    measureText(text) { ctx.medidas++; return { width: ctx.ancho * [...text].length } },
    setTransform(a, b, c, d, e, f) { const t = ctx.t; t[0] = a; t[1] = b; t[2] = c; t[3] = d; t[4] = e; t[5] = f },
    save() { ctx.stack.push([...STATE.map(k => ctx[k]), [...ctx.t]]) },
    restore() {
      const s = ctx.stack.pop()
      STATE.forEach((k, i) => ctx[k] = s[i])
      ctx.t = s[STATE.length]
    },
    clearRect() { ctx.log?.push({ op: 'clear' }) },
    fillText(text) { ctx.log?.push({ op: 'fill', text, align: ctx.textAlign, alpha: ctx.globalAlpha, t: [...ctx.t] }) },
    strokeText(text) { ctx.log?.push({ op: 'stroke', text }) },
    beginPath() {}, moveTo() {}, arcTo() {}, closePath() {}, fill() {}, stroke() {}, clip() {}, rect() {}, fillRect() {},
  }
  return ctx
}

let ctx = spyCtx()
after(decorarElementos((el, tag) => {
  if (tag === 'canvas') el.getContext = () => ctx
  return el
}))

// La cámara mira a (0, 0) a zoom 3, en un contenedor de 800 × 600. `fire` reparte sin asignar.
const fakeHost = () => {
  const handlers = {}
  const center   = { lat: 0, lng: 0 }
  const size     = { x: 800, y: 600 }
  const origin   = { x: 0, y: 0 }
  const camera   = {
    origin,
    hasView     : () => true,
    center      : () => center,
    size        : () => size,
    zoom        : () => 3,
    frameOrigin : () => origin,
    on(types, cb) {
      types.split(' ').forEach(t => (handlers[t] ??= []).push(cb))
      return () => types.split(' ').forEach(t => handlers[t].splice(handlers[t].indexOf(cb), 1))
    },
    fire(type) {
      const list = handlers[type] ?? []
      for (let i = 0; i < list.length; i++) list[i]()
    },
  }
  const surface = {
    mounted: [],
    mount(name, z, options) { surface.mounted.push({ name, z, options }); return { appendChild() {} } },
    unmount(name) { surface.mounted = surface.mounted.filter(m => m.name !== name) },
  }
  return { camera, surface }
}

// Un miembro de mentira con la forma del de engine/labels.js. Los puntos van en lat/lng; las líneas, por
// `path` en pares [lat, lng]. `reads` cuenta los ítems que entregó.
const member = ({ id = 'm', kind = 'point', placement = 'center', items, opts = {} }) => {
  const m = {
    id, kind, placement, version: 0, visible: true, curve: null, reads: 0,
    opts    : { ...LABEL_DEFAULTS, ...opts },
    hovered : new Set(),
    alpha   : 1,
    forEach(fn, arg) {
      for (let i = 0; i < items.length; i++) {
        m.reads++
        fn(arg, items[i], items[i].id, items[i].text)
      }
    },
    pathOf    : it => it.path,
    anchorOf  : (it, out) => Object.assign(out, { lat: it.lat, lng: it.lng, w: 0, h: 0 }),
    htmlOf    : () => null,
    hashOf    : it => it.id,
    alphaOf   : () => m.alpha,
    isHovered : id => m.hovered.has(id),
  }
  return m
}

// Con la vista de `fakeHost`, (0, 0) cae en (400, 300) del contenedor.
const mount = () => {
  ctx = spyCtx()
  const host = fakeHost()
  const r    = createLabelCanvas({ host, pane: 'rotulos', zIndex: 1000400 })
  return { host, r, done: () => r.destroy() }
}

const fills   = () => ctx.log.filter(e => e.op === 'fill').map(e => e.text)
const repaint = async () => {
  ctx.log = []
  await frame()
}

test('monta su canvas en el pane, a su z y sin puntero', () => {
  const { host, done } = mount()
  assert.deepEqual(host.surface.mounted, [{ name: 'rotulos', z: 1000400, options: { pointer: false } }])
  done()
  assert.deepEqual(host.surface.mounted, [], 'destroy suelta el pane')
})

test('un aviso de un miembro no recoloca a otro ni relee sus textos', async () => {
  const { r, done } = mount()
  const a = member({ id: 'a', items: [{ id: 1, text: 'uno', lat: 0, lng: 0 }] })
  const b = member({ id: 'b', items: [{ id: 2, text: 'dos', lat: 10, lng: 10 }] })
  r.attach(a)
  r.attach(b)
  await repaint()
  a.reads = b.reads = 0

  a.version++
  r.invalidate(a, 'data')
  await repaint()
  assert.equal(a.reads, 1, 'el que avisó se recoloca')
  assert.equal(b.reads, 0, 'el otro no')
  assert.deepEqual(fills(), ['uno', 'dos'], 'y los dos se pintan')
  done()
})

test('dos avisos en un cuadro son un solo repintado', async () => {
  const { r, done } = mount()
  const a = member({ items: [{ id: 1, text: 'uno', lat: 0, lng: 0 }] })
  r.attach(a)
  await repaint()
  r.invalidate(a, 'data')
  r.invalidate(a, 'focus')
  await repaint()
  assert.equal(ctx.log.filter(e => e.op === 'clear').length, 1)
  done()
})

test('oculto no pinta, y sus avisos no repintan', async () => {
  const { r, done } = mount()
  const a = member({ id: 'a', items: [{ id: 1, text: 'uno', lat: 0, lng: 0 }] })
  const b = member({ id: 'b', items: [{ id: 2, text: 'dos', lat: 10, lng: 10 }] })
  r.attach(a)
  r.attach(b)
  a.visible = false
  await repaint()
  assert.deepEqual(fills(), ['dos'])

  await repaint()
  r.invalidate(a, 'data')
  await repaint()
  assert.deepEqual(ctx.log, [], 'el aviso de un oculto no pinta')

  a.visible = true
  r.invalidate(a, 'visibility')
  await repaint()
  assert.deepEqual(fills(), ['uno', 'dos'])
  done()
})

test('pinta en el orden de attach, y el rótulo bajo el puntero al final', async () => {
  const { r, done } = mount()
  const a = member({ id: 'a', items: [{ id: 1, text: 'a1', lat: 0, lng: 0 }, { id: 2, text: 'a2', lat: 5, lng: 5 }] })
  const b = member({ id: 'b', items: [{ id: 3, text: 'b3', lat: 10, lng: 10 }] })
  r.attach(b)
  r.attach(a)
  await repaint()
  assert.deepEqual(fills(), ['b3', 'a1', 'a2'])

  a.hovered.add(1)
  r.invalidate(a, 'hover')
  await repaint()
  assert.deepEqual(fills(), ['b3', 'a2', 'a1'], 'encima de todos, también de los de otro miembro')
  done()
})

test('en cada miembro los halos van antes que cualquier relleno; con halo none no hay halo', async () => {
  const { r, done } = mount()
  const linea = member({ kind: 'line', placement: 'along', items: [{ id: 'R', text: 'Ruta', path: [[0, -20], [0, 20]] }, { id: 'S', text: 'Sur', path: [[-5, -20], [-5, 20]] }] })
  r.attach(linea)
  await repaint()
  const ops = ctx.log.filter(e => e.op !== 'clear').map(e => e.op)
  assert.deepEqual(ops, [...Array(7).fill('stroke'), ...Array(7).fill('fill')], 'grafema a grafema: 4 + 3 halos y después 4 + 3 rellenos')
  assert.deepEqual(fills(), ['R', 'u', 't', 'a', 'S', 'u', 'r'])

  linea.opts = { ...linea.opts, halo: 'none' }
  r.invalidate(linea, 'style')
  await repaint()
  assert.ok(ctx.log.every(e => e.op !== 'stroke'))
  done()
})

test('el estado que deja un paint no pasa al miembro siguiente', async () => {
  const { r, done } = mount()
  const sucio = (c, point) => {
    c.textAlign = 'left'
    c.setTransform(9, 0, 0, 9, 50, 50)
    c.fillText('pintor', point.x, point.y)
  }
  const a = member({ id: 'a', opts: { paint: sucio }, items: [{ id: 1, text: 'x', lat: 0, lng: 0 }] })
  const b = member({ id: 'b', items: [{ id: 2, text: 'limpio', lat: 0, lng: 0 }] })
  r.attach(a)
  r.attach(b)
  await repaint()
  const limpio = ctx.log.find(e => e.op === 'fill' && e.text === 'limpio')
  assert.equal(limpio.align, 'center')
  assert.deepEqual(limpio.t.map(v => v + 0), [1, 0, 0, 1, 400, 300], 'su transformación es la propia, sin la del pintor')
  done()
})

test('paint={drawLabel}: recibe el ancla, devuelve su caja y se pica por ella', async () => {
  const { r, done } = mount()
  const a = member({ opts: { paint: drawLabel }, items: [{ id: 'p', text: 'Pila', lat: 0, lng: 0 }] })
  r.attach(a)
  await repaint()
  const pildora = ctx.log.find(e => e.text === 'Pila')
  assert.ok(pildora, 'pintó la píldora')

  const out = [null]
  r.hitsAt(a, { x: 400, y: 300 + 22 + 11 }, out)
  assert.deepEqual(out.slice(1).map(p => [p.id, p.ref, p.distancePx, p.zIndex]), [['p', 'p', 0, 1000400]], 'dentro de la píldora, 22 px bajo el punto')
  out.length = 1
  r.hitsAt(a, { x: 400, y: 300 }, out)
  assert.equal(out.length, 1, 'en el punto, que la píldora no cubre, no')
  done()
})

test('un pintor que no devuelve caja dibuja igual, pero no se pica', async () => {
  const { r, done } = mount()
  const a = member({ opts: { paint: (c, p, l) => c.fillText(l.text, p.x, p.y) }, items: [{ id: 'p', text: 'sin caja', lat: 0, lng: 0 }] })
  r.attach(a)
  await repaint()
  assert.deepEqual(fills(), ['sin caja'])
  const out = [null]
  r.hitsAt(a, { x: 400, y: 300 }, out)
  assert.equal(out.length, 1)
  done()
})

test('el pintor recibe lat/lng del ítem y la paleta de la píldora', async () => {
  const { r, done } = mount()
  const vistos = []
  const a = member({ opts: { paint: (c, p, label, hovered, style) => vistos.push({ ...label, hovered, style }) }, items: [{ id: 'p', text: 'T', lat: 10, lng: 20 }] })
  r.attach(a)
  await repaint()
  const [v] = vistos
  assert.deepEqual([v.id, v.text, v.hovered], ['p', 'T', false])
  assert.ok(Math.abs(v.lat - 10) < 1e-4 && Math.abs(v.lng - 20) < 1e-4, `${v.lat}, ${v.lng}`)
  assert.equal(v.style.surface, '#ffffff')
  done()
})

test('la fuente se remide cuando termina de cargar después del primer pintado', async () => {
  let carga
  document.fonts = { load: () => new Promise(resolve => carga = resolve) }
  const { r, done } = mount()
  const a = member({ opts: { font: '700 11px Lenta' }, items: [{ id: 1, text: 'ancho', lat: 0, lng: 0 }] })
  r.attach(a)
  await repaint()
  const out = [null]
  r.hitsAt(a, { x: 400 + 20, y: 300 }, out)
  assert.equal(out.length, 1, 'con 7 px por grafema la caja mide 35 px: 20 px a la derecha queda fuera')

  ctx.ancho = 10
  carga()
  await repaint()
  r.hitsAt(a, { x: 400 + 20, y: 300 }, out)
  assert.equal(out.length, 2, 'remedida a 50 px, ahora cae adentro')
  delete document.fonts
  done()
})

test('durante el zoom animado no pica y el canvas se oculta; al asentar vuelve', async () => {
  const { host, r, done } = mount()
  const a = member({ items: [{ id: 1, text: 'uno', lat: 0, lng: 0 }] })
  r.attach(a)
  await repaint()
  const out = [null]
  host.camera.fire('zoomstart')
  r.hitsAt(a, { x: 400, y: 300 }, out)
  assert.equal(out.length, 1)
  host.camera.fire('zoomend')
  r.hitsAt(a, { x: 400, y: 300 }, out)
  assert.deepEqual(out.slice(1).map(p => p.id), [1])
  done()
})

test('el marco corrido: la muestra se corre lo que viajó el pane desde la colocación', async () => {
  const { host, r, done } = mount()
  const a = member({ items: [{ id: 1, text: 'uno', lat: 0, lng: 0 }] })
  r.attach(a)
  await repaint()
  host.camera.origin.x = -30          // el mapa se arrastró 30 px a la derecha, sin asentar
  const out = [null]
  r.hitsAt(a, { x: 430, y: 300 }, out)
  assert.deepEqual(out.slice(1).map(p => p.id), [1])
  host.camera.origin.x = 0
  done()
})

test('detach deja de pintarlo; destroy suelta todo y no pinta más', async () => {
  const { r, done } = mount()
  const a = member({ id: 'a', items: [{ id: 1, text: 'uno', lat: 0, lng: 0 }] })
  r.attach(a)
  await repaint()
  r.detach(a)
  await repaint()
  assert.deepEqual(fills(), [])
  done()
  r.attach(a)
  await repaint()
  assert.deepEqual(ctx.log, [])
})

// Las asignaciones del repintado se miden aparte, en label-canvas-alloc.test.mjs: con el espía de este
// archivo, cada llamada al contexto encajonaría sus números.
