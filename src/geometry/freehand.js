// El trazo a mano alzada hecho curva: un muestreo grueso del puntero, en píxeles, pasa a una polilínea
// suave y editable. Es un horneado de una vez, al soltar, así que asigna sin cuidado. Interno: ningún
// entry lo exporta, y sus tolerancias son de pantalla y no se piden.
//
// Tres pasos: Douglas–Peucker quita lo que no se aparta de la recta más que `TOLERANCE`; una
// Catmull-Rom centrípeta —α = ½, la que no hace lazos ni cúspides dentro de un tramo— pasa por los que
// quedan; y cada tramo se parte lo justo para que su cuerda no se aparte de la curva más que `SAGITTA`.

import { distSqToSegment } from './polyline.js'

const TOLERANCE = 2   // px: lo que el trazo se puede apartar de la recta que lo resume
const SAGITTA   = 1   // px: lo que la polilínea se puede apartar de la curva. Subpíxel saturaría el modo `edit`

// La raíz de la distancia: el intervalo de la parametrización centrípeta.
const knot = (dx, dy) => Math.hypot(dx, dy) ** 0.5

// Los vértices de `xy` (intercalado [x, y, …], sin repetidos seguidos) por una curva suave, intercalada
// igual. Abierta: pasa por el primero y el último. Cerrada: es periódica y no repite el primero al final.
// Cerrada con menos de tres vértices tras simplificar no hay curva, y devuelve los que quedan.
export const bake = (xy, closed) => {
  const p = []
  for (let i = 0; i < xy.length; i += 2)
    if (!p.length || xy[i] !== p[p.length - 2] || xy[i + 1] !== p[p.length - 1]) p.push(xy[i], xy[i + 1])
  if (p.length < (closed ? 6 : 4)) return p

  // Douglas–Peucker. Un anillo vuelve a su origen: se parte en el vértice más lejano de él.
  const q    = closed ? [...p, p[0], p[1]] : p
  const m    = q.length / 2
  const keep = new Uint8Array(m)
  keep[0] = keep[m - 1] = 1
  const runs = []
  if (!closed) runs.push(0, m - 1)
  else {
    let far = 1, most = -1
    for (let k = 1; k < m - 1; k++) {
      const d = (q[2 * k] - q[0]) ** 2 + (q[2 * k + 1] - q[1]) ** 2
      if (d > most) {
        most = d
        far  = k
      }
    }
    keep[far] = 1
    runs.push(0, far, far, m - 1)
  }
  while (runs.length) {
    const j = runs.pop(), i = runs.pop()
    let at = -1, worst = TOLERANCE ** 2
    for (let k = i + 1; k < j; k++) {
      const d = distSqToSegment(q[2 * k], q[2 * k + 1], q[2 * i], q[2 * i + 1], q[2 * j], q[2 * j + 1])
      if (d > worst) {
        worst = d
        at    = k
      }
    }
    if (at >= 0) {
      keep[at] = 1
      runs.push(i, at, at, j)
    }
  }
  const s = []
  keep.forEach((k, i) => k && i < (closed ? m - 1 : m) && s.push(q[2 * i], q[2 * i + 1]))
  const n = s.length / 2
  if (closed && n < 3) return s

  // Catmull-Rom centrípeta, un tramo de Hermite por par de vértices, pasada a Bézier cúbica. Más allá de
  // los extremos de una abierta, el vecino es el reflejo del otro lado.
  const out = []
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const j1 = (i + 1) % n
    const j0 = closed ? (i + n - 1) % n : i - 1
    const j3 = closed ? (i + 2) % n : i + 2
    const x1 = s[2 * i], y1 = s[2 * i + 1], x2 = s[2 * j1], y2 = s[2 * j1 + 1]
    const x0 = j0 < 0 ? 2 * x1 - x2 : s[2 * j0], y0 = j0 < 0 ? 2 * y1 - y2 : s[2 * j0 + 1]
    const x3 = j3 >= n ? 2 * x2 - x1 : s[2 * j3], y3 = j3 >= n ? 2 * y2 - y1 : s[2 * j3 + 1]
    const a  = knot(x1 - x0, y1 - y0), b = knot(x2 - x1, y2 - y1), c = knot(x3 - x2, y3 - y2)
    // Las tangentes de Hermite sobre [0, 1] son b·(…), y los puntos de control de la Bézier, un tercio.
    const bx1 = x1 + b * ((x1 - x0) / a - (x2 - x0) / (a + b) + (x2 - x1) / b) / 3
    const by1 = y1 + b * ((y1 - y0) / a - (y2 - y0) / (a + b) + (y2 - y1) / b) / 3
    const bx2 = x2 - b * ((x2 - x1) / b - (x3 - x1) / (b + c) + (x3 - x2) / c) / 3
    const by2 = y2 - b * ((y2 - y1) / b - (y3 - y1) / (b + c) + (y3 - y2) / c) / 3
    // |B″| ≤ 6·M, y un trozo de ancho 1/k se aparta de su cuerda a lo más (1/k)²·6M/8: con
    // k = ⌈√(¾M / SAGITTA)⌉ la polilínea queda a SAGITTA de la curva.
    const M = Math.max(Math.hypot(x1 - 2 * bx1 + bx2, y1 - 2 * by1 + by2), Math.hypot(bx1 - 2 * bx2 + x2, by1 - 2 * by2 + y2))
    const k = Math.max(1, Math.ceil(Math.sqrt(0.75 * M / SAGITTA)))
    out.push(x1, y1)
    for (let t = 1; t < k; t++) {
      const u = t / k, v = 1 - u
      out.push(
        v * v * v * x1 + 3 * v * v * u * bx1 + 3 * v * u * u * bx2 + u * u * u * x2,
        v * v * v * y1 + 3 * v * v * u * by1 + 3 * v * u * u * by2 + u * u * u * y2)
    }
  }
  closed || out.push(s[2 * n - 2], s[2 * n - 1])
  return out
}
