// Geometría de polilíneas genérica, sin dominio. Dos piezas:
//   · el contrato de path, en grados: qué es un punto, los dos encodings y la regla de corte
//     (`coordOf`, `isNested`, `foldRuns`, `toParts`). Lo comparten las capas de líneas, su encuadre y
//     la medida en metros (geodesic.js); la edición comparte el lector de punto y la decisión de
//     anidado. Los anillos de `ringsOf` y las posiciones de `positionOf` tienen su propio contrato.
//   · el hit-testing nearest-segment de la line-layer —distancia punto→segmento + índice espacial
//     (bbox ordenado por maxX, descarte por upper-bound binario), O(log n + k) por consulta— y el
//     muestreo de `sampleAlong`.
//
// La segunda se calcula en el marco EPSG:3857 a zoom 0 (world0 px) reusando projX0/projY0 — el MISMO
// espacio que proyecta glify (points.ts exige EPSG:3857). El caller convierte la tolerancia y la
// distancia a píxeles de pantalla multiplicando por la escala del zoom (world0 · 2^zoom = screen).
// Módulo puro: sin Leaflet, sin WebGL, testeable con coordenadas conocidas.
import { projX0, projY0 } from '../render/project.js'
import { bboxOfPoints } from './bbox.js'
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

// Un punto, en grados, tiene cuatro formas: `[lat, lng]` —un array, donde lo que siga, una altura, se
// ignora, o una vista tipada de dos o tres componentes—, `{ lat, lng }`, `{ lat, lon }` y
// `{ latitude, longitude }`. Es un punto si sus dos componentes son números finitos y la latitud cae
// en [-90, 90]: fuera de ahí no hay un lugar, y cada modelo de la Tierra la mediría distinto. No se
// coacciona un string, y un objeto que expone `lat()` como método no es un punto. Una vista tipada más
// larga es un track intercalado, que leído como punto mediría 0: no es un punto, y corta. El orden
// `[lng, lat]` no entra: es un par igual en forma, y en latitudes medias no se distingue.
//
// `coordOf(p, 0)` es la latitud y `coordOf(p, 1)` la longitud de un valor no nulo, leídas en su
// lugar, sin copiar el punto. El lector queda chico a propósito, con las formas objeto aparte: así
// V8 lo inlina entero en los recorridos, y el double de un par no se encajona. Por lo mismo la forma
// se reconoce por `typeof` y no comparando con undefined, y el null lo descarta `isPoint` antes de
// leer: mezclar el double con undefined o con un NaN constante también obliga a encajonarlo, una
// asignación por vértice en los recorridos de volumen.
const indexable = v => Array.isArray(v) || ArrayBuffer.isView(v)

const objectCoord = (p, axis) =>
  typeof p.lat === 'number' ? (axis ? (typeof p.lng === 'number' ? p.lng : p.lon) : p.lat)
  : axis ? p.longitude : p.latitude

export const coordOf = (p, axis) => (indexable(p) ? p[axis] : objectCoord(p, axis))
export const isPoint = p =>
  p != null && !(ArrayBuffer.isView(p) && p.length > 3) &&
  Number.isFinite(coordOf(p, 0)) && Math.abs(coordOf(p, 0)) <= 90 && Number.isFinite(coordOf(p, 1))

// Un iterable del path es un objeto: un string también se recorre, pero sus caracteres no son
// vértices. Un array se lee en su lugar; otro iterable se materializa antes de leerlo, porque uno de
// un solo uso no se deja leer dos veces. Lo que no es iterable no trae vértices.
export const iterable = v => typeof v === 'object' && !!v?.[Symbol.iterator]
const listOf          = v => (Array.isArray(v) ? v : iterable(v) ? [...v] : [])

/** Los tramos de `part` leída como un path plano, con `base` = la posición de la parte en la
 *  entrada. Un vértice que no es punto corta y, si hay `cut`, se le avisa con el vértice:
 *  `acc = cut(acc, vertex)`. Quien mide lo necesita, porque un dato que no sirve no es lo mismo que
 *  ningún dato. `i === part.length` cierra el último tramo como un corte más, sin aviso. */
export const foldPart = (part, base, fn, acc, cut) => {
  for (let i = 0, first = 0; i <= part.length; i++) {
    if (i < part.length && isPoint(part[i])) continue
    if (i - first >= 2) acc = fn(acc, part, first, i - first, base + first)
    if (cut && i < part.length) acc = cut(acc, part[i])
    first = i + 1
  }
  return acc
}

// El encoding de un path lo decide su primer elemento que trae algo. Un array o una vista tipada se
// decide por su lat y su lng, como se lee el punto —lo que siga, una altura o un objeto, no cuenta—:
// si el primero no nulo de los dos es un objeto —un punto en cualquiera de sus formas, aunque venga
// sucio—, el elemento es una parte y el path es anidado; si es un primitivo —un número, aunque sea
// NaN—, es un vértice y el path es plano, y se corta. Otro objeto decide por sí mismo: un punto es un
// vértice, así que un plano de objetos se decide en su primer punto, y otro iterable es una parte,
// que se decide sin abrirla. Saltar lo que no decide (null, un primitivo, `[]`, `[null]`, un objeto
// que no es punto ni iterable) es lo que deja leer un plano cuyo vértice 0 llega sucio, que es como
// llega una fila GPS mala, y un anidado cuya primera parte llega vacía o con un vértice nulo en la
// cabeza. Si nada decide, con algún array el path es anidado: leído como parte, un array sin lat ni
// lng puede traer puntos después y, vacío, no aporta ni corta; leído como vértice, cortaría.
export const isNested = top => {
  const lead = top.find(v => (indexable(v) ? (v[0] ?? v[1]) != null : isPoint(v) || iterable(v)))
  return lead === undefined ? top.some(indexable)
    : indexable(lead) ? typeof (lead[0] ?? lead[1]) === 'object' : !isPoint(lead)
}

/** Pliega sobre `acc`, sin copiarlos, los tramos de puntos CONTIGUOS de un path:
 *  `acc = fn(acc, vertices, first, count, from)` por tramo, con el tramo en
 *  `vertices[first … first+count)` y `from` = la posición de su primer vértice en la entrada, para
 *  indexar un escalar paralelo sin desincronizarse al cortar. Es la única dueña de la regla de
 *  corte. Dos encodings, que decide `isNested`:
 *   · plano `[punto, …]` — un vértice que no es punto CORTA (un track con baches sale partido, no
 *     puenteado por una recta que no existe); el corte igual ocupa índice.
 *   · anidado `[[punto, …], …]` — partes explícitas, arrays o cualquier iterable; los índices
 *     corren concatenados.
 *  Omite los tramos de < 2 vértices: no hay segmento que dibujar, medir ni contra el cual pickear.
 *  `cut` es el de `foldPart`. Es un pliegue, y no un recorrido con callback, para que el bucle por
 *  vértice viva en funciones de módulo, estables entre llamadas: en una clausura nueva por llamada
 *  arranca cada vez sin optimizar y encajona los doubles que lee. */
export const foldRuns = (input, fn, acc, cut) => {
  const top = listOf(input)
  if (!isNested(top)) return foldPart(top, 0, fn, acc, cut)
  let base = 0
  top.forEach(v => {
    const part = listOf(v)
    acc = foldPart(part, base, fn, acc, cut)
    base += part.length
  })
  return acc
}

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

// items: [{ id, parts }] con las partes tal cual las devuelve `toParts` — una entrada POR PARTE: las
// de un track disjunto traen bboxes ajustadas y se descartan por separado en el broad-phase. Guarda
// el `from` de cada parte para que el hit pueda expresarse en el espacio de índices de la ENTRADA (el
// mismo que recibe `scalarOf`) y no sólo en el local de la parte. Índice inmutable; reconstruir sólo
// si cambia el set. Proyecta cada vértice a world0 px una vez. O(n·k) al construir.
export const prepareIndex = items => ({
  sorted: (items ?? [])
    .flatMap(({ id, parts }) => parts.map(({ path, from }, partIndex) => {
      const pts = path.map(([lat, lng]) => ({ x: projX0(lng), y: projY0(lat) }))
      return { id, partIndex, from, pts, bbox: bboxOfPoints(pts) }
    }))
    .sort((a, b) => a.bbox.maxX - b.bbox.maxX),
})

// Un item se descarta si su bbox.maxX < value: sus previos tienen todo su bbox al oeste de `value`
// (= px − tol), así que su punto más cercano queda a más de tol. El límite es INCLUSIVO (`< value`,
// no `<=`) para no dejar fuera una línea cuyo borde este está exactamente a tol (el narrow-phase la
// aceptaría con `best <= tol²`). Ese `<` es la única diferencia con el borde del hit-test de polígonos.
const endsWestOfBand = (entry, value) => entry.bbox.maxX < value

// Rumbo del segmento a→b en grados (0=N, 90=E). En world0 el eje Y crece hacia el SUR → norte = −dy.
const bearingOf = (a, b) => {
  const deg = Math.atan2(b.x - a.x, a.y - b.y) * 180 / Math.PI
  return (deg + 360) % 360
}

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
    const hit = { id: entry.id, partIndex: entry.partIndex, vertexIndex: entry.from + bestSeg, dist }
    if (!prev) out.push(hit)
    else if (dist < prev.dist) Object.assign(prev, hit)
  }
  return out
}
