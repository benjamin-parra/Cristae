// Medidas de una ZONA en metros sobre un modelo de la Tierra: el área, el perímetro y el diámetro de un
// anillo, de un polígono con huecos o de un multipolígono, en grados. Las aristas son las geodésicas
// del modelo, las mismas que mide `distance`, así que el área y el perímetro hablan de los mismos
// bordes. El área la pone el núcleo `AREA` de cada modelo, anillo por anillo; la composición de la
// zona vive acá. Módulo puro: sin Leaflet, sin DOM, sin el elipsoide.
import { coordOf, isPoint } from '../data/path.js'
import { AREA, MODEL, RELIEF, byDefault, isModel } from './geodesic.js'
import { lowerBoundBy } from './binary-search.js'

const D   = Math.PI / 180
const TAU = 2 * Math.PI

const isBlank = e => e == null || (Array.isArray(e) && e.length === 0)
const below   = (angle, start) => angle < start

// El nivel de una zona lo da la profundidad de su primer vértice, saltando lo nulo y `[]`: 1 es un
// anillo, 2 un polígono y 3 un multipolígono, y 0 quiere decir que nada decide. Un vértice es lo que no
// es un array —un objeto punto, una vista tipada, un primitivo— o un array cuya lat o lng no es un
// objeto, como se lee un punto. Una lista sin vértices, como `[null, null]`, no decide: el nivel lo da
// lo que la sigue. A la profundidad de los vértices de un multipolígono, lo que no es nulo ni `[]`
// decide como vértice, y la lectura lo da por inválido.
const levelOf = (list, depth) => {
  for (const e of list) {
    const vertex = !Array.isArray(e) || typeof (e[0] ?? e[1]) !== 'object'
    const level  = isBlank(e) ? 0 : vertex || depth === 3 ? depth : levelOf(e, depth + 1)
    if (level) return level
  }
  return 0
}

// Recorre la zona y llama `acc = step(acc, coords, count, hole)` una vez por anillo no vacío,
// polígono por polígono y con el exterior primero. `coords` es un `Float64Array` nuevo de largo exacto
// 2·count, `[lat, lng, …]`. Devuelve `acc`, o `null` si la zona no es válida. Un último vértice igual
// al primero se descarta: la arista de cierre es implícita, y repetirla correría el orden de suma del
// área, que en la esfera se nota en los últimos bits. Un anillo no se corta como un path: saltar un
// vértice que no es punto —una ranura vacía de un array disperso incluida— uniría a sus vecinos con
// una arista que no existe, así que uno solo invalida la zona. Un anillo o un polígono nulo o vacío no
// aporta, y un exterior nulo o vacío se lleva sus huecos sin leerlos. En la posición de un anillo o de
// un polígono, lo que no es array, ni nulo, ni `[]` invalida la zona.
export const foldRings = (polygon, step, acc) => {
  if (polygon == null) return acc
  if (!Array.isArray(polygon)) return null
  const level = levelOf(polygon, 1)
  if (!level) return acc

  const parts = level === 1 ? [[polygon]] : level === 2 ? [polygon] : polygon
  for (const part of parts) {
    if (isBlank(part)) continue
    if (!Array.isArray(part)) return null
    if (isBlank(part[0])) continue
    for (let r = 0; r < part.length; r++) {
      const ring = part[r]
      if (isBlank(ring)) continue
      if (!Array.isArray(ring)) return null
      const coords = new Float64Array(ring.length * 2)
      for (let i = 0; i < ring.length; i++) {
        const p = ring[i]
        if (!isPoint(p)) return null
        coords[i * 2]     = coordOf(p, 0)
        coords[i * 2 + 1] = coordOf(p, 1)
      }
      const last   = ring.length - 1
      const closed = last > 0 && coords[0] === coords[last * 2] && coords[1] === coords[last * 2 + 1]
      const count  = closed ? last : ring.length
      acc = step(acc, coords.subarray(0, count * 2), count, r > 0)
    }
  }
  return acc
}

// El modelo, si viene, es el primero, como en `distance`; con dos argumentos tiene que serlo. La zona
// no puede ser un modelo ni una función: es un error del llamador, y medirla como un dato malo lo
// escondería.
const measureArgs = (name, args) => {
  const polygon = args[args.length - 1]
  const misused = args.length > 2 || (args.length === 2 && !isModel(args[0]))
  if (misused || isModel(polygon) || typeof polygon === 'function')
    throw new TypeError(`[${name}] recibe (model?, polygon): el modelo va primero, y construido: sphere(), no sphere`)
  return { model: args.length === 2 ? args[0] : byDefault, polygon }
}

// El paso de `foldRings` que suma el área de una zona con el núcleo `AREA` de un modelo: por polígono el
// exterior suma y los huecos restan, y los polígonos se suman, todo sobre un solo total. Un anillo de
// menos de tres vértices no encierra nada y no llega al núcleo, que exige tres. Lo comparten `area` y el
// relieve, que reparte ese total entre sus celdas.
export const areaStep = core => (total, coords, count, hole) =>
  count < 3 ? total : hole ? total - core(coords, count) : total + core(coords, count)

export const area = (...args) => {
  const { model, polygon } = measureArgs('area', args)
  const core = model[AREA]
  if (typeof core !== 'function')
    throw new TypeError('[area] este modelo no mide áreas: viene de una versión de Cristae anterior a las áreas, o de otra implementación')
  return foldRings(polygon, areaStep(core), 0) ?? NaN
}

// Cada arista con el núcleo del modelo, la de cierre al final, y los anillos seguidos sobre un solo
// total: con un anillo es, bit a bit, `distance` del anillo cerrado.
export const perimeter = (...args) => {
  const { model, polygon } = measureArgs('perimeter', args)
  const arc = model[MODEL]
  const sum = (total, coords, count) => {
    for (let i = 0; i < count; i++) {
      const j = (i + 1) % count
      total += arc(coords[i * 2], coords[i * 2 + 1], coords[j * 2], coords[j * 2 + 1])
    }
    return total
  }
  return foldRings(polygon, sum, 0) ?? NaN
}

// La mayor distancia entre dos vértices, sin la fuerza bruta de n² llamadas al modelo. Los vértices
// se llevan a la gnomónica centrada en la zona, que manda los círculos máximos a rectas: el casco plano
// es el esférico, y el par más lejano son dos vértices del casco casi antípodas. Se buscan en una
// ventana de calibres con una tolerancia demostrada, γ = β(ρ) + Δa. β acota, en la esfera, cuánto se
// aparta de antípoda el par más lejano de una zona de radio angular ρ: las rectas de apoyo
// perpendiculares al par se cortan en la imagen del polo de su círculo máximo, a ≥ cot ρ del origen,
// mientras que los vértices quedan a ≤ tan ρ. Δa cubre que en el elipsoide la perpendicular rota
// distinto en cada punta: es cuánto cambia, entre las latitudes de la zona, la razón entre la escala
// norte–sur y la este–oeste del modelo, medida con el propio modelo.
//
// Que el par más lejano esté en el casco pide además que las bolas del modelo de radio hasta 2ρ sean
// convexas en la gnomónica. En la esfera lo son: su borde se curva cot 2ρ, y las rectas son círculos
// máximos. En el elipsoide la anisotropía A —cuánto se aparta de 1 esa razón en el ecuador, donde es
// máxima— dobla el borde, y una bola de casi 90° deja de ser convexa: el vértice que el casco descarta
// por colineal puede quedar más lejos. No hay demostración de cuánto; se midió contra la fuerza bruta
// con achatamientos de 1/298 a 0,95, y la última falla está en cot 2ρ = 0,76·A, en el ecuador de WGS84.
// Por eso una zona con cot 2ρ ≤ 2·A, una de radio angular ≥ 45°, o una tan repartida que no tiene
// centro, se mide sobre todos los pares: es el único camino cuadrático. En WGS84 el umbral cae en un
// radio de 44,6°.
// Todo esto supone que la distancia del modelo es la geodésica de un elipsoide de revolución, como la
// de `sphere` y `ellipsoid`: con otra métrica, el máximo sólo lo da medir todos los pares.
export const diameter = (...args) => {
  const { model, polygon } = measureArgs('diameter', args)
  if (model[RELIEF]) throw new TypeError('[diameter] mide en horizontal: pasa el modelo base, no el terreno')
  const rings = foldRings(polygon, (list, coords) => {
    list.push(coords)
    return list
  }, [])
  if (rings === null) return NaN
  const points = new Float64Array(rings.reduce((total, coords) => total + coords.length, 0))
  const n      = points.length / 2
  if (n < 2) return 0

  let offset = 0
  rings.forEach(coords => {
    points.set(coords, offset)
    offset += coords.length
  })
  const arc       = model[MODEL]
  const pair      = (i, j) => arc(points[i * 2], points[i * 2 + 1], points[j * 2], points[j * 2 + 1])
  const everyPair = () => {
    let best = 0
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) best = Math.max(best, pair(i, j))
    return best
  }
  const unit = new Float64Array(n * 3)
  let sx = 0, sy = 0, sz = 0, minLat = 90, maxLat = -90
  for (let i = 0; i < n; i++) {
    const lat = points[i * 2] * D, lng = points[i * 2 + 1] * D
    unit[i * 3]     = Math.cos(lat) * Math.cos(lng)
    unit[i * 3 + 1] = Math.cos(lat) * Math.sin(lng)
    unit[i * 3 + 2] = Math.sin(lat)
    sx    += unit[i * 3]
    sy    += unit[i * 3 + 1]
    sz    += unit[i * 3 + 2]
    minLat = Math.min(minLat, points[i * 2])
    maxLat = Math.max(maxLat, points[i * 2])
  }
  const norm = Math.hypot(sx, sy, sz)
  if (norm < 1e-9 * n) return everyPair()

  const cx = sx / norm, cy = sy / norm, cz = sz / norm
  let nearest = 1
  for (let i = 0; i < n; i++)
    nearest = Math.min(nearest, unit[i * 3] * cx + unit[i * 3 + 1] * cy + unit[i * 3 + 2] * cz)
  const rho = Math.acos(Math.max(-1, nearest))
  if (rho >= Math.PI / 4) return everyPair()

  // Cada razón se mide a ±10⁻⁴ rad en el meridiano del centro: la de la zona en sus latitudes extremas
  // y en el ecuador si lo cruza, y la anisotropía en el ecuador, donde la del elipsoide es máxima.
  const latC    = Math.asin(cz), lngC = Math.atan2(cy, cx)
  const delta   = 1e-4 / D
  const lng     = lngC / D
  const ratioAt = latitude => {
    const lat   = Math.min(89, Math.max(-89, latitude))
    const north = arc(lat - delta, lng, lat + delta, lng)
    const east  = arc(lat, lng - delta, lat, lng + delta) / Math.cos(lat * D)
    return north / east
  }
  const ratios     = [minLat, maxLat].map(ratioAt)
  const equator    = ratioAt(0)
  const anisotropy = Math.max(equator, 1 / equator) - 1
  if (2 * anisotropy * Math.tan(2 * rho) >= 1) return everyPair()
  minLat < 0 && maxLat > 0 && ratios.push(equator)

  // La gnomónica en c, con e₁ al este y e₂ al norte del centro. Con ρ < 45°, v·c > 0,7.
  const e1x   = -Math.sin(lngC), e1y = Math.cos(lngC)
  const e2x   = -Math.sin(latC) * Math.cos(lngC), e2y = -Math.sin(latC) * Math.sin(lngC), e2z = Math.cos(latC)
  const px    = new Float64Array(n)
  const py    = new Float64Array(n)
  const order = new Uint32Array(n)
  for (let i = 0; i < n; i++) {
    const x   = unit[i * 3], y = unit[i * 3 + 1], z = unit[i * 3 + 2]
    const dot = x * cx + y * cy + z * cz
    px[i]    = (x * e1x + y * e1y) / dot
    py[i]    = (x * e2x + y * e2y + z * e2z) / dot
    order[i] = i
  }

  // El casco por la cadena monótona de Andrew, antihorario y sin colineales: la mitad de abajo y
  // después la de arriba, que nunca desapila la de abajo.
  order.sort((a, b) => px[a] - px[b] || py[a] - py[b])
  const hull = new Uint32Array(n * 2)
  let h = 0, floor = 2
  for (let k = 0; k < n * 2 - 1; k++) {
    const next = order[k < n ? k : n * 2 - 2 - k]
    if (k === n) floor = h + 1
    while (h >= floor) {
      const o = hull[h - 2], a = hull[h - 1]
      if ((px[a] - px[o]) * (py[next] - py[o]) - (py[a] - py[o]) * (px[next] - px[o]) > 0) break
      h--
    }
    hull[h++] = next
  }
  h--
  if (h < 3) return h === 2 ? pair(hull[0], hull[1]) : 0

  // θ_k es el rumbo de la arista k → k+1, desenrollado para que crezca y dé una vuelta: el cono del
  // vértice k es [θ_{k−1}, θ_k], con θ_{−1} = θ_{h−1} − 2π.
  const theta = new Float64Array(h)
  for (let k = 0; k < h; k++) {
    const a     = hull[k], b = hull[(k + 1) % h]
    const angle = Math.atan2(py[b] - py[a], px[b] - px[a])
    theta[k] = k > 0 && angle < theta[k - 1] ? angle + TAU : angle
  }
  const t     = Math.tan(rho)
  const gamma = 2 * Math.asin(Math.min(1, t * t / (1 - t * t))) + Math.max(...ratios) - Math.min(...ratios)

  // Para cada vértice i, los conos que cortan su cono girado en π, ensanchado en γ. La ventana se lleva
  // a la vuelta de θ, la búsqueda binaria da el primer cono que la toca y se avanza mientras empiecen
  // dentro. Basta medir hacia los j > i: la condición es simétrica.
  let best = 0
  for (let i = 0; i < h; i++) {
    const from  = (i > 0 ? theta[i - 1] : theta[h - 1] - TAU) + Math.PI - gamma
    const to    = theta[i] + Math.PI + gamma
    const all   = to - from >= TAU
    const shift = TAU * Math.floor((from - theta[h - 1]) / TAU + 1)
    for (let j = all ? 0 : lowerBoundBy(theta, from - shift, below), stop = j + h; j < stop; j++) {
      if (!all && theta[(j - 1 + h) % h] + TAU * Math.floor((j - 1) / h) > to - shift) break
      if (j % h > i) best = Math.max(best, pair(hull[i], hull[j % h]))
    }
  }
  return best
}
