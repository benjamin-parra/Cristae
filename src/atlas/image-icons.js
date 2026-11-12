import { IconSet, REBAKE, RECONFIGURE } from './IconSet.js'
import { fetchBytes } from '../data/remote-fetch.js'

// Sets de íconos por imagen: `icons` mapea el nombre de una variante a un `src`, y el set rasteriza la imagen
// decodificada sobre el tile. Es un IconSet normal (describe + renderers + prerender): lo único propio es
// que las imágenes llegan DESPUÉS de nacer el set, así que cada decodificación pide un re-rasterizado
// interno (REBAKE) y lo que se resolvió antes de tiempo queda transparente hasta entonces, nunca con error.
//
// Carga: una vez por `src` —fetchBytes (error clasificado) → Blob → objectURL → Image.decode()—. Los errores
// no lanzan: se publican por `onError`. `set` va en null en el detalle: lo completa quien registra el set
// con un nombre (el elemento `<cristae-icon-set>`), que es quien lo conoce.

// Señal interna (no se reexporta en `src/index.js`): `set[SET_ICONS](icons, { rotates, size })` cambia el
// catálogo de un set vivo —lo usa `<cristae-icon>` al agregarse o quitarse— sin cambiar su identidad.
export const SET_ICONS = Symbol('IconSet.setIcons')

// Señal interna: `set[DROP_ICONS]()` cancela las descargas en vuelo del set. Lo llama `<cristae-icon-set>` al
// desconectarse, para no dejar pedidos colgados tras desmontar.
export const DROP_ICONS = Symbol('IconSet.dropIcons')

const IMAGE_SHAPE = 'image'
const SVG_EXT = /\.svg(?:[?#]|$)/i
const SVG_TYPE = 'image/svg+xml'   // sin él un SVG servido como octet-stream no decodifica en <img>

const srcOf = v => (typeof v === 'string' ? v : v && typeof v === 'object' && typeof v.src === 'string' ? v.src : '')

// Record nombre → string | { src } a Map nombre → src. Entradas sin src válido se ignoran.
const normalize = icons => {
  if (!icons || typeof icons !== 'object') throw new TypeError('[imageIconSet] `icons` debe ser un objeto nombre → src')
  const map = new Map()
  for (const name of Object.keys(icons)) {
    const src = srcOf(icons[name])
    src && map.set(name, src)
  }
  if (!map.size) throw new TypeError('[imageIconSet] `icons` no puede quedar vacío')
  return map
}

const mimeOf = (src, headers) => {
  const declared = headers?.get?.('content-type')
  return declared ? declared.split(';')[0].trim() : SVG_EXT.test(src) ? SVG_TYPE : ''
}

// Descarga y decodifica UNA imagen. Resuelve a la imagen, a un `{ error }` o a `{ aborted }` si se canceló: nunca
// rechaza, y una cancelación no es un error que publicar.
const loadImage = async (src, signal) => {
  let url
  try {
    const { bytes, headers } = await fetchBytes(src, { signal })
    const type = mimeOf(src, headers)
    url = URL.createObjectURL(new Blob([bytes], type ? { type } : undefined))
  } catch (e) {
    if (signal.aborted || e?.name === 'AbortError') return { aborted: true }
    return { error: { code: e?.code ?? 'network', message: e?.message ?? String(e) } }
  }
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    return { img }
  } catch (e) {
    return { error: { code: 'format', message: `${src}: no se pudo decodificar (${e?.message ?? 'formato no soportado'})` } }
  } finally {
    URL.revokeObjectURL?.(url)
  }
}

export const imageIconSet = ({ icons, rotates = false, sizes, onLoad, onError } = {}) => {
  let map = normalize(icons)                 // nombre → src
  const loaded = new Map()                   // src → imagen decodificada
  const flight = new Map()                   // src → promesa de la carga en curso o terminada
  const ctrls  = new Map()                   // src → AbortController de la carga en curso
  const failed = new Set()                   // src cuya carga falló: un cambio de catálogo los reintenta
  const warned = new Set()
  let set
  let notified = false                       // onLoad ya avisó para el catálogo actual

  const checkDone = () => {
    if (notified) return
    for (const src of map.values()) if (!loaded.has(src)) return
    notified = true
    onLoad?.({ set: null, count: map.size })
  }

  // Un decode nuevo vuelve a rasterizar lo ya resuelto; sin nada resuelto no hay tile que rehacer.
  const refresh = () => { set && set.atlas.count && set[REBAKE]() }

  const load = src => {
    let p = flight.get(src)
    if (p) return p
    const ctrl = new AbortController()
    ctrls.set(src, ctrl)
    p = loadImage(src, ctrl.signal).then(r => {
      if (flight.get(src) !== p) return      // el catálogo ya no lo usa
      ctrls.delete(src)
      if (r.aborted) return void flight.delete(src)
      if (r.img) {
        loaded.set(src, r.img)
        refresh()
        checkDone()
      } else {
        failed.add(src)
        if (onError) for (const [icon, s] of map) s === src && onError({ set: null, icon, url: src, code: r.error.code, message: r.error.message })
      }
    })
    flight.set(src, p)
    return p
  }

  const loadAll = () => Promise.allSettled([...new Set(map.values())].map(load))

  const describe = variant => {
    const known = map.has(variant)
    if (!known && variant != null && variant !== '' && variant !== 'default' && !warned.has(variant)) {
      warned.add(variant)
      console.warn(`[imageIconSet] variante desconocida '${variant}': se usa la primera (${map.keys().next().value})`)
    }
    return { shape: IMAGE_SHAPE, name: known ? variant : map.keys().next().value }
  }

  // Modo contain: la imagen entera dentro del tile, sin deformar. Sin imagen decodificada no dibuja.
  const renderer = (ctx, size, d) => {
    const img = loaded.get(map.get(d.name))
    if (!img) return
    const w = img.naturalWidth || img.width
    const h = img.naturalHeight || img.height
    if (!w || !h) return
    const k = Math.min(size / w, size / h)
    ctx.drawImage(img, (size - w * k) / 2, (size - h * k) / 2, w * k, h * k)
  }

  set = new IconSet({
    rotates,
    sizes,
    variants: [...map.keys()],
    describe,
    renderers: { [IMAGE_SHAPE]: renderer },
    prerender: async () => {
      await loadAll()
      refresh()
    },
  })

  set[SET_ICONS] = (next, { rotates: r, size } = {}) => {
    map = normalize(next)
    const used = new Set(map.values())
    for (const src of [...flight.keys()]) {
      if (used.has(src)) continue
      ctrls.get(src)?.abort()
      ctrls.delete(src)
      flight.delete(src)
      loaded.delete(src)
      failed.delete(src)
    }
    for (const src of failed) flight.delete(src)   // un catálogo nuevo reintenta lo que falló
    failed.clear()
    notified = false
    warned.clear()
    loadAll()
    set[RECONFIGURE]({
      variants: [...map.keys()],
      ...(r !== undefined && { rotates: r }),
      ...(size !== undefined && { defaultSize: size }),
    })
    checkDone()
  }

  set[DROP_ICONS] = () => {
    for (const [src, ctrl] of ctrls) { ctrl.abort(); flight.delete(src) }
    ctrls.clear()
  }

  return set
}
