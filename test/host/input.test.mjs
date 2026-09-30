// La entrada del anfitrión sobre el Leaflet REAL, en jsdom: el arrastre del usuario de punta a punta,
// incluido el que Leaflet corta sin `dragend`; el préstamo del arrastre; los eventos crudos del contenedor
// frente a los que oye el anfitrión, con el zoom por doble click que se le saca, y qué es superficie del
// mapa. Es el test de contrato del privado que la entrada lee: si `dragging.moving()` deja de dar el
// arrastre en curso, el cursor del arrastre se rompe en silencio y es acá donde se ve. Corre con:
// node --test test/host/input.test.mjs
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

/* ── Los eventos del contenedor ── */

// Un doble click del DOM en el centro del contenedor, sobre el pane de tiles.
const doble = esc => esc.map.getPane('tilePane').dispatchEvent(
  new window.MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: 400, clientY: 300 }))

// El anfitrión oye en burbuja: quien oye en captura lo ve antes, y si corta ahí, el anfitrión no lo ve. Es
// el contrato con que la puerta del puntero le saca el zoom a un doble click que consumió.
test('on y off son los del contenedor; en captura se oye antes, y suppressDoubleClickZoom le saca el zoom', () => {
  const esc    = montar()
  const orden  = []
  const cortar = e => {
    orden.push('captura')
    esc.input.suppressDoubleClickZoom(e)
  }
  esc.map.on('dblclick', () => orden.push('anfitrión'))

  esc.input.on('dblclick', cortar, { capture: true })
  doble(esc)
  const cortado = esc.map.getZoom()
  esc.input.off('dblclick', cortar, { capture: true })
  doble(esc)

  assert.deepEqual(
    { orden, cortado, dadoDeBaja: esc.map.getZoom() },
    { orden: ['captura', 'anfitrión'], cortado: 10, dadoDeBaja: 11 },
    'cortado en captura no llega ni hace zoom; dado de baja, sí',
  )
  esc.map.remove()
})

test('onSurface reconoce la superficie del mapa, y no la UI que el anfitrión pone en el contenedor', () => {
  const esc   = montar()
  const casos = [
    ['el contenedor', esc.container, true],
    ['un pane', esc.map.getPane('tilePane'), true],
    ['un botón del zoom', esc.map.zoomControl.getContainer().firstChild, false],
    ['la atribución', esc.map.attributionControl.getContainer(), false],
  ]
  assert.deepEqual(casos.map(([caso, nodo]) => [caso, esc.input.onSurface(nodo)]), casos.map(([caso, , es]) => [caso, es]))
  esc.map.remove()
})
