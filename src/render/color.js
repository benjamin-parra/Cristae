// render/color.js — parseo/formateo de color puro (hex/array → RGBA 0..1, hex → string `rgba()`).
// Agnóstico: sin DOM, Leaflet ni dominio; reusable por cualquier capa de render.

// Plantilla del fallback; toRGBA devuelve una COPIA fresca en su rama inválida (contrato uniforme:
// TODA rama entrega un [r,g,b,a] nuevo, así ningún caller puede corromper este default compartido).
export const DEFAULT_COLOR = [0.4, 0.4, 0.4, 1]

// `#RGB` / `#RGBA` / `#RRGGBB` / `#RRGGBBAA`, o [r,g,b,a?] (0..1) → [r, g, b, a] en 0..1 (para
// escribir el buffer). El alpha del propio color gana sobre el default. Una entrada que no sea un
// color cae al DEFAULT en vez de producir NaN: un color inválido debe verse, no desaparecer.
const HEX = /^#?([0-9a-f]{3,8})$/i
export const toRGBA = (color, alpha = 1) => {
  if (Array.isArray(color)) return [color[0], color[1], color[2], color[3] ?? alpha]
  const m = typeof color === 'string' ? HEX.exec(color.trim()) : null
  const h = m && (m[1].length <= 4 ? [...m[1]].map(c => c + c).join('') : m[1])
  if (!h || (h.length !== 6 && h.length !== 8)) return [...DEFAULT_COLOR]
  const n = Number.parseInt(h, 16)
  return h.length === 6
    ? [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255, alpha]
    : [((n >>> 24) & 0xff) / 255, ((n >>> 16) & 0xff) / 255, ((n >>> 8) & 0xff) / 255, (n & 0xff) / 255]
}

// hex → string CSS `rgba(r, g, b, alpha)` con canales 0..255. Acepta los MISMOS formatos hex que toRGBA
// (mismo `HEX`): `#RGB` / `#RGBA` / `#RRGGBB` / `#RRGGBBAA`, con o sin `#`. El alpha SIEMPRE es el del
// parámetro (un `#RRGGBBAA` ignora su alpha propio: withAlpha existe para APLICAR este alpha). Lo que no
// es hex (nombres CSS, `rgb()`, null) se devuelve sin tocar.
export const withAlpha = (color, alpha) => {
  const m = typeof color === 'string' ? HEX.exec(color.trim()) : null
  const h = m && (m[1].length <= 4 ? [...m[1]].map(c => c + c).join('') : m[1])
  if (!h || (h.length !== 6 && h.length !== 8)) return color
  const n = Number.parseInt(h.slice(0, 6), 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}

// Canal de `rgb()`/`rgba()`: número o porcentaje, sin signo ni exponente.
const NUM = '(\\d*\\.?\\d+)(%?)'
const RGB = new RegExp(`^rgba?\\(\\s*${NUM}\\s*[, ]\\s*${NUM}\\s*[, ]\\s*${NUM}(?:\\s*[,/]\\s*${NUM})?\\s*\\)$`, 'i')
const RGB_MAX = 255                    // un canal sin `%` va en 0..255
const PCT_MAX = 100
const HEX_BARE = /^[0-9a-f]{3,8}$/i       // hex sin `#`, como acepta toRGBA
const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v)

// css → [r, g, b, a] en 0..1, o null si no es un color que entendamos. A diferencia de toRGBA, que cae al gris
// para que un color inválido se vea, acá lo inválido se distingue: quien valida lanza o avisa. Acepta los hex de
// toRGBA y `rgb()`/`rgba()` con números (canales 0..255, alfa 0..1) o porcentajes, con comas o espacios y `/`
// antes del alfa. Un canal fuera de rango se acota. Los nombres CSS no entran: los normaliza quien tiene DOM.
export const parseColor = css => {
  if (typeof css !== 'string') return null
  const text = css.trim()
  if (text[0] === '#' || HEX_BARE.test(text)) {
    const m = HEX.exec(text)
    const len = m ? m[1].length : 0
    return len === 3 || len === 4 || len === 6 || len === 8 ? toRGBA(text) : null
  }
  const m = RGB.exec(text)
  if (!m) return null
  const chan = (v, pct, max) => clamp01(Number(v) / (pct ? PCT_MAX : max))
  return [
    chan(m[1], m[2], RGB_MAX),
    chan(m[3], m[4], RGB_MAX),
    chan(m[5], m[6], RGB_MAX),
    m[7] === undefined ? 1 : chan(m[7], m[8], 1),
  ]
}
