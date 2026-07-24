// Caracterización de EditableGeometry (editor de geometría como <input> controlado, Leaflet-nativo).
// Cubre: (1) el drag de un vértice de polígono emite onChange con la geometría nueva (vértice movido);
// (2) el borrado por dblclick respeta el mínimo topológico (≥3 en polígono); (3) insertar en una arista
// agrega un vértice en el midpoint; (4) el modo draw agrega puntos al recibir un click de mapa y captura
// un punto vía el handler expuesto; (5) destroy limpia handles y listeners.
//
// El harness (engine-stub) shimea window/document — se importa PRIMERO. makeLeaflet no trae marker/divIcon
// (sólo lo que el fold de cluster toca), así que se EXTIENDE localmente acá (sin tocar engine-stub.mjs).

import './../../test-helpers/engine-stub.mjs'
import { makeMap, makeLeaflet } from '../../test-helpers/engine-stub.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EditableGeometry } from '../../src/render/EditableGeometry.js'

/* ── Extensión local del stub de Leaflet: marker draggable + divIcon + registro de markers ── */

// `created` recolecta todos los markers creados (en orden de creación) para que el test dispare sus
// handlers (drag/dblclick/click) como lo haría Leaflet. Cada marker guarda su latlng y sus listeners.
const makeEditLeaflet = () => {
  const base = makeLeaflet()
  const created = []
  const L = {
    ...base,
    divIcon: (opts) => ({ _icon: true, ...opts }),
    marker(latlng, opts = {}) {
      const m = {
        _ll: toLatLng(latlng),
        _opts: opts,
        _h: new Map(),
        _removed: false,
        on(type, cb) { (m._h.get(type) ?? m._h.set(type, []).get(type)).push(cb); return m },
        fire(type, e) { (m._h.get(type) ?? []).forEach(cb => cb(e)); return m },
        getLatLng: () => m._ll,
        setLatLng(ll) { m._ll = toLatLng(ll); return m },
        addTo(group) { group.addLayer?.(m); return m },
        remove() { m._removed = true },
      }
      created.push(m)
      return m
    },
  }
  return { L, created }
}

const toLatLng = (ll) => (Array.isArray(ll) ? { lat: ll[0], lng: ll[1] } : { lat: ll.lat, lng: ll.lng })

// Un polígono cuadrado (anillo simple, sin cerrar): 4 vértices → 4 midpoints.
const SQUARE = [[0, 0], [0, 10], [10, 10], [10, 0]]

/* ── Tests ── */

test('drag de un vértice → onChange con la geometría nueva (vértice movido)', () => {
  const { L, created } = makeEditLeaflet()
  const changes = []
  const ed = new EditableGeometry({
    L, map: makeMap(), pane: 'edit', kind: 'polygon', value: SQUARE,
    mode: 'edit', onChange: g => changes.push(g),
  })

  // Handles creados en orden: 4 vértices y luego 4 midpoints. El vértice 1 es [0,10].
  const vertex1 = created[1]
  assert.deepEqual(vertex1.getLatLng(), { lat: 0, lng: 10 }, 'el 2º handle es el vértice índice 1')

  // Simula el drag: Leaflet actualiza la posición del marker y dispara 'drag'.
  vertex1.setLatLng([5, 20])
  vertex1.fire('drag', {})

  assert.equal(changes.length, 1, 'el drag emitió exactamente un onChange')
  const geom = changes[0]
  assert.deepEqual(geom[1], [5, 20], 'el vértice movido aparece en la geometría emitida')
  assert.deepEqual(geom[0], [0, 0], 'los demás vértices quedan intactos')
  assert.equal(geom.length, 4, 'sigue siendo un polígono de 4 vértices')
  // Salida desacoplada del estado interno (copia, no alias del array vivo).
  geom[0][0] = 999
  assert.deepEqual(ed.getValue()[0], [0, 0], 'la geometría emitida es una copia, no el array interno')

  ed.destroy()
})

test('dblclick borra el vértice pero respeta el mínimo (≥3 en polígono)', () => {
  const { L, created } = makeEditLeaflet()
  const changes = []
  const map = makeMap()
  const ed = new EditableGeometry({ L, map, kind: 'polygon', value: SQUARE, onChange: g => changes.push(g) })

  created[0].fire('dblclick', {})                       // 4 → 3 vértices: permitido
  assert.equal(changes.length, 1, 'borró un vértice')
  assert.equal(changes[0].length, 3, 'quedan 3 vértices')

  // Tras el rebuild los primeros 3 markers son los vértices vivos; borrar uno más caería a 2 → se ignora.
  const liveVertices = created.filter(m => !m._removed && m._opts.draggable).slice(-3)
  liveVertices[0].fire('dblclick', {})
  assert.equal(changes.length, 1, 'no baja del mínimo topológico (sigue en 1 emisión)')
  assert.deepEqual(ed.getValue().length, 3, 'la geometría sigue con 3 vértices')

  ed.destroy()
})

test('click en un midpoint inserta un vértice en la arista', () => {
  const { L, created } = makeEditLeaflet()
  const changes = []
  const ed = new EditableGeometry({ L, kind: 'polygon', value: SQUARE, map: makeMap(), onChange: g => changes.push(g) })

  // Los midpoints son los handles no-draggable; el del segmento 0 une [0,0]-[0,10] → [0,5].
  const mids = created.filter(m => !m._opts.draggable)
  assert.deepEqual(mids[0].getLatLng(), { lat: 0, lng: 5 }, 'midpoint del segmento 0')
  mids[0].fire('click', {})

  const geom = changes.at(-1)
  assert.equal(geom.length, 5, 'ahora hay 5 vértices')
  assert.deepEqual(geom[1], [0, 5], 'el vértice insertado está en el midpoint de la arista')

  ed.destroy()
})

test('modo draw: click de mapa agrega puntos y el handler expuesto captura un punto', () => {
  const { L } = makeEditLeaflet()
  const map = makeMap()
  const changes = []
  const ed = new EditableGeometry({
    L, map, kind: 'polyline', value: [], mode: 'draw', onChange: g => changes.push(g),
  })

  // El modo draw se suscribe a map.on('click') (API Leaflet, no DOM) → fire simula el click en mapa vacío.
  map.fire('click', { latlng: { lat: 1, lng: 2 } })
  map.fire('click', { latlng: { lat: 3, lng: 4 } })
  assert.deepEqual(changes.at(-1), [[1, 2], [3, 4]], 'cada click agrega un vértice al trazo')

  // Sub-pieza expuesta: el caller puede rutear su propia captura de punto sin pasar por map.on.
  ed.handleMapClick({ lat: 5, lng: 6 })
  assert.deepEqual(changes.at(-1), [[1, 2], [3, 4], [5, 6]], 'handleMapClick agrega igual que el click nativo')

  ed.destroy()
})

test('destroy quita la suscripción al mapa (no emite tras destruir)', () => {
  const { L } = makeEditLeaflet()
  const map = makeMap()
  const changes = []
  const ed = new EditableGeometry({ L, map, kind: 'point', value: null, mode: 'draw', onChange: g => changes.push(g) })

  map.fire('click', { latlng: { lat: 7, lng: 8 } })
  assert.deepEqual(changes.at(-1), [7, 8], 'point en draw: el click fija el punto')

  ed.destroy()
  map.fire('click', { latlng: { lat: 9, lng: 9 } })
  assert.equal(changes.length, 1, 'tras destroy el click del mapa ya no dispara onChange')
})

/* ── setValue: input controlado, NO emite (contrato central) ── */

test('setValue NO emite onChange (el mundo empuja estado, no es una edición)', () => {
  const { L } = makeEditLeaflet()
  const changes = []
  const ed = new EditableGeometry({ L, map: makeMap(), kind: 'polyline', value: [[0, 0]], onChange: g => changes.push(g) })

  ed.setValue([[1, 1], [2, 2], [3, 3]])
  assert.equal(changes.length, 0, 'setValue no dispara onChange')
  assert.deepEqual(ed.getValue(), [[1, 1], [2, 2], [3, 3]], 'pero sí actualiza el valor interno')

  ed.destroy()
})

test('setValue reconstruye los handles: una edición posterior sí emite', () => {
  const { L, created } = makeEditLeaflet()
  const changes = []
  const ed = new EditableGeometry({ L, map: makeMap(), kind: 'polyline', value: [[0, 0]], onChange: g => changes.push(g) })

  ed.setValue([[1, 1], [2, 2], [3, 3]])
  assert.equal(changes.length, 0, 'setValue seguía sin emitir')

  // Los últimos 3 markers draggables vivos son los vértices del path nuevo; arrastramos el del medio.
  const vertices = created.filter(m => !m._removed && m._opts.draggable).slice(-3)
  vertices[1].setLatLng([7, 7])
  vertices[1].fire('drag', {})

  assert.equal(changes.length, 1, 'la edición posterior a setValue sí emite (handles recableados)')
  assert.deepEqual(changes[0], [[1, 1], [7, 7], [3, 3]], 'emite el path nuevo con el vértice movido')

  ed.destroy()
})

/* ── Coordenadas basura: se sanean en el ingest (garbage-in) ── */

test('ingest descarta coordenadas no-finitas (NaN / Infinity / undefined)', () => {
  const { L } = makeEditLeaflet()

  const line = new EditableGeometry({
    L, map: makeMap(), kind: 'polyline',
    value: [[0, 0], [NaN, 5], [10, 10], [Infinity, 2], [1, undefined], [3, 3]],
  })
  assert.deepEqual(line.getValue(), [[0, 0], [10, 10], [3, 3]], 'sólo quedan los pares finitos')
  line.destroy()

  const pt = new EditableGeometry({ L, map: makeMap(), kind: 'point', value: [NaN, 1] })
  assert.equal(pt.getValue(), null, 'un point no-finito degenera a null')
  pt.destroy()

  const rect = new EditableGeometry({ L, map: makeMap(), kind: 'rectangle', value: [[0, 0], [Infinity, 10]] })
  assert.equal(rect.getValue(), null, 'un rectangle con esquina no-finita degenera a null')
  rect.destroy()
})

/* ── Multi-anillo (paths enteros), en forma par y en forma objeto ── */

test('polígono multi-anillo: edita un vértice y conserva ambos anillos (forma par)', () => {
  const { L, created } = makeEditLeaflet()
  const changes = []
  const OUTER = [[0, 0], [0, 10], [10, 10], [10, 0]]
  const INNER = [[2, 2], [2, 4], [4, 4], [4, 2]]
  const ed = new EditableGeometry({ L, map: makeMap(), kind: 'polygon', value: [OUTER, INNER], onChange: g => changes.push(g) })

  // El valor entra y sale como multi-anillo (array de anillos), no aplanado.
  const v0 = ed.getValue()
  assert.equal(v0.length, 2, 'dos anillos')
  assert.deepEqual(v0[0], OUTER, 'anillo externo intacto')
  assert.deepEqual(v0[1], INNER, 'anillo interno intacto')

  // Cada anillo emite sus vértices y LUEGO sus midpoints; los vértices draggables en orden son
  // externo[0..3] + interno[0..3]. El 5º vértice draggable es el primer vértice del anillo interno.
  const vertices = created.filter(m => m._opts.draggable)
  const innerV0 = vertices[4]
  assert.deepEqual(innerV0.getLatLng(), { lat: 2, lng: 2 }, 'primer vértice del anillo interno')
  innerV0.setLatLng([9, 9])
  innerV0.fire('drag', {})

  const g = changes.at(-1)
  assert.equal(g.length, 2, 'la emisión sigue siendo multi-anillo')
  assert.deepEqual(g[0], OUTER, 'el anillo externo no se tocó')
  assert.deepEqual(g[1], [[9, 9], [2, 4], [4, 4], [4, 2]], 'sólo el vértice del anillo interno se movió')

  ed.destroy()
})

test('multi-anillo en forma objeto {lat,lng} NO se confunde con anillo simple', () => {
  const { L } = makeEditLeaflet()
  const OUTER = [{ lat: 0, lng: 0 }, { lat: 0, lng: 10 }, { lat: 10, lng: 10 }, { lat: 10, lng: 0 }]
  const INNER = [{ lat: 2, lng: 2 }, { lat: 2, lng: 4 }, { lat: 4, lng: 4 }, { lat: 4, lng: 2 }]
  const ed = new EditableGeometry({ L, map: makeMap(), kind: 'polygon', value: [OUTER, INNER] })

  const v = ed.getValue()
  // Antes del fix, isMultiRing sólo miraba pares → esto se leía como anillo simple y `toPair` sobre cada
  // anillo lo corrompía (tomaba r[0]/r[1]). Ahora sale como 2 anillos de 4 pares [lat,lng] cada uno.
  assert.equal(v.length, 2, 'se detecta como multi-anillo (2 anillos)')
  assert.deepEqual(v[0], [[0, 0], [0, 10], [10, 10], [10, 0]], 'anillo externo → pares')
  assert.deepEqual(v[1], [[2, 2], [2, 4], [4, 4], [4, 2]], 'anillo interno → pares')

  ed.destroy()
})

/* ── point-drag en modo edit ── */

test('point en edit: arrastrar el marcador emite el punto movido', () => {
  const { L, created } = makeEditLeaflet()
  const changes = []
  const ed = new EditableGeometry({ L, map: makeMap(), kind: 'point', value: [5, 5], onChange: g => changes.push(g) })

  const m = created[0]
  assert.deepEqual(m.getLatLng(), { lat: 5, lng: 5 }, 'el marcador arranca en el punto')
  m.setLatLng([8, 12])
  m.fire('drag', {})

  assert.equal(changes.length, 1, 'un drag → un onChange')
  assert.deepEqual(changes[0], [8, 12], 'emite el punto nuevo como par [lat,lng]')
  assert.deepEqual(ed.getValue(), [8, 12], 'getValue refleja el punto movido')

  ed.destroy()
})

/* ── rectangle: draw de 2 clicks + corner-drag ── */

test('rectangle: 2 clicks trazan el bounds y arrastrar una esquina lo recompone', () => {
  const { L, created } = makeEditLeaflet()
  const map = makeMap()
  const changes = []
  const ed = new EditableGeometry({ L, map, kind: 'rectangle', value: null, mode: 'draw', onChange: g => changes.push(g) })

  // Primer click fija una esquina (sin emitir todavía); el segundo cierra el bounds.
  map.fire('click', { latlng: { lat: 0, lng: 0 } })
  assert.equal(changes.length, 0, 'el primer click sólo fija el ancla, no emite')
  map.fire('click', { latlng: { lat: 10, lng: 20 } })
  assert.deepEqual(changes.at(-1), [[0, 0], [10, 20]], 'el segundo click emite el bounds [[S,W],[N,E]]')

  // Pasamos a edit para tener las 4 esquinas como handles y arrastrar una.
  ed.setMode('edit')
  assert.equal(changes.length, 1, 'setMode no emite')

  // rectCorners: [SW, NW, NE, SE] → created[0]=SW [0,0]. Lo arrastramos; la opuesta (NE [10,20]) queda fija.
  const sw = created[0]
  assert.deepEqual(sw.getLatLng(), { lat: 0, lng: 0 }, 'esquina SW')
  sw.setLatLng([5, 5])
  sw.fire('drag', {})

  assert.deepEqual(changes.at(-1), [[5, 5], [10, 20]], 'el bounds se recompone por min/max contra la esquina opuesta')
  assert.deepEqual(ed.getValue(), [[5, 5], [10, 20]], 'getValue refleja el rectángulo redimensionado')

  ed.destroy()
})

/* ── draw close: dblclick no duplica el último punto ni re-emite idéntico ── */

test('draw dblclick de cierre: no duplica el último vértice ni re-emite idéntico', () => {
  const { L } = makeEditLeaflet()
  const map = makeMap()
  const changes = []
  const ed = new EditableGeometry({ L, map, kind: 'polyline', value: [], mode: 'draw', onChange: g => changes.push(g) })

  map.fire('click', { latlng: { lat: 0, lng: 0 } })   // A → emite [A]
  map.fire('click', { latlng: { lat: 5, lng: 5 } })   // B → emite [A,B]
  map.fire('click', { latlng: { lat: 9, lng: 9 } })   // C → emite [A,B,C]
  assert.equal(changes.length, 3, 'tres clicks distintos → tres emisiones')

  // Leaflet dispara un click EXTRA en la misma posición (C) junto al dblclick de cierre.
  map.fire('click', { latlng: { lat: 9, lng: 9 } })
  map.fire('dblclick', { latlng: { lat: 9, lng: 9 } })

  assert.equal(changes.length, 3, 'el cierre no duplica el punto ni re-emite una geometría idéntica')
  assert.deepEqual(ed.getValue(), [[0, 0], [5, 5], [9, 9]], 'el último vértice aparece una sola vez')

  ed.destroy()
})

/* ── onChange (live) vs onCommit (settle) ── */

test('onChange es live por drag; onCommit asienta al soltar (y en cada edición discreta)', () => {
  const { L, created } = makeEditLeaflet()
  const changes = [], commits = []
  const ed = new EditableGeometry({
    L, map: makeMap(), kind: 'polygon', value: SQUARE,
    onChange: g => changes.push(g), onCommit: g => commits.push(g),
  })

  const vertex1 = created[1]                            // vértice índice 1 = [0,10]
  vertex1.setLatLng([1, 11]); vertex1.fire('drag', {})
  vertex1.setLatLng([2, 12]); vertex1.fire('drag', {})
  vertex1.setLatLng([3, 13]); vertex1.fire('drag', {})
  assert.equal(changes.length, 3, 'onChange emite por cada frame de drag')
  assert.equal(commits.length, 0, 'onCommit NO emite durante el drag (sin soltar)')

  vertex1.fire('dragend', {})
  assert.equal(commits.length, 1, 'onCommit emite UNA vez al soltar')
  assert.deepEqual(commits[0][1], [3, 13], 'el commit lleva la geometría asentada')

  created[0].fire('dblclick', {})                       // edición discreta: borra un vértice (4 → 3)
  assert.equal(changes.length, 4, 'la edición discreta también emite onChange')
  assert.equal(commits.length, 2, 'y asienta onCommit en el mismo gesto')

  ed.destroy()
})
