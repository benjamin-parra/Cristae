// El registro de la política de contextos (src/render/gl-budget.js) es del realm y vive lo que el módulo: no retiene a
// una superficie que nadie destruye —un motor que se suelta sin `destroy()`, el mapa de una ventana que se cerró sin
// desmontarlo—, ni a una destruida. Archivo propio: cuenta con un recolector a mano.
// Corre con: node --test test/render/gl-budget-registro.test.mjs
import v8 from 'node:v8'
import vm from 'node:vm'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EditSurface } from '../../src/render/EditSurface.js'

v8.setFlagsFromString('--expose_gc')
const gc = vm.runInNewContext('gc')

const glFalso = () => ({
  MAX_TEXTURE_SIZE     : 0x0D33,
  getContextAttributes : () => ({ stencil: true }),
  getExtension         : () => null,
  getParameter         : p => p === 0x0D33 ? 8192 : null,
  isContextLost        : () => false,
  viewport() {}, flush() {}, finish() {},
})

class Lienzo extends EventTarget {
  style      = {}
  width      = 0
  height     = 0
  className  = ''
  parentNode = null
  getContext() { return glFalso() }
  remove() { this.parentNode = null }
}

globalThis.document              = { createElement: () => new Lienzo() }
globalThis.requestAnimationFrame = () => 1
globalThis.requestIdleCallback   = () => 1

const host = () => {
  const pane = { nodeType: 1, style: {}, appendChild(hijo) { hijo.parentNode = this; return hijo } }
  return {
    camera  : { size: () => ({ x: 8, y: 6 }), frameOrigin: () => ({ x: 0, y: 0 }), zoom: () => 3, center: () => ({ lat: 0, lng: 0 }), on: () => () => {} },
    surface : { mount: () => pane, unmount() {}, zOf: () => 1, followZoom() {} },
  }
}

// Una superficie con dueña y contexto, de la que sólo queda una referencia débil.
const montar = destruir => {
  const s = new EditSurface({ host: host(), pane: 'p', owner: { hasContent: true, buildGl() {}, dropGl() {} } })
  s.acquire()
  destruir && s.destroy()
  return new WeakRef(s)
}

const recolectar = async () => {
  for (let i = 0; i < 6; i++) {
    await new Promise(r => setTimeout(r, 0))
    gc()
  }
}

test('R5: una superficie con dueña que nadie destruye se recolecta: el registro no la retiene', async () => {
  const ref = montar(false)
  await recolectar()
  assert.equal(ref.deref(), undefined)
})

test('destruida, sale del registro y se recolecta', async () => {
  const ref = montar(true)
  await recolectar()
  assert.equal(ref.deref(), undefined)
})
