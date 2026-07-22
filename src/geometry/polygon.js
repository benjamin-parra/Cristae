// Geometría de polígonos genérica, sin dominio: point-in-poly por ray-casting
// + índice espacial (bbox ordenado por maxLng, descarte por upper-bound binario).
// Lo usa la polygon-layer para hit-testing. O(log n + k) por consulta.
import { bboxOfRings } from './bbox.js'
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

// Acepta un anillo simple [[lat,lng], ...] o multi-anillo [[[lat,lng], ...], ...].
export const pointInPoly = (lat, lng, rings) => {
  if (rings.length === 0) return false
  if (Array.isArray(rings[0][0])) {
    for (let r = 0; r < rings.length; r++) if (pip(lat, lng, rings[r])) return true
    return false
  }
  return pip(lat, lng, rings)
}

// items: [{ id, rings }]. Índice inmutable; reconstruir solo si cambia el set (raro). O(n log n).
export const prepareIndex = (items) => {
  if (!items?.length) return { sorted: [], maxHeight: 0 }
  let maxHeight = 0
  const sorted = items.map((item) => {
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
