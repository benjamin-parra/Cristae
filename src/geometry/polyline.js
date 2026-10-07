// Geometría de polilíneas genérica, sin dominio. Dos piezas:
//   · la regla de corte sobre el contrato de path de `data/path.js` (`foldRuns`, `toParts`). La
//     comparten las capas de líneas, su encuadre, la medida en metros (geodesic.js) y las cajas
//     (bounds.js). Los anillos de `ringsOf` y las posiciones de `positionOf` tienen su propio
//     contrato.
//   · el hit-testing nearest-segment de la line-layer —distancia punto→segmento + índice espacial
//     (bbox ordenado por maxX, descarte por upper-bound binario), O(log n + k) por consulta— y el
//     muestreo de `sampleAlong`.
//
// La segunda se calcula en el marco EPSG:3857 a zoom 0 (world0 px) reusando projX0/projY0, el mismo
// espacio en que dibuja la capa. El caller convierte la tolerancia y la
// distancia a píxeles de pantalla multiplicando por la escala del zoom (world0 · 2^zoom = screen).
// Módulo puro: sin Leaflet, sin WebGL, testeable con coordenadas conocidas.
import { projX0, projY0 } from '../render/project.js'
import { coordOf, isNested, isPoint, iterable, listOf } from '../data/path.js'
import { lowerBoundBy } from './binary-search.js'

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

/** Los tramos de `part` leída como un path plano, con `base` = la posición de la parte en la
 *  entrada. Un vértice que no es punto corta y, si hay `cut`, se le avisa con el vértice:
 *  `acc = cut(acc, vertex)`. Quien mide lo necesita, porque un dato que no sirve no es lo mismo que
 *  ningún dato. `i === part.length` cierra el último tramo como un corte más, sin aviso. Un tramo de
 *  menos de `least` vértices no se pliega. */
export const foldPart = (part, base, fn, acc, cut, least = 2) => {
  for (let i = 0, first = 0; i <= part.length; i++) {
    if (i < part.length && isPoint(part[i])) continue
    if (i - first >= least) acc = fn(acc, part, first, i - first, base + first)
    if (cut && i < part.length) acc = cut(acc, part[i])
    first = i + 1
  }
  return acc
}

// El encoding de un path lo decide su primer elemento que trae algo. Un array o una vista tipada se
/** Pliega sobre `acc`, sin copiarlos, los tramos de puntos CONTIGUOS de un path:
 *  `acc = fn(acc, vertices, first, count, from)` por tramo, con el tramo en
 *  `vertices[first … first+count)` y `from` = la posición de su primer vértice en la entrada, para
 *  indexar un escalar paralelo sin desincronizarse al cortar. Es la única dueña de la regla de
 *  corte. Dos encodings, que decide `isNested`:
 *   · plano `[punto, …]` — un vértice que no es punto CORTA (un track con baches sale partido, no
 *     puenteado por una recta que no existe); el corte igual ocupa índice.
 *   · anidado `[[punto, …], …]` — partes explícitas, arrays o cualquier iterable; los índices
 *     corren concatenados.
 *  Omite los tramos de menos de `least` vértices: por defecto 2, porque con menos no hay segmento que
 *  dibujar, medir ni contra el cual pickear; la caja de unos puntos pide 1. `cut` es el de `foldPart`.
 *  Es un pliegue, y no un recorrido con callback, para que el bucle por vértice viva en funciones de
 *  módulo, estables entre llamadas: en una clausura nueva por llamada arranca cada vez sin optimizar y
 *  encajona los doubles que lee. */
export const foldRuns = (input, fn, acc, cut, least) => {
  const top = listOf(input)
  if (!isNested(top)) return foldPart(top, 0, fn, acc, cut, least)
  let base = 0
  top.forEach(v => {
    const part = listOf(v)
    acc = foldPart(part, base, fn, acc, cut, least)
    base += part.length
  })
  return acc
}

/** Pliega, como `foldRuns`, los argumentos de una función de puntos variádicos, `distance` o
 *  `boundsOf`. Un solo argumento es un path si es nulo, o iterable y no es un punto; si no, es un
 *  punto, válido o no. Con dos o más, cada uno es un punto. Un array cuyo primer elemento es un
 *  objeto es un path sin pasar por `isPoint`: leer un path como punto le enseña al lector un array de
 *  arrays, y desde ahí V8 encajona cada double que lee de una vista tipada o de un objeto, en todos
 *  los recorridos. */
export const foldArgs = (args, fn, acc, cut, least) =>
  args.length === 1 &&
  (typeof args[0]?.[0] === 'object' || args[0] == null || !isPoint(args[0]) && iterable(args[0]))
    ? foldRuns(args[0], fn, acc, cut, least)
    : foldPart(args, 0, fn, acc, cut, least)

// Un tramo de `foldRuns`, copiado como parte de pares. Vive en el módulo, estable entre llamadas, por
// lo que dice `foldRuns`.
const pushPart = (parts, vertices, first, count, from) => {
  const path = []
  for (let i = first; i < first + count; i++)
    path.push([coordOf(vertices[i], 0), coordOf(vertices[i], 1)])
  parts.push({ from, path })
  return parts
}

/** Normaliza lo que devuelve `pathOf` a partes `[{ from, path: [[lat,lng],…] }, …]`: los tramos de
 *  `foldRuns`, con cada punto copiado como par `[lat, lng]`, sea cual sea su forma. */
export const toParts = input => foldRuns(input, pushPart, [])

// El índice es `{ stale, sorted }`, con una entrada POR PARTE, `{ id, partIndex, src, pts, bbox }`: las de
// un track disjunto traen bboxes ajustadas y se descartan por separado en el broad-phase. `pts` es el path
// que se dibuja, en world0 px, y puede estar curvado, con más vértices que los que entraron: `src[k]` es la
// posición en la ENTRADA del vértice original que abre el tramo `k`, para que el hit se exprese en el
// espacio de índices de la entrada —el mismo que recibe `scalarOf`— y no en el del path dibujado.
//
// Lo arma y lo mantiene al día la capa de líneas: agrega entradas, quita las suyas o estira los `pts` de
// una con su `src` y su `bbox`, y marca `stale`. El orden por maxX se restablece al próximo `nearest`, una
// sola vez por tanda de cambios y no por cambio.
const byMaxX = (a, b) => a.bbox.maxX - b.bbox.maxX

// Un item se descarta si su bbox.maxX < value: sus previos tienen todo su bbox al oeste de `value`
// (= px − tol), así que su punto más cercano queda a más de tol. El límite es INCLUSIVO (`< value`,
// no `<=`) para no dejar fuera una línea cuyo borde este está exactamente a tol (el narrow-phase la
// aceptaría con `best <= tol²`). Ese `<` es la única diferencia con el borde del hit-test de polígonos.
const endsWestOfBand = (entry, value) => entry.bbox.maxX < value

// Un rumbo en (-180, 180], el de `atan2` y el de la librería geodésica, a [0, 360). El módulo, y no un
// +360, porque un negativo mínimo sumaría hasta 360 por redondeo, que ya no está en el rango; el `+ 0`
// lleva el -0 a 0, que la comparación estricta distingue.
export const compass = degrees => degrees < 0 ? (degrees + 360) % 360 : degrees + 0

// Rumbo del segmento a→b en grados (0=N, 90=E). En world0 el eje Y crece hacia el SUR → norte = −dy.
const bearingOf = (a, b) => compass(Math.atan2(b.x - a.x, a.y - b.y) * 180 / Math.PI)

// Muestrea `count` puntos EQUIESPACIADOS a lo largo del path (por largo world0, no por vértice),
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
      desde:   path[i],
      hasta:   path[i + 1],
      largo:   Math.hypot(b.x - pts[i].x, b.y - pts[i].y),
      heading: bearingOf(pts[i], b),
    }))
  })
  const finArr = []
  const total = segs.reduce((acc, s) => { const fin = acc + s.largo; finArr.push(fin); return fin }, 0)
  return total > 0 ? Array.from({ length: count }, (_, k) => {
    const objetivo = total * ((k + 0.5) / count)          // muestras centradas: nunca pegadas al extremo
    const i = Math.max(finArr.findIndex(fin => fin >= objetivo), 0)
    const s = segs[i]
    const t = s.largo > 0 ? (objetivo - (finArr[i] - s.largo)) / s.largo : 0
    return {
      lat:     s.desde[0] + (s.hasta[0] - s.desde[0]) * t,
      lng:     s.desde[1] + (s.hasta[1] - s.desde[1]) * t,
      heading: s.heading,
    }
  }) : []
}

// Todos los items cuyo segmento más cercano a (lat,lng) queda dentro de `tol` (world0 px), con su
// parte, su distancia mínima y el `vertexIndex` del vértice donde arranca ese segmento — en el
// espacio de la ENTRADA, el mismo que recibe `scalarOf`, para que el hit sea cruzable con el dato.
// UN hit por id: de un item multi-parte gana la parte más cercana (se pica la entidad, no el tramo).
// O(log n + k·segmentos). El caller ordena por distancePx.
export const nearest = (lat, lng, index, tol) => {
  const { sorted } = index
  if (!sorted.length) return []
  if (index.stale) {
    sorted.sort(byMaxX)
    index.stale = false
  }
  const px = projX0(lng), py = projY0(lat)
  const tol2 = tol * tol
  const out = []
  for (let i = lowerBoundBy(sorted, px - tol, endsWestOfBand); i < sorted.length; i++) {
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
    const prev = out.find(h => h.id === entry.id)   // los hits son pocos (tol ~8px): scan < Map
    const hit = { id: entry.id, partIndex: entry.partIndex, vertexIndex: entry.src[bestSeg], dist }
    if (!prev) out.push(hit)
    else if (dist < prev.dist) Object.assign(prev, hit)
  }
  return out
}
