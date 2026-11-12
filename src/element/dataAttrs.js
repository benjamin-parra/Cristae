import { fieldReader } from '../data/fields.js'

// Datos sin script en las capas declarativas: `url`, `fields`, los atributos `-of`, `refresh` y
// `click-action`, con sus señales de carga. Lo comparten las capas de puntos, polígonos, líneas y texto.
// Es interno: no se reexporta en `cristae`.

// Lo que cada capa de datos declara por atributo. `fields` llega como JSON (Lit lo parsea); asignado como
// propiedad es un objeto. `fetch` es sólo propiedad: una función no viaja por atributo.
export const FIELD_PROPERTIES = {
  fields : { type: Object },
  idOf   : { attribute: 'id-of' },
}

export const DATA_PROPERTIES = {
  url         : {},
  format      : {},
  refresh     : { type: Number },
  fetch       : { attribute: false },
  clickAction : { attribute: 'click-action' },
  ...FIELD_PROPERTIES,
}

// Los canales visuales de un punto que se nombran por atributo.
export const POINT_OF = {
  variantOf : { attribute: 'variant-of' },
  headingOf : { attribute: 'heading-of' },
}

// Las claves de `fields` que cada canal -of reemplaza, y su nombre de accessor.
const OF_PROP = { id: 'idOf', variant: 'variantOf', heading: 'headingOf', text: 'textOf' }

// Los canales que se leen al llamarse, con un cierre estable por elemento: cambiar el atributo recompila el
// lector, no el cierre, y `refresh()` repinta. `id` y `click-action` se leen al montar.
const REACTIVE = ['variant', 'heading']

// Lo que se lee al montar: cambiarlo en vivo no tiene efecto, así que se avisa.
const AT_MOUNT = ['idOf', 'fields', 'clickAction']

// Igual a DEFAULT_VARIANT de render/PointLayer.js (la prueba fija la igualdad): la variante de un ítem
// sin campo de variante, que el atlas siempre resuelve.
const DEFAULT_VARIANT = 'default'
const NEUTRAL = { variant: () => DEFAULT_VARIANT, heading: () => 0 }

const FIELD_TEXT = new WeakSet()

// ¿Este `textOf` salió de un nombre de campo? Lo usan los decoradores para no aplicarlo a las burbujas.
export const isFieldText = fn => FIELD_TEXT.has(fn)

// Un `textOf` declarado: una función pasa tal cual y un nombre de campo se vuelve un lector total
// (null o campo ausente dan ''). Vacío o ausente es undefined.
export const textOfValue = spec => {
  if (typeof spec === 'function') return spec
  if (typeof spec !== 'string' || !spec) return undefined
  const read = fieldReader(spec, 'text')
  FIELD_TEXT.add(read)
  return read
}

const stateOf = el => el._of ??= { warned: new Set(), read: {}, closures: {}, seen: {} }

export const warnOnce = (el, key, message) => {
  const { warned } = stateOf(el)
  if (warned.has(key)) return
  warned.add(key)
  globalThis.console?.warn?.(`[cristae] ${message}`)
}

const named = spec => typeof spec === 'function' || (typeof spec === 'string' && spec !== '')

// Lector de un canal visual: sin nombre, el neutro; una variante vacía vale la de por defecto.
const compile = (channel, spec) => {
  if (typeof spec === 'function') return spec
  if (!named(spec)) return NEUTRAL[channel]
  const read = fieldReader(spec, channel)
  return channel === 'variant' ? item => read(item) || DEFAULT_VARIANT : read
}

// Con `source` los accessors y los `fields` viajan con la Source del consumidor: lo declarado por atributo no
// se aplica, y se dice una vez en lugar de quedar mudo.
const warnIgnored = el => {
  const names = [...Object.keys(OF_PROP).map(key => OF_PROP[key]).filter(name => named(el[name])), ...(el.fields ? ['fields'] : [])]
  names.length && el._consumerSource &&
    warnOnce(el, 'source-of', `${names.join(', ')} se ignora${names.length > 1 ? 'n' : ''} con 'source': los accessors viajan con la Source`)
}

// Los accessors y los `fields` que el elemento pasa al motor. Precedencia: función en `accessors` > atributo
// `-of` > `fields`, con un aviso (una vez) cuando chocan. Devuelve los propios sin copiar cuando no hay nada
// que instalar. `keys` son los canales -of que la capa admite. Toma la foto de lo declarado al montar, contra
// la que `syncData` distingue un cambio real del estado inicial que Lit entrega tras un montaje diferido.
export const resolveOf = (el, keys) => {
  const st = stateOf(el)
  keys.length || warnIgnored(el)
  st.seen = { url: el.url, format: el.format, refresh: el.refresh, fields: el.fields, idOf: el.idOf,
              variantOf: el.variantOf, headingOf: el.headingOf, clickAction: el.clickAction }
  let accessors = el.accessors
  let fields    = el.fields
  const install = (name, fn) => { accessors === el.accessors && (accessors = { ...el.accessors }); accessors[name] = fn }
  const drop    = key => { fields === el.fields && (fields = { ...el.fields }); delete fields[key] }

  for (const key of keys) {
    const name   = OF_PROP[key]
    const spec   = el[name]
    const byAttr = named(spec) && (key !== 'text' || typeof spec === 'string')
    const byFn   = typeof el.accessors?.[name] === 'function' || (key === 'text' && typeof spec === 'function')
    const inFlds = !!fields && key in fields

    if (byFn) {
      byAttr && warnOnce(el, name, `'${name}' y accessors.${name} a la vez: gana la función`)
      key === 'text' && inFlds && (warnOnce(el, `fields.${key}`, `'${name}' y fields.${key} a la vez: gana '${name}'`), drop(key))
      continue
    }
    if (byAttr && inFlds) {
      warnOnce(el, `fields.${key}`, `'${name}' y fields.${key} a la vez: gana '${name}'`)
      drop(key)
    }
    if (key === 'text') continue
    if (key === 'id') { byAttr && install(name, typeof spec === 'function' ? spec : fieldReader(spec, 'id')); continue }

    if (!byAttr && inFlds) continue                  // lo lee `fields`, sin cierre
    // Sin atributo ni cierre previo no hay nada que leer: el accessor ausente es el neutro del PointLayer, y el
    // 2D de hoy no gana una llamada por ítem.
    if (!byAttr && !st.closures[key]) continue
    st.read[key] = compile(key, byAttr ? spec : undefined)
    install(name, st.closures[key] ??= item => st.read[key](item))
  }
  return { accessors, fields }
}

// El subconjunto del alta que viaja al motor. Sin valor, la clave no existe: el alta queda igual a la de hoy.
export const remoteConfig = el => {
  const cfg = {}
  for (const key of ['url', 'format', 'refresh', 'fetch', 'clickAction']) el[key] !== undefined && (cfg[key] = el[key])
  return cfg
}

// Cambios en caliente. `url`, `format` y `refresh` recargan; un canal visual recompila su lector y repinta;
// lo que se lee al montar avisa una vez. Sólo cuenta lo que difiere de lo montado.
export const syncData = (el, changed) => {
  const st = stateOf(el)
  const seen = st.seen
  const handle = el._handle
  if (!handle) return

  const moved = key => changed.has(key) && el[key] !== seen[key] && (seen[key] = el[key], true)

  const reload = ['url', 'format', 'refresh'].map(moved).includes(true)
  reload && handle.reload({ url: el.url, format: el.format, refresh: el.refresh })

  let dirty = false
  for (const key of REACTIVE) {
    const name = OF_PROP[key]
    if (!moved(name)) continue
    if (st.closures[key]) { st.read[key] = compile(key, el[name]); dirty = true }
    else if (named(el[name]) && !el._consumerSource && typeof el.accessors?.[name] !== 'function' && !(el.fields && key in el.fields))
      warnOnce(el, `mount:${name}`, `'${name}' no estaba declarado al montar la capa: el cambio no se aplica en vivo`)
  }
  dirty && handle.refresh()

  for (const name of AT_MOUNT) {
    changed.has(name) && el[name] !== seen[name] &&
      warnOnce(el, `mount:${name}`, `'${name}' se lee al montar la capa: el cambio no se aplica en vivo`)
  }
}

// Reenvía `dataload` y `dataerror` del motor, filtrados por la capa, como `cristae:load` y `cristae:error`
// del elemento. La baja va en `dropLoad`, que cada capa llama al desmontar. El puente cuenta como oyente de
// `dataerror` y silencia el volcado del motor, así que el elemento lo hace por él: `cristae:error` es
// cancelable, y si nadie llama `preventDefault` el fallo va a `console.error`, una vez por capa. En HTML sin
// script, donde nadie escucha, un fallo de carga no queda mudo.
export const bridgeLoad = (el, engine) => {
  dropLoad(el)
  const id   = el.layerId()
  let logged = false
  const send = type => detail => {
    if (detail?.layerId !== id) return
    const ok = el.dispatchEvent(new CustomEvent(`cristae:${type}`, { detail, bubbles: true, composed: true, cancelable: type === 'error' }))
    if (type !== 'error' || !ok || logged) return
    logged = true
    globalThis.console?.error?.(`[cristae] la capa '${id}' no cargó ${detail.url}: ${detail.message}`)
  }
  const offs = [engine.on?.('dataload', send('load')), engine.on?.('dataerror', send('error'))]
  el._offLoad = () => offs.forEach(off => off?.())
}

export const dropLoad = el => {
  el._offLoad?.()
  el._offLoad = null
}
