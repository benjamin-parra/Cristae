// Atributos de un Shapefile: el `.dbf` de dBase III/IV. La especificación pública (dbase.com,
// «db7_file_fmt») es la de dBase Level 7: confirma el terminador 0x0D de los descriptores, el language
// driver id en el byte 29 y la bandera de borrado (0x20 / 0x2A). La cabecera de 32 bytes y los
// descriptores de 32 de III/IV son la estructura conocida [inf.]: ninguna fuente oficial los publica.
import { FormatError } from './core/error.js'

const fail = (code, at = -1) => { throw new FormatError('shapefile', code, at) }

// Versiones de dBase III y IV, con y sin memo, y las de FoxPro, que comparten descriptores de 32
// bytes [inf.]. dBase 7 (0x04) usa descriptores de 48 (dbase.com) y queda fuera.
const VERSIONS = new Set([0x03, 0x30, 0x31, 0x32, 0x43, 0x63, 0x83, 0x8B, 0xCB, 0xF5, 0xFB])

// Byte 29, el language driver id. Sólo los que `TextDecoder` conoce: uno fuera de la tabla no aplica
// y se pasa al default (D-4) [inf.: valores de memoria].
const DRIVERS = new Map([
  [0x03, 'windows-1252'], [0x57, 'windows-1252'], [0x58, 'windows-1252'], [0x59, 'windows-1252'],
  [0x65, 'ibm866'],       [0x7D, 'windows-1255'], [0x7E, 'windows-1256'], [0xC8, 'windows-1250'],
  [0xC9, 'windows-1251'], [0xCA, 'windows-1254'], [0xCB, 'windows-1253'],
])

// Páginas de código que un `.cpg` escribe como número, fuera de las reglas de `encodingOf`. 437 y 850
// se reconocen pero `TextDecoder` no las trae (WHATWG Encoding): caen al aviso como una desconocida.
const CODEPAGES = new Map([
  [65001, 'utf-8'],       [874, 'windows-874'],   [932, 'shift_jis'],     [936, 'gbk'],
  [949, 'euc-kr'],        [950, 'big5'],          [866, 'ibm866'],        [437, 'ibm437'],
  [850, 'ibm850'],        [20866, 'koi8-r'],      [21866, 'koi8-u'],      [10000, 'macintosh'],
  [54936, 'gb18030'],     [20932, 'euc-jp'],      [28603, 'iso-8859-13'], [28604, 'iso-8859-14'],
  [28605, 'iso-8859-15'], [28606, 'iso-8859-16'],
])

const supported = name => {
  try { return new TextDecoder(name).encoding }
  catch { return null }
}

// La etiqueta de un `.cpg` o de `options.encoding` → el nombre canónico de `TextDecoder`, o `null` si no
// se reconoce o el entorno no la decodifica. Se normaliza sin mayúsculas, espacios, `_` ni `-`:
// `88591`, `8859-1` e `ISO 8859-1` son ISO-8859-1; `1252`, `ANSI 1252`, `CP1252` y `windows-1252` son
// windows-1252; `28591` es ISO-8859-1 por número de página. Lo demás se le pregunta a `TextDecoder`, que
// conoce los nombres del estándar (`latin1`, `Shift_JIS`, `EUC-KR`, `koi8-r`…).
export const encodingOf = label => {
  const trimmed = label.trim()
  const key     = trimmed.toUpperCase().replace(/[\s_-]+/g, '')
  const iso     = /^(?:ISO)?8859(\d{1,2})$/.exec(key)?.[1]
  const page    = /^(?:ANSI|WINDOWS|CP|MS|IBM)?(\d+)$/.exec(key)?.[1]
  const n       = Number(page)
  const name    = iso !== undefined ? `iso-8859-${iso}`
    : page === undefined ? null
    : n >= 1250 && n <= 1258 ? `windows-${n}`
    : n >= 28591 && n <= 28599 ? `iso-8859-${n - 28590}`
    : CODEPAGES.get(n) ?? ''
  return name !== null ? (name || null) && supported(name)
    : trimmed === '' ? null
    : (supported(trimmed) ?? supported(trimmed.replace(/\s+/g, '-')) ??
      supported(trimmed.replace(/\s+/g, '_')) ?? supported(key.toLowerCase()))
}

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

// `label` es la codificación ya elegida y validada por el llamador (`options.encoding` o el `.cpg`); sin
// ella manda el language driver y después windows-1252. `stats` es el de las tablas del lector.
// Decodificar es estricto: un byte inválido en su codificación es 'codificacion', en el nombre de un
// campo al abrir y en un valor al pedirlo. windows-1252 asigna los 256 bytes (WHATWG Encoding), así que
// el default no falla nunca.
export const openDbf = (bytes, label, stats) => {
  const len = bytes.length
  len < 32 && fail('truncado', len)
  VERSIONS.has(bytes[0]) || fail('version', 0)

  const view     = new DataView(bytes.buffer, bytes.byteOffset, len)
  const records  = view.getUint32(4, true)
  const header   = view.getUint16(8, true)
  const size     = view.getUint16(10, true)
  const encoding = label ?? supported(DRIVERS.get(bytes[29]) ?? 'windows-1252') ?? 'windows-1252'
  const decoder  = new TextDecoder(encoding, { fatal: true })
  const decode   = (data, from, to) => {
    try { return decoder.decode(data.subarray(from, to)) }
    catch { return fail('codificacion', from) }
  }
  header > len && fail('truncado', len)

  const fields = []
  let at = 32, offset = 1
  while (at < header && bytes[at] !== 0x0D) {
    at + 32 > header && fail('estructura', at)
    let end = at
    while (end < at + 11 && bytes[end]) end++
    const name   = decode(bytes, at, end).trim()
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
    // `fromEntries` y no asignación: un campo `__proto__` es una clave, no el prototipo.
    properties : (data, from) => Object.fromEntries(fields.map(({ name, offset, length, value }) =>
      [name, value ? value(decode(data, from + offset, from + offset + length)) : null])),
  }
}
