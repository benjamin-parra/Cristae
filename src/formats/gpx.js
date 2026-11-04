// Lector de GPX 1.1: bytes → las tablas CSR de readGeoJson, en una pasada sobre el tokenizador XML.
// Referencia: esquema http://www.topografix.com/GPX/1/1/gpx.xsd. Contrato en DISENO-INTEROP §3.2.

import { FormatError } from './core/error.js'
import { asBytes } from './core/input.js'
import { DECIMAL_GRAMMAR, scanNumber } from './core/number.js'
import { createTables } from './core/tables.js'
import { crsFromEpsg } from './core/crs.js'
import { EOF, END, START, WS, createXml, names, xmlOptions } from './xml.js'

const GPX = 1, WPT = 2, RTE = 3, TRK = 4, RTEPT = 5, TRKSEG = 6, TRKPT = 7, ELE = 8, NAME = 9, CMT = 10,
      DESC = 11, SRC = 12, TYPE = 13, NUMBER = 14, LINK = 15, KML = 16

const ELEMENTS = names([
  ['gpx', GPX], ['wpt', WPT], ['rte', RTE], ['trk', TRK], ['rtept', RTEPT], ['trkseg', TRKSEG],
  ['trkpt', TRKPT], ['ele', ELE], ['name', NAME], ['cmt', CMT], ['desc', DESC], ['src', SRC],
  ['type', TYPE], ['number', NUMBER], ['link', LINK], ['kml', KML],
])
const TEXT_KEYS = ['name', 'cmt', 'desc', 'src', 'type']

const encoder = new TextEncoder()
const LAT     = encoder.encode('lat')
const LON     = encoder.encode('lon')
const HREF    = encoder.encode('href')

const C_ROOT = 1, C_WPT = 2, C_RTE = 3, C_TRK = 4, C_SEG = 5, C_POINT = 6

const WGS84 = 4326

// `{ name, cmt, desc, src, type, number, link }`, los presentes (DISENO §1.2). `link` es el `href` del
// primero. Un `number` que no es número no decodifica: lanza, y el sellado lo vuelve 'properties'.
const featureProperties = (encoding, maxDepth) => (bytes, from, to) => {
  const x      = createXml(bytes, 'gpx', maxDepth, from, to, encoding)
  const values = new Array(TEXT_KEYS.length)
  let number = null
  let link   = null

  x.next()
  for (let e; (e = x.next()) !== EOF; ) {
    if (e !== START) continue
    const code = x.code(ELEMENTS)
    if (code >= NAME && code <= TYPE) values[code - NAME] = x.text()
    else if (code === NUMBER) {
      number = Number(x.text())
      if (!Number.isFinite(number)) throw new FormatError('gpx', 'properties', x.tag0)
    } else if (code === LINK && link === null) {
      const m = x.attr(HREF)
      m < 0 || (link = x.attrText(m))
      x.skip()
    } else x.skip()
  }
  const entries = TEXT_KEYS.map((key, k) => [key, values[k]]).filter(([, value]) => value !== undefined)
  number === null || entries.push(['number', number])
  link === null || entries.push(['link', link])
  return Object.fromEntries(entries)
}

export const readGpx = (input, options = {}) => {
  const bytes = asBytes(input)
  if (bytes === null) throw new FormatError('gpx', 'entrada')

  const { maxDepth, capacityHint, bounds } = xmlOptions(options, bytes, 'gpx')
  const x     = createXml(bytes, 'gpx', maxDepth)
  const t     = createTables('gpx', { capacityHint, bounds })
  const stats = t.stats
  const out   = new Float64Array(2)
  const fail  = (code, at, hint = null) => { throw new FormatError('gpx', code, at, hint) }

  const context = new Uint8Array(8)
  let feature = -1
  let started = 0
  let opened  = false
  let lon     = 0
  let lat     = 0
  let ele     = NaN

  // Un `xsd:decimal` con `whiteSpace` collapse: espacios al principio y al final, y nada más.
  const number = () => {
    const b    = x.gBytes
    const stop = x.gTo
    let k = x.gFrom
    while (k < stop && WS[b[k]]) k++
    const next = scanNumber(b, k, stop, DECIMAL_GRAMMAR, out)
    next < 0 && fail('numero', b === bytes ? k : x.gAt)
    out[1] && stats.slowNumbers++
    k = next
    while (k < stop && WS[b[k]]) k++
    k < stop && fail('numero', b === bytes ? k : x.gAt)
    return out[0]
  }

  // `lat` y `lon` son atributos obligatorios de `wptType` y van a `xy` como `[lon, lat]`.
  const position = () => {
    const mLat = x.attr(LAT), mLon = x.attr(LON)
    ;(mLat < 0 || mLon < 0) && fail('posicion', x.tag0)
    x.attrNumber(mLat)
    lat = number()
    x.attrNumber(mLon)
    lon = number()
    ele = NaN
  }

  const foreign = () => {
    stats.foreignMembers++
    x.skip()
  }

  const open = (d, ctx) => {
    context[d] = ctx
    feature    = t.feature()
    started    = x.tag0
  }

  // Hijos de `wpt`, `rte` y `trk` que son atributos del feature: no se recorren ahora, los decodifica
  // `propertiesOf`.
  const attribute = code => code >= NAME && code <= LINK

  x.next()
  const root = x.code(ELEMENTS)
  root === GPX || fail('formato', x.tag0, root === KML ? 'kml' : null)
  context[1] = C_ROOT

  for (let e; (e = x.next()) !== EOF; ) {
    const d = x.depth
    if (e === END) {
      switch (context[d]) {
        case C_WPT:
          t.geometry()
          t.part()
          t.ring()
          t.vertex(lon, lat, ele)
          t.close(1)
          t.attributes(feature, started, x.tag1)
          break
        case C_POINT:
          if (context[d - 1] === C_RTE && !opened) {
            t.part()
            t.ring()
            opened = true
          }
          t.vertex(lon, lat, ele)
          break
        case C_RTE:
          t.close(3)
          t.attributes(feature, started, x.tag1)
          break
        case C_TRK:
          t.close(4)
          t.attributes(feature, started, x.tag1)
          break
      }
      continue
    }
    if (e !== START) continue

    const code = x.code(ELEMENTS)
    switch (context[d - 1]) {
      case C_ROOT:
        if (code === WPT) {
          open(d, C_WPT)
          position()
        } else if (code === RTE || code === TRK) {
          open(d, code === RTE ? C_RTE : C_TRK)
          t.geometry()
          opened = false
        } else foreign()
        break
      case C_WPT:
      case C_POINT:
        if (code === ELE) {
          x.gather()
          ele = number()
        } else context[d - 1] === C_WPT && attribute(code) ? x.skip() : foreign()
        break
      case C_RTE:
        if (code === RTEPT) {
          context[d] = C_POINT
          position()
        } else attribute(code) ? x.skip() : foreign()
        break
      case C_TRK:
        // Un `trk` es siempre MultiLineString: una parte por `trkseg`, vacío incluido (D-15).
        if (code === TRKSEG) {
          context[d] = C_SEG
          t.part()
          t.ring()
        } else attribute(code) ? x.skip() : foreign()
        break
      case C_SEG:
        if (code === TRKPT) {
          context[d] = C_POINT
          position()
        } else foreign()
        break
      default:
        foreign()
    }
  }

  return t.seal({
    source     : crsFromEpsg(WGS84),
    bytes,
    properties : featureProperties(x.encoding, maxDepth),
    id         : () => null,
  })
}
