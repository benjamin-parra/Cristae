// El anfitrión sobre el Leaflet REAL, en jsdom: el ciclo de vista con su orden, la política de
// animación del zoom en el `setView` de un cambio de zoom, lo que le devuelve a un mapa adoptado al
// soltarlo y cómo lo suelta el motor. Es también el test de contrato del privado que el anfitrión
// intercepta: si Leaflet deja de pasar por `_tryAnimatedZoom` al decidir un zoom, la política deja de
// aplicarse en silencio y es acá donde se ve.
// Corre con: node --test test/host/leaflet-host.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { contenedor, prepararDom } from '../../test-helpers/leaflet-real.mjs'

// Con transformaciones 3D, como en un navegador: sin ellas Leaflet no anima ningún zoom.
prepararDom({ transformaciones3d: true })
const { default: L }                          = await import('leaflet')
const { createLeafletHost, adoptLeafletHost } = await import('../../src/host/LeafletHost.js')
const { MapEngine }                           = await import('../../src/engine/MapEngine.js')

const VISTA   = { center: [-33, -70], zoom: 10 }
const EVENTOS = ['movestart', 'move', 'moveend', 'zoomstart', 'zoomanim', 'zoomend', 'resize']

// Un anfitrión propio con la política pedida, y lo que oyó en el orden en que lo oyó.
const montar = zoomPolicy => {
  const host = createLeafletHost({ container: contenedor(), view: VISTA })
  const oido = []
  host.camera.zoomPolicy = zoomPolicy
  EVENTOS.forEach(tipo => host.camera.on(tipo, () => oido.push(tipo)))
  return { host, camera: host.camera, oido }
}

// Un zoom animado se asienta a los 250 ms; un frame alcanza para que arranque.
const frame   = () => new Promise(resolve => requestAnimationFrame(resolve))
const asiente = camera => new Promise(resolve => { const off = camera.on('zoomend', () => { off(); resolve() }) })

// Un cambio de zoom por la cámara: si anima, `zoomanim` llega un frame después y la vista se asienta
// después; si no, el zoom ya cambió al volver del comando.
const animaAl = async (camera, oido, zoom) => {
  oido.length = 0
  camera.setZoom(zoom)
  const salto = camera.zoom() === zoom
  await (salto ? Promise.resolve() : asiente(camera))
  return oido.includes('zoomanim')
}

test('zoomanim sale antes de que la vista cambie, con el destino plano', async () => {
  const { host, camera, oido } = montar('on')
  let enZoomanim = null
  camera.on('zoomanim', destino => enZoomanim = { destino, zoom: camera.zoom(), center: camera.center() })

  camera.setZoom(11)
  await asiente(camera)

  assert.deepEqual(enZoomanim.destino, { center: camera.center(), zoom: 11 }, 'el destino es la vista final')
  assert.equal(Object.getPrototypeOf(enZoomanim.destino.center), Object.prototype, 'con el centro plano')
  assert.equal(enZoomanim.zoom, 10, 'durante el reparto la cámara todavía da la vista de partida')
  assert.deepEqual(oido, ['zoomstart', 'movestart', 'zoomanim', 'move', 'zoomend', 'moveend'])
  host.destroy()
})

// Un tipo tiene un oyente en el mapa: los suscriptores del anfitrión se reparten su lugar, aunque
// lleguen después de otro oyente del mapa.
test('el ciclo de vista tiene un solo emisor', () => {
  const { host, camera } = montar('none')
  const orden = []
  camera.on('moveend', () => orden.push('primero'))
  host.map.on('moveend', () => orden.push('mapa'))
  camera.on('moveend', () => orden.push('segundo'))

  camera.setView([-33.1, -70.1], 10, { animate: false })
  assert.deepEqual(orden, ['primero', 'segundo', 'mapa'])
  host.destroy()
})

// Como en Leaflet: quien se baja a mitad de un reparto ya soltó lo que su oyente toca, y quien se
// suscribe a mitad espera al siguiente.
test('un reparto no llama a quien se bajó ni a quien se suscribió a mitad de él', () => {
  const { host, camera } = montar('none')
  const oido = []
  let off
  camera.on('moveend', () => {
    off()
    camera.on('moveend', () => oido.push('nuevo'))
  })
  off = camera.on('moveend', () => oido.push('bajado'))

  camera.setView([-33.1, -70.1], 10, { animate: false })
  assert.deepEqual(oido, [], 'ni el que se bajó ni el que llegó')
  camera.setView([-33.2, -70.2], 10, { animate: false })
  assert.deepEqual(oido, ['nuevo'], 'el que llegó entra en el reparto siguiente')
  host.destroy()
})

test("'none' no anima ningún zoom de setView; 'in-only' sólo los que no alejan; 'on' todos", async () => {
  const esperado = { none: [false, false], 'in-only': [true, false], on: [true, true] }
  for (const [modo, [acercar, alejar]] of Object.entries(esperado)) {
    const { host, camera, oido } = montar(modo)
    assert.equal(await animaAl(camera, oido, 11), acercar, `${modo}: acercar`)
    assert.equal(await animaAl(camera, oido, 9), alejar, `${modo}: alejar`)
    host.destroy()
  }
})

test('la política cambia en vivo', async () => {
  const { host, camera, oido } = montar('none')
  assert.equal(await animaAl(camera, oido, 11), false)
  camera.zoomPolicy = 'on'
  assert.equal(await animaAl(camera, oido, 12), true)
  host.destroy()
})

// Mientras dura un zoom animado, Leaflet ignora el pedido de otro zoom. Con 'in-only' también: negar el
// alejamiento reseteaba a mitad de la transición, y al terminar ésta la vista volvía a su destino.
test("con 'in-only', alejar durante un acercamiento animado se ignora como con 'on'", async () => {
  for (const modo of ['in-only', 'on']) {
    const { host, camera } = montar(modo)
    camera.setZoom(11)
    await frame()
    camera.setZoom(9)
    const durante = camera.zoom()
    await asiente(camera)
    assert.deepEqual([durante, camera.zoom()], [11, 11], modo)
    host.destroy()
  }
})

test('un mapa propio no anima el zoom y uno adoptado conserva el de su dueño', () => {
  const propio = createLeafletHost({ container: contenedor(), view: VISTA })
  const map    = L.map(contenedor()).setView(VISTA.center, VISTA.zoom)
  const ajeno  = adoptLeafletHost(map)
  assert.equal(propio.camera.zoomPolicy, 'none')
  assert.equal(ajeno.camera.zoomPolicy, 'on')
  propio.destroy()
  ajeno.destroy()
  map.remove()
})

// Soltar un mapa adoptado le devuelve lo que se le tomó y lo deja vivo.
test('destruir un anfitrión adoptado devuelve el mapa como estaba', () => {
  const map  = L.map(contenedor()).setView(VISTA.center, VISTA.zoom)
  const host = adoptLeafletHost(map)
  const oido = []
  host.camera.on('moveend', () => oido.push('moveend'))
  host.destroy()

  map.setView(VISTA.center, 12, { animate: false })
  assert.deepEqual(oido, [], 'ya no oye la vista')
  assert.equal(map.getZoom(), 12, 'y el mapa sigue vivo')
  assert.equal(map._tryAnimatedZoom, L.Map.prototype._tryAnimatedZoom)
  assert.equal(Object.hasOwn(map, '_tryAnimatedZoom'), false, 'heredado del prototipo, como lo tenía')
  map.remove()
})

// Un mapa adoptado sin vista la toma con su primer `setView`. Si el motor se destruye antes, esa vista
// ya no es asunto suyo: su promesa no se cumple con un motor muerto.
test('un mapa adoptado sin vista no despierta al motor destruido al tomarla', async () => {
  const map    = L.map(contenedor())
  const engine = new MapEngine({ host: adoptLeafletHost(map), glify: null })
  let listo    = false
  engine.ready.then(() => listo = true)
  engine.destroy()

  map.setView(VISTA.center, VISTA.zoom)
  await new Promise(resolve => setTimeout(resolve))
  assert.equal(listo, false)
  map.remove()
})

// Con dos anfitriones sobre el mismo mapa, el de arriba envuelve lo que puso el de abajo: soltar el de
// abajo no puede sacarle su política al de arriba, y lo suyo queda como paso directo.
test('con dos anfitriones sobre un mapa, soltar el de abajo no toca al de arriba', async () => {
  const map    = L.map(contenedor()).setView(VISTA.center, VISTA.zoom)
  const abajo  = adoptLeafletHost(map)
  const arriba = adoptLeafletHost(map)
  const oido   = []
  abajo.camera.zoomPolicy  = 'none'
  arriba.camera.zoomPolicy = 'none'
  arriba.camera.on('zoomanim', () => oido.push('zoomanim'))

  abajo.destroy()
  assert.equal(await animaAl(arriba.camera, oido, 11), false, 'la de arriba sigue sin animar')
  arriba.camera.zoomPolicy = 'on'
  assert.equal(await animaAl(arriba.camera, oido, 12), true, 'y la de abajo, suelta, ya no filtra')
  arriba.destroy()
  map.remove()
})

// Y al revés: el de arriba sale de encima y el mapa vuelve a lo que envolvía, la política del de abajo.
test('con dos anfitriones sobre un mapa, soltar el de arriba deja la política del de abajo', async () => {
  const map    = L.map(contenedor()).setView(VISTA.center, VISTA.zoom)
  const abajo  = adoptLeafletHost(map)
  const arriba = adoptLeafletHost(map)
  const oido   = []
  abajo.camera.zoomPolicy = 'none'
  abajo.camera.on('zoomanim', () => oido.push('zoomanim'))

  arriba.destroy()
  assert.equal(await animaAl(abajo.camera, oido, 11), false)
  abajo.destroy()
  map.remove()
})

// El relevo de un mapa longevo: el anfitrión nuevo se adopta antes de soltar el viejo. El que se suelta
// sale de la cadena aunque tenga otro encima, así que al soltar el último el mapa recupera su método.
test('los relevos solapados no dejan envoltorios muertos en el mapa', () => {
  const map = L.map(contenedor()).setView(VISTA.center, VISTA.zoom)
  let viejo = adoptLeafletHost(map)
  for (let i = 0; i < 3; i++) {
    const nuevo = adoptLeafletHost(map)
    viejo.destroy()
    viejo = nuevo
  }
  viejo.destroy()
  assert.equal(map._tryAnimatedZoom, L.Map.prototype._tryAnimatedZoom)
  assert.equal(Object.hasOwn(map, '_tryAnimatedZoom'), false)
  map.remove()
})

// Un envoltorio que no es de un anfitrión —el de otra copia de Cristae, o uno del dueño del mapa— no deja
// sacar de la cadena al que quedó debajo: ése queda como paso directo y ya no filtra.
test('un anfitrión soltado bajo un envoltorio ajeno pasa de largo', async () => {
  const map  = L.map(contenedor()).setView(VISTA.center, VISTA.zoom)
  const host = adoptLeafletHost(map)
  const oido = []
  host.camera.zoomPolicy = 'none'
  const debajo           = map._tryAnimatedZoom
  map._tryAnimatedZoom   = function (...args) { return debajo.apply(this, args) }
  map.on('zoomanim', () => oido.push('zoomanim'))

  host.destroy()
  const asentado = new Promise(resolve => map.once('zoomend', resolve))
  map.setZoom(11)
  await asentado
  assert.deepEqual(oido, ['zoomanim'], 'el zoom anima como en el mapa sin anfitrión')
  map.remove()
})

// El motor es dueño de su anfitrión: el que crea se lleva el mapa, y el adoptado lo devuelve como estaba.
test('el motor suelta su anfitrión al destruirse', () => {
  const propio    = new MapEngine({ container: contenedor(), view: VISTA, glify: null })
  const map       = L.map(contenedor()).setView(VISTA.center, VISTA.zoom)
  const ajeno     = new MapEngine({ host: adoptLeafletHost(map), glify: null, zoomAnimation: 'none' })
  const removidos = []
  propio.getLeafletMap().on('unload', () => removidos.push('propio'))
  map.on('unload', () => removidos.push('adoptado'))

  propio.destroy()
  ajeno.destroy()
  assert.deepEqual(removidos, ['propio'], 'el mapa propio se remueve y el adoptado sigue siendo de su dueño')
  assert.equal(map._tryAnimatedZoom, L.Map.prototype._tryAnimatedZoom, 'que lo recibe sin la política')
  map.remove()
})

test('la señal ready del motor sale con su promesa: quien se suscribe al construirlo la oye', async () => {
  const engine = new MapEngine({ container: contenedor(), view: VISTA, glify: null })
  let oida     = false
  engine.on('ready', () => oida = true)
  await engine.ready
  assert.ok(oida)
  engine.destroy()
})
