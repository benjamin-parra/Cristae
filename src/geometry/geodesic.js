// Distancias en METROS sobre un modelo de la Tierra. El defecto es la esfera de radio medio IUGG
// (R1 = 6 371 008,8 m) con haversine, que contra el elipsoide WGS84 se desvía hasta 0,56 %; dónde, lo
// dice docs/geometry.md. `sphere(radius)` existe para reproducir las cifras de un sistema que mide con
// otro radio, y `ellipsoid` (ellipsoid.js) da la geodésica del elipsoide, a precisión geodésica.
// Cada modelo trae también el área de un anillo, que usan las medidas de zona (measure.js).
// Módulo puro: sin Leaflet, sin DOM, sin el elipsoide.
import { coordOf } from '../data/path.js'
import { foldArgs } from './polyline.js'

const D = Math.PI / 180

// El radio de la esfera por defecto, en metros. Quien coloca puntos a una distancia dada y después los
// mide con `arcMeters` tiene que usar este mismo radio, o el punto cae a otra distancia de la que se pidió.
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
// `RELIEF` marca un terreno: lo que mide en horizontal lo rechaza como modelo.
export const MODEL   = Symbol.for('cristae.geometry.model')
export const AREA    = Symbol.for('cristae.geometry.area')
export const RELIEF  = Symbol.for('cristae.geometry.relief')
export const isModel = value => typeof value?.[MODEL] === 'function'

// Un modelo es inmutable y se valida al construirlo, no en medio de un track: un radio o un semieje
// es un número finito mayor que 0.
export const makeModel   = (distanceCore, areaCore) =>
  Object.freeze({ [MODEL]: distanceCore, [AREA]: areaCore })
export const checkLength = (length, name) => {
  if (!(Number.isFinite(length) && length > 0))
    throw new RangeError(`${name} tiene que ser un número finito mayor que 0: ${length}`)
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
  })
}

export const byDefault = sphere()

// El núcleo de la esfera por defecto, para quien mide sin modelo: el picking de círculos.
export const arcMeters = byDefault[MODEL]

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
