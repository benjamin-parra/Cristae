// `fields`: el gemelo serializable de `accessors`. Cada clave es un accessor sin el `Of` y cada valor un
// nombre de campo (con `.` para anidar), así que viaja por un atributo HTML o por JSON. Es interno: no
// se reexporta en `cristae/core`; lo usan `createSource`, el motor y los elementos.
//
// Todo lector es total: un ítem nulo o un campo ausente dan el neutro de su canal, nunca una excepción. `heading`
// acepta también una cadena numérica ("90"); `text` de un objeto da '' y no '[object Object]'. Un `id` ausente
// da '' para todos los ítems sin campo, así que esos ítems comparten identidad: el dato debe traer el id.
// El camino caliente no asigna: el arreglo de claves se calcula al compilar el lector, no al leer.

// Neutro por canal. Un canal sin entrada devuelve el valor crudo (altura, radio, color, geometría).
const COERCE = {
  id:      v => v ?? '',
  variant: v => (v == null ? '' : String(v)),
  heading: v => { const n = typeof v === 'string' ? +v : v; return Number.isFinite(n) ? n : 0 },
  text:    v => (v == null || typeof v === 'object' ? '' : String(v)),
}

const rawReader = path => {
  if (!path.includes('.')) return item => item?.[path]
  const keys = path.split('.')
  const last = keys.length - 1
  return item => {
    let v = item
    for (let i = 0; i < last && v != null; i++) v = v[keys[i]]
    return v?.[keys[last]]
  }
}

export const fieldReader = (path, channel) => {
  const read = rawReader(path)
  const coerce = COERCE[channel]
  return coerce ? item => coerce(read(item)) : read
}

// Un par `[lat, lng]` leído de un ítem se arma una vez por ítem. El WeakMap guarda el último `{lat, lng}`
// y se reutiliza mientras los dos valores crudos no cambien: estado estable sin asignar. Un `set` con
// objetos nuevos no tiene entrada y recalcula; un ítem mutado en sitio cambia sus valores y recalcula.
const cachedPoint = (cache, host, lat, lng) => {
  const hit = cache.get(host)
  if (hit && hit.lat === lat && hit.lng === lng) return hit
  const point = { lat, lng }
  cache.set(host, point)
  return point
}

const isObject = v => typeof v === 'object' && v !== null

export const positionReader = spec => {
  const cache = new WeakMap()
  if (Array.isArray(spec)) {
    const readLat = rawReader(spec[0])
    const readLng = rawReader(spec[1])
    return item => {
      if (!isObject(item)) return undefined
      return cachedPoint(cache, item, readLat(item), readLng(item))
    }
  }
  const read = rawReader(spec)
  return item => {
    const v = read(item)
    if (!isObject(v)) return undefined
    if (Array.isArray(v)) return cachedPoint(cache, v, v[0], v[1])
    return typeof v.lat === 'number' ? v : undefined
  }
}

const readerFor = (key, spec) => {
  if (key === 'position') return Array.isArray(spec) || typeof spec === 'string' ? positionReader(spec) : undefined
  return typeof spec === 'string' && spec ? fieldReader(spec, key) : undefined
}

const defaultWarn = key => globalThis.console?.warn?.(`[cristae] '${key}Of' y fields.${key} a la vez: gana la función`)

// Arma los accessors de una Source a partir de `fields`. Precedencia, de menor a mayor: `fallback` (los
// de `url`), `fields`, y las funciones de `accessors`. Cuando una función choca con un campo, gana la
// función y `warn(key)` avisa una vez por clave. No muta ninguna entrada y devuelve un objeto nuevo.
export const accessorsFromFields = (fields, accessors, { warn = defaultWarn, fallback } = {}) => {
  const out = { ...fallback }
  const own = {}
  // Sólo las funciones: una clave en `undefined` o `null` (habitual al armar props) no pisa lo que dio `fields`.
  if (accessors) for (const k of Object.keys(accessors)) if (k !== 'fields' && typeof accessors[k] === 'function') own[k] = accessors[k]
  if (fields) {
    for (const key of Object.keys(fields)) {
      const reader = readerFor(key, fields[key])
      if (!reader) continue
      const name = `${key}Of`
      if (typeof own[name] === 'function') warn(key)
      else out[name] = reader
    }
  }
  return Object.assign(out, own)
}
