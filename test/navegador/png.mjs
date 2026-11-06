// Lector mínimo de PNG de 8 bits (RGB o RGBA, sin entrelazado): lo que devuelven las capturas de Playwright y de Marionette.
// Sólo para leer píxeles sueltos; no escribe ni convierte nada.
import { inflateSync } from 'node:zlib'

const paeth = (a, b, c) => {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

export const leerPng = buf => {
  let ancho = 0, alto = 0, tipo = 0, prof = 0, entrelazado = 0
  const idat = []
  for (let o = 8; o < buf.length;) {
    const n = buf.readUInt32BE(o), t = buf.toString('latin1', o + 4, o + 8), d = buf.subarray(o + 8, o + 8 + n)
    t === 'IHDR' && ([ancho, alto, prof, tipo, entrelazado] = [d.readUInt32BE(0), d.readUInt32BE(4), d[8], d[9], d[12]])
    t === 'IDAT' && idat.push(d)
    o += 12 + n
  }
  if (prof !== 8 || (tipo !== 2 && tipo !== 6) || entrelazado) throw new Error(`PNG no soportado (profundidad ${prof}, tipo ${tipo}, entrelazado ${entrelazado})`)
  const bpp = tipo === 6 ? 4 : 3, fila = ancho * bpp, raw = inflateSync(Buffer.concat(idat)), datos = Buffer.alloc(alto * fila)
  for (let y = 0; y < alto; y++) {
    const f = raw[y * (fila + 1)], src = y * (fila + 1) + 1, dst = y * fila
    for (let i = 0; i < fila; i++) {
      const x = raw[src + i], a = i >= bpp ? datos[dst + i - bpp] : 0, b = y ? datos[dst - fila + i] : 0, c = i >= bpp && y ? datos[dst - fila + i - bpp] : 0
      datos[dst + i] = (f === 0 ? x : f === 1 ? x + a : f === 2 ? x + b : f === 3 ? x + ((a + b) >> 1) : x + paeth(a, b, c)) & 255
    }
  }
  return { ancho, alto, px: (x, y) => { const o = y * fila + x * bpp; return [datos[o], datos[o + 1], datos[o + 2]] } }
}
