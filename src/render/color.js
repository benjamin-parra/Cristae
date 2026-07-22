// render/color.js — parseo/formateo de color puro (hex/array → RGBA 0..1, → objeto glify {r,g,b,a},
// hex → string `rgba()`). Agnóstico: sin DOM, Leaflet ni dominio; reusable por cualquier capa de render.

// Fallback compartido; toRGBA lo devuelve POR REFERENCIA en su rama inválida (no una copia).
export const DEFAULT_COLOR = [0.4, 0.4, 0.4, 1]

// `#RGB` / `#RGBA` / `#RRGGBB` / `#RRGGBBAA`, o [r,g,b,a?] (0..1) → [r, g, b, a] en 0..1 (para
// escribir el buffer). El alpha del propio color gana sobre el default. Una entrada que no sea un
// color cae al DEFAULT en vez de producir NaN: un color inválido debe verse, no desaparecer.
const HEX = /^#?([0-9a-f]{3,8})$/i
export const toRGBA = (color, alpha = 1) => {
  if (Array.isArray(color)) return [color[0], color[1], color[2], color[3] ?? alpha]
  const m = typeof color === 'string' ? HEX.exec(color.trim()) : null
  const h = m && (m[1].length <= 4 ? [...m[1]].map((c) => c + c).join('') : m[1])
  if (!h || (h.length !== 6 && h.length !== 8)) return DEFAULT_COLOR
  const n = Number.parseInt(h, 16)
  return h.length === 6
    ? [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255, alpha]
    : [((n >>> 24) & 0xff) / 255, ((n >>> 16) & 0xff) / 255, ((n >>> 8) & 0xff) / 255, (n & 0xff) / 255]
}

// glify.Lines quiere el color PER-FEATURE como IColor {r,g,b,a} (line-feature-vertices lee color.r…),
// no un array. Para el gradiente es placeholder (se sobre-escribe por vértice); para plano es el final.
export const toColorObj = (color, alpha) => {
  const [r, g, b, a] = toRGBA(color, alpha)
  return { r, g, b, a }
}

// hex `#RRGGBB` → string CSS `rgba(r, g, b, alpha)` con canales 0..255. Sólo acepta `#RRGGBB`: cualquier
// otro formato se devuelve sin tocar (divergencia latente con toRGBA — se unifica aparte, no acá).
export const withAlpha = (color, alpha) => {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return color
  const n = parseInt(color.slice(1), 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}
