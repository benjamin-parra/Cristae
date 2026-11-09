// La colocación cacheada de los rótulos, con un miembro doble y una medida sobre un contexto falso. Los
// trazos se escriben en px y se pasan a lat/lng con la inversa de la proyección, así cada caso se lee en
// la pantalla. Fija el hit por glifo (el hueco de una curva no pica), el marco corrido, la colocación sin
// medida (html), que el búfer no depende del renderer y que `hitsAt` y la lectura no asignan.
import test from 'node:test'
import assert from 'node:assert/strict'
import { bytesPorLlamada } from '../../test-helpers/asignaciones.mjs'
import { createLayout, readLabelView } from '../../src/render/labelLayout.js'
import { mergeLabelOptions, resolvePlacement } from '../../src/render/labelOptions.js'
import { createMeasure } from '../../src/render/labelText.js'

// Cada punto de código mide 7 px; la caja de la fuente, 8 arriba y 2 abajo.
const ctx     = { font: '', measureText: s => ({ width: 7 * [...s].length, fontBoundingBoxAscent: 8, fontBoundingBoxDescent: 2 }) }
const camera  = { center: () => ({ lat: 0, lng: 0 }), size: () => ({ x: 800, y: 600 }), zoom: () => 3, frameOrigin: () => ({ x: 0, y: 0 }) }
const VIEW    = readLabelView(camera, {})
const ORIGIN  = { x: 0, y: 0 }
const D       = 180 / Math.PI

// px del contenedor → [lat, lng] en la vista de los tests.
const ll = (x, y) => {
  const wx = (x - VIEW.hw) / VIEW.scale + VIEW.cx
  const wy = (y - VIEW.hh) / VIEW.scale + VIEW.cy
  return [(2 * Math.atan(Math.exp((0.5 - wy / 256) * 2 * Math.PI)) - Math.PI / 2) * D, (wx / 256 - 0.5) * 360]
}
const line = (...pts) => pts.map(([x, y]) => ll(x, y))

const member = ({ kind = 'line', items, opts = {}, version = 1, curve = null, onPath }) => {
  const merged = mergeLabelOptions(null, opts)
  return {
    id        : 'm',
    kind,
    placement : resolvePlacement(kind, merged),
    opts      : merged,
    version,
    visible   : true,
    curve,
    forEach   : (fn, arg) => items.forEach(it => fn(arg, it, it.id, it.text)),
    pathOf    : it => (onPath?.(it), it.path),
    anchorOf  : (it, out) => {
      const [lat, lng] = ll(it.x, it.y)
      out.lat = lat
      out.lng = lng
      out.w   = 20
      out.h   = 20
      return out
    },
    alphaOf   : () => 1,
    isHovered : () => false,
  }
}

const measure = () => createMeasure(ctx)
const hits    = (layout, x, y, origin = ORIGIN) => layout.hitsAt({ x, y }, origin, []).map(p => p.id)
const glyphAt = (layout, g) => [layout.glyphs[4 * g], layout.glyphs[4 * g + 1], layout.glyphs[4 * g + 2], layout.glyphs[4 * g + 3]]
const near    = (a, b, tol = 1e-3) => Math.abs(a - b) <= tol

test('readLabelView: centro en world0, escala, tamaños y origen del marco', () => {
  const v = readLabelView({ ...camera, frameOrigin: () => ({ x: 12, y: -4 }) }, {})
  assert.deepEqual(v, { cx: 128, cy: 128, scale: 8, w: 800, h: 600, hw: 400, hh: 300, ox: 12, oy: -4 })
})

test('along: los grafemas en fila sobre una recta, con su unidad, su ítem y su caja', () => {
  const m = member({ items: [{ id: 'R1', text: 'abc', path: line([100, 300], [700, 300]) }] })
  const l = createLayout().place(m, VIEW, measure())
  assert.equal(l.placementCount, 1)
  assert.equal(l.glyphCount, 3)
  assert.deepEqual([...l.spans.slice(0, 3)], [0, 3, 0])
  ;[0, 1, 2].forEach(g => {
    const [x, y, a, u] = glyphAt(l, g)
    assert.ok(near(x, 400 - 10.5 + 3.5 + 7 * g) && near(y, 300) && a === 0 && u === g, `glifo ${g}`)
  })
  assert.deepEqual(l.ids, ['R1'])
  assert.equal(l.texts[0].text, 'abc')
  assert.deepEqual(hits(l, 400, 302), ['R1'])
  assert.deepEqual(hits(l, 400, 310), [])
})

test('along: el hueco de una curva cae en la caja de la colocación y no pica', () => {
  const arc = []
  for (let deg = 200; deg <= 340; deg += 2) arc.push([400 + 100 * Math.cos(deg / D), 300 + 100 * Math.sin(deg / D)])
  const l = createLayout().place(member({ items: [{ id: 'C', text: 'abcdefghijklmn', path: line(...arc) }] }), VIEW, measure())
  assert.equal(l.placementCount, 1)
  const [cx, cy, , hw, hh] = l.boxes.slice(0, 5)
  const [x, y] = [400, 214]                               // bajo la cima del arco, entre sus extremos
  assert.ok(Math.abs(x - cx) <= hw && Math.abs(y - cy) <= hh, 'la caja alineada cubre el hueco')
  assert.deepEqual(hits(l, x, y), [])
  const [gx, gy] = glyphAt(l, 7)
  assert.deepEqual(hits(l, gx, gy), ['C'])
})

test('marco corrido: hitsAt descuenta el corrimiento del origen desde place', () => {
  const l      = createLayout().place(member({ items: [{ id: 'R1', text: 'abc', path: line([100, 300], [700, 300]) }] }), VIEW, measure())
  const [x, y] = glyphAt(l, 1)
  const moved  = { x: 0, y: 300 }
  assert.deepEqual(hits(l, x, y - 300, moved), ['R1'])
  assert.deepEqual(hits(l, x, y, moved), [])
})

test('repeat: varias colocaciones del mismo ítem dan una sola parte; dos ítems, dos', () => {
  const m = member({
    opts  : { repeat: 100 },
    items : [
      { id: 'A', text: 'ab', path: line([0, 300], [800, 300]) },
      { id: 'B', text: 'cd', path: line([400, 0], [400, 600]) },
    ],
  })
  const l = createLayout().place(m, VIEW, measure())
  assert.ok(l.placementCount > 4)
  const spans = Array.from({ length: l.placementCount }, (_, i) => l.spans[3 * i + 2])
  assert.deepEqual(spans, [...spans].sort(), 'contiguas por ítem')
  assert.deepEqual(hits(l, 50, 300), ['A'])
  const [x, y] = glyphAt(l, l.spans[3 * spans.indexOf(1)])
  assert.deepEqual(hits(l, x, y), ['B'])
})

test('sin medida (html): una colocación por parte, sin glifos, girada según la tangente', () => {
  const m = member({
    opts  : { htmlOf: () => '<b>x</b>' },
    items : [{ id: 'D', text: 'diag', path: line([300, 400], [500, 200]) }, { id: 'O', text: 'oeste', path: line([600, 500], [200, 500]) }],
  })
  const l = createLayout().place(m, VIEW, null)
  assert.equal(l.placementCount, 2)
  assert.equal(l.glyphCount, 0)
  assert.deepEqual([l.spans[1], l.spans[4]], [0, 0])
  assert.deepEqual(l.texts, ['diag', 'oeste'])
  assert.ok(near(l.boxes[2], -Math.PI / 4, 1e-6), 'sube hacia la derecha')
  assert.ok(near(l.boxes[7], 0), 'hacia el oeste se da vuelta para leerse')
  assert.ok(near(l.anchors[0], 400) && near(l.anchors[1], 300) && near(l.anchors[3], 500))
  assert.deepEqual(hits(l, 400, 300), [], 'sin caja medida no pica')
  l.size(0, 40, 10)
  const along = 15 / Math.SQRT2
  assert.deepEqual(hits(l, 400 + along, 300 - along), ['D'])
  assert.deepEqual(hits(l, 400 + along, 300 + along), [], 'a 15 px de través ya no')
})

test('sin medida, offset corre el ancla hacia arriba del sentido de lectura', () => {
  const l = createLayout().place(member({ opts: { renderer: 'html', offset: 6 }, items: [{ id: 'O', text: 'o', path: line([600, 500], [200, 500]) }] }), VIEW, null)
  assert.ok(near(l.anchors[1], 494))
})

test('el búfer no depende del renderer: la colocación no lo recibe y se repite igual', () => {
  assert.equal(createLayout.length, 0)
  const m      = member({ opts: { repeat: 120, offset: 4 }, items: [{ id: 'A', text: 'ruta 68', path: line([50, 100], [400, 350], [760, 120]) }] })
  const shared = measure()
  const a      = createLayout()
  const b      = createLayout()
  assert.equal(a.place.length, 3)
  a.place(m, VIEW, shared)
  b.place(m, VIEW, measure())
  assert.ok(a.glyphCount > 0)
  assert.deepEqual(a.glyphs.slice(0, 4 * a.glyphCount), b.glyphs.slice(0, 4 * b.glyphCount))
  assert.deepEqual(a.spans.slice(0, 3 * a.placementCount), b.spans.slice(0, 3 * b.placementCount))
  assert.deepEqual(a.boxes.slice(0, 5 * a.placementCount), b.boxes.slice(0, 5 * b.placementCount))
})

test('puntos: below apoya la caja bajo el ícono, right a su derecha; texto en fila y derecho', () => {
  const items = [{ id: 'P', text: 'ab', x: 200, y: 200 }]
  const below = createLayout().place(member({ kind: 'point', items }), VIEW, measure())
  assert.deepEqual([...below.boxes.slice(0, 5)].map(v => Math.round(v * 1000) / 1000), [200, 219, 0, 7, 5])
  assert.ok(near(below.anchors[1], 214))
  const right = createLayout().place(member({ kind: 'point', items, opts: { placement: 'right' } }), VIEW, measure())
  assert.ok(near(right.boxes[0], 214 + 7) && near(right.boxes[1], 200))
  assert.ok(near(glyphAt(right, 0)[0], 214 + 3.5) && near(glyphAt(right, 1)[0], 214 + 10.5))
  assert.deepEqual(hits(right, 216, 203), ['P'])
  assert.deepEqual(right.items, items)
})

test('size con esquina: la caja de un pintor, alineada; vacía, no pica', () => {
  const l = createLayout().place(member({ kind: 'point', items: [{ id: 'P', text: 'ab', x: 200, y: 200 }], opts: { paint: () => {} } }), VIEW, measure())
  assert.ok(near(l.anchors[0], 200) && near(l.anchors[1], 200), 'paint recibe el punto del ítem')
  l.size(0, 60, 22, 170, 222)
  assert.deepEqual(hits(l, 225, 240), ['P'])
  assert.deepEqual(hits(l, 200, 200), [])
  assert.ok(near(l.anchors[1], 200), 'el ancla no se mueve')
  l.size(0, 0, 0)
  assert.deepEqual(hits(l, 225, 240), [])
})

test('líneas con center: a mitad del largo de cada parte, horizontal', () => {
  const l = createLayout().place(member({ opts: { placement: 'center' }, items: [{ id: 'L', text: 'ab', path: line([100, 100], [100, 300], [300, 300]) }] }), VIEW, measure())
  assert.equal(l.placementCount, 1)
  assert.ok(near(l.boxes[0], 100) && near(l.boxes[1], 300) && l.boxes[2] === 0)
})

test('polígonos: center en el polo, calculado una vez por versión; along sobre el anillo cerrado', () => {
  let reads = 0
  const ring  = line([100, 100], [300, 100], [300, 300], [100, 300])
  const items = [{ id: 'G', text: 'zona', path: ring }]
  const l     = createLayout()
  l.place(member({ kind: 'polygon', items, onPath: () => reads++ }), VIEW, measure())
  assert.ok(Math.abs(l.anchors[0] - 200) < 3 && Math.abs(l.anchors[1] - 200) < 3)
  const m = member({ kind: 'polygon', items, onPath: () => reads++ })
  l.place(m, VIEW, measure())
  l.place(m, VIEW, measure())
  assert.equal(reads, 2, 'otro miembro recalcula; el mismo con la misma versión, no')
  m.version++
  l.place(m, VIEW, measure())
  assert.equal(reads, 3)
  const a = createLayout().place(member({ kind: 'polygon', opts: { placement: 'along', repeat: 100 }, items }), VIEW, measure())
  assert.ok(a.placementCount >= 7, 'repite por los cuatro lados y por la arista de cierre')
})

test('con medida, lo que cae lejos de la vista no se coloca; sin medida, sí', () => {
  const items = [{ id: 'F', text: 'lejos', x: 3000, y: 200 }]
  assert.equal(createLayout().place(member({ kind: 'point', items }), VIEW, measure()).placementCount, 0)
  assert.equal(createLayout().place(member({ kind: 'point', items }), VIEW, null).placementCount, 1)
})

test('recolocar con menos ítems acorta ids, items y texts', () => {
  const l = createLayout()
  l.place(member({ kind: 'point', items: [{ id: 'a', text: 'a', x: 1, y: 1 }, { id: 'b', text: 'b', x: 2, y: 2 }] }), VIEW, measure())
  l.place(member({ kind: 'point', items: [{ id: 'c', text: 'c', x: 1, y: 1 }] }), VIEW, measure())
  assert.deepEqual([l.ids, l.items.length, l.texts.length, l.placementCount], [['c'], 1, 1, 1])
})

// SPECS §14: se cuentan los bytes asignados en la generación joven, con calentamiento (el medidor está en
// test-helpers/asignaciones.mjs). Una asignación por llamada son al menos 16 bytes.

test('cero asignaciones en hitsAt y en la lectura', () => {
  const arc = []
  for (let deg = 200; deg <= 340; deg += 2) arc.push([400 + 100 * Math.cos(deg / D), 300 + 100 * Math.sin(deg / D)])
  const m = member({
    opts  : { repeat: 60 },
    items : [{ id: 'C', text: 'curva', path: line(...arc) }, { id: 'R', text: 'recta', path: line([0, 450], [800, 450]) }],
  })
  const l      = createLayout().place(m, VIEW, measure())
  const sample = { x: 0, y: 0 }
  const acc    = { sum: 0.5 }
  // `length = 0` le hace soltar a V8 el almacenamiento del arreglo, y el `push` siguiente lo vuelve a
  // pedir: un centinela en la casilla 0 deja medir sólo lo que asigna `hitsAt`.
  const out      = [null]
  const [gx, gy] = glyphAt(l, 2)
  const hit = i => {
    sample.x   = i & 1 ? gx : 400
    sample.y   = i & 1 ? gy : 214
    out.length = 1
    l.hitsAt(sample, ORIGIN, out)
  }
  // La suma va a un campo y no a una variable capturada, que encajonaría cada double.
  const read = () => {
    let sum = 0
    for (let i = 0; i < l.placementCount; i++) {
      const first = l.spans[3 * i]
      const text  = l.texts[l.spans[3 * i + 2]]
      sum += l.boxes[5 * i] + l.anchors[2 * i] + l.ids.length + text.total
      for (let g = first; g < first + l.spans[3 * i + 1]; g++) sum += l.glyphs[4 * g] + text.widths[l.glyphs[4 * g + 3]]
    }
    acc.sum = sum
  }
  hit(1)
  assert.deepEqual(out.slice(1).map(p => p.id), ['C'])
  assert.ok(bytesPorLlamada(hit, 20_000, { calentar: 300_000 }) < 2, 'hitsAt')
  assert.ok(bytesPorLlamada(read, 20_000, { calentar: 300_000 }) < 2, 'lectura')
  assert.ok(acc.sum > 0)
})
