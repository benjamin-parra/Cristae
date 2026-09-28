// Caracterización de EditableGeometry (editor de geometría como <input> controlado). Cubre: (1) el drag
// de un vértice de polígono emite onChange con la geometría nueva (vértice movido); (2) el borrado por
// dblclick respeta el mínimo topológico (≥3 en polígono); (3) insertar en una arista agrega un vértice en
// el midpoint; (4) el modo draw agrega puntos al recibir un click de mapa y captura un punto vía el
// handler expuesto; (5) destroy limpia el gesto y los listeners; (6) el costo en el arena: insertar
// desplaza a lo sumo un chunk y el drag no renumera nada; (7) el click que cierra una pulsación sobre un
// handle es del gesto; en el vacío, o sobre un control, no.
//
// El gesto ya no vive en un `L.marker` por vértice: lo posee la capa GL. El test lo ejerce como el
// navegador —pointerdown / pointermove / pointerup / pointercancel / click / dblclick sobre el contenedor
// del mapa— y DECLARA qué entrada hay bajo el puntero (`spy.bajoElCursor`): el parche que el pase
// decodifica lo compone el doble con los draws que la capa emitió de verdad, así que una entrada que quedó
// fuera de sus rangos —o que se apagó con el tile transparente— no se pickea. El resto del árbol
// (ChunkedPath, arena, capas, picking) es el REAL.
//
// El harness (engine-stub) shimea window/document — se importa PRIMERO.

import './../../test-helpers/engine-stub.mjs'
import { conGlDeEdicion, contadorNodos, makeDragging, makeEditGl, makeLeaflet, makeMap, makePickSpy, makeSurface } from '../../test-helpers/engine-stub.mjs'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { ROLE } from '../../src/geometry/ChunkedPath.js'
import { defineEditIconSet, editHandleChannels } from '../../src/render/EditHandleLayer.js'
import { EditableGeometry } from '../../src/render/EditableGeometry.js'

/* ── Harness de la sesión de edición ── */

const P = 100                            // el harness proyecta lineal: un grado son 100 px de contenedor

// El canal del tile TRANSPARENTE, con el que el editor apaga un handle del visual y del pase a la vez. El
// doble lo necesita para descartar como el fragment; el tile de cada entrada lo lee del VBO.
const TILE_VACIO = editHandleChannels(defineEditIconSet()).tiles[ROLE.free]

// La superficie de edición pide un WebGL2 CON stencil sobre un canvas propio, y el `document` del harness
// devuelve un contexto no-op. La costura del harness le enchufa el doble de GL del repo —el mismo que
// ejercen las otras capas de edición—: el canvas lo sigue creando el shim, así que nada más cambia.
let glVigente = null

after(conGlDeEdicion(() => glVigente))

// `L.DomUtil` posiciona los nodos del banco y el canvas de la superficie.
const conDomUtil = L => ({ ...L, DomUtil: { ...L.DomUtil, setPosition: () => {} } })

// `alAsentar` corre dentro de `onCommit` y recibe el editor: es donde un consumidor lo corta —pasa a draw,
// lo destruye— antes de que llegue el resto de la pulsación.
const montar = ({ kind = 'polygon', value = null, mode = 'edit', dpr = 1, style, pintado, alAsentar } = {}) => {
  const spy = makePickSpy()
  spy.tileVacio = TILE_VACIO
  glVigente = makeEditGl(spy, makeSurface({ dpr }))
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
  const map       = { ...makeMap(), dragging }
  const container = map.getContainer()
  const changes   = [], commits = []
  // Lo que llega a la burbuja como click del mapa: lo que el motor emitiría como `cristae:mapclick`, o
  // como click de la capa que haya debajo.
  const alMapa    = []
  map.on('click', e => alMapa.push(e.latlng))
  const ed = new EditableGeometry({
    L: conDomUtil(makeLeaflet()), map, pane: 'edit', kind, value, mode, style,
    onChange: leer => changes.push(leer()),
    onCommit: leer => {
      commits.push(leer())
      alAsentar?.(ed)
    },
  })
  return { ed, kind, map, container, dragging, spy, changes, commits, alMapa, punto: [0, 0], destino: null, puntero: 1 }
}

// El evento como lo despacha el navegador, y con el testigo de si el editor se lo QUEDÓ: consumirlo es
// sacárselo al mapa, así que reconocer un handle donde no hay ninguno se nota acá aunque no edite nada.
// `cortado` es la mitad que decide si el evento sigue a la burbuja, donde escucha Leaflet. `detail` es la
// cuenta de clicks —0 en el de teclado, que no viene de un puntero—, `target` el nodo DOM bajo el puntero
// (`esc.destino`) y `pointerId`, el puntero que lo despacha (`esc.puntero`).
const emitir = (esc, tipo, x, y, detail = 1) =>
  esc.container.emitir(tipo, { clientX: x, clientY: y, detail, target: esc.destino, pointerId: esc.puntero })

// Qué HAY bajo el puntero, no qué contesta el pase: se declara la entrada del arena y el doble sólo la
// devuelve si algún draw del trazo la cubrió y su tile la deja escribir (ver `componer` en el harness).
// point y rectangle no exponen su trazo —el suyo se DERIVA del valor— y viven en un chunk único, así que
// su local es el ref.
const apuntar = (esc, ref, anillo = 0) => {
  const path = esc.ed.paths[anillo] ?? null
  esc.spy.bajoElCursor = { obj: anillo + 1, entrada: ref, local: path ? path.localOf(ref) : ref }
  return esc
}

// La coordenada del handle `ref`: sale del trazo cuando el kind lo expone. point y rectangle no —el suyo
// se DERIVA del valor—, así que se reconstruye igual que el editor: el punto es su única entrada, y el
// rectángulo va [SW, NW, NE, SE] con el midpoint de cada arista intercalado.
const coordDe = (esc, ref, anillo) => {
  const path = esc.ed.paths[anillo]
  if (path) return [path.xAt(ref), path.yAt(ref)]
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

// El `click` con que el navegador cierra la pulsación, en su mismo píxel. Pasa primero por la captura del
// contenedor —donde escucha el editor— y, si nadie cortó la propagación, sigue a la burbuja, donde
// Leaflet lo vuelve el click del mapa.
const click = (esc, detail) => {
  const e = emitir(esc, 'click', esc.punto[0], esc.punto[1], detail)
  e.cortado || esc.map.fire('click', { latlng: esc.map.containerPointToLatLng(esc.punto) })
  return e
}

// Una pulsación entera, hasta el `click` que la cierra: sobre el handle `ref`, o sobre un píxel sin handle.
const pulsarHandle = (esc, ref, anillo = 0) => {
  tomar(esc, ref, anillo)
  soltar(esc)
  return click(esc)
}

const pulsarVacio = (esc, x, y) => {
  vaciar(esc)
  esc.punto = [x, y]
  emitir(esc, 'pointerdown', x, y)
  soltar(esc)
  return click(esc)
}

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

  // El modo draw se suscribe a map.on('click') (API Leaflet, no DOM) → fire simula el click en mapa vacío.
  esc.map.fire('click', { latlng: { lat: 1, lng: 2 } })
  esc.map.fire('click', { latlng: { lat: 3, lng: 4 } })
  assert.deepEqual(esc.changes.at(-1), [[1, 2], [3, 4]], 'cada click agrega un vértice al trazo')

  // Sub-pieza expuesta: el caller puede rutear su propia captura de punto sin pasar por map.on.
  esc.ed.handleMapClick({ lat: 5, lng: 6 })
  assert.deepEqual(esc.changes.at(-1), [[1, 2], [3, 4], [5, 6]], 'handleMapClick agrega igual que el click nativo')

  esc.ed.destroy()
})

test('modo draw: cada click ASIENTA (onCommit), no sólo emite live', () => {
  const esc = montar({ kind: 'polyline', value: [], mode: 'draw' })
  esc.map.fire('click', { latlng: { lat: 1, lng: 2 } })
  esc.map.fire('click', { latlng: { lat: 3, lng: 4 } })
  assert.equal(esc.commits.length, 2, 'un host que sólo escucha onCommit tiene que ver los puntos')
  assert.deepEqual(esc.commits.at(-1), [[1, 2], [3, 4]])
  esc.ed.destroy()
})

test('destroy quita la suscripción al mapa y el gesto del contenedor', () => {
  const esc = montar({ kind: 'point', value: null, mode: 'draw' })

  esc.map.fire('click', { latlng: { lat: 7, lng: 8 } })
  assert.deepEqual(esc.changes.at(-1), [7, 8], 'point en draw: el click fija el punto')

  esc.ed.destroy()
  esc.map.fire('click', { latlng: { lat: 9, lng: 9 } })
  assert.equal(esc.changes.length, 1, 'tras destroy el click del mapa ya no dispara onChange')

  const edit = montar({ kind: 'polygon', value: SQUARE })
  assert.ok(edit.container.oyentes.length > 0, 'en edit el gesto está cableado al contenedor')
  edit.ed.destroy()
  assert.equal(edit.container.oyentes.length, 0, 'y destroy lo descablea entero')
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
  // Antes del fix, isMultiRing sólo miraba pares → esto se leía como anillo simple y `toPair` sobre cada
  // anillo lo corrompía (tomaba r[0]/r[1]). Ahora sale como 2 anillos de 4 pares [lat,lng] cada uno.
  assert.equal(v.length, 2, 'se detecta como multi-anillo (2 anillos)')
  assert.deepEqual(v[0], [[0, 0], [0, 10], [10, 10], [10, 0]], 'anillo externo → pares')
  assert.deepEqual(v[1], [[2, 2], [2, 4], [4, 4], [4, 2]], 'anillo interno → pares')

  esc.ed.destroy()
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
  esc.map.fire('click', { latlng: { lat: 0, lng: 0 } })
  assert.equal(esc.changes.length, 0, 'el primer click sólo fija el ancla, no emite')
  esc.map.fire('click', { latlng: { lat: 10, lng: 20 } })
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

test('draw dblclick de cierre: no duplica el último vértice ni re-emite idéntico', () => {
  const esc = montar({ kind: 'polyline', value: [], mode: 'draw' })

  esc.map.fire('click', { latlng: { lat: 0, lng: 0 } })   // A → emite [A]
  esc.map.fire('click', { latlng: { lat: 5, lng: 5 } })   // B → emite [A,B]
  esc.map.fire('click', { latlng: { lat: 9, lng: 9 } })   // C → emite [A,B,C]
  assert.equal(esc.changes.length, 3, 'tres clicks distintos → tres emisiones')

  // Leaflet dispara un click EXTRA en la misma posición (C) junto al dblclick de cierre.
  esc.map.fire('click', { latlng: { lat: 9, lng: 9 } })
  esc.map.fire('dblclick', { latlng: { lat: 9, lng: 9 } })

  assert.equal(esc.changes.length, 3, 'el cierre no duplica el punto ni re-emite una geometría idéntica')
  assert.deepEqual(esc.ed.getValue(), [[0, 0], [5, 5], [9, 9]], 'el último vértice aparece una sola vez')

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

/* ── El click que cierra la pulsación: del gesto si tomó un handle, del mapa si no ── */

test('el click que cierra el arrastre de un handle no llega al mapa, en las cuatro formas', () => {
  const casos = [
    ['polygon', SQUARE],
    ['polyline', [[0, 0], [5, 5], [9, 9]]],
    ['point', [5, 5]],
    ['rectangle', [[0, 0], [10, 20]]],
  ]
  casos.forEach(([kind, value]) => {
    const esc = montar({ kind, value })
    arrastrar(esc, esc.ed.paths[0]?.firstVertex ?? 0, [[3, 4]])
    const e = click(esc)
    assert.deepEqual(
      { consumido: e.consumido, cortado: e.cortado, alMapa: esc.alMapa.length, commits: esc.commits.length },
      { consumido: true, cortado: true, alMapa: 0, commits: 1 },
      `${kind}: el arrastre asentó y su click no sigue viaje`,
    )
    esc.ed.destroy()
  })
})

test('un click quieto sobre un vértice tampoco llega al mapa, y el testigo vale un solo click', () => {
  const esc = montar({ kind: 'polygon', value: SQUARE })

  const delGesto = pulsarHandle(esc, refsDe(esc.ed.paths[0])[1])
  const suelto   = click(esc)                           // sin `pointerdown` propio, aunque traiga `detail`

  assert.deepEqual(
    { delGesto: delGesto.cortado, suelto: suelto.cortado, alMapa: esc.alMapa.length, changes: esc.changes.length },
    { delGesto: true, suelto: false, alMapa: 1, changes: 0 },
    'la pulsación sin arrastre no edita ni sale como click; el click siguiente ya no es del gesto',
  )

  esc.ed.destroy()
})

test('el click de un midpoint no llega al mapa', () => {
  const esc  = montar({ kind: 'polyline', value: [[0, 0], [0, 10]] })
  const path = esc.ed.paths[0]

  const e = pulsarHandle(esc, path.midOf(path.firstVertex))

  assert.deepEqual({ cortado: e.cortado, alMapa: esc.alMapa.length }, { cortado: true, alMapa: 0 })

  esc.ed.destroy()
})

// `onCommit` corre a mitad de la pulsación —al soltar un arrastre, o en el `pointerdown` que inserta por un
// midpoint, antes de tomar el gesto— y puede sacar al editor de edit. El click que la cierra sigue siendo
// del gesto: no sale al mapa ni, en draw, agrega un vértice donde se soltó. La inserción cortada tampoco
// toma el gesto, así que el arrastre del mapa queda como estaba, y lo que siguió escuchando por ese click
// se retira con él.
const CORTES = [['draw', ed => ed.setMode('draw')], ['destroy', ed => ed.destroy()]]

test('un onCommit que corta la pulsación no suelta su click al mapa', () => {
  const gestos = [
    ['arrastre', esc => click(arrastrar(esc, esc.ed.paths[0].firstVertex, [[3, 4]])), 2],
    ['midpoint', esc => pulsarHandle(esc, esc.ed.paths[0].midOf(esc.ed.paths[0].firstVertex)), 3],
  ]
  CORTES.forEach(([corte, alAsentar]) => gestos.forEach(([gesto, pulsar, vertices]) => {
    const esc = montar({ kind: 'polyline', value: [[0, 0], [0, 10]], alAsentar })
    const e   = pulsar(esc)
    assert.deepEqual(
      {
        cortado  : e.cortado,
        arrastre : esc.dragging.activo,
        alMapa   : esc.alMapa.length,
        vertices : esc.ed.getValue().length,
        oyentes  : esc.container.oyentes.length,
      },
      { cortado: true, arrastre: true, alMapa: 0, vertices, oyentes: 0 },
      `${gesto} cortado por ${corte}`,
    )
    esc.ed.destroy()
  }))
})

// Un arrastre táctil no despacha click: lo que siguió escuchando por él se retira con la pulsación
// siguiente, que es del mapa.
test('sin click que consumir, la pulsación que sigue al corte es del mapa', () => {
  CORTES.forEach(([corte, alAsentar]) => {
    const esc = montar({ kind: 'polyline', value: [[0, 0], [0, 10]], alAsentar })
    arrastrar(esc, esc.ed.paths[0].firstVertex, [[3, 4]])
    const e = pulsarVacio(esc, 500, 300)
    assert.deepEqual(
      { consumido: e.consumido, alMapa: esc.alMapa.length, oyentes: esc.container.oyentes.length },
      { consumido: false, alMapa: 1, oyentes: 0 },
      corte,
    )
    esc.ed.destroy()
  })
})

// El navegador despacha dos pulsaciones completas —cada una con su click— antes del `dblclick`.
test('el doble click que borra un vértice se consume entero: sus dos clicks y el dblclick', () => {
  const esc = montar({ kind: 'polygon', value: SQUARE })
  const v0  = refsDe(esc.ed.paths[0])[0]

  const eventos = [pulsarHandle(esc, v0), pulsarHandle(esc, v0), doble(esc, v0)]

  assert.deepEqual(eventos.map(e => e.cortado), [true, true, true], 'ninguno de los tres sigue al mapa')
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

// Un arrastre táctil no despacha su click, y un gesto cancelado tampoco: el testigo queda armado. El click
// de teclado pasa igual, y el de puntero trae su `pointerdown`, que lo desarma.
test('un testigo que quedó armado no se come el click siguiente, de teclado ni de puntero', () => {
  const esc = montar({ kind: 'polygon', value: SQUARE })
  const v1  = refsDe(esc.ed.paths[0])[1]

  arrastrar(esc, v1, [[3, 4]])
  const teclado = click(esc, 0)                         // Enter sobre un control del mapa
  tomar(esc, v1)
  emitir(esc, 'pointercancel', esc.punto[0], esc.punto[1])
  const puntero = pulsarVacio(esc, 500, 300)

  assert.deepEqual({ teclado: teclado.consumido, puntero: puntero.consumido }, { teclado: false, puntero: false })

  esc.ed.destroy()
})

// En draw el click del mapa ES la edición, y el del contenedor ya no se escucha.
test('en draw el click del mapa sigue agregando vértices', () => {
  const esc = montar({ kind: 'polyline', value: [[0, 0], [0, 10]] })

  esc.ed.setMode('draw')
  pulsarVacio(esc, 200, 100)
  pulsarVacio(esc, 400, 300)

  assert.deepEqual(
    { oye: esc.container.oyentes.some(o => o.tipo === 'click'), valor: esc.ed.getValue() },
    { oye: false, valor: [[0, 0], [0, 10], [1, 2], [3, 4]] },
  )

  esc.ed.destroy()
})

// Los controles viven dentro del contenedor, por encima de la superficie de edición: uno que tapa un handle
// se queda con la pulsación, su click y su doble click, que no toman ni borran el vértice de abajo. El
// control lo marca `disableClickPropagation`, y la pulsación cae en un botón suyo. Llega con el testigo
// armado por un arrastre sin click, y su `pointerdown` lo desarma igual.
test('sobre un control que tapa un handle, la pulsación es del control', () => {
  const esc     = montar({ kind: 'polygon', value: SQUARE })
  const v1      = refsDe(esc.ed.paths[0])[1]
  const control = { _leaflet_disable_click: true, parentNode: esc.container }
  arrastrar(esc, v1, [[3, 4]])
  esc.destino = { parentNode: control }

  const eventos = [tomar(esc, v1), soltar(esc), click(esc), doble(esc, v1)]

  assert.deepEqual(
    { consumidos: eventos.map(e => e.consumido), vertices: esc.ed.getValue().length },
    { consumidos: [false, false, false, false], vertices: 4 },
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
