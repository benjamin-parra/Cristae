// Refresco de una capa por `url`: aplica la DIFERENCIA por id entre lo que ya está y lo que llegó, y en
// los puntos interpola la posición entre las dos lecturas. Interno del motor: no se reexporta.
//
// Un ítem que persiste y no cambió entra con su objeto previo: conserva su revisión (`REVISION`, el hash
// de los accessors de `url`) y el Store no lo marca sucio, así la capa no lo re-encoda. Sólo lo cambiado y
// las altas se reescriben; una baja o un alta cambia los miembros y la capa reconstruye, como antes.

import { POSITION, PATH, RINGS } from './features.js'

// Piso del período de `refresh` (ms). Una capa por `url` que se relee más de una vez por segundo ya no
// sigue un archivo que cambia: es un bucle de descarga. Razonado: un servidor de archivos estáticos no
// espera más de un pedido por segundo de un mismo cliente.
export const MIN_REFRESH_MS = 1000
// Techo del período de `refresh` (ms): el mayor retardo que acepta `setTimeout` (un entero de 32 bits con signo).
// Un valor mayor se trata como 1 ms y volvería la capa un bucle de descarga, justo lo que el piso evita.
export const MAX_REFRESH_MS = 2 ** 31 - 1

// Duración de la interpolación de la posición entre dos lecturas (ms). Razonado: el siguiente `set` de un
// refresh llega al menos MIN_REFRESH_MS más la descarga después del anterior, porque el timer se arma al
// aplicar; así la interpolación termina antes de la lectura siguiente y nunca hay dos encimadas. Queda a
// confirmar con una prueba de uso con un refresh real en navegador, que no corre en Node.
export const REFRESH_TWEEN_MS = MIN_REFRESH_MS

const FULL_TURN = 360
const HALF_TURN = 180

// Una forma por valor: anillos o partes, anidados a la profundidad que traiga (`[lat, lng]` es la hoja).
const sameShapes = (a, b) => {
  if (a === b) return true
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (!sameShapes(a[i], b[i])) return false
  return true
}

const SAME_GEOMETRY = {
  point  : (a, b) => a[POSITION].lat === b[POSITION].lat && a[POSITION].lng === b[POSITION].lng,
  line   : (a, b) => sameShapes(a[PATH], b[PATH]),
  polygon: (a, b) => sameShapes(a[RINGS], b[RINGS]),
}

// Igualdad de dos lecturas del mismo ítem: las claves propias enumerables con === (una propiedad anidada
// que se relee es objeto nuevo y cuenta como cambio: es lo conservador) y la geometría por valor.
const same = (prev, next, kind) => {
  const keys = Object.keys(next)
  if (keys.length !== Object.keys(prev).length) return false
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]
    if (!(k in prev) || prev[k] !== next[k]) return false
  }
  return SAME_GEOMETRY[kind](prev, next)
}

// Lleva a `[-180, 180)`. La entrada viene de una salida y un arco cortos, así que a lo sumo se pasa una
// vuelta: con ramas y sin `%`, que en doubles es una llamada a C.
const wrapLng = lng => (lng >= HALF_TURN ? lng - FULL_TURN : lng < -HALF_TURN ? lng + FULL_TURN : lng)

export const createRefresher = ({
  source, kind,
  frame = cb => globalThis.requestAnimationFrame(cb),
  cancelFrame = h => globalThis.cancelAnimationFrame(h),
  now = () => globalThis.performance.now(),
}) => {
  const animate = kind === 'point'
  let last   = new Map()           // id → ítem de la aplicación anterior
  let spare  = new Map()           // el de la anterior a ésa: se reusa y se vacía
  let ids    = []                  // ids de los puntos en movimiento, sólo crece en apply
  let from   = new Float64Array(0) // lat, lng de salida por punto
  let to     = new Float64Array(0) // lat, lng de llegada por punto
  let moving = 0
  let start  = 0
  let handle = 0

  // El callback es estable: se crea una vez. Velocidad constante entre muestras (interpolación lineal).
  // La longitud va por el arco corto. [0-alloc]
  const tick = () => {
    handle = 0
    const t = Math.min(1, (now() - start) / REFRESH_TWEEN_MS)
    for (let i = 0; i < moving; i++) {
      const j = i * 2
      if (t >= 1) { source.move(ids[i], to[j], to[j + 1]); continue }
      let dLng = to[j + 1] - from[j + 1]
      if (dLng > HALF_TURN) dLng -= FULL_TURN
      else if (dLng < -HALF_TURN) dLng += FULL_TURN
      source.move(ids[i], from[j] + (to[j] - from[j]) * t, wrapLng(from[j + 1] + dLng * t))
    }
    if (t < 1) handle = frame(tick)
    else moving = 0
  }

  const apply = items => {
    const { idOf, positionOf } = source.accessors
    const next = new Array(items.length)
    let persistent = 0

    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      const id = idOf(item)
      const prev = last.get(id)
      let kept = item
      if (prev !== undefined) {
        if (same(prev, item, kind)) kept = prev
        if (animate) {
          // La posición efectiva (con override) se lee con el set aún por hacer: el set limpia los
          // overrides, y una interpolación en curso debe seguir desde donde va.
          const at = positionOf(prev)
          if (at) {
            if (from.length < (persistent + 1) * 2) {
              const cap = Math.max(items.length, persistent + 1) * 2
              const grow = old => { const a = new Float64Array(cap); a.set(old); return a }
              from = grow(from); to = grow(to)
            }
            ids[persistent] = id
            from[persistent * 2]     = at.lat
            from[persistent * 2 + 1] = at.lng
            persistent++
          }
        }
      }
      next[i] = kept
      spare.set(id, kept)
    }

    source.set(next)

    // Tras el set los overrides se limpiaron: la posición de cada ítem es ya la de llegada. Se compacta
    // lo que de verdad se mueve y se vuelve a su salida en el mismo tick (coalesce con el set).
    let n = 0
    for (let k = 0; k < persistent; k++) {
      const id = ids[k]
      const item = spare.get(id)
      const at = positionOf(item)
      const fLat = from[k * 2], fLng = from[k * 2 + 1]
      if (!at || (at.lat === fLat && at.lng === fLng)) continue
      ids[n] = id
      from[n * 2] = fLat; from[n * 2 + 1] = fLng
      to[n * 2] = at.lat; to[n * 2 + 1] = at.lng
      n++
    }
    for (let k = 0; k < n; k++) source.move(ids[k], from[k * 2], from[k * 2 + 1])
    moving = n
    if (n > 0) {
      start = now()
      if (!handle) handle = frame(tick)
    } else if (handle) {
      cancelFrame(handle)
      handle = 0
    }

    last.clear()
    const old = last
    last = spare
    spare = old
  }

  const stop = () => {
    if (handle) cancelFrame(handle)
    handle = 0
    moving = 0
    ids.length = 0
    from = new Float64Array(0)
    to = new Float64Array(0)
    last.clear()
    spare.clear()
  }

  return { apply, stop }
}
