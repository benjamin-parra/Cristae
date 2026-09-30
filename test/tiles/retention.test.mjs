// La retención de tiles sobre el Leaflet REAL, en jsdom con transformaciones 3D, como en un navegador:
// ahí Leaflet puede animar cualquier zoom, y la política del motor decide cuál no anima. La retención
// cubre ése, el que resetea la vista, y se hace a un lado en el animado. Son también los tests de
// contrato de lo que lee de Leaflet: que avise el reset (`viewprereset`) antes de que la capa suelte sus
// tiles y que un zoom animado no resetee, que `_tileZoom` y `_tiles` digan qué tiles cargados hay, y
// que `_resetGrid` recalcule la grilla con que `_wrapCoords` y `getTileUrl` arman la URL de un tile.
// Corre con: node --test test/tiles/retention.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM, VirtualConsole } from 'jsdom'

// Leaflet decide al evaluarse si puede animar: sin transformaciones 3D no anima ningún zoom, y
// `WebKitCSSMatrix` es lo que mira. jsdom no rasteriza: el contexto 2D sólo anota lo que se le dibuja.
const { window } = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true, virtualConsole: new VirtualConsole() })
window.WebKitCSSMatrix           = class { m11 = 1 }
globalThis.window                = window
globalThis.document              = window.document
globalThis.getComputedStyle      = window.getComputedStyle.bind(window)
globalThis.requestAnimationFrame = window.requestAnimationFrame
globalThis.cancelAnimationFrame  = window.cancelAnimationFrame

const dibujos = []
window.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, {
  get: (_, key) => (key === 'drawImage' ? (...args) => dibujos.push(args) : () => {}),
  set: () => true,
})
const { default: L } = await import('leaflet')
const { MapEngine }  = await import('../../src/engine/MapEngine.js')

const URL_TILES = 'https://{s}.tiles.test/{z}/{x}/{y}/{-y}.png'
const PANE      = 'tileZoomSnapshotPane'

// Un contenedor de 800×600: jsdom no mide, así que el tamaño se declara.
const contenedor = () => {
  const container = window.document.createElement('div')
  window.document.body.appendChild(container)
  Object.entries({ clientWidth: 800, clientHeight: 600, offsetWidth: 800, offsetHeight: 600 })
    .forEach(([k, value]) => Object.defineProperty(container, k, { value }))
  return container
}

// Un motor con su mapa, la política pedida y tiles; `capa` es la capa de tiles que puso el motor.
const montar = (zoomAnimation, center = [-33, -70]) => {
  const engine = new MapEngine({ container: contenedor(), view: { center, zoom: 10 }, zoomAnimation })
  engine.setTileProvider({ url: URL_TILES, noWrap: false })
  const map    = engine.getLeafletMap()
  let capa
  map.eachLayer(layer => layer instanceof L.TileLayer && (capa = layer))
  return { engine, map, capa }
}

// Cada tile de la capa carga por el camino de Leaflet: su imagen dispara `load`. jsdom no decodifica,
// así que la imagen declara que tiene contenido.
const cargar = capa => Object.values(capa._tiles).forEach(({ el }) => {
  Object.defineProperties(el, { complete: { value: true }, naturalWidth: { value: 256 } })
  el.dispatchEvent(new window.Event('load'))
})

// Un zoom animado arranca en el frame siguiente y se asienta a los 250 ms.
const frame   = () => new Promise(resolve => window.requestAnimationFrame(resolve))
const asiente = map => new Promise(resolve => map.once('zoomend', resolve))
const pausa   = ms => new Promise(resolve => setTimeout(resolve, ms))

test('un zoom que Leaflet no anima deja la foto de los tiles que soltó, debajo del de tiles y sin puntero', () => {
  const { engine, map, capa } = montar('none')
  cargar(capa)
  const tiles = Object.keys(capa._tiles).length
  dibujos.length = 0

  engine.camera.setZoom(9)

  const pane = map.getPane(PANE)
  assert.equal(map.getZoom(), 9)
  assert.equal(capa._tileZoom, 9, 'la capa ya soltó los tiles del zoom 10')
  assert.equal(pane?.children.length, 1, 'y la foto quedó en su pane')
  assert.equal(dibujos.length, tiles, 'con todos los tiles cargados')
  assert.match(pane.firstChild.style.transform, /scale\(0\.5\)$/, 'reproyectada al zoom nuevo')
  assert.deepEqual([pane.style.zIndex, pane.style.pointerEvents], ['150', 'none'])
  engine.destroy()
})

test('un zoom animado no fotografía, y esconde la foto que había', async () => {
  const { engine, map, capa } = montar('in-only')
  cargar(capa)
  engine.camera.setZoom(9)
  const pane = map.getPane(PANE)
  assert.equal(pane.children.length, 1, 'alejar no anima: foto')
  const antes = dibujos.length

  const asentado = asiente(map)
  engine.camera.setZoom(10)
  await frame()
  assert.equal(pane.children.length, 0, 'acercar anima: la foto no acompaña a la transición y sale al empezar')
  await asentado
  assert.equal(map.getZoom(), 10)
  assert.equal(dibujos.length, antes, 'el zoom animado no fotografía')
  assert.equal(pane.children.length, 0, 'ni vuelve a poner la foto al asentarse')
  engine.destroy()
})

// Un paneo más largo que el contenedor tampoco lo anima Leaflet: resetea sin cambiar el zoom, así que no
// hay `zoomstart` que esconda la foto de antes.
test('un salto sin cambio de zoom también resetea, y la foto que ya no cae en la vista sale', () => {
  const { engine, map, capa } = montar('none')
  cargar(capa)
  engine.camera.setZoom(9)
  const pane = map.getPane(PANE)
  assert.equal(pane.children.length, 1)

  engine.camera.setView([-20, -70], 9)
  assert.equal(pane.children.length, 0)
  engine.destroy()
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
  const { engine, capa } = montar('none')
  const entradas = Object.values(capa._tiles)
  assert.equal(capa._tileZoom, 10)
  assert.ok(entradas.length > 0)
  assert.ok(entradas.every(({ el, coords, loaded }) =>
    el instanceof window.HTMLImageElement && coords.z === 10 && Number.isInteger(coords.x) && loaded === undefined))

  cargar(capa)
  assert.ok(entradas.every(({ loaded }) => loaded > 0), 'al cargar la imagen, Leaflet anota cuándo')
  engine.destroy()
})

// Junto al antimeridiano la vista de un zoom más profundo cruza el borde del mundo, y las semillas de ese
// lado tienen una x que da la vuelta. La vuelta es con el ancho del mundo de su zoom: al este del
// meridiano 0 la x ya pasa el del zoom actual. La y invertida (`{-y}`) también sale del rango de su zoom.
test('una semilla pide el tile que Leaflet pediría a ese zoom: la vuelta al mundo y la y invertida son las de ese zoom', async () => {
  const pedidas = []
  globalThis.requestIdleCallback = cb => setTimeout(cb, 0)
  globalThis.cancelIdleCallback  = clearTimeout
  globalThis.Image               = class { set src(url) { pedidas.push(url); queueMicrotask(() => this.onload()) } }

  const centro                = [10.3, 179.99]
  const { engine, map, capa } = montar('none', centro)
  const grilla                = () => [capa._tileZoom, capa._wrapX, capa._wrapY, capa._globalTileRange]
  const antes                 = grilla()
  const zoomDe                = url => Number(url.split('/')[3])
  await pausa(20)
  assert.deepEqual(grilla(), antes, 'la capa vuelve a su grilla después de armar las URL')

  ;[11, 12].forEach(zoom => {
    const semillas = pedidas.filter(url => zoomDe(url) === zoom)
    engine.camera.setView(centro, zoom)
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
  engine.destroy()
})
