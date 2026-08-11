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
    width: 0, height: 0, style: {}, className: '', pane: null,
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
const ZOOM_INICIAL   = 10
const P              = 100                              // proyección lineal del harness: un grado son 100 px a zoom 0

const makeMap = ({ width = 800, height = 600 } = {}) => {
  const panes    = new Map()
  const oyentes  = new Map()
  const map = {
    panes, oyentes,
    zoom       : ZOOM_INICIAL,
    center     : { lat: 0, lng: 0 },
    on         : (tipo, cb) => (oyentes.get(tipo) ?? oyentes.set(tipo, new Set()).get(tipo)).add(cb),
    off        : (tipo, cb) => oyentes.get(tipo)?.delete(cb),
    fire       : (tipo, e) => oyentes.get(tipo)?.forEach(cb => cb(e)),
    getSize    : () => ({ x: width, y: height }),
    getZoom    : () => map.zoom,
    getCenter  : () => map.center,
    getZoomScale: (a, b) => 2 ** (a - b),
    project    : (ll, z) => ({ x: ll.lng * P * 2 ** z, y: ll.lat * P * 2 ** z }),
    getPane    : n => panes.get(n) ?? null,
    createPane : n => {
      const pane = { hijos: [], appendChild(c) { pane.hijos.push(c); c.pane = pane } }
      panes.set(n, pane)
      return pane
    },
    containerPointToLayerPoint: ([x, y]) => ({ x: x + DESPLAZAMIENTO.x, y: y + DESPLAZAMIENTO.y }),
    // Un frame de zoom ANIMADO como lo hace Leaflet: emite `zoomanim` con la vista DESTINO y recién
    // DESPUÉS mueve la vista viva. Durante la transición CSS `getZoom`/`getCenter` ya son las del destino
    // —por eso una capa que se reproyecte contra el mapa vivo aterriza en el final y se teletransporta—.
    animarZoom(zoom, center = map.center) {
      map.fire('zoomanim', { zoom, center })
      map.zoom   = zoom
      map.center = center
      return map
    },
  }
  return map
}

// El punto de contenedor que una vista (zoom, center) le asigna a una coordenada: el patrón de medida
// contra el que se compara el transform de la animación.
const enContenedor = (map, ll, zoom, center) => ({
  x: map.project(ll, zoom).x - map.project(center, zoom).x + map.getSize().x / 2,
  y: map.project(ll, zoom).y - map.project(center, zoom).y + map.getSize().y / 2,
})

const makeL = espia => ({
  point   : (x, y) => ({ x, y }),
  DomUtil : {
    setPosition  : (el, punto) => {
      espia.positions.push(punto)
      el.style.transform = `translate3d(${punto.x}px, ${punto.y}px, 0)`
    },
    setTransform : (el, punto, escala) => {
      espia.transforms.push({ x: punto.x, y: punto.y, escala })
      el.style.transform = `translate3d(${punto.x}px, ${punto.y}px, 0) scale(${escala})`
    },
  },
})

const montar = ({ stencil = true, ...opciones } = {}) => {
  host = { stencilOtorgado: stencil, contexts: 0, lost: 0, canvases: [], viewports: [], positions: [], transforms: [] }
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

/* ── Zoom animado: el canvas CABALGA el transform (no se re-rasteriza por frame ni asienta al final) ── */

test('el canvas es un elemento zoom-animado de Leaflet', () => {
  const { surface, host: espia } = montar()
  surface.attach()
  // La clase es lo que le aplica la transición CSS del pane y el `transform-origin: 0 0` del que depende
  // la escala; sin ella el transform salta en vez de animar.
  assert.match(espia.canvases[0].className, /\bleaflet-zoom-animated\b/)
})

test('en zoomanim el transform deja cada punto del contenido donde la vista destino lo pone', () => {
  const { surface, map, host: espia } = montar()
  surface.attach()                                        // ancla: zoom 10, centro (0,0)
  const g     = { lat: 0.02, lng: 0.05 }                  // una coordenada cualquiera del contenido
  const antes = enContenedor(map, g, ZOOM_INICIAL, map.getCenter())

  const destino = { lat: 0.01, lng: -0.01 }
  map.animarZoom(ZOOM_INICIAL + 1, destino)

  // Composición del transform sobre el píxel que el punto ocupaba en el ancla (origen 0 0), llevada de
  // coordenadas de capa a las de contenedor. Debe coincidir con lo que proyecta la vista destino.
  const t        = espia.transforms.at(-1)
  const esperado = enContenedor(map, g, ZOOM_INICIAL + 1, destino)
  assert.equal(t.escala, 2, 'la escala es la del salto de zoom')
  assert.deepEqual([
    t.x + t.escala * antes.x - DESPLAZAMIENTO.x,
    t.y + t.escala * antes.y - DESPLAZAMIENTO.y,
  ], [esperado.x, esperado.y])
})

test('mientras anima, resetCanvasReference no reancla: el transform es de la animación', () => {
  const { surface, map, host: espia } = montar()
  surface.attach()
  map.animarZoom(ZOOM_INICIAL + 1)
  const posiciones = espia.positions.length
  surface.resetCanvasReference()
  assert.equal(espia.positions.length, posiciones)
  assert.match(espia.canvases[0].style.transform, /scale/, 'la escala del frame sobrevive al redibujo')
})

test('al asentar, zoomend devuelve el ancla, suelta la escala y RECUERDA la vista nueva', () => {
  const { surface, map, host: espia } = montar()
  surface.attach()
  map.animarZoom(ZOOM_INICIAL + 1)
  map.fire('zoomend')
  assert.deepEqual(espia.positions.at(-1), DESPLAZAMIENTO)
  assert.doesNotMatch(espia.canvases[0].style.transform, /scale/)

  // El ancla pasa a ser la vista asentada: el próximo frame escala desde ELLA (×2), no desde la inicial.
  espia.transforms.length = 0
  map.animarZoom(ZOOM_INICIAL + 2)
  assert.equal(espia.transforms.at(-1).escala, 2)
})

test('destroy desengancha del zoom del mapa', () => {
  const { surface, map } = montar()
  surface.attach()
  surface.destroy()
  assert.equal(map.oyentes.get('zoomanim').size, 0)
  assert.equal(map.oyentes.get('zoomend').size, 0)
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
