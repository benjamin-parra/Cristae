// Un terreno sin red, para las pruebas: tiles sintéticos armados a partir de una altura h(lat, lng),
// evaluada en el centro de cada píxel con la Mercator escrita acá (la forma ln tan, no la atanh sen del
// código) y codificada en Terrarium o Mapbox, más el tile real de AWS de test/fixtures. Lo comparten las
// pruebas del terreno, de su caché, de la capa GPU y del motor.
import { readFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

const RAD = Math.PI / 180

export const lngDe = (x, n = 2 ** 20) => x / n * 360 - 180
export const latDe = (y, n = 2 ** 20) => (2 * Math.atan(Math.exp(Math.PI * (1 - 2 * y / n))) - Math.PI / 2) / RAD

const CRC = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = bytes => {
  let c = 0xFFFFFFFF
  for (const v of bytes) c = CRC[(c ^ v) & 255] ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}
const chunk = (type, data) => {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'latin1')
  out.set(data, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

// Un PNG de `lado` × `lado`, RGB o RGBA según lo que devuelva `pixel(x, y)`, sin filtro.
export const png = (lado, pixel) => {
  const bpp = pixel(0, 0).length
  const raw = Buffer.alloc(lado * (1 + lado * bpp))
  for (let y = 0; y < lado; y++)
    for (let x = 0; x < lado; x++) raw.set(pixel(x, y), y * (1 + lado * bpp) + 1 + x * bpp)
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(lado, 0)
  ihdr.writeUInt32BE(lado, 4)
  ihdr.set([8, bpp === 4 ? 6 : 2, 0, 0, 0], 8)
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

// Las dos codificaciones, escritas desde su definición; `terrariumDe` es la altura que decodifica el tile.
export const terrarium   = h => {
  const v = h + 32768
  return [Math.floor(v / 256), Math.floor(v) % 256, Math.floor((v - Math.floor(v)) * 256)]
}
export const mapbox      = h => (c => [c >> 16 & 255, c >> 8 & 255, c & 255])(Math.round((h + 10000) * 10))
export const terrariumDe = h => (([r, g, b]) => r * 256 + g + b / 256 - 32768)(terrarium(h))

export const respuesta = (status, bytes) => ({
  ok          : status >= 200 && status < 300,
  status,
  arrayBuffer : async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
})

// Un mundo de alturas `h(lat, lng)` servido como tiles, plano a 500 m si no se da: `estados` responde un
// código a esas URLs, `pixel` reemplaza la codificación y `lado` el tamaño del PNG. Registra las URLs, las
// señales y los receptores.
export const mundo = ({ h = () => 500, lado = 64, codificar = terrarium, pixel, estados = {}, bytes = {} } = {}) => {
  const urls      = []
  const senales   = []
  const receptores = []
  const fetch = function (url, { signal }) {
    urls.push(url)
    senales.push(signal)
    receptores.push(this)
    if (estados[url]) return Promise.resolve(respuesta(estados[url], new Uint8Array(0)))
    if (bytes[url]) return Promise.resolve(respuesta(200, bytes[url]))
    const [z, tx, ty] = url.match(/(\d+)\/(\d+)\/(\d+)/).slice(1).map(Number)
    const n           = lado * 2 ** z
    return Promise.resolve(respuesta(200, png(lado, pixel ?? ((x, y) =>
      codificar(h(latDe(ty * lado + y + 0.5, n), lngDe(tx * lado + x + 0.5, n)))))))
  }
  return { fetch, urls, senales, receptores }
}

// Los bytes del tile real de AWS z12 1217/2501 (Terrarium, 256 × 256), y su URL en el mundo de pruebas.
export const TESELA_REAL = new Uint8Array(readFileSync(new URL('../test/fixtures/terrarium-12-1217-2501.png', import.meta.url)))
export const URL_TESELA_REAL = 'https://t.test/12/1217/2501.png'
