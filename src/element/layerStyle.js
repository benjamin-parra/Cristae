import { boolDefaultOn, boolOff } from './attrs.js'

// El estilo de capa de las capas de áreas (polígonos y formas): los nombres de `PolygonLayerConfig`, que
// `styleOf` pisa por ítem. `stroke` y `fill` prenden o apagan el trazo y el relleno de la capa entera y
// se leen al montar; los otros cinco se reenvían a `handle.style` al cambiar.
export const STYLE_PROPERTIES = {
  color      : {},
  weight     : { type: Number },
  opacity    : { type: Number },
  stroke     : { converter: boolDefaultOn },
  fill       : { converter: boolDefaultOn },
  fillColor  : { attribute: 'fill-color' },
  fillOpacity: { attribute: 'fill-opacity', type: Number },
}

const KEYS = ['color', 'weight', 'opacity', 'fillColor', 'fillOpacity']
const pick = el => Object.fromEntries(KEYS.map(k => [k, el[k]]))

export const styleConfig = el => ({ ...pick(el), stroke: !boolOff(el.stroke), fill: !boolOff(el.fill) })

export const syncStyle = (el, changed) => KEYS.some(k => changed.has(k)) && el._handle.style(pick(el))
