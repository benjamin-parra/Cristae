import { CristaeLayerElement } from './base.js'
import { makeAutoId } from './autoId.js'
import { bridgeLoad, dropLoad, warnOnce } from './dataAttrs.js'
import { hillshadeAttr, parseDem, parseElevationRange, parseSlopeBreaks, parseSlopeColors } from './terrainAttrs.js'
import { terrainPresets } from '../geometry/terrain-presets.js'
import { parseColor } from '../render/color.js'

// Los canales de color de rgba(): 0..1 del lector a 0..255 del texto.
const CHANNEL_MAX = 255
// Decimales del alfa en el texto: de sobra para un color de pantalla.
const ALPHA_DIGITS = 3

const rgbaText = ([r, g, b, a]) =>
  `rgba(${Math.round(r * CHANNEL_MAX)}, ${Math.round(g * CHANNEL_MAX)}, ${Math.round(b * CHANNEL_MAX)}, ${+a.toFixed(ALPHA_DIGITS)})`

// Un color CSS cualquiera → rgba(), o null si no es un color. Los hex y rgb() se leen sin DOM; un nombre
// ("tomato") o cualquier otra sintaxis se resuelve con el canvas 2D, que deja el valor anterior ante lo inválido:
// un color que da lo mismo partiendo de dos centinelas distintos es un color de verdad.
let probe
const SENTINELS = ['#000000', '#ffffff']
const cssColor = token => {
  const direct = parseColor(token)
  if (direct) return rgbaText(direct)
  const ctx = (probe ??= globalThis.document?.createElement?.('canvas')?.getContext?.('2d'))
  if (!ctx) return null
  const seen = SENTINELS.map(sentinel => {
    ctx.fillStyle = sentinel
    ctx.fillStyle = token
    return ctx.fillStyle
  })
  const rgba = seen[0] === seen[1] ? parseColor(seen[0]) : null
  return rgba ? rgbaText(rgba) : null
}

const normalizeColors = tokens => {
  if (!tokens) return null
  const out = tokens.map(cssColor)
  return out.includes(null) ? null : out
}

const absent = v => v === undefined || v === null || v === ''

// Lo que se lee por lector. Devuelven null ante lo ilegible; lo ausente no llega a ellos.
const finite = v => (Number.isFinite(v) ? v : null)
const READERS = {
  dem            : parseDem,
  slopeBreaks    : parseSlopeBreaks,
  elevationRange : parseElevationRange,
  contours       : finite,
}

// Las opciones de la config que viajan al motor, en `update` parcial.
const CONFIG = ['dem', 'hillshade', 'colorBy', 'slopeBreaks', 'slopeColors', 'elevationRange', 'contours', 'clipTo']

// <cristae-terrain-layer> — relieve del dem como capa del mapa (docs/terrain-layer.md): sombreado y color por
// altura o por pendiente, con curvas de nivel, recortado a una capa de polígonos por `clip-to`. `fetch` se lee
// al montar. Los atributos ilegibles no cambian nada y se dicen en consola.
export class CristaeTerrainLayer extends CristaeLayerElement {

  // Gramática de composición: entidad hoja que produce `terrain`, que ningún modificador consume.
  static cristaeSignature = { role: 'leaf', produces: ['terrain'] }

  static properties = {
    dem            : {},
    hillshade      : { converter: { fromAttribute: hillshadeAttr } },
    colorBy        : { attribute: 'color-by' },
    slopeBreaks    : { attribute: 'slope-breaks' },
    slopeColors    : { attribute: 'slope-colors' },
    elevationRange : { attribute: 'elevation-range' },
    contours       : { type: Number },
    clipTo         : { attribute: 'clip-to' },
    opacity        : { type: Number },
    visible        : { type: Boolean },
    fetch          : { attribute: false },
  }

  constructor() {
    super()
    this.visible = true
  }

  layerId() { return this.id || (this._auto ??= makeAutoId('terrain')) }

  // Hay dem legible: un nombre de `terrainPresets` o un objeto. Lo demás lo valida el motor al montar.
  mountReady() {
    const dem = parseDem(this.dem)
    const named = typeof dem === 'string'
    if (dem && !(named && !Object.hasOwn(terrainPresets, dem))) return true
    const shown = named ? `'${dem}' no es un preset (${Object.keys(terrainPresets).join(', ')})` : absent(this.dem) ? 'falta' : 'no se pudo leer'
    warnOnce(this, `dem:${shown}`, `dem ${shown}: la capa de terreno no monta`)
    return false
  }

  mountLayer(engine) {
    const config = {}
    for (const key of CONFIG) {
      const read = this._read(key)
      if (read.invalid) this._complain(key)
      else read.value !== undefined && (config[key] = read.value)
    }
    let handle
    try {
      handle = engine.addTerrainLayer({
        id: this.layerId(), ...this._placement, ...config, visible: this.visible, ...(this.fetch && { fetch: this.fetch }),
      })
    } catch (error) {
      if (!(error instanceof TypeError || error instanceof RangeError)) throw error
      this._fail(`mount:${error.message}`, error.message)
      return null
    }
    bridgeLoad(this, engine)
    this._applyOpacity(handle)
    this._attribute()
    return handle
  }

  cristaeUnmount() {
    dropLoad(this)
    this._demMap?.cristaeAttribution?.(this, null)
    this._demMap = null
    super.cristaeUnmount()
  }

  // Un solo `update` con lo que cambió. Ante un valor que el motor rechaza, la capa queda como estaba.
  syncLayer(changed) {
    const handle  = this._handle
    const partial = {}
    for (const key of CONFIG) {
      if (!changed.has(key)) continue
      const read = this._read(key)
      if (read.invalid) this._complain(key)
      else partial[key] = read.value
    }
    if (Object.keys(partial).length) {
      try {
        handle.update(partial)
        'dem' in partial && this._attribute()
      } catch (error) {
        if (!(error instanceof TypeError || error instanceof RangeError)) throw error
        this._fail(`update:${error.message}`, error.message)
      }
    }
    changed.has('visible') && handle.setVisible(this.visible)
    changed.has('opacity') && this._applyOpacity(handle)
  }

  // La opción `key` leída del atributo o la propiedad: { value } (undefined si falta) o { invalid }.
  _read(key) {
    const raw = this[key]
    if (absent(raw)) return { value: undefined }
    if (key === 'slopeColors') {
      if (raw !== this._colorsRaw) {
        this._colorsRaw = raw
        this._colorsOut = normalizeColors(parseSlopeColors(raw))   // una vez por cambio
      }
      return this._colorsOut ? { value: this._colorsOut } : { invalid: true }
    }
    const value = READERS[key] ? READERS[key](raw) : raw
    return value === null ? { invalid: true } : { value }
  }

  _applyOpacity(handle) {
    const alpha = this.opacity
    if (absent(alpha)) return
    if (Number.isFinite(alpha) && alpha >= 0 && alpha <= 1) handle.setOpacity(alpha)
    else this._fail('opacity', `opacity tiene que estar en [0, 1]: ${alpha}`)
  }

  // La atribución del dem como texto al mapa que contiene la capa; la de un preset sale de `terrainPresets`.
  _attribute() {
    const dem  = parseDem(this.dem)
    const text = typeof dem === 'string'
      ? terrainPresets[dem]?.attribution
      : dem?.attribution
    const map = this._demMap ?? this.closest?.('cristae-map')
    this._demMap = map ?? null
    map?.cristaeAttribution?.(this, typeof text === 'string' && text ? text : null)
  }

  _complain(key) { this._fail(`attr:${key}`, `${key} no se pudo leer: se conserva el valor vigente`) }

  _fail(key, message) {
    const seen = this._failed ??= new Set()
    if (seen.has(key)) return
    seen.add(key)
    globalThis.console?.error?.(`[cristae] <cristae-terrain-layer> ${message}`)
  }
}
