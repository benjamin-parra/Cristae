// Álgebra de bounding-boxes / rectángulos, pura y sin dominio: min/max de coordenadas + intersección
// de rectángulos. Reusable por quien indexe por extensión: la comparten el hit-test de polígonos
// (anillos [lat,lng]), el de líneas (puntos {x,y} proyectados), la medida de las tablas tipadas de
// polígonos y el scoring de snapshots de tiles. Son cajas de trabajo, en el espacio y la forma de quien
// indexa y sin regla de lugar; la caja en grados que entregan las capas y la API es la de bounds.js.

// Lista plana de anillos de cualquiera de las tres formas de entrada: anillo simple `[[lat,lng],…]`,
// polígono `[[[lat,lng],…],…]` (exterior + agujeros) y multipolígono.
export const ringsOf = rings =>
  !Array.isArray(rings[0]?.[0])   ? [rings]
  : Array.isArray(rings[0][0][0]) ? rings.flat()
  : rings

// bbox de un anillo simple [[lat,lng],…], un polígono o un multipolígono. → { minLat, maxLat, minLng, maxLng }.
export const bboxOfRings = rings => {
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity
  const list = ringsOf(rings)
  for (let r = 0; r < list.length; r++) {
    const ring = list[r]
    for (let i = 0; i < ring.length; i++) {
      const lat = ring[i][0], lng = ring[i][1]
      if (lat < minLat) minLat = lat
      if (lat > maxLat) maxLat = lat
      if (lng < minLng) minLng = lng
      if (lng > maxLng) maxLng = lng
    }
  }
  return { minLat, maxLat, minLng, maxLng }
}

// bbox de un path proyectado [{x,y},…] en world0 px. → { minX, maxX, minY, maxY }.
export const bboxOfPoints = pts => {
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

// Caja del tramo de vértices [first, first+count) de un intercalado [lng, lat, …], acumulada sobre
// `out` = [minLng, minLat, maxLng, maxLat] y devuelta. `out` entra sembrado en ±Infinity por el
// llamador y se reusa entre tramos; un tramo vacío lo deja intacto.
export const growBoxOfRange = (xy, first, count, out) => {
  for (let i = first, end = first + count; i < end; i++) {
    const lng = xy[i * 2], lat = xy[i * 2 + 1]
    if (lng < out[0]) out[0] = lng
    if (lat < out[1]) out[1] = lat
    if (lng > out[2]) out[2] = lng
    if (lat > out[3]) out[3] = lat
  }
  return out
}

// Rectángulo por lados (marco de los rects de viewport/tiles).
export const rect = (left, top, right, bottom) => ({ left, top, right, bottom })

// Área de un rect (0 si está colapsado o invertido).
export const area = r =>
  Math.max(0, r.right - r.left) * Math.max(0, r.bottom - r.top)

// Intersección de dos rects (puede quedar colapsada/invertida → area() da 0).
export const intersect = (a, b) =>
  rect(
    Math.max(a.left, b.left),
    Math.max(a.top, b.top),
    Math.min(a.right, b.right),
    Math.min(a.bottom, b.bottom),
  )
