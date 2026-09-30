// PROBES adversariales sobre el remake GPU de EditableGeometry. No son la caracterización: son
// sondas para ver si el contrato observable del editor viejo (marcadores Leaflet) sobrevivió.
//
// El pase de picking se ejerce por su DOBLE DERIVADO (`spy.bajoElCursor`, ver el harness): el test declara
// qué entrada hay bajo el puntero y el parche sale de los draws que la capa emitió de verdad. Un doble que
// contestara lo que el test pintó da verde con un handle que la capa dejó fuera de sus rangos —o sea,
// inagarrable—, que es exactamente lo que estas sondas buscan.

import './../../test-helpers/engine-stub.mjs'
import { conGlDeEdicion, contadorNodos, makeDragging, makeEditGl, makeMap, makePickSpy } from '../../test-helpers/engine-stub.mjs'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { EditableGeometry } from '../../src/render/EditableGeometry.js'
import { adoptLeafletHost } from '../../src/host/LeafletHost.js'

const P = 100

let glVigente = null

after(conGlDeEdicion(() => glVigente))

const contenedor = () => {
  const oyentes = new Map()
  return {
    oyentes,
    style                 : {},
    addEventListener      : (tipo, fn) => oyentes.set(tipo, fn),
    removeEventListener   : tipo => oyentes.delete(tipo),
    setPointerCapture     : () => {},
    getBoundingClientRect : () => ({ left: 0, top: 0, width: 800, height: 600 }),
  }
}

// `panePrevio`: el pane de edición ya existe en el mapa antes de montar el editor — el caso en que el
// pane es del consumidor y el editor sólo lo usa prestado. `sobre`: un editor ya montado cuyo MAPA se
// comparte (dos editores sobre el mismo mapa comparten también su anfitrión, su contenedor y su arrastre).
const montar = ({ kind = 'polygon', value = null, mode = 'edit', panePrevio = false, sobre = null } = {}) => {
  const spy = makePickSpy()
  glVigente = makeEditGl(spy)
  const container = sobre?.container ?? contenedor()
  const dragging  = sobre?.dragging  ?? makeDragging()
  const map       = sobre?.map       ?? { ...makeMap(), getContainer: () => container, dragging }
  panePrevio && map.createPane('edit')
  const host      = sobre?.host      ?? adoptLeafletHost(map)
  const changes   = [], commits = []
  const ed = new EditableGeometry({
    host, pane: 'edit', kind, value, mode,
    onChange: leer => changes.push(leer()), onCommit: leer => commits.push(leer()),
  })
  return { ed, map, host, container, dragging, spy, changes, commits, pixel: 0 }
}

const emitir = (esc, tipo, x, y) => esc.container.oyentes.get(tipo)?.({
  clientX: x, clientY: y, button: 0, pointerId: 1, preventDefault() {}, stopPropagation() {},
})

// Qué HAY bajo el puntero, no qué contesta el pase: se declara la entrada del arena y el doble sólo la
// devuelve si algún draw del trazo la cubrió (ver `componer` en el harness). point y rectangle no exponen
// su trazo —el suyo se DERIVA del valor— y viven en un chunk único, así que su local es el ref.
const apuntar = (esc, ref, anillo = 0) => {
  const path = esc.ed.paths[anillo] ?? null
  esc.spy.bajoElCursor = { obj: anillo + 1, entrada: ref, local: path ? path.localOf(ref) : ref }
  return esc
}

const vaciar = esc => (esc.spy.bajoElCursor = null, esc)

const posar = (esc, x, y) => {
  emitir(esc, 'pointermove', x, y)
  emitir(esc, 'pointermove', x, y)
  return esc
}

const mover = (esc, lat, lng) => emitir(esc, 'pointermove', lng * P, lat * P)

const refsDe = path => {
  const out = []
  path.forEachVertex((x, y, ref) => out.push(ref))
  return out
}

const SQUARE = [[0, 0], [0, 10], [10, 10], [10, 0]]
const OUTER  = [[0, 0], [0, 10], [10, 10], [10, 0]]
const INNER  = [[2, 2], [2, 4], [4, 4], [4, 2]]

/* ── P1: la caché por píxel no se invalida cuando cambia lo que hay bajo el píxel ── */

test('P1a — setValue suelta un trazo y el pointerdown en el MISMO píxel lo sigue direccionando', () => {
  const esc = montar({ kind: 'polygon', value: [OUTER, INNER] })

  posar(apuntar(esc, refsDe(esc.ed.paths[1])[0], 1), 40, 40)   // hover resuelto sobre el anillo 1
  esc.ed.setValue(SQUARE)                                      // ahora hay UN solo anillo: el 1 se soltó

  vaciar(esc)                                                  // bajo ese píxel ya no hay nada
  assert.doesNotThrow(() => emitir(esc, 'pointerdown', 40, 40),
    'el pointerdown en el píxel cacheado no puede reventar contra un trazo que ya no existe')

  esc.ed.destroy()
})

test('P1b — tras un cambio de vista el pointerdown quieto agarra el ref viejo', () => {
  const esc  = montar({ kind: 'polygon', value: SQUARE })
  const refs = refsDe(esc.ed.paths[0])

  // Una pulsación previa deja la caché fijada Y el buzón del pick asíncrono VACÍO (lo drenó ella misma):
  // de ahí en adelante nada vuelve a preguntarle al GPU hasta que el puntero se mueva.
  apuntar(esc, refs[1])
  emitir(esc, 'pointerdown', 40, 40)
  emitir(esc, 'pointerup',   40, 40)
  assert.equal(esc.changes.length, 0, 'la pulsación sin arrastre no editó nada')

  esc.map.fire('zoomend')                                      // el mapa se movió bajo el puntero QUIETO
  vaciar(esc)                                                  // el pase diría: NO hay handle en ese píxel

  emitir(esc, 'pointerdown', 40, 40)
  mover(esc, 5, 20)

  assert.equal(esc.changes.length, 0,
    'sin handle bajo el cursor no puede empezar un arrastre (con L.marker era imposible)')

  esc.ed.destroy()
})

test('P1c — pulsar dos veces el mismo píxel de un midpoint inserta DOS vértices', () => {
  const esc  = montar({ kind: 'polygon', value: SQUARE })
  const path = esc.ed.paths[0]
  const v0   = refsDe(path)[0]

  apuntar(esc, path.midOf(v0))
  emitir(esc, 'pointerdown', 40, 40)                           // inserta [0,5] — el cursor queda encima
  emitir(esc, 'pointerup',   40, 40)
  emitir(esc, 'pointerdown', 40, 40)                           // MISMO píxel, sin mover: ahora hay un VÉRTICE ahí

  assert.deepEqual(esc.ed.getValue(), [[0, 0], [0, 5], [0, 10], [10, 10], [10, 0]],
    'la segunda pulsación cae sobre el vértice recién creado, no sobre un midpoint fantasma')

  esc.ed.destroy()
})

test('P1d — tras setValue el mismo píxel se vuelve a preguntar, no se contesta de memoria', () => {
  const esc = montar({ kind: 'polyline', value: [[0, 0], [1, 1], [2, 2], [3, 3]] })

  // Como en P1b: la pulsación deja la caché fijada Y el buzón del pick asíncrono vacío.
  apuntar(esc, refsDe(esc.ed.paths[0])[1])
  emitir(esc, 'pointerdown', 40, 40)
  emitir(esc, 'pointerup',   40, 40)
  assert.equal(esc.changes.length, 0, 'la pulsación sin arrastre no editó nada')

  esc.ed.setValue([[5, 5], [6, 6], [7, 7], [8, 8]])            // MISMA forma, otro valor: los refs coinciden

  vaciar(esc)                                                  // bajo ese píxel ya no hay handle
  emitir(esc, 'pointerdown', 40, 40)
  mover(esc, 9, 9)

  assert.deepEqual(
    { valor: esc.ed.getValue(), changes: esc.changes.length },
    { valor: [[5, 5], [6, 6], [7, 7], [8, 8]], changes: 0 },
    'el ref cacheado sobre el valor viejo no puede arrastrar un vértice del nuevo',
  )

  esc.ed.destroy()
})

test('P1e — borrar un vértice invalida el píxel: su ranura la ocupa OTRO vértice', () => {
  const esc  = montar({ kind: 'polyline', value: [[0, 0], [1, 1], [2, 2], [3, 3], [4, 4], [5, 5]] })
  const path = esc.ed.paths[0]
  const r2   = refsDe(path)[2]

  apuntar(esc, r2)
  emitir(esc, 'dblclick', 40, 40)
  assert.deepEqual(esc.ed.getValue(), [[0, 0], [1, 1], [3, 3], [4, 4], [5, 5]], 'el dblclick borró [2,2]')
  assert.deepEqual([path.xAt(r2), path.yAt(r2)], [1, 1], 'y la ranura que dejó la ocupa otro vértice')

  vaciar(esc)                                                  // bajo ese píxel ya no hay handle
  emitir(esc, 'pointerdown', 40, 40)
  mover(esc, 9, 9)

  assert.equal(esc.changes.length, 1,
    'sólo emitió el borrado: el ref viejo no puede arrastrar el vértice que heredó su ranura')

  esc.ed.destroy()
})

/* ── P2: el préstamo del arrastre del mapa ── */

test('P2 — el gesto devuelve el arrastre que el CONSUMIDOR tenía apagado', () => {
  const esc = montar({ kind: 'polygon', value: SQUARE })
  esc.dragging.disable()                                       // el consumidor bloqueó el mapa

  apuntar(esc, refsDe(esc.ed.paths[0])[1])
  emitir(esc, 'pointerdown', 40, 40)
  mover(esc, 5, 20)
  emitir(esc, 'pointerup', 40, 40)

  assert.equal(esc.dragging.activo, false,
    'devolver de más es tan malo como no devolver: el editor sólo puede devolver lo que tomó')

  esc.ed.destroy()
})

/* ── P3: el corte a mitad de gesto deja el espejo GPU con la posición vieja ── */

test('P3 — setMode a mitad de drag: el valor se movió pero el dibujo se quedó', () => {
  const esc  = montar({ kind: 'polygon', value: SQUARE })
  const refs = refsDe(esc.ed.paths[0])

  // El handle de [0,10] vive en el píxel (1000,0), y ahí cae la pulsación: el agarre no lleva offset.
  apuntar(esc, refs[1])
  emitir(esc, 'pointerdown', 1000, 0)
  mover(esc, 5, 20)
  assert.deepEqual(esc.changes.at(-1)[1], [5, 20], 'onChange ya salió con el vértice movido')

  const subs = esc.spy.bufferSubDatas.length
  esc.ed.setMode('draw')

  assert.deepEqual(esc.ed.getValue()[1], [5, 20], 'y el valor quedó movido')
  assert.ok(esc.spy.bufferSubDatas.length > subs,
    'el espejo GPU tiene que quedar de acuerdo con el valor que el editor ya emitió')

  esc.ed.destroy()
})

/* ── P5: setValue a mitad de gesto no corta el gesto ── */

test('P5 — setValue a mitad de drag: el gesto sigue vivo y edita el valor RECIÉN empujado', () => {
  const esc  = montar({ kind: 'polyline', value: [[0, 0], [5, 5], [10, 10]] })
  const refs = refsDe(esc.ed.paths[0])

  apuntar(esc, refs[1])
  emitir(esc, 'pointerdown', 40, 40)                           // el usuario tiene el vértice 1 tomado
  esc.ed.setValue([[0, 0], [1, 1], [2, 2], [3, 3], [4, 4]])    // el mundo empuja otro valor

  mover(esc, 9, 9)                                             // y el dedo sigue apoyado

  assert.deepEqual(
    { valor: esc.ed.getValue(), changes: esc.changes.length },
    { valor: [[0, 0], [1, 1], [2, 2], [3, 3], [4, 4]], changes: 0 },
    'un setValue tiene que cortar el gesto: el ref viejo no puede seguir editando el valor nuevo',
  )

  esc.ed.destroy()
})

/* ── P6: destroy idempotente ── */

test('P6 — destroy dos veces no revienta', () => {
  const esc = montar({ kind: 'polygon', value: SQUARE })
  esc.ed.destroy()
  assert.doesNotThrow(() => esc.ed.destroy(), 'destroy es idempotente')
})

/* ── P7: el pane es del que lo estrena ── */

test('P7 — destroy devuelve el pane que el editor estrenó, y no toca uno ajeno', () => {
  const propio = montar({ kind: 'polygon', value: SQUARE })
  assert.ok(propio.map.getPane('edit'), 'el editor estrena el pane que no existía')
  propio.ed.destroy()
  assert.equal(propio.map.getPane('edit'), null, 'y lo devuelve: destroy no puede dejar un nodo vivo')

  const prestado = montar({ kind: 'polygon', value: SQUARE, panePrevio: true })
  prestado.ed.destroy()
  assert.ok(prestado.map.getPane('edit'), 'un pane del consumidor NO es del editor: no se lo lleva puesto')
})

// El pane se direcciona por NOMBRE: dos editores sobre el mismo mapa comparten el nodo, y con él el canvas
// WebGL2 de cada superficie. Si el primero en irse se lo lleva, el que queda dibuja contra un canvas
// desprendido —invisible y sin un solo error—.
test('P7b — dos editores comparten el pane: el primero en destruirse no se lo lleva al otro', () => {
  const a = montar({ kind: 'polygon', value: SQUARE })
  const b = montar({ kind: 'polyline', value: [[0, 0], [1, 1]], sobre: a })
  assert.ok(a.map.getPane('edit'), 'el pane lo estrenó el primero')

  a.ed.destroy()
  assert.ok(b.map.getPane('edit'), 'y el segundo sigue con el suyo: destruir uno no desmonta la sesión del otro')

  b.ed.destroy()
  assert.equal(b.map.getPane('edit'), null, 'el último que se va sí lo devuelve')
})

/* ── P8: el puntero se va del contenedor ── */

test('P8 — el puntero sale del mapa y el vecindario se devuelve entero', () => {
  const esc   = montar({ kind: 'polygon', value: SQUARE })
  const nodos = contadorNodos()

  posar(apuntar(esc, refsDe(esc.ed.paths[0])[1]), 40, 40)
  assert.equal(nodos.vivos, 3, 'con el cursor sobre un vértice hay vecindario')

  emitir(esc, 'pointerleave', 40, 40)
  assert.equal(nodos.vivos, 0,
    'afuera del contenedor no llega otro pointermove que lo despromueva: se suelta acá o no se suelta')

  esc.ed.destroy()
})

/* ── P4: el arrastre pierde el offset de agarre ── */

test('P4 — el vértice salta a centrarse bajo el cursor en el primer frame', () => {
  const esc  = montar({ kind: 'polyline', value: [[0, 0], [5, 5], [10, 10]] })
  const refs = refsDe(esc.ed.paths[0])

  // El usuario agarra el handle de [5,5] por el BORDE (el sprite mide 12 px, el radio de pick 3):
  // el píxel del cursor es (504,504), no (500,500).
  apuntar(esc, refs[1])
  emitir(esc, 'pointerdown', 504, 504)
  emitir(esc, 'pointermove', 504, 504)                         // el puntero NO se movió: el mismo píxel
  emitir(esc, 'pointerup',   504, 504)

  assert.deepEqual(
    { valor: esc.ed.getValue()[1], changes: esc.changes.length, commits: esc.commits.length },
    { valor: [5, 5], changes: 0, commits: 0 },
    'mover el puntero 0 px no puede reubicar el vértice ni asentar una edición: el agarre lleva su offset',
  )

  esc.ed.destroy()
})

test('P4b — el vértice recorre lo que recorre el puntero, no salta a centrarse bajo él', () => {
  const esc  = montar({ kind: 'polyline', value: [[0, 0], [5, 5], [10, 10]] })
  const refs = refsDe(esc.ed.paths[0])

  // Otra vez por el BORDE: el handle de [5,5] está en (500,500) y se agarra en (505,505). El puntero
  // recorre 10 px, así que el vértice tiene que recorrer 10 px —0,10 grados—, no ir a parar al cursor.
  apuntar(esc, refs[1])
  emitir(esc, 'pointerdown', 505, 505)
  emitir(esc, 'pointermove', 515, 515)

  assert.deepEqual(esc.ed.getValue()[1], [5.1, 5.1],
    'con el offset de agarre el vértice queda en [5.10,5.10]; centrándolo bajo el cursor daría [5.15,5.15]')

  esc.ed.destroy()
})

/* ── P9: el apagado del vecindario se realimenta con el pase que lo encuentra ── */

// El handle promovido sale del VISUAL —lo dibuja su nodo DOM— pero tiene que seguir en el PASE: es lo único
// que sabe direccionarlo (el nodo del banco es `pointer-events: none` y no pickea nada). Apagarlo también
// del pase cierra un lazo: se promueve → sale del pase → el pick contesta «nada» → se despromueve → vuelve
// al pase → lo encuentra. Se ve como un parpadeo del resaltado, un `pointermove` por vuelta.
test('P9 — el hover sostenido sobre el mismo píxel no estrobea el vecindario', () => {
  const esc   = montar({ kind: 'polygon', value: SQUARE })
  const nodos = contadorNodos()
  apuntar(esc, refsDe(esc.ed.paths[0])[1])                     // el handle de [0,10] vive en (1000,0)

  const vivos = Array.from({ length: 6 }, () => (emitir(esc, 'pointermove', 1000, 0), nodos.vivos))

  assert.deepEqual(vivos, [0, 3, 3, 3, 3, 3],
    'la primera muestra lo pide, la segunda lo cobra, y de ahí en más el vecindario se QUEDA')

  esc.ed.destroy()
})

test('P10 — con el vecindario a la vista, la pulsación agarra el handle y lo arrastra', () => {
  const esc  = montar({ kind: 'polygon', value: SQUARE })
  const refs = refsDe(esc.ed.paths[0])

  posar(apuntar(esc, refs[1]), 1000, 0)                        // el resaltado ya está en pantalla
  emitir(esc, 'pointerdown', 1000, 0)
  emitir(esc, 'pointermove', 1100, 0)
  emitir(esc, 'pointerup',   1100, 0)
  assert.deepEqual(esc.ed.getValue()[1], [0, 11], 'el vértice recorrió los 100 px del puntero')

  posar(apuntar(esc, refs[1]), 1100, 0)                        // el cursor quedó encima: se vuelve a resolver
  emitir(esc, 'pointerdown', 1100, 0)
  emitir(esc, 'pointermove', 1200, 0)
  emitir(esc, 'pointerup',   1200, 0)

  assert.deepEqual(
    { valor: esc.ed.getValue()[1], commits: esc.commits.length },
    { valor: [0, 12], commits: 2 },
    'y la pulsación siguiente sobre el mismo píxel lo vuelve a agarrar',
  )

  esc.ed.destroy()
})

test('P11 — con el vecindario a la vista, el doble click borra el vértice', () => {
  const esc = montar({ kind: 'polygon', value: SQUARE })

  posar(apuntar(esc, refsDe(esc.ed.paths[0])[1]), 1000, 0)
  emitir(esc, 'dblclick', 1000, 0)

  assert.deepEqual(esc.ed.getValue(), [[0, 0], [10, 10], [10, 0]],
    'el handle resaltado es el mismo que el pase tiene que reconocer')

  esc.ed.destroy()
})

/* ── P12: el atlas de los handles se instanciaba por editor ── */

test('P12 — montar y destruir editores no acumula los tiles del atlas', () => {
  montar({ kind: 'polygon', value: SQUARE }).ed.destroy()      // el primero rasteriza el atlas del proceso
  const nodos = contadorNodos()

  for (let i = 0; i < 20; i++) {
    const esc = montar({ kind: 'polygon', value: SQUARE })
    posar(apuntar(esc, refsDe(esc.ed.paths[0])[1]), 1000, 0)
    esc.ed.destroy()
  }

  assert.equal(nodos.vivos, 0,
    'un IconSet por editor deja sus cinco canvas de atlas por ciclo, y nadie los suelta')
})
