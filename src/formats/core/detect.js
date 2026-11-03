// Detección de formato por bytes mágicos y primer token (DISENO-INTEROP §2.8). Es para el consumidor que
// recibe un archivo sin extensión fiable: ningún lector la llama, porque leer no adivina (SPECS §17.3-1).

import { asBytes, bomSkip } from './input.js'
import { listZip } from './zip.js'

const WKT = new Set([
  'POINT', 'LINESTRING', 'POLYGON', 'MULTIPOINT', 'MULTILINESTRING', 'MULTIPOLYGON', 'GEOMETRYCOLLECTION',
  'TRIANGLE', 'TIN', 'POLYHEDRALSURFACE', 'CIRCULARSTRING', 'COMPOUNDCURVE', 'CURVEPOLYGON', 'MULTICURVE',
  'MULTISURFACE',
])
const GEOJSON = new Set([
  'Feature', 'FeatureCollection', 'Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon',
  'MultiPolygon', 'GeometryCollection',
])
const ESRI = new Set(['geometryType', 'spatialReference', 'attributes', 'rings', 'paths', 'points', 'xmin'])

const isSpace  = c => c === 32 || c === 9 || c === 10 || c === 13
const isLetter = c => (c | 0x20) >= 97 && (c | 0x20) <= 122
const ascii    = (bytes, from, to) => {
  let s = ''
  for (let i = from; i < to; i++) s += String.fromCharCode(bytes[i])
  return s
}

// Tipo WKB con las banderas EWKB fuera: ISO 1-7, 15-17 y sus variantes +1000, +2000 y +3000.
const wkbType = t => (k => k <= 3999 && [1, 2, 3, 4, 5, 6, 7, 15, 16, 17].includes(k % 1000))((t & 0x1FFFFFFF) >>> 0)

const isWkb = bytes => {
  if (bytes.length < 5 || bytes[0] > 1) return false
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return wkbType(view.getUint32(1, bytes[0] === 1))
}

// El hex que sale de PostGIS, con el blanco del final que deja un archivo de texto.
const isHexWkb = (bytes, from) => {
  let to = bytes.length
  while (to > from && isSpace(bytes[to - 1])) to--
  if (to - from < 10 || (to - from) % 2) return false
  const raw = new Uint8Array(5)
  for (let i = from; i < to; i++) {
    const c = bytes[i] | 0x20
    if (!((c >= 48 && c <= 57) || (c >= 97 && c <= 102))) return false
    i - from < 10 && (raw[(i - from) >> 1] = raw[(i - from) >> 1] << 4 | (c <= 57 ? c - 48 : c - 87))
  }
  return isWkb(raw)
}

// Raíz de un XML: se saltan el prólogo, los comentarios, las PI y el DOCTYPE.
const xmlRoot = (bytes, i) => {
  const len = bytes.length
  while (i < len) {
    while (i < len && isSpace(bytes[i])) i++
    if (bytes[i] !== 60) return null
    const c = bytes[i + 1]
    if (c === 63 || c === 33) {
      const comment = c === 33 && bytes[i + 2] === 45 && bytes[i + 3] === 45
      i += 2
      while (i < len && !(comment ? bytes[i] === 45 && bytes[i + 1] === 45 && bytes[i + 2] === 62 : bytes[i] === 62)) i++
      i += comment ? 3 : 1
      continue
    }
    const from = i + 1
    let to = from
    while (to < len && !isSpace(bytes[to]) && bytes[to] !== 62 && bytes[to] !== 47) to++
    const name  = ascii(bytes, from, to)
    const local = name.slice(name.lastIndexOf(':') + 1)
    return local === 'kml' || local === 'gpx' ? local : null
  }
  return null
}

// Claves del objeto raíz, con el valor de `type` si es texto. Recorre una vez y sin decodificar valores.
const jsonRoot = (bytes, i) => {
  const len  = bytes.length
  const keys = new Set()
  let depth = 0, expectKey = false, key = null, type = null
  for (; i < len; i++) {
    const c = bytes[i]
    if (c === 34) {
      const from = ++i
      while (i < len && bytes[i] !== 34) bytes[i] === 92 ? i += 2 : i++
      if (depth === 1 && expectKey) {
        key = ascii(bytes, from, i)
        keys.add(key)
        expectKey = false
      } else if (depth === 1 && key === 'type') type = ascii(bytes, from, i)
    } else if (c === 123 || c === 91) {
      depth++
      depth === 1 && c === 123 && (expectKey = true)
    } else if (c === 125 || c === 93) depth--
    else if (c === 44 && depth === 1) {
      expectKey = true
      key = null
    }
    if (type !== null) break
  }
  return type === 'Topology' ? 'topojson'
    : GEOJSON.has(type) ? 'geojson'
    : [...keys].some(k => ESRI.has(k)) || (keys.has('x') && keys.has('y')) ? 'esrijson'
    : null
}

export const detectFormat = input => {
  const bytes = asBytes(input)
  if (bytes === null || bytes.length === 0) return null

  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4B && bytes[2] === 3 && bytes[3] === 4) {
    try {
      const names = listZip(bytes, 'zip').map(e => e.name.toLowerCase())
      return names.some(n => n.endsWith('.kml')) ? 'kmz' : names.some(n => n.endsWith('.shp')) ? 'shapefile-zip' : 'zip'
    } catch { return 'zip' }
  }
  if (bytes.length >= 8 && ascii(bytes, 0, 3) === 'fgb' && ascii(bytes, 4, 7) === 'fgb') return 'flatgeobuf'
  if (bytes.length >= 100 && bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 0x27 && bytes[3] === 0x0A) return 'shapefile'
  if (isWkb(bytes)) return 'wkb'

  let i = bomSkip(bytes)
  while (i < bytes.length && isSpace(bytes[i])) i++
  const c = bytes[i]
  if (c === 60) return xmlRoot(bytes, i)
  if (c === 123) return jsonRoot(bytes, i)
  if (isHexWkb(bytes, i)) return 'wkb'

  let j = i
  if (ascii(bytes, i, i + 5).toUpperCase() === 'SRID=') {
    j += 5
    while (j < bytes.length && bytes[j] >= 48 && bytes[j] <= 57) j++
    if (bytes[j] !== 59) return null
    i = ++j
  }
  while (j < bytes.length && isLetter(bytes[j])) j++
  return WKT.has(ascii(bytes, i, j).toUpperCase()) ? 'wkt' : null
}
