// Los editores de círculo, elipse y sector: por forma, cómo se lee su valor, dónde van sus manijas y qué
// cambia arrastrar cada una. Trabajan sobre el registro de `readShape`, que el editor muta en su sitio, y
// con el modelo del mapa, del que salen las manijas y el valor. La manija `i` es el vértice `i` del trazo
// de manijas; la 0 es el centro, que traslada la figura. En una figura entera redonda el anillo no lee
// `heading`, que guarda el rumbo de la manija de radio: en el sector, el de la punta; en el círculo, uno que
// entra al este y queda donde se soltó. Las manijas se escriben como el anillo, `[lng, lat, …]`. Módulo
// puro: sin GL ni DOM.
import { DESTINATION, HEADING, MODEL } from '../geometry/geodesic.js'
import { compass } from '../geometry/polyline.js'
import { reachesPole, readDrawable } from '../geometry/shape.js'

const D   = Math.PI / 180
const out = [0, 0]   // el destino que escribe el modelo y se copia enseguida

// La manija `i` a `heading` y `meters` del centro.
const at = (model, s, xy, i, heading, meters) => {
  model[DESTINATION](s.lat, s.lng, heading, meters, out)
  xy[2 * i]     = out[1]
  xy[2 * i + 1] = out[0]
}

// La punta del sector y la manija del círculo: el radio y su rumbo.
const tip = (s, heading, r) => {
  if (reachesPole({ lat: s.lat, a: r, b: r })) return false
  s.a = s.b = r
  s.heading = heading
  return true
}

// Una forma del editor sobre la regla de `readDrawable`, con el radio de su tipo; `fields` es lo que lee del
// valor. `pull` es el arrastre de una manija que no es el centro: recibe el rumbo y la distancia del centro
// al puntero, ésta ya acotada a `min` metros, y devuelve si lo aceptó: si no, la forma queda como estaba.
const shape = ({ round, handles, clicks, fields, value, place, pull }) => ({
  round, handles, clicks, value,
  read: v => {
    const f = fields(v)
    const s = readDrawable(f)
    if (!s || s.round !== round) return null
    s.heading = compass((Number.isFinite(f.heading) ? f.heading : s.heading) % 360)
    return s
  },
  place: (model, s, xy) => {
    xy[0] = s.lng
    xy[1] = s.lat
    place(model, s, xy)
  },
  // Arrastrar la manija `i` al punto (lat, lng) muta la forma y dice si la regla lo aceptó: un centro o un
  // radio que alcanzaría un polo y un punto sobre el centro se rechazan.
  drag: (model, s, i, lat, lng, min) => {
    if (!i) {
      if (reachesPole({ lat, a: s.a, b: s.b })) return false
      s.lat = lat
      s.lng = lng
      return true
    }
    const heading = model[HEADING](s.lat, s.lng, lat, lng)
    return heading >= 0 && pull(s, i, heading, Math.max(min, model[MODEL](s.lat, s.lng, lat, lng)), min)
  },
  // Tomar una manija empieza un gesto: lo que el arrastre recuerda del anterior no vale, y una figura que
  // quedó cerrada se abre por cualquier lado, como la que entra cerrada por el valor.
  grab: s => {
    s.prev = null
    s.shut = 0
  },
})

export const SHAPES = {
  circle: shape({
    round   : true,
    handles : 2,
    clicks  : 2,
    fields  : v => ({ center: v?.center, radius: v?.radius, heading: 90 }),   // la manija entra al este
    value   : s => ({ center: [s.lat, s.lng], radius: s.a }),
    place   : (model, s, xy) => at(model, s, xy, 1, s.heading, s.a),
    pull    : (s, _, heading, r) => tip(s, heading, r),
  }),
  // `a` gira la elipse y `b` sólo la ensancha.
  ellipse: shape({
    round   : false,
    handles : 3,
    clicks  : 3,
    fields  : v => ({ center: v?.center, radius: v?.radius, heading: v?.heading }),
    value   : s => ({ center: [s.lat, s.lng], radius: [s.a, s.b], heading: s.heading }),
    place   : (model, s, xy) => {
      at(model, s, xy, 1, s.heading, s.a)
      at(model, s, xy, 2, s.heading + 90, s.b)
    },
    pull    : (s, i, heading, r) => {
      const a = i === 1 ? r : s.a
      const b = i === 1 ? s.b : r
      if (reachesPole({ lat: s.lat, a, b })) return false
      s.a       = a
      s.b       = b
      s.heading = i === 1 ? heading : s.heading
      return true
    },
  }),
  // Los bordes, del izquierdo al derecho, cambian sólo la apertura, simétrica alrededor de `heading`: Δ es
  // el rumbo del puntero relativo a `heading`, envuelto a [−180, 180). La punta queda a sweep/2 de cada borde
  // y los bordes, a 360 − sweep por detrás; `gap` es el medio ángulo cuya cuerda mide `min`, así que ninguna
  // apertura deja la punta y un borde más cerca que eso. Por detrás, el borde que llega a la cuerda `min` del
  // otro, o que pasa al otro lado —Δ cambia de signo lejos de la punta, aunque el puntero salte esa ventana—,
  // cierra la figura en 360 con las dos manijas de borde en el mismo punto. Queda cerrada hasta que el puntero
  // vuelve abierto por el lado del que llegó (`shut`).
  // Un radio menor que `min` —entrado por el valor o al alejar el zoom— ya junta las manijas con el centro, y
  // bajo min/√3 ninguna apertura las separa: se acota como en el radio mínimo, y sigue al puntero. El trazado
  // termina en el primer borde.
  sector: shape({
    round   : true,
    handles : 4,
    clicks  : 3,
    fields  : v => v,
    value   : s => ({ center: [s.lat, s.lng], radius: s.a, heading: s.heading, sweep: s.sweep }),
    place   : (model, s, xy) => {
      at(model, s, xy, 1, s.heading, s.a)
      at(model, s, xy, 2, s.heading - s.sweep / 2, s.a)
      at(model, s, xy, 3, s.heading + s.sweep / 2, s.a)
    },
    pull    : (s, i, heading, r, min) => {
      if (i === 1) return tip(s, heading, r)
      const gap   = Math.asin(min / (2 * Math.max(s.a, min))) / D
      const delta = (heading - s.heading + 540) % 360 - 180
      const sweep = 2 * Math.abs(delta)
      const open  = sweep <= 360 - 2 * gap
      if (s.sweep < 360) {
        const prev   = s.prev ?? (i === 2 ? -s.sweep : s.sweep) / 2   // la primera muestra parte de la manija tomada
        const behind = Math.abs(prev) > 90 && Math.sign(delta) !== Math.sign(prev)
        if (open && !behind) s.sweep = Math.max(4 * gap, sweep)
        else {
          s.sweep = 360
          s.shut  = behind ? Math.sign(prev) : Math.sign(delta)
        }
      } else if (open && (!s.shut || Math.sign(delta) === s.shut)) {
        s.shut  = 0
        s.sweep = Math.max(4 * gap, sweep)
      }
      s.prev = delta
      return true
    },
  }),
}
