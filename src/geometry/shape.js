// Formas en METROS sobre un modelo de la Tierra (SPECS §18). `ring` y `arc` son la cara pública, y
// `readShape`, `sizeShape` y `writeShape` el escritor que comparten con las capas de círculos y de formas y
// con los editores, para que lo que se dibuja, lo que se pica y lo que se mide salgan del mismo anillo.
// Módulo puro: sin Leaflet, sin DOM, sin el elipsoide.
//
// La elipse se parametriza por la anomalía excéntrica t, no por el lugar focal: el vértice es el destino
// desde el centro a `heading + atan2(v, u)` y `hypot(u, v)` metros, con u = a·cos t y v = b·sin t. El anillo
// parte en `heading`, sigue en sentido horario y no repite el primer vértice.
import { coordOf, isPoint } from '../data/path.js'
import { DESTINATION, MEAN_RADIUS, byDefault, checkPlacer } from './geodesic.js'
import { measureArgs } from './measure.js'
import { GROUND, segmentsFor, stepsFor, viewTolerance } from './density.js'

const D   = Math.PI / 180
const TAU = 2 * Math.PI
const out = [0, 0]   // el destino que escribe el modelo y se lee enseguida

const positive = value => Number.isFinite(value) && value > 0

// La forma con la regla de validez, o `null` si no la cumple. Lee escalares y no retiene `value`: el
// centro puede ser un objeto scratch. `n`, `arc`, `steps` y `half` los fija `sizeShape`.
export const readShape = value => {
  const { center, radius, heading, sweep } = value ?? {}
  const round = typeof radius === 'number'
  const a     = round ? radius : radius?.[0]
  const b     = round ? radius : radius?.[1]
  const whole = sweep == null || sweep >= 360
  const valid = isPoint(center) && positive(a) && positive(b) && (sweep == null || positive(sweep))
    && ((round && whole) || heading == null || Number.isFinite(heading))
  return valid ? {
    lat: coordOf(center, 0), lng: coordOf(center, 1), a, b, round,
    heading: round && whole ? 0 : heading ?? 0, sweep: whole ? 360 : sweep,
    n: 0, arc: 0, steps: 0, half: 0,
  } : null
}

// Si el borde de la forma alcanza un polo, por la cota de la distancia angular del semieje mayor: ahí las
// expresiones del círculo sobre la esfera pierden la lng, y Mercator no tiene un contorno finito.
export const reachesPole = ({ lat, a, b }) => Math.abs(lat) * D + Math.max(a, b) / MEAN_RADIUS >= Math.PI / 2

// La forma que el mapa dibuja: la de `readShape` si no alcanza un polo, o `null`. Es la que la capa de formas
// acepta y la que los editores emiten.
export const readDrawable = value => {
  const s = readShape(value)
  return s && !reachesPole(s) ? s : null
}

// Los segmentos que la vista pide a `zoom` para la forma: los de su semieje mayor, donde la flecha es
// máxima. Con ellos re-teselan la capa de formas y el contorno de los editores.
export const viewSegments = ({ lat, a, b }, zoom) => segmentsFor(Math.max(a, b), viewTolerance(lat, Math.max(a, b), zoom))

// Fija los segmentos de la figura entera en `n` y devuelve cuántos vértices escribe `writeShape`: `n` en la
// figura entera y, en un sector, el centro, los radios sin repetir sus extremos y el arco. Los tramos de
// cada radio salen de la tolerancia sin vista, y no de `n`, que la capa toma de la vista. El arco recorre
// 2·half de anomalía con, a lo más, el paso 2π/n de la figura entera, que es el que acota su flecha; con
// a = b eso es sweep/360, y se cuenta así para que el redondeo de atan2 no sume un tramo en los bordes exactos.
export const sizeShape = (shape, n) => {
  const { lat, a, b, sweep } = shape
  shape.n = n
  if (sweep === 360) return n
  const half  = shape.half = Math.atan2(a * Math.sin(sweep / 2 * D), b * Math.cos(sweep / 2 * D))
  const reach = Math.hypot(a * Math.cos(half), b * Math.sin(half))
  shape.arc   = Math.ceil(n * (a === b ? sweep / 360 : half / Math.PI))
  shape.steps = stepsFor(reach, Math.min(90, Math.abs(lat) + reach / MEAN_RADIUS / D), GROUND)
  return 2 * shape.steps + shape.arc
}

// Escribe en `xy[at]` el destino desde el centro de `shape` al punto (u, v) de su marco —u sobre `rot`, v de
// través— y devuelve dónde sigue. Va libre, y no como lambda de `writeShape`, para no asignar una clausura
// por llamada.
const put = (destination, shape, rot, u, v, xy, at) => {
  destination(shape.lat, shape.lng, rot + Math.atan2(v, u) / D, Math.hypot(u, v), out)
  xy[at]     = out[1]
  xy[at + 1] = out[0]
  return at + 2
}

// Escribe en `xy[at…]` los vértices de la forma dimensionada, como `[lng, lat, …]`, y devuelve dónde
// termina; no asigna, porque el gesto de los editores lo llama por frame. La lng sigue a la del centro sin
// envolverse. Una figura entera redonda no lee `heading`, que en los editores guarda el rumbo de una manija.
// Un círculo entero sobre la esfera por defecto que no alcanza un polo va por las expresiones del destino de
// esa esfera, con `n` vértices a `i·2π/n` desde el norte, sin pasar por la marca.
export const writeShape = (model, shape, xy, at) => {
  const { lat, lng, a, b, heading, sweep, n, arc, steps, half } = shape
  if (sweep === 360 && shape.round && model === byDefault && !reachesPole(shape)) {
    const sinLat = Math.sin(lat * D), cosLat = Math.cos(lat * D)
    const sinD   = Math.sin(a / MEAN_RADIUS), cosD = Math.cos(a / MEAN_RADIUS)
    for (let i = 0; i < n; i++) {
      const bearing = i * TAU / n
      const sinOut  = sinLat * cosD + cosLat * sinD * Math.cos(bearing)
      xy[at++] = lng + Math.atan2(Math.sin(bearing) * sinD * cosLat, cosD - sinLat * sinOut) / D
      xy[at++] = Math.asin(sinOut) / D
    }
    return at
  }
  const destination = model[DESTINATION]
  const rot         = shape.round && sweep === 360 ? 0 : heading
  if (sweep === 360) {
    for (let i = 0; i < n; i++)
      at = put(destination, shape, rot, a * Math.cos(i * TAU / n), b * Math.sin(i * TAU / n), xy, at)
    return at
  }
  // Un sector es [centro, radio, arco, radio]: los radios, a ±half de anomalía, miden lo mismo porque la
  // elipse es simétrica, y sus vértices intermedios van al mismo rumbo, sobre la geodésica.
  const u = a * Math.cos(half), v = b * Math.sin(half)
  xy[at++] = lng
  xy[at++] = lat
  for (let k = 1; k <= steps; k++) at = put(destination, shape, rot, u * (k / steps), -v * (k / steps), xy, at)
  for (let j = 1; j <= arc; j++) {
    const t = half * (2 * j / arc - 1)
    at = put(destination, shape, rot, a * Math.cos(t), b * Math.sin(t), xy, at)
  }
  for (let k = steps - 1; k > 0; k--) at = put(destination, shape, rot, u * (k / steps), v * (k / steps), xy, at)
  return at
}

// La forma colocada con la tolerancia sin vista, como `[lng, lat, …]`; `null` si no hay forma. Con dos
// argumentos el primero es el modelo, que tiene que saber ubicar destinos, y no un terreno.
const place = (name, args) => {
  const { model, polygon: value } = measureArgs(name, args, 'shape')
  checkPlacer(model, name, 'la forma')
  const shape = readShape(value)
  if (!shape) return null
  const xy = new Float64Array(sizeShape(shape, segmentsFor(Math.max(shape.a, shape.b), GROUND)) * 2)
  writeShape(model, shape, xy, 0)
  return { shape, xy }
}

// Los vértices `[from, to)` de `xy` como `[lat, lng]`; un índice que pasa del último vuelve al primero.
export const pairs = (xy, from, to) => {
  const count = xy.length / 2
  return Array.from({ length: to - from }, (_, i) => {
    const at = (from + i) % count * 2
    return [xy[at + 1], xy[at]]
  })
}

export const ring = (...args) => {
  const placed = place('ring', args)
  return placed ? pairs(placed.xy, 0, placed.xy.length / 2) : []
}

// El arco de un sector son los vértices que `writeShape` escribe entre sus dos radios.
export const arc = (...args) => {
  const placed = place('arc', args)
  if (!placed) return []
  const { shape, xy } = placed
  return shape.sweep === 360 ? pairs(xy, 0, shape.n + 1) : pairs(xy, shape.steps, shape.steps + shape.arc + 1)
}
