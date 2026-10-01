// Contrato de PointLayer: qué entra al buffer, cuándo el path incremental cae al rebuild O(n), y el marco
// con que se dibuja y se pica. La capa toma su superficie del anfitrión, así que se monta en node contra
// el doble de GL del harness: lo único que se le lee de vuelta es lo que se le SUBIÓ —el espejo del VBO
// que mantiene el doble— y las matrices del draw. El rebuild es el único que estrena el buffer
// (`bufferData`), así que contarlos es contar rebuilds.
import '../test-helpers/engine-stub.mjs'
import { decorarElementos, makeEditGl, makeIconSet, makeLeaflet, makeMap, makePickSpy, makeSurface } from '../test-helpers/engine-stub.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { PointLayer } from '../src/render/PointLayer.js'
import { adoptLeafletHost } from '../src/host/LeafletHost.js'
import { projX0, projY0 } from '../src/render/project.js'

/* ── Harness ── */

const FLOATS = 7
const flushRaf = () => new Promise(r => setTimeout(r, 5))

// Source manual: notify SÍNCRONO (sin rAF) y acumuladores controlados por el test, con la misma
// semántica de ventana que la Source de la casa (se limpian tras el emit).
const makeSource = (items, accessors) => {
  const subs = new Set()
  const moveDirty = new Set()
  const structDirty = new Set()
  return {
    accessors,
    getSnapshot: () => items,
    subscribe: (cb) => { subs.add(cb); return () => subs.delete(cb) },
    itemById: (id) => items.find(it => accessors.idOf(it) === id),
    moveDirtyIds: () => moveDirty,
    dirtyIds: () => structDirty,
    emitMove(...ids) { ids.forEach(id => moveDirty.add(id)); this.flush() },
    emitDirty(...ids) { ids.forEach(id => structDirty.add(id)); this.flush() },
    flush() { subs.forEach(cb => cb()); moveDirty.clear(); structDirty.clear() },
  }
}

const idOf = (it) => it.id
const positionOf = (it) => it.pos

// El GL del harness más lo que estos asertos leen y el doble no guarda: las matrices de cada draw (del
// visual y del pase), el ORIGEN de cada subida —su identidad dice si se reservó un array—, los atributos
// con que se pidió el contexto y sus bajas. El ancho del buffer se lee VIVO de la superficie, para poder
// moverlo como lo mueve un cambio de monitor.
const mount = (items, accessors, opts = {}, superficie = makeSurface()) => {
  const spy  = makePickSpy()
  const base = makeEditGl(spy, superficie)
  const log  = { matrices: [], fuentes: [], attrs: null, canvas: null, perdidos: 0 }
  const gl   = new Proxy(base, {
    get: (t, p) => {
      if (p === 'drawingBufferWidth') return superficie.width
      if (p === 'uniformMatrix4fv')   return (_loc, _t, m) => log.matrices.push(Float32Array.from(m))
      if (p === 'bufferData')         return (target, src, usage) => { log.fuentes.push(src); t.bufferData(target, src, usage) }
      if (p === 'bufferSubData')      return (...args) => { log.fuentes.push(args[2]); t.bufferSubData(...args) }
      if (p === 'getExtension')       return name => (name === 'WEBGL_lose_context' ? { loseContext: () => log.perdidos++ } : {})
      return t[p]
    },
  })
  const restaurar = decorarElementos((el, tag) => {
    if (tag !== 'canvas') return el
    log.canvas = el
    el.getContext = (_kind, attrs) => { log.attrs = attrs; return gl }
    return el
  })
  try {
    const map    = makeMap({ zoom: 5 })
    const host   = adoptLeafletHost(map, { leaflet: makeLeaflet() })
    const source = makeSource(items, accessors)
    const layer  = new PointLayer({ host, pane: 'p', source, iconSet: makeIconSet(), ...opts })
    return { layer, source, host, map, spy, log, rebuilds: () => spy.bufferDatas.length, verts: () => spy.array.datos }
  } finally {
    restaurar()
  }
}

// El vértice de una posición, como lo escribe la capa: world0 relativo al ancla —el centro de la vista
// en el último rebuild— y bajado a float32.
const xyDe = (host, lat, lng) => {
  const c = host.camera.center()
  return [Math.fround(projX0(lng) - projX0(c.lng)), Math.fround(projY0(lat) - projY0(c.lat))]
}
const xyEn = (h, slot) => [...h.verts().slice(slot * FLOATS, slot * FLOATS + 2)]

/* ── P5: el camino incremental tiene que sobrevivir al cluster ── */

test('P5 — move de un punto SUPRIMIDO por el cluster no dispara rebuild', () => {
  const items = [1, 2, 3, 4, 5].map(id => ({ id, pos: { lat: id, lng: id } }))
  const { source, layer, rebuilds } = mount(items, { idOf, positionOf })

  layer.suppressed = new Set([2, 3, 4, 5])
  layer.refresh()
  assert.equal(layer.count, 1, 'sólo el no suprimido queda en el buffer')

  const before = rebuilds()
  source.emitMove(2)
  source.emitMove(3, 4, 5)
  assert.equal(rebuilds(), before, 'los moves de clusterizados no rebuildean')
  layer.destroy()
})

test('P5 — move de un punto sin posición finita tampoco dispara rebuild', () => {
  const items = [
    { id: 1, pos: { lat: 1, lng: 1 } },
    { id: 2, pos: { lat: NaN, lng: NaN } },   // sin fix GPS
    { id: 3, pos: null },                      // sin posición
  ]
  const { source, layer, rebuilds } = mount(items, { idOf, positionOf })
  assert.equal(layer.count, 1)

  const before = rebuilds()
  source.emitMove(2)
  source.emitDirty(3)
  assert.equal(rebuilds(), before)
  layer.destroy()
})

test('P5 — ítem ajeno a la capa (`where`) no dispara rebuild', () => {
  const items = [{ id: 1, pos: { lat: 1, lng: 1 }, badge: true }, { id: 2, pos: { lat: 2, lng: 2 }, badge: false }]
  const { source, layer, rebuilds } = mount(items, { idOf, positionOf }, { where: (it) => it.badge })
  assert.equal(layer.count, 1)

  const before = rebuilds()
  source.emitMove(2)
  source.emitDirty(2)
  assert.equal(rebuilds(), before)
  layer.destroy()
})

test('P5 — un id DESCONOCIDO sigue cayendo al rebuild (la red de seguridad no se pierde)', () => {
  const items = [{ id: 1, pos: { lat: 1, lng: 1 } }]
  const { source, layer, rebuilds } = mount(items, { idOf, positionOf })

  const before = rebuilds()
  source.emitMove(99)
  assert.equal(rebuilds(), before + 1, 'id fuera del snapshot → el buffer no está al día → rebuild')
  layer.destroy()
})

test('P5 — el ítem que RECUPERA posición finita vuelve al buffer', () => {
  const items = [{ id: 1, pos: { lat: 1, lng: 1 } }, { id: 2, pos: null }]
  const { source, layer, rebuilds } = mount(items, { idOf, positionOf })
  assert.equal(layer.count, 1)

  items[1].pos = { lat: 2, lng: 2 }
  const before = rebuilds()
  source.emitDirty(2)
  assert.equal(rebuilds(), before + 1, 'la omisión se reevalúa, no se cachea')
  assert.equal(layer.count, 2)
  layer.destroy()
})

/* ── El path incremental: el slot, desde el mismo espejo ── */

// [0-alloc] por construcción: cada subida parte del MISMO Float32Array que estrenó el rebuild, con la
// forma de 5 argumentos (offset y largo, sin `subarray`), y sin volver a estrenar el buffer.
test('incremental — move y patch suben SU slot desde el mismo espejo, sin reservar ni estrenar el buffer', () => {
  const items = [{ id: 1, pos: { lat: 1, lng: 1 } }, { id: 2, pos: { lat: 2, lng: 2 } }]
  const h = mount(items, { idOf, positionOf })
  const espejo = h.log.fuentes.at(-1)
  const before = h.rebuilds()

  items[1].pos = { lat: 5, lng: 6 }
  h.source.emitMove(2)
  h.source.emitDirty(1)

  assert.equal(h.rebuilds(), before, 'sin cambio de membresía no se estrena el buffer')
  assert.deepEqual(h.spy.bufferSubDatas, [
    { offset: FLOATS * 4, srcOffset: FLOATS, length: 2 },
    { offset: 0,          srcOffset: 0,      length: FLOATS },
  ], 'el move sube los 2 floats de posición de su slot; el patch, los 7 del suyo')
  assert.ok(h.log.fuentes.slice(-2).every(src => src.buffer === espejo.buffer), 'y los dos parten del espejo del rebuild')
  assert.deepEqual(xyEn(h, 1), xyDe(h.host, 5, 6), 'con la posición nueva en el buffer')
  h.layer.destroy()
})

test('rebuild — sube lo que ocupa el set, no la capacidad del espejo', () => {
  const items = [{ id: 1, pos: { lat: 1, lng: 1 } }, { id: 2, pos: { lat: 2, lng: 2 } }, { id: 3, pos: { lat: 3, lng: 3 } }]
  const h = mount(items, { idOf, positionOf })
  items.length = 1
  h.layer.refresh()
  assert.equal(h.spy.bufferDatas.at(-1).length, FLOATS)
  h.layer.destroy()
})

/* ── Picking jerárquico: el índice LOCAL que la capa empaqueta en los canales b,a ── */

// El reparto obj(14)/chunk(6)/local(12) le deja al vértice 12 bits, con la convención `local + 1` (el 0
// significa «el objeto, pero no un vértice»). El chunk lo suma el pase en el nibble ALTO de b, así que
// el invariante que la capa no puede romper es que su b nunca pase de 15.
const CANALES = 4097   // dos chunks: 4.095 entradas + el arranque del siguiente

test('picking — el índice local se empaqueta en 12 bits con la convención +1 y vuelve a empezar por chunk', () => {
  const items = Array.from({ length: CANALES }, (_, i) => ({ id: i + 1, pos: { lat: i * 1e-3, lng: i * 1e-3 } }))
  const h     = mount(items, { idOf, positionOf })
  const byte  = (i, k) => Math.round(h.verts()[i * FLOATS + k] * 255)
  const canal = i => ({ b: byte(i, 4), a: byte(i, 5) })

  assert.deepEqual(canal(0), { b: 0, a: 1 }, 'el slot 0 se emite como local 1')
  assert.deepEqual(canal(255), { b: 1, a: 0 }, 'el acarreo al byte alto cae en b')
  assert.deepEqual(canal(4094), { b: 15, a: 255 }, 'última entrada del chunk 0: local 4.095')
  assert.deepEqual(canal(4095), { b: 0, a: 1 }, 'el chunk siguiente arranca de nuevo en local 1')
  assert.deepEqual(canal(4096), { b: 0, a: 2 })
  for (let i = 0; i < CANALES; i++)
    assert.ok(byte(i, 4) <= 15, `slot ${i} desborda los 4 bits altos del local`)
  h.layer.destroy()
})

// Lo que se ve es lo que se pica: el pase recibe la matriz del último dibujo, incluido el de un cuadro
// del zoom animado, que no es la vista de la cámara.
test('picking — el pase pica con la matriz del último dibujo, también la de un cuadro del zoom animado', () => {
  const h = mount([{ id: 'A', pos: { lat: 1, lng: 1 } }], { idOf, positionOf }, { interactive: true })
  h.layer.pickObject = 7

  h.layer.renderAtView(6.5, { lat: 1, lng: 1 })
  const visual = h.log.matrices.at(-1)
  h.layer.resolveClick({ x: 10, y: 10 })
  assert.deepEqual(h.log.matrices.at(-1), visual, 'la matriz del pase es la del cuadro que se ve')
  assert.deepEqual(h.spy.draws.at(-1), { mode: 0, first: 0, count: 1 }, 'y el pase recorre lo que dibuja el visual')
  h.layer.destroy()
})

/* ── Regrow del atlas a mitad del rebuild ── */

// El canal de tile es `índice / (capacidad − 1)`: una variante nueva que hace crecer el atlas a mitad del
// recorrido deja a los slots ya escritos con la capacidad vieja. El tile 1 de un atlas de 2 vale 1; en uno
// de 4, un tercio.
const crecible = () => {
  const atlasDe = capacity => ({ count: 2, cols: 2, rows: 2, tileSize: 2, capacity,
    tileChannel: i => i / (capacity - 1), cellOf: () => ({ col: 0, row: 0 }), tileAt: () => new Uint8Array(16) })
  const set = { ...makeIconSet(), atlas: atlasDe(2) }
  set.resolve = variante => (variante === 'nueva' && set.atlas.capacity === 2 && (set.atlas = atlasDe(4)), 1)
  return set
}

test('rebuild — un regrow a mitad del recorrido re-codifica los slots ya escritos con el atlas final', () => {
  const items = [{ id: 1, pos: { lat: 0, lng: 0 }, v: 'vieja' }, { id: 2, pos: { lat: 1, lng: 1 }, v: 'nueva' }]
  const h = mount(items, { idOf, positionOf, variantOf: it => it.v }, { iconSet: crecible() })
  assert.equal(h.verts()[2], Math.fround(1 / 3), 'el slot 0 lleva el canal del atlas que creció, no el de antes')
  assert.equal(h.verts()[FLOATS + 2], Math.fround(1 / 3))
  h.layer.destroy()
})

/* ── El marco: ancla, vista inyectada y escala del buffer ── */

// La matriz lleva world0 rel-ancla a clip: un punto en el centro de la vista cae en el centro del clip,
// sea la vista de la cámara o una inyectada por cuadro.
const clip = (m, [x, y]) => [m[0] * x + m[12], m[5] * y + m[13]]

test('marco — el punto en el centro de la vista cae en el centro del clip, con la vista viva o la inyectada', () => {
  const items = [{ id: 1, pos: { lat: 0, lng: 0 } }, { id: 2, pos: { lat: 10, lng: 20 } }]
  const h = mount(items, { idOf, positionOf })

  h.layer.resetCanvasReference()
  clip(h.log.matrices.at(-1), xyEn(h, 0)).forEach(c => assert.ok(Math.abs(c) < 1e-6, `el centro de la cámara: ${c}`))

  h.layer.renderAtView(7.25, { lat: 10, lng: 20 })
  clip(h.log.matrices.at(-1), xyEn(h, 1)).forEach(c => assert.ok(Math.abs(c) < 1e-4, `el centro inyectado: ${c}`))
  h.layer.destroy()
})

test('marco — un repintado agendado durante el zoom animado dibuja el cuadro que se ve, hasta que la capa se reasienta', async () => {
  const h = mount([{ id: 1, pos: { lat: 0, lng: 0 } }], { idOf, positionOf })
  await flushRaf()

  h.layer.renderAtView(7.25, { lat: 10, lng: 20 })
  const cuadro = h.log.matrices.at(-1)
  h.layer.redraw()
  await flushRaf()
  assert.deepEqual(h.log.matrices.at(-1), cuadro, 'no la vista de partida de la cámara')

  h.layer.resetCanvasReference()
  h.map.setZoomForTest(8)
  h.layer.redraw()
  await flushRaf()
  const pintada = h.log.matrices.at(-1)
  h.layer.resetCanvasReference()
  assert.deepEqual(pintada, h.log.matrices.at(-1), 'ya asentada, el repintado lee la cámara')
  h.layer.destroy()
})

test('marco — el tamaño va en px del buffer, y se recodifica cuando cambia la escala del buffer', () => {
  const superficie = makeSurface({ dpr: 2 })
  const h = mount([{ id: 1, pos: { lat: 0, lng: 0 } }], { idOf, positionOf }, {}, superficie)
  assert.equal(h.verts()[6], 48, '24 px CSS son 48 px del buffer, la unidad de `gl_PointSize`')

  superficie.clientWidth = 1600                      // misma resolución, otra caja: sin resize no se remide
  h.layer.resetCanvasReference()
  assert.equal(h.rebuilds(), 1, 'con el mismo buffer no se remide: `clientWidth` fuerza layout')

  superficie.width       = 800                       // la ventana pasó a un monitor de DPR 1
  superficie.clientWidth = 800
  h.layer.resetCanvasReference()
  assert.equal(h.verts()[6], 24, 'el buffer cambió de escala: los tamaños se recodifican')
  h.layer.destroy()
})

/* ── La superficie ── */

test('superficie — pide profundidad para el orden por banda y no sigue la transición del zoom', () => {
  const h = mount([{ id: 1, pos: { lat: 0, lng: 0 } }], { idOf, positionOf })
  assert.equal(h.log.attrs.depth, true, 'el contexto nace con profundidad: no se puede pedir después')
  assert.ok(!String(h.log.canvas.className ?? '').includes('leaflet-zoom-animated'), 'el canvas no hereda la transición')

  const anclado = h.log.canvas.style.transform
  h.map.animarZoom(7, { lat: 3, lng: 3 })
  assert.equal(h.log.canvas.style.transform, anclado, 'zoomanim no lo escala: el motor reproyecta por cuadro')
  h.layer.destroy()
})

test('destroy — suelta el contexto y cancela el repintado agendado', async () => {
  const h = mount([{ id: 1, pos: { lat: 0, lng: 0 } }], { idOf, positionOf })
  h.layer.redraw()
  h.layer.destroy()
  await flushRaf()
  assert.equal(h.log.perdidos, 1, 'el contexto vuelve al navegador: el techo de ~16 es acumulativo')
  assert.deepEqual(h.spy.draws, [], 'el cuadro agendado no corre sobre una superficie destruida')
})

/* ── El objeto de `positionOf` no se retiene entre callbacks del consumidor ── */

// `variantOf` que mira la posición de OTRO ítem (variante por cercanía): si la capa retuviera el
// objeto de `positionOf`, el scratch del consumidor ya estaría pisado al leerlo.
const scratchAccessors = (items) => {
  const scratch = { lat: 0, lng: 0 }
  const a = {
    idOf,
    positionOf: (it) => { scratch.lat = it.lat; scratch.lng = it.lng; return scratch },
    variantOf: (it) => (a.positionOf(items[items.length - 1]).lat < 0 ? 'sur' : 'norte'),
  }
  return a
}

test('rebuild — `positionOf` que reusa el objeto no intercambia coordenadas', () => {
  const items = [{ id: 1, lat: 10, lng: 20 }, { id: 2, lat: -30, lng: -40 }]
  const h = mount(items, scratchAccessors(items))

  assert.deepEqual(xyEn(h, 0), xyDe(h.host, 10, 20), 'el punto 1 conserva SU posición')
  assert.deepEqual(xyEn(h, 1), xyDe(h.host, -30, -40))
  h.layer.destroy()
})

test('patch — `positionOf` que reusa el objeto no contamina el slot', () => {
  const items = [{ id: 1, lat: 10, lng: 20 }, { id: 2, lat: -30, lng: -40 }]
  const h = mount(items, scratchAccessors(items))

  items[0].lat = 11
  items[0].lng = 21
  h.source.emitDirty(1)
  assert.deepEqual(xyEn(h, 0), xyDe(h.host, 11, 21))
  h.layer.destroy()
})
