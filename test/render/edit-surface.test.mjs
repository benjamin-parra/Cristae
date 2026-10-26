// Contrato de la superficie WebGL2 propia de una capa GPU, sobre un doble de gl: la esclusa del stencil (lo que
// evita que el relleno falle en silencio), el teardown que DEVUELVE el contexto, que tomarlo otra vez con uno
// vivo no consuma otro del techo del navegador (~16), y la re-adquisición: soltarlo o perderlo y volver a
// tomarlo en un canvas nuevo, en el lugar del viejo, con la capa avisada para rehacer su parte GL.

import { estiloTrasladado, oyentesDeVista } from '../../test-helpers/engine-stub.mjs'
import { after, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { EditSurface } from '../../src/render/EditSurface.js'
import { adoptLeafletHost } from '../../src/host/LeafletHost.js'

/* ── Dobles: canvas + gl + map, con el contador de contextos, de loseContext y de lo que se cuelga ── */

// El navegador puede otorgar MENOS de lo pedido: el doble separa lo SOLICITADO de lo CONCEDIDO
// (`stencilOtorgado`), que es exactamente la brecha que vigila la esclusa.
const makeGl = (espia, attrs) => ({
  getContextAttributes : () => ({ ...attrs, stencil: attrs.stencil && espia.stencilOtorgado }),
  getExtension         : nombre => (nombre === 'WEBGL_lose_context' ? { loseContext: () => { espia.lost++ } } : null),
  isContextLost        : () => espia.perdido,
  viewport             : (x, y, w, h) => espia.viewports.push({ x, y, w, h }),
})

// `traslados` son los transforms que la superficie le escribe al canvas, en orden: el ancla y los frames
// del zoom animado. `emit` reparte un evento cancelable, como el navegador, y lo devuelve; `replaceWith`
// pone otro canvas en el lugar de éste dentro del pane.
const makeCanvas = espia => {
  const canvas = {
    width: 0, height: 0, className: '', pane: null,
    style      : estiloTrasladado(t => espia.traslados.push(t)),
    listeners  : {},
    addEventListener(tipo, cb) { (canvas.listeners[tipo] ??= []).push(cb) },
    emit(tipo) {
      const evento = new Event(tipo, { cancelable: true })
      canvas.listeners[tipo]?.forEach(cb => cb(evento))
      return evento
    },
    remove()                   { canvas.pane = null },
    replaceWith(nuevo) {
      const hijos = canvas.pane.hijos
      hijos[hijos.indexOf(canvas)] = nuevo
      nuevo.pane  = canvas.pane
      canvas.pane = null
    },
    getContext(_kind, attrs)   { espia.contexts++; return makeGl(espia, attrs) },
  }
  espia.canvases.push(canvas)
  return canvas
}

let espiaVigente = null
globalThis.document = { createElement: () => makeCanvas(espiaVigente) }   // la superficie sólo pide canvas

// El pane NO está en el origen del contenedor: así el aserto de posicionamiento no es vacuo.
const DESPLAZAMIENTO = { x: -120, y: -40 }
const ZOOM_INICIAL   = 10
const P              = 100                              // proyección lineal del harness: un grado son 100 px a zoom 0

// Lo que el anfitrión le lee al mapa: la vista, la proyección, el marco y los panes por nombre.
const makeMap = ({ width = 800, height = 600 } = {}) => {
  const oyentes = new Map()
  const map = {
    zoom           : ZOOM_INICIAL,
    center         : { lat: 0, lng: 0 },
    _loaded        : true,
    _panes         : {},
    _paneRenderers : {},
    on             : (tipo, cb) => (oyentes.get(tipo) ?? oyentes.set(tipo, new Set()).get(tipo)).add(cb),
    off            : (tipo, cb) => oyentes.get(tipo)?.delete(cb),
    fire           : (tipo, e) => oyentes.get(tipo)?.forEach(cb => cb(e)),
    getContainer   : () => ({}),
    getSize        : () => ({ x: width, y: height }),
    getZoom        : () => map.zoom,
    getCenter      : () => map.center,
    project        : (ll, z) => ({ x: ll.lng * P * 2 ** z, y: ll.lat * P * 2 ** z }),
    getPane        : n => map._panes[n] ?? null,
    createPane     : n => {
      const pane = { hijos: [], style: {}, appendChild(c) { pane.hijos.push(c); c.pane = pane }, remove() {} }
      return (map._panes[n] = pane)
    },

    // El marco del paneo, corrido del origen del contenedor.
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

const PANE = 'cristae-edit-0'

// La capa dueña: anota con qué contexto construye y cuándo olvida lo suyo.
const makeOwner = () => {
  const owner = {
    avisos  : [],
    buildGl : gl => owner.avisos.push(['buildGl', gl]),
    dropGl  : () => owner.avisos.push(['dropGl']),
  }
  return owner
}

const montar = ({ stencil = true, owner = null, ...opciones } = {}) => {
  espiaVigente = { stencilOtorgado: stencil, perdido: false, contexts: 0, lost: 0, canvases: [], viewports: [], traslados: [] }
  const map     = makeMap(opciones)
  const host    = adoptLeafletHost(map)
  const oyentes = oyentesDeVista(host)
  return { espia: espiaVigente, host, map, oyentes, surface: new EditSurface({ host, pane: PANE, owner }) }
}

// La política no recupera una pérdida que llega hasta un segundo después de otra recuperación: el reloj avanza
// entre test y test para que cada uno empiece sin una reciente.
const reloj   = performance.now.bind(performance)
let   desfase = 0
performance.now = () => reloj() + desfase
beforeEach(() => { desfase += 10_000 })
after(() => { performance.now = reloj })

const cuadro = () => new Promise(r => setTimeout(r, 5))

const ANCLA = { ...DESPLAZAMIENTO, escala: 1 }

const conDpr = (valor, fn) => {
  const previo = globalThis.devicePixelRatio
  globalThis.devicePixelRatio = valor
  try { fn() } finally { globalThis.devicePixelRatio = previo }
}

/* ── Esclusa del stencil ── */

test('la esclusa tira si el contexto no otorga stencil, y suelta el que no sirve', () => {
  const { surface, espia, map, oyentes } = montar({ stencil: false })
  assert.throws(() => surface.acquire(), /stencil/i)
  assert.equal(espia.lost, 1, 'no se queda con uno de los ~16 contextos en un camino que va a degradar')
  assert.equal(surface.gl, null, 'y la superficie no queda a medio construir:')
  assert.equal(oyentes('zoomanim', 'zoomend'), 0, 'no oye la vista')
  assert.equal(map.getPane(PANE), null, 'ni sostiene su pane')
})

test('con stencil otorgado, acquire entrega el contexto y deja el viewport puesto', () => {
  const { surface, espia } = montar()
  const gl = surface.acquire()
  assert.equal(espia.contexts, 1)
  assert.equal(gl.getContextAttributes().stencil, true)
  assert.deepEqual(espia.viewports, [{ x: 0, y: 0, w: 800, h: 600 }])
  assert.equal(espia.canvases[0].pane.hijos.length, 1, 'el canvas vive en el pane de la capa')
})

/* ── Con el contexto vivo no se toma otro; soltarlo y volver a tomarlo es un canvas nuevo en el mismo lugar ── */

test('30 acquire con el contexto vivo crean UN solo contexto y lo devuelven', () => {
  const { surface, espia } = montar()
  const gl = surface.acquire()
  for (let i = 0; i < 30; i++) assert.equal(surface.acquire(), gl)
  assert.equal(espia.contexts, 1)
  assert.equal(espia.canvases.length, 1)
  assert.equal(espia.lost, 0)
})

test('release suelta el contexto en el acto, y acquire toma otro en un canvas nuevo en el lugar del viejo', () => {
  const { surface, espia, host } = montar()
  const vecino = { pane: null }
  surface.acquire()
  host.surface.mount(PANE).appendChild(vecino)        // otra capa que comparte el pane, después de ésta
  const [viejo] = espia.canvases
  const pane    = viejo.pane

  assert.equal(surface.release(), true)
  assert.equal(espia.lost, 1, 'el cupo vuelve al techo en el acto')
  assert.deepEqual([surface.state, surface.gl, surface.canvas], ['released', null, viejo], 'el canvas queda de marcador')
  assert.deepEqual(pane.hijos, [viejo, vecino])
  assert.equal(surface.release(), false, 'soltar la soltada no hace nada')

  const gl = surface.acquire()
  const [, nuevo] = espia.canvases
  assert.equal(espia.contexts, 2)
  assert.deepEqual([surface.state, surface.gl, surface.canvas], ['live', gl, nuevo])
  assert.deepEqual(pane.hijos, [nuevo, vecino], 'el nuevo ocupa el lugar del marcador: el orden en el pane no cambia')
  assert.deepEqual([nuevo.width, nuevo.height], [800, 600], 'y nace con el tamaño del mapa')
  assert.equal(espia.viewports.length, 2)
})

test('el canvas nuevo hereda del marcador si se ve', () => {
  const { surface, espia } = montar()
  surface.acquire()
  surface.canvas.style.display = 'none'                // la capa está oculta
  surface.release()
  surface.acquire()
  assert.equal(espia.canvases[1].style.display, 'none')
})

test('soltada, resetCanvasReference no dimensiona ni reposiciona nada', () => {
  const { surface, espia } = montar()
  surface.acquire()
  surface.release()
  const posiciones = espia.traslados.length
  espia.canvases[0].width = 0
  surface.resetCanvasReference()
  assert.equal(espia.traslados.length, posiciones)
  assert.equal(espia.canvases[0].width, 0)
})

/* ── Receta Leaflet-canvas: posición por frame, realoque sólo cuando cambia el tamaño ── */

test('resetCanvasReference dimensiona por DPR y ancla el canvas al origen del contenedor', () => {
  conDpr(2, () => {
    const { surface, espia } = montar()
    surface.acquire()
    const canvas = espia.canvases[0]
    assert.deepEqual([canvas.width, canvas.height], [1600, 1200], 'buffer en px de dispositivo')
    assert.deepEqual([canvas.style.width, canvas.style.height], ['800px', '600px'], 'caja CSS en px lógicos')
    assert.deepEqual(espia.traslados.at(-1), ANCLA)
  })
})

test('resetCanvasReference reposiciona siempre pero NO realoca el drawing buffer si el tamaño no cambió', () => {
  const { surface, espia } = montar()
  surface.acquire()
  surface.resetCanvasReference()
  surface.resetCanvasReference()
  surface.resetCanvasReference()
  assert.equal(espia.viewports.length, 1, 'un solo realoque: `move` llega por frame durante un arrastre')
  assert.equal(espia.traslados.length, 4, 'la posición sí se actualiza en cada llamada')
})

/* ── Zoom animado: el canvas CABALGA el transform (no se re-rasteriza por frame ni asienta al final) ── */

test('el canvas acompaña la transición del zoom animado del anfitrión', () => {
  const { surface, espia } = montar()
  surface.acquire()
  // Es lo que interpola el transform del zoom desde la esquina del canvas, de la que depende la escala;
  // sin eso el transform salta en vez de animar. El anfitrión lo hace con la clase de Leaflet.
  assert.match(espia.canvases[0].className, /\bleaflet-zoom-animated\b/)
})

test('el canvas re-adquirido también la acompaña, y la vista se oye una sola vez', () => {
  const { surface, espia, oyentes } = montar()
  surface.acquire()
  surface.release()
  surface.acquire()
  assert.match(espia.canvases[1].className, /\bleaflet-zoom-animated\b/)
  assert.equal(oyentes('zoomanim', 'zoomend'), 2)
})

test('en zoomanim el transform deja cada punto del contenido donde la vista destino lo pone', () => {
  const { surface, map, espia } = montar()
  surface.acquire()                                       // ancla: zoom 10, centro (0,0)
  const g     = { lat: 0.02, lng: 0.05 }                  // una coordenada cualquiera del contenido
  const antes = enContenedor(map, g, ZOOM_INICIAL, map.getCenter())

  const destino = { lat: 0.01, lng: -0.01 }
  map.animarZoom(ZOOM_INICIAL + 1, destino)

  // Composición del transform sobre el píxel que el punto ocupaba en el ancla (origen 0 0), llevada de
  // coordenadas de capa a las de contenedor. Debe coincidir con lo que proyecta la vista destino.
  const t        = espia.traslados.at(-1)
  const esperado = enContenedor(map, g, ZOOM_INICIAL + 1, destino)
  assert.equal(t.escala, 2, 'la escala es la del salto de zoom')
  assert.deepEqual([
    t.x + t.escala * antes.x - DESPLAZAMIENTO.x,
    t.y + t.escala * antes.y - DESPLAZAMIENTO.y,
  ], [esperado.x, esperado.y])
})

test('mientras anima, resetCanvasReference no reancla: el transform es de la animación', () => {
  const { surface, map, espia } = montar()
  surface.acquire()
  map.animarZoom(ZOOM_INICIAL + 1)
  const posiciones = espia.traslados.length
  surface.resetCanvasReference()
  assert.equal(espia.traslados.length, posiciones)
  assert.match(espia.canvases[0].style.transform, /scale/, 'la escala del frame sobrevive al redibujo')
})

test('al asentar, zoomend devuelve el ancla, suelta la escala y RECUERDA la vista nueva', () => {
  const { surface, map, espia } = montar()
  surface.acquire()
  map.animarZoom(ZOOM_INICIAL + 1)
  map.fire('zoomend')
  assert.deepEqual(espia.traslados.at(-1), ANCLA)
  assert.doesNotMatch(espia.canvases[0].style.transform, /scale/)

  // El ancla pasa a ser la vista asentada: el próximo frame escala desde ELLA (×2), no desde la inicial.
  espia.traslados.length = 0
  map.animarZoom(ZOOM_INICIAL + 2)
  assert.equal(espia.traslados.at(-1).escala, 2)
})

test('zooming dice si hay un zoom animado en curso: desde el zoomanim hasta el zoomend', () => {
  const { surface, map } = montar()
  assert.equal(surface.zooming, false, 'sin contexto no oye la vista')
  surface.acquire()
  assert.equal(surface.zooming, false, 'tampoco antes de que haya un zoom')
  map.animarZoom(ZOOM_INICIAL + 1)
  assert.equal(surface.zooming, true)
  map.animarZoom(ZOOM_INICIAL + 1)                      // un pellizco emite un zoomanim por cuadro
  assert.equal(surface.zooming, true)
  map.fire('zoomend')
  assert.equal(surface.zooming, false, 'el zoomend lo apaga en el acto')
})

test('un zoomanim al que nunca le llega el zoomend deja de contar a los 400 ms', () => {
  const { surface, map } = montar()
  surface.acquire()
  map.animarZoom(ZOOM_INICIAL + 1)
  desfase += 399
  assert.equal(surface.zooming, true)
  desfase += 2
  assert.equal(surface.zooming, false, 'una recuperación no se queda esperando un zoom que ya terminó')
})

test('zooming sigue la vista aunque la superficie esté perdida o soltada', () => {
  const { surface, map, espia } = montar()
  surface.acquire()
  surface.release()
  map.animarZoom(ZOOM_INICIAL + 1)                      // el canvas es un marcador: no hay transform que escribir
  assert.equal(surface.zooming, true, 'es lo que la recuperación necesita saber')
  assert.equal(espia.traslados.filter(t => t.escala === 2).length, 0)
  map.fire('zoomend')
  assert.equal(surface.zooming, false)
})

test('una superficie sin cssZoom no oye la vista: zooming vale siempre falso', () => {
  espiaVigente = { stencilOtorgado: true, perdido: false, contexts: 0, lost: 0, canvases: [], viewports: [], traslados: [] }
  const map     = makeMap()
  const surface = new EditSurface({ host: adoptLeafletHost(map), pane: PANE, cssZoom: false })
  surface.acquire()
  map.animarZoom(ZOOM_INICIAL + 1)
  assert.equal(surface.zooming, false, 'el motor la reproyecta por cuadro')
})

test('destroy desengancha del zoom animado y suelta su pane', () => {
  const { surface, map, oyentes } = montar()
  surface.acquire()
  assert.equal(oyentes('zoomanim', 'zoomend'), 2)
  surface.destroy()
  assert.equal(oyentes('zoomanim', 'zoomend'), 0)
  assert.equal(map.getPane(PANE), null, 'la superficie era la única que lo sostenía')
})

/* ── Teardown ── */

test('destroy() invoca loseContext exactamente UNA vez y es idempotente', () => {
  const { surface, espia, host, map } = montar()
  host.surface.mount(PANE)                                // otro que sostiene el mismo pane
  surface.acquire()
  surface.destroy()
  assert.equal(espia.lost, 1)
  assert.equal(espia.canvases[0].pane, null, 'el canvas sale del pane')
  surface.destroy()
  assert.equal(espia.lost, 1, 'un segundo destroy no vuelve a pedirlo')
  assert.ok(map.getPane(PANE), 'ni suelta el pane dos veces: el otro lo sigue sosteniendo')
})

test('acquire tras destroy tira: una destruida no se re-adquiere', () => {
  const { surface, espia } = montar()
  surface.acquire()
  surface.destroy()
  assert.throws(() => surface.acquire(), /no se re-adquiere/)
  assert.equal(espia.contexts, 1)
  assert.equal(surface.state, 'none')
})

test('registra webglcontextlost (el probe reporta si el navegador soltó el contexto)', () => {
  const { surface, espia } = montar()
  surface.acquire()
  assert.equal(surface.contextLost, false)
  espia.canvases[0].emit('webglcontextlost')
  assert.equal(surface.contextLost, true)
})

test('state dice si la superficie tiene su contexto, y cssZoom devuelve el que se pidió', () => {
  const { surface, espia, host } = montar()
  assert.equal(surface.state, 'none', 'antes de acquire no tiene contexto')
  assert.equal(surface.cssZoom, true, 'por defecto sigue la transición del zoom')
  assert.equal(new EditSurface({ host, pane: PANE, cssZoom: false }).cssZoom, false)

  surface.acquire()
  assert.equal(surface.state, 'live')
  espia.canvases[0].emit('webglcontextlost')
  assert.equal(surface.state, 'lost')
  assert.equal(surface.gl, null, 'perdida, no entrega el contexto muerto')

  surface.acquire()
  surface.release()
  assert.equal(surface.state, 'released')
  assert.equal(surface.contextLost, false, 'soltarla no es perderla')
})

test('state lee la pérdida del contexto, que la sabe en el acto: no espera al evento, que llega en otra tarea', () => {
  const { surface, espia } = montar()
  surface.acquire()
  espia.perdido = true
  assert.equal(surface.state, 'lost', 'isContextLost() ya es verdadero')
  assert.equal(surface.contextLost, false, 'la bandera del evento sigue en pie hasta que webglcontextlost llegue')

  espia.canvases[0].emit('webglcontextlost')
  assert.equal(surface.state, 'lost')
  assert.equal(surface.contextLost, true)
})

test('onState oye cada cambio con la superficie ya cambiada, y una destruida no avisa', () => {
  const { surface, espia } = montar()
  const avisos = []
  surface.onState = s => avisos.push([s.state, s.contextLost])
  surface.acquire()
  surface.acquire()                                       // con el contexto vivo no cambia nada
  assert.deepEqual(avisos, [['live', false]])

  espia.canvases[0].emit('webglcontextlost')
  surface.acquire()
  surface.release()
  assert.deepEqual(avisos.slice(1), [['lost', true], ['live', false], ['released', false]])

  surface.acquire()
  surface.destroy()
  espia.canvases[2].emit('webglcontextlost')              // el evento que el `loseContext` de destroy deja en camino
  assert.equal(avisos.length, 5)
})

/* ── El dueño: construye con cada contexto y olvida lo suyo al perderlo o soltarlo ── */

test('acquire avisa al dueño con el contexto nuevo, después de colgar y medir el canvas', () => {
  const owner = makeOwner()
  const { surface, espia } = montar({ owner })
  owner.buildGl = gl => owner.avisos.push(['buildGl', gl, surface.canvas.width, surface.state])
  const gl = surface.acquire()
  assert.deepEqual(owner.avisos, [['buildGl', gl, 800, 'live']])
  surface.acquire()
  assert.equal(owner.avisos.length, 1, 'con el contexto vivo no se construye de nuevo')
  assert.equal(espia.contexts, 1)
})

test('release avisa al dueño ANTES de soltar, y destroy no lo avisa: la capa se suelta sola', () => {
  const owner = makeOwner()
  const { surface, espia } = montar({ owner })
  owner.dropGl = () => owner.avisos.push(['dropGl', surface.state, espia.lost])
  surface.acquire()
  surface.release()
  assert.deepEqual(owner.avisos.slice(1), [['dropGl', 'live', 0]], 'olvida sus handles con el contexto todavía vivo')

  surface.acquire()
  surface.destroy()
  assert.equal(owner.avisos.length, 3, 'destroy no le avisa')
})

test('la pérdida avisa al dueño y nunca la cancela: sin preventDefault el navegador no queda esperando un restoreContext', () => {
  const owner = makeOwner()
  const { surface, espia } = montar({ owner })
  surface.acquire()
  const evento = espia.canvases[0].emit('webglcontextlost')
  assert.equal(evento.defaultPrevented, false)
  assert.deepEqual(owner.avisos.at(-1), ['dropGl'])
  assert.equal(surface.state, 'lost')
  surface.destroy()                                       // la re-adquisición pendiente no corre en el test siguiente
})

test('con dueño, la perdida se re-adquiere en el cuadro siguiente en un canvas nuevo, y el dueño construye con él', async () => {
  const owner = makeOwner()
  const { surface, espia } = montar({ owner })
  surface.acquire()
  espia.canvases[0].emit('webglcontextlost')
  assert.equal(espia.contexts, 1, 'no en la misma tarea del aviso')

  await cuadro()
  assert.equal(espia.contexts, 2)
  assert.equal(surface.state, 'live')
  assert.equal(surface.canvas, espia.canvases[1])
  assert.deepEqual(owner.avisos.map(([que]) => que), ['buildGl', 'dropGl', 'buildGl'])
  assert.equal(owner.avisos[2][1], surface.gl)
  surface.destroy()
})

test('perdida en pleno zoom animado, espera a que asiente y el canvas nuevo se ancla a la vista final', async () => {
  const owner = makeOwner()
  const { surface, espia, map } = montar({ owner })
  surface.acquire()
  map.animarZoom(ZOOM_INICIAL + 1)
  espia.canvases[0].emit('webglcontextlost')

  await cuadro()
  await cuadro()
  assert.equal(espia.contexts, 1, 'dos cuadros de zoom y todavía ningún getContext')
  assert.equal(surface.state, 'lost')

  map.fire('zoomend')
  await cuadro()
  assert.equal(espia.contexts, 2, 'asentó: vuelve')
  assert.equal(surface.state, 'live')
  assert.deepEqual(espia.traslados.at(-1), ANCLA, 'el canvas nuevo se ancla a la vista asentada, sin escala')
  surface.destroy()
})

test('sin dueño, la perdida se queda perdida', async () => {
  const { surface, espia } = montar()
  surface.acquire()
  espia.canvases[0].emit('webglcontextlost')
  await cuadro()
  assert.equal(espia.contexts, 1)
  assert.equal(surface.state, 'lost')
})

test('el aviso de un canvas ya reemplazado, o el que deja release, no es una pérdida', async () => {
  const owner = makeOwner()
  const { surface, espia } = montar({ owner })
  surface.acquire()
  surface.release()
  espia.canvases[0].emit('webglcontextlost')              // el que deja `loseContext`
  assert.equal(surface.state, 'released')

  surface.acquire()
  espia.canvases[0].emit('webglcontextlost')              // el del canvas reemplazado
  await cuadro()
  assert.equal(surface.state, 'live')
  assert.equal(espia.contexts, 2, 'ninguno se re-adquiere')
  assert.deepEqual(owner.avisos.map(([que]) => que), ['buildGl', 'dropGl', 'buildGl'])
  surface.destroy()
})

test('perdida sin aviso todavía, acquire toma otro y el dueño olvida lo viejo antes de construir', () => {
  const owner = makeOwner()
  const { surface, espia } = montar({ owner })
  surface.acquire()
  espia.perdido = true                                    // `isContextLost()` ya es verdadero
  surface.acquire()
  assert.equal(espia.contexts, 2)
  assert.deepEqual(owner.avisos.map(([que]) => que), ['buildGl', 'dropGl', 'buildGl'])
})

test('destruida mientras espera su turno, no se re-adquiere', async () => {
  const owner = makeOwner()
  const { surface, espia } = montar({ owner })
  surface.acquire()
  espia.canvases[0].emit('webglcontextlost')
  surface.destroy()
  await cuadro()
  assert.equal(espia.contexts, 1)
  assert.equal(surface.state, 'none')
})

test('sin quien oiga, la pérdida no rompe', () => {
  const { surface, espia } = montar()
  surface.acquire()
  assert.equal(surface.onState, null)
  assert.doesNotThrow(() => espia.canvases[0].emit('webglcontextlost'))
})
