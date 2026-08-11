// Geometría de polígonos genérica, sin dominio: point-in-poly por ray-casting
// + índice espacial (bbox ordenado por maxLng, descarte por upper-bound binario).
// Lo usa la polygon-layer para hit-testing. O(log n + k) por consulta.
//
// Dos representaciones de la misma geometría, cada una con su propio bucle: anillos de arrays
// `[[lat,lng],…]` y tramos de un intercalado `[lng, lat, …]` con tablas CSR.
import { bboxOfRings, growBoxOfRange } from './bbox.js'
import { lowerBoundBy } from './binary-search.js'

// Ray-casting sobre un anillo simple ([[lat,lng], ...]). Primitivas inline → sin alloc.
const pip = (lat, lng, ring) => {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const yi = ring[i][0], xi = ring[i][1]
    const yj = ring[j][0], xj = ring[j][1]
    if ((yi > lat) !== (yj > lat) && lng < (xj - xi) * (lat - yi) / (yj - yi) + xi)
      inside = !inside
  }
  return inside
}

// Paridad XOR entre los anillos de UN polígono: el exterior la aporta adentro y cada agujero la quita.
const parityOfRings = (lat, lng, rings) =>
  rings.reduce((inside, ring) => inside !== pip(lat, lng, ring), false)

// Acepta las tres formas: anillo simple `[[lat,lng],…]`, polígono `[[[lat,lng],…],…]` (exterior +
// agujeros) y multipolígono. Entre los polígonos de un multi la composición es OR; dentro de cada
// polígono, XOR entre sus anillos.
export const pointInPoly = (lat, lng, rings) =>
  !rings?.length                      ? false
  : !Array.isArray(rings[0]?.[0])     ? pip(lat, lng, rings)
  : Array.isArray(rings[0][0][0])     ? rings.some(poly => parityOfRings(lat, lng, poly))
  : parityOfRings(lat, lng, rings)

// items: [{ id, rings }]. Índice inmutable; reconstruir solo si cambia el set (raro). O(n log n).
export const prepareIndex = items => {
  if (!items?.length) return { sorted: [], maxHeight: 0 }
  let maxHeight = 0
  const sorted = items.map(item => {
    const bbox = bboxOfRings(item.rings)
    const height = bbox.maxLat - bbox.minLat
    if (height > maxHeight) maxHeight = height
    return { item, bbox }
  })
  sorted.sort((a, b) => a.bbox.maxLng - b.bbox.maxLng)
  return { sorted, maxHeight }
}

// Un item queda del todo al oeste del punto (y se descarta) si su bbox.maxLng <= value: borde
// EXCLUSIVO — el primer superviviente es el de maxLng ESTRICTAMENTE mayor que el punto.
const endsWestOfPoint = (entry, value) => entry.bbox.maxLng <= value

// Todos los ids cuyo polígono contiene (lat, lng). O(log n + k), k = supervivientes de bbox.
export const idsFor = (lat, lng, index) => {
  if (lat == null || lng == null) return []
  const { sorted } = index
  const out = []
  for (let i = lowerBoundBy(sorted, lng, endsWestOfPoint); i < sorted.length; i++) {
    const { item, bbox } = sorted[i]
    if (lng < bbox.minLng || lat < bbox.minLat || lat > bbox.maxLat) continue
    if (pointInPoly(lat, lng, item.rings)) out.push(item.id)
  }
  return out
}

// Primer id que contiene (lat, lng), o null.
export const idFor = (lat, lng, index) => {
  const ids = idsFor(lat, lng, index)
  return ids.length > 0 ? ids[0] : null
}

/* ── La misma geometría sobre un intercalado `[lng, lat, …]` con tablas CSR ── */

// Paridad del tramo de vértices [first, first+count) contra la semirrecta al este del punto. Un
// anillo cerrado —último vértice repetido— aporta una arista de largo cero, que no cruza nada.
export const oddEvenRange = (xy, first, count, lng, lat) => {
  let inside = false
  const end = first + count
  for (let i = first, j = end - 1; i < end; j = i++) {
    const yi = xy[i * 2 + 1], xi = xy[i * 2]
    const yj = xy[j * 2 + 1], xj = xy[j * 2]
    if ((yi > lat) !== (yj > lat) && lng < (xj - xi) * (lat - yi) / (yj - yi) + xi)
      inside = !inside
  }
  return inside
}

// XOR entre los anillos [firstRing, firstRing+ringCount) de una PARTE: el primero es el exterior y
// los demás, agujeros. `vertexAt` es la tabla anillo → primer vértice, así que el anillo `r` ocupa
// [vertexAt[r], vertexAt[r+1]).
export const pointInPart = (xy, vertexAt, firstRing, ringCount, lng, lat) => {
  let inside = false
  for (let r = firstRing, end = firstRing + ringCount; r < end; r++)
    inside = inside !== oddEvenRange(xy, vertexAt[r], vertexAt[r + 1] - vertexAt[r], lng, lat)
  return inside
}

// Índice espacial de PARTES: caja por parte y orden por maxLng, en arrays tipados y sin un objeto
// por parte. `ringAt` es la tabla parte → primer anillo. `parts`, si viene, acota el índice a ese
// subconjunto de partes —las únicas cuyos anillos cierran—; sin él entran las `partCount`.
export const prepareRangeIndex = ({ xy, ringAt, vertexAt, partCount, parts }) => {
  const ids   = parts ?? Uint32Array.from({ length: partCount }, (_, p) => p)
  const boxes = new Float64Array(ids.length * 4)
  const order = new Uint32Array(ids.length)
  const box   = new Float64Array(4)
  for (let i = 0; i < ids.length; i++) {
    const p = ids[i]
    box[0] = box[1] = Infinity
    box[2] = box[3] = -Infinity
    for (let r = ringAt[p]; r < ringAt[p + 1]; r++)
      growBoxOfRange(xy, vertexAt[r], vertexAt[r + 1] - vertexAt[r], box)
    boxes.set(box, i * 4)
    order[i] = i
  }
  // Una parte vacía conserva la caja en ±Infinity: con maxLng -Infinity ordena primera y el descarte
  // por bbox la saltea sin mirar un vértice.
  order.sort((a, b) => boxes[a * 4 + 2] - boxes[b * 4 + 2])
  return { xy, ringAt, vertexAt, ids, boxes, order }
}

// Primera parte que contiene el punto —su índice original, aunque `prepareRangeIndex` lo haya acotado
// con `parts`—, o -1. Semántica de `some`: el llamador que quiera todas las partes itera él. El
// lower-bound descarta en O(log n) las que terminan al oeste, con el borde exclusivo de arriba.
// Todas las partes que contienen el punto, acumuladas en `out` —que el llamador reusa—. Es el gemelo
// de `idsFor` del camino de arrays: dos polígonos superpuestos contestan los dos.
export const partsAtPoint = (index, lng, lat, out = []) => {
  const { order, boxes, ids, xy, ringAt, vertexAt } = index
  const endsWest = (slot, value) => boxes[slot * 4 + 2] <= value
  out.length = 0
  for (let i = lowerBoundBy(order, lng, endsWest); i < order.length; i++) {
    const slot = order[i], b = slot * 4
    if (lng < boxes[b] || lat < boxes[b + 1] || lat > boxes[b + 3]) continue
    const p = ids[slot]
    pointInPart(xy, vertexAt, ringAt[p], ringAt[p + 1] - ringAt[p], lng, lat) && out.push(p)
  }
  return out
}

export const partAtPoint = (index, lng, lat) => {
  const { order, boxes, ids, xy, ringAt, vertexAt } = index
  const endsWest = (slot, value) => boxes[slot * 4 + 2] <= value
  for (let i = lowerBoundBy(order, lng, endsWest); i < order.length; i++) {
    const slot = order[i], b = slot * 4
    if (lng < boxes[b] || lat < boxes[b + 1] || lat > boxes[b + 3]) continue
    const p = ids[slot]
    if (pointInPart(xy, vertexAt, ringAt[p], ringAt[p + 1] - ringAt[p], lng, lat)) return p
  }
  return -1
}
