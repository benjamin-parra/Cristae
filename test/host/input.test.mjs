// La entrada del anfitrión sobre el Leaflet REAL, en jsdom: el arrastre del usuario de punta a punta,
// incluido el que Leaflet corta sin `dragend`; el préstamo del arrastre; el píxel de un evento; los
// eventos crudos del contenedor frente a los que oye el anfitrión, y lo que Leaflet todavía reconoce: el
// click del mapa y los controles. Son los tests de contrato de los dos privados que la entrada lee: si
// `dragging.moving()` deja de dar el arrastre en curso, o `_isClickDisabled` deja de reconocer un
// control, el cursor del arrastre o la pulsación sobre un control se rompen en silencio y es acá donde se
// ve. Corre con: node --test test/host/input.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { contenedor, prepararDom } from '../../test-helpers/leaflet-real.mjs'

// Leaflet decide al evaluarse cómo escucha el toque: jsdom tiene `ontouchstart`, así que el arrastre oye
// `touchstart` directo.
const window               = prepararDom()
const { default: L }       = await import('leaflet')
const { adoptLeafletHost } = await import('../../src/host/LeafletHost.js')

// Un mapa con vista, adoptado. Sin inercia: el arrastre termina en su `dragend` y no sigue animando.
const montar = opciones => {
  const map  = L.map(contenedor(opciones), { inertia: false }).setView([-33, -70], 10)
  const host = adoptLeafletHost(map)
  return { map, host, input: host.input, container: map.getContainer() }
}

const raton    = (el, tipo, x, y) => el.dispatchEvent(new window.MouseEvent(tipo, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, which: 1 }))
const puntero  = (el, tipo) => el.dispatchEvent(new window.PointerEvent(tipo, { bubbles: tipo !== 'pointerenter' }))
const arrastre = container => {
  raton(container, 'mousedown', 100, 100)
  raton(container, 'mousemove', 150, 150)
}
const soltar   = container => raton(container, 'mouseup', 150, 150)

// Un segundo dedo que se apoya: jsdom tiene eventos de toque pero no `Touch`, así que los dedos van como
// la lista `touches` que Leaflet lee.
const segundoDedo = container => {
  const e = new window.Event('touchstart', { bubbles: true, cancelable: true })
  Object.defineProperty(e, 'touches', { value: [{ clientX: 100, clientY: 100 }, { clientX: 200, clientY: 200 }] })
  container.dispatchEvent(e)
}

// Lo que avisó `onDrag`, en orden, y cómo lo daba Leaflet en ese momento.
const oirArrastre = ({ map, input }) => {
  const avisos = []
  input.onDrag(value => avisos.push({ value, moving: !!map.dragging.moving() }))
  return avisos
}

/* ── El arrastre del usuario ── */

test('onDrag avisa el arrastre del usuario: al empezar, cuando Leaflet todavía no lo da en curso, y al soltar', () => {
  const esc    = montar()
  const avisos = oirArrastre(esc)

  arrastre(esc.container)
  assert.deepEqual(avisos, [{ value: true, moving: false }], 'dragstart abre el arrastre antes de que Leaflet lo marque')
  assert.equal(esc.map.dragging.moving(), true, 'y el primer movimiento lo marca en curso')
  soltar(esc.container)
  assert.deepEqual(avisos.slice(1), [{ value: false, moving: false }], 'dragend lo cierra, ya fuera de curso')
  esc.map.remove()
})

// Leaflet pone `_moved` en falso al apoyarse el segundo dedo, antes de terminar el arrastre, así que lo
// termina sin `dragend`. Lo que sigue a ese corte es el `moveend` del pinch, el `pointerup` del último
// dedo o botón, o el `pointerenter` si se soltó afuera: cualquiera de los tres lo cierra, y mientras
// Leaflet lo siga dando en curso, ninguno.
test('un segundo dedo corta el arrastre sin dragend, y el anfitrión lo cierra en lo que siempre le sigue', () => {
  const lecturas = [
    ['el moveend del pinch', esc => esc.map.fire('moveend')],
    ['el pointerup del último', esc => puntero(esc.container, 'pointerup')],
    ['el pointerenter de la vuelta', esc => puntero(esc.container, 'pointerenter')],
  ]
  lecturas.forEach(([lectura, releer]) => {
    const esc    = montar()
    const avisos = oirArrastre(esc)
    let dragend  = false
    esc.map.on('dragend', () => dragend = true)

    arrastre(esc.container)
    releer(esc)
    assert.deepEqual(avisos.map(a => a.value), [true], `${lectura}, con el arrastre en curso, lo sostiene`)
    segundoDedo(esc.container)
    assert.deepEqual({ moving: !!esc.map.dragging.moving(), dragend }, { moving: false, dragend: false },
      `${lectura}: Leaflet lo corta sin avisar`)
    releer(esc)
    assert.deepEqual(avisos.map(a => a.value), [true, false], `${lectura} lo cierra`)
    esc.map.remove()
  })
})

// Hasta que alguien lo pide, el anfitrión no le cuelga nada a un mapa adoptado; y al soltarlo le saca lo
// que le colgó, también del contenedor: un arrastre en curso con el `pointerup` del contenedor todavía
// oído se daría por empezado.
test('el arrastre se oye desde que alguien lo pide, y destruir el anfitrión lo suelta', () => {
  const esc = montar()
  assert.equal(esc.map.listens('dragstart'), false, 'sin nadie que lo pida, no se oye')
  const avisos = oirArrastre(esc)
  assert.equal(esc.map.listens('dragstart'), true)

  esc.host.destroy()
  assert.deepEqual(['dragstart', 'dragend'].filter(tipo => esc.map.listens(tipo)), [], 'nadie oye ya el arrastre del mapa')
  arrastre(esc.container)
  puntero(esc.container, 'pointerup')
  soltar(esc.container)
  assert.deepEqual(avisos, [], 'ni el del contenedor')
  esc.map.remove()
})

/* ── El préstamo ── */

test('lendDrag presta el arrastre y lo devuelve; uno que su dueño apagó sigue apagado', () => {
  const esc    = montar()
  const avisos = oirArrastre(esc)

  const devolver = esc.input.lendDrag()
  arrastre(esc.container)
  soltar(esc.container)
  assert.deepEqual({ enabled: esc.map.dragging.enabled(), avisos: avisos.length }, { enabled: false, avisos: 0 },
    'prestado, el mapa no se arrastra')
  devolver()
  arrastre(esc.container)
  soltar(esc.container)
  assert.deepEqual({ enabled: esc.map.dragging.enabled(), avisos: avisos.length }, { enabled: true, avisos: 2 },
    'devuelto, vuelve a arrastrarse')

  esc.map.dragging.disable()
  esc.input.lendDrag()()
  assert.equal(esc.map.dragging.enabled(), false, 'no se devuelve lo que no se prestó')
  esc.map.remove()
})

/* ── El píxel ── */

// La caja en pantalla mide la mitad que el contenedor: está escalada a 0,5 por CSS.
test('containerPoint da el píxel del contenedor, plano, descontados la escala CSS y el borde', () => {
  const esc   = montar({ caja: { left: 10, top: 20, width: 400, height: 300 }, borde: 3 })
  const punto = esc.input.containerPoint({ clientX: 110, clientY: 120 })
  assert.deepEqual(punto, { x: 197, y: 197 })
  assert.equal(Object.getPrototypeOf(punto), Object.prototype)
  esc.map.remove()
})

/* ── Los eventos del contenedor y lo que reconoce Leaflet ── */

// Un click del DOM en el centro del contenedor, sobre el pane de tiles, y el evento despachado.
const clickear = (esc, { target = esc.map.getPane('tilePane'), tipo = 'click' } = {}) => {
  const e = new window.MouseEvent(tipo, { bubbles: true, cancelable: true, clientX: 400, clientY: 300 })
  target.dispatchEvent(e)
  return e
}

test('onRecognized entrega el click del mapa con valores planos, y no el de un control ni el que cierra un arrastre', () => {
  const esc      = montar()
  const clicks   = []
  const dobles   = []
  const offClick = esc.input.onRecognized('click', click => clicks.push(click))
  esc.input.onRecognized('dblclick', doble => dobles.push(doble))

  const centro = { latlng: esc.host.camera.fromContainer({ x: 400, y: 300 }), point: { x: 400, y: 300 } }
  const click  = clickear(esc)
  const doble  = clickear(esc, { tipo: 'dblclick' })
  assert.deepEqual([clicks, dobles], [[{ ...centro, event: click }], [{ ...centro, event: doble }]])
  assert.deepEqual([clicks[0].latlng, clicks[0].point].map(Object.getPrototypeOf), [Object.prototype, Object.prototype])

  clickear(esc, { target: esc.map.zoomControl.getContainer().firstChild })
  arrastre(esc.container)
  soltar(esc.container)
  clickear(esc)
  assert.equal(clicks.length, 1, 'ni el del control ni el que sigue al arrastre')

  esc.map.fire('click', { latlng: L.latLng(1, 2) })
  esc.map.fire('click')
  assert.deepEqual(clicks.slice(1), [
    { latlng: { lat: 1, lng: 2 }, point: undefined, event: undefined },
    { latlng: undefined, point: undefined, event: undefined },
  ], 'uno disparado por código trae sólo lo que se le pasó')

  offClick()
  esc.map.fire('click', { latlng: L.latLng(1, 2) })
  assert.equal(clicks.length, 3, 'dado de baja, no oye más')
  esc.map.remove()
})

// El anfitrión oye en burbuja: quien oye en captura lo ve antes, y si corta ahí, el anfitrión no lo ve.
test('on y off son los del contenedor, y en captura se oye antes que el anfitrión', () => {
  const esc    = montar()
  const orden  = []
  const cortar = e => {
    orden.push('captura')
    e.stopPropagation()
  }
  esc.input.onRecognized('click', () => orden.push('anfitrión'))

  esc.input.on('click', cortar, { capture: true })
  clickear(esc)
  esc.input.off('click', cortar, { capture: true })
  clickear(esc)
  assert.deepEqual(orden, ['captura', 'anfitrión'], 'cortado en captura no llega; dado de baja, sí')
  esc.map.remove()
})

test('withinControl reconoce un control o un popup, y no la superficie del mapa', () => {
  const esc   = montar()
  const popup = L.popup().setLatLng([-33, -70]).setContent('<b>hola</b>').openOn(esc.map)
  const casos = [
    ['un botón del zoom', esc.map.zoomControl.getContainer().firstChild, true],
    ['la atribución', esc.map.attributionControl.getContainer(), true],
    ['el contenido de un popup', popup.getElement().querySelector('b'), true],
    ['un pane', esc.map.getPane('tilePane'), false],
    ['el contenedor', esc.container, false],
    ['nada', null, false],
  ]
  assert.deepEqual(casos.map(([caso, nodo]) => [caso, esc.input.withinControl(nodo)]), casos.map(([caso, , es]) => [caso, es]))
  esc.map.remove()
})
