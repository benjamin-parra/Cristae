// Cajas en grados, `{ south, west, north, east }`: los lados de la caja que cubre unos puntos, por
// mínimo y máximo. La longitud no se envuelve: una caja que cruza el antimeridiano lleva el este pasado
// de 180, y con el oeste al este del este no es una caja. Es la caja de la API, de los encuadres y de lo
// que una capa informa como propia; las cajas de trabajo de los índices, sin regla de lugar, viven en
// bbox.js. Módulo puro, como geodesic.js: sin Leaflet, sin DOM.
import { coordOf, isPlace, isPoint, iterable } from '../data/path.js'
import { foldArgs, foldRuns } from './polyline.js'

// La caja vacía, que el primer lugar que se le suma vuelve la caja de un punto. Hasta entonces no es una
// caja: `readBounds` la rechaza, y con él decide todo el que acumula si le quedó alguna.
export const emptyBounds = () => ({ south: Infinity, west: Infinity, north: -Infinity, east: -Infinity })

// Estira `box` hasta (lat, lng), que ya pasaron su regla, y la devuelve.
const stretch = (box, lat, lng) => {
  if (lat < box.south) box.south = lat
  if (lng < box.west) box.west = lng
  if (lat > box.north) box.north = lat
  if (lng > box.east) box.east = lng
  return box
}

// Estira `box` hasta (lat, lng) si son un lugar: fuera de ahí no hay caja que encuadrar. Los encuadres
// del motor y de la cámara leen posiciones sueltas, sin la regla de forma del punto.
export const growBounds = (box, lat, lng) => (isPlace(lat, lng) ? stretch(box, lat, lng) : box)

// Un tramo de `foldRuns`, sumado a la caja sin volver a validarlo: sus vértices ya pasaron la regla de
// punto. Vive en el módulo, estable entre llamadas, por lo que dice `foldRuns`.
export const growRun = (box, vertices, first, count) => {
  for (let i = first; i < first + count; i++)
    stretch(box, coordOf(vertices[i], 0), coordOf(vertices[i], 1))
  return box
}

// Un tipado plano, intercalado [lat, lng, …], sumado a la caja.
const growTyped = (box, v) => {
  for (let i = 0; i + 1 < v.length; i += 2) growBounds(box, v[i], v[i + 1])
  return box
}

// Una coordenada de positionOf o de ringsOf llega como `{lat,lng}`, `[lat,lng]`, un anidado, un iterable
// o un tipado plano. Se recorre sin materializar pares. Estable en el módulo: sin clausura por ítem.
const walk = (box, v) => {
  if (ArrayBuffer.isView(v)) return growTyped(box, v)
  if (Array.isArray(v)) {
    if (typeof v[0] === 'number') return growBounds(box, v[0], v[1])
    for (let i = 0; i < v.length; i++) walk(box, v[i])
    return box
  }
  if (typeof v?.lat === 'number') return growBounds(box, v.lat, v.lng)
  if (iterable(v)) for (const x of v) walk(box, x)
  return box
}

// Suma a `box` lo que dibuja un ítem, según el accessor que tenga su Source: `positionOf`, si no `pathOf`
// —con el contrato de path de las líneas, sus formas de punto y su regla de corte: ahí una vista tipada es
// un vértice, no un plano—, si no `ringsOf`. Un ítem sin lugares no estira nada. No sale de este módulo
// hacia geometry/index.js: lo usan el motor y la cámara.
export const growItem = (box, accessors, item) => {
  if (accessors.positionOf) return walk(box, accessors.positionOf(item))
  if (accessors.pathOf) return foldRuns(accessors.pathOf(item), growRun, box)
  if (accessors.ringsOf) return walk(box, accessors.ringsOf(item))
  return box
}

// La caja de los puntos, con las formas de llamada de `distance` sin el modelo. Un vértice suelto entre
// dos cortes también es un lugar, así que se pliegan los tramos de uno.
export const boundsOf = (...args) => readBounds(foldArgs(args, growRun, emptyBounds(), null, 1))

// El único lector de una caja de entrada. Una `Bounds` nombra sus lados y no se reordena: es una caja si
// sus dos esquinas son lugares y ni el sur queda sobre el norte ni el oeste al este del este, y entonces
// se devuelve ella misma, sin copiarla, porque `boundsContain` corre por punto. Un par son dos esquinas
// opuestas cualesquiera, en cualquier forma de punto, y su caja es la de los dos puntos. Lo demás no es
// una caja.
export const readBounds = b =>
  typeof b?.south === 'number'
    ? (isPlace(b.south, b.west) && isPlace(b.north, b.east) && b.south <= b.north && b.west <= b.east ? b : null)
    : Array.isArray(b) && b.length === 2 && isPoint(b[0]) && isPoint(b[1]) ? boundsOf(b[0], b[1])
    : null

// La caja agrandada por cada lado en `ratio` de su alto y de su ancho; un ratio negativo la achica. La
// latitud se acota a [-90, 90] para que siga siendo una caja, y un ratio que la invierte no deja caja.
export const boundsPad = (bounds, ratio) => {
  const b = readBounds(bounds)
  if (!b) return null
  const dLat = (b.north - b.south) * ratio
  const dLng = (b.east - b.west) * ratio
  return readBounds({
    south : Math.max(b.south - dLat, -90),
    west  : b.west - dLng,
    north : Math.min(b.north + dLat, 90),
    east  : b.east + dLng,
  })
}

// Si el punto cae en la caja, con los bordes adentro. La longitud del punto tampoco se envuelve: uno de
// otra copia del mundo cae afuera.
export const boundsContain = (bounds, point) => {
  const b = readBounds(bounds)
  if (!b || !isPoint(point)) return false
  const lat = coordOf(point, 0)
  const lng = coordOf(point, 1)
  return lat >= b.south && lat <= b.north && lng >= b.west && lng <= b.east
}

export const boundsCenter = bounds => {
  const b = readBounds(bounds)
  return b && { lat: (b.south + b.north) / 2, lng: (b.west + b.east) / 2 }
}
