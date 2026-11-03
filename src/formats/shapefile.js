// Lector de Shapefile: registros del `.shp` → las tablas de `readGeoJson`, en una pasada y sin grafo.
// Referencia: ESRI Shapefile Technical Description, julio 1998. Contrato en SPECS §19.
import { FormatError } from './core/error.js'
import { asBytes } from './core/input.js'
import { createTables, CW } from './core/tables.js'
import { crsFromWkt, optionCrs } from './core/crs.js'
import { listZip, unzipEntry } from './core/zip.js'
import { openDbf } from './dbf.js'

const FORMAT = 'shapefile'
const EMPTY  = new Uint8Array(0)

const fail = (code, at = -1, detail = null) => { throw new FormatError(FORMAT, code, at, null, detail) }

// Tabla de tipos de forma: familia (1 punto, 3 polilínea, 5 polígono, 8 multipunto, 31 multiparche)
// y si la variante trae Z (11-18) o sólo M (21-28).
const FAMILY = new Map([[0, 0], [1, 1], [3, 3], [5, 5], [8, 8], [11, 1], [13, 3], [15, 5], [18, 8],
  [21, 1], [23, 3], [25, 5], [28, 8], [31, 31]])

// Lee el `.shp` con su `.dbf`, `.prj` y `.cpg` opcionales. Sin `.shx`: se recorre en orden.
export const readShapefile = (files, options = {}) => {
  const optional = input => input === undefined || input === null ? null : asBytes(input) ?? fail('entrada')

  const shp = asBytes(files?.shp) ?? fail('entrada')
  const dbf = optional(files.dbf)
  const prj = optional(files.prj)
  const cpg = optional(files.cpg)

  const len = shp.length
  len < 100 && fail('truncado', len)
  const view = new DataView(shp.buffer, shp.byteOffset, len)
  view.getInt32(0) === 9994 || fail('formato', 0)
  view.getInt32(28, true) === 1000 || fail('version', 28)
  // El largo de archivo está en palabras de 16 bits. Lo que sigue al largo declarado no es del archivo.
  const declared = view.getInt32(24) * 2
  declared < 100 && fail('estructura', 24)
  declared > len && fail('truncado', len)
  const type = view.getInt32(32, true)
  FAMILY.has(type) || fail('tipo', 32)

  const family = FAMILY.get(type)
  const hasZ   = type > 10 && type < 20
  const hasM   = type > 20 && type < 30
  const t      = createTables(FORMAT, { capacityHint: options.capacityHint, bounds: options.bounds, orientation: CW })
  const stats  = t.stats

  const vertex = (at, z) => {
    const x = view.getFloat64(at, true), y = view.getFloat64(at + 8, true)
    const h = z < 0 ? NaN : view.getFloat64(z, true)
    Number.isFinite(x) && Number.isFinite(y) && (z < 0 || Number.isFinite(h)) || fail('numero', at)
    t.vertex(x, y, h)
  }

  // El contenido es tipo, cabecera de la familia, partes y puntos; la Z es obligatoria en su variante
  // y el bloque de M, opcional en las variantes Z y M: lo dice el largo del registro.
  const shape = (from, size) => {
    const kind = view.getInt32(from, true)
    if (kind === 0) return
    kind === type || fail('estructura', from)
    if (family === 31) return stats.skippedGeometries++

    const head = family === 1 ? 4 : family === 8 ? 40 : 44
    size < head && fail('truncado', from)
    const parts = family === 3 || family === 5 ? view.getInt32(from + 36, true) : 0
    const count = family === 1 ? 1 : view.getInt32(from + head - 4, true)
    parts < 0 || count < 0 ? fail('estructura', from + 36)
      : 4 * parts + 16 * count > size - head && fail('truncado', from)

    const points = from + head + 4 * parts
    const base   = head + 4 * parts + 16 * count
    const range  = family === 1 ? 0 : 16
    const min    = base + (hasZ ? range + 8 * count : 0)
    const withM  = min + range + 8 * count
    size < min && fail('truncado', from)
    size === min || (hasZ || hasM) && size === withM || fail('estructura', from)
    size === withM && (stats.extraOrdinates += count)
    const z    = hasZ ? points + 16 * count + range : -1
    const emit = k => vertex(points + 16 * k, z < 0 ? -1 : z + 8 * k)

    t.geometry()
    if (family === 1 || family === 8) {
      if (count) {
        t.part()
        t.ring()
        for (let k = 0; k < count; k++) emit(k)
      }
      return t.close(family === 1 ? 1 : 2)
    }

    // Parts[] debe abrir en 0, no decrecer y quedar bajo NumPoints: un índice que miente corre los
    // anillos sobre vértices ajenos.
    parts === 0 && count > 0 && fail('estructura', from + 36)
    for (let p = 0, prev = 0; p < parts; p++) {
      const start = view.getInt32(from + 44 + 4 * p, true)
      ;(start < prev || start >= count || p === 0 && start !== 0) && fail('estructura', from + 44 + 4 * p)
      prev = start
    }
    if (!parts) return t.close(family === 5 ? 5 : 3)

    family === 5 && t.part()
    for (let p = 0; p < parts; p++) {
      const end = p + 1 < parts ? view.getInt32(from + 48 + 4 * p, true) : count
      family === 3 && t.part()
      t.ring()
      for (let k = view.getInt32(from + 44 + 4 * p, true); k < end; k++) emit(k)
    }
    return family === 5 ? t.closeRings() : t.close(parts === 1 ? 3 : 4)
  }

  let at = 100, records = 0
  while (at < declared) {
    at + 8 > declared && fail('truncado', at)
    const size = view.getInt32(at + 4) * 2
    size < 4 && fail('estructura', at + 4)
    at + 8 + size > declared && fail('truncado', at + 4)
    t.feature()
    shape(at + 8, size)
    at += 8 + size
    records++
  }

  const text  = bytes => new TextDecoder().decode(bytes).trim()
  const table = dbf && openDbf(dbf, options.encoding ?? (cpg && cpgLabel(text(cpg))), stats)
  table && table.records !== records && fail('estructura', 4, `${records} registros en el .shp y ${table.records} en el .dbf`)
  for (let r = 0; table && r < records; r++) t.attributes(r, table.at(r), table.at(r) + table.size)

  // Sin `.prj` manda `options.crs` (§1.5): código EPSG, `'EPSG:n'` o WKT1.
  const source = prj ? crsFromWkt(prj) ?? fail('crs', 0, text(prj)) : optionCrs(options.crs, FORMAT)
  return t.seal({
    crs        : source?.name ?? null,
    source,
    bytes      : dbf ?? EMPTY,
    properties : table ? table.properties : () => null,
    id         : () => null,
  })
}

// El `.cpg` trae una etiqueta de codificación o un número de página de códigos de Windows.
const cpgLabel = label =>
  label === '65001'        ? 'utf-8'
  : /^125\d$/.test(label)  ? `windows-${label}`
  : /^2859\d$/.test(label) ? `iso-8859-${label.slice(4)}`
  : label === ''           ? null
  : label

// Shapefile dentro de un zip: el `.shp` elegido y sus hermanos por nombre base, sin distinguir
// mayúsculas en la extensión. La suma de lo inflado va contra `maxBytes` (§2.7).
export const readShapefileZip = async (input, options = {}) => {
  const bytes   = asBytes(input) ?? fail('entrada')
  let budget    = options.maxBytes ?? 268435456
  Number.isInteger(budget) && budget >= 1 || fail('entrada')
  const entries = listZip(bytes, FORMAT)
  const stem    = name => name.replace(/\.[^./]*$/, '')
  const ext     = name => /\.([^./]*)$/.exec(name)?.[1].toLowerCase()
  const shps    = entries.filter(entry => ext(entry.name) === 'shp')
  const chosen  = options.layer === undefined ? shps : shps.filter(entry => stem(entry.name) === options.layer)
  chosen.length === 1 || fail('formato', -1, `capas: ${shps.map(entry => stem(entry.name)).join(', ') || 'ninguna'}`)

  const base = stem(chosen[0].name)

  const inflate = async kind => {
    const entry = entries.find(entry => stem(entry.name) === base && ext(entry.name) === kind)
    if (!entry) return undefined
    const out = await unzipEntry(bytes, entry, FORMAT, budget)
    budget -= out.length
    return out
  }
  const shp = await inflate('shp')
  const dbf = await inflate('dbf')
  const prj = await inflate('prj')
  const cpg = await inflate('cpg')
  return readShapefile({ shp, dbf, prj, cpg }, options)
}
