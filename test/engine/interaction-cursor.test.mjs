// El cursor del contenedor tiene UN escritor: `Interaction`, que arbitra entre el arrastre del mapa, el
// handle de un editor, el cursor del consumidor y el `pointer` de una feature interactiva, en ese orden.
// Se caracteriza la tabla fila por fila y sus transiciones, que un flyTo no pisa el cursor del
// consumidor, que un arrastre cortado sin `dragend` no deja el suyo, que la escritura sólo ocurre al
// cambiar el valor, que el picking que sólo decidía el `pointer` se apaga bajo un cursor del consumidor,
// que quitarlo lo resuelve con el puntero quieto y que reponer el vigente no pide nada.
// Cierra con el cableado del motor: un editor montado con `addEditableLayer` informa su handle al
// árbitro. El harness no tiene `CSS` global, como un DOM emulado: el árbitro acepta cualquier cursor salvo
// en el test que dobla el parser. Corre con:
//   node --test test/engine/interaction-cursor.test.mjs
//
// Importa el helper de stubs PRIMERO: instala el shim window/document que la carga del árbol toca por
// top-level.
import { conGlDeEdicion, makeContainer, makeDragging, makeEditGl, makeGlify, makeLeaflet, makeMap, makePickSpy } from '../../test-helpers/engine-stub.mjs'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { Camera } from '../../src/engine/Camera.js'
import { Interaction } from '../../src/engine/Interaction.js'
import { MapEngine } from '../../src/engine/MapEngine.js'
import { EVENT_CLICK, EVENT_HOVER, HANDLE_HELD, HANDLE_NONE, HANDLE_OVER } from '../../src/events/events.js'

/* ── Harness ── */

// El contenedor del doble del mapa, que reparte los eventos como el DOM, con CADA escritura del cursor
// anotada: una repetida es un valor que no cambió y se escribió igual.
const contenedor = () => {
  const c        = makeContainer()
  const escritas = []
  Object.defineProperty(c.style, 'cursor', { get: () => escritas.at(-1) ?? '', set: v => { escritas.push(v) } })
  return Object.assign(c, { escritas })
}

// Registro con una demanda por capa y una sola pregunta que importa acá: ¿hay una feature bajo el
// puntero? Cuenta cuántas veces se la hicieron.
const registro = demandas => {
  const r = {
    bajo              : false,
    consultas         : 0,
    layerIds          : () => Object.keys(demandas),
    demandMaskOf      : id => demandas[id] ?? 0,
    isLayerVisible    : () => true,
    resolveHits       : () => [],
    hasHitForChannels : () => {
      r.consultas++
      return r.bajo
    },
  }
  return r
}

// Una capa del pase de picking por id de capa; `pedidos` cuenta las sesiones que la pickearon. No encola
// nada, así que la sesión se resuelve en línea.
const capaDePick = layerId => {
  const layer = {
    pedidos         : 0,
    requestHoverHit : () => { layer.pedidos++; return false },
    cancelHoverHit() {},
    syncPickingSize() {},
  }
  return { layerId, layer }
}

// El puntero arranca adentro del contenedor: entrando, como en toda muestra real, o con `yaEncima`, sobre
// el mapa desde antes de que el motor montara —una carga, un remontaje—, que no despacha `pointerenter`.
const montar = ({ demandas = { capa: EVENT_CLICK }, cursor, yaEncima = false } = {}) => {
  const map       = { ...makeMap(), dragging: makeDragging() }
  const container = contenedor()
  const registry  = registro(demandas)
  const capas     = Object.keys(demandas).map(capaDePick)
  const bus       = { eventos: [], dispatch: tipo => bus.eventos.push(tipo) }
  const it        = new Interaction({ map, camera: new Camera({ map }), registry, bus, container, cursor, pickLayers: () => capas })
  it.syncHoverDemand()
  yaEncima || container.emitir('pointerenter')
  return { it, map, container, registry, capas, bus }
}

// Una muestra del puntero, con o sin feature debajo.
const mover = (esc, bajo) => {
  esc.registry.bajo = bajo
  esc.container.emitir('pointermove')
  return esc.container.style.cursor
}

/* ── La tabla ── */

test('la precedencia, fila por fila, de ida y de vuelta, con una escritura por cambio', () => {
  const esc = montar({ demandas: { capa: EVENT_CLICK | EVENT_HOVER } })
  const { it, map, container } = esc
  const pasos = [
    ['sin nada deja el grab de Leaflet', () => {}, ''],
    ['feature interactiva', () => mover(esc, true), 'pointer'],
    ['el consumidor tapa al pointer', () => (it.cursor = 'crosshair'), 'crosshair'],
    ['handle bajo el puntero tapa al consumidor', () => it.setHandleLevel('ed', HANDLE_OVER), 'grab'],
    ['handle tomado', () => it.setHandleLevel('ed', HANDLE_HELD), 'grabbing'],
    ['el gesto se suelta sobre el handle', () => it.setHandleLevel('ed', HANDLE_OVER), 'grab'],
    ['el arrastre del mapa tapa al handle', () => map.fire('dragstart'), 'grabbing'],
    ['fin del arrastre', () => map.fire('dragend'), 'grab'],
    ['sin handle vuelve el consumidor', () => it.setHandleLevel('ed', HANDLE_NONE), 'crosshair'],
    ['sin consumidor vuelve el pointer', () => (it.cursor = null), 'pointer'],
    ['fuera de la feature', () => mover(esc, false), ''],
  ]
  pasos.forEach(([paso, accion, esperado]) => {
    accion()
    assert.equal(container.style.cursor, esperado, paso)
  })
  assert.deepEqual(container.escritas,
    ['pointer', 'crosshair', 'grab', 'grabbing', 'grab', 'grabbing', 'grab', 'crosshair', 'pointer', ''],
    'cada cambio es UNA escritura, y un valor que no cambió no se reescribe')
})

test('con varios editores manda el handle más fuerte', () => {
  const { it, container } = montar()
  it.setHandleLevel('a', HANDLE_OVER)
  it.setHandleLevel('b', HANDLE_HELD)
  assert.equal(container.style.cursor, 'grabbing', 'tomado en uno, bajo el puntero en otro')
  it.setHandleLevel('b', HANDLE_NONE)
  assert.equal(container.style.cursor, 'grab', 'se soltó el tomado: queda el otro')
  it.setHandleLevel('a', HANDLE_NONE)
  assert.equal(container.style.cursor, '')
})

// Cerrar la sesión de hover suelta el `pointer`: el puntero que sale del contenedor, y el pan o el zoom
// que empieza con él sobre una feature.
test('el pointer cae al salir del mapa y al empezar un pan o un zoom', () => {
  const cortes = [
    ['salir del contenedor', esc => esc.container.emitir('pointerleave')],
    ['un pan', esc => esc.map.fire('movestart')],
    ['un zoom', esc => esc.map.fire('zoomstart')],
  ]
  cortes.forEach(([corte, cortar]) => {
    const esc = montar()
    assert.equal(mover(esc, true), 'pointer')
    cortar(esc)
    assert.equal(esc.container.style.cursor, '', corte)
  })
})

/* ── El arrastre y la cámara ── */

// Leaflet dispara `movestart` también en un flyTo o un setView; el agarre es `dragstart`.
test('un flyTo programático no pisa el cursor del consumidor', () => {
  const { map, container } = montar({ cursor: 'crosshair' })
  ;['movestart', 'zoomstart', 'zoomend', 'moveend'].forEach(tipo => map.fire(tipo))
  assert.deepEqual(container.escritas, ['crosshair'], 'se escribió al construir y nada más')
})

test('el arrastre del usuario pone grabbing y al soltar vuelve lo que corresponda', () => {
  const libre = montar()
  libre.map.fire('movestart').fire('dragstart')
  assert.equal(libre.container.style.cursor, 'grabbing')
  libre.map.fire('dragend').fire('moveend')
  assert.equal(libre.container.style.cursor, '', 'sin nada, el grab de Leaflet')

  const conCursor = montar({ cursor: 'crosshair' })
  conCursor.map.fire('movestart').fire('dragstart')
  assert.equal(conCursor.container.style.cursor, 'grabbing', 'el agarre tapa al consumidor')
  conCursor.map.fire('dragend')
  assert.equal(conCursor.container.style.cursor, 'crosshair', 'y al soltar vuelve el suyo')
})

// Leaflet corta el arrastre sin `dragend` cuando entra un segundo dedo —el pinch— o un segundo botón: el
// árbitro relee su estado en lo que siempre sigue. Mientras Leaflet lo siga dando en curso, esas mismas
// lecturas lo sostienen: el `pointerup` del mouse llega antes que el `mouseup` que Leaflet escucha.
test('un arrastre que Leaflet corta sin dragend no deja el grabbing puesto', () => {
  const lecturas = [
    ['el zoom del pinch', esc => esc.map.fire('zoomstart').fire('zoomend').fire('moveend')],
    ['el pointerup del último botón', esc => esc.container.emitir('pointerup')],
    ['el pointerenter tras soltarlo afuera', esc => esc.container.emitir('pointerenter')],
  ]
  lecturas.forEach(([lectura, releer]) => {
    const esc = montar({ cursor: 'crosshair' })
    esc.map.fire('movestart').fire('dragstart')
    esc.map.dragging.moviendo = true
    releer(esc)
    assert.equal(esc.container.style.cursor, 'grabbing', `${lectura}, con el arrastre en curso, lo sostiene`)
    esc.map.dragging.moviendo = false
    releer(esc)
    assert.equal(esc.container.style.cursor, 'crosshair', `${lectura}, tras el corte, lo suelta`)
  })
})

/* ── El cursor del consumidor y el picking ── */

// Bajo el cursor del consumidor el `pointer` no se resuelve, así que quitarlo lo resuelve donde quedó el
// puntero, sin esperar a que se mueva. No depende de la historia: da igual si el picking se apagó con él o
// si la demanda de hover lo sostuvo con muestras que no consultaron el `pointer`.
test('quitar el cursor del consumidor resuelve el pointer con el puntero quieto', () => {
  const casos = [
    ['sólo click', { capa: EVENT_CLICK }, () => {}],
    ['con hover y muestras bajo el cursor', { capa: EVENT_CLICK | EVENT_HOVER }, esc => mover(esc, true)],
  ]
  casos.forEach(([caso, demandas, mientras]) => {
    const esc = montar({ demandas })
    assert.equal(mover(esc, true), 'pointer')
    esc.it.cursor = 'crosshair'
    mientras(esc)
    esc.it.cursor = ''
    assert.equal(esc.container.style.cursor, 'pointer', caso)
  })
})

test('sin pointerenter, la primera muestra del puntero ya lo pone adentro', () => {
  const esc = montar({ yaEncima: true })
  assert.equal(mover(esc, true), 'pointer')
  esc.it.cursor = 'crosshair'
  esc.it.cursor = ''
  assert.equal(esc.container.style.cursor, 'pointer', 'quitar el cursor resuelve el pointer donde quedó')
})

// Sin un `pointer` que destapar no hay pase: el cursor que se pone, y el que se quita con el puntero afuera,
// en pleno pan o sin demanda que lo muestre.
test('poner un cursor, o quitarlo sin nada que resolver, no pide ningún pase', () => {
  const casos = [
    ['poner otro', { capa: EVENT_CLICK | EVENT_HOVER }, esc => (esc.it.cursor = 'copy')],
    ['quitarlo afuera', { capa: EVENT_CLICK }, esc => { esc.container.emitir('pointerleave'); esc.it.cursor = '' }],
    ['quitarlo en un pan', { capa: EVENT_CLICK }, esc => { esc.map.fire('movestart'); esc.it.cursor = '' }],
    ['quitarlo sin demanda', { capa: 0 }, esc => (esc.it.cursor = '')],
  ]
  casos.forEach(([caso, demandas, accion]) => {
    const esc = montar({ demandas, cursor: 'crosshair' })
    accion(esc)
    assert.deepEqual({ pedidos: esc.capas[0].layer.pedidos, consultas: esc.registry.consultas },
      { pedidos: 0, consultas: 0 }, caso)
  })
})

// El motor reacciona al valor: un consumidor imperativo que repone el vigente por evento no relanza el
// pase del `pointer`, que se saltaría el `hover-throttle`. Cuenta el valor normalizado, no el crudo.
test('reponer el cursor vigente no pide ningún pase', () => {
  const esc = montar()
  mover(esc, true)
  ;[null, '', undefined, null].forEach(ninguno => (esc.it.cursor = ninguno))
  assert.deepEqual({ pedidos: esc.capas[0].layer.pedidos, consultas: esc.registry.consultas },
    { pedidos: 1, consultas: 1 }, 'sólo el pase de la muestra')
})

// Con una sesión abierta —su pase todavía no volvió del GPU— no se pide otro encima: la sesión relee el
// puntero al cerrar, con los canales de ahora. Así se pickea la capa solo-click que la sesión no incluía.
test('quitarlo con una sesión abierta la relee al cerrar', async () => {
  const esc = montar({ demandas: { hover: EVENT_HOVER, click: EVENT_CLICK }, cursor: 'crosshair' })
  const [hover, click] = esc.capas
  let vuelto = false
  hover.layer.requestHoverHit = () => { hover.layer.pedidos++; vuelto = false; return true }
  hover.layer.collectHoverHit = () => (vuelto ? {} : null)

  mover(esc, true)
  esc.it.cursor = ''
  assert.deepEqual({ hover: hover.layer.pedidos, click: click.layer.pedidos }, { hover: 1, click: 0 },
    'ningún pase encima de la sesión abierta')
  vuelto = true
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual({ hover: hover.layer.pedidos, click: click.layer.pedidos, cursor: esc.container.style.cursor },
    { hover: 2, click: 1, cursor: 'pointer' }, 'al cerrar relee con los dos canales')
  esc.it.destroy()
})

test('con cursor del consumidor y sólo demanda de click no corre el picking', () => {
  const esc = montar({ cursor: 'crosshair' })
  const [{ layer }] = esc.capas
  mover(esc, true)
  mover(esc, true)
  assert.deepEqual({ pedidos: layer.pedidos, consultas: esc.registry.consultas }, { pedidos: 0, consultas: 0 },
    'ni pase de picking ni resolución del pointer: su único motivo era un cursor que no se ve')

  esc.it.cursor = null
  assert.deepEqual({ pedidos: layer.pedidos, cursor: esc.container.style.cursor }, { pedidos: 1, cursor: 'pointer' },
    'quitarlo lo vuelve a correr')
})

test('con demanda de hover el picking sigue y los eventos salen, pero sólo por las capas que los piden', () => {
  const esc = montar({ demandas: { hover: EVENT_HOVER, click: EVENT_CLICK }, cursor: 'crosshair' })
  const [hover, click] = esc.capas
  mover(esc, true)
  assert.deepEqual(
    { hover: hover.layer.pedidos, click: click.layer.pedidos, consultas: esc.registry.consultas },
    { hover: 1, click: 0, consultas: 0 },
    'la capa de hover se pickea; la solo-click y el pointer no',
  )
  assert.ok(esc.bus.eventos.includes('hover'), 'el evento de hover se emite igual')
  assert.equal(esc.container.style.cursor, 'crosshair')
})

// El estilo ignora un valor que no parsea y conserva el anterior: el árbitro no puede darlo por escrito.
// Un `url()` sin keyword de respaldo es el caso típico.
test('un cursor que el CSS rechaza cuenta como ninguno', t => {
  globalThis.CSS = { supports: (_, valor) => !valor.startsWith('url(') }
  t.after(() => { delete globalThis.CSS })

  const esc = montar({ cursor: 'url(herramienta.cur)' })
  assert.deepEqual(esc.container.escritas, [], 'al montar no escribe nada')
  assert.equal(mover(esc, true), 'pointer', 'y el automático sigue en pie')
  esc.it.cursor = 'crosshair'
  esc.it.cursor = 'url(herramienta.cur)'
  assert.equal(esc.container.style.cursor, 'pointer',
    'reemplazar uno válido por uno rechazado lo suelta: vuelve el automático')
})

test('sin CSS global no hay con qué validar, y el cursor se acepta', () => {
  assert.equal(globalThis.CSS, undefined)
  assert.deepEqual(montar({ cursor: 'url(herramienta.cur)' }).container.escritas, ['url(herramienta.cur)'])
})

/* ── Ciclo de vida ── */

test('el árbitro escribe el cursor inicial sólo si hay uno', () => {
  assert.deepEqual(montar().container.escritas, [], 'sin cursor no toca el contenedor')
  assert.deepEqual(montar({ cursor: 'copy' }).container.escritas, ['copy'])
})

// Un motor nuevo sobre el mismo contenedor —el elemento que se reconecta— arranca sin escribir nada, así
// que lo que dejó el anterior quedaría pegado.
test('destroy devuelve el cursor y el aviso tardío de un editor no lo repinta', () => {
  const { it, container } = montar({ cursor: 'crosshair' })
  it.setHandleLevel('a', HANDLE_OVER)
  it.setHandleLevel('b', HANDLE_HELD)
  it.destroy()
  assert.equal(container.style.cursor, '')
  const escritas = container.escritas.length
  it.setHandleLevel('b', HANDLE_NONE)
  assert.equal(container.escritas.length, escritas, 'el editor que se destruye después no escribe')
})

/* ── El cableado del motor con el editor ── */

let glVigente = null
after(conGlDeEdicion(() => glVigente))

// Un editor de verdad sobre un motor de verdad: el pase de picking lo compone el doble del harness con la
// entrada que se declara bajo el puntero (ver `componer` en engine-stub).
test('el editor que monta el motor informa su handle al árbitro, y al irse lo suelta', () => {
  const spy = makePickSpy()
  glVigente = makeEditGl(spy)
  const container = contenedor()
  const map       = { ...makeMap(), getContainer: () => container, dragging: makeDragging() }
  const engine    = new MapEngine({ leaflet: makeLeaflet(), glify: makeGlify(), map, cursor: 'crosshair' })
  engine.addEditableLayer({ id: 'geo', kind: 'polygon', value: [[0, 0], [0, 10], [10, 10], [10, 0]] })
  const path = engine.getLayer('geo').editor.paths[0]
  const v1   = path.nextVertex(path.firstVertex)          // [0, 10] → píxel (1000, 0)
  spy.bajoElCursor = { obj: 1, entrada: v1, local: path.localOf(v1) }

  container.emitir('pointerdown', { clientX: 1000 })
  assert.equal(container.style.cursor, 'grabbing', 'el gesto tomó el vértice')
  container.emitir('pointerup', { clientX: 1000 })
  assert.equal(container.style.cursor, 'grab', 'soltado, el vértice sigue bajo el puntero')
  engine.removeLayer('geo')
  assert.equal(container.style.cursor, 'crosshair', 'sin editor vuelve el del consumidor')

  engine.destroy()
})
