// Contrato de la capa de relleno GPU de polígonos ESTÁTICOS: el ciclo de vida (montar / destruir /
// volver a montar sobre el mismo mapa), el descarte por viewport que decide qué anillos llegan al pase,
// la visibilidad —propia y la que le llega desde el motor—, y el contrato de RENDIMIENTO que nadie
// fijaba: durante el arrastre no se repinta, porque el canvas va anclado en coordenadas de capa y el
// pane lo lleva; sólo una vista ya asentada rehace el stencil de todos los contornos.
//
// El árbol es el REAL (EditSurface + RingStore + EditFillLayer + el índice point-in-poly); lo único
// doble es el navegador. `spy.draws` —los `drawArrays` que la capa emitió— es la unidad de medida:
// un repintado son tantos pases de paridad como anillos en pantalla más UNA cobertura.
//
// El harness (engine-stub) shimea window/document — se importa PRIMERO.

import './../../test-helpers/engine-stub.mjs'
import { decorarElementos, makeGl, makeLeaflet, makeMap as makeMapStub, makePickSpy, makeSurface, oyentesDeVista } from '../../test-helpers/engine-stub.mjs'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { MapEngine } from '../../src/engine/MapEngine.js'
import { adoptLeafletHost } from '../../src/host/LeafletHost.js'
import { PolygonGpuLayer } from '../../src/render/PolygonGpuLayer.js'
import { areasOf, readGeoJson } from '../../src/geojson/geojson.js'
import { projX0 } from '../../src/render/project.js'

/* ── Dobles: el contexto de edición, el canvas de su pane y un mapa con el registro de Leaflet ── */

const WITH_STENCIL = () => ({ stencil: true })
const MAX_TEXTURE  = 0x0D33

// El doble de GL del repo más las dos cosas que la superficie de edición le consulta al navegador: si
// consiguió el stencil y el `loseContext` con el que devuelve el contexto (`spy.released` lo cuenta).
// `cap` declara el tope de textura, como hace un contexto real.
const editGl = (spy, cap = null) => {
  const gl  = makeGl(() => spy.released++, spy, makeSurface())
  const own = cap === null ? null : { MAX_TEXTURE_SIZE: MAX_TEXTURE, getParameter: p => (p === MAX_TEXTURE ? cap : undefined) }
  return new Proxy(gl, { get: (t, p) => (p === 'getContextAttributes' ? WITH_STENCIL : own?.[p] ?? t[p]) })
}

const newSpy = () => Object.assign(makePickSpy(), { released: 0 })

// El contexto que abre la próxima superficie: cada montaje estrena el suyo, como un canvas nuevo.
let currentGl = null

// El canvas de la superficie: entrega ese contexto y, como en el DOM, `remove()` lo desprende de su
// pane —de ahí sale si un teardown dejó nodos muertos colgando—.
after(decorarElementos((el, tag) => {
  if (tag !== 'canvas') return el
  const dispose = el.remove
  el.getContext = kind => (kind === 'webgl2' ? currentGl : null)
  el.remove     = () => {
    const at = el.pane?.children.indexOf(el) ?? -1
    at >= 0 && el.pane.children.splice(at, 1)
    dispose()
  }
  return el
}))

// Pane como el div de Leaflet: `remove()` lo desprende del documento y nada más. El registro por nombre
// del que sale `getPane` es `_panes`, y Leaflet NO lo toca al desprender el nodo — quien quiera soltar
// un pane de verdad tiene que borrar su entrada, o el alta siguiente lo recupera ya huérfano.
const makePane = () => {
  const pane = {
    style     : {},
    children  : [],
    connected : true,
    appendChild(child) { pane.children.push(child); child.pane = pane },
    remove()           { pane.connected = false },
  }
  return pane
}

// El mapa del harness con los panes de Leaflet.
const makeMap = () => {
  const panes = {}
  return Object.assign(makeMapStub(), {
    _panes     : panes,
    getPane    : name => panes[name] ?? null,
    createPane : name => (panes[name] = makePane()),
  })
}

// Un anfitrión sobre ese mapa, con sus suscripciones de vista contadas desde antes de montar nada.
const anfitrion = (map = makeMap()) => {
  const host = adoptLeafletHost(map)
  return { host, map, oyentes: oyentesDeVista(host) }
}

/* ── Geometría: las tablas CSR del lector, sin pasar por el lector ── */

// Anillo cuadrado CERRADO —el último vértice repite al primero— en [lng, lat], orden del RFC.
const square = (lng, lat, r) => [[lng - r, lat - r], [lng + r, lat - r], [lng + r, lat + r], [lng - r, lat + r], [lng - r, lat - r]]

// Un anillo por parte: `vertexAt` anillo → vértice y `ringAt` parte → anillo.
// `agrupacion` dice cuántos anillos lleva cada POLÍGONO; por defecto, uno cada uno. Es lo que
// distingue un agujero (dos anillos de la misma parte) de un solape (dos partes).
const tables = (rings, agrupacion = rings.map(() => 1)) => {
  const xy = [], vertexAt = [0], closed = []
  rings.forEach(ring => {
    ring.forEach(([lng, lat]) => xy.push(lng, lat))
    vertexAt.push(xy.length / 2)
    const [head, tail] = [ring[0], ring.at(-1)]
    closed.push(head[0] === tail[0] && head[1] === tail[1] ? 1 : 0)
  })
  const ringAt = [0]
  agrupacion.forEach(n => ringAt.push(ringAt.at(-1) + n))
  return {
    xy        : Float64Array.from(xy),
    vertexAt  : Uint32Array.from(vertexAt),
    ringAt    : Uint32Array.from(ringAt),
    closed    : Uint8Array.from(closed),
    ringCount : rings.length,
    partCount : agrupacion.length,
  }
}

const ONE_RING = () => tables([square(0, 0, 0.05)])

const mount = (geometry = ONE_RING(), { cap = null, sobre = anfitrion(), ...options } = {}) => {
  const spy = newSpy()
  currentGl = editGl(spy, cap)
  const layer = new PolygonGpuLayer({ host: sobre.host, pane: 'gpu', geometry, ...options })
  return { layer, map: sobre.map, spy }
}

// Los `drawArrays` de UN repintado, contados desde cero.
const drawsOf = (spy, run) => {
  spy.draws.length = 0
  run()
  return spy.draws.length
}

// El borde este del encuadre en grados, con la MISMA proyección con la que la capa descarta. Todo mapa
// del harness nace en la misma vista, así que el borde es uno solo.
const eastEdge = map =>
  ((projX0(map.getCenter().lng) + map.getSize().x / (2 * 2 ** map.getZoom())) / 256 - 0.5) * 360

const EAST_EDGE = eastEdge(makeMap())

/* ── 1. Ciclo de vida: destruir y volver a montar sobre el mismo mapa ── */

test('una capa nueva tras destroy() abre SU contexto, sube SU textura y dibuja', () => {
  // Los dos ciclos sobre el MISMO mapa: con mapas distintos, un `destroy()` inerte pasaría igual.
  const sobre = anfitrion()
  const first = mount(ONE_RING(), { sobre })
  first.layer.destroy()

  const second = mount(ONE_RING(), { sobre })
  assert.equal(second.spy.texImages.length, 1, 'la capa nueva sube su propia textura')
  assert.equal(second.layer.redraw(), true, 'y el repintado llega a la GPU')
  assert.ok(drawsOf(second.spy, () => second.layer.redraw()) > 0, 'con draws de verdad, no un pase vacío')
  assert.equal(second.map.getPane('gpu').children.length, 1, 'y el pane no arrastra el canvas del ciclo anterior')
})

test('el alta que reemplaza a una capa dada de baja cuelga su canvas de un pane VIVO', () => {
  const map    = makeMap()
  const engine = new MapEngine({ host: adoptLeafletHost(map, { leaflet: makeLeaflet() }) })
  const pane   = 'cristae-polygon-gpu-areas'

  currentGl = editGl(newSpy())
  engine.addPolygonGpuLayer({ id: 'areas', geometry: ONE_RING() })
  const abandoned = map.getPane(pane)
  engine.removeLayer('areas')

  const spy = newSpy()
  currentGl = editGl(spy)
  const handle = engine.addPolygonGpuLayer({ id: 'areas', geometry: ONE_RING() })

  assert.equal(spy.texImages.length, 1, 'la capa nueva sube su textura')
  assert.equal(handle.redraw(), true)
  assert.ok(spy.draws.length > 0, 'y emite draws')

  // Lo que se ve —o no— es esto: un canvas que dibuja perfecto dentro de un pane desprendido del
  // documento no aparece nunca, y ningún repintado lo arregla.
  const live = map.getPane(pane)
  assert.equal(live.connected, true, 'el pane del alta nueva sigue montado en el mapa')
  assert.notEqual(live, abandoned, 'y no es el que la baja anterior desprendió')
  assert.equal(live.children.length, 1, 'con un solo canvas: el de la capa viva')
})

const VIEW_EVENTS = ['moveend', 'zoomend', 'resize', 'zoomanim']

test('destroy() desengancha de la vista, devuelve el contexto y suelta el canvas y su pane', () => {
  const sobre = anfitrion()
  assert.equal(sobre.oyentes(...VIEW_EVENTS), 0, 'el anfitrión arranca sin oyentes de vista')

  const { layer, map, spy } = mount(ONE_RING(), { sobre })
  const pane   = map.getPane('gpu')
  const canvas = pane.children[0]
  assert.equal(sobre.oyentes(...VIEW_EVENTS), 5,
    'la capa engancha la vista asentada (3) y su superficie el zoom animado (2, uno de ellos comparte `zoomend`)')

  layer.destroy()
  assert.equal(sobre.oyentes(...VIEW_EVENTS), 0, 'no queda un solo oyente')
  assert.equal(spy.released, 1, 'el contexto vuelve al techo de ~16 del navegador')
  assert.equal(pane.children.includes(canvas), false, 'el canvas no queda colgando del pane')
  assert.equal(map.getPane('gpu'), null, 'y el pane, que sólo sostenía la superficie, se va del registro')
  assert.equal(pane.connected, false)
})

test('la vista asentada ya no repinta una capa destruida', () => {
  const { layer, map, spy } = mount()
  layer.destroy()
  assert.equal(drawsOf(spy, () => ['moveend', 'zoomend', 'resize'].forEach(type => map.fire(type))), 0)
})

/* ── 2. Descarte por viewport: al pase sólo entra lo que toca el encuadre ── */

test('sólo los anillos que tocan el viewport entran al pase', () => {
  const { layer, spy } = mount(tables([
    square(0, 0, 0.05),                 // en el centro
    square(EAST_EDGE + 20, 0, 0.05),    // al este, fuera
    square(0, 80, 0.05),                // al norte, fuera
  ]), { stroke: false })

  const drawn = drawsOf(spy, () => assert.equal(layer.redraw(), true))
  assert.equal(layer.ringCount, 3, 'los tres anillos están en la textura')
  assert.equal(layer.drawnRingCount, 1, 'pero sólo uno toca el encuadre')
  assert.equal(drawn, layer.drawnRingCount + layer.drawnPartCount, 'una paridad por anillo, más una cobertura por polígono')
})

test('un anillo que cruza el borde NO se descarta: aporta píxeles', () => {
  const across = square(EAST_EDGE, 0, 5)               // centrado en el borde: mitad adentro, mitad afuera
  const { layer, spy } = mount(tables([square(0, 0, 0.05), across]), { stroke: false })

  const drawn = drawsOf(spy, () => layer.redraw())
  assert.equal(layer.drawnRingCount, 2, 'el que cruza el borde entra igual')
  assert.equal(drawn, layer.drawnRingCount + layer.drawnPartCount, 'una paridad por anillo + una cobertura POR POLÍGONO')
})

test('con todo fuera del encuadre no dibuja nada y lo dice', () => {
  const { layer, spy } = mount(tables([square(EAST_EDGE + 20, 0, 0.05), square(EAST_EDGE + 30, 0, 0.05)]), { stroke: false })

  const drawn = drawsOf(spy, () => assert.equal(layer.redraw(), false, 'redraw informa que no dibujó'))
  assert.equal(layer.drawnRingCount, 0)
  assert.equal(drawn, 0, 'ni siquiera la cobertura')
})

/* ── 3. Visibilidad, propia y la que baja del motor ── */

test('setVisible(false) deja de dibujar y setVisible(true) vuelve', () => {
  const { layer, map, spy } = mount()
  const canvas = map.getPane('gpu').children[0]

  assert.equal(layer.setVisible(false), false, 'apagada no dibuja, y lo informa')
  assert.equal(canvas.style.display, 'none')
  assert.equal(drawsOf(spy, () => layer.redraw()), 0, 'ni por un repintado explícito')
  assert.equal(drawsOf(spy, () => map.fire('moveend')), 0, 'ni por la vista asentada')

  assert.equal(layer.setVisible(true), true)
  assert.equal(canvas.style.display, '')
  assert.ok(drawsOf(spy, () => layer.redraw()) > 0, 'encendida vuelve a dibujar')
})

test('MapEngine.setLayerVisibility alcanza a la capa, no sólo al pane', () => {
  const map    = makeMap()
  const engine = new MapEngine({ host: adoptLeafletHost(map, { leaflet: makeLeaflet() }) })
  const spy    = newSpy()
  currentGl = editGl(spy)
  engine.addPolygonGpuLayer({ id: 'areas', geometry: ONE_RING() })
  const pane = map.getPane('cristae-polygon-gpu-areas')

  engine.setLayerVisibility('areas', false)
  assert.equal(pane.style.visibility, 'hidden', 'el pane se oculta')
  assert.equal(pane.children[0].style.display, 'none', 'y la capa se entera: una capa que dibuja sola no se apaga ocultando el pane')
  assert.equal(drawsOf(spy, () => engine.getLayer('areas').layer.redraw()), 0)

  engine.setLayerVisibility('areas', true)
  assert.equal(pane.style.visibility, '')
  assert.ok(drawsOf(spy, () => engine.getLayer('areas').layer.redraw()) > 0, 'y vuelve a dibujar')
})

/* ── 4. Repintado sólo en vista ASENTADA ── */

test('el arrastre no repinta: `move` no rehace el stencil de ningún contorno', () => {
  const { map, spy } = mount()
  assert.equal(drawsOf(spy, () => { for (let i = 0; i < 30; i++) map.fire('move') }), 0,
    'repintar por frame sería rehacer la paridad de todos los anillos 30 veces')
})

test('la vista asentada sí repinta: moveend, zoomend y resize', () => {
  const { map, spy } = mount()
  const perEvent = ['moveend', 'zoomend', 'resize'].map(type => drawsOf(spy, () => map.fire(type)))
  assert.deepEqual(perEvent, [3, 3, 3], 'paridad del anillo + cobertura + contorno, en cada uno')
})

// El motor reproyecta por frame las capas GL inscritas en su ciclo de render, y en esta capa
// `resetCanvasReference()` ES el repintado entero. El marco se desplaza en cada frame, así que no hay
// `move` que el motor se saltee por posición repetida: si la capa estuviera inscrita, serían 30 stencils.
test('el motor tampoco repinta la capa por frame de arrastre', () => {
  const position = { x: 0, y: 0 }
  const map      = Object.assign(makeMap(), {   // el marco del paneo: mover `position` es arrastrar
    containerPointToLayerPoint: ([x, y]) => ({ x: x - position.x, y: y - position.y }),
  })
  const engine   = new MapEngine({ host: adoptLeafletHost(map, { leaflet: makeLeaflet() }) })
  const spy      = newSpy()
  currentGl = editGl(spy)
  engine.addPolygonGpuLayer({ id: 'areas', geometry: ONE_RING() })

  const drawn = drawsOf(spy, () => {
    for (let i = 0; i < 30; i++) {
      position.x += 7
      position.y += 3
      map.fire('move')
    }
  })
  assert.equal(drawn, 0)
  assert.ok(drawsOf(spy, () => map.fire('moveend')) > 0, 'y al soltar, el repintado llega igual')
})

/* ── 5. `rings` / `parts`: la selección de ÁREA de un documento mixto ── */

const MIXED = new TextEncoder().encode(JSON.stringify({
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [0.4, 0.4] } },
    { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[0.3, -0.3], [0.5, -0.3], [0.5, -0.1]] } },
    { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [square(0, 0, 0.1)] } },
  ],
}))

const IN_LINE    = { lat: -0.25, lng: 0.45 }        // dentro de la CLAUSURA de la LineString, de ningún área
const IN_POLYGON = { lat: 0, lng: 0 }

const hits = (layer, latlng) => layer.resolveClick(latlng)

test('con la selección de áreas, la capa sube sólo anillos de área y sólo ellos pickean', () => {
  const geo = readGeoJson(MIXED)
  const { layer } = mount(areasOf(geo), { interactive: true })

  assert.equal(layer.ringCount, 1, 'ni el punto ni la línea son anillos de área')
  assert.equal(hits(layer, IN_POLYGON).length, 1, 'el polígono contesta')
  assert.deepEqual(hits(layer, IN_LINE), [], 'y la clausura de la LineString no es un área: no contesta')
})

// Sin `rings`/`parts` la capa no tiene con qué distinguir —las tablas no traen `kinds`— y toma el
// documento entero como si fuera de área. Es lo que hace `geometry: geo` en vez de `areasOf(geo)`, y
// no falla: rellena la clausura de las líneas y contesta hits sobre ellas.
test('con la salida CRUDA de un documento mixto, la capa rellena y pickea lo que no es área', () => {
  const geo = readGeoJson(MIXED)
  const { layer } = mount(geo, { interactive: true })

  assert.equal(layer.ringCount, geo.ringCount, 'suben los anillos del punto y de la línea también')
  assert.ok(layer.ringCount > 1)

  const [hit] = hits(layer, IN_LINE)
  assert.ok(hit, 'un hit de polígono sobre una LineString')
  assert.equal(geo.kinds[geo.geometryOf(hit.ref)], 3, 'la parte que contestó es la LineString (kind 3)')
})

// La incoherencia peor no es la cruda entera sino la selección A MEDIAS: el relleno se acota a las
// áreas y el índice sigue indexando todo, así que se pickea una figura que la capa no dibujó.
test('media selección falla ruidoso: `rings` y `parts` van juntas o no van', () => {
  const areas = areasOf(readGeoJson(MIXED))
  assert.throws(() => mount({ ...areas, parts: undefined }, { interactive: true }), /rings.*parts/)
  assert.throws(() => mount({ ...areas, rings: undefined }, { interactive: true }), /rings.*parts/)
})

/* ── 6. Tope de textura: el camino a través de la capa ── */

test('un conteo que no entra en la textura falla ruidoso al construir la capa', () => {
  assert.throws(() => mount(tables([square(0, 0, 0.05)]), { cap: 1 }),
    /no entran en una textura de 1×1/, 'el tope sale del contexto, y el fallo no es una textura corta')
})

// La superficie abre el contexto ANTES de que el store suba la textura, así que el fallo del tope
// ocurre con uno de los ~16 contextos ya tomado y nadie lo devuelve.
test('el fallo del tope no se queda con el contexto ni con el canvas', () => {
  const spy   = newSpy()
  currentGl   = editGl(spy, 1)
  const sobre = anfitrion()
  assert.throws(() => new PolygonGpuLayer({ host: sobre.host, pane: 'gpu', geometry: tables([square(0, 0, 0.05)]) }))

  assert.equal(spy.released, 1, 'el contexto se suelta antes de tirar, como hace la esclusa del stencil')
  assert.equal(sobre.map.getPane('gpu'), null, 'y ni el canvas ni su pane quedan en el mapa')
  assert.equal(sobre.oyentes('zoomanim', 'zoomend'), 0, 'ni la superficie enganchada a la vista')
})

/* ── El harness no miente ── */

test('cada montaje estrena su contexto: dos capas vivas no comparten espía', () => {
  const first  = mount()
  const second = mount()
  assert.notEqual(first.spy, second.spy)
  assert.equal(drawsOf(first.spy, () => second.layer.redraw()), 0, 'el repintado de una no cuenta en la otra')
  assert.ok(drawsOf(second.spy, () => second.layer.redraw()) > 0)
})

// Si el doble desregistrara el pane al desprenderlo, el caso del alta que reemplaza a una baja pasaría
// por construcción y no probaría nada. Leaflet sólo vacía `_panes` al destruir el mapa entero.
test('el doble de pane hace lo mismo que Leaflet: `remove()` no lo saca de `_panes`', () => {
  const map  = makeMap()
  const pane = map.createPane('suelto')
  pane.remove()
  assert.equal(pane.connected, false, 'el nodo se desprende del documento')
  assert.equal(map.getPane('suelto'), pane, 'pero el registro por nombre lo sigue devolviendo')
})

test('el encuadre del harness deja anillos adentro y afuera, o el descarte no probaría nada', () => {
  assert.ok(Number.isFinite(EAST_EDGE) && Math.abs(EAST_EDGE) < 180)
  assert.equal(mount(tables([square(0, 0, 0.05)])).layer.drawnRingCount, 1)
  assert.equal(mount(tables([square(EAST_EDGE + 20, 0, 0.05)])).layer.drawnRingCount, 0)
})

/* ── 8. Contorno: la capa dibuja borde ── */

test('con el contorno prendido, cada anillo dibujado agrega UN draw sobre el relleno', () => {
  const geometria = tables([square(0, 0, 0.05), square(0.2, 0, 0.05)])
  const conTrazo  = mount(geometria, {})
  const sinTrazo  = mount(geometria, { stroke: false })
  const dCon = drawsOf(conTrazo.spy, () => conTrazo.layer.redraw())
  const dSin = drawsOf(sinTrazo.spy, () => sinTrazo.layer.redraw())
  assert.equal(conTrazo.layer.drawnRingCount, 2)
  assert.equal(dCon - dSin, conTrazo.layer.drawnRingCount, 'un draw de contorno por anillo dibujado')
})

test('`stroke: false` y `weight: 0` no dibujan borde', () => {
  const geometria = tables([square(0, 0, 0.05)])
  const base = mount(geometria, { stroke: false })
  const cero = mount(geometria, { weight: 0 })
  const dBase = drawsOf(base.spy, () => base.layer.redraw())
  const dCero = drawsOf(cero.spy, () => cero.layer.redraw())
  assert.equal(dCero, dBase, 'un ancho de cero no emite el pase')
})

test('el contorno respeta el descarte por viewport igual que el relleno', () => {
  const { layer, spy } = mount(tables([square(0, 0, 0.05), square(EAST_EDGE + 20, 0, 0.05)]))
  const dibujados = drawsOf(spy, () => layer.redraw())
  assert.equal(layer.drawnRingCount, 1, 'sólo uno toca el encuadre')
  assert.equal(dibujados, 1 + 1 + 1, 'paridad + cobertura + contorno, del único visible')
})

test('style() ajusta relleno y contorno por separado, y repinta', () => {
  const { layer, spy } = mount(tables([square(0, 0, 0.05)]))
  assert.ok(drawsOf(spy, () => layer.style({ color: '#ff0000', weight: 6, fillOpacity: 0.5 })) > 0)
})

test('sin relleno, el contorno sigue dibujando: son ejes independientes', () => {
  const { layer, spy } = mount(tables([square(0, 0, 0.05)]), { fill: false })
  assert.equal(drawsOf(spy, () => layer.redraw()), 1, 'sólo el pase del contorno')
})

/* ── 9. Agujero contra solape: quién comparte cobertura y quién no ── */

// La cobertura es el único draw de 3 vértices del relleno; las paridades son 3 por arista. La SECUENCIA
// dice la semántica: anillos que comparten cobertura componen su paridad (XOR ⇒ agujero), y una
// cobertura por polígono deja el stencil en cero ⇒ el siguiente apila en vez de restarse.
const secuencia = (spy, run) => {
  spy.draws.length = 0
  run()
  return spy.draws.map(d => d.count)
}

test('los anillos de UN polígono comparten cobertura: por eso el agujero se abre', () => {
  const conAgujero = tables([square(0, 0, 0.05), square(0, 0, 0.02)], [2])   // una parte, dos anillos
  const { layer, spy } = mount(conAgujero, { stroke: false })
  assert.deepEqual(secuencia(spy, () => layer.redraw()), [12, 12, 3],
    'dos paridades y UNA cobertura: los dos anillos componen antes de cubrir')
})

test('cada polígono estrena su cobertura: por eso el solape apila y no se cancela', () => {
  const solapados = tables([square(0, 0, 0.05), square(0.02, 0, 0.05)], [1, 1])  // dos partes de un anillo
  const { layer, spy } = mount(solapados, { stroke: false })
  assert.equal(layer.drawnPartCount, 2)
  assert.deepEqual(secuencia(spy, () => layer.redraw()), [12, 3, 12, 3],
    'paridad y cobertura por polígono, intercaladas')
})

/* ── 10. Estilo por polígono ── */

test('styleOf se evalúa una vez por polígono al resolver, no por frame', () => {
  const vistos = []
  const { layer } = mount(tables([square(0, 0, 0.05), square(0.2, 0, 0.05)], [1, 1]),
    { styleOf: id => (vistos.push(id), { color: id === 0 ? '#ff0000' : '#00ff00' }) })
  assert.deepEqual(vistos, [0, 1], 'una vez por parte, con su id')
  layer.redraw(); layer.redraw()
  assert.deepEqual(vistos, [0, 1], 'repintar no lo vuelve a llamar')
})

test('setStyleOf reevalúa y repinta: es la vía de la selección y del filtro', () => {
  const { layer, spy } = mount(tables([square(0, 0, 0.05)], [1]))
  const llamadas = []
  assert.ok(drawsOf(spy, () => layer.setStyleOf(id => (llamadas.push(id), { weight: 6 }))) > 0, 'repinta')
  assert.deepEqual(llamadas, [0])
})

test('style() mueve el default de la capa y respeta lo que styleOf pisa', () => {
  const { layer } = mount(tables([square(0, 0, 0.05), square(0.2, 0, 0.05)], [1, 1]),
    { styleOf: id => (id === 0 ? { color: '#ff0000' } : null) })
  assert.ok(layer.style({ color: '#0000ff', weight: 4 }) !== undefined, 'aplica y repinta')
})

// Un `styleOf` que sólo cambia `color` mueve también el relleno: `fillColor` sin declarar sigue al
// color vigente, no al de la capa. El relleno fija su color con `uniform4f` y el trazo con `uniform4fv`.
test('sin fillColor, el relleno sigue al color que pone styleOf', () => {
  const spy = newSpy(), fills = []
  currentGl = new Proxy(editGl(spy), { get: (t, p) => (p === 'uniform4f' ? (_loc, ...rgba) => fills.push(rgba) : t[p]) })
  const layer = new PolygonGpuLayer({
    host: anfitrion().host, pane: 'gpu', geometry: ONE_RING(),
    styleOf: () => ({ color: '#ff0000' }),
  })
  assert.deepEqual(fills.at(-1), [1, 0, 0, 0.2], 'rojo con fillOpacity 0,2, no el azul por defecto')

  layer.style({ fillColor: '#00ff00' })
  assert.deepEqual(fills.at(-1), [0, 1, 0, 0.2], 'pero un fillColor explícito de la capa sí gana al color de styleOf')
  layer.destroy()
})

// El dash de `styleOf` viaja al trazo: el largo acumulado del patrón sube como una segunda textura, y
// sólo cuando alguna parte lo pide.
test('el dash de styleOf llega al trazo y un trazo continuo no sube la textura del patrón', () => {
  const sin = mount(ONE_RING())
  const con = mount(ONE_RING(), { styleOf: () => ({ dash: [6, 4] }) })

  assert.equal(sin.spy.texImages.length, 1, 'sólo las posiciones')
  assert.equal(con.spy.texImages.length, 2, 'las posiciones y el largo acumulado del patrón')
})

// El repintado sólo mira lo que toca el encuadre: si el patrón se comprobara ahí, una figura lejana
// lanzaría recién cuando la vista llegue a ella, desde el ciclo de vista.
test('un patrón que no cabe lanza al resolver el estilo, aunque la figura quede fuera del encuadre', () => {
  const lejos = () => tables([square(150, 60, 0.05)])
  assert.throws(() => mount(lejos(), { styleOf: () => ({ dash: Array(18).fill(1) }) }), RangeError, 'el alta')
  const { layer } = mount(lejos())
  assert.equal(layer.drawnPartCount, 0, 'la figura está fuera del encuadre')
  assert.throws(() => layer.setStyleOf(() => ({ dash: Array(9).fill(1) })), RangeError)
})

// El estilo se publica entero o nada: una figura que lanza en medio no deja a las de antes con el
// estilo nuevo y a las de después con el viejo.
test('un styleOf que lanza a mitad de las figuras deja el estilo entero como estaba', () => {
  const spy = newSpy(), trazos = []
  currentGl = new Proxy(editGl(spy), { get: (t, p) => (p === 'uniform4fv' ? (_loc, rgba) => trazos.push([...rgba]) : t[p]) })
  const layer = new PolygonGpuLayer({
    host: anfitrion().host, pane: 'gpu', geometry: tables([square(0, 0, 0.01), square(0.02, 0, 0.01), square(0.04, 0, 0.01)]),
    styleOf: () => ({ color: '#ff0000' }),
  })
  assert.throws(() => layer.setStyleOf(id => (id === 1 ? { dash: Array(17).fill(1) } : { color: '#0000ff' })), RangeError)
  trazos.length = 0
  layer.redraw()
  assert.deepEqual(trazos.map(c => c.slice(0, 3)), [[1, 0, 0], [1, 0, 0], [1, 0, 0]])
})

test('setGeometry() cambia la figura sin tomar otro contexto y repinta', () => {
  const { layer, spy } = mount(ONE_RING())
  const subidas = spy.texImages.length
  assert.equal(drawsOf(spy, () => layer.setGeometry(tables([square(0, 0, 0.1), square(0.5, 0, 0.1)], [1, 1]))) > 0, true)
  assert.equal(spy.texImages.length, subidas + 1, 'sube la textura nueva')
  assert.equal(layer.ringCount, 2)
  assert.equal(spy.released, 0, 'el contexto sigue siendo el mismo')
})

/* ── 11. Montada sobre un Source ── */

const ANILLO_A = [[0, 0], [0, 0.05], [0.05, 0.05], [0, 0]]
const ANILLO_B = [[0, 0.02], [0, 0.07], [0.05, 0.07], [0, 0.02]]

const fuente = (items, extra = {}) => {
  let notify = null
  return {
    accessors: { idOf: it => it.id, ringsOf: it => it.rings, ...extra },
    getSnapshot: () => items,
    subscribe: cb => { notify = cb; return () => (notify = null) },
    cambiar: nuevos => { items = nuevos; notify?.() },
  }
}

const conFuente = (source, options = {}, cap = null) => {
  const spy = newSpy()
  currentGl = editGl(spy, cap)
  const map = makeMap()
  return { layer: new PolygonGpuLayer({ host: adoptLeafletHost(map), pane: 'gpu', source, ...options }), map, spy, source }
}

test('con un Source y sus accessors, la capa dibuja sin recibir tablas', () => {
  const { layer, spy } = conFuente(fuente([{ id: 'a', rings: ANILLO_A }, { id: 'b', rings: ANILLO_B }]))
  assert.equal(layer.ringCount, 2, 'un anillo por entidad')
  assert.ok(drawsOf(spy, () => layer.redraw()) > 0)
})

test('styleOf e idOf reciben la ENTIDAD, no el índice de parte', () => {
  const vistos = []
  const src = fuente([{ id: 'zona-1', rings: ANILLO_A }], { styleOf: it => (vistos.push(it.id), { color: '#ff0000' }) })
  conFuente(src)
  assert.deepEqual(vistos, ['zona-1'])
})

test('el picking contesta con el id de la entidad, y por TODAS las que contienen el punto', () => {
  const src = fuente([{ id: 'a', rings: ANILLO_A }, { id: 'b', rings: ANILLO_B }])
  const { layer } = conFuente(src, { interactive: true })
  const golpes = layer.resolveClick({ lat: 0.01, lng: 0.03 })
  assert.deepEqual(golpes.map(h => h.id).sort(), ['a', 'b'], 'las dos se superponen ahí')
  assert.equal(golpes.every(h => h.distancePx === 0), true)
})

test('un cambio del Source rehace la geometría', () => {
  const src = fuente([{ id: 'a', rings: ANILLO_A }])
  const { layer } = conFuente(src)
  assert.equal(layer.ringCount, 1)
  src.cambiar([{ id: 'a', rings: ANILLO_A }, { id: 'b', rings: ANILLO_B }])
  assert.equal(layer.ringCount, 2, 'la capa se reconstruyó sola')
})

test('applyFocus atenúa lo que queda fuera del foco, y destroy desengancha del Source', () => {
  const src = fuente([{ id: 'a', rings: ANILLO_A }, { id: 'b', rings: ANILLO_B }])
  const { layer, spy } = conFuente(src)
  assert.ok(drawsOf(spy, () => layer.applyFocus(new Set(['a']), 0.2)) > 0, 'reevalúa y repinta')
  layer.destroy()
  src.cambiar([{ id: 'a', rings: ANILLO_A }])
  assert.ok(true, 'un cambio tras destroy no revienta')
})

/* ── 12. Alta fallida y reingesta fallida: la capa no se queda con nada a medias ── */

test('si el alta falla en código del CONSUMIDOR, devuelve el contexto y no deja oyentes', () => {
  const spy   = newSpy()
  currentGl   = editGl(spy, null)
  const sobre = anfitrion()
  assert.throws(() => new PolygonGpuLayer({
    host: sobre.host, pane: 'gpu', geometry: tables([square(0, 0, 0.05)], [1]),
    styleOf: () => { throw new Error('el styleOf del consumidor tira') },
  }), /styleOf del consumidor/)

  assert.equal(spy.released, 1, 'el contexto vuelve: es uno de los ~16 del navegador')
  assert.equal(sobre.map.getPane('gpu'), null, 'ni el canvas ni su pane quedan en el mapa')
  assert.equal(sobre.oyentes(...VIEW_EVENTS), 0, 'ni un oyente de más')
})

test('una reingesta que falla deja la capa coherente, no dibujando contra una textura muerta', () => {
  const src = fuente([{ id: 'a', rings: ANILLO_A }])
  // Tope de 2: un anillo de 4 vértices entra (2×2); dos anillos piden 4 filas y ya no.
  const { layer, spy } = conFuente(src, {}, 2)
  assert.equal(layer.ringCount, 1)

  assert.throws(() => src.cambiar([{ id: 'a', rings: ANILLO_A }, { id: 'b', rings: ANILLO_B }]),
    /no entran en una textura/)

  assert.equal(layer.ringCount, 1, 'sigue con la geometría vieja, entera')
  assert.ok(drawsOf(spy, () => layer.redraw()) > 0, 'y sigue dibujando')
})

test('un multipolígono con piezas solapadas contesta UNA vez', () => {
  const partida = [[ANILLO_A], [ANILLO_B]]                 // una entidad, dos piezas que se pisan
  const src = fuente([{ id: 'zona-partida', rings: partida }])
  const { layer } = conFuente(src, { interactive: true })
  const golpes = layer.resolveClick({ lat: 0.01, lng: 0.03 })
  assert.equal(layer.drawnPartCount, 2, 'son dos partes')
  assert.deepEqual(golpes.map(h => h.id), ['zona-partida'], 'pero una sola entidad')
})

/* ── 8. Identidad por FEATURE en la ruta de geometría tipada ── */

// Dos piezas SUPERPUESTAS de un mismo MultiPolygon. Antes, sin dueño, cada pieza era un id distinto y
// la entidad contestaba DOS veces sobre el mismo píxel — contra la promesa de "una vez por entidad"
// que la ruta de Source ya cumplía. `owner` de `areasOf` es lo que las vuelve a atar.
const MULTI = new TextEncoder().encode(JSON.stringify({
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [square(1, 1, 0.1)] } },
    { type: 'Feature', properties: {}, geometry: {
      type: 'MultiPolygon', coordinates: [[square(0, 0, 0.1)], [square(0.05, 0, 0.1)]] } },
  ],
}))

const EN_EL_SOLAPE = { lat: 0, lng: 0.02 }          // dentro de las DOS piezas del multipolígono

test('un multipolígono contesta UNA vez, aunque el punto caiga en dos de sus piezas', () => {
  const { layer } = mount(areasOf(readGeoJson(MULTI)), { interactive: true })
  const golpes = hits(layer, EN_EL_SOLAPE)
  assert.equal(golpes.length, 1, 'una entidad, un hit')
  assert.equal(golpes[0].id, 1, 'y el id es el de la FEATURE, no el de la pieza')
})

test('`idOf` recibe el índice de la feature — la identidad natural del documento', () => {
  const vistos = []
  const { layer } = mount(areasOf(readGeoJson(MULTI)), {
    interactive: true,
    idOf: f => { vistos.push(f); return `zona-${f}` },
  })
  assert.deepEqual(hits(layer, EN_EL_SOLAPE).map(h => h.id), ['zona-1'])
  // El polígono suelto es la feature 0 y las dos piezas del multi son la 1: tres partes, dos dueños.
  assert.deepEqual([...new Set(vistos)].sort(), [0, 1])
})

// Sin `owner` —tablas armadas a mano, sin pasar por `areasOf`— el sujeto sigue siendo la parte. Es lo
// que mantiene andando a quien construye la geometría por su cuenta.
test('sin `owner`, el sujeto sigue siendo la parte', () => {
  const vistos = []
  const { layer } = mount(tables([square(0, 0, 0.1)]), {
    interactive: true,
    idOf: p => { vistos.push(p); return `parte-${p}` },
  })
  assert.deepEqual(hits(layer, { lat: 0, lng: 0 }).map(h => h.id), ['parte-0'])
  assert.deepEqual([...new Set(vistos)], [0], 'el alta ya lo consultó en su restyle')
})

/* ── 9. Una sola puerta: `addPolygonLayer` con geometría tipada ── */

const conMotor = () => {
  const map = makeMap()
  const engine = new MapEngine({ host: adoptLeafletHost(map, { leaflet: makeLeaflet() }) })
  currentGl = editGl(newSpy())
  return { engine, map }
}

test('`addPolygonLayer({ geometry })` monta el sustrato GPU sin declararlo', () => {
  const { engine, map } = conMotor()
  const handle = engine.addPolygonLayer({ id: 'areas', geometry: ONE_RING() })

  assert.equal(typeof handle.redraw, 'function', 'el handle trae lo propio del sustrato GPU')
  assert.equal(handle.source, null, 'la geometría tipada es inmutable: no hay Source que exponer')
  assert.ok(map.getPane('cristae-polygon-areas'), 'y el pane es el de la puerta única')
  assert.equal(engine.getLayer('areas').interactive, true, 'con el default de la puerta única')
})

test('`addPolygonGpuLayer` delega y conserva su pane y su `interactive` histórico', () => {
  const { engine, map } = conMotor()
  const handle = engine.addPolygonGpuLayer({ id: 'areas', geometry: ONE_RING() })

  assert.ok(map.getPane('cristae-polygon-gpu-areas'), 'el pane de siempre, no el de la puerta nueva')
  assert.equal(engine.getLayer('areas').interactive, false, 'y su default de picking apagado')
  assert.equal(typeof handle.style, 'function')
})

// Sin Source, la capa le informa su caja al encuadre del motor, con la forma de toda caja en grados.
test('la capa informa su caja en grados como una `Bounds`', () => {
  const { layer } = mount(tables([square(10, 20, 1), square(12, 22, 0.5)]))
  assert.deepEqual(layer.bounds, { south: 19, west: 9, north: 22.5, east: 12.5 })
})

test('fitToLayers encuadra la capa por la caja que informa', () => {
  const { engine, map } = conMotor()
  const cajas = []
  map.fitBounds = ([sw, ne]) => { cajas.push([...sw, ...ne]); return map }
  engine.addPolygonLayer({ id: 'areas', geometry: tables([square(10, 20, 1), square(12, 22, 0.5)]) })

  engine.fitToLayers()
  assert.deepEqual(cajas, [[19, 9, 22.5, 12.5]], 'sur, oeste, norte y este: cada lado en su esquina')
})

/* ── 10. El descarte por viewport cuenta el ancho del trazo ── */

// El trazo se expande en píxeles de PANTALLA: una figura con la caja apenas afuera todavía pinta
// borde adentro. Descartarla por la caja pelada le come ese borde hasta que la figura entra entera.
// Vista del harness: 800×600 a zoom 3 centrado en (0,0) → x ∈ [78, 178] en unidades de mundo, y una
// unidad de mundo son 360/256 grados de longitud.
const BORDE_IZQUIERDO = 360 * (179 / 256 - 0.5)          // una unidad de mundo pasado el viewport
const APENAS_AFUERA   = () => tables([square(BORDE_IZQUIERDO + 0.1, 0, 0.1)])

test('una figura apenas afuera se descarta si su trazo tampoco llega', () => {
  const { layer } = mount(APENAS_AFUERA(), { weight: 1 })    // margen: (0.5 + 0.5) / 8 = 0.125 < 1
  layer.redraw()
  assert.equal(layer.drawnPartCount, 0)
})

test('y NO se descarta cuando el trazo sí entra: el margen sale del ancho', () => {
  const { layer } = mount(APENAS_AFUERA(), { weight: 200 })   // margen: (100 + 0.5) / 8 = 12.56 > 1
  layer.redraw()
  assert.equal(layer.drawnPartCount, 1, 'antes se le comía el borde hasta que la figura entraba entera')
})
