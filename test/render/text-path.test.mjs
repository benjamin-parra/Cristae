// `placeGlyphs` sin canvas: oráculos a mano sobre rectas y una L, y propiedades sobre polilíneas al azar
// con semilla fija. Las propiedades no repiten el cálculo: comparan la salida consigo misma bajo una
// transformación (invertir el path, trasladarlo) o contra un recorrido lineal escrito acá.
import test from 'node:test'
import assert from 'node:assert/strict'
import { placeGlyphs } from '../../src/render/textPath.js'

// Vértices [[x, y], …] → { xy, cum } como los arma la capa.
const path = (...parts) => {
  const pts = parts.flat()
  const xy  = new Float64Array(pts.length * 2)
  const cum = new Float64Array(pts.length)
  let from = 0
  parts.forEach(part => {
    part.forEach(([x, y], i) => {
      const k = from + i
      xy[2 * k]     = x
      xy[2 * k + 1] = y
      cum[k]        = i ? cum[k - 1] + Math.hypot(x - part[i - 1][0], y - part[i - 1][1]) : 0
    })
    from += part.length
  })
  return { xy, cum }
}

const place = (pts, widths, opts = {}, out = { buf: new Float64Array(3) }) => {
  const { xy, cum } = path(pts)
  const count = placeGlyphs(xy, cum, 0, pts.length, widths, opts, out)
  return { count, out, glyphs: Array.from({ length: count }, (_, i) => out.buf.slice(3 * i, 3 * i + 3)) }
}

const close = (actual, expected, msg) => assert.ok(Math.abs(actual - expected) < 1e-6, `${msg}: ${actual} ≠ ${expected}`)
const sameAngle = (a, b, msg) => close(Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b))), 0, msg)

test('recta horizontal: ángulo 0 y centros equiespaciados por el ancho', () => {
  const { count, glyphs } = place([[0, 0], [100, 0]], [10, 10, 10])
  assert.equal(count, 3)
  assert.deepEqual(glyphs.map(([x, y, a]) => [x, y, a]), [[40, 0, 0], [50, 0, 0], [60, 0, 0]])
})

test('recta hacia el oeste: con auto se da vuelta y queda derecha; con path sigue el sentido', () => {
  const auto = place([[100, 0], [0, 0]], [10, 10, 10])
  assert.deepEqual(auto.glyphs.map(([x, , a]) => [x, a]), [[40, 0], [50, 0], [60, 0]])

  const seguida = place([[100, 0], [0, 0]], [10, 10, 10], { orientation: 'path' })
  assert.deepEqual(seguida.glyphs.map(([x]) => x), [60, 50, 40])
  seguida.glyphs.forEach(([, , a]) => close(Math.abs(a), Math.PI, 'ángulo π'))
})

test('L de 90°: se omite con maxAngle 45 y se coloca con 120', () => {
  const ele = [[0, 0], [50, 0], [50, 50]]
  assert.equal(place(ele, [10, 10, 10], { maxAngle: 45 }).count, 0)
  assert.equal(place(ele, [10, 10, 10], { maxAngle: 120 }).count, 3)
})

test('repeat: una colocación por cada `repeat` que cabe, centrada en repeat/2 + k·repeat', () => {
  const { count, glyphs } = place([[0, 0], [1000, 0]], [10, 10, 10, 10, 10], { repeat: 200 })
  assert.equal(count, 5 * 5)
  assert.deepEqual(glyphs.filter((_, i) => i % 5 === 2).map(([x]) => x), [100, 300, 500, 700, 900])
})

test('repeat menor que el texto: la que pisaría a la anterior se omite', () => {
  const { count, glyphs } = place([[0, 0], [100, 0]], [10, 10, 10], { repeat: 20 })
  const centros = glyphs.filter((_, i) => i % 3 === 1).map(([x]) => x)
  assert.equal(count, centros.length * 3)
  centros.slice(1).forEach((c, i) => assert.ok(c - centros[i] >= 30, `separadas al menos el ancho: ${centros}`))
})

test('offset: distancia perpendicular exacta, positivo arriba del sentido de lectura', () => {
  const este = place([[0, 0], [100, 0]], [10, 10], { offset: 6 })
  este.glyphs.forEach(([, y]) => assert.equal(y, -6))

  const diagonal = place([[0, 0], [60, 80]], [10, 10], { offset: -4 })
  diagonal.glyphs.forEach(([x, y]) => close(Math.abs(80 * x - 60 * y) / 100, 4, 'distancia a la recta'))
})

test('texto más largo que la parte: no se coloca', () => {
  assert.equal(place([[0, 0], [25, 0]], [10, 10, 10]).count, 0)
  assert.equal(place([[0, 0], [25, 0]], [10, 10, 10], { placement: 'start' }).count, 0)
})

test('start: el texto arranca en el inicio de la parte', () => {
  const { glyphs } = place([[0, 0], [100, 0]], [10, 10], { placement: 'start' })
  assert.deepEqual(glyphs.map(([x]) => x), [5, 15])
})

test('multi-parte: una colocación por parte, cada una sobre su rango', () => {
  const { xy, cum } = path([[0, 0], [100, 0]], [[0, 50], [100, 50]])
  const out = { buf: new Float64Array(3) }
  assert.equal(placeGlyphs(xy, cum, 0, 2, [10], {}, out), 1)
  assert.deepEqual([...out.buf.slice(0, 2)], [50, 0])
  assert.equal(placeGlyphs(xy, cum, 2, 2, [10], {}, out), 1)
  assert.deepEqual([...out.buf.slice(0, 2)], [50, 50])
})

test('`out` se reusa: misma referencia y sin crecer en la segunda llamada', () => {
  const out = { buf: new Float64Array(3) }
  place([[0, 0], [1000, 0]], [10, 10], { repeat: 100 }, out)
  const buf = out.buf
  assert.ok(buf.length >= 10 * 2 * 3)
  place([[0, 0], [1000, 0]], [10, 10], { repeat: 100 }, out)
  assert.equal(out.buf, buf)
})

test('vertical exacta hacia el norte y hacia el sur: mismos ángulos y posiciones', () => {
  const norte = place([[0, 100], [0, 0]], [10, 10, 10])
  const sur   = place([[0, 0], [0, 100]], [10, 10, 10])
  assert.deepEqual(norte.glyphs, sur.glyphs)
  sur.glyphs.forEach(([, , a]) => assert.equal(a, Math.PI / 2))
})

test('rectas a +179° y −179°: ambas quedan derechas (el caso que rompía el ángulo medio)', () => {
  const r = 179 * Math.PI / 180
  ;[r, -r].forEach(rumbo => {
    const { count, glyphs } = place([[0, 0], [100 * Math.cos(rumbo), 100 * Math.sin(rumbo)]], [10, 10, 10])
    assert.equal(count, 3)
    glyphs.forEach(([, , a]) => assert.ok(Math.abs(a) < 2 * Math.PI / 180, `rumbo ${rumbo}: ángulo ${a}`))
  })
})

test('culling: la colocación cuyo punto medio cae lejos de la vista se omite', () => {
  assert.equal(place([[5000, 0], [5100, 0]], [10], { viewW: 800, viewH: 600 }).count, 0)
  assert.equal(place([[0, 0], [100, 0]], [10], { viewW: 800, viewH: 600 }).count, 1)
  // Una parte enorme con repeat: sólo quedan las colocaciones cerca de la vista.
  const { count } = place([[-1e6, 300], [1e6, 300]], [10, 10], { repeat: 200, viewW: 800, viewH: 600 })
  assert.ok(count > 0 && count <= 2 * 10, `colocaciones cerca de la vista: ${count / 2}`)
})

/* ── Propiedades, sobre polilíneas al azar con semilla fija ── */

const SEMILLA = 0x7e47
const CASOS   = 400

const mulberry32 = seed => () => {
  seed = seed + 0x6D2B79F5 | 0
  let t = Math.imul(seed ^ seed >>> 15, 1 | seed)
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
  return ((t ^ t >>> 14) >>> 0) / 4294967296
}

const casos = () => {
  const rnd = mulberry32(SEMILLA)
  return Array.from({ length: CASOS }, () => ({
    pts    : Array.from({ length: 2 + Math.floor(rnd() * 6) }, () => [rnd() * 500, rnd() * 500]),
    widths : Array.from({ length: 1 + Math.floor(rnd() * 6) }, () => 4 + rnd() * 8),
    offset : rnd() * 20 - 10,
    shift  : [rnd() * 2000 - 1000, rnd() * 2000 - 1000],
  }))
}

// El punto a la distancia `s` del inicio, por recorrido lineal: independiente de la búsqueda binaria.
const walk = (pts, s) => {
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1]
    const [bx, by] = pts[i]
    const d = Math.hypot(bx - ax, by - ay)
    if (s <= d || i === pts.length - 1) return [ax + (bx - ax) * s / d, ay + (by - ay) * s / d]
    s -= d
  }
}
const lengthOf = pts => pts.slice(1).reduce((sum, [x, y], i) => sum + Math.hypot(x - pts[i][0], y - pts[i][1]), 0)
const sum = ws => ws.reduce((a, w) => a + w, 0)

test('(a) con auto y center, invertir los vértices da las mismas posiciones y ángulos', () => {
  let colocados = 0
  casos().forEach(({ pts, widths, offset }, n) => {
    const opts   = { offset, maxAngle: 170 }
    const ida    = place(pts, widths, opts)
    const vuelta = place([...pts].reverse(), widths, opts)
    assert.equal(vuelta.count, ida.count, `caso ${n}`)
    ida.glyphs.forEach(([x, y, a], i) => {
      close(vuelta.glyphs[i][0], x, `caso ${n} x`)
      close(vuelta.glyphs[i][1], y, `caso ${n} y`)
      sameAngle(vuelta.glyphs[i][2], a, `caso ${n} ángulo`)
    })
    colocados += ida.count > 0
  })
  assert.ok(colocados > CASOS / 4, `el barrido coloca texto en una parte de los casos: ${colocados}`)
})

test('(b) trasladar el path traslada la salida y no cambia los ángulos', () => {
  casos().forEach(({ pts, widths, offset, shift: [dx, dy] }, n) => {
    const opts   = { offset, maxAngle: 170 }
    const base   = place(pts, widths, opts)
    const movido = place(pts.map(([x, y]) => [x + dx, y + dy]), widths, opts)
    assert.equal(movido.count, base.count, `caso ${n}`)
    base.glyphs.forEach(([x, y, a], i) => {
      close(movido.glyphs[i][0], x + dx, `caso ${n} x`)
      close(movido.glyphs[i][1], y + dy, `caso ${n} y`)
      sameAngle(movido.glyphs[i][2], a, `caso ${n} ángulo`)
    })
  })
})

test('(c) en una parte recta, cada glifo queda a |offset| de la recta', () => {
  casos().forEach(({ pts: [[ax, ay], [bx, by]], widths, offset }, n) => {
    const { glyphs } = place([[ax, ay], [bx, by]], widths, { offset, repeat: 40 })
    const len = Math.hypot(bx - ax, by - ay)
    glyphs.forEach(([x, y]) =>
      close(Math.abs((bx - ax) * (y - ay) - (by - ay) * (x - ax)) / len, Math.abs(offset), `caso ${n}`))
  })
})

test('(d) con auto, la colocación se lee desde el extremo izquierdo de su cuerda', () => {
  casos().forEach(({ pts, widths }, n) => {
    const { count, glyphs } = place(pts, widths, { maxAngle: 170 })
    if (!count) return
    const total    = sum(widths)
    const s0       = (lengthOf(pts) - total) / 2
    const [hx, hy] = walk(pts, s0)
    const [tx, ty] = walk(pts, s0 + total)
    const recta    = tx - hx > 0 || tx - hx === 0 && ty - hy > 0
    const [ex, ey] = walk(pts, recta ? s0 + widths[0] / 2 : s0 + total - widths[0] / 2)
    close(glyphs[0][0], ex, `caso ${n} x del primer glifo`)
    close(glyphs[0][1], ey, `caso ${n} y del primer glifo`)
  })
})

test('(e) sin NaN y sin escribir más allá de `count`', () => {
  casos().forEach(({ pts, widths, offset }, n) => {
    const out = { buf: new Float64Array(4096).fill(777) }
    const { count } = place(pts, widths, { offset, repeat: 30, maxAngle: 90 }, out)
    out.buf.slice(0, count * 3).forEach(v => assert.ok(Number.isFinite(v), `caso ${n}`))
    assert.ok(out.buf.slice(count * 3).every(v => v === 777), `caso ${n}: escribió fuera de count`)
  })
})

test('una parte de menos de 2 vértices o sin glifos no coloca nada', () => {
  assert.equal(place([[0, 0]], [10]).count, 0)
  assert.equal(place([[0, 0], [100, 0]], []).count, 0)
})
