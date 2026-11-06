// Dónde se apoya un rótulo que no sigue el trazo: alrededor del ícono de un punto, a mitad del largo de
// una línea o en el polo de un polígono. Puro: sin DOM; todo en px, salvo el polo, que va en world0.
import { pole } from '../geometry/pole.js'
import { PART } from './labelPath.js'

const GAP = 4                             // px entre el borde del ícono y el texto

// Hacia dónde sale el texto desde el ícono: es también hacia dónde se alinea su caja.
const SIDES = { center: [0, 0], above: [0, -1], below: [0, 1], right: [1, 0] }

/** El ancla de `placement` para un ítem en (x, y) px con su ícono `icon` ({ w, h } y, si el punto no
 *  es el centro del ícono, { ax, ay }: dónde cae el punto dentro de la caja). Escribe en `out` el ancla
 *  ya corrida por `offset` (positivo hacia arriba) y en `sx`, `sy` hacia dónde crece la caja del texto
 *  desde ella: `above` la apoya por abajo, `below` por arriba, `right` por la izquierda y `center` la
 *  centra. Devuelve `out`. */
export const anchorAt = (placement, x, y, icon, offset, out) => {
  const side = SIDES[placement]
  const w    = icon.w > 0 ? icon.w : 0
  const h    = icon.h > 0 ? icon.h : 0
  const cx   = x - (Number.isFinite(icon.ax) ? icon.ax : w / 2) + w / 2
  const cy   = y - (Number.isFinite(icon.ay) ? icon.ay : h / 2) + h / 2
  const away = side[0] || side[1]
  out.x  = away ? cx + side[0] * (w / 2 + GAP) : x
  out.y  = (away ? cy + side[1] * (h / 2 + GAP) : y) - offset
  out.sx = side[0]
  out.sy = side[1]
  return out
}

/** El punto a mitad del largo de la parte que ocupa los vértices `from … from+n` de `xy`, con la
 *  tangente unitaria de su segmento, en `out` ({ x, y, ux, uy }). Devuelve `out`. */
export const midAlong = (xy, cum, from, n, out) => {
  const end  = from + n - 1
  const half = cum[from] + (cum[end] - cum[from]) / 2
  let k = from + 1
  while (k < end && cum[k] < half) k++
  const j   = k - 1
  const dx  = xy[2 * k] - xy[2 * j]
  const dy  = xy[2 * k + 1] - xy[2 * j + 1]
  const len = cum[k] - cum[j]
  const t   = len > 0 ? (half - cum[j]) / len : 0
  out.x  = xy[2 * j] + t * dx
  out.y  = xy[2 * j + 1] + t * dy
  out.ux = len > 0 ? dx / len : 1
  out.uy = len > 0 ? dy / len : 0
  return out
}

/** El polo del exterior más grande de un run proyectado (labelPath.js), con sus huecos: los huecos son
 *  las partes marcadas que siguen a cada exterior. `{ x, y, distance }` en la unidad del run, o null si
 *  no tiene partes. */
export const poleOf = run => {
  const { xy, parts } = run
  let best = -1, bestArea = -1
  for (let p = 0; p < run.count; p++) {
    if (parts[p * PART + 6]) continue
    const from = parts[p * PART], n = parts[p * PART + 1]
    let area = 0
    for (let i = from, j = from + n - 1; i < from + n; j = i++) area += xy[2 * j] * xy[2 * i + 1] - xy[2 * i] * xy[2 * j + 1]
    if (Math.abs(area) > bestArea) {
      best     = p
      bestArea = Math.abs(area)
    }
  }
  if (best < 0) return null

  const ring  = p => xy.slice(2 * parts[p * PART], 2 * (parts[p * PART] + parts[p * PART + 1]))
  const rings = [ring(best)]
  for (let p = best + 1; p < run.count && parts[p * PART + 6]; p++) rings.push(ring(p))
  return pole(rings)
}
