// Atributos de un Shapefile: el `.dbf` de dBase III/IV. No hay especificación oficial pública; la
// estructura es la conocida [inf.]: cabecera de 32 bytes, descriptores de campo de 32 bytes
// terminados en 0x0D y registros de largo fijo que abren con la bandera de borrado.
import { FormatError } from './core/error.js'

const fail = (code, at = -1) => { throw new FormatError('shapefile', code, at) }

// Versiones de dBase III y IV, con y sin memo, y las de FoxPro, que comparten descriptores de 32
// bytes [inf.]. dBase 7 (0x04) usa descriptores de 48 y queda fuera.
const VERSIONS = new Set([0x03, 0x30, 0x31, 0x32, 0x43, 0x63, 0x83, 0x8B, 0xCB, 0xF5, 0xFB])

// Byte 29, el language driver id. Sólo los que `TextDecoder` conoce: uno fuera de la tabla no aplica
// y se pasa al default (D-4) [inf.: valores de memoria].
const DRIVERS = new Map([
  [0x03, 'windows-1252'], [0x57, 'windows-1252'], [0x58, 'windows-1252'], [0x59, 'windows-1252'],
  [0x65, 'ibm866'],       [0x7D, 'windows-1255'], [0x7E, 'windows-1256'], [0xC8, 'windows-1250'],
  [0xC9, 'windows-1251'], [0xCA, 'windows-1254'], [0xCB, 'windows-1253'],
])

const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/
const DATE   = /^\d{8}$/

// Un valor que no decodifica lanza: el sellado lo convierte en FormatError('properties') (§1.2).
const invalid = text => { throw new Error(`dbf: valor inválido ${JSON.stringify(text)}`) }

const VALUE = {
  C: text => text.replace(/[ \0]+$/, ''),
  N: text => (t => t === '' ? null : NUMBER.test(t) ? Number(t) : invalid(t))(text.trim()),
  L: text => /^[TtYy]$/.test(text) ? true : /^[FfNn]$/.test(text) ? false : /^[? ]?$/.test(text) ? null : invalid(text),
  D: text => (t => t === '' ? null : DATE.test(t) ? `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6)}` : invalid(t))(text.trim()),
}
VALUE.F = VALUE.N

// `label` es la codificación ya elegida por el llamador (`options.encoding` o el `.cpg`); sin ella
// manda el language driver y después windows-1252. `stats` es el de las tablas del lector.
export const openDbf = (bytes, label, stats) => {
  const len = bytes.length
  len < 32 && fail('truncado', len)
  VERSIONS.has(bytes[0]) || fail('version', 0)

  const view     = new DataView(bytes.buffer, bytes.byteOffset, len)
  const records  = view.getUint32(4, true)
  const header   = view.getUint16(8, true)
  const size     = view.getUint16(10, true)
  const encoding = label ?? DRIVERS.get(bytes[29]) ?? 'windows-1252'
  let decoder
  try { decoder = new TextDecoder(encoding, { fatal: true }) }
  catch { fail('codificacion', 29) }
  header > len && fail('truncado', len)

  const fields = []
  let at = 32, offset = 1
  while (at < header && bytes[at] !== 0x0D) {
    at + 32 > header && fail('estructura', at)
    let end = at
    while (end < at + 11 && bytes[end]) end++
    let name
    try { name = decoder.decode(bytes.subarray(at, end)).trim() }
    catch { fail('codificacion', at) }
    const length = bytes[at + 16]
    fields.push({ name, offset, length, value: VALUE[String.fromCharCode(bytes[at + 11])] })
    offset += length
    at += 32
  }
  at < header || fail('estructura', at)
  offset === size || fail('estructura', 10)
  header + records * size > len && fail('truncado', len)

  // Un campo fuera de la tabla (memo, binarios de FoxPro…) sale null: es un miembro atravesado sin
  // interpretar en cada registro.
  stats.foreignMembers += records * fields.filter(field => !field.value).length
  for (let r = 0; r < records; r++) bytes[header + r * size] === 0x2A && stats.deletedRecords++

  return {
    records,
    at         : r => header + r * size,
    size,
    properties : (data, from) => {
      const out = {}
      fields.forEach(({ name, offset, length, value }) => {
        out[name] = value ? value(decoder.decode(data.subarray(from + offset, from + offset + length))) : null
      })
      return out
    },
  }
}
