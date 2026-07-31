// Contrato de la superficie WebGL2 propia de la geometría editable, sobre un doble de gl: la esclusa
// del stencil (lo que evita que el relleno falle en silencio), el teardown que DEVUELVE el contexto, y
// que el ciclo de sesión no consuma contextos del techo acumulativo del navegador (~16).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EditSurface } from '../../src/render/EditSurface.js'

/* ── Dobles: canvas + gl + map + L, con el contador de contextos y de loseContext ── */

// El navegador puede otorgar MENOS de lo pedido: el doble separa lo SOLICITADO de lo CONCEDIDO
// (`stencilOtorgado`), que es exactamente la brecha que vigila la esclusa.
const makeGl = (host, attrs) => ({
  getContextAttributes : () => ({ ...attrs, stencil: attrs.stencil && host.stencilOtorgado }),
  getExtension         : nombre => (nombre === 'WEBGL_lose_context' ? { loseContext: () => { host.lost++ } } : null),
  viewport             : (x, y, w, h) => host.viewports.push({ x, y, w, h }),
})

const makeCanvas = host => {
  const canvas = {
    width: 0, height: 0, style: {}, pane: null,
    listeners  : {},
    addEventListener(tipo, cb) { (canvas.listeners[tipo] ??= []).push(cb) },
    emit(tipo)                 { canvas.listeners[tipo]?.forEach(cb => cb()) },
    remove()                   { canvas.pane = null },
    getContext(_kind, attrs)   { host.contexts++; return makeGl(host, attrs) },
  }
  host.canvases.push(canvas)
  return canvas
}

let host = null
globalThis.document = { createElement: () => makeCanvas(host) }   // la superficie sólo pide canvas

// El pane NO está en el origen del contenedor: así el aserto de posicionamiento no es vacuo.
const DESPLAZAMIENTO = { x: -120, y: -40 }

const makeMap = ({ width = 800, height = 600 } = {}) => {
  const panes = new Map()
  return {
    panes,
    getSize    : () => ({ x: width, y: height }),
    getPane    : n => panes.get(n) ?? null,
    createPane : n => {
      const pane = { hijos: [], appendChild(c) { pane.hijos.push(c); c.pane = pane } }
      panes.set(n, pane)
      return pane
    },
    containerPointToLayerPoint: ([x, y]) => ({ x: x + DESPLAZAMIENTO.x, y: y + DESPLAZAMIENTO.y }),
  }
}

const makeL = espia => ({ DomUtil: { setPosition: (_el, punto) => espia.positions.push(punto) } })

const montar = ({ stencil = true, ...opciones } = {}) => {
  host = { stencilOtorgado: stencil, contexts: 0, lost: 0, canvases: [], viewports: [], positions: [] }
  const map = makeMap(opciones)
  return { host, map, surface: new EditSurface({ L: makeL(host), map, pane: 'cristae-edit-0' }) }
}

const conDpr = (valor, fn) => {
  const previo = globalThis.devicePixelRatio
  globalThis.devicePixelRatio = valor
  try { fn() } finally { globalThis.devicePixelRatio = previo }
}

/* ── Esclusa del stencil ── */

test('la esclusa tira si el contexto no otorga stencil, y suelta el que no sirve', () => {
  const { surface, host: espia } = montar({ stencil: false })
  assert.throws(() => surface.attach(), /stencil/i)
  assert.equal(espia.lost, 1, 'no se queda con uno de los ~16 contextos en un camino que va a degradar')
  assert.equal(surface.gl, null, 'y la superficie no queda a medio construir')
})

test('con stencil otorgado, attach entrega el contexto y deja el viewport puesto', () => {
  const { surface, host: espia } = montar()
  const gl = surface.attach()
  assert.equal(espia.contexts, 1)
  assert.equal(gl.getContextAttributes().stencil, true)
  assert.deepEqual(espia.viewports, [{ x: 0, y: 0, w: 800, h: 600 }])
  assert.equal(espia.canvases[0].pane.hijos.length, 1, 'el canvas vive en el pane de la capa')
})

/* ── Ciclo de sesión: el contexto se crea UNA vez y no se recrea ── */

test('30 ciclos attach/park crean UN solo contexto', () => {
  const { surface, host: espia } = montar()
  for (let i = 0; i < 30; i++) { surface.attach(); surface.park() }
  assert.equal(espia.contexts, 1)
  assert.equal(espia.canvases.length, 1)
  assert.equal(espia.lost, 0, 'aparcar no suelta el contexto: sólo el drawing buffer')
})

test('park deja el canvas en 1×1 y attach lo restituye al tamaño del mapa', () => {
  const { surface, host: espia } = montar()
  surface.attach()
  const canvas = espia.canvases[0]
  assert.equal(canvas.width, 800)

  surface.park()
  assert.equal(surface.attached, false)
  assert.deepEqual([canvas.width, canvas.height], [1, 1])
  assert.equal(canvas.style.display, 'none')

  surface.attach()
  assert.deepEqual([canvas.width, canvas.height], [800, 600])
  assert.equal(canvas.style.display, '')
})

test('aparcada, resetCanvasReference no dimensiona ni reposiciona nada', () => {
  const { surface, host: espia } = montar()
  surface.attach()
  surface.park()
  const posiciones = espia.positions.length
  surface.resetCanvasReference()
  assert.equal(espia.positions.length, posiciones)
  assert.equal(espia.canvases[0].width, 1)
})

/* ── Receta Leaflet-canvas: posición por frame, realoque sólo cuando cambia el tamaño ── */

test('resetCanvasReference dimensiona por DPR y ancla el canvas al origen del contenedor', () => {
  conDpr(2, () => {
    const { surface, host: espia } = montar()
    surface.attach()
    const canvas = espia.canvases[0]
    assert.deepEqual([canvas.width, canvas.height], [1600, 1200], 'buffer en px de dispositivo')
    assert.deepEqual([canvas.style.width, canvas.style.height], ['800px', '600px'], 'caja CSS en px lógicos')
    assert.deepEqual(espia.positions.at(-1), DESPLAZAMIENTO)
  })
})

test('resetCanvasReference reposiciona siempre pero NO realoca el drawing buffer si el tamaño no cambió', () => {
  const { surface, host: espia } = montar()
  surface.attach()
  surface.resetCanvasReference()
  surface.resetCanvasReference()
  surface.resetCanvasReference()
  assert.equal(espia.viewports.length, 1, 'un solo realoque: `move` llega por frame durante un arrastre')
  assert.equal(espia.positions.length, 4, 'la posición sí se actualiza en cada llamada')
})

/* ── Teardown ── */

test('destroy() invoca loseContext exactamente UNA vez y es idempotente', () => {
  const { surface, host: espia } = montar()
  surface.attach()
  surface.destroy()
  assert.equal(espia.lost, 1)
  assert.equal(espia.canvases[0].pane, null, 'el canvas sale del pane')
  surface.destroy()
  assert.equal(espia.lost, 1, 'un segundo destroy no vuelve a pedirlo')
})

test('attach tras destroy tira: el contexto no se recrea', () => {
  const { surface, host: espia } = montar()
  surface.attach()
  surface.destroy()
  assert.throws(() => surface.attach(), /no se recrea/)
  assert.equal(espia.contexts, 1)
})

test('registra webglcontextlost (el probe reporta si el navegador soltó el contexto)', () => {
  const { surface, host: espia } = montar()
  surface.attach()
  assert.equal(surface.contextLost, false)
  espia.canvases[0].emit('webglcontextlost')
  assert.equal(surface.contextLost, true)
})
