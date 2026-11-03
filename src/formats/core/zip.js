// Zip de lectura por el directorio central (DISENO-INTEROP §2.7; PKWARE APPNOTE 6.3.x, §4.3.7, §4.3.12,
// §4.3.16, §4.4.4 y §4.4.5, números de § a verificar con D-11). Inflado con `DecompressionStream`, un
// solo camino para todos los motores.

import { FormatError } from './error.js'

const EOCD    = 0x06054b50
const CENTRAL = 0x02014b50
const LOCAL   = 0x04034b50
const LOCATOR = 0x07064b50    // localizador del EOCD de zip64

const MAX_BYTES = 268435456

let crcTable = null

const crc32 = bytes => {
  crcTable ??= Uint32Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  let c = 0xFFFFFFFF
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}

const utf8   = new TextDecoder('utf-8', { fatal: true })
const legacy = new TextDecoder('windows-1252')

// ZipEntry = { name, method, flags, crc, size, packed, data }. `data` es el offset del primer byte de
// datos, tomado del encabezado LOCAL; tamaños y CRC salen del directorio central (bit 3).
export const listZip = (bytes, format) => {
  const fail = (code, at = -1) => { throw new FormatError(format, code, at) }
  const len  = bytes.length
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  // El EOCD se busca hacia atrás: gana la firma más cercana al final cuyo comentario llega justo al final.
  let end = -1
  for (let p = len - 22; p >= 0 && p >= len - 22 - 65535 && end < 0; p--)
    view.getUint32(p, true) === EOCD && p + 22 + view.getUint16(p + 20, true) === len && (end = p)
  end < 0 && fail('formato', 0)

  const disk    = view.getUint16(end + 4, true)
  const cdDisk  = view.getUint16(end + 6, true)
  const onDisk  = view.getUint16(end + 8, true)
  const total   = view.getUint16(end + 10, true)
  const cdSize  = view.getUint32(end + 12, true)
  const cdStart = view.getUint32(end + 16, true)

  ;(disk || cdDisk || onDisk !== total) && fail('version', end)
  ;(total === 0xFFFF || cdSize === 0xFFFFFFFF || cdStart === 0xFFFFFFFF) && fail('version', end)
  end >= 20 && view.getUint32(end - 20, true) === LOCATOR && fail('version', end - 20)
  // §1.6-1: el conteo declarado se valida contra los bytes antes de recorrer nada.
  ;(cdStart + cdSize > end || total * 46 > cdSize) && fail('truncado', end)

  const entries = []
  for (let k = 0, p = cdStart; k < total; k++) {
    p + 46 > cdStart + cdSize && fail('truncado', p)
    view.getUint32(p, true) === CENTRAL || fail('estructura', p)

    const flags   = view.getUint16(p + 8, true)
    const method  = view.getUint16(p + 10, true)
    const crc     = view.getUint32(p + 16, true)
    const packed  = view.getUint32(p + 20, true)
    const size    = view.getUint32(p + 24, true)
    const nameLen = view.getUint16(p + 28, true)
    const next    = p + 46 + nameLen + view.getUint16(p + 30, true) + view.getUint16(p + 32, true)
    const local   = view.getUint32(p + 42, true)

    next > cdStart + cdSize && fail('truncado', p)
    ;(packed === 0xFFFFFFFF || size === 0xFFFFFFFF || local === 0xFFFFFFFF) && fail('version', p)
    local + 30 > len && fail('truncado', local)
    view.getUint32(local, true) === LOCAL || fail('estructura', local)

    const data = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true)
    data + packed > len && fail('truncado', local)

    let name = ''
    try { name = (flags & 0x800 ? utf8 : legacy).decode(bytes.subarray(p + 46, p + 46 + nameLen)) }
    catch { fail('codificacion', p + 46) }

    entries.push({ name, method, flags, crc, size, packed, data })
    p = next
  }
  return entries
}

// Infla una entrada con tope y CRC. `maxBytes` es lo que le queda a la lectura: el lector descuenta lo
// inflado antes de pedir la siguiente entrada (§2.7).
export const unzipEntry = async (bytes, entry, format, maxBytes = MAX_BYTES) => {
  const fail = code => { throw new FormatError(format, code, entry.data) }

  ;(entry.flags & 1) && fail('compresion')
  entry.method === 0 || entry.method === 8 || fail('compresion')
  entry.size > maxBytes && fail('tope')

  const packed = bytes.subarray(entry.data, entry.data + entry.packed)
  let out = null

  if (entry.method === 0) {
    entry.packed === entry.size || fail('compresion')
    out = packed.slice()
  } else {
    typeof DecompressionStream === 'function' || fail('entorno')
    let stream = null
    try { stream = new DecompressionStream('deflate-raw') }
    catch { fail('entorno') }

    // Se infla por partes y se corta apenas lo inflado pasa del tamaño declarado, como el PNG de
    // `src/geometry/raster.js`. Inflar de más o de menos es 'compresion': el tamaño mintió.
    out = new Uint8Array(entry.size)
    const reader = new Blob([packed]).stream().pipeThrough(stream).getReader()
    let filled   = 0
    try {
      for (let part; !(part = await reader.read()).done; ) {
        if (filled + part.value.length > entry.size) {
          reader.cancel().catch(() => {})
          filled = -1
          break
        }
        out.set(part.value, filled)
        filled += part.value.length
      }
    } catch { filled = -1 }
    filled === entry.size || fail('compresion')
  }

  crc32(out) === entry.crc || fail('compresion')
  return out
}
