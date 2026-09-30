// La puerta del puntero (`Interaction`): de quién es cada pulsación, el click que sintetiza y el doble
// click. Una pulsación quieta que no tomó nadie es el click del mapa: sale por el bus con los hits del
// canal click y, sin ninguno, como `onEmptyClick(latlng)`, que es la captura de coordenada del editor y de
// quien coloca un punto. La que tomó un participante es entera suya, en el orden declarado, salvo que el
// hit de una capa quede encima. Corre con:
//   node --test test/engine/puerta-del-puntero.test.mjs
//
// Importa el helper de stubs PRIMERO: instala el shim window/document que la carga del árbol de Cristae
// toca por top-level. El contenedor del doble del mapa reparte los eventos como el DOM.
import { makeLeaflet, makeMap } from '../../test-helpers/engine-stub.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { Camera } from '../../src/engine/Camera.js'
import { Interaction } from '../../src/engine/Interaction.js'
import { adoptLeafletHost } from '../../src/host/LeafletHost.js'

/* ── Harness ── */

// Registro mínimo: resolveHits devuelve una lista fija y anota el canal y la muestra con que se lo
// consultó. El click al vacío tiene que resolverse por el canal 'click': por otro, dispararía sobre
// features.
const makeRegistry = hits => {
  const channels = []
  const samples  = []
  return { channels, samples, resolveHits: (channel, sample) => { channels.push(channel); samples.push(sample); return hits } }
}

// Bus mínimo: anota cada dispatch.
const makeBus = () => {
  const dispatched = []
  return { dispatched, dispatch: (kind, hits, base) => dispatched.push({ kind, hits, base }) }
}

// Un participante que reconoce un handle donde `handleAt` lo dice y anota lo que la puerta le entrega. Su
// doble click consume cuando es el dueño del píxel.
const participante = (handleAt = () => false) => {
  const recibido = []
  const anotar   = tipo => (...args) => { recibido.push([tipo, ...args]) }
  return {
    recibido,
    handleAt,
    down     : anotar('down'),
    move     : anotar('move'),
    up       : anotar('up'),
    leave    : anotar('leave'),
    click    : muestra => { recibido.push(['click', muestra.x, muestra.y]) },
    dblclick : (muestra, propio) => { recibido.push(['dblclick', propio]); return propio },
  }
}

const mount = ({ hits = [], onEmptyClick = true } = {}) => {
  const map       = makeMap()
  const container = map.getContainer()
  const bus       = makeBus()
  const registry  = makeRegistry(hits)
  const calls     = []
  const host      = adoptLeafletHost(map, { leaflet: makeLeaflet() })
  const puerta    = new Interaction({
    host, camera: new Camera({ host }), registry, bus, pickLayers: () => [],
    onEmptyClick: onEmptyClick ? latlng => calls.push(latlng) : undefined,
  })
  return { map, container, bus, calls, registry, puerta }
}

const emitir   = (esc, tipo, x, y, campos) => esc.container.emitir(tipo, { clientX: x, clientY: y, ...campos })
const pulsar   = (esc, x, y, campos) => emitir(esc, 'pointerdown', x, y, campos)
const soltar   = (esc, x, y, campos) => emitir(esc, 'pointerup', x, y, campos)
const clickear = (esc, x, y) => [pulsar(esc, x, y), soltar(esc, x, y)]
const clicks   = esc => esc.bus.dispatched.filter(d => d.kind === 'click')

/* ── El click que sintetiza ── */

test('una pulsación quieta en el vacío es un click: onEmptyClick con su posición y el bus con su pointerup', () => {
  const esc        = mount()
  const [, suelta] = clickear(esc, 340, 120)

  assert.deepEqual(esc.calls, [{ lat: 1.2, lng: 3.4 }], 'onEmptyClick recibió la posición del píxel')
  assert.deepEqual(esc.registry.channels, ['click'], 'el vacío se resolvió por el canal click (no otro)')
  assert.deepEqual(clicks(esc).map(d => [d.hits, d.base]), [[[], suelta]], 'el bus lo despachó con su pointerup')
  assert.equal(suelta.consumido, false, 'y el pointerup sigue su camino')
})

test('sobre una feature el click va al bus con su hit y onEmptyClick no corre', () => {
  const hit = { layerId: 'flota', id: 7, zIndex: 400, order: 1 }
  const esc = mount({ hits: [hit] })

  clickear(esc, 100, 200)

  assert.deepEqual({ calls: esc.calls, hits: clicks(esc).map(d => d.hits) }, { calls: [], hits: [[hit]] })
})

test('onEmptyClick es opcional: sin el callback un click al vacío no rompe', () => {
  const esc = mount({ onEmptyClick: false })
  assert.doesNotThrow(() => clickear(esc, 0, 0))
  assert.equal(clicks(esc).length, 1, 'el click se despachó igual')
})

// La caja en pantalla mide el doble que el contenedor, corrida y con borde: el píxel descuenta las tres
// cosas, como la proyección de la cámara. La caja se relee en cada pulsación.
test('la muestra es el píxel del contenedor, descontados la escala CSS y el borde, y su posición', () => {
  const esc = mount()
  let caja  = { left: 10, top: 20, width: 1600, height: 1200 }
  Object.assign(esc.container, { clientLeft: 5, clientTop: 5, getBoundingClientRect: () => caja })

  clickear(esc, 10 + 2 * (5 + 100), 20 + 2 * (5 + 50))
  caja = { left: 0, top: 0, width: 800, height: 600 }
  clickear(esc, 5 + 300, 5 + 200)

  assert.deepEqual(esc.registry.samples, [{ lat: 0.5, lng: 1, x: 100, y: 50 }, { lat: 2, lng: 3, x: 300, y: 200 }])
})

// Cada caso es una pulsación que no llega a click. Después, una quieta sí: la puerta no quedó trabada.
test('no es un click la pulsación que se mueve, arrastra el mapa, usa otro botón, se cancela, suma un dedo o cae en un control', () => {
  const casos = {
    'se movió y volvió'                       : esc => { pulsar(esc, 0, 0); emitir(esc, 'pointermove', 3, 0); soltar(esc, 0, 0) },
    'se soltó lejos'                          : esc => { pulsar(esc, 0, 0); soltar(esc, 2, 1) },
    'arrastró el mapa'                        : esc => { pulsar(esc, 0, 0); esc.map.fire('dragstart'); soltar(esc, 0, 0) },
    'botón secundario'                        : esc => { pulsar(esc, 0, 0, { button: 2 }); soltar(esc, 0, 0, { button: 2 }) },
    'se canceló'                              : esc => { pulsar(esc, 0, 0); emitir(esc, 'pointercancel', 0, 0); soltar(esc, 0, 0) },
    'dos dedos'                               : esc => {
      pulsar(esc, 0, 0)
      pulsar(esc, 50, 0, { pointerId: 2 })
      soltar(esc, 0, 0)
      soltar(esc, 50, 0, { pointerId: 2 })
    },
    'sobre un control'                        : esc => {
      const destino = { parentNode: { parentNode: esc.container } }
      pulsar(esc, 0, 0, { target: destino })
      soltar(esc, 0, 0, { target: destino })
    },
    'soltada afuera, y otra sobre un control' : esc => {
      const destino = { parentNode: { parentNode: esc.container } }
      pulsar(esc, 0, 0)
      pulsar(esc, 0, 0, { target: destino })
      soltar(esc, 0, 0, { target: destino })
    },
  }
  Object.entries(casos).forEach(([caso, pulsacion]) => {
    const esc = mount()
    pulsacion(esc)
    const antes = clicks(esc).length
    emitir(esc, 'pointermove', 1, 1)
    clickear(esc, 2, 1)
    assert.deepEqual([antes, clicks(esc).length], [0, 1], caso)
  })
})

/* ── Los participantes ── */

// Con el handle del participante en zIndex 500 y order 2: la capa de abajo, sin hit o con uno por debajo,
// le deja la pulsación; con el hit encima —más z, o el mismo z y declarada antes— es del mapa, y es un
// click con ese hit.
test('el handle de un participante toma la pulsación salvo que el hit de una capa quede encima', () => {
  const casos = [
    ['sin hit', [], true],
    ['hit por debajo', [{ layerId: 'antes', zIndex: 400, order: 1 }], true],
    ['hit encima', [{ layerId: 'despues', zIndex: 600, order: 3 }], false],
    ['mismo z, declarada antes', [{ layerId: 'par', zIndex: 500, order: 1 }], false],
  ]
  casos.forEach(([caso, hits, delEditor]) => {
    const esc    = mount({ hits })
    const editor = participante(() => true)
    esc.puerta.join(editor, 500, 2)

    const [apretada, suelta] = clickear(esc, 100, 100)

    assert.deepEqual(
      {
        recibido : editor.recibido.map(([tipo]) => tipo),
        cortados : [apretada.cortado, suelta.cortado],
        clicks   : clicks(esc).map(d => d.hits),
      },
      delEditor
        ? { recibido: ['down', 'up'], cortados: [true, true], clicks: [] }
        : { recibido: ['click'], cortados: [false, false], clicks: [hits] },
      caso,
    )
  })
})

test('los participantes se consultan top-first: el de arriba que reconoce el píxel se la queda', () => {
  const esc    = mount()
  const abajo  = participante(() => true)
  const arriba = participante(x => x > 50)
  esc.puerta.join(abajo, 500, 1)
  esc.puerta.join(arriba, 600, 2)

  clickear(esc, 100, 0)
  clickear(esc, 10, 0)

  assert.deepEqual(
    { arriba: arriba.recibido.map(([tipo]) => tipo), abajo: abajo.recibido.map(([tipo]) => tipo) },
    { arriba: ['down', 'up'], abajo: ['down', 'up'] },
  )
})

// La del participante le toma el puntero: sólo sus muestras le llegan, a nadie más como hover, y un
// segundo dedo no la toca. Terminada, cada muestra es hover para todos, y salir del mapa también les llega.
test('la pulsación de un participante es suya entera: su puntero, capturado, y sin hover para los demás', () => {
  const esc        = mount()
  const capturados = []
  esc.container.setPointerCapture = id => capturados.push(id)
  const editor = participante(x => x === 10)
  const otro   = participante()
  esc.puerta.join(editor, 500, 1)
  esc.puerta.join(otro, 400, 0)

  pulsar(esc, 10, 0)
  emitir(esc, 'pointermove', 20, 0)
  pulsar(esc, 10, 0, { pointerId: 2 })
  emitir(esc, 'pointermove', 30, 0, { pointerId: 2 })
  soltar(esc, 30, 0, { pointerId: 2 })
  soltar(esc, 25, 0)
  emitir(esc, 'pointermove', 40, 0)
  emitir(esc, 'pointerleave', 40, 0)

  assert.deepEqual(
    { capturados, editor: editor.recibido, otro: otro.recibido },
    {
      capturados : [1],
      editor     : [['down', 10, 0], ['move', 20, 0], ['up', 25, 0], ['move', 40, 0], ['leave']],
      otro       : [['move', 40, 0], ['leave']],
    },
  )
})

// El dedo que baja con otro apoyado no es el primario, aunque el que se sumó antes ya se haya levantado:
// con el primero todavía en el mapa, un toque quieto no es un click y uno sobre un handle no lo toma.
test('un dedo que baja con otro apoyado no abre pulsación: ni click ni handle', () => {
  const esc    = mount()
  const editor = participante(x => x === 10)
  esc.puerta.join(editor, 500, 1)

  pulsar(esc, 100, 0)
  pulsar(esc, 150, 0, { pointerId: 2 })
  soltar(esc, 150, 0, { pointerId: 2 })
  pulsar(esc, 150, 0, { pointerId: 3 })
  soltar(esc, 150, 0, { pointerId: 3 })
  pulsar(esc, 10, 0, { pointerId: 4 })
  soltar(esc, 10, 0, { pointerId: 4 })
  soltar(esc, 100, 0)

  assert.deepEqual({ clicks: clicks(esc).length, editor: editor.recibido }, { clicks: 0, editor: [] })
})

// El editor que se va a mitad de su pulsación —un `onCommit` que lo destruye— no la vuelve un click.
test('join devuelve la baja: sacado a mitad de su pulsación, el pointerup no es un click', () => {
  const esc    = mount()
  const editor = participante(() => true)
  const salir  = esc.puerta.join(editor, 500, 1)

  pulsar(esc, 0, 0)
  salir()
  const suelta = soltar(esc, 0, 0)
  clickear(esc, 0, 0)

  assert.deepEqual(
    { recibido: editor.recibido.map(([tipo]) => tipo), suelta: suelta.consumido, clicks: clicks(esc).length },
    { recibido: ['down'], suelta: false, clicks: 1 },
  )
})

// El dueño del píxel lo recibe como propio; los demás, como del mapa. Consumido, se le corta al zoom del
// anfitrión; con el hit de una capa encima nadie es dueño, y sobre un control no llega a nadie.
test('el doble click es del dueño del píxel, y el que se consume no hace zoom', () => {
  const casos = [
    ['sobre el handle', [], [['dblclick', true]], true],
    ['con un hit encima', [{ layerId: 'despues', zIndex: 600, order: 3 }], [['dblclick', false]], false],
    ['sobre un control', [], [], false],
  ]
  casos.forEach(([caso, hits, recibido, cortado]) => {
    const esc    = mount({ hits })
    const editor = participante(() => true)
    const otro   = participante()
    esc.puerta.join(editor, 500, 2)
    esc.puerta.join(otro, 400, 1)
    const destino = caso === 'sobre un control' ? { parentNode: esc.container } : esc.container

    const doble = emitir(esc, 'dblclick', 0, 0, { target: destino })

    assert.deepEqual(
      { editor: editor.recibido, otro: otro.recibido, cortado: doble.cortado },
      { editor: recibido, otro: recibido.length ? [['dblclick', false]] : [], cortado },
      caso,
    )
  })
})
