// La faceta `tiles` del anfitrión sobre el Leaflet REAL, en jsdom con transformaciones 3D, como en un
// navegador: ahí Leaflet puede animar cualquier zoom, y la política decide cuál no anima. La retención
// cubre ése, el que resetea la vista, y se hace a un lado en el animado; un proveedor nuevo suelta al
// anterior, y el anfitrión le saca a un mapa adoptado lo que le puso. Son también los tests de contrato
// de lo que la retención lee de Leaflet: que avise el reset (`viewprereset`) antes de que la capa suelte
// sus tiles y que un zoom animado no resetee, que `_tileZoom` y `_tiles` digan qué tiles cargados hay, y
// que `_resetGrid` recalcule la grilla con que `_wrapCoords` y `getTileUrl` arman la URL de un tile. Y
// de lo que la hoja de la superficie alcanza por la clase que Leaflet le da al contenedor.
// Corre con: node --test test/host/tiles.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { contenedor, frame, prepararDom } from '../../test-helpers/leaflet-real.mjs'
import { surfaceCss } from '../../src/host/styles.js'

// Con transformaciones 3D, como en un navegador: sin ellas Leaflet no anima ningún zoom. jsdom no
// rasteriza: el contexto 2D sólo anota lo que se le dibuja.
const window  = prepararDom({ transformaciones3d: true })
const dibujos = []
window.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, {
  get: (_, key) => (key === 'drawImage' ? (...args) => dibujos.push(args) : () => {}),
  set: () => true,
})
const { default: L }                          = await import('leaflet')
const { createLeafletHost, adoptLeafletHost } = await import('../../src/host/LeafletHost.js')
const { MapEngine }                           = await import('../../src/engine/MapEngine.js')

const URL_TILES  = 'https://{s}.tiles.test/{z}/{x}/{y}/{-y}.png'
const PANE       = 'tileZoomSnapshotPane'
const ATRIBUCION = '&copy; <a href="https://proveedor.test">Proveedor</a>'

const capaDe = map => {
  let capa
  map.eachLayer(layer => layer instanceof L.TileLayer && (capa = layer))
  return capa
}

// Un anfitrión propio con la política pedida y un proveedor.
const montar = (zoomPolicy, center = [-33, -70]) => {
  const host = createLeafletHost({ container: contenedor(), view: { center, zoom: 10 } })
  host.camera.zoomPolicy = zoomPolicy
  host.tiles.setProvider({ url: URL_TILES, noWrap: false })
  return { host, camera: host.camera, map: host.map, capa: capaDe(host.map) }
}

// Cada tile de la capa carga por el camino de Leaflet: su imagen dispara `load`. jsdom no decodifica,
// así que la imagen declara que tiene contenido.
const cargar = capa => Object.values(capa._tiles).forEach(({ el }) => {
  Object.defineProperties(el, { complete: { value: true }, naturalWidth: { value: 256 } })
  el.dispatchEvent(new window.Event('load'))
})

// Un zoom animado se asienta a los 250 ms.
const asiente = map => new Promise(resolve => map.once('zoomend', resolve))
const pausa   = ms => new Promise(resolve => setTimeout(resolve, ms))

test('un zoom que Leaflet no anima deja la foto de los tiles que soltó, debajo del de tiles y sin puntero', () => {
  const { host, camera, map, capa } = montar('none')
  cargar(capa)
  const tiles = Object.keys(capa._tiles).length
  dibujos.length = 0

  camera.setZoom(9)

  const pane = map.getPane(PANE)
  assert.equal(map.getZoom(), 9)
  assert.equal(capa._tileZoom, 9, 'la capa ya soltó los tiles del zoom 10')
  assert.equal(pane?.children.length, 1, 'y la foto quedó en su pane')
  assert.equal(dibujos.length, tiles, 'con todos los tiles cargados')
  assert.match(pane.firstChild.style.transform, /scale\(0\.5\)$/, 'reproyectada al zoom nuevo')
  assert.deepEqual([pane.style.zIndex, pane.style.pointerEvents], ['150', 'none'])
  host.destroy()
})

// En línea, y no en la hoja de la superficie: rige también con el mapa en la página, donde esa hoja no está.
test('la capa del proveedor y el pane de la foto llevan en línea el filtro de su custom property', () => {
  const { host, camera, map, capa } = montar('none')
  cargar(capa)

  camera.setZoom(9)

  const pane = map.getPane(PANE)
  assert.equal(capa.getContainer().style.filter, 'var(--cristae-tile-filter, none)')
  assert.equal(pane.style.filter, 'var(--cristae-tile-filter, none)', 'el mismo que el de los tiles')
  assert.equal(pane.firstChild.style.filter, '', 'la foto no lleva uno propio')
  assert.equal(map.getPane('tilePane').style.filter, '', 'el pane de Leaflet no se toca')
  host.destroy()
})

test('en un mapa adoptado sin vista, la capa recibe el filtro cuando entra, con la primera vista', () => {
  const map  = new L.Map(contenedor())
  const host = adoptLeafletHost(map)
  host.tiles.setProvider({ url: URL_TILES })
  map.setView([-33, -70], 10)
  assert.equal(capaDe(map).getContainer().style.filter, 'var(--cristae-tile-filter, none)')
  host.destroy()
  map.remove()
})

// La hoja de la superficie, sin adoptar: sólo se le pregunta qué le declara al contenedor. Las reglas que
// le declaran fondo son todas de una clase, así que gana la última.
test('el fondo del contenedor sale de su custom property, que le gana al gris de Leaflet', () => {
  const { host, map } = montar('none')
  const hoja          = new window.CSSStyleSheet()
  hoja.replaceSync(surfaceCss)
  const fondo = [...hoja.cssRules]
    .filter(regla => regla.style?.getPropertyValue('background') && map.getContainer().matches(regla.selectorText))
    .at(-1)?.style.getPropertyValue('background')
  assert.equal(fondo, 'var(--cristae-map-background, #ddd)')
  host.destroy()
})

test('un zoom animado no fotografía, y esconde la foto que había', async () => {
  const { host, camera, map, capa } = montar('in-only')
  cargar(capa)
  camera.setZoom(9)
  const pane = map.getPane(PANE)
  assert.equal(pane.children.length, 1, 'alejar no anima: foto')
  const antes = dibujos.length

  const asentado = asiente(map)
  camera.setZoom(10)
  await frame()
  assert.equal(pane.children.length, 0, 'acercar anima: la foto no acompaña a la transición y sale al empezar')
  await asentado
  assert.equal(map.getZoom(), 10)
  assert.equal(dibujos.length, antes, 'el zoom animado no fotografía')
  assert.equal(pane.children.length, 0, 'ni vuelve a poner la foto al asentarse')
  host.destroy()
})

// Un paneo más largo que el contenedor tampoco lo anima Leaflet: resetea sin cambiar el zoom, así que no
// hay `zoomstart` que esconda la foto de antes.
test('un salto sin cambio de zoom también resetea, y la foto que ya no cae en la vista sale', () => {
  const { host, camera, map, capa } = montar('none')
  cargar(capa)
  camera.setZoom(9)
  const pane = map.getPane(PANE)
  assert.equal(pane.children.length, 1)

  camera.setView([-20, -70], 9)
  assert.equal(pane.children.length, 0)
  host.destroy()
})

test('un proveedor nuevo suelta al anterior con sus fotos', () => {
  const { host, camera, map, capa } = montar('none')
  cargar(capa)
  camera.setZoom(9)
  assert.equal(map.getPane(PANE).children.length, 1)

  host.tiles.setProvider({ url: 'https://otro.test/{z}/{x}/{y}.png', attribution: '© Otro' })
  const nueva = capaDe(map)
  assert.notEqual(nueva, capa)
  assert.equal(map.hasLayer(capa), false, 'la capa anterior sale del mapa')
  assert.equal(map.getPane(PANE), undefined, 'y sus fotos con ella')

  cargar(nueva)
  camera.setZoom(8)
  assert.equal(map.getPane(PANE).children.length, 1, 'el reset siguiente muestra sólo la foto del proveedor nuevo')
  host.destroy()
})

// Leaflet, en un móvil, pide los tiles recién al soltar el gesto: el default de `updateWhenIdle` depende
// de la plataforma, así que el anfitrión lo pasa siempre, y el proveedor que lo pide lo pisa.
test('el proveedor pide tiles durante el gesto en cualquier plataforma, salvo que diga otra cosa', () => {
  const host  = createLeafletHost({ container: contenedor(), view: { center: [-33, -70], zoom: 10 } })
  const idle  = () => {
    const { options } = capaDe(host.map)
    return Object.hasOwn(options, 'updateWhenIdle') ? options.updateWhenIdle : 'el de la plataforma'
  }
  host.tiles.setProvider({ url: URL_TILES })
  assert.equal(idle(), false)
  host.tiles.setProvider({ url: URL_TILES, updateWhenIdle: true })
  assert.equal(idle(), true)
  host.destroy()
})

test('la atribución es la del proveedor vigente, tal como la dio, y el mapa propio no la dibuja', () => {
  const host         = createLeafletHost({ container: contenedor(), view: { center: [-33, -70], zoom: 10 } })
  const atribuciones = [host.tiles.attribution()]
  host.tiles.setProvider({ url: URL_TILES, attribution: ATRIBUCION })
  atribuciones.push(host.tiles.attribution())
  host.tiles.setProvider({ url: URL_TILES })
  atribuciones.push(host.tiles.attribution())

  assert.deepEqual(atribuciones, [null, ATRIBUCION, null])
  assert.equal(host.map.getContainer().querySelector('.leaflet-control'), null, 'ni zoom ni atribución de Leaflet')
  host.destroy()
})

test('el motor pone los tiles por su anfitrión, y al destruirse se los saca a un mapa adoptado', () => {
  const map    = new L.Map(contenedor(), { center: [-33, -70], zoom: 10 })
  const host   = adoptLeafletHost(map)
  const engine = new MapEngine({ host, zoomAnimation: 'none' })

  engine.setTileProvider({ url: URL_TILES, attribution: '© Proveedor' })
  const capa = capaDe(map)
  assert.equal(capa.options.attribution, '© Proveedor', 'las opciones llegan a la capa')
  assert.equal(engine.getTileAttribution(), '© Proveedor', 'y el motor da su atribución')
  cargar(capa)
  engine.camera.setZoom(9)
  assert.equal(map.getPane(PANE).children.length, 1)

  engine.destroy()
  assert.equal(map.hasLayer(capa), false, 'la capa que puso sale del mapa')
  assert.equal(map.getPane(PANE), undefined, 'y el pane de la retención también')
  assert.deepEqual(['viewprereset', 'viewreset'].filter(tipo => map.listens(tipo)), [], 'nadie oye ya los resets')
  map.remove()
})

// Un mapa adoptado puede llegar sin vista, y Leaflet agrega la capa de tiles recién cuando la toma: en ese
// primer reset la capa todavía no tiene tiles que fotografiar, y antes no hay zoom desde el que sembrar.
test('un proveedor sobre un mapa adoptado sin vista no rompe su primer setView ni siembra sin vista', async () => {
  const rechazos = []
  const anotar   = error => rechazos.push(error)
  process.on('unhandledRejection', anotar)
  globalThis.requestIdleCallback = cb => setTimeout(cb, 0)
  globalThis.cancelIdleCallback  = clearTimeout
  try {
    const map    = new L.Map(contenedor())
    const engine = new MapEngine({ host: adoptLeafletHost(map), zoomAnimation: 'none' })
    engine.setTileProvider({ url: URL_TILES })
    await pausa(20)
    assert.deepEqual(rechazos, [], 'sin vista no hay semillas')

    map.setView([-33, -70], 10)
    const capa = capaDe(map)
    assert.equal(capa._tileZoom, 10, 'la capa entra con la vista')
    cargar(capa)
    engine.camera.setZoom(9)
    assert.equal(map.getPane(PANE).children.length, 1, 'y desde ahí la retención cubre el zoom que no anima')
    engine.destroy()
    map.remove()
  } finally {
    process.off('unhandledRejection', anotar)
    delete globalThis.requestIdleCallback
    delete globalThis.cancelIdleCallback
  }
})

test('Leaflet avisa el reset antes de que la capa suelte sus tiles, y un zoom animado no resetea', async () => {
  const map  = new L.Map(contenedor(), { center: [-33, -70], zoom: 10 })
  const capa = new L.TileLayer(URL_TILES)
  const vio  = []
  map.on('viewprereset', () => vio.push([capa._tileZoom, Object.keys(capa._tiles).length]))
  capa.addTo(map)
  const tiles = Object.keys(capa._tiles).length
  assert.ok(tiles > 0)

  map.setZoom(9, { animate: false })
  assert.deepEqual(vio, [[10, tiles]], 'el oyente que llegó antes que la capa todavía ve sus tiles')
  assert.equal(capa._tileZoom, 9)

  const asentado = asiente(map)
  map.setZoom(10)
  await asentado
  assert.equal(vio.length, 1, 'el zoom animado llegó sin reset')
  map.remove()
})

test('`_tileZoom` es el zoom de los tiles de la capa, y `_tiles` los trae con su nodo, sus coordenadas y cuándo cargaron', () => {
  const { host, capa } = montar('none')
  const entradas = Object.values(capa._tiles)
  assert.equal(capa._tileZoom, 10)
  assert.ok(entradas.length > 0)
  assert.ok(entradas.every(({ el, coords, loaded }) =>
    el instanceof window.HTMLImageElement && coords.z === 10 && Number.isInteger(coords.x) && loaded === undefined))

  cargar(capa)
  assert.ok(entradas.every(({ loaded }) => loaded > 0), 'al cargar la imagen, Leaflet anota cuándo')
  host.destroy()
})

// Junto al antimeridiano la vista de un zoom más profundo cruza el borde del mundo, y las semillas de ese
// lado tienen una x que da la vuelta. La vuelta es con el ancho del mundo de su zoom: al este del
// meridiano 0 la x ya pasa el del zoom actual. La y invertida (`{-y}`) también sale del rango de su zoom.
test('una semilla pide el tile que Leaflet pediría a ese zoom: la vuelta al mundo y la y invertida son las de ese zoom', async () => {
  const pedidas = []
  globalThis.requestIdleCallback = cb => setTimeout(cb, 0)
  globalThis.cancelIdleCallback  = clearTimeout
  globalThis.Image               = class { set src(url) { pedidas.push(url); queueMicrotask(() => this.onload()) } }

  const centro                      = [10.3, 179.99]
  const { host, camera, map, capa } = montar('none', centro)
  const grilla                      = () => [capa._tileZoom, capa._wrapX, capa._wrapY, capa._globalTileRange]
  const antes                       = grilla()
  const zoomDe                      = url => Number(url.split('/')[3])
  await pausa(20)
  assert.deepEqual(grilla(), antes, 'la capa vuelve a su grilla después de armar las URL')

  ;[11, 12].forEach(zoom => {
    const semillas = pedidas.filter(url => zoomDe(url) === zoom)
    camera.setView(centro, zoom)
    const tiles     = Object.values(capa._tiles).filter(t => t.coords.z === zoom)
    const deLeaflet = new Set(tiles.map(t => t.el.src))
    assert.ok(tiles.some(t => t.coords.x >= 2 ** zoom), `zoom ${zoom}: la vista cruza el borde del mundo`)
    assert.ok(semillas.length > 0, `zoom ${zoom}: hubo semillas`)
    assert.deepEqual(semillas.filter(url => !deLeaflet.has(url)), [], `zoom ${zoom}: todas son tiles de Leaflet`)
  })
  assert.equal(map.getZoom(), 12)

  delete globalThis.requestIdleCallback
  delete globalThis.cancelIdleCallback
  delete globalThis.Image
  host.destroy()
})
