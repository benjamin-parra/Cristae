// El gemelo float32 de la clase de pendiente que calcula el shader: cada operación del fragmento redondeada con
// Math.fround, en el orden de la expresión de eachCell. Lo comparten la prueba de clases y el escenario de navegador.
import { NO_DATA } from '../src/render/terrain-shaders.js'

const f = Math.fround

// La clase del shader: gradiente de Horn con cada operación redondeada a float32.
export const claseGemela = (grid, i, j, cortes) => {
  const { heights, W, ew, ns } = grid
  const h = (di, dj) => {
    const v = heights[(j + dj) * W + i + di]
    return Number.isNaN(v) ? NO_DATA : v
  }
  const a0 = h(-1, -1), a1 = h(0, -1), a2 = h(1, -1), b0 = h(-1, 0), b2 = h(1, 0), c0 = h(-1, 1), c1 = h(0, 1), c2 = h(1, 1)
  if (Math.min(a0, a1, a2, b0, b2, c0, c1, c2, h(0, 0)) < NO_DATA * 0.5) return { clase: -1 }
  const up = f(ew[j - 1]), mid = f(ew[j]), down = f(ew[j + 1]), ens = f(ns[j])
  const t1 = f(f(a2 - a0) / up)
  const t2 = f(f(f(2 * f(b2 - b0))) / mid)
  const t3 = f(f(c2 - c0) / down)
  const gx = f(f(f(f(t1 + t2) + t3)) / 4)
  const s  = f(f(f(f(f(f(c0 + f(2 * c1)) + c2) - a0) - f(2 * a1)) - a2))
  const gy = f(s / f(4 * ens))
  const p  = f(Math.sqrt(f(f(gx * gx) + f(gy * gy))))
  let clase = 0
  while (clase < cortes.length && f(cortes[clase]) <= p) clase++
  return { clase, p }
}
