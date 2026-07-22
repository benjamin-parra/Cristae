// Álgebra de bounding-boxes / rectángulos, pura y sin dominio: min/max de coordenadas + intersección
// de rectángulos. Reusable por quien indexe por extensión: la comparten el hit-test de polígonos
// (anillos [lat,lng]), el de líneas (puntos {x,y} proyectados) y el scoring de snapshots de tiles.

// bbox de un anillo simple [[lat,lng],…] o multi-anillo [[[lat,lng],…],…]. → { minLat, maxLat, minLng, maxLng }.
export const bboxOfRings = (rings) => {
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity
  const list = Array.isArray(rings[0]?.[0]) ? rings : [rings]
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
export const bboxOfPoints = (pts) => {
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

// Rectángulo por lados (marco de los rects de viewport/tiles).
export const rect = (left, top, right, bottom) => ({ left, top, right, bottom })

// Área de un rect (0 si está colapsado o invertido).
export const area = (r) =>
  Math.max(0, r.right - r.left) * Math.max(0, r.bottom - r.top)

// Intersección de dos rects (puede quedar colapsada/invertida → area() da 0).
export const intersect = (a, b) =>
  rect(
    Math.max(a.left, b.left),
    Math.max(a.top, b.top),
    Math.min(a.right, b.right),
    Math.min(a.bottom, b.bottom),
  )
