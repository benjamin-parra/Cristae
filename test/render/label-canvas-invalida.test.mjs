// Lo que el canvas de los rótulos reutiliza entre cuadros (el texto ya medido, la colocación, los números que
// viajan en objetos reutilizados) tiene que rehacerse cuando cambia aquello de lo que depende: el texto, la
// fuente, el tema, la densidad de píxeles, la colocación, los datos y la posición. Cada caso mira lo que se pinta
// y la caja que se pica, no la caché. Corre con:
//   node --test test/render/label-canvas-invalida.test.mjs
import { decorarElementos } from '../../test-helpers/engine-stub.mjs'
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { createLabelCanvas } from '../../src/render/LabelCanvas.js'
import { LABEL_DEFAULTS } from '../../src/render/labelOptions.js'

const frame = () => new Promise(resolve => setTimeout(resolve, 5))

// Un 2D que anota lo que pinta y mide el tamaño en px de la fuente vigente por grafema.
const spyCtx = () => {
  const ctx = {
    log: [], t: [1, 0, 0, 1, 0, 0], stack: [], medidas: 0,
    font: '', textAlign: '', textBaseline: '', globalAlpha: 1, lineWidth: 1, fillStyle: '', strokeStyle: '', lineJoin: '',
    measureText(text) {
      ctx.medidas++
      const px = Number(/(\d+)px/.exec(ctx.font)?.[1] ?? 10)
      return { width: px * [...text].length, fontBoundingBoxAscent: px * 0.8, fontBoundingBoxDescent: px * 0.2 }
    },
    setTransform(a, b, c, d, e, f) { ctx.t = [a, b, c, d, e, f] },
    save() { ctx.stack.push([ctx.fillStyle, [...ctx.t]]) },
    restore() { [ctx.fillStyle, ctx.t] = ctx.stack.pop() },
    clearRect() {},
    fillText(text) { ctx.log.push({ text, fillStyle: ctx.fillStyle, t: [...ctx.t] }) },
    strokeText() {},
  }
  return ctx
}

let ctx = spyCtx()
after(decorarElementos((el, tag) => {
  if (tag === 'canvas') el.getContext = () => ctx
  return el
}))

// La cámara de label-canvas.test.mjs: (0, 0) cae en (400, 300) a zoom 3.
const fakeHost = () => {
  const handlers = {}
  const center   = { lat: 0, lng: 0 }
  const size     = { x: 800, y: 600 }
  const origin   = { x: 0, y: 0 }
  const camera   = {
    origin,
    fire: type => handlers[type]?.forEach(cb => cb()),
    hasView: () => true, center: () => center, size: () => size, zoom: () => 3, frameOrigin: () => origin,
    on(types, cb) {
      types.split(' ').forEach(t => (handlers[t] ??= []).push(cb))
      return () => {}
    },
  }
  return { camera, surface: { mount: () => ({ appendChild() {} }), unmount() {} } }
}

const member = ({ placement = 'right', items, opts = {} }) => {
  const m = {
    id: 'm', kind: 'point', placement, version: 0, visible: true, curve: null,
    opts      : { ...LABEL_DEFAULTS, font: '700 10px A', ...opts },
    forEach   : (fn, arg) => items.forEach(it => fn(arg, it, it.id, it.text)),
    pathOf    : null,
    anchorOf  : (it, out) => { out.lat = it.lat; out.lng = it.lng; out.w = it.w ?? 0; out.h = it.h ?? 0; return out },
    alphaOf   : () => 1,
    isHovered : () => false,
  }
  return m
}

let host
const mount = () => {
  window.devicePixelRatio = 1
  ctx  = spyCtx()
  host = fakeHost()
  return createLabelCanvas({ host, pane: 'rotulos', zIndex: 1 })
}
const pintar = async () => { ctx.log = []; await frame() }
// El centro x del texto pintado: ratio * (centro de la caja). Con `right` y un ícono de ancho 0, la caja arranca a 4 px del punto.
const centroX = () => ctx.log.map(e => e.t[4])

test('el texto que cambia con el mismo id se vuelve a medir y a colocar: la caja de `right` crece con él', async () => {
  const r  = mount()
  const it = { id: 1, text: 'ab', lat: 0, lng: 0 }
  const m  = member({ items: [it] })
  r.attach(m)
  await pintar()
  assert.deepEqual(centroX(), [400 + 4 + 10])
  it.text = 'abcdef'
  m.version++
  r.invalidate(m, 'data')
  await pintar()
  assert.deepEqual(ctx.log.map(e => e.text), ['abcdef'])
  assert.deepEqual(centroX(), [400 + 4 + 30])
  it.text = 'ab'
  m.version++
  r.invalidate(m, 'data')
  await pintar()
  assert.deepEqual(centroX(), [400 + 4 + 10], 'y vuelve al ancho que tenía')
  r.destroy()
})

test('la fuente nueva no usa lo medido con la anterior, ni la vieja lo medido con la nueva', async () => {
  const r  = mount()
  const m  = member({ items: [{ id: 1, text: 'abcd', lat: 0, lng: 0 }], opts: { font: '700 10px A' } })
  r.attach(m)
  await pintar()
  assert.deepEqual(centroX(), [400 + 4 + 20])
  m.opts = { ...m.opts, font: '700 20px A' }
  m.version++
  r.invalidate(m, 'style')
  await pintar()
  assert.deepEqual(centroX(), [400 + 4 + 40])
  m.opts = { ...m.opts, font: '700 10px A' }
  m.version++
  r.invalidate(m, 'style')
  await pintar()
  assert.deepEqual(centroX(), [400 + 4 + 20])
  r.destroy()
})

test('el tema y la densidad de píxeles no pasan por la medida: cambian el pintado y no el ancho', async () => {
  const r  = mount()
  const m  = member({ items: [{ id: 1, text: 'abcd', lat: 0, lng: 0 }], opts: { color: '#111' } })
  r.attach(m)
  await pintar()
  const medidas = ctx.medidas
  assert.equal(ctx.log[0].fillStyle, '#111')
  m.opts = { ...m.opts, color: '#eee', halo: '#000' }
  m.version++
  r.invalidate(m, 'style')
  await pintar()
  assert.equal(ctx.log[0].fillStyle, '#eee', 'el color nuevo se pinta')
  assert.equal(ctx.medidas, medidas, 'sin medir de nuevo')

  window.devicePixelRatio = 2
  r.invalidate(m, 'style')
  await pintar()
  assert.equal(ctx.log[0].t[0], 2, 'la escala del contexto sigue a la densidad')
  assert.equal(ctx.log[0].t[4], 2 * (400 + 4 + 20), 'y la caja no cambia de ancho en px de CSS')
  assert.equal(ctx.medidas, medidas)
  window.devicePixelRatio = 1
  r.destroy()
})

test('la colocación nueva usa el texto medido: `right` → `center` → `above` mueve la caja sin remedir', async () => {
  const r  = mount()
  const m  = member({ items: [{ id: 1, text: 'abcd', lat: 0, lng: 0, w: 10, h: 10 }] })
  r.attach(m)
  await pintar()
  const medidas = ctx.medidas
  assert.deepEqual(centroX(), [400 + 5 + 4 + 20])
  m.placement = 'center'
  m.version++
  r.invalidate(m, 'data')
  await pintar()
  assert.deepEqual(centroX(), [400])
  m.placement = 'above'
  m.version++
  r.invalidate(m, 'data')
  await pintar()
  assert.deepEqual(ctx.log.map(e => e.t[5]), [300 - 5 - 4 - 5])
  assert.equal(ctx.medidas, medidas)
  r.destroy()
})

test('los datos nuevos (otro ítem, otra posición) se colocan con el ancla de ahora, sin restos del ícono anterior', async () => {
  const r  = mount()
  const items = [{ id: 1, text: 'ab', lat: 0, lng: 0, w: 40, h: 20 }]
  const m  = member({ items })
  r.attach(m)
  await pintar()
  assert.deepEqual(centroX(), [400 + 20 + 4 + 10], 'ícono de 40 px')
  items[0] = { id: 1, text: 'ab', lat: 0, lng: 0 }
  m.version++
  r.invalidate(m, 'data')
  await pintar()
  assert.deepEqual(centroX(), [400 + 4 + 10], 'sin ícono: el ancho anterior no queda')
  items[0] = { id: 2, text: 'xyz', lat: 10, lng: 10 }
  m.version++
  r.invalidate(m, 'data')
  await pintar()
  assert.equal(ctx.log.length, 1)
  assert.ok(ctx.log[0].t[4] > 400 + 4 + 15, 'se movió con el ítem')
  assert.equal(ctx.log[0].text, 'xyz')
  r.destroy()
})

test('un repintado sin cambios no recoloca ni remide: pinta lo mismo', async () => {
  const r  = mount()
  const m  = member({ items: [{ id: 1, text: 'ab', lat: 0, lng: 0 }] })
  r.attach(m)
  await pintar()
  const antes   = ctx.log.map(e => e.t)
  const medidas = ctx.medidas
  r.invalidate(m, 'focus')
  await pintar()
  assert.deepEqual(ctx.log.map(e => e.t), antes)
  assert.equal(ctx.medidas, medidas)
  r.destroy()
})

test('un `paint` que cambia de caja entre cuadros se pica por la de ahora, y sin caja deja de picarse', async () => {
  const r   = mount()
  let caja  = { x: 400, y: 290, w: 30, h: 20 }
  const m   = member({ placement: 'center', items: [{ id: 1, text: 'ab', lat: 0, lng: 0 }], opts: { paint: () => caja } })
  r.attach(m)
  await pintar()
  const out = [null]
  r.hitsAt(m, { x: 410, y: 300 }, out)
  assert.equal(out.length, 2, 'dentro de la caja')
  out.length = 1
  caja = { x: 100, y: 290, w: 30, h: 20 }
  m.version++
  r.invalidate(m, 'data')
  await pintar()
  r.hitsAt(m, { x: 410, y: 300 }, out)
  assert.equal(out.length, 1, 'la caja vieja ya no pica')
  r.hitsAt(m, { x: 110, y: 300 }, out)
  assert.equal(out.length, 2, 'la nueva sí')
  out.length = 1
  caja = undefined
  m.version++
  r.invalidate(m, 'data')
  await pintar()
  r.hitsAt(m, { x: 110, y: 300 }, out)
  assert.equal(out.length, 1, 'sin caja no se pica')
  r.destroy()
})

test('con el marco corrido, la caja de un `paint` vuelve al marco de la colocación en los dos ejes', async () => {
  const r = mount()
  const m = member({ placement: 'center', items: [{ id: 1, text: 'ab', lat: 0, lng: 0 }], opts: { paint: (_c, p) => ({ x: p.x - 15, y: p.y - 10, w: 30, h: 20 }) } })
  r.attach(m)
  await pintar()
  host.camera.fire('movestart')
  host.camera.origin.x = -30
  host.camera.origin.y = -20
  r.invalidate(m, 'focus')
  await pintar()
  const out = [null]
  r.hitsAt(m, { x: 430 + 12, y: 320 }, out)
  assert.equal(out.length, 2, 'a la derecha, dentro de la caja corrida 30 px')
  out.length = 1
  r.hitsAt(m, { x: 430, y: 320 + 8 }, out)
  assert.equal(out.length, 2, 'abajo, dentro de la caja corrida 20 px')
  out.length = 1
  r.hitsAt(m, { x: 430 + 20, y: 320 }, out)
  assert.equal(out.length, 1, 'y fuera de ella')
  host.camera.origin.x = host.camera.origin.y = 0
  r.destroy()
})
