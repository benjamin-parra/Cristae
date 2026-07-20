// Geometría de polilíneas genérica, sin dominio: distancia punto→segmento + índice espacial
// (bbox ordenado por maxX, descarte por upper-bound binario). La usa la line-layer para
// hit-testing (nearest-segment). O(log n + k) por consulta.
//
// Todo se calcula en el marco EPSG:3857 a zoom 0 (world0 px) reusando projX0/projY0 — el MISMO
// espacio que proyecta glify (points.ts exige EPSG:3857). El caller convierte la tolerancia y la
// distancia a píxeles de pantalla multiplicando por la escala del zoom (world0 · 2^zoom = screen).
// Módulo puro: sin Leaflet, sin WebGL, testeable con coordenadas conocidas.
import { projX0, projY0 } from '../render/project.js'

// Distancia² de (px,py) al segmento (ax,ay)-(bx,by), en world0 px. Inline, sin alloc.
const distSqToSegment = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax, dy = by - ay
  const len2 = dx * dx + dy * dy
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0
  t = t < 0 ? 0 : t > 1 ? 1 : t
  const cx = ax + t * dx, cy = ay + t * dy
  const ex = px - cx, ey = py - cy
  return ex * ex + ey * ey
}

// bbox de un path proyectado [{x,y}, ...] en world0 px.
const bboxOf = (pts) => {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (let i = 0; i < pts.length; i++) {
    const x = pts[i].x, y = pts[i].y
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  return { minX, maxX, minY, maxY }
}

// Tramos de vértices finitos CONTIGUOS dentro de una parte; `base` = índice de su primer vértice en
// la entrada. Un vértice no finito corta: el siguiente finito arranca un tramo nuevo.
const runsOf = (part, base) => part.reduce((runs, p, k) => {
  if (!Number.isFinite(p?.[0]) || !Number.isFinite(p?.[1])) return runs
  const last = runs[runs.length - 1]
  if (last && last.from + last.path.length === base + k) last.path.push([p[0], p[1]])
  else runs.push({ from: base + k, path: [[p[0], p[1]]] })
  return runs
}, [])

/** Normaliza lo que devuelve `pathOf` a partes `[{ path: [[lat,lng],…], from }, …]` — `from` es la
 *  posición del primer vértice de la parte en la entrada (dentro de una parte los índices son
 *  contiguos), para indexar un escalar paralelo sin desincronizarse al cortar. Dos encodings:
 *   · plano `[[lat,lng], …]` — un vértice no finito CORTA (un track con baches sale partido, no
 *     puenteado por una recta que no existe); el corte igual ocupa índice.
 *   · anidado `[[[lat,lng], …], …]` — partes explícitas; los índices corren concatenados.
 *  Descarta partes de < 2 vértices: no hay segmento que dibujar ni contra el cual pickear. */
export const toParts = (input) => {
  const top = input ? [...input] : []
  // Es anidado sólo si el primer elemento concluyente CONTIENE otro array. Cualquier otra forma
  // —incluido un par sucio en la cabeza, que es como llega una fila GPS mala— es un path plano y se
  // corta. Discriminar por "no es un número" haría desaparecer el path entero cuando el corte cae
  // justo en el vértice 0; mirar sólo `top[0]` perdería un anidado que arranca con una parte nula.
  const head = top.find((v) => v != null)
  const parts = Array.isArray(head?.[0])
    ? top.map((part) => (part ? [...part] : []))
    : [top]
  const { runs } = parts.reduce(
    ({ runs, base }, part) => ({ runs: runs.concat(runsOf(part, base)), base: base + part.length }),
    { runs: [], base: 0 },
  )
  return runs.filter((r) => r.path.length >= 2)
}

// items: [{ id, parts }] con las partes tal cual las devuelve `toParts` — una entrada POR PARTE: las
// de un track disjunto traen bboxes ajustadas y se descartan por separado en el broad-phase. Guarda
// el `from` de cada parte para que el hit pueda expresarse en el espacio de índices de la ENTRADA (el
// mismo que recibe `scalarOf`) y no sólo en el local de la parte. Índice inmutable; reconstruir sólo
// si cambia el set. Proyecta cada vértice a world0 px una vez. O(n·k) al construir.
export const prepareIndex = (items) => ({
  sorted: (items ?? [])
    .flatMap(({ id, parts }) => parts.map(({ path, from }, partIndex) => {
      const pts = path.map(([lat, lng]) => ({ x: projX0(lng), y: projY0(lat) }))
      return { id, partIndex, from, pts, bbox: bboxOf(pts) }
    }))
    .sort((a, b) => a.bbox.maxX - b.bbox.maxX),
})

// Primer índice cuyo bbox.maxX >= value; los previos tienen todo su bbox al oeste de `value`
// (= px − tol), así que su punto más cercano queda a más de tol → se descartan. El límite es
// INCLUSIVO (`< value`, no `<=`) para no dejar fuera una línea cuyo borde este está exactamente a
// tol (el narrow-phase la aceptaría con `best <= tol²`).
const lowerBound = (sorted, value) => {
  let lo = 0, hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (sorted[mid].bbox.maxX < value) lo = mid + 1
    else hi = mid
  }
  return lo
}

// Rumbo del segmento a→b en grados (0=N, 90=E). En world0 el eje Y crece hacia el SUR → norte = −dy.
const bearingOf = (a, b) => {
  const deg = Math.atan2(b.x - a.x, a.y - b.y) * 180 / Math.PI
  return (deg + 360) % 360
}

// Muestrea `count` puntos EQUIESPACIADOS a lo largo del path (por longitud real, no por vértice),
// cada uno con el `heading` del segmento en que cae. Es la pieza para DECORAR una línea COMPONIENDO:
// los puntos salen a un point-layer con `headingOf` (sprite rotado) — p. ej. flechas de dirección o
// ticks. La capa de líneas NO dibuja flechas: una flecha es un punto con rumbo, no una propiedad del
// trazo (misma separación que el cabezal animado, que es un punto que se mueve sobre la línea).
// Muestras centradas ((k+½)/count) para no pegarlas a los extremos. Puro: sin DOM, sin Leaflet.
export const sampleAlong = (input, count) => {
  if (!(count >= 1)) return []
  // Los segmentos salen de las PARTES: así el muestreo nunca cae en un hueco ni traza una recta que
  // no existe, y acepta los dos encodings sin saber cuál le tocó.
  const segs = toParts(input).flatMap(({ path }) => {
    const pts = path.map(([lat, lng]) => ({ x: projX0(lng), y: projY0(lat) }))
    return pts.slice(1).map((b, i) => ({
      desde: path[i],
      hasta: path[i + 1],
      largo: Math.hypot(b.x - pts[i].x, b.y - pts[i].y),
      heading: bearingOf(pts[i], b),
    }))
  })
  const finArr = []
  const total = segs.reduce((acc, s) => { const fin = acc + s.largo; finArr.push(fin); return fin }, 0)
  if (!(total > 0)) return []

  return Array.from({ length: count }, (_, k) => {
    const objetivo = total * ((k + 0.5) / count)          // muestras centradas: nunca pegadas al extremo
    const i = Math.max(finArr.findIndex((fin) => fin >= objetivo), 0)
    const s = segs[i]
    const t = s.largo > 0 ? (objetivo - (finArr[i] - s.largo)) / s.largo : 0
    return {
      lat: s.desde[0] + (s.hasta[0] - s.desde[0]) * t,
      lng: s.desde[1] + (s.hasta[1] - s.desde[1]) * t,
      heading: s.heading,
    }
  })
}

// Todos los items cuyo segmento más cercano a (lat,lng) queda dentro de `tol` (world0 px), con su
// parte, su distancia mínima y el `vertexIndex` del vértice donde arranca ese segmento — en el
// espacio de la ENTRADA, el mismo que recibe `scalarOf`, para que el hit sea cruzable con el dato.
// UN hit por id: de un item multi-parte gana la parte más cercana (se pica la entidad, no el tramo).
// O(log n + k·segmentos). El caller ordena por distancePx.
export const nearest = (lat, lng, index, tol) => {
  const { sorted } = index
  if (!sorted.length) return []
  const px = projX0(lng), py = projY0(lat)
  const tol2 = tol * tol
  const out = []
  for (let i = lowerBound(sorted, px - tol); i < sorted.length; i++) {
    const entry = sorted[i]
    const b = entry.bbox
    if (px < b.minX - tol || py < b.minY - tol || py > b.maxY + tol) continue
    const pts = entry.pts
    let best = Infinity, bestSeg = -1
    for (let s = 0; s < pts.length - 1; s++) {
      const d2 = distSqToSegment(px, py, pts[s].x, pts[s].y, pts[s + 1].x, pts[s + 1].y)
      if (d2 < best) { best = d2; bestSeg = s }
    }
    if (best > tol2) continue
    const dist = Math.sqrt(best)
    const prev = out.find((h) => h.id === entry.id)   // los hits son pocos (tol ~8px): scan < Map
    const hit = { id: entry.id, partIndex: entry.partIndex, vertexIndex: entry.from + bestSeg, dist }
    if (!prev) out.push(hit)
    else if (dist < prev.dist) Object.assign(prev, hit)
  }
  return out
}
