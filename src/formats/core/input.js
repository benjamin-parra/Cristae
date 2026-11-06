// Normalización de la entrada (SPECS §17.3-6, DISENO-INTEROP §2.1).

import { FormatError } from './error.js'

const encoder = new TextEncoder()

// Por tipo explícito y respetando `byteOffset`: un `Buffer` de Node vive en un pool compartido.
export const asBytes = input =>
  ArrayBuffer.isView(input)      ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
  : input instanceof ArrayBuffer ? new Uint8Array(input)
  : typeof input === 'string'    ? encoder.encode(input)
  : null

export const bomSkip = bytes =>
  bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF ? 3 : 0

// Valor de cada carácter hexadecimal, 255 para los demás.
const NIBBLE = new Uint8Array(128).fill(255)
'0123456789abcdef'.split('').forEach((c, k) => {
  NIBBLE[c.charCodeAt(0)] = k
  NIBBLE[c.toUpperCase().charCodeAt(0)] = k
})

// El WKB que sale de PostGIS en texto. `at` es el índice del carácter que falla.
export const hexBytes = (text, format) => {
  if (typeof text !== 'string' || text.length % 2) throw new FormatError(format, 'entrada', typeof text === 'string' ? text.length : -1)

  const out = new Uint8Array(text.length >> 1)
  for (let i = 0; i < text.length; i += 2) {
    const hi = text.charCodeAt(i), lo = text.charCodeAt(i + 1)
    const h  = hi < 128 ? NIBBLE[hi] : 255
    const l  = lo < 128 ? NIBBLE[lo] : 255
    if (h === 255 || l === 255) throw new FormatError(format, 'entrada', h === 255 ? i : i + 1)
    out[i >> 1] = h << 4 | l
  }
  return out
}
