// Caracterización de EditableGeometry (editor de geometría como <input> controlado). Cubre: (1) el drag
// de un vértice de polígono emite onChange con la geometría nueva (vértice movido); (2) el borrado por
// dblclick respeta el mínimo topológico (≥3 en polígono); (3) insertar en una arista agrega un vértice en
// el midpoint; (4) el modo draw agrega puntos al recibir un click de mapa y captura un punto vía el
// handler expuesto; (5) destroy limpia el gesto y los listeners; (6) el costo en el arena: insertar
// desplaza a lo sumo un chunk y el drag no renumera nada; (7) la pulsación sobre un handle es del gesto y
// no sale como click del mapa; en el vacío sí, y sobre un control no es de ninguno; (8) el nivel de handle
// que el editor informa al mapa para el cursor.
//
// El gesto ya no vive en un `L.marker` por vértice: lo posee la capa GL. El test lo ejerce como el
// navegador —pointerdown / pointermove / pointerup / pointercancel / dblclick sobre el contenedor del
// mapa—, que se los entrega al editor por la puerta del puntero (engine/Interaction), y DECLARA qué
// entrada hay bajo el puntero (`spy.bajoElCursor`): el parche que el pase
// decodifica lo compone el doble con los draws que la capa emitió de verdad, así que una entrada que quedó
// fuera de sus rangos —o que se apagó con el tile transparente— no se pickea. El resto del árbol
// (ChunkedPath, arena, capas, picking) es el REAL.
//
// El harness (engine-stub) shimea window/document — se importa PRIMERO.

import './../../test-helpers/engine-stub.mjs'
import { conGlDeEdicion, contadorNodos, contando, makeDragging, makeEditGl, makeMap, makePickSpy, makeSurface } from '../../test-helpers/engine-stub.mjs'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { HANDLE_HELD, HANDLE_NONE, HANDLE_OVER } from '../../src/events/events.js'
import { ROLE } from '../../src/geometry/ChunkedPath.js'
import { defineEditIconSet, editHandleChannels } from '../../src/render/EditHandleLayer.js'
import { EditableGeometry } from '../../src/render/EditableGeometry.js'
import { Camera } from '../../src/engine/Camera.js'
import { WGS84 } from '../../src/geometry/ellipsoid.js'
import { DESTINATION, HEADING, MEAN_RADIUS, MODEL, byDefault } from '../../src/geometry/geodesic.js'
import geographiclib from 'geographiclib-geodesic'
import { Interaction } from '../../src/engine/Interaction.js'
import { adoptLeafletHost } from '../../src/host/LeafletHost.js'
import { LayerRegistry } from '../../src/interaction/LayerRegistry.js'

/* ── Harness de la sesión de edición ── */

const P = 100                            // el harness proyecta lineal: un grado son 100 px de contenedor

const { Geodesic, LATITUDE, LONGITUDE, LONG_UNROLL } = geographiclib.Geodesic

const ESFERA    = new Geodesic(MEAN_RADIUS, 0)
const ELIPSOIDE = new Geodesic(6378137, 1 / 298.257223563)
const FORMAS    = ['circle', 'ellipse', 'sector']

// El canal del tile TRANSPARENTE, con el que el editor apaga un handle del visual y del pase a la vez. El
// doble lo necesita para descartar como el fragment; el tile de cada entrada lo lee del VBO.
const TILE_VACIO = editHandleChannels(defineEditIconSet()).tiles[ROLE.free]

// La superficie de edición pide un WebGL2 CON stencil sobre un canvas propio, y el `document` del harness
// devuelve un contexto no-op. La costura del harness le enchufa el doble de GL del repo —el mismo que
// ejercen las otras capas de edición—: el canvas lo sigue creando el shim, así que nada más cambia.
// `contextos` cuenta los que se piden.
let glVigente = null
let contextos = 0

after(conGlDeEdicion(() => {
  contextos++
  return glVigente
}))

// `alAsentar` corre dentro de `onCommit` y recibe el editor: es donde un consumidor lo corta —pasa a draw,
// lo destruye— antes de que llegue el resto de la pulsación.
// `cuentas` anota cuántas texturas y buffers se crean y se borran. `model` llega al editor como lo pasa el
// motor, y `geod` es la geographiclib del mismo modelo, que el harness usa para ubicar las manijas de forma.
const montar = ({ kind = 'polygon', value = null, mode = 'edit', dpr = 1, zoom, model, geod = ESFERA, style, pintado, cuentas, alAsentar, alCambiar } = {}) => {
  const spy = makePickSpy()
  spy.tileVacio = TILE_VACIO
  glVigente = makeEditGl(spy, makeSurface({ dpr }))
  if (cuentas) {
    const contar = (t, p) => (...args) => {
      cuentas[p] = (cuentas[p] ?? 0) + 1
      return t[p](...args)
    }
    glVigente = new Proxy(glVigente, { get: (t, p) => (/^(create|delete)(Texture|Buffer)$/.test(p) ? contar(t, p) : t[p]) })
  }
  // El doble devuelve `{}` por cada localización, así que las capas son indistinguibles por sus uniforms.
  // Etiquetarlas con el NOMBRE deja leer con qué color dibujó cada una.
  if (pintado) {
    const trampa = {
      __proto__          : null,
      getUniformLocation : (_program, nombre) => ({ nombre }),
      uniform4f          : (loc, ...rgba) => pintado.set(loc.nombre, rgba),
      uniform4fv         : (loc, rgba) => pintado.set(loc.nombre, [...rgba]),
    }
    glVigente = new Proxy(glVigente, { get: (t, p) => trampa[p] ?? t[p] })
  }
  // El gesto es NUESTRO mientras dura, así que apaga el arrastre del mapa; el doble deja ver que lo
  // devuelve por todos los caminos de salida (soltar, y también los cortes de afuera). El contenedor del
  // doble del mapa reparte los eventos como el DOM.
  const dragging  = makeDragging()
  const map       = { ...makeMap({ zoom }), dragging }
  const container = map.getContainer()
  const changes   = [], commits = [], informes = []
  // La puerta del puntero, sin capas: lo que sintetiza como click del mapa es lo que el motor emitiría como
  // `map:click` / `cristae:mapclick`.
  const alMapa    = []
  const host      = adoptLeafletHost(map)
  const puerta    = new Interaction({ host, camera: new Camera({ host }), registry: new LayerRegistry(), bus: { dispatch() {} }, onEmptyClick: latlng => alMapa.push(latlng) })
  const ed = new EditableGeometry({
    host, join: participante => puerta.join(participante, 0, 0), pane: 'edit', kind, value, mode, model, style,
    onChange: leer => {
      changes.push(leer())
      alCambiar?.(ed)
    },
    onCommit: leer => {
      commits.push(leer())
      alAsentar?.(ed)
    },
    onHandleLevel: nivel => informes.push(nivel),
  })
  return {
    ed, kind, geod, map, container, dragging, spy, changes, commits, informes, alMapa, punto: [0, 0], destino: container, puntero: 1,
    rumbo: 90,   // el de la manija de radio del círculo, que entra al este
  }
}

// El evento como lo despacha el navegador, y con el testigo de si la puerta se lo dio al editor, que se lo
// QUEDA: consumirlo es sacárselo al mapa, así que reconocer un handle donde no hay ninguno se nota acá
// aunque no edite nada. `cortado` es la mitad que decide si el evento sigue a la burbuja, donde escucha
// Leaflet. `target` es el nodo DOM bajo el puntero (`esc.destino`, por omisión el contenedor mismo) y
// `pointerId`, el puntero que lo despacha (`esc.puntero`).
const emitir = (esc, tipo, x, y) =>
  esc.container.emitir(tipo, { clientX: x, clientY: y, target: esc.destino, pointerId: esc.puntero })

// Qué HAY bajo el puntero, no qué contesta el pase: se declara la entrada del arena y el doble sólo la
// devuelve si algún draw del trazo la cubrió y su tile la deja escribir (ver `componer` en el harness).
// point y rectangle no exponen su trazo —el suyo se DERIVA del valor— y viven en un chunk único, así que
// su local es el ref.
const apuntar = (esc, ref, anillo = 0) => {
  const path = esc.ed.paths[anillo] ?? null
  esc.spy.bajoElCursor = { obj: anillo + 1, entrada: ref, local: path ? path.localOf(ref) : ref }
  return esc
}

// La manija `i` de una forma, desde su valor y con la geographiclib: el centro, y después cada una a su
// rumbo y su distancia del centro. La del círculo va al rumbo que el test le lleva en `esc.rumbo`.
const manijaDe = (esc, i) => {
  const { center: [lat, lng], radius, heading, sweep } = esc.ed.getValue()
  if (!i) return [lat, lng]
  const [a, b]   = typeof radius === 'number' ? [radius, radius] : radius
  const [azi, s] = esc.kind === 'circle' ? [esc.rumbo, a]
    : esc.kind === 'ellipse' ? [[heading, a], [heading + 90, b]][i - 1]
    : [[heading, a], [heading - sweep / 2, a], [heading + sweep / 2, a]][i - 1]
  const r = esc.geod.Direct(lat, lng, azi, s, LATITUDE | LONGITUDE | LONG_UNROLL)
  return [r.lat2, r.lon2]
}

// La coordenada del handle `ref`: sale del trazo cuando el kind lo expone. point, rectangle y las formas no
// —el suyo se DERIVA del valor—, así que se reconstruye: el punto es su única entrada, el rectángulo va
// [SW, NW, NE, SE] con el midpoint de cada arista intercalado, y una forma lleva su manija `i` en el ref 2i.
const coordDe = (esc, ref, anillo) => {
  const path = esc.ed.paths[anillo]
  if (path) return [path.xAt(ref), path.yAt(ref)]
  if (FORMAS.includes(esc.kind)) return manijaDe(esc, ref >> 1)
  if (esc.kind === 'point') return esc.ed.getValue()
  const [[s, w], [n, e]] = esc.ed.getValue()
  const esquinas = [[s, w], [n, w], [n, e], [s, e]]
  const a = esquinas[(ref >> 1) % 4]
  const b = esquinas[((ref >> 1) + 1) % 4]
  return ref % 2 ? [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] : a
}

// La pulsación cae SOBRE el handle, como el gesto real: el agarre conserva su offset, así que apretar al
// costado corre el vértice ese offset. El píxel queda anotado para el `pointerup`.
const pulsar = (esc, tipo, ref, anillo) => {
  apuntar(esc, ref, anillo)
  const [lat, lng] = coordDe(esc, ref, anillo)
  esc.punto = [lng * P, lat * P]
  return emitir(esc, tipo, esc.punto[0], esc.punto[1])
}

const tomar  = (esc, ref, anillo = 0) => pulsar(esc, 'pointerdown', ref, anillo)
const doble  = (esc, ref, anillo = 0) => pulsar(esc, 'dblclick', ref, anillo)
const mover  = (esc, lat, lng) => emitir(esc, 'pointermove', lng * P, lat * P)
const soltar = esc => emitir(esc, 'pointerup', esc.punto[0], esc.punto[1])

// Píxel sin handle: bajo el cursor no hay ninguna entrada que el pase pueda atribuir.
const vaciar = esc => (esc.spy.bajoElCursor = null, esc)

// Una pulsación quieta entera, hasta el `pointerup` que la cierra y que se devuelve: sobre el handle `ref`,
// o sobre un píxel sin handle, donde es el click del mapa.
const pulsarHandle = (esc, ref, anillo = 0) => {
  tomar(esc, ref, anillo)
  return soltar(esc)
}

const pulsarVacio = (esc, x, y) => {
  vaciar(esc)
  esc.punto = [x, y]
  emitir(esc, 'pointerdown', x, y)
  return soltar(esc)
}

// El click del mapa en una posición, y el doble click en el píxel de otra.
const clickMapa = (esc, lat, lng) => pulsarVacio(esc, lng * P, lat * P)
const dobleMapa = (esc, lat, lng) => emitir(vaciar(esc), 'dblclick', lng * P, lat * P)

// Un hover RESUELTO: el pase de hover no bloquea, así que la primera muestra lo pide y la segunda lo
// cobra. Recién ahí el vecindario está promovido.
const posar = (esc, x, y) => {
  emitir(esc, 'pointermove', x, y)
  emitir(esc, 'pointermove', x, y)
  return esc
}

// Un gesto completo sobre `ref`: tomar, arrastrar a cada destino y soltar.
const arrastrar = (esc, ref, destinos, anillo = 0) => {
  tomar(esc, ref, anillo)
  destinos.forEach(([lat, lng]) => mover(esc, lat, lng))
  soltar(esc)
  return esc
}

/* ── Datos ── */

// Un polígono cuadrado (anillo simple, sin cerrar): 4 vértices → 4 midpoints.
const SQUARE = [[0, 0], [0, 10], [10, 10], [10, 0]]

// El stride del VBO del arena: lo que ocupa una entrada (vértice o midpoint) en la subida a GPU.
const FLOATS_POR_ENTRADA = 7

// Los vértices de un trazo en orden, por su ref del arena. El ref ES la posición de la entrada, así que
// un ref que cambia es una entrada que se desplazó — es la unidad en la que se mide el costo de editar.
const refsDe = path => {
  const out = []
  path.forEachVertex((x, y, ref) => out.push(ref))
  return out
}

const midDe = (path, v) => [path.xAt(path.midOf(v)), path.yAt(path.midOf(v))]

const diagonal = n => Array.from({ length: n }, (_, i) => [i * 0.01, i * 0.02])

/* ── Tests ── */

test('drag de un vértice → onChange con la geometría nueva (vértice movido)', () => {
  const esc  = montar({ kind: 'polygon', value: SQUARE })
  const path = esc.ed.paths[0]
  const v1   = refsDe(path)[1]                          // vértice índice 1 = [0,10]
  assert.deepEqual([path.xAt(v1), path.yAt(v1)], [0, 10], 'el 2º vértice del anillo')

  tomar(esc, v1)
  mover(esc, 5, 20)

  assert.equal(esc.changes.length, 1, 'el drag emitió exactamente un onChange')
  const geom = esc.changes[0]
  assert.deepEqual(geom[1], [5, 20], 'el vértice movido aparece en la geometría emitida')
  assert.deepEqual(geom[0], [0, 0], 'los demás vértices quedan intactos')
  assert.equal(geom.length, 4, 'sigue siendo un polígono de 4 vértices')
  // Salida desacoplada del estado interno (copia, no alias del array vivo).
  geom[0][0] = 999
  assert.deepEqual(esc.ed.getValue()[0], [0, 0], 'la geometría emitida es una copia, no el array interno')

  esc.ed.destroy()
})

test('dblclick borra el vértice pero respeta el mínimo (≥3 en polígono)', () => {
  const esc  = montar({ kind: 'polygon', value: SQUARE })
  const path = esc.ed.paths[0]

  doble(esc, refsDe(path)[0])                           // 4 → 3 vértices: permitido
  assert.equal(esc.changes.length, 1, 'borró un vértice')
  assert.equal(esc.changes[0].length, 3, 'quedan 3 vértices')

  doble(esc, refsDe(path)[0])                           // borrar uno más caería a 2 → se ignora
  assert.equal(esc.changes.length, 1, 'no baja del mínimo topológico (sigue en 1 emisión)')
  assert.deepEqual(esc.ed.getValue().length, 3, 'la geometría sigue con 3 vértices')

  esc.ed.destroy()
})

test('pulsar un midpoint inserta un vértice en la arista', () => {
  const esc  = montar({ kind: 'polygon', value: SQUARE })
  const path = esc.ed.paths[0]
  const v0   = refsDe(path)[0]
  assert.deepEqual(midDe(path, v0), [0, 5], 'midpoint del segmento 0, que une [0,0] con [0,10]')

  tomar(esc, path.midOf(v0))

  const geom = esc.changes.at(-1)
  assert.equal(geom.length, 5, 'ahora hay 5 vértices')
  assert.deepEqual(geom[1], [0, 5], 'el vértice insertado está en el midpoint de la arista')

  esc.ed.destroy()
})

// Sin esto el midpoint cuesta dos gestos: uno que inserta y otro que agarra el vértice recién nacido.
test('el midpoint se agarra directo: la pulsación lo vuelve vértice y el MISMO gesto lo arrastra', () => {
  const esc  = montar({ kind: 'polygon', value: SQUARE })
  const path = esc.ed.paths[0]

  tomar(esc, path.midOf(refsDe(path)[0]))
  mover(esc, 7, 3)
  soltar(esc)

  const geom = esc.ed.getValue()
  assert.equal(geom.length, 5, 'insertó UN vértice, no uno por muestra del arrastre')
  assert.deepEqual(geom[1], [7, 3], 'y el arrastre siguió sobre él sin soltar: no quedó en el midpoint')
  assert.equal(esc.commits.length, 2, 'la inserción asienta, y el arrastre asienta al soltar')

  esc.ed.destroy()
})

test('modo draw: click de mapa agrega puntos y el handler expuesto captura un punto', () => {
  const esc = montar({ kind: 'polyline', value: [], mode: 'draw' })

  // El modo draw recibe el click que sintetiza la puerta del puntero: una pulsación quieta en el vacío.
  clickMapa(esc, 1, 2)
  clickMapa(esc, 3, 4)
  assert.deepEqual(esc.changes.at(-1), [[1, 2], [3, 4]], 'cada click agrega un vértice al trazo')

  // Sub-pieza expuesta: el caller puede rutear su propia captura de punto sin pasar por el anfitrión.
  esc.ed.handleMapClick({ lat: 5, lng: 6 })
  assert.deepEqual(esc.changes.at(-1), [[1, 2], [3, 4], [5, 6]], 'handleMapClick agrega igual que el click nativo')

  esc.ed.destroy()
})

test('modo draw: cada click ASIENTA (onCommit), no sólo emite live', () => {
  const esc = montar({ kind: 'polyline', value: [], mode: 'draw' })
  clickMapa(esc, 1, 2)
  clickMapa(esc, 3, 4)
  assert.equal(esc.commits.length, 2, 'un host que sólo escucha onCommit tiene que ver los puntos')
  assert.deepEqual(esc.commits.at(-1), [[1, 2], [3, 4]])
  esc.ed.destroy()
})

test('destroy saca al editor de la puerta: ni el click del mapa ni la pulsación sobre un handle le llegan', () => {
  const esc = montar({ kind: 'point', value: null, mode: 'draw' })

  clickMapa(esc, 7, 8)
  assert.deepEqual(esc.changes.at(-1), [7, 8], 'point en draw: el click fija el punto')

  esc.ed.destroy()
  clickMapa(esc, 9, 9)
  assert.equal(esc.changes.length, 1, 'tras destroy el click del mapa ya no dispara onChange')

  const edit = montar({ kind: 'polygon', value: SQUARE })
  const v0   = refsDe(edit.ed.paths[0])[0]
  edit.ed.destroy()
  const e = tomar(edit, v0)
  assert.deepEqual({ consumido: e.consumido, arrastre: edit.dragging.activo }, { consumido: false, arrastre: true })
})

/* ── setValue: input controlado, NO emite (contrato central) ── */

test('setValue NO emite onChange (el mundo empuja estado, no es una edición)', () => {
  const esc = montar({ kind: 'polyline', value: [[0, 0]] })

  esc.ed.setValue([[1, 1], [2, 2], [3, 3]])
  assert.equal(esc.changes.length, 0, 'setValue no dispara onChange')
  assert.equal(esc.commits.length, 0, 'ni onCommit')
  assert.deepEqual(esc.ed.getValue(), [[1, 1], [2, 2], [3, 3]], 'pero sí actualiza el valor interno')

  esc.ed.destroy()
})

test('setValue recablea el gesto: una edición posterior sí emite', () => {
  const esc = montar({ kind: 'polyline', value: [[0, 0]] })

  esc.ed.setValue([[1, 1], [2, 2], [3, 3]])
  assert.equal(esc.changes.length, 0, 'setValue seguía sin emitir')

  const v1 = refsDe(esc.ed.paths[0])[1]                 // el vértice del medio del path NUEVO
  tomar(esc, v1)
  mover(esc, 7, 7)

  assert.equal(esc.changes.length, 1, 'la edición posterior a setValue sí emite (gesto recableado)')
  assert.deepEqual(esc.changes[0], [[1, 1], [7, 7], [3, 3]], 'emite el path nuevo con el vértice movido')

  esc.ed.destroy()
})

/* ── Coordenadas basura: se sanean en el ingest (garbage-in) ── */

test('ingest descarta coordenadas no-finitas (NaN / Infinity / undefined)', () => {
  const line = montar({
    kind: 'polyline',
    value: [[0, 0], [NaN, 5], [10, 10], [Infinity, 2], [1, undefined], [3, 3]],
  })
  assert.deepEqual(line.ed.getValue(), [[0, 0], [10, 10], [3, 3]], 'sólo quedan los pares finitos')
  line.ed.destroy()

  const pt = montar({ kind: 'point', value: [NaN, 1] })
  assert.equal(pt.ed.getValue(), null, 'un point no-finito degenera a null')
  pt.ed.destroy()

  const rect = montar({ kind: 'rectangle', value: [[0, 0], [Infinity, 10]] })
  assert.equal(rect.ed.getValue(), null, 'un rectangle con esquina no-finita degenera a null')
  rect.ed.destroy()
})

// La coacción de la entrada es la regla de punto de la librería: entran sus cuatro formas y la vista
// tipada, y sale siempre el par.
test('ingest acepta las cuatro formas de punto y emite pares', () => {
  const line = montar({
    kind  : 'polyline',
    value : [{ lat: 0, lng: 0 }, { lat: 1, lon: 1 }, { latitude: 2, longitude: 2 }, Float64Array.of(3, 3), { lat: () => 4, lng: () => 4 }],
  })
  assert.deepEqual(line.ed.getValue(), [[0, 0], [1, 1], [2, 2], [3, 3]], 'un objeto con métodos lat()/lng() no es un punto')
  line.ed.destroy()

  const pt = montar({ kind: 'point', value: { latitude: -33.4, longitude: -70.6 } })
  assert.deepEqual(pt.ed.getValue(), [-33.4, -70.6])
  pt.ed.destroy()

  const rect = montar({ kind: 'rectangle', value: [{ lat: 0, lon: 0 }, { latitude: 10, longitude: 10 }] })
  assert.deepEqual(rect.ed.getValue(), [[0, 0], [10, 10]])
  rect.ed.destroy()
})

// El editor DIBUJA la geometría, así que el estilo es suyo: sin esto habría que atarle una capa de
// display al mismo value y se verían las dos, superpuestas.
test('el estilo llega al relleno y al contorno, y restilar no rehace la geometría', () => {
  const RING    = [[0, 0], [0, 10], [10, 10], [10, 0]]
  const pintado = new Map()
  const esc     = montar({ value: RING, pintado, style: { color: '#f59e0b', weight: 2, fillColor: '#f59e0b', fillOpacity: 0.2 } })
  const naranjo = [0xf5 / 255, 0x9e / 255, 0x0b / 255]

  assert.deepEqual(pintado.get('uColor'), [...naranjo, 0.2], 'el relleno')
  assert.deepEqual(pintado.get('color'), [...naranjo, 1], 'y el contorno')

  esc.ed.setStyle({ fillColor: '#2563eb' })
  assert.deepEqual(pintado.get('uColor'), [0x25 / 255, 0x63 / 255, 0xeb / 255, 0.2], 'estilo PARCIAL: la opacidad que no vino queda')
  assert.deepEqual(pintado.get('color'), [...naranjo, 1], 'y lo que no se nombró tampoco se movió')
  assert.deepEqual(esc.ed.getValue(), RING, 'restilar es un uniform, no una reingesta')

  esc.ed.destroy()
})

/* ── Multi-anillo (paths enteros), en forma par y en forma objeto ── */

test('polígono multi-anillo: edita un vértice y conserva ambos anillos (forma par)', () => {
  const OUTER = [[0, 0], [0, 10], [10, 10], [10, 0]]
  const INNER = [[2, 2], [2, 4], [4, 4], [4, 2]]
  const esc   = montar({ kind: 'polygon', value: [OUTER, INNER] })

  // El valor entra y sale como multi-anillo (array de anillos), no aplanado.
  const v0 = esc.ed.getValue()
  assert.equal(v0.length, 2, 'dos anillos')
  assert.deepEqual(v0[0], OUTER, 'anillo externo intacto')
  assert.deepEqual(v0[1], INNER, 'anillo interno intacto')

  // Cada anillo tiene su propio trazo y su propio pase: el impacto se atribuye al anillo que lo reconoce.
  const interno = refsDe(esc.ed.paths[1])[0]
  tomar(esc, interno, 1)
  mover(esc, 9, 9)

  const g = esc.changes.at(-1)
  assert.equal(g.length, 2, 'la emisión sigue siendo multi-anillo')
  assert.deepEqual(g[0], OUTER, 'el anillo externo no se tocó')
  assert.deepEqual(g[1], [[9, 9], [2, 4], [4, 4], [4, 2]], 'sólo el vértice del anillo interno se movió')

  esc.ed.destroy()
})

test('multi-anillo en forma objeto {lat,lng} NO se confunde con anillo simple', () => {
  const OUTER = [{ lat: 0, lng: 0 }, { lat: 0, lng: 10 }, { lat: 10, lng: 10 }, { lat: 10, lng: 0 }]
  const INNER = [{ lat: 2, lng: 2 }, { lat: 2, lng: 4 }, { lat: 4, lng: 4 }, { lat: 4, lng: 2 }]
  const esc   = montar({ kind: 'polygon', value: [OUTER, INNER] })

  const v = esc.ed.getValue()
  // El anidado se decide por puntos, no por pares: sale como 2 anillos de 4 pares [lat,lng] cada uno.
  assert.equal(v.length, 2, 'se detecta como multi-anillo (2 anillos)')
  assert.deepEqual(v[0], [[0, 0], [0, 10], [10, 10], [10, 0]], 'anillo externo → pares')
  assert.deepEqual(v[1], [[2, 2], [2, 4], [4, 4], [4, 2]], 'anillo interno → pares')

  esc.ed.destroy()
})

// El multi-anillo lo decide la regla del path de las líneas: un primer anillo vacío o con un vértice nulo
// en la cabeza no vuelve simple al valor —que se descartaría entero, porque un anillo no es un punto—, y
// un anillo que no es array se lee, como una parte de una línea.
test('multi-anillo cuyo primer anillo llega vacío, sucio en la cabeza o como iterable', () => {
  const OUTER = [[0, 0], [0, 10], [10, 10], [10, 0]]
  const INNER = [[2, 2], [2, 4], [4, 4], [4, 2]]
  const casos = {
    'vacío'                   : [[[], INNER], [[], INNER]],
    'con un nulo en cabeza'   : [[[null, ...OUTER], INNER], [OUTER, INNER]],
    'con dos nulos en cabeza' : [[[null, null, ...OUTER], INNER], [OUTER, INNER]],
    'como Set'                : [[new Set(OUTER), INNER], [OUTER, INNER]],
  }
  for (const [nombre, [value, esperado]] of Object.entries(casos)) {
    const esc = montar({ kind: 'polygon', value })
    assert.deepEqual(esc.ed.getValue(), esperado, nombre)
    esc.ed.destroy()
  }
})

/* ── point-drag en modo edit ── */

test('point en edit: arrastrar su único vértice emite el punto movido', () => {
  const esc = montar({ kind: 'point', value: [5, 5] })

  // El punto no expone trazo (`paths` es vacío para él): su vértice es la primera entrada del arena.
  arrastrar(esc, 0, [[8, 12]])

  assert.equal(esc.changes.length, 1, 'un drag → un onChange')
  assert.deepEqual(esc.changes[0], [8, 12], 'emite el punto nuevo como par [lat,lng]')
  assert.deepEqual(esc.ed.getValue(), [8, 12], 'getValue refleja el punto movido')

  esc.ed.destroy()
})

// point y rectangle DERIVAN su trazo de su estado: ese trazo es del dibujo y del gesto, no del valor —por
// eso no entra a `paths`— y lo que sale por getValue es una copia, no el par que el editor tiene vivo.
test('point y rectangle: el trazo derivado no es el valor, y la salida es una copia', () => {
  const pt = montar({ kind: 'point', value: [5, 5] })
  assert.deepEqual(pt.ed.paths, [], 'el punto no expone trazo')
  pt.ed.getValue()[0] = 999
  assert.deepEqual(pt.ed.getValue(), [5, 5], 'y su salida es una copia, no el par interno')
  pt.ed.destroy()

  const rect = montar({ kind: 'rectangle', value: [[0, 0], [10, 20]] })
  assert.deepEqual(rect.ed.paths, [], 'el rectángulo tampoco: sus cuatro esquinas salen del bounds')
  rect.ed.getValue()[0][0] = 999
  assert.deepEqual(rect.ed.getValue(), [[0, 0], [10, 20]], 'ídem el bounds, esquina por esquina')
  rect.ed.destroy()
})

/* ── rectangle: draw de 2 clicks + corner-drag ── */

test('rectangle: 2 clicks trazan el bounds y arrastrar una esquina lo recompone', () => {
  const esc = montar({ kind: 'rectangle', value: null, mode: 'draw' })

  // Primer click fija una esquina (sin emitir todavía); el segundo cierra el bounds.
  clickMapa(esc, 0, 0)
  assert.equal(esc.changes.length, 0, 'el primer click sólo fija el ancla, no emite')
  clickMapa(esc, 10, 20)
  assert.deepEqual(esc.changes.at(-1), [[0, 0], [10, 20]], 'el segundo click emite el bounds [[S,W],[N,E]]')

  // Pasamos a edit para tener las 4 esquinas como handles y arrastrar una.
  esc.ed.setMode('edit')
  assert.equal(esc.changes.length, 1, 'setMode no emite')

  // Las esquinas van [SW, NW, NE, SE] y viven en un chunk único: la SW es la entrada 0. La opuesta
  // (NE [10,20]) queda fija.
  arrastrar(esc, 0, [[5, 5]])

  assert.deepEqual(esc.changes.at(-1), [[5, 5], [10, 20]], 'el bounds se recompone por min/max contra la esquina opuesta')
  assert.deepEqual(esc.ed.getValue(), [[5, 5], [10, 20]], 'getValue refleja el rectángulo redimensionado')

  esc.ed.destroy()
})

// La esquina arrastrada puede CRUZAR a la opuesta: el bounds se recompone por min/max, así que el
// rectángulo se da vuelta y la entrada tomada pasa a ser la esquina de enfrente. El arrastre siguiente lo
// prueba: su esquina opuesta la lee del TRAZO, que el frame anterior tuvo que dejar al día.
test('rectangle: la esquina cruza a la opuesta y el arrastre siguiente parte del rectángulo nuevo', () => {
  const esc = montar({ kind: 'rectangle', value: [[0, 0], [10, 20]] })

  arrastrar(esc, 0, [[15, 25]])                         // la SW se pasa al noreste de la NE
  assert.deepEqual(esc.ed.getValue(), [[10, 20], [15, 25]], 'el bounds se recompone por min/max, dado vuelta')

  arrastrar(esc, 4, [[12, 22]])                         // ahora la NE, contra la SW que quedó en [10,20]
  assert.deepEqual(esc.ed.getValue(), [[10, 20], [12, 22]], 'las cuatro esquinas del trazo siguieron al bounds')

  assert.deepEqual({ changes: esc.changes.length, commits: esc.commits.length }, { changes: 2, commits: 2 },
    'dos gestos, dos emisiones y dos asentados')

  esc.ed.destroy()
})

test('el rectángulo no inserta ni borra vértices: siempre tiene cuatro esquinas', () => {
  const esc = montar({ kind: 'rectangle', value: [[0, 0], [10, 20]] })

  doble(esc, 0)                                         // doble click sobre la esquina SW
  tomar(esc, 1)                                         // pulsación sobre el midpoint de esa arista

  assert.equal(esc.changes.length, 0, 'ni el borrado ni la inserción tocan un rectángulo')
  assert.deepEqual(esc.ed.getValue(), [[0, 0], [10, 20]], 'el bounds queda intacto')

  esc.ed.destroy()
})

/* ── draw close: dblclick no duplica el último punto ni re-emite idéntico ── */

// El cierre es del editor: el mapa no hace zoom con él. Con un solo vértice no hay trazo que cerrar, y el
// doble click sigue siendo del mapa.
test('draw dblclick de cierre: no duplica el último vértice, no re-emite idéntico ni hace zoom', () => {
  const esc = montar({ kind: 'polyline', value: [], mode: 'draw' })

  clickMapa(esc, 0, 0)                                  // A → emite [A]
  const suelto = dobleMapa(esc, 0, 0)
  clickMapa(esc, 5, 5)                                  // B → emite [A,B]
  clickMapa(esc, 9, 9)                                  // C → emite [A,B,C]
  assert.equal(esc.changes.length, 3, 'tres clicks distintos → tres emisiones')

  // El doble click llega detrás de sus dos clicks, en el mismo píxel.
  clickMapa(esc, 9, 9)
  const cierre = dobleMapa(esc, 9, 9)

  assert.deepEqual(
    { changes: esc.changes.length, valor: esc.ed.getValue(), suelto: suelto.cortado, cierre: cierre.cortado },
    { changes: 3, valor: [[0, 0], [5, 5], [9, 9]], suelto: false, cierre: true },
    'el cierre no duplica el punto ni re-emite una geometría idéntica, y se lo saca al zoom del mapa',
  )

  esc.ed.destroy()
})

// El duplicado que el dedup del click no ve —uno que ya traía el valor— lo colapsa el doble click.
test('draw dblclick de cierre: colapsa el duplicado final que traía el valor', () => {
  const esc = montar({ kind: 'polyline', value: [[0, 0], [5, 5], [5, 5]], mode: 'draw' })
  dobleMapa(esc, 5, 5)
  assert.deepEqual([esc.changes.length, esc.ed.getValue()], [1, [[0, 0], [5, 5]]])
  esc.ed.destroy()
})

/* ── onChange (live) vs onCommit (settle) ── */

test('onChange es live por drag; onCommit asienta al soltar (y en cada edición discreta)', () => {
  const esc = montar({ kind: 'polygon', value: SQUARE })
  const v1  = refsDe(esc.ed.paths[0])[1]                // vértice índice 1 = [0,10]

  tomar(esc, v1)
  mover(esc, 1, 11)
  mover(esc, 2, 12)
  mover(esc, 3, 13)
  assert.equal(esc.changes.length, 3, 'onChange emite por cada frame de drag')
  assert.equal(esc.commits.length, 0, 'onCommit NO emite durante el drag (sin soltar)')

  soltar(esc)
  assert.equal(esc.commits.length, 1, 'onCommit emite UNA vez al soltar')
  assert.deepEqual(esc.commits[0][1], [3, 13], 'el commit lleva la geometría asentada')

  doble(esc, refsDe(esc.ed.paths[0])[0])                // edición discreta: borra un vértice (4 → 3)
  assert.equal(esc.changes.length, 4, 'la edición discreta también emite onChange')
  assert.equal(esc.commits.length, 2, 'y asienta onCommit en el mismo gesto')

  esc.ed.destroy()
})

test('una pulsación sin arrastre no es una edición: no emite ni asienta', () => {
  const esc = montar({ kind: 'polygon', value: SQUARE })

  tomar(esc, refsDe(esc.ed.paths[0])[1])
  soltar(esc)

  assert.deepEqual({ changes: esc.changes.length, commits: esc.commits.length }, { changes: 0, commits: 0 },
    'las dos pulsaciones de un doble click no pueden entrar como si hubieran movido algo')

  esc.ed.destroy()
})

/* ── La pulsación: del gesto si tomó un handle, del mapa si no ── */

// El click del mapa lo sintetiza la puerta con la pulsación quieta que no tomó nadie: la que tomó un handle
// no tiene click, se mueva o no, y su `pointerup` no sigue a la burbuja.
test('soltar un handle no sale como click del mapa, en las cuatro formas', () => {
  const casos = [
    ['polygon', SQUARE],
    ['polyline', [[0, 0], [5, 5], [9, 9]]],
    ['point', [5, 5]],
    ['rectangle', [[0, 0], [10, 20]]],
  ]
  casos.forEach(([kind, value]) => {
    const esc = montar({ kind, value })
    tomar(esc, esc.ed.paths[0]?.firstVertex ?? 0)
    mover(esc, 3, 4)
    const e = soltar(esc)
    assert.deepEqual(
      { cortado: e.cortado, alMapa: esc.alMapa.length, commits: esc.commits.length },
      { cortado: true, alMapa: 0, commits: 1 },
      `${kind}: el arrastre asentó y no hubo click`,
    )
    esc.ed.destroy()
  })
})

test('una pulsación quieta sobre un vértice no es un click, y la que sigue en el vacío sí', () => {
  const esc = montar({ kind: 'polygon', value: SQUARE })

  const delGesto = pulsarHandle(esc, refsDe(esc.ed.paths[0])[1])
  const suelta   = pulsarVacio(esc, 500, 300)

  assert.deepEqual(
    { delGesto: delGesto.cortado, suelta: suelta.cortado, alMapa: esc.alMapa, changes: esc.changes.length },
    { delGesto: true, suelta: false, alMapa: [{ lat: 3, lng: 5 }], changes: 0 },
    'la pulsación sin arrastre no edita ni sale como click; la siguiente, en el vacío, es del mapa',
  )

  esc.ed.destroy()
})

test('la pulsación sobre un midpoint no es un click', () => {
  const esc  = montar({ kind: 'polyline', value: [[0, 0], [0, 10]] })
  const path = esc.ed.paths[0]

  const e = pulsarHandle(esc, path.midOf(path.firstVertex))

  assert.deepEqual({ cortado: e.cortado, alMapa: esc.alMapa.length }, { cortado: true, alMapa: 0 })

  esc.ed.destroy()
})

// `onCommit` corre a mitad de la pulsación —al soltar un arrastre, o en el `pointerdown` que inserta por un
// midpoint, antes de tomar el gesto— y puede sacar al editor de edit. La pulsación sigue siendo suya: no
// sale como click ni, en draw, agrega un vértice donde se soltó. La inserción cortada tampoco toma el
// gesto, así que el arrastre del mapa queda como estaba.
const CORTES = [['draw', ed => ed.setMode('draw')], ['destroy', ed => ed.destroy()]]

test('un onCommit que corta la pulsación no la vuelve un click', () => {
  const gestos = [
    ['arrastre', esc => arrastrar(esc, esc.ed.paths[0].firstVertex, [[3, 4]]), 2],
    ['midpoint', esc => pulsarHandle(esc, esc.ed.paths[0].midOf(esc.ed.paths[0].firstVertex)), 3],
  ]
  CORTES.forEach(([corte, alAsentar]) => gestos.forEach(([gesto, pulsar, vertices]) => {
    const esc = montar({ kind: 'polyline', value: [[0, 0], [0, 10]], alAsentar })
    pulsar(esc)
    assert.deepEqual(
      { arrastre: esc.dragging.activo, alMapa: esc.alMapa.length, vertices: esc.ed.getValue().length },
      { arrastre: true, alMapa: 0, vertices },
      `${gesto} cortado por ${corte}`,
    )
    esc.ed.destroy()
  }))
})

// La pulsación cortada terminó con su `pointerup`: la siguiente, en el vacío, es del mapa.
test('la pulsación que sigue a un corte es del mapa', () => {
  CORTES.forEach(([corte, alAsentar]) => {
    const esc = montar({ kind: 'polyline', value: [[0, 0], [0, 10]], alAsentar })
    arrastrar(esc, esc.ed.paths[0].firstVertex, [[3, 4]])
    const e = pulsarVacio(esc, 500, 300)
    assert.deepEqual({ consumido: e.consumido, alMapa: esc.alMapa.length }, { consumido: false, alMapa: 1 }, corte)
    esc.ed.destroy()
  })
})

// El navegador despacha dos pulsaciones completas antes del `dblclick`.
test('el doble click que borra un vértice es del gesto entero: sus dos pulsaciones y el dblclick', () => {
  const esc = montar({ kind: 'polygon', value: SQUARE })
  const v0  = refsDe(esc.ed.paths[0])[0]

  const eventos = [tomar(esc, v0), soltar(esc), tomar(esc, v0), soltar(esc), doble(esc, v0)]

  assert.deepEqual(eventos.map(e => e.cortado), [true, true, true, true, true], 'ninguno sigue al mapa, ni hace zoom')
  assert.deepEqual({ vertices: esc.ed.getValue().length, alMapa: esc.alMapa.length }, { vertices: 3, alMapa: 0 },
    'borró el vértice y el mapa no vio ningún click')

  esc.ed.destroy()
})

test('un click en el vacío sigue siendo del mapa', () => {
  const esc = montar({ kind: 'polygon', value: SQUARE })

  const e = pulsarVacio(esc, 500, 300)

  assert.deepEqual({ consumido: e.consumido, alMapa: esc.alMapa }, { consumido: false, alMapa: [{ lat: 3, lng: 5 }] })

  esc.ed.destroy()
})

// Un `pointercancel` termina la pulsación como su `pointerup`, sin click.
test('un pointercancel suelta el gesto sin asentar un vértice quieto, y la pulsación siguiente es del mapa', () => {
  const esc = montar({ kind: 'polygon', value: SQUARE })

  tomar(esc, refsDe(esc.ed.paths[0])[1])
  const cancelado = emitir(esc, 'pointercancel', esc.punto[0], esc.punto[1])
  pulsarVacio(esc, 500, 300)

  assert.deepEqual(
    { cancelado: cancelado.cortado, arrastre: esc.dragging.activo, commits: esc.commits.length, alMapa: esc.alMapa.length },
    { cancelado: true, arrastre: true, commits: 0, alMapa: 1 },
  )

  esc.ed.destroy()
})

// En draw el click del mapa ES la edición.
test('en draw el click del mapa sigue agregando vértices', () => {
  const esc = montar({ kind: 'polyline', value: [[0, 0], [0, 10]] })

  esc.ed.setMode('draw')
  pulsarVacio(esc, 200, 100)
  pulsarVacio(esc, 400, 300)

  assert.deepEqual(esc.ed.getValue(), [[0, 0], [0, 10], [1, 2], [3, 4]])

  esc.ed.destroy()
})

// Los controles del anfitrión viven dentro del contenedor, por encima de la superficie de edición, pero
// fuera de su `mapPane`: uno que tapa un handle se queda con su pulsación y su doble click, que no toman ni
// borran el vértice de abajo ni salen como click del mapa.
test('sobre un control que tapa un handle, la pulsación es del control', () => {
  const esc     = montar({ kind: 'polygon', value: SQUARE })
  const v1      = refsDe(esc.ed.paths[0])[1]
  const control = { parentNode: esc.container }
  esc.destino   = { parentNode: control }

  const eventos = [tomar(esc, v1), soltar(esc), doble(esc, v1)]

  assert.deepEqual(
    { consumidos: eventos.map(e => e.consumido), vertices: esc.ed.getValue().length, alMapa: esc.alMapa.length },
    { consumidos: [false, false, false], vertices: 4, alMapa: 0 },
  )

  esc.ed.destroy()
})

/* ── El pick: caché por píxel y pase síncrono ── */

// La caché se mide por su COSTO: el pase síncrono es el único que lee el framebuffer dentro del gesto, y
// cada lectura queda anotada en el espía. Con el puntero quieto no puede aparecer una nueva.
test('el pointerdown reusa la última muestra ya resuelta: sin stall de GPU si el píxel no cambió', () => {
  const esc  = montar({ kind: 'polygon', value: SQUARE })
  const refs = refsDe(esc.ed.paths[0])

  // Hover sobre el vértice 1 —que vive en el píxel (1000,0)—: el pase asíncrono se pide en un pointermove
  // y se cobra en el siguiente.
  apuntar(esc, refs[1])
  posar(esc, 1000, 0)
  const asincronas = esc.spy.readbacks.length

  emitir(esc, 'pointerdown', 1000, 0)
  mover(esc, 6, 16)
  assert.deepEqual(esc.changes.at(-1)[1], [6, 16], 'el gesto agarró el vértice que ya había resuelto el hover')
  assert.equal(esc.spy.readbacks.length, asincronas, 'y no pagó una lectura más: el píxel no cambió')
  emitir(esc, 'pointerup', 1600, 600)

  // Píxel distinto ⇒ la caché no aplica y el gesto cae al pase SÍNCRONO, el único que contesta a tiempo.
  apuntar(esc, refs[3])
  emitir(esc, 'pointerdown', 0, 1000)
  mover(esc, 7, 17)
  assert.deepEqual(esc.changes.at(-1)[3], [7, 17], 'con el píxel cambiado el pick síncrono resuelve igual')
  assert.ok(esc.spy.readbacks.length > asincronas, 'y ahí sí hubo una lectura bloqueante')

  esc.ed.destroy()
})

// El midpoint inactivo del último vértice de un trazo abierto NO se saca del batch: se le asigna el tile
// TRANSPARENTE, y el fragment del pase descarta por silueta. Una escritura apaga el visual y el pase a la
// vez, sin excepción en el recorrido. Sin ese descarte el pase devuelve un handle que no está dibujado en
// ninguna parte, y el editor se queda con una pulsación que era del mapa.
test('el midpoint inactivo del extremo de un trazo abierto no es pickeable', () => {
  const esc  = montar({ kind: 'polyline', value: [[0, 0], [1, 1], [2, 2], [3, 3]] })
  const path = esc.ed.paths[0]
  const mid  = path.midOf(path.lastVertex)
  assert.equal(path.roleAt(mid), ROLE.free, 'en el último vértice no arranca ningún segmento')

  const pulsacion = tomar(esc, mid)

  assert.deepEqual(
    { valor: esc.ed.getValue(), changes: esc.changes.length, consumido: pulsacion.consumido },
    { valor: [[0, 0], [1, 1], [2, 2], [3, 3]], changes: 0, consumido: false },
    'la entrada que el tile apaga no devuelve impacto, y sin impacto el evento sigue siendo del mapa',
  )

  esc.ed.destroy()
})

/* ── El arrastre del mapa: prestado mientras dura el gesto, devuelto por TODAS las salidas ── */

// El gesto lo posee la capa GL, y para eso apaga el arrastre del mapa. Si una salida no lo devuelve, el
// mapa queda sin arrastre para el resto de la sesión y ningún aserto de geometría lo nota.
test('el gesto devuelve el arrastre del mapa, lo termine el usuario o lo corte el editor', () => {
  const esc = montar({ kind: 'polygon', value: SQUARE })
  const v1  = refsDe(esc.ed.paths[0])[1]

  tomar(esc, v1)
  assert.equal(esc.dragging.activo, false, 'con el vértice tomado el mapa no arrastra')
  soltar(esc)
  assert.equal(esc.dragging.activo, true, 'y al soltar lo recupera')

  tomar(esc, v1)
  mover(esc, 5, 20)
  const asentados = esc.commits.length
  esc.ed.destroy()
  assert.equal(esc.dragging.activo, true, 'destruir el editor a mitad de gesto también lo devuelve')
  assert.equal(esc.commits.length, asentados, 'y no asienta: destruirlo no es confirmar la edición')
})

// El gesto es del puntero que lo tomó. Un segundo dedo que se apoya sobre otro handle no lo reinicia —y
// el arrastre que el primero ya había apagado quedaría sin nadie que lo devuelva—, no arrastra el vértice
// tomado ni lo suelta: el primero lo asienta donde lo dejó.
test('un segundo puntero no toca el gesto de otro', () => {
  const esc      = montar({ kind: 'polygon', value: SQUARE })
  const [v0, v1] = refsDe(esc.ed.paths[0])

  tomar(esc, v0)
  mover(esc, 2, 3)
  esc.puntero = 2
  const ajenos = [tomar(esc, v1), mover(esc, 8, 8), soltar(esc)]
  assert.equal(esc.dragging.activo, false, 'el gesto sigue vivo con el segundo dedo levantado')
  esc.puntero = 1
  soltar(esc)

  assert.deepEqual(
    {
      consumidos : ajenos.map(e => e.consumido),
      arrastre   : esc.dragging.activo,
      commits    : esc.commits.length,
      tomado     : esc.ed.getValue()[0],
    },
    { consumidos: [false, false, false], arrastre: true, commits: 1, tomado: [2, 3] },
  )

  esc.ed.destroy()
})

test('setMode a mitad de gesto lo suelta sin asentar', () => {
  const esc = montar({ kind: 'polygon', value: SQUARE })

  tomar(esc, refsDe(esc.ed.paths[0])[1])
  mover(esc, 5, 20)
  esc.ed.setMode('draw')

  assert.deepEqual({ arrastre: esc.dragging.activo, commits: esc.commits.length }, { arrastre: true, commits: 0 },
    'el mapa recupera el arrastre y el gesto cortado no confirma nada')

  esc.ed.destroy()
})

// La otra mitad del préstamo: devolver de más es tan malo como no devolver. El arrastre puede estar
// apagado porque lo apagó el CONSUMIDOR, y una salida del editor que lo prenda le pisa el mapa.
test('sin gesto vivo el editor no toca el arrastre: sólo devuelve lo que tomó', () => {
  const esc = montar({ kind: 'polygon', value: SQUARE })
  esc.dragging.disable()

  esc.ed.setMode('draw')
  assert.equal(esc.dragging.activo, false, 'setMode sin gesto no prende un arrastre ajeno')

  esc.ed.destroy()
  assert.equal(esc.dragging.activo, false, 'ni destroy')
})

/* ── El vecindario bajo el cursor: los ÚNICOS nodos DOM que el editor monta por gesto ── */

// `presupuesto-dom.test.mjs` congela el costo EN REPOSO (6 nodos: la superficie y los tiles del atlas).
// Lo que ese número no puede ver es el gesto, y es justo lo que esta tanda cableó: el banco repone como
// nodo el vértice bajo el cursor y sus dos adyacentes. Sin este aserto, un `promote` desconectado del
// hover deja el presupuesto en verde y la afordancia muerta.
test('el hover monta el vecindario —tres nodos— y salir lo devuelve entero', () => {
  const esc   = montar({ kind: 'polygon', value: SQUARE })
  const nodos = contadorNodos()

  posar(apuntar(esc, refsDe(esc.ed.paths[0])[1]), 40, 40)
  assert.equal(nodos.vivos, 3, 'el vértice bajo el cursor y sus DOS adyacentes, y nada más')

  posar(vaciar(esc), 90, 90)
  assert.deepEqual({ vivos: nodos.vivos, destruidos: nodos.destruidos }, { vivos: 0, destruidos: 3 },
    'salir del handle los devuelve: en reposo el editor no cuelga un solo nodo por vértice')

  esc.ed.destroy()
})

// La puerta le entrega cada muestra del puntero en cualquier modo: fuera de `edit` no hay handles que
// tomar, así que el hover no pide el pase de picking, ni monta vecindario ni informa un handle.
test('en draw el puntero no pide el pase, ni monta vecindario ni informa un handle', () => {
  const esc   = montar({ kind: 'polygon', value: SQUARE, mode: 'draw' })
  const nodos = contadorNodos()
  const antes = esc.spy.readbacks.length

  posar(apuntar(esc, refsDe(esc.ed.paths[0])[1]), 40, 40)

  assert.deepEqual(
    { pases: esc.spy.readbacks.length - antes, vivos: nodos.vivos, informes: esc.informes },
    { pases: 0, vivos: 0, informes: [] },
  )

  esc.ed.destroy()
})

// El hover se cobra en la muestra SIGUIENTE, así que un vecindario que sobrevive al gesto queda atado a
// que el puntero vuelva a moverse: se detiene tras soltar y la afordancia se queda encendida.
test('soltar devuelve el vecindario: la afordancia no sobrevive al gesto', () => {
  const esc   = montar({ kind: 'polygon', value: SQUARE })
  const nodos = contadorNodos()

  tomar(esc, refsDe(esc.ed.paths[0])[1])
  mover(esc, 4, 4)
  assert.equal(nodos.vivos, 3, 'durante el gesto el vecindario está montado')

  soltar(esc)
  assert.equal(nodos.vivos, 0, 'y al soltar se devuelve, sin esperar otra muestra del puntero')

  esc.ed.destroy()
})

test('en el extremo de un trazo abierto el vecindario son DOS: el primero no tiene anterior', () => {
  const esc   = montar({ kind: 'polyline', value: [[0, 0], [1, 1], [2, 2], [3, 3]] })
  const nodos = contadorNodos()

  posar(apuntar(esc, refsDe(esc.ed.paths[0])[0]), 40, 40)
  assert.equal(nodos.vivos, 2, 'el vecindario sale de la LISTA del trazo, no de aritmética sobre el ref')

  esc.ed.destroy()
})

test('destroy recoge el vecindario promovido: no queda un nodo del gesto colgando', () => {
  const esc   = montar({ kind: 'polygon', value: SQUARE })
  const nodos = contadorNodos()

  posar(apuntar(esc, refsDe(esc.ed.paths[0])[1]), 40, 40)
  assert.equal(nodos.vivos, 3, 'con el cursor encima hay vecindario')

  esc.ed.destroy()
  assert.equal(nodos.vivos, 0, 'y destroy lo suelta con el resto del stack, no lo deja en el pane')
})

/* ── El nivel de handle que ve el mapa ── */

// El mapa lo traduce a cursor. Se informa en cada momento que puede cambiarlo, y sólo si cambió: una
// muestra del puntero que resuelve lo mismo no llega al mapa.
test('el nivel de handle se informa al cambiar, y sólo al cambiar: hover, gesto y salida', () => {
  const esc  = montar({ kind: 'polygon', value: SQUARE })
  const path = esc.ed.paths[0]
  const v1   = refsDe(path)[1]

  posar(apuntar(esc, v1), 40, 40)
  posar(esc, 40, 40)
  assert.deepEqual(esc.informes, [HANDLE_OVER], 'sobre un vértice, una vez aunque el hover se repita')

  tomar(esc, v1)
  mover(esc, 3, 4)
  mover(esc, 5, 6)
  assert.deepEqual(esc.informes, [HANDLE_OVER, HANDLE_HELD], 'tomado, y los frames del arrastre no lo repiten')

  soltar(esc)
  posar(vaciar(esc), 900, 900)
  posar(apuntar(esc, path.midOf(v1)), 40, 40)
  emitir(esc, 'pointerleave', 40, 40)
  assert.deepEqual(esc.informes, [HANDLE_OVER, HANDLE_HELD, HANDLE_OVER, HANDLE_NONE, HANDLE_OVER, HANDLE_NONE],
    'soltado sigue bajo el puntero; el vacío lo suelta, un midpoint también cuenta y salir lo suelta')

  esc.ed.destroy()
})

// Pasar por un control —el zoom, la atribución— y volver al mapa no es salir del mapa: el puntero sigue
// sobre el handle, y soltarlo lo apagaría hasta que el pase asíncrono lo vuelva a contestar.
test('la salida de un descendiente del contenedor no suelta el handle; la del contenedor, sí', () => {
  const esc = montar({ kind: 'polygon', value: SQUARE })

  posar(apuntar(esc, refsDe(esc.ed.paths[0])[1]), 40, 40)
  esc.destino = { parentNode: esc.container }
  emitir(esc, 'pointerleave', 40, 40)
  assert.deepEqual(esc.informes, [HANDLE_OVER], 'salió de un control')
  esc.destino = esc.container
  emitir(esc, 'pointerleave', 40, 40)
  assert.deepEqual(esc.informes, [HANDLE_OVER, HANDLE_NONE], 'salió del mapa')

  esc.ed.destroy()
})

test('la vista, el modo, el valor y el borrado sueltan el handle informado', () => {
  const cortes = [
    ['la vista cambió', esc => esc.map.fire('moveend')],
    ['fuera de edit', esc => esc.ed.setMode('draw')],
    ['un valor nuevo', esc => esc.ed.setValue(SQUARE)],
    ['el vértice se borró', esc => doble(esc, refsDe(esc.ed.paths[0])[0])],
  ]
  cortes.forEach(([corte, cortar]) => {
    const esc = montar({ kind: 'polygon', value: SQUARE })
    posar(apuntar(esc, refsDe(esc.ed.paths[0])[1]), 40, 40)
    cortar(esc)
    assert.deepEqual(esc.informes, [HANDLE_OVER, HANDLE_NONE], corte)
    esc.ed.destroy()
  })
})

// Mientras dura otro modo nadie sigue al puntero: lo que se resolvió bajo él antes no vale al volver.
test('de vuelta en edit no se informa un handle que se resolvió antes de salir', () => {
  const esc = montar({ kind: 'polygon', value: SQUARE })

  posar(apuntar(esc, refsDe(esc.ed.paths[0])[1]), 40, 40)
  esc.ed.setMode('draw')
  esc.ed.setMode('edit')

  assert.deepEqual(esc.informes, [HANDLE_OVER, HANDLE_NONE])

  esc.ed.destroy()
})

// El ref tomado es posicional: el valor nuevo lo suelta. Sin hover previo, la pulsación informa «bajo el
// puntero» antes de «tomado».
test('setValue a mitad de gesto suelta el handle tomado', () => {
  const esc = montar({ kind: 'polygon', value: SQUARE })

  tomar(esc, refsDe(esc.ed.paths[0])[1])
  mover(esc, 5, 20)
  esc.ed.setValue(SQUARE)

  assert.deepEqual(esc.informes, [HANDLE_OVER, HANDLE_HELD, HANDLE_NONE])

  esc.ed.destroy()
})

// La pulsación resuelve el píxel en el acto, sin esperar al hover —el touch no lo tiene, y una muestra
// puede no haber vuelto del GPU—, y eso cuenta también cuando no toma nada: el handle que dejó informado
// una muestra anterior se suelta aunque la última todavía no haya contestado.
test('una pulsación en el vacío suelta el handle aunque el GPU no haya contestado la última muestra', () => {
  const esc = montar({ kind: 'polygon', value: SQUARE })

  posar(apuntar(esc, refsDe(esc.ed.paths[0])[1]), 40, 40)
  esc.spy.status = 0x911A   // TIMEOUT_EXPIRED: el pase de hover deja de contestar
  emitir(vaciar(esc), 'pointermove', 900, 900)
  emitir(esc, 'pointerdown', 900, 900)

  assert.deepEqual(esc.informes, [HANDLE_OVER, HANDLE_NONE])

  esc.ed.destroy()
})

// Tras destroy el mapa ya olvidó al editor: un aviso tardío lo volvería a anotar, con su cursor pegado.
test('destroy suelta el handle y no informa nada después, aunque lo corte un onCommit', () => {
  const quieto = montar({ kind: 'polygon', value: SQUARE })
  posar(apuntar(quieto, refsDe(quieto.ed.paths[0])[1]), 40, 40)
  quieto.ed.destroy()
  assert.deepEqual(quieto.informes, [HANDLE_OVER, HANDLE_NONE])

  const casos = [['destroy', ed => ed.destroy()], ['draw', ed => ed.setMode('draw')]]
  casos.forEach(([corte, alAsentar]) => {
    const esc = montar({ kind: 'polygon', value: SQUARE, alAsentar })
    arrastrar(esc, refsDe(esc.ed.paths[0])[1], [[3, 4]])
    assert.deepEqual(esc.informes, [HANDLE_OVER, HANDLE_HELD, HANDLE_NONE],
      `${corte} en onCommit: el vértice soltado ya no es un handle`)
    esc.ed.destroy()
  })
})

/* ── Costo en el arena: insertar toca un chunk, arrastrar no toca la estructura ── */

test('insertar un vértice desplaza a lo sumo un chunk del arena, no el trazo entero', () => {
  const N      = 2500                                     // varios chunks con el tamaño de producción
  const puntos = diagonal(N)
  const esc    = montar({ kind: 'polyline', value: puntos })
  const path   = esc.ed.paths[0]
  assert.ok(path.chunkCount > 1, 'el trazo tiene que ocupar más de un chunk')

  // El midpoint del PRIMER segmento: insertar ahí deja los otros N-1 vértices por detrás, que es el peor
  // caso del modelo viejo (el splice del array los corría a todos).
  const antes = refsDe(path)
  tomar(esc, path.midOf(path.firstVertex))

  const despues = refsDe(path)
  assert.equal(despues.length, N + 1, 'entró un vértice')
  assert.deepEqual(
    esc.ed.getValue()[1],
    [(puntos[0][0] + puntos[1][0]) / 2, (puntos[0][1] + puntos[1][1]) / 2],
    'y quedó en el midpoint de la arista',
  )

  const sobrevivientes = despues.filter((ref, i) => i !== 1)
  const movidos        = sobrevivientes.filter((ref, i) => ref !== antes[i]).length
  assert.ok(movidos * 2 <= path.entriesPerChunk, `las entradas desplazadas caben en UN chunk (${movidos * 2})`)
  assert.ok(movidos < N / 2, `${movidos} vértices movidos contra los ${N - 1} que corría un splice`)
  assert.deepEqual(sobrevivientes.slice(-1000), antes.slice(-1000), 'la cola del trazo no se movió del arena')

  esc.ed.destroy()
})

// El sprite del handle sale por `gl_PointSize`, que se mide en píxeles del FRAMEBUFFER, y la superficie
// de edición rasteriza a px CSS × DPR: sin escalar, el handle se dibuja a la mitad del tamaño declarado
// —y el pase, que lee el MISMO atributo, con la mitad de silueta que agarrar—.
test('el tamaño del handle sube al VBO escalado por la resolución de SU superficie', () => {
  const tamaños = esc => [...esc.spy.array.datos].filter((_, i) => i % FLOATS_POR_ENTRADA === 6)
  const uno = montar({ value: SQUARE })
  const dos = montar({ value: SQUARE, dpr: 2 })

  assert.ok(tamaños(uno).some(s => s > 0), 'el canal de tamaño del VBO tiene que traer los sprites vivos')
  assert.deepEqual(tamaños(dos), tamaños(uno).map(s => s * 2))

  uno.ed.destroy()
  dos.ed.destroy()
})

// La contracara en GPU del test de arriba, que mide el arena en CPU. `bufferData` REALOCA el VBO entero
// —la reconstrucción—; `bufferSubData` escribe un rango. El presupuesto dice que insertar no toca el DOM;
// esto dice que tampoco rehace el espejo, que es de dónde sale que la edición sea O(chunk) de punta a punta.
test('insertar sube UN chunk al espejo GPU, sin reconstruir el VBO', () => {
  const N    = 2500
  const esc  = montar({ kind: 'polyline', value: diagonal(N) })
  const path = esc.ed.paths[0]
  assert.ok(path.chunkCount > 1, 'el trazo tiene que ocupar más de un chunk')

  const spy   = esc.spy
  const antes = { datas: spy.bufferDatas.length, subs: spy.bufferSubDatas.length }
  tomar(esc, path.midOf(path.firstVertex))

  const subidas = spy.bufferSubDatas.slice(antes.subs)
  const floats  = subidas.reduce((n, u) => n + u.length, 0)
  assert.equal(spy.bufferDatas.length, antes.datas, 'ni una realocación del VBO: el espejo no se rehace')
  assert.ok(subidas.length > 0, 'pero el vértice nuevo sí subió')
  assert.ok(floats <= path.entriesPerChunk * FLOATS_POR_ENTRADA,
    `lo subido cabe en UN chunk (${floats} floats contra los ${(2 * N + 1) * FLOATS_POR_ENTRADA} del trazo entero)`)

  esc.ed.destroy()
})

test('arrastrar no renumera el arena: el ref que capturó el gesto sigue valiendo todo el drag', () => {
  const esc   = montar({ kind: 'polygon', value: SQUARE })
  const path  = esc.ed.paths[0]
  const antes = refsDe(path)
  const sello = path.structRev
  const v1    = antes[1]                                  // vértice índice 1 = [0,10]

  // Los 30 destinos son 30 posiciones DISTINTAS de la de agarre: un frame que devuelve el vértice a donde
  // ya estaba no es un frame del gesto —el umbral de click lo descarta— y no tendría por qué emitir.
  arrastrar(esc, v1, Array.from({ length: 30 }, (_, i) => [i + 1, 11 + i]))

  assert.equal(esc.changes.length, 30, 'emitió por cada frame del gesto')
  assert.deepEqual(refsDe(path), antes, 'ningún vértice cambió de lugar en el arena')
  assert.equal(path.structRev, sello, 'y el gesto no fue un cambio estructural')
  assert.deepEqual(esc.ed.getValue()[1], [30, 40], 'el vértice quedó donde lo soltó el último frame')

  // Los dos midpoints que tocan al vértice lo siguieron: el que LLEGA es el del vértice anterior.
  assert.deepEqual(midDe(path, path.prevVertex(v1)), [15, 20], 'midpoint del segmento que llega')
  assert.deepEqual(midDe(path, v1), [20, 25], 'midpoint del segmento que arranca')

  esc.ed.destroy()
})

// El contorno que se dibuja comparte path y arena con el trazo que se pica: el arrastre lo muestra con el
// vértice como uniform, sin re-ingerir el arena ni escribirle un rango por frame, y lo pone al día con UNA
// escritura al soltar.
test('el contorno sigue al arrastre sin escribir al espejo GPU, y lo pone al día al soltar sin re-ingerir', () => {
  const esc        = montar({ kind: 'polygon', value: SQUARE })
  const spy        = esc.spy
  const ingestas   = () => spy.texImages.length + spy.bufferDatas.length
  const escrituras = () => spy.texSubImages.length + spy.bufferSubDatas.length
  tomar(esc, refsDe(esc.ed.paths[0])[1])
  const antes = { ingestas: ingestas(), escrituras: escrituras() }

  ;[[1, 11], [2, 12], [3, 13]].forEach(([lat, lng]) => mover(esc, lat, lng))
  assert.equal(esc.changes.length, 3, 'cada frame del gesto emitió')
  assert.equal(escrituras(), antes.escrituras, 'ningún frame escribe un rango del espejo')

  soltar(esc)
  assert.ok(escrituras() > antes.escrituras, 'soltar sube el vértice')
  assert.equal(ingestas(), antes.ingestas, 'y ni el gesto ni el soltar re-ingieren el arena')
  assert.deepEqual(esc.ed.getValue()[1], [3, 13])

  esc.ed.destroy()
})

// Lo que se pica y lo que se dibuja son dos listas: el anillo que sale del valor tiene que salir de las
// dos, o el relleno y el contorno siguen dibujando un trazo ya soltado.
test('el anillo que setValue quita deja de dibujarse: el frame cuesta lo mismo que el de un editor nuevo', () => {
  const dibujos = esc => {
    const antes = esc.spy.draws.length
    esc.ed.setStyle({})
    return esc.spy.draws.length - antes
  }
  const recortado = montar({ value: [SQUARE, [[2, 2], [2, 4], [4, 4], [4, 2]]] })
  const nuevo     = montar({ value: SQUARE })
  recortado.ed.setValue(SQUARE)

  assert.equal(dibujos(recortado), dibujos(nuevo))

  recortado.ed.destroy()
  nuevo.ed.destroy()
})

/* ── Círculo, elipse y sector ── */

// Las referencias salen de la geographiclib directa —la esfera de radio medio, o WGS84— y de fórmulas
// cerradas. Cada manija vive en el ref 2i de su trazo, como las esquinas del rectángulo.

// Dónde queda la manija `ref` llevada al punto (lat, lng) de la grilla de píxeles: el agarre conserva la
// fracción de píxel que tenía la manija al tomarla.
const llevada = (esc, ref, lat, lng) => {
  const [hlat, hlng] = coordDe(esc, ref)
  return [
    (Math.round(lat * P) + hlat * P - Math.round(hlat * P)) / P,
    (Math.round(lng * P) + hlng * P - Math.round(hlng * P)) / P,
  ]
}

// La distancia y el rumbo en [0, 360) de un punto a otro.
const inverso = (geod, [lat1, lng1], [lat2, lng2]) => {
  const r = geod.Inverse(lat1, lng1, lat2, lng2)
  return { s: r.s12, azi: (r.azi1 + 360) % 360 }
}

// Los segmentos de un anillo de radio `r` en el ecuador a `zoom`: la flecha de 0,2 px en metros de
// Mercator, y la potencia de dos que la cumple.
const segmentos = (r, zoom) => {
  const tol = 0.2 * MEAN_RADIUS * Math.cos(r / MEAN_RADIUS) * 2 * Math.PI / (256 * 2 ** zoom)
  return Math.min(4096, Math.max(16, 2 ** Math.ceil(Math.log2(Math.PI / Math.acos(1 - tol / r)))))
}

// 24 px en metros, en el ecuador.
const minimo = zoom => 24 * 2 * Math.PI * MEAN_RADIUS / (256 * 2 ** zoom)

const cerca = (real, esperado, tol, msg) => assert.ok(Math.abs(real - esperado) < tol, `${msg}: ${real} ≠ ${esperado}`)

test('círculo: el centro traslada la figura, y la manija de radio mide hasta el puntero y queda donde se soltó', () => {
  const esc = montar({ kind: 'circle', value: { center: { lat: 0, lng: 0 }, radius: 30000, sweep: 90 }, zoom: 10 })
  assert.deepEqual(esc.ed.getValue(), { center: [0, 0], radius: 30000 }, 'entra cualquier punto y no lee sweep')
  assert.notEqual(esc.ed.getValue(), esc.ed.getValue(), 'un objeto fresco por lectura')

  arrastrar(esc, 0, [[0.1, 0.1]])
  assert.deepEqual(esc.ed.getValue(), { center: [0.1, 0.1], radius: 30000 })

  const fin = llevada(esc, 2, 0.2, 0.3)
  arrastrar(esc, 2, [[0.2, 0.3]])
  const { s, azi } = inverso(ESFERA, [0.1, 0.1], fin)
  cerca(esc.ed.getValue().radius, s, 1e-6, 'el radio es la distancia al puntero')

  esc.rumbo = azi
  const otra = llevada(esc, 2, -0.1, 0.3)
  arrastrar(esc, 2, [[-0.1, 0.3]])
  cerca(esc.ed.getValue().radius, inverso(ESFERA, [0.1, 0.1], otra).s, 1e-6, 'la manija se toma donde se soltó')
  assert.equal(esc.commits.length, 3)

  esc.ed.destroy()
})

test('elipse: `a` gira y cambia su semieje, `b` sólo el suyo y al soltar vuelve al eje', () => {
  const esc = montar({ kind: 'ellipse', value: { center: [0, 0], radius: [200000, 100000], heading: -30 }, zoom: 10 })
  assert.deepEqual(esc.ed.getValue(), { center: [0, 0], radius: [200000, 100000], heading: 330 }, 'el rumbo sale en [0, 360)')

  const finA = llevada(esc, 2, 1, 1)
  arrastrar(esc, 2, [[1, 1]])
  const ia = inverso(ESFERA, [0, 0], finA)

  let v = esc.ed.getValue()
  cerca(v.radius[0], ia.s, 1e-6, 'a')
  cerca(v.heading, ia.azi, 1e-9, 'heading')
  assert.equal(v.radius[1], 100000)

  const finB = llevada(esc, 4, -0.5, 0.6)
  arrastrar(esc, 4, [[-0.5, 0.6]])
  v = esc.ed.getValue()
  cerca(v.radius[1], inverso(ESFERA, [0, 0], finB).s, 1e-6, 'b')
  cerca(v.heading, ia.azi, 1e-9, 'b no gira')

  const otraB = llevada(esc, 4, -1, 1.2)
  arrastrar(esc, 4, [[-1, 1.2]])
  cerca(esc.ed.getValue().radius[1], inverso(ESFERA, [0, 0], otraB).s, 1e-6, 'la manija de b se toma en su eje')

  esc.ed.destroy()
})

test('sector: la punta cambia radio y rumbo, y un borde sólo la apertura, también cruzando el norte', () => {
  const esc = montar({ kind: 'sector', value: { center: [0, 0], radius: 100000, heading: 350, sweep: 60 }, zoom: 10 })

  // El borde derecho está a rumbo 20; se lo lleva a rumbo 10, del mismo lado del norte que la punta no.
  const r       = ESFERA.Direct(0, 0, 10, 100000)
  const destino = [Math.round(r.lat2 * P) / P, Math.round(r.lon2 * P) / P]
  const fin     = llevada(esc, 6, ...destino)
  arrastrar(esc, 6, [destino])
  const { azi } = inverso(ESFERA, [0, 0], fin)

  let v = esc.ed.getValue()
  cerca(v.sweep, 2 * Math.abs((azi - 350 + 540) % 360 - 180), 1e-9, 'sweep = 2·|Δ| envuelto')
  cerca(v.sweep, 40, 1, 'unos 40°')
  assert.deepEqual([v.radius, v.heading], [100000, 350], 'el borde no toca la punta')

  const finT = llevada(esc, 2, 0.5, 0.5)
  arrastrar(esc, 2, [[0.5, 0.5]])
  const it    = inverso(ESFERA, [0, 0], finT)
  const antes = v.sweep
  v = esc.ed.getValue()
  cerca(v.radius, it.s, 1e-6, 'radio')
  cerca(v.heading, it.azi, 1e-9, 'heading')
  assert.equal(v.sweep, antes, 'la punta no abre')

  esc.ed.destroy()
})

test('ningún radio baja de 24 px, ni la apertura acerca la punta a un borde, y por detrás se cierra en 360', () => {
  const circulo = montar({ kind: 'circle', value: { center: [0, 0], radius: 100000 }, zoom: 10 })
  arrastrar(circulo, 2, [[0, 0.01]])
  cerca(circulo.ed.getValue().radius, minimo(10), 1e-6, 'el radio se queda en el mínimo')
  circulo.ed.destroy()

  // La cuerda entre manijas a `min`: la punta a sweep/2 de cada borde. Por detrás, a la cuerda `min` del otro, se cierra.
  const gap    = Math.asin(minimo(10) / 200000) * 180 / Math.PI
  const sector = montar({ kind: 'sector', value: { center: [0, 0], radius: 100000, sweep: 90 }, zoom: 10 })
  const punta  = coordDe(sector, 2)
  arrastrar(sector, 6, [[Math.round(punta[0] * P) / P, 0]])
  cerca(sector.ed.getValue().sweep, 4 * gap, 1e-9, 'el borde sobre la punta')
  arrastrar(sector, 6, [[-0.9, 0]])
  assert.equal(sector.ed.getValue().sweep, 360, 'el borde detrás, sobre el otro, cierra la figura')
  arrastrar(sector, 6, [[0, 0.9]])
  cerca(sector.ed.getValue().sweep, 180, 1, 'y el mismo borde la vuelve a abrir')
  sector.ed.destroy()
})

// La ventana de cierre mide la cuerda `min` (~1° a este radio): un arrastre rápido la salta, de 176° a 183°. El
// puntero cae en píxeles enteros, así que una apertura abierta se compara a 1,5°.
test('el borde que pasa por detrás cierra el sector en 360, y sigue cerrado hasta que vuelve por su lado', () => {
  const esc = montar({ kind: 'sector', value: { center: [0, 0], radius: 100000, heading: 0, sweep: 90 }, zoom: 10 })
  const en  = az => {
    const { lat2, lon2 } = ESFERA.Direct(0, 0, az, 100000)
    return [lat2, lon2]
  }
  const aperturas = []
  tomar(esc, 6)
  for (const az of [110, 150, 170, 176, 183, 195, 250, 200, 183, 176, 170]) {
    mover(esc, ...en(az))
    aperturas.push(esc.ed.getValue().sweep)
  }
  soltar(esc)
  ;[220, 300, 340, 352, 360, 360, 360, 360, 360, 352, 340].forEach((esperada, k) =>
    esperada === 360 ? assert.equal(aperturas[k], 360, `muestra ${k}`) : cerca(aperturas[k], esperada, 1.5, `muestra ${k}`))

  // Un gesto nuevo abre la figura cerrada por cualquiera de sus dos bordes.
  arrastrar(esc, 6, [en(183)])
  assert.equal(esc.ed.getValue().sweep, 360)
  arrastrar(esc, 4, [en(300)])
  cerca(esc.ed.getValue().sweep, 120, 1.5, 'el otro borde, del otro lado, la abre')
  esc.ed.destroy()
})

test('cada editor admite el radio de su forma, y el rumbo y la apertura salen en su rango', () => {
  const valor = (kind, value) => {
    const esc = montar({ kind, value })
    const v   = esc.ed.getValue()
    esc.ed.destroy()
    return v
  }
  assert.equal(valor('circle', { center: [0, 0], radius: [3, 4] }), null, 'el círculo no es una elipse')
  assert.equal(valor('sector', { center: [0, 0], radius: [3, 4], sweep: 90 }), null, 'ni el sector')
  assert.equal(valor('ellipse', { center: [0, 0], radius: 3 }), null, 'ni la elipse un círculo')
  assert.equal(valor('sector', { center: [0, 0], radius: 3, sweep: 0 }), null, 'la apertura es mayor que 0')
  assert.deepEqual(valor('sector', { center: [0, 0], radius: 3, heading: 400, sweep: 90 }),
    { center: [0, 0], radius: 3, heading: 40, sweep: 90 })
  assert.deepEqual(valor('sector', { center: [0, 0], radius: 3, heading: 30, sweep: 500 }),
    { center: [0, 0], radius: 3, heading: 30, sweep: 360 }, 'el sector entero conserva su punta')
  assert.deepEqual(valor('sector', { center: [0, 0], radius: 3 }),
    { center: [0, 0], radius: 3, heading: 0, sweep: 360 }, 'ausentes son norte y figura entera')
})

// Un radio menor que `min` acota `gap` a asin(1/2) = 30°: la apertura no baja de 120, y de 300 se cierra en 360.
test('un sector más chico que el mínimo abre siguiendo al puntero, acotado como en el radio mínimo', () => {
  const esc = montar({ kind: 'sector', value: { center: [0, 0], radius: 50, heading: 0, sweep: 20 }, zoom: 10 })
  assert.ok(50 < minimo(10) / 2, 'ninguna apertura separa sus manijas')
  ;[[[0.1, 0.4], null], [[0.5, 0.1], 120], [[-0.5, -0.05], 360]].forEach(([destino, cota]) => {
    const fin = llevada(esc, 4, ...destino)
    arrastrar(esc, 4, [destino])
    const libre = 2 * Math.abs((inverso(ESFERA, [0, 0], fin).azi + 540) % 360 - 180)
    cerca(esc.ed.getValue().sweep, cota ?? libre, 1e-9, `hacia ${destino}`)
  })
  esc.ed.destroy()
})

// La vista se centra en la forma: un trazo fuera de ella no se dibuja, y una manija sin dibujar no se toma.
test('una forma que alcanzaría un polo no entra, y el arrastre que la llevaría ahí no se aplica ni emite', () => {
  assert.equal(montar({ kind: 'circle', value: { center: [85, 0], radius: 600000 } }).ed.getValue(), null)

  const circulo = montar({ kind: 'circle', value: { center: [80, 0], radius: 500000 }, zoom: 10 })
  circulo.map.animarZoom(10, { lat: 80, lng: 0 }).fire('moveend')
  arrastrar(circulo, 0, [[86, 0]])
  arrastrar(circulo, 2, [[86, 180]])
  assert.deepEqual({ changes: circulo.changes.length, commits: circulo.commits.length }, { changes: 0, commits: 0 })
  assert.deepEqual(circulo.ed.getValue(), { center: [80, 0], radius: 500000 })
  arrastrar(circulo, 0, [[81, 0]])
  assert.deepEqual(circulo.ed.getValue(), { center: [81, 0], radius: 500000 }, 'lejos del polo, el mismo gesto se aplica')
  circulo.ed.destroy()

  // La cota es la del semieje mayor, sea `a` o `b`.
  const elipse = montar({ kind: 'ellipse', value: { center: [80, 0], radius: [100000, 500000], heading: 90 }, zoom: 10 })
  elipse.map.animarZoom(10, { lat: 80, lng: 0 }).fire('moveend')
  arrastrar(elipse, 4, [[86, 180]])
  assert.equal(elipse.changes.length, 0)
  elipse.ed.destroy()
})

test('draw: un click sobre el centro no fija una manija, y el trazado sigue', () => {
  const esc = montar({ kind: 'circle', mode: 'draw', zoom: 10 })
  clickMapa(esc, 0.1, 0.1)
  clickMapa(esc, 0.1, 0.1)
  assert.deepEqual({ changes: esc.changes.length, valor: esc.ed.getValue() }, { changes: 0, valor: null })
  clickMapa(esc, 0.2, 0.1)
  assert.deepEqual(esc.ed.getValue().center, [0.1, 0.1])
  esc.ed.destroy()
})

test('con WGS84 el valor sale del modelo, y el anillo del gesto de la esfera hasta soltar', () => {
  const modelo = contando(WGS84)
  const esc    = montar({ kind: 'circle', value: { center: [0, 0], radius: 30000 }, zoom: 10, model: modelo, geod: ELIPSOIDE })
  const fin    = llevada(esc, 2, 0.3, 0.05)
  tomar(esc, 2)
  modelo.destinos = 0
  mover(esc, 0.3, 0.05)
  assert.equal(modelo.destinos, 1, 'en el frame el modelo sólo ubica la manija')
  const radio = esc.ed.getValue().radius
  cerca(radio, inverso(ELIPSOIDE, [0, 0], fin).s, 1e-6, 'el radio de WGS84')
  assert.ok(Math.abs(radio - inverso(ESFERA, [0, 0], fin).s) > 100, 'y no el de la esfera')

  soltar(esc)
  assert.ok(modelo.destinos > segmentos(radio, 10), 'al soltar, un destino por vértice del anillo')
  esc.ed.destroy()
})

test('el anillo re-tesela cuando el zoom pide otros segmentos, y sólo entonces', () => {
  const modelo = contando(WGS84)
  const esc    = montar({ kind: 'circle', value: { center: [0, 0], radius: 100000 }, zoom: 10, model: modelo, geod: ELIPSOIDE })
  modelo.destinos = 0
  esc.map.fire('moveend')
  assert.equal(modelo.destinos, 0, 'el pan no pide otros segmentos')
  esc.map.setZoomForTest(13)
  esc.map.fire('zoomend')
  assert.notEqual(segmentos(100000, 13), segmentos(100000, 10))
  assert.equal(modelo.destinos, segmentos(100000, 13), 'un destino por vértice del anillo nuevo')
  esc.ed.destroy()
})

test('draw: las formas se trazan por clicks, con vista previa sin emitir y un solo asentado al final', () => {
  const casos = [
    ['circle', [[1, 1], [1.5, 1]], ([c, p]) => ({ center: c, radius: inverso(ESFERA, c, p).s })],
    ['ellipse', [[1, 1], [1.5, 1], [1, 1.3]],
      ([c, p, q]) => ({ center: c, radius: [inverso(ESFERA, c, p).s, inverso(ESFERA, c, q).s], heading: 0 })],
    ['sector', [[1, 1], [1.5, 1], [1.3, 1.3]],
      ([c, p, q]) => ({ center: c, radius: inverso(ESFERA, c, p).s, heading: 0, sweep: 2 * inverso(ESFERA, c, q).azi })],
  ]
  casos.forEach(([kind, clicks, esperado]) => {
    const esc     = montar({ kind, mode: 'draw', zoom: 10 })
    const subidas = () => esc.spy.texImages.length + esc.spy.texSubImages.length
    clicks.slice(0, -1).forEach(([lat, lng]) => {
      clickMapa(esc, lat, lng)
      const antes = subidas()
      mover(esc, lat + 0.2, lng + 0.1)
      assert.ok(subidas() > antes, `${kind}: la vista previa sigue al puntero`)
    })
    assert.deepEqual({ changes: esc.changes.length, valor: esc.ed.getValue() }, { changes: 0, valor: null }, `${kind}: no emite`)

    clickMapa(esc, ...clicks.at(-1))
    assert.deepEqual({ changes: esc.changes.length, commits: esc.commits.length }, { changes: 1, commits: 1 }, kind)
    const v = esc.ed.getValue()
    Object.entries(esperado(clicks)).forEach(([campo, valor]) =>
      [valor].flat().forEach((x, i) => cerca([v[campo]].flat()[i], x, 1e-6, `${kind}.${campo}`)))
    esc.ed.destroy()
  })
})

test('draw: el rectángulo también tiene vista previa, y salir del trazado lo descarta', () => {
  const esc     = montar({ kind: 'rectangle', mode: 'draw' })
  const subidas = () => esc.spy.texImages.length + esc.spy.texSubImages.length
  clickMapa(esc, 0, 0)
  const antes = subidas()
  mover(esc, 2, 3)
  assert.ok(subidas() > antes, 'la vista previa sigue al puntero')
  assert.deepEqual({ changes: esc.changes.length, valor: esc.ed.getValue() }, { changes: 0, valor: null })

  esc.ed.setMode('edit')
  esc.ed.setMode('draw')
  clickMapa(esc, 5, 5)
  assert.equal(esc.changes.length, 0, 'el click después de salir empieza otro rectángulo')
  clickMapa(esc, 6, 7)
  assert.deepEqual(esc.ed.getValue(), [[5, 5], [6, 7]])
  esc.ed.destroy()
})

// El arrastre de una forma no cambia el conteo de su anillo: mueve sus vértices y sube sus chunks, sin re-ingerir.
test('el anillo sigue al arrastre con sus tramos congelados: escribe rangos y no re-ingiere', () => {
  const esc        = montar({ kind: 'sector', value: { center: [0, 0], radius: 30000, heading: 0, sweep: 60 }, zoom: 10 })
  const ingestas   = () => esc.spy.texImages.length + esc.spy.bufferDatas.length
  const escrituras = () => esc.spy.texSubImages.length + esc.spy.bufferSubDatas.length
  tomar(esc, 6)
  const antes = { ingestas: ingestas(), escrituras: escrituras() }
  ;[[0.2, 0.25], [0.1, 0.3], [0, 0.3], [-0.1, 0.25]].forEach(([lat, lng]) => mover(esc, lat, lng))
  assert.equal(esc.changes.length, 4, 'cada frame abrió el sector')
  assert.equal(ingestas(), antes.ingestas, 'ningún frame re-ingiere')
  assert.ok(escrituras() > antes.escrituras, 'los frames suben rangos')
  soltar(esc)
  esc.ed.destroy()

  // El sector entero es un círculo: abrirlo cambia el conteo en el primer frame, y sólo ése re-ingiere.
  const entero = montar({ kind: 'sector', value: { center: [0, 0], radius: 30000, sweep: 360 }, zoom: 10 })
  const pasos  = () => entero.spy.texImages.length + entero.spy.bufferDatas.length
  tomar(entero, 4)
  const previo = pasos()
  mover(entero, 0.1, 0.2)
  const abierto = pasos()
  assert.ok(abierto > previo, 'el primer frame rehace el anillo')
  ;[[0.2, 0.1], [0.25, 0]].forEach(([lat, lng]) => mover(entero, lat, lng))
  assert.equal(pasos(), abierto, 'los siguientes ya no')
  assert.ok(entero.ed.getValue().sweep < 360)
  soltar(entero)
  entero.ed.destroy()
})

// El relleno y el trazo de una forma leen su anillo, y el vértice del gesto es una manija: si les llegara,
// partirían el anillo en un vértice ajeno.
test('el gesto de una forma no promueve ni arrastra un vértice del anillo: el frame dibuja lo de uno quieto', () => {
  const esc       = montar({ kind: 'ellipse', value: { center: [0, 0], radius: [1500000, 800000] } })
  const contornos = antes => esc.spy.draws.slice(antes).filter(d => d.mode !== glVigente.POINTS).length
  let antes = esc.spy.draws.length
  esc.ed.setStyle({})
  const quieto = contornos(antes)

  tomar(esc, 4)
  antes = esc.spy.draws.length
  mover(esc, -0.1, 7.3)
  assert.equal(esc.changes.length, 1)
  assert.equal(contornos(antes), quieto, 'los draws del relleno y del trazo, sin los de las manijas')
  soltar(esc)
  esc.ed.destroy()
})

test('soltar una forma libera también el arena de su anillo', () => {
  const sobrante = kind => {
    const cuentas = {}
    montar({ kind, value: kind === 'point' ? [0, 0] : { center: [0, 0], radius: 100000 }, zoom: 10, cuentas }).ed.destroy()
    return [cuentas.createTexture - cuentas.deleteTexture, cuentas.createBuffer - (cuentas.deleteBuffer ?? 0)]
  }
  assert.deepEqual(sobrante('circle'), sobrante('point'))
})

// La proyección del arena en su fórmula cerrada: EPSG:3857 en world0, 256 unidades por vuelta.
const mercator = (lat, lng) => {
  const sin = Math.sin(lat * Math.PI / 180)
  return [256 * (lng / 360 + 0.5), 256 * (0.5 - 0.25 / Math.PI * Math.log((1 + sin) / (1 - sin)))]
}

// Un círculo entero como lo dibuja el contorno: `n` vértices desde el norte en sentido horario, a `r` metros
// del centro sobre `geod`, en world0 y relativos al vértice 0.
const anilloDe = (geod, [lat, lng], r, n) => {
  const xy = Array.from({ length: n }, (_, i) => {
    const d = geod.Direct(lat, lng, i * 360 / n, r, LATITUDE | LONGITUDE | LONG_UNROLL)
    return mercator(d.lat2, d.lon2)
  })
  return xy.map(([x, y]) => [x - xy[0][0], y - xy[0][1]])
}

// El anillo que subió la última re-ingesta, la del contorno, relativo a su vértice 0: la ingesta pone el
// vértice `i` en el ref 2i, y la textura guarda [x, y] por ref. Las que suben sin datos son del atlas de iconos.
const anilloSubido = (esc, n) => {
  const t = esc.spy.texels.findLast(Boolean)
  return Array.from({ length: n }, (_, i) => [t[4 * i] - t[0], t[4 * i + 1] - t[1]])
}

const mismoAnillo = (real, esperado, msg) =>
  real.forEach(([x, y], i) => assert.ok(Math.hypot(x - esperado[i][0], y - esperado[i][1]) < 1e-6, `${msg}: vértice ${i}`))

test('setValue, soltar y el zoom suben al contorno el anillo del modelo, desde el norte', () => {
  const esc = montar({ kind: 'circle', value: { center: [0, 0], radius: 30000 }, zoom: 10, model: WGS84, geod: ELIPSOIDE })
  esc.ed.setValue({ center: [0, 1], radius: 50000 })
  mismoAnillo(anilloSubido(esc, segmentos(50000, 10)), anilloDe(ELIPSOIDE, [0, 1], 50000, segmentos(50000, 10)), 'setValue')

  // La manija queda donde se soltó, y el anillo no la sigue: el círculo no lee su rumbo.
  arrastrar(esc, 2, [[0.3, 1.05]])
  const r = esc.ed.getValue().radius
  mismoAnillo(anilloSubido(esc, segmentos(r, 10)), anilloDe(ELIPSOIDE, [0, 1], r, segmentos(r, 10)), 'al soltar')

  esc.map.setZoomForTest(13)
  esc.map.fire('zoomend')
  assert.notEqual(segmentos(r, 13), segmentos(r, 10))
  mismoAnillo(anilloSubido(esc, segmentos(r, 13)), anilloDe(ELIPSOIDE, [0, 1], r, segmentos(r, 13)), 'el zoom')
  esc.ed.destroy()
})

test('el borrador de una forma se dibuja con la esfera, y salir del trazado devuelve el contorno al valor', () => {
  const modelo = contando(WGS84)
  const esc    = montar({ kind: 'circle', value: { center: [0, 0], radius: 30000 }, mode: 'draw', zoom: 10, model: modelo, geod: ELIPSOIDE })
  modelo.destinos = 0
  clickMapa(esc, 1, 1)
  mover(esc, 1.2, 1.1)
  esc.map.setZoomForTest(13)
  esc.map.fire('zoomend')
  assert.equal(modelo.destinos, 0, 'ni el click, ni la vista previa, ni el zoom llaman al modelo')

  esc.ed.setMode('edit')
  mismoAnillo(anilloSubido(esc, segmentos(30000, 13)), anilloDe(ELIPSOIDE, [0, 0], 30000, segmentos(30000, 13)), 'el valor')
  assert.equal(esc.changes.length, 0)
  esc.ed.destroy()
})

// Cerrarse en 360 y volver a abrirse cambian el conteo del anillo, dentro del gesto o al empezar otro.
test('el sector que se cierra y se abre arrastrando dibuja el mismo anillo que sube al soltar', () => {
  const esc = montar({ kind: 'sector', value: { center: [0, 0], radius: 100000, heading: 0, sweep: 90 }, zoom: 10 })
  const en  = az => {
    const { lat2, lon2 } = ESFERA.Direct(0, 0, az, 100000)
    return [lat2, lon2]
  }
  const ultimo = () => esc.spy.texels.findLast(Boolean).slice()
  const n      = segmentos(100000, 10)

  tomar(esc, 6)
  for (const az of [150, 183]) mover(esc, ...en(az))
  assert.equal(esc.ed.getValue().sweep, 360)
  mismoAnillo(anilloSubido(esc, n), anilloDe(ESFERA, [0, 0], 100000, n), 'cerrado, el círculo')
  mover(esc, ...en(150))
  const abierto = ultimo()
  soltar(esc)
  assert.deepEqual(abierto, ultimo(), 'abierto de nuevo, el sector')

  arrastrar(esc, 6, [en(183)])
  tomar(esc, 4)
  mover(esc, ...en(300))
  const otro = ultimo()
  soltar(esc)
  assert.ok(esc.ed.getValue().sweep < 360)
  assert.deepEqual(otro, ultimo(), 'el gesto siguiente lo abre desde el círculo')
  esc.ed.destroy()
})

/* ── Mano alzada: el dedo traza y al soltar el trazo se hornea ── */

// El dedo apoyado en el primer punto, en píxeles del contenedor, y recorre el resto sin levantarse. El
// harness proyecta lineal: el píxel (x, y) es la coordenada [y / P, x / P].
const apoyar = (esc, [x, y]) => emitir(esc, 'pointerdown', x, y)
const recorrer = (esc, puntos) => puntos.forEach(([x, y]) => emitir(esc, 'pointermove', x, y))
const levantar = (esc, [x, y]) => emitir(esc, 'pointerup', x, y)

// Un cuarto de circunferencia de 200 px de radio con una muestra cada 5°: la mano trazando una curva.
const CUARTO = Array.from({ length: 19 }, (_, i) => [300 + 200 * Math.cos(i * Math.PI / 36), 400 - 200 * Math.sin(i * Math.PI / 36)])

test('freehand en una polilínea: el dedo traza, cada muestra emite el trazo crudo y soltar hornea un solo commit', () => {
  const previo = [[0, 0], [0, 1]]
  const esc    = montar({ kind: 'polyline', value: previo, mode: 'freehand' })

  apoyar(esc, CUARTO[0])
  assert.equal(esc.dragging.activo, false, 'el trazo es del editor: el mapa no panea')
  assert.equal(esc.changes.length, 0, 'una sola muestra no es todavía un trazo')
  recorrer(esc, CUARTO.slice(1))

  assert.equal(esc.changes.length, 18, 'un change por muestra desde la segunda')
  assert.deepEqual(esc.changes[0].slice(0, 2), previo, 'la polilínea se continúa: lo anterior queda')
  assert.deepEqual(esc.changes.map(c => c.length), Array.from({ length: 18 }, (_, i) => 4 + i), 'el trazo crudo crece de a una')
  assert.equal(esc.commits.length, 0, 'sin commit mientras dura')
  assert.deepEqual(esc.informes, [], 'el cursor no es del editor: no se informa HANDLE_HELD')

  const ingestas = () => esc.spy.texImages.length + esc.spy.bufferDatas.length
  const antes    = ingestas()
  levantar(esc, CUARTO.at(-1))
  const final = esc.ed.getValue()

  assert.ok(ingestas() > antes, 'el horneado re-ingiere el espejo GPU del trazo')
  assert.equal(esc.dragging.activo, true, 'soltar devuelve el arrastre')
  assert.deepEqual(esc.commits, [final], 'un solo commit, con lo horneado')
  assert.deepEqual(esc.changes.at(-1), final)
  assert.deepEqual(final.slice(0, 2), previo)
  const trazo = final.slice(2)
  assert.ok(trazo.length > 2 && trazo.length < CUARTO.length, `simplificado: ${trazo.length} vértices de ${CUARTO.length} muestras`)
  assert.ok(Math.abs(trazo[0][0] - 4) < 1e-9 && Math.abs(trazo[0][1] - 5) < 1e-9, 'arranca donde se apoyó el dedo')
  trazo.forEach(([lat, lng]) =>
    assert.ok(Math.abs(Math.hypot(lng * P - 300, lat * P - 400) - 200) < 1.5, `el vértice ${lat},${lng} está sobre el arco`))

  esc.ed.destroy()
})

test('freehand: un toque sin recorrido no crea trazo ni quita el valor, y no es un click del mapa', () => {
  const esc = montar({ kind: 'polygon', value: SQUARE, mode: 'freehand' })

  apoyar(esc, [50, 50])
  recorrer(esc, [[52, 51], [50, 53]])
  levantar(esc, [50, 50])

  assert.deepEqual(
    { valor: esc.ed.getValue(), changes: esc.changes.length, commits: esc.commits.length, alMapa: esc.alMapa.length, arrastre: esc.dragging.activo },
    { valor: SQUARE, changes: 0, commits: 0, alMapa: 0, arrastre: true },
  )

  esc.ed.destroy()
})

test('freehand: mientras la cámara se mueve no se muestrea, y al retomar la primera muestra entra aunque esté cerca', () => {
  const esc = montar({ kind: 'polyline', value: [], mode: 'freehand' })

  apoyar(esc, [0, 0])
  recorrer(esc, [[10, 0], [20, 0]])
  esc.map.fire('movestart')
  recorrer(esc, [[30, 0], [40, 0]])
  assert.equal(esc.changes.length, 2, 'en pausa no hay muestras')
  esc.map.fire('moveend')
  recorrer(esc, [[21, 0]])

  assert.deepEqual(esc.changes.at(-1), [[0, 0], [0, 0.1], [0, 0.2], [0, 0.21]], 'queda una cuerda recta hasta la muestra que retoma')
  levantar(esc, [21, 0])

  esc.ed.destroy()
})

test('freehand: zoomstart pausa igual que movestart', () => {
  const esc = montar({ kind: 'polyline', value: [], mode: 'freehand' })

  apoyar(esc, [0, 0])
  recorrer(esc, [[10, 0]])
  esc.map.fire('zoomstart')
  recorrer(esc, [[30, 0]])
  esc.map.fire('zoomend')

  assert.equal(esc.changes.length, 1)
  levantar(esc, [10, 0])
  esc.ed.destroy()
})

test('freehand: pointercancel descarta el trazo, devuelve el valor de antes y no asienta', () => {
  const previo = [[[0, 0], [0, 10], [10, 10]], [[20, 20], [20, 30], [30, 30]]]
  const esc    = montar({ kind: 'polygon', value: previo, mode: 'freehand' })

  apoyar(esc, [0, 0])
  recorrer(esc, [[100, 0], [100, 100], [0, 100]])
  assert.equal(esc.ed.getValue().length, 4, 'mientras dura, el valor es el trazo')
  emitir(esc, 'pointercancel', 0, 100)

  assert.deepEqual(esc.ed.getValue(), previo)
  assert.deepEqual(esc.changes.at(-1), previo, 'el consumidor ve volver el valor')
  assert.equal(esc.commits.length, 0)
  assert.equal(esc.ed.paths.length, 2, 'los dos anillos otra vez')
  assert.equal(esc.dragging.activo, true)

  esc.ed.destroy()
})

test('freehand en un polígono: el lazo reemplaza el valor entero por un anillo simple, con las esquinas', () => {
  const esc  = montar({ kind: 'polygon', value: [[[0, 0], [0, 10], [10, 10]], [[20, 20], [20, 30], [30, 30]]], mode: 'freehand' })
  const lado = (de, a) => Array.from({ length: 20 }, (_, i) => [de[0] + (a[0] - de[0]) * (i + 1) / 20, de[1] + (a[1] - de[1]) * (i + 1) / 20])

  apoyar(esc, [0, 0])
  recorrer(esc, [...lado([0, 0], [200, 0]), ...lado([200, 0], [200, 200]), ...lado([200, 200], [0, 200]), ...lado([0, 200], [0, 10])])
  levantar(esc, [0, 10])
  const valor = esc.ed.getValue()

  assert.ok(valor.every(p => typeof p[0] === 'number'), 'un anillo simple, no multi-anillo')
  assert.equal(esc.ed.paths.length, 1)
  assert.equal(esc.commits.length, 1)
  ;[[0, 0], [0, 2], [2, 2], [2, 0]].forEach(esquina =>
    assert.ok(valor.some(p => p[0] === esquina[0] && p[1] === esquina[1]), `esquina ${esquina}`))

  esc.ed.destroy()
})

test('freehand: un lazo que no encierra área se descarta como un cancel', () => {
  const esc = montar({ kind: 'polygon', value: SQUARE, mode: 'freehand' })

  apoyar(esc, [0, 0])
  recorrer(esc, Array.from({ length: 20 }, (_, i) => [10 * (i + 1), 0]))
  levantar(esc, [200, 0])

  assert.deepEqual(
    { valor: esc.ed.getValue(), commits: esc.commits.length, ultimo: esc.changes.at(-1), arrastre: esc.dragging.activo },
    { valor: SQUARE, commits: 0, ultimo: SQUARE, arrastre: true },
  )

  esc.ed.destroy()
})

test('freehand: setMode, setCurve, setValue o destroy a mitad del trazo devuelven el arrastre y no asientan', () => {
  const previo = [[0, 0], [0, 1]]
  const otro   = [[5, 5], [5, 6]]
  // El último `change` es lo que el consumidor cree que vale: tras setMode y setCurve, el valor de antes;
  // setValue y destroy no emiten, y queda el crudo.
  const corte  = [
    ['setMode', esc => esc.ed.setMode('edit'), previo, previo],
    ['setCurve', esc => esc.ed.setCurve(byDefault), previo, previo],
    ['setValue', esc => esc.ed.setValue(otro), otro, 'crudo'],
    ['destroy', esc => esc.ed.destroy(), previo, 'crudo'],
  ]
  corte.forEach(([nombre, cortar, valor, ultimo]) => {
    const esc = montar({ kind: 'polyline', value: previo, mode: 'freehand' })

    apoyar(esc, [200, 200])
    recorrer(esc, [[210, 200], [220, 200]])
    const crudo = esc.changes.at(-1)
    assert.equal(esc.dragging.activo, false)
    cortar(esc)
    levantar(esc, [220, 200])

    assert.deepEqual(
      { arrastre: esc.dragging.activo, commits: esc.commits.length, valor: esc.ed.getValue(), ultimo: esc.changes.at(-1) },
      { arrastre: true, commits: 0, valor, ultimo: ultimo === 'crudo' ? crudo : ultimo },
      nombre,
    )
    esc.ed.destroy()
  })
})

test('freehand: un onChange que pasa a edit en la primera muestra deja al consumidor con el valor de antes', () => {
  const esc = montar({ kind: 'polygon', value: SQUARE, mode: 'freehand', alCambiar: ed => ed.setMode('edit') })

  apoyar(esc, [0, 0])
  recorrer(esc, [[100, 0], [100, 100]])

  assert.deepEqual(
    { valor: esc.ed.getValue(), ultimo: esc.changes.at(-1), arrastre: esc.dragging.activo },
    { valor: SQUARE, ultimo: SQUARE, arrastre: true },
  )
  esc.ed.destroy()
})

test('freehand en una polilínea sin valor traza desde cero', () => {
  const esc = montar({ kind: 'polyline', value: null, mode: 'freehand' })

  apoyar(esc, [0, 0])
  recorrer(esc, [[100, 0], [200, 100], [300, 100]])
  levantar(esc, [300, 100])

  assert.equal(esc.commits.length, 1)
  assert.deepEqual(esc.ed.getValue()[0], [0, 0])
  assert.deepEqual(esc.ed.getValue().at(-1), [1, 3])

  esc.ed.destroy()
})

test('freehand queda inerte en los demás kinds: el puntero es del mapa', () => {
  const inertes = ['rectangle', 'point', ...FORMAS]
  inertes.forEach(kind => {
    const esc = montar({ kind, value: null, mode: 'freehand' })

    const apretada = apoyar(vaciar(esc), [100, 100])
    recorrer(esc, [[120, 100], [150, 130]])
    levantar(esc, [150, 130])

    assert.deepEqual(
      { cortado: apretada.cortado, arrastre: esc.dragging.activo, changes: esc.changes.length, commits: esc.commits.length },
      { cortado: false, arrastre: true, changes: 0, commits: 0 },
      kind,
    )
    esc.ed.destroy()
  })
})

test('freehand: el doble click no se consume, así que el mapa hace zoom', () => {
  const esc = montar({ kind: 'polygon', value: SQUARE, mode: 'freehand' })

  assert.equal(dobleMapa(esc, 5, 5).cortado, false)
  assert.deepEqual(esc.ed.getValue(), SQUARE)

  esc.ed.destroy()
})

/* ── Curva geodésica: el contorno de polígono y polilínea sobre la geodésica del modelo ── */

// El contorno curvo se lee del espejo GPU: la última ingesta y, encima, las escrituras parciales desde la
// subida número `desde`. La ingesta llena cada chunk hasta un cuarto de su capacidad, así que el punto `k`
// vive en el ref ⌊k / por⌋·cap + 2·(k mod por). Devuelve el punto `k` en world0, relativo al punto 0.
const contornoSubido = (esc, desde = esc.spy.texSubImages.length) => {
  const spy   = esc.spy
  const i     = spy.texels.findLastIndex(Boolean)
  const t     = spy.texels[i].slice()
  const ancho = spy.texImages[i].width
  for (let s = desde; s < spy.texSubImages.length; s++) {
    const { x, y } = spy.texSubImages[s]
    t.set(spy.texSubTexels[s], (y * ancho + x) * 2)
  }
  const cap = esc.ed.paths[0].entriesPerChunk
  const por = cap >> 2
  return k => {
    const ref = Math.floor(k / por) * cap + k % por * 2
    return [t[2 * ref] - t[0], t[2 * ref + 1] - t[1]]
  }
}

const TOL = 1e-5   // px de world0, ~1,5 m: lo que conserva un float32 relativo al ancla

const juntos = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < TOL

// Un [lat, lng] en world0 relativo a `origen`, y de vuelta.
const relativo = (origen, [lat, lng]) => {
  const [x, y] = mercator(lat, lng), [x0, y0] = mercator(origen[0], origen[1])
  return [x - x0, y - y0]
}
const lugarDe = (origen, [x, y]) => {
  const [x0, y0] = mercator(origen[0], origen[1])
  return [Math.atan(Math.sinh(Math.PI * (1 - (y + y0) / 128))) * 180 / Math.PI, (x + x0) / 256 * 360 - 180]
}

// El tramo de `a` a `b` que arranca en el punto `o` del contorno: el punto `o` es `a` y los intermedios caen
// a fracciones iguales de la geodésica de `geod`. Cuántos segmentos son lo dice el primero, por su distancia
// a `a`; es lo que devuelve, y un tramo largo tiene que partirse (`partido`): si no, un contorno que no se
// curvó pasaría sin puntos que medir.
const tramoCurvo = (c, o, a, b, geod, origen, msg, partido = true) => {
  assert.ok(juntos(c(o), relativo(origen, a)), `${msg}: arranca en su vértice`)
  const total = geod.Inverse(a[0], a[1], b[0], b[1])
  const p     = lugarDe(origen, c(o + 1))
  const m     = Math.round(total.s12 / geod.Inverse(a[0], a[1], p[0], p[1]).s12)
  assert.ok(m >= 1 && (!partido || m > 1), `${msg}: ${m} segmentos`)
  for (let k = 1; k < m; k++) {
    const d = geod.Direct(a[0], a[1], total.azi1, k / m * total.s12, LATITUDE | LONGITUDE | LONG_UNROLL)
    assert.ok(juntos(c(o + k), relativo(origen, [d.lat2, d.lon2])), `${msg}: punto ${k} de ${m}`)
  }
  return m
}

// El tramo medido sobre `geod` NO es el del contorno: falla en algún punto.
const fuera = (c, o, a, b, geod, origen) => assert.throws(() => tramoCurvo(c, o, a, b, geod, origen, ''), assert.AssertionError)

// El punto medio de la geodésica de `a` a `b`.
const medioDe = (geod, a, b) => {
  const r = geod.Inverse(a[0], a[1], b[0], b[1])
  const d = geod.Direct(a[0], a[1], r.azi1, r.s12 / 2, LATITUDE | LONGITUDE | LONG_UNROLL)
  return [d.lat2, d.lon2]
}

const TRIANGULO = [[40, 1], [40, 3], [41, 2]]
const GRANDE    = [[40, -10], [40, 10], [50, 0]]   // ~2 000 puntos de contorno: dos chunks

test('con curva, el contorno parte cada tramo sobre la geodésica, también el cierre, y las manijas son los vértices del valor', () => {
  const esc       = montar({ kind: 'polygon', value: TRIANGULO })
  const [a, b, d] = TRIANGULO
  esc.ed.setCurve(byDefault)
  const c  = contornoSubido(esc)
  const ab = tramoCurvo(c, 0, a, b, ESFERA, a, 'a → b')
  const bd = tramoCurvo(c, ab, b, d, ESFERA, a, 'b → c')
  tramoCurvo(c, ab + bd, d, a, ESFERA, a, 'el cierre')

  assert.equal(esc.ed.paths[0].length, 3, 'las manijas son los tres vértices')
  assert.deepEqual(esc.ed.getValue(), TRIANGULO)
  assert.deepEqual([esc.changes.length, esc.commits.length], [0, 0], 'curvar no es una edición')
  esc.ed.destroy()
})

test('el midpoint de un tramo curvo cae sobre la geodésica del modelo, y pulsarlo inserta ahí el vértice', () => {
  const valor = [[40, -10], [40, 10], [10, 170], [10, -170]]
  const esc   = montar({ kind: 'polyline', value: valor })
  esc.ed.setCurve(WGS84)
  const path       = esc.ed.paths[0]
  const [v0, , v2] = refsDe(path)
  const medio      = medioDe(ELIPSOIDE, valor[0], valor[1])

  cerca(midDe(path, v0)[0], medio[0], 1e-9, 'lat del midpoint')
  cerca(midDe(path, v0)[1], medio[1], 1e-9, 'lng del midpoint')
  assert.ok(Math.abs(midDe(path, v0)[0] - medioDe(ESFERA, valor[0], valor[1])[0]) > 1e-4, 'del modelo, no de la esfera')
  assert.deepEqual(midDe(path, v2), [10, 0], 'el tramo de más de media vuelta no se curva: su midpoint es el promedio')

  tomar(esc, path.midOf(v0))
  soltar(esc)
  cerca(esc.ed.getValue()[1][0], medio[0], 1e-9, 'el vértice insertado')
  cerca(esc.ed.getValue()[1][1], medio[1], 1e-9, 'el vértice insertado')
  const c     = contornoSubido(esc)
  const hasta = tramoCurvo(c, 0, valor[0], medio, ELIPSOIDE, valor[0], 'hasta el insertado')
  tramoCurvo(c, hasta, medio, valor[1], ELIPSOIDE, valor[0], 'desde el insertado')
  esc.ed.destroy()
})

test('el gesto reescribe sólo los dos tramos del vértice, con la esfera y sus segmentos congelados; soltar los rehace con el modelo', () => {
  const esc       = montar({ kind: 'polygon', value: GRANDE })
  const spy       = esc.spy
  const [a, b, d] = GRANDE
  const ingestas  = () => spy.texImages.length + spy.bufferDatas.length
  esc.ed.setCurve(WGS84)
  const path = esc.ed.paths[0]
  const c0   = contornoSubido(esc)
  const ab   = tramoCurvo(c0, 0, a, b, ELIPSOIDE, a, 'a → b')
  const bd   = tramoCurvo(c0, ab, b, d, ELIPSOIDE, a, 'b → c')
  const da   = tramoCurvo(c0, ab + bd, d, a, ELIPSOIDE, a, 'c → a')

  const antes   = ingestas()
  const subidas = spy.texSubImages.length
  const verts   = spy.bufferSubDatas.length
  tomar(esc, refsDe(path)[1])
  mover(esc, 45, 12)
  const b2 = esc.ed.getValue()[1]
  const c1 = contornoSubido(esc, subidas)
  assert.notDeepEqual(b2, b, 'el vértice se movió')

  assert.equal(ingestas(), antes, 'el frame no re-ingiere')
  assert.equal(tramoCurvo(c1, 0, a, b2, ESFERA, a, 'gesto a → b'), ab, 'con los segmentos de antes')
  assert.equal(tramoCurvo(c1, ab, b2, d, ESFERA, a, 'gesto b → c'), bd)
  assert.equal(tramoCurvo(c1, ab + bd, d, a, ELIPSOIDE, a, 'el tramo que no toca'), da)
  fuera(c1, 0, a, b2, ELIPSOIDE, a)
  const enviadas = spy.bufferSubDatas.slice(verts).reduce((n, s) => n + s.length, 0) / FLOATS_POR_ENTRADA
  assert.equal(enviadas, 2 * (ab + bd), 'sube los puntos de los dos tramos con sus midpoints, y nada más')

  soltar(esc)
  const c2  = contornoSubido(esc)
  const ab2 = tramoCurvo(c2, 0, a, b2, ELIPSOIDE, a, 'al soltar a → b')
  const v1  = refsDe(path)[1]
  ;[[midDe(path, path.prevVertex(v1)), medioDe(ELIPSOIDE, a, b2)], [midDe(path, v1), medioDe(ELIPSOIDE, b2, d)]].forEach(([real, esperado], i) =>
    real.forEach((x, j) => cerca(x, esperado[j], 1e-9, `al soltar, el midpoint ${i} sobre el modelo`)))
  assert.ok(ingestas() > antes, 'soltar re-ingiere el contorno')
  assert.notEqual(ab2, ab, 'con la cuenta del tramo nuevo')
  const bd2 = tramoCurvo(c2, ab2, b2, d, ELIPSOIDE, a, 'al soltar b → c')

  // El vértice 0: su tramo de llegada es el del cierre, que cruza del último chunk al primero.
  const subidas2 = spy.texSubImages.length
  tomar(esc, refsDe(path)[0])
  mover(esc, 41, -11)
  const a2 = esc.ed.getValue()[0]
  const c3 = contornoSubido(esc, subidas2)
  assert.notDeepEqual(a2, a, 'el vértice se movió')
  assert.equal(tramoCurvo(c3, 0, a2, b2, ESFERA, a2, 'gesto a → b'), ab2)
  assert.equal(tramoCurvo(c3, ab2, b2, d, ELIPSOIDE, a2, 'el tramo que no toca'), bd2)
  assert.equal(tramoCurvo(c3, ab2 + bd2, d, a2, ESFERA, a2, 'gesto en el cierre'), da)
  soltar(esc)
  esc.ed.destroy()
})

test('en un anillo de un chunk, el gesto sobre el vértice 0 sube su tramo de llegada, que da la vuelta', () => {
  const esc       = montar({ kind: 'polygon', value: TRIANGULO })
  const [a, b, d] = TRIANGULO
  esc.ed.setCurve(byDefault)
  const c0 = contornoSubido(esc)
  const ab = tramoCurvo(c0, 0, a, b, ESFERA, a, 'a → b')
  const bd = tramoCurvo(c0, ab, b, d, ESFERA, a, 'b → c')
  const da = tramoCurvo(c0, ab + bd, d, a, ESFERA, a, 'c → a')

  const subidas = esc.spy.texSubImages.length
  tomar(esc, refsDe(esc.ed.paths[0])[0])
  mover(esc, 39.5, 0.5)
  const a2 = esc.ed.getValue()[0]
  const c1 = contornoSubido(esc, subidas)
  assert.notDeepEqual(a2, a, 'el vértice se movió')
  assert.equal(tramoCurvo(c1, 0, a2, b, ESFERA, a2, 'gesto a → b'), ab)
  assert.equal(tramoCurvo(c1, ab + bd, d, a2, ESFERA, a2, 'gesto c → a'), da)
  soltar(esc)
  esc.ed.destroy()
})

test('un tramo que el gesto lleva a más de media vuelta de longitud, o a extremos que se juntan, va por la recta de Mercator', () => {
  const valor = [[10, 150], [10, 175], [20, 160]]
  const esc   = montar({ kind: 'polyline', value: valor })
  const spy   = esc.spy
  esc.ed.setCurve(byDefault)
  const m = tramoCurvo(contornoSubido(esc), 0, valor[0], valor[1], ESFERA, valor[0], 'antes del gesto')

  const subidas = spy.texSubImages.length
  tomar(esc, refsDe(esc.ed.paths[0])[1])
  mover(esc, 30, 340)
  const c      = contornoSubido(esc, subidas)
  const [x, y] = relativo(valor[0], [30, 340])
  for (let k = 1; k <= m; k++)
    assert.ok(juntos(c(k), [k / m * x, k / m * y]), `media vuelta: punto ${k} de ${m} sobre la recta`)

  const subidas2 = spy.texSubImages.length
  mover(esc, ...valor[0])
  const c2 = contornoSubido(esc, subidas2)
  assert.ok(spy.texSubTexels.slice(subidas2).every(t => t.every(v => !Number.isNaN(v))), 'sin NaN')
  for (let k = 1; k <= m; k++)
    assert.ok(juntos(c2(k), [0, 0]), `sobre el vecino: punto ${k} de ${m} en el vértice`)
  soltar(esc)
  esc.ed.destroy()
})

test('el frame del gesto y las muestras de la mano alzada no llaman al modelo; soltar y hornear sí', () => {
  const llamadas = { n: 0 }
  const modelo   = Object.fromEntries([MODEL, HEADING, DESTINATION].map(marca => [marca, (...args) => {
    llamadas.n++
    return WGS84[marca](...args)
  }]))
  const esc = montar({ kind: 'polygon', value: GRANDE })
  esc.ed.setCurve(modelo)
  tomar(esc, refsDe(esc.ed.paths[0])[1])
  llamadas.n = 0
  ;[[45, 12], [46, 14], [44, 9]].forEach(([lat, lng]) => mover(esc, lat, lng))
  assert.equal(llamadas.n, 0, 'el gesto escribe con la esfera')
  soltar(esc)
  assert.ok(llamadas.n > 0, 'soltar rehace la curva con el modelo')
  esc.ed.destroy()

  const mano = montar({ kind: 'polyline', value: [[2, 0], [2, 2]], mode: 'freehand' })
  mano.ed.setCurve(modelo)
  apoyar(mano, CUARTO[0])
  llamadas.n = 0
  recorrer(mano, CUARTO.slice(1))
  assert.equal(llamadas.n, 0, 'cada muestra curva con la esfera')
  levantar(mano, CUARTO.at(-1))
  assert.ok(llamadas.n > 0, 'hornear curva con el modelo')
  mano.ed.destroy()
})

test('setValue con curva curva el valor nuevo', () => {
  const esc = montar({ kind: 'polygon', value: TRIANGULO })
  esc.ed.setCurve(byDefault)
  esc.ed.setValue([[50, 0], [50, 3], [52, 1]])
  const c  = contornoSubido(esc)
  const ab = tramoCurvo(c, 0, [50, 0], [50, 3], ESFERA, [50, 0], 'a → b')
  tramoCurvo(c, ab, [50, 3], [52, 1], ESFERA, [50, 0], 'b → c')
  esc.ed.destroy()
})

test('setCurve a mitad del gesto lo suelta sin asentar, como setValue', () => {
  const esc = montar({ kind: 'polygon', value: SQUARE })
  tomar(esc, refsDe(esc.ed.paths[0])[1])
  mover(esc, 5, 20)
  esc.ed.setCurve(byDefault)

  assert.deepEqual(
    { arrastre: esc.dragging.activo, commits: esc.commits.length, informes: esc.informes, valor: esc.ed.getValue()[1] },
    { arrastre: true, commits: 0, informes: [HANDLE_OVER, HANDLE_HELD, HANDLE_NONE], valor: [5, 20] },
  )
  esc.ed.destroy()
})

test('borrar y agregar vértices rehacen el contorno curvo', () => {
  const esc = montar({ kind: 'polyline', value: [[60, 0], [60, 2]] })
  esc.ed.setCurve(byDefault)
  esc.ed.setMode('draw')
  clickMapa(esc, 61, 3)
  let c       = contornoSubido(esc)
  const antes = tramoCurvo(c, 0, [60, 0], [60, 2], ESFERA, [60, 0], 'el de antes')
  tramoCurvo(c, antes, [60, 2], [61, 3], ESFERA, [60, 0], 'el agregado')

  esc.ed.setMode('edit')
  doble(esc, refsDe(esc.ed.paths[0])[1])
  assert.deepEqual(esc.ed.getValue(), [[60, 0], [61, 3]])
  c = contornoSubido(esc)
  tramoCurvo(c, 0, [60, 0], [61, 3], ESFERA, [60, 0], 'el que queda')
  esc.ed.destroy()
})

test('el trazo a mano alzada se hornea sobre la curva', () => {
  const esc = montar({ kind: 'polyline', value: [[2, 0], [2, 2]], mode: 'freehand' })
  esc.ed.setCurve(byDefault)
  apoyar(esc, CUARTO[0])
  recorrer(esc, CUARTO.slice(1))
  levantar(esc, CUARTO.at(-1))

  const valor = esc.ed.getValue()
  const c     = contornoSubido(esc)
  assert.ok(valor.length > 4, `horneado: ${valor.length} vértices`)
  valor.slice(1).reduce((o, p, i) => o + tramoCurvo(c, o, valor[i], p, ESFERA, valor[0], `tramo ${i}`, !i), 0)
  esc.ed.destroy()
})

test('setCurve no pide otro contexto, `null` vuelve a rectas, y sólo polígono y polilínea se curvan', () => {
  const esc   = montar({ kind: 'polyline', value: [[60, 0], [60, 2]] })
  const path  = () => esc.ed.paths[0]
  const antes = contextos
  esc.ed.setCurve(byDefault)
  esc.ed.setCurve(null)

  assert.equal(contextos, antes, 'la curva vive en el contexto del editor')
  assert.deepEqual(midDe(path(), path().firstVertex), [60, 1], 'el midpoint vuelve al promedio')
  assert.ok(juntos(contornoSubido(esc)(1), relativo([60, 0], [60, 2])), 'y el contorno es el path')
  assert.deepEqual([esc.changes.length, esc.ed.getValue()], [0, [[60, 0], [60, 2]]])
  esc.ed.destroy()

  ;['rectangle', 'point', ...FORMAS].forEach(kind => {
    const otro = montar({ kind })
    assert.throws(() => otro.ed.setCurve(byDefault), /no se curva/, kind)
    otro.ed.destroy()
  })
})
