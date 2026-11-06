// Polo de inaccesibilidad: el punto de un polígono más lejano de su borde, que es donde un rótulo cae
// adentro y con más aire. El centroide no sirve, porque en un polígono en C cae afuera. Búsqueda por
// cuadrícula con cota superior, como polylabel: una celda se parte mientras su mejor caso posible supere
// al mejor encontrado en más de `precision`. Plano y sin unidades: lo usan los rótulos en world0. Módulo
// puro: sin Leaflet, sin DOM.

const SQRT2 = Math.SQRT2

// Distancia con signo de (x, y) al borde de los anillos: positiva adentro por paridad, negativa afuera.
// Cada anillo cierra solo; repetir el primer vértice al final agrega una arista de largo cero.
const signedDistance = (x, y, rings) => {
  let inside = false
  let min    = Infinity
  rings.forEach(ring => {
    const n = ring.length >> 1
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const ax = ring[2 * i], ay = ring[2 * i + 1]
      const bx = ring[2 * j], by = ring[2 * j + 1]
      if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) inside = !inside
      const dx = bx - ax, dy = by - ay
      const l2 = dx * dx + dy * dy
      const t  = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0
      const ex = ax + t * dx - x, ey = ay + t * dy - y
      min = Math.min(min, ex * ex + ey * ey)
    }
  })
  return (inside ? 1 : -1) * Math.sqrt(min)
}

const cell = (x, y, h, rings) => {
  const d = signedDistance(x, y, rings)
  return { x, y, h, d, max: d + h * SQRT2 }
}

// Cola de prioridad por `max`, de mayor a menor.
const push = (heap, c) => {
  let i = heap.push(c) - 1
  while (i > 0) {
    const up = (i - 1) >> 1
    if (heap[up].max >= c.max) break
    heap[i] = heap[up]
    i       = up
  }
  heap[i] = c
}

const pop = heap => {
  const top  = heap[0]
  const last = heap.pop()
  if (!heap.length) return top
  let i = 0
  for (;;) {
    const l = 2 * i + 1, r = l + 1
    let big = l < heap.length && heap[l].max > last.max ? l : -1
    if (r < heap.length && heap[r].max > (big < 0 ? last.max : heap[big].max)) big = r
    if (big < 0) break
    heap[i] = heap[big]
    i       = big
  }
  heap[i] = last
  return top
}

/** El polo de `rings`, el primero el exterior y los demás sus huecos, cada uno plano `[x, y, …]`.
 *  Devuelve `{ x, y, distance }`, con la distancia al borde, o null sin vértices. Un exterior sin área
 *  (un punto, un segmento) da el centro de su caja con distancia 0. `precision` es la tolerancia en la
 *  unidad de los vértices; por defecto, 1/100 del lado mayor de la caja del exterior. */
export const pole = (rings, precision) => {
  const outer = rings[0]
  const n     = outer ? outer.length >> 1 : 0
  if (!n) return null

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  let area = 0, sx = 0, sy = 0
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const ax = outer[2 * i], ay = outer[2 * i + 1], bx = outer[2 * j], by = outer[2 * j + 1]
    const f  = ax * by - bx * ay
    minX = Math.min(minX, ax)
    minY = Math.min(minY, ay)
    maxX = Math.max(maxX, ax)
    maxY = Math.max(maxY, ay)
    area += f
    sx   += (ax + bx) * f
    sy   += (ay + by) * f
  }
  const width = maxX - minX, height = maxY - minY
  const side  = Math.min(width, height)
  if (!(side > 0) || !area) return { x: minX + width / 2, y: minY + height / 2, distance: 0 }

  const tolerance = precision > 0 ? precision : Math.max(width, height) / 100
  const heap      = []
  const h         = side / 2
  for (let x = minX; x < maxX; x += side)
    for (let y = minY; y < maxY; y += side) push(heap, cell(x + h, y + h, h, rings))

  // El centroide y el centro de la caja son buenos puntos de partida en polígonos convexos y casi.
  let best = cell(sx / (3 * area), sy / (3 * area), 0, rings)
  const mid = cell(minX + width / 2, minY + height / 2, 0, rings)
  if (mid.d > best.d) best = mid

  while (heap.length) {
    const c = pop(heap)
    if (c.d > best.d) best = c
    if (c.max - best.d <= tolerance) continue
    const k = c.h / 2
    push(heap, cell(c.x - k, c.y - k, k, rings))
    push(heap, cell(c.x + k, c.y - k, k, rings))
    push(heap, cell(c.x - k, c.y + k, k, rings))
    push(heap, cell(c.x + k, c.y + k, k, rings))
  }
  return { x: best.x, y: best.y, distance: best.d }
}
