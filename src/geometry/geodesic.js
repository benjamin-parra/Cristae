// Distancias en METROS sobre un modelo de la Tierra. El defecto es la esfera de radio medio IUGG
// (R1 = 6 371 008,8 m) con haversine, que contra el elipsoide WGS84 se desvía hasta 0,56 %; dónde, lo
// dice docs/geometry.md. `sphere(radius)` existe para reproducir las cifras de un sistema que mide con
// otro radio, y `ellipsoid` (ellipsoid.js) da la geodésica del elipsoide, a precisión geodésica.
// Cada modelo trae también el área de un anillo, que usan las medidas de zona (measure.js), y el destino y
// el rumbo entre puntos, que usan las formas.
// Módulo puro: sin Leaflet, sin DOM, sin el elipsoide.
import { coordOf } from '../data/path.js'
import { compass, foldArgs } from './polyline.js'

const D = Math.PI / 180

// El radio de la esfera por defecto, en metros. Quien coloca puntos a una distancia dada y después los
// mide con la esfera por defecto tiene que usar este mismo radio, o el punto cae a otra distancia de la que
// se pidió.
export const MEAN_RADIUS = 6371008.8

// La marca de un modelo es a la vez su núcleo: `model[MODEL](lat1, lng1, lat2, lng2)` son los metros
// entre dos puntos válidos, en grados. Va en el registro global de símbolos, y no es una clase, para
// que una copia de la librería reconozca los modelos de otra cargada en la misma página: `instanceof`
// no cruza copias. Por eso esa firma es un protocolo entre versiones, y no cambia.
//
// Las demás marcas son aditivas y sus firmas quedan igual de congeladas. `model[AREA](coords, count)`
// son los m² sin signo de la menor de las dos regiones que separa un anillo: `coords` intercala
// `[lat, lng, …]` en grados, y sus primeros `count ≥ 3` vértices son puntos válidos, con la arista del
// último al primero implícita. Va por anillo y con primitivos para que la composición de una zona
// —exterior menos huecos, suma de partes— quede en `area` y no en el protocolo. Un modelo sin `AREA`,
// el de una copia anterior o el de otra implementación, sigue sirviendo a lo que sólo mide tramos.
// `model[DESTINATION](lat, lng, heading, meters, out)` escribe en `out[0..1]` el `[lat, lng]` del punto al
// que se llega desde uno válido, a ese rumbo (0 = N, 90 = E, cualquier real) y esos metros (uno negativo
// mira al lado opuesto): el problema directo. Su lng sigue a la de partida sin envolverse, así que una
// geodésica que cruza el antimeridiano no salta. `model[HEADING](lat1, lng1, lat2, lng2)` es el rumbo
// inicial, en [0, 360), de la geodésica de un punto al otro, y `NaN` si coinciden: el problema inverso.
// Un terreno es un modelo que además trae `ELEVATION` —`(lat, lng) → m`, la altura en un punto válido— y
// `RELIEF`, y mide sobre el relieve. `RELIEF` es lo que lo distingue: lo que mide en horizontal lo
// rechaza como modelo. No trae `DESTINATION` ni `HEADING`: no hay un destino a tantos metros de relieve.
export const MODEL       = Symbol.for('cristae.geometry.model')
export const AREA        = Symbol.for('cristae.geometry.area')
export const DESTINATION = Symbol.for('cristae.geometry.destination')
export const HEADING     = Symbol.for('cristae.geometry.heading')
export const ELEVATION   = Symbol.for('cristae.geometry.elevation')
export const RELIEF      = Symbol.for('cristae.geometry.relief')
export const isModel     = value => typeof value?.[MODEL] === 'function'

// Un modelo es inmutable y se valida al construirlo, no en medio de un track: un radio o un semieje
// es un número finito mayor que 0.
export const makeModel   = (distanceCore, areaCore, destinationCore, headingCore) => Object.freeze({
  [MODEL]: distanceCore, [AREA]: areaCore, [DESTINATION]: destinationCore, [HEADING]: headingCore,
})
export const checkLength = (length, name) => {
  if (!(Number.isFinite(length) && length > 0))
    throw new RangeError(`${name} tiene que ser un número finito mayor que 0: ${length}`)
}

// El modelo que coloca puntos —`ring`, `arc`, `geodesic`— no es un terreno, que mide sobre el relieve y no
// trae destino, y sabe ubicar destinos. `noun` dice qué se coloca.
export const checkPlacer = (model, name, noun) => {
  if (model[RELIEF])
    throw new TypeError(`[${name}] coloca ${noun} en horizontal: pasa el modelo base, no el terreno`)
  if (typeof model[DESTINATION] !== 'function') throw new TypeError(`[${name}] este modelo no ubica destinos`)
}

// Lo que además pide una pieza que se orienta por el puntero o por otro punto: que sepa dar rumbos.
export const checkHeading = (model, name) => {
  if (typeof model[HEADING] !== 'function') throw new TypeError(`[${name}] este modelo no ubica rumbos`)
}

// El núcleo de la esfera mide dos puntos en grados, sin validarlos, con la haversine: estable a
// escala de centímetros, donde la ley de cosenos pierde los dígitos. El término se acota a [0, 1]
// porque en pares casi antípodas el redondeo lo empuja sobre 1, y ahí `asin` da NaN. El antimeridiano
// no necesita caso aparte: sin² tiene período π.
//
// El área es exacta para aristas de círculo máximo: cada arista aporta el exceso con signo del
// cuadrilátero que forma con el ecuador (Bevis y Cambareri), escrito con `atan2` para que un Δλ de
// ±180° no divida por cero. El Δλ se reduce con `round`, que deja exacto un Δλ chico: la reducción
// por módulo lo redondea y mete error relativo en una figura de pocas hectáreas. Un giro neto impar
// es un anillo que rodea un polo, y sin corregirlo en ±2π mediría la franja hasta el ecuador: se elige
// el signo que achica el exceso. El complemento `4π − e` se toma sólo pasado 2π, porque reducir
// siempre por módulo y quedarse con el menor cancela los dígitos de una figura chica de giro negativo.
// Antes, |e| se reduce por módulo 4π: un anillo que se superpone a sí mismo puede pasar de 4π, y el
// módulo deja exacto lo que no llega.
//
// El destino escribe el punto de llegada por sus componentes —`east` y `north`, que valen cos φ₂·sin Δλ y
// cos φ₂·cos Δλ, y `up`, sin φ₂—: la latitud y el Δλ salen de `atan2`, sin `asin`, que pierde dígitos junto
// a un polo, y sin dividir por cos φ₁, que en el polo es 0: ahí el Δλ sale con la convención de la
// librería geodésica. El rumbo es el `atan2` cerrado, con el Δλ reducido como el del área para que una
// vuelta de más coincida exacta; los dos puntos en un mismo polo son el mismo punto.
export const sphere = (radius = MEAN_RADIUS) => {
  checkLength(radius, '[sphere] radius')
  return makeModel((lat1, lng1, lat2, lng2) => {
    const sLat = Math.sin((lat2 - lat1) * D / 2)
    const sLng = Math.sin((lng2 - lng1) * D / 2)
    const h    = sLat * sLat + Math.cos(lat1 * D) * Math.cos(lat2 * D) * sLng * sLng
    return radius * 2 * Math.asin(Math.sqrt(h < 0 ? 0 : h > 1 ? 1 : h))
  }, (coords, count) => {
    let excess = 0
    let turn   = 0
    let lng    = coords[count * 2 - 1]
    let t1     = Math.tan(coords[count * 2 - 2] * D / 2)
    for (let i = 0; i < count; i++) {
      const t2   = Math.tan(coords[i * 2] * D / 2)
      const step = coords[i * 2 + 1] - lng
      const dLng = step - 360 * Math.round(step / 360)
      const h    = dLng * D / 2
      excess += 2 * Math.atan2(Math.sin(h) * (t1 + t2), Math.cos(h) * (1 + t1 * t2))
      turn   += dLng
      lng     = coords[i * 2 + 1]
      t1      = t2
    }
    if (Math.round(turn / 360) & 1) excess += excess > 0 ? -2 * Math.PI : 2 * Math.PI
    const e = Math.abs(excess) % (4 * Math.PI)
    return radius * radius * (e > 2 * Math.PI ? 4 * Math.PI - e : e)
  }, (lat, lng, heading, meters, out) => {
    const bearing = heading * D
    const sinB    = Math.sin(bearing), cosB = Math.cos(bearing)
    const sinLat  = Math.sin(lat * D), cosLat = Math.cos(lat * D)
    const sinD    = Math.sin(meters / radius), cosD = Math.cos(meters / radius)
    const east    = sinB * sinD
    const north   = cosLat * cosD - sinLat * sinD * cosB
    const up      = sinLat * cosD + cosLat * sinD * cosB
    out[0] = Math.atan2(up, Math.sqrt(east * east + north * north)) / D
    out[1] = lng + Math.atan2(east, north) / D
    return out
  }, (lat1, lng1, lat2, lng2) => {
    const step = lng2 - lng1
    const dLng = (step - 360 * Math.round(step / 360)) * D
    if (lat1 === lat2 && (dLng === 0 || Math.abs(lat1) === 90)) return NaN
    const cos2 = Math.cos(lat2 * D)
    const y    = Math.sin(dLng) * cos2
    const x    = Math.cos(lat1 * D) * Math.sin(lat2 * D) - Math.sin(lat1 * D) * cos2 * Math.cos(dLng)
    return compass(Math.atan2(y, x) / D)
  })
}

export const byDefault = sphere()

// Los metros de un tramo, sumados sobre `walk.meters` con el núcleo del modelo. El tramo ya llega
// validado, y cada vértice se lee una sola vez, en su lugar.
const measureRun = (walk, vertices, first, count) => {
  const arc  = walk.arc
  let meters = walk.meters
  let lat    = coordOf(vertices[first], 0)
  let lng    = coordOf(vertices[first], 1)
  for (let i = first + 1; i < first + count; i++) {
    const nextLat = coordOf(vertices[i], 0)
    const nextLng = coordOf(vertices[i], 1)
    meters += arc(lat, lng, nextLat, nextLng)
    lat = nextLat
    lng = nextLng
  }
  walk.meters   = meters
  walk.measured = true
  return walk
}

// Un vértice que no es punto es un dato malo, salvo un modelo o una función: eso es un error del
// llamador —un modelo fuera del primer lugar, una fábrica sin llamar—, y medirlo como un corte, con el
// modelo por defecto, lo escondería.
const markCut = (walk, vertex) => {
  if (isModel(vertex) || typeof vertex === 'function')
    throw new TypeError('[distance] el modelo va primero, y construido: sphere(), no sphere')
  walk.invalid = true
  return walk
}

// El modelo, si viene, es el primer argumento, para que los puntos queden al final, variádicos. Se
// reconoce por su marca, y null no la tiene: `distance(xs[0], xs[1])` sobre un array vacío son dos
// puntos inválidos, no «el modelo por defecto y un punto». Los demás se leen como dice `foldArgs`: un
// objeto inválido solo, o un string, es un punto inválido y da NaN como un par inválido, no el 0 de un
// path vacío. Un punto inválido corta como en `toParts` y el hueco no suma. Si hubo datos y ninguno
// sirvió —algún inválido y ningún tramo— la distancia es NaN, no un 0 que se sumaría después como si
// fuera un tramo real; un modelo fuera de lugar, en cambio, lanza (`markCut`).
export const distance = (...args) => {
  const model = isModel(args[0]) ? args.shift() : byDefault
  const start = { arc: model[MODEL], meters: 0, measured: false, invalid: false }
  const walk  = foldArgs(args, measureRun, start, markCut)
  return walk.invalid && !walk.measured ? NaN : walk.meters
}
