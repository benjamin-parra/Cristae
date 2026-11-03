// Colocación de un texto a lo largo de una polilínea en px de pantalla, glifo por glifo. Pura y sin DOM:
// la capa proyecta, mide y pinta; acá se decide dónde cae cada glifo y con qué giro.
//
// Un glifo se apoya en el punto del trazo que está a su largo acumulado, con la tangente del segmento
// que lo contiene. La colocación se lee de izquierda a derecha: con `orientation: 'auto'` se recorre al
// revés si la cuerda que va de su comienzo a su final apunta a la izquierda, o recto hacia arriba. Un
// promedio de ángulos fallaría cerca de ±180°, donde +179° y −179° promedian 0°.

const DEG = Math.PI / 180
const TAU = 2 * Math.PI

// El punto del trazo a la distancia `s` y la tangente unitaria de su segmento. Portador de módulo: se
// escribe y se lee en el acto, así el recorrido por glifo no asigna.
const hit = { x: 0, y: 0, ux: 1, uy: 0 }

// Primer vértice `k` de (from, end] con `cum[k] ≥ s`: el segmento que contiene `s` es el que termina en
// `k`. Con largos repetidos (un segmento de largo 0) cae en el primero, que sí tiene largo.
const segmentEnd = (cum, from, end, s) => {
  let lo = from + 1, hi = end
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (cum[mid] < s) lo = mid + 1
    else hi = mid
  }
  return lo
}

const pointAt = (xy, cum, from, end, s) => {
  const k   = segmentEnd(cum, from, end, s)
  const j   = k - 1
  const dx  = xy[2 * k] - xy[2 * j]
  const dy  = xy[2 * k + 1] - xy[2 * j + 1]
  const len = cum[k] - cum[j]
  const t   = len > 0 ? (s - cum[j]) / len : 0
  hit.x  = xy[2 * j] + t * dx
  hit.y  = xy[2 * j + 1] + t * dy
  hit.ux = len > 0 ? dx / len : 1
  hit.uy = len > 0 ? dy / len : 0
  return hit
}

// Cuánto le falta a (x, y) para entrar a la vista agrandada en `pad`: 0 si ya está adentro. Ningún punto
// del trazo a menos de esa distancia de arco puede entrar, porque el arco no es más corto que la recta.
const outside = (x, y, pad, viewW, viewH) => {
  const ex = x < -pad ? -pad - x : x > viewW + pad ? x - viewW - pad : 0
  const ey = y < -pad ? -pad - y : y > viewH + pad ? y - viewH - pad : 0
  return Math.hypot(ex, ey)
}

// Crece conservando lo ya escrito: las colocaciones anteriores de la misma llamada están en `buf`.
const reserve = (out, need) => {
  if (out.buf.length >= need) return out.buf
  const buf = new Float64Array(Math.max(out.buf.length * 2, need))
  buf.set(out.buf)
  return out.buf = buf
}

// Una colocación que empieza a la distancia `s0` de la parte. Escribe sus glifos en `out.buf` a partir
// del glifo `count` y devuelve el nuevo total, o `count` si la omite por el giro. Dos pasadas: la primera
// sólo mide el giro, así una colocación omitida no deja glifos sueltos detrás de `count`.
const placeOne = (xy, cum, from, end, s0, widths, total, offset, auto, maxTurn, out, count) => {
  const base = cum[from]
  const head = pointAt(xy, cum, from, end, base + s0)
  const hx   = head.x
  const hy   = head.y
  const tail = pointAt(xy, cum, from, end, base + s0 + total)
  const dx   = tail.x - hx
  const dy   = tail.y - hy
  const back = auto && (dx < 0 || dx === 0 && dy < 0)
  const g    = widths.length

  for (let write = 0; write < 2; write++) {
    const buf = write && reserve(out, (count + g) * 3)
    let o    = count * 3
    let acc  = 0
    let prev = 0
    for (let i = 0; i < g; i++) {
      const w = widths[i]
      const s = back ? s0 + total - acc - w / 2 : s0 + acc + w / 2
      acc += w
      const p  = pointAt(xy, cum, from, end, base + s)
      const ux = back ? -p.ux : p.ux
      const uy = back ? -p.uy : p.uy
      const a  = Math.atan2(uy, ux) + 0          // + 0 lleva el −0 de una tangente invertida a 0
      if (!write && i > 0) {
        let turn = a - prev
        if (turn > Math.PI) turn -= TAU
        else if (turn <= -Math.PI) turn += TAU
        if (Math.abs(turn) > maxTurn) return count
      }
      prev = a
      if (!write) continue
      // La normal izquierda del sentido de lectura, con la y de pantalla hacia abajo: positivo queda arriba.
      buf[o++] = p.x + offset * uy
      buf[o++] = p.y - offset * ux
      buf[o++] = a
    }
  }
  return count + g
}

/** Coloca los glifos de un texto sobre la parte que ocupa los vértices `from … from+n` de `xy`.
 *  - `xy`: vértices en px de contenedor, intercalados (x, y), de todas las partes.
 *  - `cum`: largo acumulado por vértice, alineado con `xy`; creciente dentro de la parte.
 *  - `widths`: ancho de cada glifo (un punto de código cada uno), en el orden de lectura.
 *  - `opts`: `placement` ('center' | 'start'), `repeat` (px entre centros, o null), `offset` (px a la
 *    izquierda del sentido de lectura), `orientation` ('auto' | 'path'), `maxAngle` (grados) y, si se
 *    quiere culling, `viewW`/`viewH` del contenedor.
 *  - `out`: `{ buf: Float64Array }` con (x, y, ángulo) por glifo desde el índice 0; si no alcanza se
 *    reemplaza `buf` por uno del doble.
 *  Devuelve cuántos glifos escribió, siempre de colocaciones enteras. */
export const placeGlyphs = (xy, cum, from, n, widths, opts, out) => {
  if (n < 2 || !widths.length) return 0
  const end   = from + n - 1
  const len   = cum[end] - cum[from]
  const total = widths.reduce((sum, w) => sum + w, 0)
  if (!(total > 0) || total > len) return 0

  const { placement = 'center', repeat = null, offset = 0, orientation = 'auto', maxAngle = 45, viewW, viewH } = opts

  const auto    = orientation === 'auto'
  const maxTurn = maxAngle * DEG
  const culls   = viewW != null && viewH != null
  const place   = (s0, count) => placeOne(xy, cum, from, end, s0, widths, total, offset, auto, maxTurn, out, count)
  const away    = s0 => {
    const mid = pointAt(xy, cum, from, end, cum[from] + s0 + total / 2)
    return culls ? outside(mid.x, mid.y, total, viewW, viewH) : 0
  }

  if (repeat == null) {
    const s0 = placement === 'start' ? 0 : (len - total) / 2
    return away(s0) > 0 ? 0 : place(s0, 0)
  }

  // Centros en `repeat/2 + k·repeat`. Lo que no cabe, pisa a la anterior o cae fuera de la vista se
  // omite, y el salto de `k` se estira hasta el primer centro que podría servir.
  let count   = 0
  let lastEnd = -Infinity
  for (let k = 0; repeat * (k + 0.5) + total / 2 <= len;) {
    const s0   = repeat * (k + 0.5) - total / 2
    const skip = s0 < 0 ? -s0 : s0 < lastEnd ? lastEnd - s0 : away(s0)
    if (skip > 0) {
      k = Math.max(k + 1, Math.ceil((s0 + skip + total / 2) / repeat - 0.5))
      continue
    }
    const next = place(s0, count)
    next > count && (lastEnd = s0 + total)
    count = next
    k++
  }
  return count
}
