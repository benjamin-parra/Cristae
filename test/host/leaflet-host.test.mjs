// El anfitrión sobre el Leaflet REAL, en jsdom: el ciclo de vista con su orden, la política de
// animación del zoom en los tres caminos que animan —el `setView` de un cambio de zoom, el cierre del
// pinch y el vuelo—, lo que le devuelve a un mapa adoptado al soltarlo y cómo lo suelta el motor. Son
// también los tests de contrato de los privados que el anfitrión intercepta: si Leaflet deja de pasar
// por `_tryAnimatedZoom` al decidir un zoom, o por `_animateZoom` al cerrar el pinch —y por
// `_resetView` para cerrarlo sin animar—, la política deja de aplicarse en silencio y es acá donde se ve.
// Corre con: node --test test/host/leaflet-host.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { contenedor, prepararDom } from '../../test-helpers/leaflet-real.mjs'

// Con transformaciones 3D, como en un navegador: sin ellas Leaflet no anima ningún zoom ni vuela.
const window = prepararDom({ transformaciones3d: true })
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
const frame   = () => new Promise(resolve => window.requestAnimationFrame(resolve))
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

// Una capa que oye la vista asentada se suscribe a varios tipos de una vez, como en Leaflet, y se da de
// baja con una sola llamada.
test('on acepta varios tipos separados por espacios y los suelta con una sola baja', () => {
  const { host, camera } = montar('none')
  const oido = []
  const off  = camera.on('movestart moveend', () => oido.push('vista'))

  camera.setView([-33.1, -70.1], 10, { animate: false })
  assert.equal(oido.length, 2, 'un aviso por tipo')
  off()
  camera.setView([-33.2, -70.2], 10, { animate: false })
  assert.equal(oido.length, 2, 'y la baja suelta los dos')
  host.destroy()
})

// Un mapa adoptado puede llegar sin vista, y entonces la cámara no se puede leer: `hasView` lo dice. Ya
// vale en el `moveend` del primer `setView`, que es donde una capa repinta al tomar la vista. Es el test de
// contrato del privado que lee, `_loaded`.
test('hasView dice si la cámara se puede leer, y ya vale en el primer moveend', () => {
  const map     = L.map(contenedor())
  const host    = adoptLeafletHost(map)
  let enMoveend = null
  host.camera.on('moveend', () => enMoveend = host.camera.hasView())

  assert.equal(host.camera.hasView(), false)
  assert.throws(() => host.camera.bounds(), /Set map center and zoom first/)
  map.setView(VISTA.center, VISTA.zoom)
  assert.equal(enMoveend, true)
  assert.doesNotThrow(() => host.camera.bounds())
  host.destroy()
  map.remove()
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

// Dos dedos que se abren o se cierran sobre el contenedor. El gesto deja el zoom fraccionario, y el
// cierre lo lleva al entero más cercano: de 100 px a 170 px el zoom sube 0,77 y cierra en 11, y de
// 100 px a 60 px baja 0,74 y cierra en 9, que desde 9,26 es alejar. jsdom tiene eventos de toque pero
// no `Touch`: los dedos van como la lista `touches` que Leaflet lee.
const tocar = (container, tipo, xs) => {
  const e = new window.Event(tipo, { bubbles: true, cancelable: true })
  Object.defineProperty(e, 'touches', { value: xs.map(clientX => ({ clientX, clientY: 300 })) })
  container.dispatchEvent(e)
}

const pellizcar = async (host, separacion, centro = 400) => {
  const container = host.map.getContainer()
  tocar(container, 'touchstart', [350, 450])
  tocar(container, 'touchmove', [centro - separacion / 2, centro + separacion / 2])
  await frame()
  tocar(container, 'touchend', [])
}

// El cierre del pinch no pasa por setView: Leaflet llama a `_animateZoom`, y sin animación a `_resetView`.
const cierreAnima = async (modo, separacion) => {
  const { host, camera, oido } = montar(modo)
  await pellizcar(host, separacion)
  const salto = !oido.includes('zoomanim')
  salto || await asiente(camera)
  const final = camera.zoom()
  host.destroy()
  return { anima: !salto, final }
}

test('el cierre del pinch sigue la política, con el mismo criterio que un zoom', async () => {
  assert.deepEqual(await cierreAnima('on', 170), { anima: true, final: 11 }, 'on: acercar anima')
  assert.deepEqual(await cierreAnima('on', 60), { anima: true, final: 9 }, 'on: alejar anima')
  assert.deepEqual(await cierreAnima('in-only', 170), { anima: true, final: 11 }, 'in-only: acercar anima')
  assert.deepEqual(await cierreAnima('in-only', 60), { anima: false, final: 9 }, 'in-only: alejar salta')
  assert.deepEqual(await cierreAnima('none', 170), { anima: false, final: 11 }, 'none: salta al zoom ajustado')
})

// Dos dedos que se desplazan juntos pellizcan sin cambiar el zoom. El gesto abre con `zoomstart`, y su
// cierre, que no es un zoom, tiene que emitir el `zoomend` que lo cierra: quien se esconde en el primero
// y vuelve en el segundo quedaría escondido.
test('el cierre de un pinch que no cambia el zoom cierra el zoomstart del gesto, con cualquier política', async () => {
  for (const modo of ['none', 'in-only', 'on']) {
    const { host, camera, oido } = montar(modo)
    await pellizcar(host, 100, 430)
    await new Promise(resolve => setTimeout(resolve, 300))
    assert.deepEqual(oido.filter(tipo => tipo === 'zoomstart' || tipo === 'zoomend'), ['zoomstart', 'zoomend'], modo)
    assert.equal(camera.zoom(), 10, modo)
    host.destroy()
  }
})

// Un vuelo empieza en la vista de partida y llega en varios frames; un setView ya está en el destino.
test('flyTo vuela si la política anima el zoom de destino, y si no es un setView', () => {
  const esperado = { none: [false, false], 'in-only': [true, false], on: [true, true] }
  Object.entries(esperado).forEach(([modo, [acercar, alejar]]) => {
    const vuela = zoom => {
      const { host, camera } = montar(modo)
      camera.flyTo([-33.2, -70.2], zoom)
      const enDestino = camera.zoom() === zoom
      host.destroy()
      return !enDestino
    }
    assert.equal(vuela(12), acercar, `${modo}: hacia 12`)
    assert.equal(vuela(8), alejar, `${modo}: hacia 8`)
  })
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
  assert.equal(map._animateZoom, L.Map.prototype._animateZoom)
  assert.deepEqual(['_tryAnimatedZoom', '_animateZoom'].filter(name => Object.hasOwn(map, name)), [],
    'heredados del prototipo, como los tenía')
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
// sale de la cadena aunque tenga otro encima, así que al soltar el último el mapa recupera sus métodos.
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
  assert.equal(map._animateZoom, L.Map.prototype._animateZoom)
  assert.deepEqual(['_tryAnimatedZoom', '_animateZoom'].filter(name => Object.hasOwn(map, name)), [])
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

// El dueño de un mapa adoptado puede removerlo antes de destruir el motor, con un pane suyo que el motor
// tomó prestado: el motor igual suelta lo que le puso.
test('el motor suelta su anfitrión aunque el dueño haya removido el mapa antes', () => {
  const map    = L.map(contenedor()).setView(VISTA.center, VISTA.zoom)
  const engine = new MapEngine({ host: adoptLeafletHost(map), glify: null })
  engine.addPolygonLayer({ id: 'zonas', backend: 'leaflet', pane: 'overlayPane', accessors: { idOf: it => it.id, ringsOf: it => it.rings } })

  map.remove()
  assert.doesNotThrow(() => engine.destroy())
  assert.deepEqual(['_tryAnimatedZoom', '_animateZoom'].filter(name => Object.hasOwn(map, name)), [])
})

test('la señal ready del motor sale con su promesa: quien se suscribe al construirlo la oye', async () => {
  const engine = new MapEngine({ container: contenedor(), view: VISTA, glify: null })
  let oida     = false
  engine.on('ready', () => oida = true)
  await engine.ready
  assert.ok(oida)
  engine.destroy()
})
