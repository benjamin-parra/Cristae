// El encuadre con tope y los límites de la cámara, sobre el Leaflet REAL en jsdom: `fitBounds` con
// `maxZoom` y `animate` de punta a punta —cámara, anfitrión y Leaflet—, `setLimits` del anfitrión y del
// motor, y la vista inicial de un mapa propio que ya los cumple. Son también los tests de contrato de lo
// que el anfitrión le deja a Leaflet: que `fitBounds` tope antes de centrar, y que el arrastre lea la
// viscosidad de las opciones del mapa al empezar.
// Corre con: node --test test/host/camera-limits.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { contenedor, prepararDom } from '../../test-helpers/leaflet-real.mjs'

prepararDom()
const { default: L }                          = await import('leaflet')
const { createLeafletHost, adoptLeafletHost } = await import('../../src/host/LeafletHost.js')
const { Camera }                              = await import('../../src/engine/Camera.js')
const { MapEngine }                           = await import('../../src/engine/MapEngine.js')

const NINGUNO = { minZoom: null, maxZoom: null, maxBounds: null, viscosity: null }
const CAJA    = { south: 10, west: 10, north: 20, east: 20 }

const cerca = (valor, esperado, tolerancia, mensaje) =>
  assert.ok(Math.abs(valor - esperado) <= tolerancia, `${mensaje}: ${valor} en vez de ${esperado}`)

const dentro = ({ lat, lng }, { south, west, north, east }) => lat >= south && lat <= north && lng >= west && lng <= east

test('con maxZoom, fitBounds topa el zoom y deja la caja en el medio de la región visible', () => {
  const host   = createLeafletHost({ container: contenedor(), view: { center: [0, 0], zoom: 3 } })
  const camera = new Camera({ host, insets: { left: 200 } })
  camera.fitBounds({ south: -33.01, west: -70.01, north: -32.99, east: -69.99 }, { maxZoom: 10, animate: false })
  assert.equal(camera.getZoom(), 10)
  const { x, y } = camera.latLngToContainerPoint([-33, -70])
  cerca(x, 500, 1, 'la región visible va de 200 a 800')
  cerca(y, 300, 1, 'y de alto, entera')
  host.destroy()
})

test('un maxZoom que no es un número finito no topa el encuadre, como no limita en los límites', () => {
  const host   = createLeafletHost({ container: contenedor(), view: { center: [0, 0], zoom: 3 } })
  const camera = new Camera({ host })
  const caja   = { south: -33.01, west: -70.01, north: -32.99, east: -69.99 }
  camera.fitBounds(caja, { animate: false })
  const libre = camera.getZoom()
  ;[NaN, '12'].forEach(maxZoom => {
    camera.fitBounds(caja, { maxZoom, animate: false })
    assert.equal(camera.getZoom(), libre, `con maxZoom ${maxZoom}`)
  })
  host.destroy()
})

test('con animate:false, el paneo de fitBounds llega sin animar', () => {
  const encuadra = animate => {
    const host   = createLeafletHost({ container: contenedor(), view: { center: [0, 0], zoom: 5 } })
    const camera = new Camera({ host })
    camera.fitBounds({ south: 0.9, west: 0.9, north: 1.1, east: 1.1 }, { maxZoom: 5, animate })
    const { lat, lng } = camera.getCenter()
    host.destroy()
    return Math.abs(lat - 1) < 0.05 && Math.abs(lng - 1) < 0.05
  }
  assert.equal(encuadra(false), true)
  assert.equal(encuadra(undefined), false, 'sin él Leaflet anima el paneo corto')
})

test('setLimits fija los cuatro: el zoom queda entre los topes, y el que no viene deja de limitar', () => {
  const { camera, destroy } = createLeafletHost({ container: contenedor(), view: { center: [0, 0], zoom: 10 } })
  camera.setLimits({ ...NINGUNO, minZoom: 3, maxZoom: 8 })
  assert.equal(camera.zoom(), 8, 'la vista que queda fuera vuelve adentro')
  assert.deepEqual([camera.minZoom(), camera.maxZoom()], [3, 8])
  camera.setZoom(1)
  assert.equal(camera.zoom(), 3)

  camera.setLimits({ minZoom: 3 })
  assert.equal(camera.maxZoom(), Infinity, 'sin tope ni tiles, no hay techo')
  camera.setZoom(15)
  assert.equal(camera.zoom(), 15)
  camera.setLimits({})
  assert.equal(camera.minZoom(), 0, 'sin tope ni tiles, el piso es 0')
  destroy()
})

test('con maxBounds la cámara no sale de la caja, y sin ella vuelve a ir a cualquier lado', () => {
  const { camera, destroy } = createLeafletHost({ container: contenedor(), view: { center: [-33, -70], zoom: 8 } })
  camera.setLimits({ ...NINGUNO, maxBounds: CAJA })
  assert.ok(dentro(camera.center(), CAJA), 'la vista que queda fuera vuelve adentro')
  camera.setView([-33, -70], 8)
  assert.ok(dentro(camera.center(), CAJA), 'y no se la puede sacar')

  camera.setLimits(NINGUNO)
  camera.setView([-33, -70], 8)
  cerca(camera.center().lat, -33, 1e-6, 'sin caja')
  destroy()
})

test('el arrastre lee la viscosidad de las opciones del mapa al empezar', () => {
  const host     = createLeafletHost({ container: contenedor(), view: { center: [15, 15], zoom: 8 } })
  const dragging = host.map.dragging
  host.camera.setLimits({ ...NINGUNO, maxBounds: CAJA, viscosity: 0.5 })
  dragging._onDragStart()
  assert.equal(dragging._viscosity, 0.5)

  host.camera.setLimits({ ...NINGUNO, maxBounds: CAJA })
  dragging._onDragStart()
  assert.equal(dragging._offsetLimit, null, 'sin viscosidad el borde no resiste')
  host.destroy()
})

test('un mapa propio nace con sus límites: la vista inicial ya los cumple, sin moverse', () => {
  const caja = { south: 0.5, west: 0.5, north: 10, east: 10 }
  const { camera, map, destroy } = createLeafletHost({
    container : contenedor(),
    view      : { center: [0, 0], zoom: 5 },
    limits    : { ...NINGUNO, minZoom: 6, maxBounds: caja },
  })
  assert.equal(camera.zoom(), 6)
  assert.ok(dentro(camera.center(), caja), 'puestos después, la traerían con un paneo animado')
  assert.ok(!map._panAnim, 'que ni empezó')
  destroy()
})

test('el motor pone sus límites en el mapa propio y no los lee en uno adoptado', () => {
  const propio = new MapEngine({ container: contenedor(), view: { center: [0, 0], zoom: 2 }, minZoom: 4 })
  const map    = L.map(contenedor()).setView([0, 0], 2)
  const ajeno  = new MapEngine({ host: adoptLeafletHost(map), minZoom: 4 })
  assert.equal(propio.camera.getZoom(), 4)
  assert.equal(map.getZoom(), 2)
  assert.equal(map.getMinZoom(), 0, 'el adoptado conserva los de su dueño')

  ajeno.setLimits({ minZoom: 4 })
  assert.equal(map.getZoom(), 4, 'y los recibe por setLimits')
  propio.destroy()
  ajeno.destroy()
  map.remove()
})

// Abrir un tope no mueve la vista: el aviso es lo único que sale, uno por tope que cambia.
test('el motor avisa con zoomlevelschange que cambiaron los topes, aunque la vista no se mueva', () => {
  const engine = new MapEngine({ container: contenedor(), view: { center: [0, 0], zoom: 10 }, maxZoom: 10 })
  const avisos = []
  engine.on('zoomlevelschange', detail => avisos.push(detail))
  engine.on('viewportchange', () => avisos.push('viewportchange'))

  engine.setLimits({ minZoom: 3, maxZoom: 15 })
  assert.deepEqual(
    { ultimo: avisos.at(-1), vista: avisos.includes('viewportchange'), zoom: engine.camera.getZoom() },
    { ultimo: { minZoom: 3, maxZoom: 15 }, vista: false, zoom: 10 },
  )
  engine.destroy()
})

test('al soltarse, el mapa adoptado recupera los límites que tenía antes del primer setLimits', () => {
  const map    = L.map(contenedor(), { minZoom: 1, maxZoom: 12, maxBounds: [[-50, -50], [50, 50]], maxBoundsViscosity: 0.5 })
  const caja   = map.setView([0, 0], 5).options.maxBounds
  const engine = new MapEngine({ host: adoptLeafletHost(map) })
  engine.setLimits({ minZoom: 4, maxZoom: 6, maxBounds: CAJA, maxBoundsViscosity: 1 })
  engine.setLimits({ minZoom: 3 })
  engine.destroy()
  assert.equal(map.getMinZoom(), 1)
  assert.equal(map.getMaxZoom(), 12)
  assert.equal(map.options.maxBounds, caja)
  assert.equal(map.options.maxBoundsViscosity, 0.5)
  map.remove()
})

test('setLimits del motor: lo que no es un número finito o una caja no limita, y sin nada los quita', () => {
  const host   = createLeafletHost({ container: contenedor(), view: { center: [0, 0], zoom: 5 } })
  const engine = new MapEngine({ host })
  const map    = host.map
  assert.equal(engine.setLimits({ minZoom: '3', maxZoom: 7, maxBounds: [[0, 0], [10, 10]], maxBoundsViscosity: Infinity }), engine)
  assert.equal(map.getMinZoom(), 0)
  assert.equal(map.getMaxZoom(), 7)
  assert.equal(map.options.maxBoundsViscosity, 0)
  assert.ok(map.options.maxBounds, 'el par de esquinas es una caja')

  engine.setLimits({ maxBounds: { south: 10, west: 0, north: 0, east: 10 } })
  assert.equal(map.options.maxBounds, null, 'una caja invertida no lo es')
  assert.equal(map.getMaxZoom(), Infinity)
  engine.setLimits()
  engine.destroy()
})
