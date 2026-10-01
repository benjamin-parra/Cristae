// Ningún valor de Leaflet cruza la API pública: la cámara devuelve objetos planos, los canales del
// motor entregan la muestra del puntero, el evento del DOM y cajas planas, el <cristae-map> los
// re-emite en el detail de sus eventos, y el painter de etiquetas recibe un píxel plano. Corre sobre el
// Leaflet REAL, en jsdom, porque un doble ya devuelve objetos planos y el test se cumpliría solo:
// recorre cada retorno y cada payload, y falla si encuentra una instancia de cualquier clase que
// Leaflet exporte. Sobre el mismo Leaflet, la vista viaja sólo cuando hay una que leer.
// Corre con: node --test test/engine/valores-propios.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { contenedor, prepararDom } from '../../test-helpers/leaflet-real.mjs'

// El DOM va antes que Leaflet. El elemento, además, escucha como un EventTarget —su addEventListener
// enciende el puente bajo demanda y delega en el de la base—; lo demás que Lit toca lo pone el harness
// de elementos.
const window           = prepararDom()
globalThis.Element     = window.Element
globalThis.HTMLElement = class extends EventTarget {}
await import('../../test-helpers/element-stub.mjs')
const { default: L }       = await import('leaflet')
const { MapEngine }        = await import('../../src/engine/MapEngine.js')
const { adoptLeafletHost } = await import('../../src/host/LeafletHost.js')
const { CristaeMap }       = await import('../../src/element/CristaeMap.js')

const CLASES_LEAFLET = Object.values(L).filter(v => typeof v === 'function' && v.prototype)

// Los caminos, dentro de `valor`, que llevan a una instancia de Leaflet. Baja sólo por objetos planos y
// arrays: un evento del DOM es del navegador, no de Leaflet, y no se abre.
const deLeaflet = (valor, camino = 'valor') => {
  if (valor === null || typeof valor !== 'object') return []
  if (CLASES_LEAFLET.some(C => valor instanceof C)) return [camino]
  const proto = Object.getPrototypeOf(valor)
  return proto === Object.prototype || proto === Array.prototype
    ? Object.entries(valor).flatMap(([k, v]) => deLeaflet(v, `${camino}.${k}`))
    : []
}

const plano = (valor, claves, msg) => {
  assert.deepEqual(deLeaflet(valor), [], msg)
  assert.equal(Object.getPrototypeOf(valor), Object.prototype, `${msg}: objeto plano`)
  assert.deepEqual(Object.keys(valor).sort(), [...claves].sort(), `${msg}: sus campos`)
}

// La proyección de Leaflet redondea el origen de píxeles: un píxel son ~1e-3 grados a este zoom.
const cerca = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-2, `${msg}: ${a} vs ${b}`)

// Un motor con su mapa propio, ya con vista.
const montar = async () => {
  const container = contenedor()
  const engine    = new MapEngine({ container, view: { center: [-33, -70], zoom: 10 } })
  await engine.ready
  return { engine, container }
}

const puntero = (container, tipo, x, y) =>
  container.dispatchEvent(new window.MouseEvent(tipo, { clientX: x, clientY: y, bubbles: true, cancelable: true }))

// Una pulsación quieta: el click que sintetiza la puerta del puntero.
const clickear = (container, x, y) => ['pointerdown', 'pointerup'].forEach(tipo =>
  container.dispatchEvent(new window.PointerEvent(tipo, { clientX: x, clientY: y, bubbles: true, cancelable: true })))

// Un marcador en el centro, con picking propio: da hits al click, al secundario y al hover.
const marcar = async engine => {
  engine.addHtmlLayer({
    id          : 'marcas',
    interactive : true,
    data        : [{ id: 1, lat: -33, lng: -70 }],
    accessors   : { idOf: m => m.id, positionOf: m => ({ lat: m.lat, lng: m.lng }), htmlOf: () => '<b>1</b>' },
  })
  await new Promise(resolve => window.requestAnimationFrame(resolve))
}

test('la cámara devuelve posiciones, píxeles y cajas planas', async () => {
  const { engine } = await montar()
  const camera     = engine.camera

  plano(camera.getCenter(), ['lat', 'lng'], 'getCenter')
  plano(camera.getBounds(), ['south', 'west', 'north', 'east'], 'getBounds')
  plano(camera.containerPointToLatLng({ x: 400, y: 300 }), ['lat', 'lng'], 'containerPointToLatLng')

  const formas = {
    par      : [-33, -70],
    tipado   : Float64Array.of(-33, -70, 500),
    latLng   : { lat: -33, lng: -70 },
    latLon   : { lat: -33, lon: -70 },
    latitude : { latitude: -33, longitude: -70 },
  }
  for (const [nombre, punto] of Object.entries(formas)) {
    const p = camera.latLngToContainerPoint(punto)
    plano(p, ['x', 'y'], `latLngToContainerPoint, ${nombre}`)
    cerca(p.x, 400, nombre)
    cerca(p.y, 300, nombre)
  }

  const b = camera.getBounds()
  cerca((b.south + b.north) / 2, -33, 'la caja rodea el centro')
  engine.destroy()
})

test('fitBounds encuadra una Bounds o un par de esquinas, y lo que no es caja no mueve la cámara', async () => {
  const { engine } = await montar()
  const camera     = engine.camera
  const caja       = { south: -34, west: -71, north: -33.5, east: -70.5 }
  const dentro     = b => b.south <= caja.south && b.west <= caja.west && b.north >= caja.north && b.east >= caja.east

  camera.fitBounds(caja)
  const vista = camera.getBounds()
  assert.ok(dentro(vista), 'la vista cubre la caja')

  camera.setView([-33, -70], 10)
  camera.fitBounds([{ lat: -33.5, lng: -71 }, Float32Array.of(-34, -70.5)])
  assert.deepEqual(camera.getBounds(), vista, 'noroeste y sudeste, en dos formas de punto, dan la misma vista')

  const centro = camera.getCenter()
  camera.fitBounds(L.latLngBounds([-34, -71], [-33.5, -70.5]))
  camera.fitBounds({ ...caja, north: -35 })
  camera.fitBounds(null)
  assert.deepEqual(camera.getCenter(), centro, 'ni un L.LatLngBounds, ni una caja invertida, ni null')
  engine.destroy()
})

test('los canales del motor entregan la muestra, el evento del DOM y cajas planas', async () => {
  const { engine, container } = await montar()
  const recibido = {}
  const guardar  = canal => (...args) => (recibido[canal] ??= []).push(args)
  ;['viewportchange', 'map:click', 'pointer:move'].forEach(canal => engine.on(canal, guardar(canal)))
  ;['click', 'secondary-click', 'hover', 'hover:start', 'hover:end'].forEach(canal => engine.on(canal, 'marcas', guardar(canal)))

  await marcar(engine)

  puntero(container, 'pointermove', 400, 300)
  clickear(container, 400, 300)
  puntero(container, 'contextmenu', 400, 300)
  clickear(container, 50, 50)
  puntero(container, 'pointerleave', 50, 50)
  engine.camera.setView([-33.1, -70.1], 11)

  const [[vacio, muestra]] = recibido['pointer:move']
  assert.deepEqual(vacio, [], 'pointer:move no lleva hits')
  plano(muestra, ['lat', 'lng', 'x', 'y'], 'la muestra del puntero')
  assert.ok(Object.isFrozen(muestra), 'la comparten los handlers y el picking: llega congelada')
  assert.deepEqual([muestra.x, muestra.y], [400, 300])
  cerca(muestra.lat, -33, 'la muestra trae su posición')

  assert.equal(recibido.hover[0][1], muestra, 'el hover entrega la misma muestra')
  assert.equal(recibido['hover:start'][0][1], muestra)
  assert.equal(recibido['hover:end'][0][1], null, 'salir del mapa no tiene muestra')
  assert.ok(recibido.click[0][1] instanceof window.PointerEvent, 'el click entrega el pointerup que lo cerró')
  assert.ok(recibido['secondary-click'][0][1] instanceof window.MouseEvent)

  const [[clickVacio]] = recibido['map:click']
  plano(clickVacio, ['latlng'], 'map:click')
  plano(clickVacio.latlng, ['lat', 'lng'], 'map:click.latlng')

  const [detalle] = recibido.viewportchange.at(-1)
  plano(detalle, ['center', 'zoom', 'bounds'], 'viewportchange')
  plano(detalle.center, ['lat', 'lng'], 'viewportchange.center')
  plano(detalle.bounds, ['south', 'west', 'north', 'east'], 'viewportchange.bounds')

  Object.entries(recibido).forEach(([canal, llamadas]) =>
    assert.deepEqual(deLeaflet(llamadas), [], `${canal}: ningún valor de Leaflet`))
  engine.destroy()
})

// El elemento arma su propio mapa sobre el mismo Leaflet y re-emite los canales como CustomEvent;
// click y pointermove se puentean recién cuando alguien los escucha.
test('los eventos del elemento llevan en el detail los mismos valores planos', async () => {
  const container = contenedor()
  const recibido  = {}
  const el        = Object.assign(new CristaeMap(), {
    renderRoot    : { querySelector: () => container },
    initialCenter : [-33, -70],
    initialZoom   : 10,
  })
  ;['viewportchange', 'mapclick', 'click', 'pointermove'].forEach(tipo =>
    el.addEventListener(`cristae:${tipo}`, ev => (recibido[tipo] ??= []).push(ev.detail)))
  el.firstUpdated()
  await el.ready
  await marcar(el.engine)

  puntero(container, 'pointermove', 400, 300)
  clickear(container, 400, 300)
  clickear(container, 50, 50)
  el.camera.setView([-33.1, -70.1], 11)

  const [clic] = recibido.click
  plano(recibido.pointermove[0], ['lat', 'lng', 'x', 'y'], 'cristae:pointermove')
  plano(clic, ['hits', 'originalEvent'], 'cristae:click')
  assert.equal(clic.hits.length, 1, 'el click sobre el marcador trae su hit')
  assert.ok(clic.originalEvent instanceof window.PointerEvent, 'y el pointerup que cerró la pulsación')
  plano(recibido.mapclick[0], ['latlng'], 'cristae:mapclick')
  plano(recibido.mapclick[0].latlng, ['lat', 'lng'], 'cristae:mapclick.latlng')
  plano(recibido.viewportchange.at(-1), ['center', 'zoom', 'bounds'], 'cristae:viewportchange')
  assert.deepEqual(deLeaflet(recibido), [], 'ningún detail lleva un valor de Leaflet')
  el.disconnectedCallback()
})

// El click lo sintetiza la puerta del puntero con la pulsación quieta: el `click` que Leaflet dispara —el
// de `map.fire('click', { latlng })`, la forma habitual de simularlo— ya no es un click de Cristae.
test('una pulsación quieta sale por click con su hit, y en el vacío por map:click con su posición plana', async () => {
  const { engine, container } = await montar()
  const recibido              = { click: [], vacio: [] }
  engine.on('click', 'marcas', (hits, ev) => recibido.click.push([hits.length, ev.type]))
  engine.on('map:click', detalle => recibido.vacio.push(detalle))
  await marcar(engine)

  const vacio = engine.camera.latLngToContainerPoint([-33.1, -70.1])
  engine.getLeafletMap().fire('click', { latlng: L.latLng(-33, -70) })
  clickear(container, 400, 300)
  clickear(container, vacio.x, vacio.y)

  assert.deepEqual(recibido.click, [[1, 'pointerup']], 'sobre el marcador: su hit y su pointerup; el de Leaflet no cuenta')
  assert.equal(recibido.vacio.length, 1, 'en el vacío, uno')
  plano(recibido.vacio[0].latlng, ['lat', 'lng'], 'map:click.latlng')
  cerca(recibido.vacio[0].latlng.lat, -33.1, 'la latitud del píxel')
  cerca(recibido.vacio[0].latlng.lng, -70.1, 'la longitud del píxel')
  engine.destroy()
})

// La cámara lee un punto con la forma de cristae/geometry, sin el rango de la latitud: una vista tipada
// más larga es un track, y leerla como punto encuadraría su primer vértice en silencio.
test('lo que no tiene forma de punto lanza en la cámara; la latitud fuera de rango no', async () => {
  const { engine } = await montar()
  const camera     = engine.camera
  const track      = Float64Array.of(-33, -70, 0, -33.1, -70.1)

  assert.throws(() => camera.latLngToContainerPoint(track), TypeError)
  assert.throws(() => camera.setView(track, 10), TypeError)
  assert.throws(() => camera.panTo(null), TypeError)
  plano(camera.latLngToContainerPoint({ lat: 95, lng: -70 }), ['x', 'y'], 'la proyección la acota')
  engine.destroy()
})

// jsdom no pinta: el contexto 2D es un doble que acepta todo. El painter espía lo que recibe.
test('el painter de etiquetas recibe un píxel plano, también el de una elevada', async () => {
  const getContext = window.HTMLCanvasElement.prototype.getContext
  window.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, { get: () => () => {}, set: () => true })
  try {
    const { engine } = await montar()
    const pintados   = []
    const paint      = (ctx, point, label, hovered) => pintados.push({ point, id: label.id, hovered })
    const rotulos    = engine.addLabelLayer({ id: 'rotulos', paint })

    rotulos.setHovered([2])
    rotulos.setLabels([
      { id: 1, lat: -33, lng: -70, text: 'centro' },
      { id: 2, lat: -33.01, lng: -70.01, text: 'elevada' },
      { id: 3, lat: 10, lng: 10, text: 'lejos' },
    ])

    assert.deepEqual(pintados.map(({ id, hovered }) => [id, hovered]), [[1, false], [2, true]], 'la lejana queda fuera de la caja')
    pintados.forEach(({ point, id }) => plano(point, ['x', 'y'], `el píxel de la etiqueta ${id}`))
    cerca(pintados[0].point.x, 400, 'el píxel es el del contenedor')
    cerca(pintados[0].point.y, 300, 'el píxel es el del contenedor')
    engine.destroy()
  } finally {
    window.HTMLCanvasElement.prototype.getContext = getContext
  }
})

// Un mapa adoptado puede llegar sin vista. Los insets se guardan igual —los encuadres los usan—, pero sin
// vista no hay centro ni caja que emitir: la vista sale desde que el mapa la toma.
test('asignar insets a un mapa adoptado sin vista no lanza ni emite, y emite desde que la toma', () => {
  const map    = L.map(contenedor())
  const engine = new MapEngine({ host: adoptLeafletHost(map) })
  const vistas = []
  engine.on('viewportchange', vista => vistas.push(vista))

  engine.camera.insets = { top: 10 }
  assert.deepEqual(vistas, [], 'sin vista, los insets sólo se guardan')
  map.setView([-33, -70], 10)
  const antes = vistas.length
  engine.camera.insets = { top: 20 }
  assert.equal(vistas.length, antes + 1, 'con vista, cambiar los insets la emite')
  plano(vistas.at(-1), ['center', 'zoom', 'bounds'], 'viewportchange')
  engine.destroy()
  map.remove()
})

// Las etiquetas pintan con la caja y la proyección de la cámara, que sin vista no se pueden leer: esperan
// al `moveend` que la trae.
test('una capa de etiquetas sobre un mapa adoptado sin vista no lanza, y pinta al tomarla', () => {
  const getContext = window.HTMLCanvasElement.prototype.getContext
  window.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, { get: () => () => {}, set: () => true })
  try {
    const map      = L.map(contenedor())
    const engine   = new MapEngine({ host: adoptLeafletHost(map) })
    const pintados = new Set()
    const rotulos  = engine.addLabelLayer({ id: 'rotulos', paint: (ctx, point, label) => pintados.add(label.id) })

    rotulos.setLabels([{ id: 1, lat: -33, lng: -70, text: 'centro' }])
    assert.deepEqual([...pintados], [], 'sin vista no pinta')
    map.setView([-33, -70], 10)
    assert.deepEqual([...pintados], [1], 'la vista trae el pintado')
    engine.destroy()
    map.remove()
  } finally {
    window.HTMLCanvasElement.prototype.getContext = getContext
  }
})

// El calor proyecta cada punto con la cámara, igual que las etiquetas: sin vista, espera al `moveend` que
// la trae. La Source reparte en el frame siguiente, y lo que lanza su oyente sale por la consola.
test('una capa de calor sobre un mapa adoptado sin vista no lanza, y pinta al tomarla', async t => {
  const estampas   = []
  const frame      = () => new Promise(resolve => requestAnimationFrame(resolve))
  const getContext = window.HTMLCanvasElement.prototype.getContext
  const contexto   = {
    drawImage    : (...args) => estampas.push(args),
    getImageData : () => ({ data: new Uint8ClampedArray(4) }),
  }
  window.HTMLCanvasElement.prototype.getContext = () =>
    new Proxy({}, { get: (_, clave) => contexto[clave] ?? (() => ({ addColorStop() {} })), set: () => true })
  const errores = t.mock.method(console, 'error', () => {})
  try {
    const map    = L.map(contenedor())
    const engine = new MapEngine({ host: adoptLeafletHost(map) })
    engine.addHeatLayer({ id: 'calor', accessors: { idOf: it => it.id, positionOf: it => it }, data: [{ id: 1, lat: -33, lng: -70 }] })

    await frame()
    assert.deepEqual([errores.mock.callCount(), estampas.length], [0, 0], 'sin vista no lanza ni pinta')
    map.setView([-33, -70], 10)
    await frame()
    assert.ok(estampas.length > 0, 'la vista trae el pintado')
    engine.destroy()
    map.remove()
  } finally {
    window.HTMLCanvasElement.prototype.getContext = getContext
  }
})

test('tras destroy, asignar insets no lanza: el mapa propio ya no está', async () => {
  const { engine } = await montar()
  engine.destroy()
  assert.doesNotThrow(() => { engine.camera.insets = { top: 20 } })
  assert.deepEqual(engine.camera.insets, { top: 20, right: 0, bottom: 0, left: 0 })
})
