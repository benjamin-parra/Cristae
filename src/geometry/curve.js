// La geodésica de un tramo recto, partida en los puntos que la dibujan. `count` dice en cuántos tramos
// hay que partir uno para que su polilínea recta en Mercator no se aparte de la geodésica más que
// `GROUND`, y `at` escribe uno de los puntos intermedios; las capas de líneas y de polígonos y los
// editores los llaman por tramo y escriben donde necesitan —el escalar interpolado, el índice de la
// entrada—, y `geodesic` los junta en el path que expone. Módulo puro: sin Leaflet, sin DOM, sin el
// elipsoide.
import { HEADING, DESTINATION, MEAN_RADIUS, MODEL, byDefault, checkPlacer } from './geodesic.js'
import { GROUND, stepsFor } from './density.js'
import { measureArgs } from './measure.js'
import { toParts } from './polyline.js'
import { MAXLAT } from '../render/project.js'

const D    = Math.PI / 180
const SPAN = MEAN_RADIUS * D * Math.sqrt(1.005)   // los metros por grado del prefiltro

// En cuántos tramos se parte el segmento entre dos puntos válidos, en grados. Un segmento de más de media
// vuelta de longitud no se toca, porque el consumidor eligió el lado largo, ni uno entre antípodas, que
// no tiene una geodésica, ni un meridiano, que ya es recto en Mercator.
//
// La cota de `stepsFor` va con la latitud más alta de la geodésica, que pasa la de los extremos cuando el
// vértice del círculo máximo cae entre ellos (cos φ = cos φ₁·|sin α₁|), y se corta en la de la proyección:
// más allá se dibuja aplastado, y un vértice en un polo no infla el path. La separación escala con el
// radio del modelo, L·θ y no L²/R, así que el largo que recibe es el de la esfera media con esa
// separación. Un track de puntos cercanos pasa por el prefiltro, que no le pide la distancia al modelo,
// en el elipsoide una solución de la geographiclib: la cota con un largo y una latitud que no bajan de los
// verdaderos, el camino por meridiano y paralelo y los extremos más medio camino. Su margen cubre un radio
// de hasta 1,005 R, el mayor de curvatura del elipsoide.
export const count = (model, lat1, lng1, lat2, lng2) => {
  const dLng = Math.abs(lng2 - lng1)
  if (dLng > 180 || !dLng || lat1 === -lat2 && (dLng === 180 || Math.abs(lat1) === 90)) return 1
  const top  = Math.max(Math.abs(lat1), Math.abs(lat2))
  const span = Math.abs(lat2 - lat1) + dLng
  if (stepsFor(SPAN * span, Math.min(MAXLAT, top + span / 2), GROUND) === 1) return 1
  const s1    = Math.sin(lat1 * D), c1 = Math.cos(lat1 * D)
  const s2    = Math.sin(lat2 * D), c2 = Math.cos(lat2 * D)
  const sinL  = Math.sin(dLng * D), cosL = Math.cos(dLng * D)
  const east  = c2 * sinL
  const north = c1 * s2 - s1 * c2 * cosL
  const sin   = Math.sqrt(east * east + north * north)
  const apex  = north * (c1 * s2 * cosL - s1 * c2) < 0 ? Math.acos(c1 * east / sin) / D : top
  const angle = Math.atan2(sin, s1 * s2 + c1 * c2 * cosL)
  return stepsFor(Math.sqrt(model[MODEL](lat1, lng1, lat2, lng2) * angle * MEAN_RADIUS), Math.min(MAXLAT, apex), GROUND)
}

// El tramo que `at` partió último con un modelo que no es la esfera por defecto: su largo y su rumbo no
// cambian entre los puntos, y en el elipsoide cada uno es una solución de la geographiclib.
const last = { model: null, lat1: 0, lng1: 0, lat2: 0, lng2: 0, meters: 0, heading: 0 }

// Escribe en `out[0..1]` el `[lat, lng]` del punto a la fracción `t` de la geodésica, medida en largo, y
// devuelve `out`. La lng sigue a `lng1` sin envolverse. En la esfera por defecto es la interpolación
// esférica de los dos vectores, que se arma con la lng relativa a `lng1`, donde el primero queda en el
// plano xz y la lng del resultado sale ya continua; los demás modelos componen sus marcas: el destino
// desde el primer punto al rumbo inicial, a `t` por la distancia. Los puntos no son coincidentes ni
// antípodas, que `count` deja en 1 tramo.
export const at = (model, lat1, lng1, lat2, lng2, t, out) => {
  if (model !== byDefault) {
    if (model !== last.model || lat1 !== last.lat1 || lng1 !== last.lng1 || lat2 !== last.lat2 || lng2 !== last.lng2)
      Object.assign(last, {
        model, lat1, lng1, lat2, lng2,
        meters  : model[MODEL](lat1, lng1, lat2, lng2),
        heading : model[HEADING](lat1, lng1, lat2, lng2),
      })
    return model[DESTINATION](lat1, lng1, last.heading, t * last.meters, out)
  }
  const dLng  = (lng2 - lng1) * D
  const x1    = Math.cos(lat1 * D), z1 = Math.sin(lat1 * D)
  const c2    = Math.cos(lat2 * D)
  const x2    = c2 * Math.cos(dLng), y2 = c2 * Math.sin(dLng), z2 = Math.sin(lat2 * D)
  const cx    = -z1 * y2, cy = z1 * x2 - x1 * z2, cz = x1 * y2
  const sin   = Math.sqrt(cx * cx + cy * cy + cz * cz)
  const angle = Math.atan2(sin, x1 * x2 + z1 * z2)
  const w1    = Math.sin((1 - t) * angle) / sin, w2 = Math.sin(t * angle) / sin
  const px    = w1 * x1 + w2 * x2, py = w2 * y2, pz = w1 * z1 + w2 * z2
  out[0] = Math.atan2(pz, Math.sqrt(px * px + py * py)) / D
  out[1] = lng1 + Math.atan2(py, px) / D
  return out
}

// El path con cada tramo curvado sobre la geodésica del modelo, partido como `toParts`: un par `[lat, lng]`
// por punto, y los de entrada se conservan. Una parte de menos de dos vértices no sale.
export const geodesic = (...args) => {
  const { model, polygon } = measureArgs('geodesic', args, 'path')
  checkPlacer(model, 'geodesic', 'la curva')
  if (typeof model[HEADING] !== 'function') throw new TypeError('[geodesic] este modelo no ubica rumbos')
  return toParts(polygon).map(({ path }) => {
    const curved = [path[0]]
    for (let i = 1; i < path.length; i++) {
      const [lat1, lng1] = path[i - 1], [lat2, lng2] = path[i]
      const steps = count(model, lat1, lng1, lat2, lng2)
      for (let k = 1; k < steps; k++) curved.push(at(model, lat1, lng1, lat2, lng2, k / steps, [0, 0]))
      curved.push(path[i])
    }
    return curved
  })
}
