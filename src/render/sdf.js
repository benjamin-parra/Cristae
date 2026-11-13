// El campo de distancia de un glifo a partir de su cobertura, con la transformada de distancia euclídea exacta de
// Felzenszwalb y Huttenlocher (2012), en dos pasadas 1D por eje. Un píxel de borde (cobertura entre 0 y 1) arranca a
// una distancia subpíxel del contorno, proporcional a lo que le falta para el medio: el contorno conserva la precisión
// del antialias del canvas y no sale en escalones de un píxel. Puro: sin DOM.

// Mayor que cualquier distancia al cuadrado de una celda, y tal que sumado a q² no pierde la resta del algoritmo: con
// Infinity daría NaN.
const FAR = 1e20

/** Los arreglos de trabajo para celdas de hasta `side` px por eje y `area` px: se reusan entre glifos. */
export const createScratch = (side, area = side * side) => ({
  side,
  area,
  outside : new Float64Array(area),
  inside  : new Float64Array(area),
  f       : new Float64Array(side),
  d       : new Float64Array(side),
  v       : new Int32Array(side),
  z       : new Float64Array(side + 1),
})

/** `s` si alcanza para una celda de `w` × `h`; si no, uno nuevo que alcanza. */
export const fitScratch = (s, w, h) =>
  s.side >= Math.max(w, h) && s.area >= w * h ? s : createScratch(Math.max(w, h, s.side), Math.max(w * h, s.area))

// La transformada 1D de `n` valores de `grid` desde `base` con paso `step`, en el sitio.
const line = (grid, base, step, n, s) => {
  const { f, d, v, z } = s
  for (let q = 0; q < n; q++) f[q] = grid[base + q * step]
  let k = 0
  v[0] = 0
  z[0] = -FAR
  z[1] = FAR
  for (let q = 1; q < n; q++) {
    let r = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
    while (r <= z[k]) {
      k--
      r = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
    }
    k++
    v[k]     = q
    z[k]     = r
    z[k + 1] = FAR
  }
  k = 0
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++
    const dq = q - v[k]
    d[q] = dq * dq + f[v[k]]
  }
  for (let q = 0; q < n; q++) grid[base + q * step] = d[q]
}

const transform = (grid, w, h, s) => {
  for (let x = 0; x < w; x++) line(grid, x, w, h, s)
  for (let y = 0; y < h; y++) line(grid, y * w, 1, w, s)
}

/** Escribe en `out`, desde `from` y con `stride` por fila, el campo de la cobertura de `rgba` (RGBA de `w` × `h`; se
 *  lee el alfa). Cada valor es 255 · (1 − d / `radius` − `cut`), recortado a 0..255, con `d` la distancia con signo
 *  en px, positiva afuera: el contorno vale 255 · (1 − cut), lo de adentro sube y lo de afuera llega a 0 a
 *  `radius` · (1 − cut) px. */
export const distanceField = (rgba, w, h, radius, cut, s, out, from, stride) => {
  const { outside, inside } = s
  for (let i = 0, n = w * h; i < n; i++) {
    const a = rgba[4 * i + 3] / 255
    if (a >= 1) {
      outside[i] = 0
      inside[i]  = FAR
    } else if (a <= 0) {
      outside[i] = FAR
      inside[i]  = 0
    } else {
      const fo = Math.max(0, 0.5 - a), fi = Math.max(0, a - 0.5)
      outside[i] = fo * fo
      inside[i]  = fi * fi
    }
  }
  transform(outside, w, h, s)
  transform(inside, w, h, s)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      const v = Math.round(255 * (1 - (Math.sqrt(outside[i]) - Math.sqrt(inside[i])) / radius - cut))
      out[from + y * stride + x] = v < 0 ? 0 : v > 255 ? 255 : v
    }
  }
}
