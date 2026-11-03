// Lector de KML 2.2 y KMZ: bytes → las tablas CSR de readGeoJson, en una pasada sobre el tokenizador
// XML y sin construir nodos. Referencia: OGC 07-147r2. Contrato en DISENO-INTEROP §3.1.

import { FormatError } from './core/error.js'
import { asBytes } from './core/input.js'
import { DECIMAL_GRAMMAR, scanNumber } from './core/number.js'
import { createTables } from './core/tables.js'
import { crsFromEpsg } from './core/crs.js'
import { listZip, unzipEntry } from './core/zip.js'
import { EOF, END, START, WS, createXml, names, xmlOptions, xmlText, ATTRIBUTE_MODE } from './xml.js'

const KML = 1, DOCUMENT = 2, FOLDER = 3, PLACEMARK = 4, POINT = 5, LINESTRING = 6, LINEARRING = 7,
      POLYGON = 8, MULTI = 9, OUTER = 10, INNER = 11, COORDINATES = 12, NAME = 13, DESCRIPTION = 14,
      STYLEURL = 15, EXTENDED = 16, MODEL = 17, TRACK = 18, MULTITRACK = 19, GPX = 20, DATA = 21,
      VALUE = 22, SCHEMADATA = 23, SIMPLEDATA = 24

const ELEMENTS = names([
  ['kml', KML], ['Document', DOCUMENT], ['Folder', FOLDER], ['Placemark', PLACEMARK], ['Point', POINT],
  ['LineString', LINESTRING], ['LinearRing', LINEARRING], ['Polygon', POLYGON], ['MultiGeometry', MULTI],
  ['outerBoundaryIs', OUTER], ['innerBoundaryIs', INNER], ['coordinates', COORDINATES], ['name', NAME],
  ['description', DESCRIPTION], ['styleUrl', STYLEURL], ['ExtendedData', EXTENDED], ['Model', MODEL],
  ['Track', TRACK], ['MultiTrack', MULTITRACK], ['gpx', GPX], ['Data', DATA], ['value', VALUE],
  ['SchemaData', SCHEMADATA], ['SimpleData', SIMPLEDATA],
])
const encoder   = new TextEncoder()
const ID_ATTR   = encoder.encode('id')
const NAME_ATTR = encoder.encode('name')
const BASE_KEYS = ['name', 'description', 'styleUrl']

// Contexto del elemento abierto en cada nivel: decide qué significa un hijo.
const C_ROOT = 1, C_CONTAINER = 2, C_PLACEMARK = 3, C_POINT = 4, C_LINE = 5, C_POLYGON = 6,
      C_OUTER = 7, C_INNER = 8, C_RING = 9, C_MULTI = 10

// Modos del escáner de coordenadas: anillo ya abierto, o parte y anillo abiertos con la primera tupla
// (así un `<coordinates/>` vacío deja una geometría de 0 partes, como `"coordinates": []`).
const M_RING = 0, M_LINE = 1, M_POINT = 2

const MAX_BYTES = 268435456
const WGS84     = 4326

// Atributos de un Placemark: sus hijos DIRECTOS `name`, `description`, `styleUrl` y lo que trae su
// `ExtendedData` (`Data/value` por su atributo `name`, y `SchemaData/SimpleData`). Se construye con
// `fromEntries` para que un `name="__proto__"` sea una clave y no el prototipo.
const placemarkProperties = (encoding, maxDepth, format) => (bytes, from, to) => {
  const x      = createXml(bytes, format, maxDepth, from, to, encoding)
  const base   = new Array(3)
  const data   = []
  const simple = []
  const named  = () => {
    const m = x.attr(NAME_ATTR)
    return m < 0 ? null : x.attrText(m)
  }

  x.next()
  for (let e; (e = x.next()) !== EOF; ) {
    if (e !== START) continue
    const code = x.code(ELEMENTS)
    if (code === NAME || code === DESCRIPTION || code === STYLEURL) {
      base[code - NAME] = x.text()
      continue
    }
    if (code !== EXTENDED) {
      x.skip()
      continue
    }
    for (const d = x.depth; x.next() !== END || x.depth !== d; ) {
      if (x.kind !== START) continue
      const inner = x.code(ELEMENTS)
      const key   = inner === DATA || inner === SCHEMADATA ? named() : null
      if (inner === DATA) {
        let value = null
        for (const dd = x.depth; x.next() !== END || x.depth !== dd; )
          if (x.kind === START) x.code(ELEMENTS) === VALUE ? value = x.text() : x.skip()
        key === null || data.push([key, value])
      } else if (inner === SCHEMADATA) {
        for (const dd = x.depth; x.next() !== END || x.depth !== dd; ) {
          if (x.kind !== START) continue
          const field = x.code(ELEMENTS) === SIMPLEDATA ? named() : null
          field === null ? x.skip() : simple.push([field, x.text()])
        }
      } else x.skip()
    }
  }
  const present = BASE_KEYS.map((key, k) => [key, base[k]]).filter(([, value]) => value !== undefined)
  return Object.fromEntries([...present, ...data, ...simple])
}

const parseKml = (bytes, options, format) => {
  const { maxDepth, capacityHint, bounds } = xmlOptions(options, bytes, format)
  const x     = createXml(bytes, format, maxDepth)
  const t     = createTables('kml', { capacityHint, bounds })
  const stats = t.stats
  const out   = new Float64Array(2)
  const fail  = (code, at, hint = null) => { throw new FormatError(format, code, at, hint) }

  let context  = new Uint8Array(Math.min(maxDepth, 64) + 1)
  let layerAt  = new Int32Array(context.length)
  let topLayer = -1
  let feature  = -1
  let started  = 0
  let idFrom   = 0
  let idTo     = 0
  let coords   = 0
  let boundary = 0
  let ring     = 0

  // Tuplas `lon,lat[,alt]` separadas por espacio en blanco, sin espacio dentro de una tupla (§3.1).
  const tuples = mode => {
    coords++ && fail('estructura', x.tag0)
    x.gather()
    const b    = x.gBytes
    const stop = x.gTo
    const at   = k => b === bytes ? k : x.gAt
    let k = x.gFrom
    let n = 0
    for (;;) {
      while (k < stop && WS[b[k]]) k++
      if (k >= stop) return
      let ordinates = 0, lon = 0, lat = 0, alt = NaN
      for (;;) {
        const next = scanNumber(b, k, stop, DECIMAL_GRAMMAR, out)
        next === -1 && fail(k >= stop || WS[b[k]] || b[k] === 44 ? 'posicion' : 'numero', at(k))
        next === -2 && fail('numero', at(k))
        out[1] && stats.slowNumbers++
        ordinates === 0 ? lon = out[0] : ordinates === 1 ? lat = out[0] : ordinates === 2 && (alt = out[0])
        ordinates++
        k = next
        if (k < stop && b[k] === 44) {
          k++
          continue
        }
        k < stop && !WS[b[k]] && fail('numero', at(k))
        break
      }
      ordinates < 2 && fail('posicion', at(k))
      ordinates > 3 && stats.extraOrdinates++
      mode === M_POINT && n && fail('posicion', at(k))
      if (mode !== M_RING && !n) {
        t.part()
        t.ring()
      }
      t.vertex(lon, lat, alt)
      n++
    }
  }

  const foreign = () => {
    stats.foreignMembers++
    x.skip()
  }

  const geometry = (code, d) => {
    if (code === POINT || code === LINESTRING || code === LINEARRING || code === POLYGON) {
      t.geometry()
      context[d] = code === POINT ? C_POINT : code === POLYGON ? C_POLYGON : C_LINE
      coords     = 0
      boundary   = 0
    } else if (code === MULTI) context[d] = C_MULTI
    else if (code === MODEL || code === TRACK || code === MULTITRACK) {
      stats.skippedGeometries++
      x.skip()
    } else foreign()
  }

  x.next()
  const root = x.code(ELEMENTS)
  root === KML || fail('formato', x.tag0, root === GPX ? 'gpx' : null)
  context[1] = C_ROOT

  for (let e; (e = x.next()) !== EOF; ) {
    const d = x.depth
    if (e === END) {
      switch (context[d]) {
        case C_PLACEMARK : t.attributes(feature, started, x.tag1, idFrom, idTo); break
        case C_POINT     : t.close(1); break
        case C_LINE      : t.close(3); break
        case C_POLYGON   : t.close(5); break
        case C_OUTER     :
        case C_INNER     : ring || fail('estructura', x.tag0); break
      }
      continue
    }
    if (e !== START) continue
    if (context.length <= d) {
      const grown = new Uint8Array(context.length * 2)
      grown.set(context)
      context = grown
      const layers = new Int32Array(context.length)
      layers.set(layerAt)
      layerAt = layers
    }

    const code = x.code(ELEMENTS)
    switch (context[d - 1]) {
      case C_ROOT:
      case C_CONTAINER:
        if (code === DOCUMENT || code === FOLDER) {
          context[d] = C_CONTAINER
          layerAt[d] = t.layer(null, context[d - 1] === C_ROOT ? -1 : layerAt[d - 1])
        } else if (code === PLACEMARK) {
          const parent = context[d - 1] === C_CONTAINER ? layerAt[d - 1] : topLayer < 0 ? topLayer = t.layer(null, -1) : topLayer
          const m      = x.attr(ID_ATTR)
          context[d] = C_PLACEMARK
          feature    = t.feature(parent)
          started    = x.tag0
          idFrom     = m < 0 ? 0 : x.attrFrom(m)
          idTo       = m < 0 ? 0 : x.attrTo(m)
        } else if (code === NAME && context[d - 1] === C_CONTAINER) t.layerName(layerAt[d - 1], x.text())
        else foreign()
        break
      case C_PLACEMARK:
        code === NAME || code === DESCRIPTION || code === STYLEURL || code === EXTENDED ? x.skip() : geometry(code, d)
        break
      case C_MULTI:
        geometry(code, d)
        break
      case C_POINT:
      case C_LINE:
        code === COORDINATES ? tuples(context[d - 1] === C_POINT ? M_POINT : M_LINE) : foreign()
        break
      case C_POLYGON:
        // El exterior es el anillo 0 y va primero (07-147r2, `kml:Polygon`, § a verificar).
        if (code === OUTER) {
          boundary++ && fail('estructura', x.tag0)
          t.part()
          context[d] = C_OUTER
          ring       = 0
        } else if (code === INNER) {
          boundary || fail('estructura', x.tag0)
          context[d] = C_INNER
          ring       = 0
        } else foreign()
        break
      case C_OUTER:
      case C_INNER:
        if (code !== LINEARRING) foreign()
        else {
          ring++ && context[d - 1] === C_OUTER && fail('estructura', x.tag0)
          t.ring()
          context[d] = C_RING
          coords     = 0
        }
        break
      case C_RING:
        code === COORDINATES ? tuples(M_RING) : foreign()
        break
    }
  }

  const encoding = x.encoding
  return t.seal({
    crs        : 'EPSG:4326',
    source     : crsFromEpsg(WGS84),
    bytes,
    properties : placemarkProperties(encoding, maxDepth, format),
    id         : (b, from, to) => xmlText(b, from, to, encoding, format, ATTRIBUTE_MODE),
  })
}

export const readKml = (input, options = {}) => {
  const bytes = asBytes(input)
  if (bytes === null) throw new FormatError('kml', 'entrada')
  return parseKml(bytes, options, 'kml')
}

// KMZ: `doc.kml` en la raíz del zip y, si no está, la primera entrada `.kml` del directorio central
// (DISENO §3.1). Las posiciones de los errores son offsets dentro del KML inflado, que es `bytes`.
export const readKmz = async (input, options = {}) => {
  const bytes    = asBytes(input)
  const maxBytes = options.maxBytes ?? MAX_BYTES
  if (bytes === null || !Number.isInteger(maxBytes) || maxBytes < 1) throw new FormatError('kmz', 'entrada')

  const entries = listZip(bytes, 'kmz')
  const entry   = entries.find(e => e.name.toLowerCase() === 'doc.kml') ??
                  entries.find(e => e.name.toLowerCase().endsWith('.kml'))
  if (!entry) throw new FormatError('kmz', 'formato')
  return parseKml(await unzipEntry(bytes, entry, 'kmz', maxBytes), options, 'kmz')
}
