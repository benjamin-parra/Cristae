// La configuración de una capa de terreno: valida, normaliza y completa lo que escribió quien la crea, y
// calcula qué cambió entre dos configuraciones para que la capa recargue sólo lo necesario. Funciones puras,
// sin DOM ni GL. Los tipos de error son los de `terrain()`: TypeError para un valor que no es de la forma
// pedida y RangeError para un tope.

import { terrainPresets } from '../geometry/terrain-presets.js'
import { parseColor } from '../render/color.js'
import { MAX_SLOPE_BREAKS } from '../render/terrain-shaders.js'

// Los extremos de la rampa de pendiente por defecto: el verde y el rojo de la rampa RdYlGn de ColorBrewer
// (Brewer, 2002), de lo llano a lo escarpado.
export const DEFAULT_SLOPE_LOW  = '#1a9850'
export const DEFAULT_SLOPE_HIGH = '#d73027'

// El tope de zoom de una fuente que no declara `maxZoom`, el mismo que acepta `terrain()` (24).
const MAX_ZOOM_LIMIT = 24

const COLOR_BY = ['none', 'elevation', 'slope']

// Lo que el autor escribió y se resuelve por defecto, por configuración: así `update` puede volver a
// resolverlo cuando cambia aquello de lo que depende (el sombreado con `colorBy`, los colores con los cortes).
const DECLARED = new WeakMap()

const fail = (Err, msg) => { throw new Err(`[terrain-layer] ${msg}`) }

const isInteger = (v, min, max) => Number.isInteger(v) && v >= min && v <= max

// El dem: un nombre propio de los presets o una fuente completa. Devuelve la fuente resuelta y congelada.
const readSource = dem => {
  if (typeof dem === 'string') {
    if (!Object.hasOwn(terrainPresets, dem))
      fail(TypeError, `dem desconocido: ${JSON.stringify(dem)} (los nombres son ${Object.keys(terrainPresets).join(', ')})`)
    return Object.freeze({ ...terrainPresets[dem] })
  }
  if (dem === null || typeof dem !== 'object' || Array.isArray(dem))
    fail(TypeError, 'dem tiene que ser un nombre de terrainPresets o un TerrainSource')
  const { url, encoding, zoom, maxZoom = MAX_ZOOM_LIMIT, tileSize = 256 } = dem
  if (typeof url !== 'string' || !url.includes('{z}') || !url.includes('{x}') || !url.includes('{y}'))
    fail(TypeError, 'dem.url tiene que llevar {z}, {x} e {y}')
  if (encoding !== 'terrarium' && encoding !== 'mapbox') fail(TypeError, `dem.encoding desconocido: ${encoding}`)
  if (!isInteger(maxZoom, 0, MAX_ZOOM_LIMIT)) fail(RangeError, `dem.maxZoom tiene que ser un entero en [0, ${MAX_ZOOM_LIMIT}]: ${maxZoom}`)
  if (!isInteger(zoom, 0, maxZoom)) fail(RangeError, `dem.zoom tiene que ser un entero en [0, ${maxZoom}]: ${zoom}`)
  if (!isInteger(tileSize, 1, Infinity)) fail(RangeError, `dem.tileSize tiene que ser un entero ≥ 1: ${tileSize}`)
  const out = { ...dem, maxZoom, tileSize }
  return Object.freeze(out)
}

const readBreaks = breaks => {
  if (breaks === undefined) return Object.freeze([])
  if (!Array.isArray(breaks)) fail(TypeError, 'slopeBreaks tiene que ser un array de razones m/m')
  if (breaks.length > MAX_SLOPE_BREAKS) fail(RangeError, `slopeBreaks admite a lo sumo ${MAX_SLOPE_BREAKS} cortes: ${breaks.length}`)
  let last = -Infinity
  for (const b of breaks) {
    if (typeof b !== 'number' || !Number.isFinite(b) || b < 0 || b <= last)
      fail(TypeError, 'slopeBreaks: números finitos ≥ 0, en orden estrictamente creciente')
    last = b
  }
  return Object.freeze([...breaks])
}

// n + 1 colores entre los dos extremos por defecto, interpolados linealmente en RGBA. Con n = 0 se piden
// dos: la rampa continua necesita una parada en cada extremo.
const defaultColors = count => {
  const lo = parseColor(DEFAULT_SLOPE_LOW)
  const hi = parseColor(DEFAULT_SLOPE_HIGH)
  const steps = Math.max(count, 2)
  const out = []
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1)
    out.push(Object.freeze(lo.map((c, k) => c + (hi[k] - c) * t)))
  }
  return out
}

const readColors = (colors, n) => {
  if (colors === undefined) return Object.freeze(defaultColors(n + 1))
  if (!Array.isArray(colors)) fail(TypeError, 'slopeColors tiene que ser un array de colores CSS')
  // Con cortes, una clase por intervalo. Sin cortes la rampa es continua y admite las paradas que se quiera.
  if (n > 0 ? colors.length !== n + 1 : colors.length < 1)
    fail(TypeError, `slopeColors tiene que traer ${n + 1} colores para ${n} cortes: ${colors.length}`)
  return Object.freeze(colors.map(c => {
    const rgba = parseColor(c)
    if (!rgba) fail(TypeError, `slopeColors: color inválido ${JSON.stringify(c)}`)
    return Object.freeze(rgba)
  }))
}

const readRange = range => {
  if (range === undefined || range === null) return null
  if (!Array.isArray(range) || range.length !== 2 || !range.every(v => typeof v === 'number' && Number.isFinite(v)) || !(range[0] < range[1]))
    fail(TypeError, 'elevationRange tiene que ser un par finito [min, max] con min < max, o null')
  return Object.freeze([range[0], range[1]])
}

/**
 * Valida y normaliza una configuración de capa de terreno. Con `previous` (otra salida de esta función)
 * comprueba además lo que no cambia después del alta: `id` y `fetch`. Nunca muta sus argumentos.
 * @returns {Readonly<object>} la configuración resuelta y congelada.
 */
export const readTerrainConfig = (cfg, previous = null) => {
  if (cfg === null || typeof cfg !== 'object') fail(TypeError, 'la configuración tiene que ser un objeto')
  const { id, dem, hillshade, colorBy = 'none', slopeBreaks, slopeColors, elevationRange, contours = 0,
    clipTo, opacity = 1, visible = true, pane, z, fetch } = cfg
  if (typeof id !== 'string' || id === '') fail(TypeError, 'id tiene que ser una cadena no vacía')
  if (previous && id !== previous.id) fail(TypeError, `id no se cambia después del alta: ${previous.id} → ${id}`)
  if (dem === undefined) fail(TypeError, 'falta dem: un nombre de terrainPresets o un TerrainSource')
  const source = readSource(dem)
  if (!COLOR_BY.includes(colorBy)) fail(TypeError, `colorBy tiene que ser ${COLOR_BY.join(', ')}: ${JSON.stringify(colorBy)}`)
  if (hillshade !== undefined && typeof hillshade !== 'boolean') fail(TypeError, `hillshade tiene que ser un booleano: ${hillshade}`)
  const breaks = readBreaks(slopeBreaks)
  const colors = readColors(slopeColors, breaks.length)
  const range = readRange(elevationRange)
  if (typeof contours !== 'number' || !Number.isFinite(contours) || contours < 0) fail(TypeError, `contours tiene que ser un número finito ≥ 0: ${contours}`)
  if (clipTo !== undefined && (typeof clipTo !== 'string' || clipTo === '')) fail(TypeError, 'clipTo tiene que ser una cadena no vacía')
  if (typeof opacity !== 'number' || !(opacity >= 0 && opacity <= 1)) fail(TypeError, `opacity tiene que estar en [0, 1]: ${opacity}`)
  if (typeof visible !== 'boolean') fail(TypeError, `visible tiene que ser un booleano: ${visible}`)
  if (fetch !== undefined && typeof fetch !== 'function') fail(TypeError, 'fetch tiene que ser una función')
  if (previous && fetch !== previous.fetch) fail(TypeError, 'fetch se da sólo al alta')
  if (pane !== undefined && typeof pane !== 'string') fail(TypeError, `pane tiene que ser una cadena: ${pane}`)
  if (previous && pane !== previous.pane) fail(TypeError, 'pane se da sólo al alta')
  if (z !== undefined && !(typeof z === 'number' && Number.isFinite(z))) fail(TypeError, `z tiene que ser un número finito: ${z}`)

  const out = Object.freeze({
    id, dem, source, hillshade: hillshade ?? colorBy === 'none', colorBy,
    slopeBreaks: breaks, slopeColors: colors, elevationRange: range, contours, clipTo, opacity, visible,
    pane, z, fetch,
  })
  DECLARED.set(out, { hillshade, slopeColors })
  return out
}

// Igualdad de dos arreglos de números o de arreglos de números.
const sameList = (a, b) => a.length === b.length && a.every((v, i) => (Array.isArray(v) ? sameList(v, b[i]) : v === b[i]))

const sameSource = (a, b) => {
  const ka = Object.keys(a)
  return ka.length === Object.keys(b).length && ka.every(k => a[k] === b[k])
}

/**
 * Aplica un cambio parcial a una configuración. Lo que el autor no declaró (el sombreado, los colores) se
 * resuelve de nuevo con los valores nuevos. Si algo es inválido lanza y `previous` queda como estaba.
 * @returns {{ config: Readonly<object>, changed: { dem: boolean, style: boolean, clip: boolean } }}
 */
export const updateTerrainConfig = (previous, partial) => {
  if (partial === null || typeof partial !== 'object') fail(TypeError, 'update espera un objeto con las opciones a cambiar')
  const declared = DECLARED.get(previous) ?? {}
  const base = { ...previous, hillshade: declared.hillshade, slopeColors: declared.slopeColors }
  const config = readTerrainConfig({ ...base, ...partial }, previous)
  const style = config.hillshade !== previous.hillshade || config.colorBy !== previous.colorBy
    || !sameList(config.slopeBreaks, previous.slopeBreaks) || !sameList(config.slopeColors, previous.slopeColors)
    || !sameList(config.elevationRange ?? [], previous.elevationRange ?? []) || (config.elevationRange === null) !== (previous.elevationRange === null)
    || config.contours !== previous.contours || config.opacity !== previous.opacity || config.visible !== previous.visible
  return {
    config,
    changed: { dem: !sameSource(config.source, previous.source), style, clip: config.clipTo !== previous.clipTo },
  }
}
