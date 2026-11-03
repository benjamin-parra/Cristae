// `quadTransform`: la matriz se aplica como lo hace CSS —por columnas, con la división por w— y se le pide
// lo que una homografía cumple sin mirar cómo se resolvió: las cuatro esquinas de la caja caen en las de
// destino, y el centro de la caja en el cruce de las diagonales del destino, porque una proyectiva lleva
// rectas a rectas.
import test from 'node:test'
import assert from 'node:assert/strict'
import { quadTransform } from '../../src/render/homography.js'

const aplicar = (m, u, v) => {
  const w = m[3] * u + m[7] * v + m[15]
  return [(m[0] * u + m[4] * v + m[12]) / w, (m[1] * u + m[5] * v + m[13]) / w]
}

const cerca = (real, esperado, tol, msg) =>
  assert.ok(Math.abs(real - esperado) <= tol, `${msg}: ${real} contra ${esperado}`)

const esquinasCaen = (w, h, destino, tol = 1e-6) => {
  const m = quadTransform(w, h, destino)
  ;[[0, 0], [w, 0], [w, h], [0, h]].forEach(([u, v], i) => {
    const [x, y] = aplicar(m, u, v)
    cerca(x, destino[i * 2], tol, `x de la esquina ${i}`)
    cerca(y, destino[i * 2 + 1], tol, `y de la esquina ${i}`)
  })
  return m
}

// El cruce de las diagonales p0–p2 y p1–p3, por la fórmula de dos rectas.
const cruce = d => {
  const [x0, y0, x1, y1, x2, y2, x3, y3] = d
  const den = (x0 - x2) * (y1 - y3) - (y0 - y2) * (x1 - x3)
  const a   = x0 * y2 - y0 * x2
  const b   = x1 * y3 - y1 * x3
  return [(a * (x1 - x3) - (x0 - x2) * b) / den, (a * (y1 - y3) - (y0 - y2) * b) / den]
}

test('una caja da una matriz afín que lleva cada esquina a la suya', () => {
  const m = esquinasCaen(256, 256, [10, 20, 410, 20, 410, 220, 10, 220])
  assert.ok(m[3] === 0 && m[7] === 0, 'sin términos de perspectiva')
  assert.deepEqual([m[0], m[5], m[12], m[13]], [400 / 256, 200 / 256, 10, 20])
})

test('un cuadrilátero en perspectiva: esquinas en su lugar y el centro en el cruce de las diagonales', () => {
  const destino = [0, 0, 300, 40, 260, 260, 20, 200]
  const m       = esquinasCaen(256, 128, destino)
  const [cx, cy] = aplicar(m, 128, 64)
  const [ex, ey] = cruce(destino)
  cerca(cx, ex, 1e-9, 'x del centro')
  cerca(cy, ey, 1e-9, 'y del centro')
  assert.notEqual(m[3], 0, 'la perspectiva no es afín')
})

test('el sentido inverso es convexo y da la imagen espejada', () => {
  esquinasCaen(256, 256, [400, 0, 0, 0, 0, 300, 400, 300])
})

test('un cuadrilátero sin área, cóncavo o en moño lanza TypeError', () => {
  const malos = {
    degenerado : [0, 0, 100, 0, 200, 0, 50, 0],
    colapsado  : [0, 0, 100, 0, 100, 0, 0, 100],
    concavo    : [0, 0, 100, 0, 30, 30, 0, 100],
    moño       : [0, 0, 100, 100, 100, 0, 0, 100],
    noFinito   : [0, 0, NaN, 0, 100, 100, 0, 100],
  }
  Object.entries(malos).forEach(([nombre, d]) =>
    assert.throws(() => quadTransform(256, 256, d), TypeError, nombre))
})

test('esquinas a 10⁷ px del origen devuelven las de destino con error < 0,01 px', () => {
  const lejos = 1e7
  esquinasCaen(256, 256, [lejos, lejos, lejos + 900, lejos + 30, lejos + 870, lejos + 700, lejos - 40, lejos + 650], 0.01)
  esquinasCaen(256, 256, [-lejos, lejos, -lejos + 5e6, lejos, -lejos + 5e6, lejos + 4e6, -lejos, lejos + 4e6], 0.01)
})

// mulberry32, como test/geojson/fuzz.test.mjs: la misma secuencia en cualquier runtime.
const generador = semilla => () => {
  let t = (semilla = (semilla + 0x6D2B79F5) | 0)
  t = Math.imul(t ^ (t >>> 15), 1 | t)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

// Convexo con los cuatro giros del mismo signo, calculado acá y no con el de la función.
const convexo = d => {
  const giros = [0, 1, 2, 3].map(i => {
    const [a, b, c] = [i, (i + 1) % 4, (i + 2) % 4]
    return (d[b * 2] - d[a * 2]) * (d[c * 2 + 1] - d[b * 2 + 1]) - (d[b * 2 + 1] - d[a * 2 + 1]) * (d[c * 2] - d[b * 2])
  })
  return giros.every(g => g > 1) || giros.every(g => g < -1)
}

test('un barrido de cuadriláteros convexos al azar cumple el oráculo sin NaN (semilla fija)', () => {
  const rng = generador(0x1A6E)
  let probados = 0
  while (probados < 500) {
    const escala  = 10 ** (rng() * 6)
    const destino = Array.from({ length: 8 }, () => (rng() - 0.5) * escala)
    if (!convexo(destino)) continue
    const w = 1 + rng() * 1000
    const h = 1 + rng() * 1000
    const m = esquinasCaen(w, h, destino, escala * 1e-9)
    assert.ok(m.every(Number.isFinite), 'sin NaN ni infinitos')
    const [cx, cy] = aplicar(m, w / 2, h / 2)
    const [ex, ey] = cruce(destino)
    cerca(cx, ex, escala * 1e-9, 'x del centro')
    cerca(cy, ey, escala * 1e-9, 'y del centro')
    probados++
  }
})
