// Las asignaciones del canvas compartido de los rótulos (DISENO-ROTULOS §3.2), en un proceso propio: el
// contexto es de no-ops que el compilador puede integrar, así lo que se mide es el código de los rótulos y
// no el espía, que en label-canvas.test.mjs encajonaría los números de cada llamada. En un navegador las
// llamadas al contexto 2D son del motor. Corre con:
//   node --test test/render/label-canvas-alloc.test.mjs
import { decorarElementos } from '../../test-helpers/engine-stub.mjs'
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { bytesPorLlamada } from '../../test-helpers/asignaciones.mjs'
import { createLabelCanvas } from '../../src/render/LabelCanvas.js'
import { LABEL_DEFAULTS } from '../../src/render/labelOptions.js'

const frame = () => new Promise(resolve => setTimeout(resolve, 5))

// SPECS §14: se cuentan los bytes asignados en la generación joven (test-helpers/asignaciones.mjs), con
// calentamiento previo, largo para que el compilador optimice. El repintado de lo ya colocado —un aviso ajeno, el hover, el foco— no llama a
// `forEach` ni a la colocación, y no asigna por rótulo. Lo que asigna una vez por repintado es la lectura
// de la vista (la cámara, `readLabelView`), que no crece con los rótulos: por eso se mide la diferencia
// entre 10 y 210 rótulos. El contexto es de no-ops, así el que asigna no es el espía.
const noop = () => {}
const mudo = () => ({
  font: '', textAlign: '', textBaseline: '', globalAlpha: 1, lineWidth: 1, fillStyle: '', strokeStyle: '', lineJoin: '',
  measureText: text => ({ width: 7 * text.length }),
  setTransform: noop, clearRect: noop, fillText: noop, strokeText: noop, save: noop, restore: noop,
})

let ctx = mudo()
after(decorarElementos((el, tag) => {
  if (tag === 'canvas') el.getContext = () => ctx
  return el
}))

// La cámara quieta de label-canvas.test.mjs: `fire` reparte sin asignar.
const fakeHost = () => {
  const handlers = {}
  const center   = { lat: 0, lng: 0 }
  const size     = { x: 800, y: 600 }
  const origin   = { x: 0, y: 0 }
  const camera   = {
    hasView     : () => true,
    center      : () => center,
    size        : () => size,
    zoom        : () => 3,
    frameOrigin : () => origin,
    on(types, cb) {
      types.split(' ').forEach(t => (handlers[t] ??= []).push(cb))
      return noop
    },
    fire(type) {
      const list = handlers[type]
      for (let i = 0; i < list.length; i++) list[i]()
    },
  }
  return { camera, surface: { mount: () => ({ appendChild: noop }), unmount: noop } }
}

const member = ({ id, kind = 'point', placement = 'center', items }) => {
  const m = {
    id, kind, placement, version: 0, visible: true, curve: null, reads: 0,
    opts      : { ...LABEL_DEFAULTS },
    forEach(fn, arg) {
      for (let i = 0; i < items.length; i++) {
        m.reads++
        fn(arg, items[i], items[i].id, items[i].text)
      }
    },
    pathOf    : it => it.path,
    anchorOf  : (it, out) => Object.assign(out, { lat: it.lat, lng: it.lng, w: 0, h: 0 }),
    alphaOf   : () => 1,
    isHovered : () => false,
  }
  return m
}

const repintados = async n => {
  ctx        = mudo()
  const host = fakeHost()
  const r    = createLabelCanvas({ host, pane: 'rotulos', zIndex: 1 })
  const p    = member({ id: 'p', items: Array.from({ length: n }, (_, i) => ({ id: i, text: `p${i}`, lat: i % 40, lng: i % 60 })) })
  const l    = member({ id: 'l', kind: 'line', placement: 'along', items: [{ id: 'R', text: 'Ruta', path: [[0, -20], [0, 20]] }] })
  r.attach(p)
  r.attach(l)
  await frame()
  p.reads = l.reads = 0
  const bytes = bytesPorLlamada(() => host.camera.fire('resize'), 100, { calentar: 50_000 })
  assert.equal(p.reads + l.reads, 0, 'sin recolocar')

  const sample = { x: 400, y: 300 }
  const out    = [null]
  const hit    = () => {
    out.length = 1
    r.hitsAt(l, sample, out)
  }
  hit()
  assert.equal(out.length, 2, 'la línea se pica en su centro')
  const pica = bytesPorLlamada(hit, 5_000, { calentar: 200_000 })
  r.destroy()
  return { bytes, pica }
}

test('cero asignaciones por rótulo en el repintado de lo colocado, y en hitsAt', async () => {
  const pocos = await repintados(10)
  const hartos = await repintados(210)
  const porRotulo = (hartos.bytes - pocos.bytes) / 200
  assert.ok(porRotulo < 1, `repintado: ${porRotulo} bytes por rótulo (${pocos.bytes} y ${hartos.bytes} por repintado)`)
  // Una asignación por llamada son al menos 16 bytes; lo de menos es el ruido del contador.
  assert.ok(hartos.pica < 16, `hitsAt: ${hartos.pica} bytes por llamada`)
})
