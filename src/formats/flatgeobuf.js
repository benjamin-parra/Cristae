// Lector de FlatGeobuf 3: cabecera y features en FlatBuffers → las tablas de `readGeoJson`, en lectura
// secuencial y sin grafo. Referencia: flatgeobuf.org, esquemas `header.fbs` y `feature.fbs`
// (índices de campo verificados contra flatgeobuf/flatgeobuf, D-11). Contrato en SPECS §19.
import { FormatError } from './core/error.js'
import { asBytes } from './core/input.js'
import { createTables } from './core/tables.js'
import { crsFromEpsg, crsFromWkt, optionCrs } from './core/crs.js'

const FORMAT = 'flatgeobuf'
const NODE   = 40                  // nodo del R-tree: caja de 4 doubles + offset uint64

// GeometryType → kind de §17.1. 7 es GeometryCollection, que se aplana; 8-17 son curvas,
// superficies, TIN y Triangle, fuera del subconjunto.
const KIND = new Uint8Array([0, 1, 3, 5, 2, 4, 6])

// ColumnType: Byte, UByte, Bool, Short, UShort, Int, UInt, Long, ULong, Float, Double; desde 11
// (String, Json, DateTime, Binary) el valor lleva un prefijo de largo uint32.
const SIZE = new Uint8Array([1, 1, 1, 2, 2, 4, 4, 8, 8, 4, 8, 4, 4, 4, 4])

// Los enteros de 64 bits salen como `number` si caben exactos y si no como `bigint` (D-17).
const long   = v => Number.isSafeInteger(Number(v)) ? Number(v) : v
const SCALAR = [
  (v, p) => v.getInt8(p),
  (v, p) => v.getUint8(p),
  (v, p) => v.getUint8(p) !== 0,
  (v, p) => v.getInt16(p, true),
  (v, p) => v.getUint16(p, true),
  (v, p) => v.getInt32(p, true),
  (v, p) => v.getUint32(p, true),
  (v, p) => long(v.getBigInt64(p, true)),
  (v, p) => long(v.getBigUint64(p, true)),
  (v, p) => v.getFloat32(p, true),
  (v, p) => v.getFloat64(p, true),
]

const fail = (code, at = -1, detail = null) => { throw new FormatError(FORMAT, code, at, null, detail) }

export const readFlatGeobuf = (input, options = {}) => {
  const bytes    = asBytes(input) ?? fail('entrada')
  const maxDepth = options.maxDepth ?? 512
  Number.isInteger(maxDepth) && maxDepth >= 1 || fail('entrada')
  const len      = bytes.length
  len < 12 && fail('truncado', len)
  bytes[0] === 0x66 && bytes[1] === 0x67 && bytes[2] === 0x62 && bytes[4] === 0x66 && bytes[5] === 0x67
    && bytes[6] === 0x62 || fail('formato', 0)
  bytes[3] === 3 || fail('version', 3)

  // FlatBuffers mínimo: tablas por vtable, escalares, vectores y strings. Toda lectura se valida contra
  // el buffer en curso, [lo, hi): la cabecera o el feature (§1.6-2).
  const view = new DataView(bytes.buffer, bytes.byteOffset, len)
  const utf8 = new TextDecoder('utf-8', { fatal: true })
  let lo = 0, hi = 0
  const check  = (p, n) => p >= lo && p + n <= hi ? p : fail('estructura', p)
  const u32    = p => view.getUint32(check(p, 4), true)
  const ref    = p => p + u32(p)
  const slot   = (t, i) => {
    const vt = t - view.getInt32(check(t, 4), true), size = view.getUint16(check(vt, 4), true)
    const at = 4 + 2 * i
    return at + 2 <= size ? (off => off && t + off)(view.getUint16(check(vt + at, 2), true)) : 0
  }
  const vector = (t, i, size) => {
    const p = slot(t, i)
    if (!p) return -1
    const at = ref(p)
    check(at + 4, u32(at) * size)
    return at + 4
  }
  const count  = start => view.getUint32(start - 4, true)
  const byte   = (t, i, fallback) => (p => p ? bytes[check(p, 1)] : fallback)(slot(t, i))
  const string = (t, i) => {
    const p = vector(t, i, 1)
    if (p < 0) return null
    try { return utf8.decode(bytes.subarray(p, p + count(p))) }
    catch { return fail('codificacion', p) }
  }

  const headerSize = view.getUint32(8, true)
  12 + headerSize > len && fail('truncado', len)
  lo = 12
  hi = 12 + headerSize
  const header = ref(12)

  const type = byte(header, 2, 0)
  type > 17 && fail('tipo', header)
  const columns = vector(header, 7, 4)
  const names   = []
  const types   = []
  for (let c = 0, n = columns < 0 ? 0 : count(columns); c < n; c++) {
    const column = ref(columns + 4 * c)
    names.push(string(column, 0) ?? fail('estructura', column))
    types.push(byte(column, 1, 0))
    types[c] > 14 && fail('tipo', column)
  }
  const total = (p => p ? Number(view.getBigUint64(check(p, 8), true)) : 0)(slot(header, 8))
  const nodes = (p => p ? view.getUint16(check(p, 2), true) : 16)(slot(header, 9))

  // `Header.crs`: org + code, o el WKT si no hay código. Un `crs` sin ninguno de los dos es no declarado.
  const declared = (crs => {
    if (!crs) return null
    const org  = string(crs, 0)
    const code = (p => p ? view.getInt32(check(p, 4), true) : 0)(slot(crs, 1))
    const wkt  = vector(crs, 4, 1)
    const id   = string(crs, 5)
    const epsg = org === null || /^epsg$/i.test(org)
    return code && epsg ? crsFromEpsg(code) ?? fail('crs', crs, `${org ?? 'EPSG'}:${code}`)
      : /^ogc$/i.test(org ?? '') && id === 'CRS84' ? crsFromEpsg(4326)
      : wkt >= 0 ? crsFromWkt(bytes, wkt, wkt + count(wkt)) ?? fail('crs', wkt, string(crs, 4))
      : code || id ? fail('crs', crs, `${org}:${id ?? code}`)
      : null
  })((p => p && ref(p))(slot(header, 10)))
  const source = declared ?? optionCrs(options.crs, FORMAT)

  // El índice se salta: nodos de 40 bytes por nivel del árbol empaquetado de `total` hojas. Sin conteo
  // o con `index_node_size` 0 no hay índice; 1 no forma árbol. La raíz se suma aunque haya una sola
  // hoja, como el `calcTreeSize` de la referencia [inf.].
  let pos = hi
  if (total && nodes) {
    nodes === 1 && fail('estructura', header)
    total * NODE > len - pos && fail('truncado', len)
    let n = total, size = total
    do size += n = Math.ceil(n / nodes)
    while (n !== 1)
    pos += size * NODE
    pos > len && fail('truncado', len)
  }

  const t        = createTables(FORMAT, { capacityHint: options.capacityHint, bounds: options.bounds })
  const stats    = t.stats
  let budget = 0, visits = 0

  const vertex = (xy, z, k) => {
    const x = view.getFloat64(xy + 16 * k, true), y = view.getFloat64(xy + 16 * k + 8, true)
    const h = z < 0 ? NaN : view.getFloat64(z + 8 * k, true)
    Number.isFinite(x) && Number.isFinite(y) && (z < 0 || Number.isFinite(h)) || fail('numero', xy + 16 * k)
    t.vertex(x, y, h)
  }

  // Los vértices de una tabla `Geometry`. `mode` 0: un solo anillo, sin mirar `ends` (Point,
  // LineString, MultiPoint); 1: anillos partidos por `ends` en una parte, que `open` abre aunque no
  // haya vértices (polígono); 2: una parte por anillo (MultiLineString). Devuelve los vértices.
  const rings = (g, mode, open) => {
    const xy = vector(g, 1, 8), n = xy < 0 ? 0 : count(xy)
    n & 1 && fail('estructura', xy)
    const vertices = n / 2
    ;(budget -= vertices) < 0 && fail('estructura', g)
    const z = vector(g, 2, 8), m = vector(g, 3, 8)
    z < 0 || count(z) === vertices || fail('estructura', z)
    m < 0 || count(m) === vertices || fail('estructura', m)
    m < 0 || (stats.extraOrdinates += vertices)

    const ends = mode ? vector(g, 0, 4) : -1, last = ends < 0 ? vertices && 1 : count(ends)
    ;(open || last && mode < 2) && t.part()
    let k = 0
    for (let r = 0; r < last; r++) {
      const stop = ends < 0 ? vertices : u32(ends + 4 * r)
      ;(stop < k || stop > vertices) && fail('estructura', ends + 4 * r)
      mode === 2 && t.part()
      t.ring()
      for (; k < stop; k++) vertex(xy, z, k)
    }
    k === vertices || fail('estructura', g)
    return vertices
  }

  // Una tabla `Geometry`. `kind` 0 = la propia de la tabla. Las partes de un MultiPolygon son
  // polígonos implícitos; las de una GeometryCollection traen su tipo y se aplanan en profundidad.
  const geometry = (g, kind, depth) => {
    depth > maxDepth && fail('profundidad', g)
    // Dos entradas de `parts` pueden apuntar a la misma tabla: cada visita honesta cuesta al menos
    // los 4 bytes de su offset (§1.6-3).
    ;(visits -= 4) < 0 && fail('estructura', g)
    kind ||= byte(g, 6, 0)
    kind || fail('tipo', g)
    kind > 17 && fail('tipo', g)
    if (kind > 7) return stats.skippedGeometries++

    const parts = kind > 5 ? vector(g, 7, 4) : -1
    const n     = parts < 0 ? 0 : count(parts)
    if (kind === 7) {
      for (let p = 0; p < n; p++) geometry(ref(parts + 4 * p), 0, depth + 1)
      return
    }
    t.geometry()
    if (kind === 6) {
      for (let p = 0; p < n; p++) {
        const part = ref(parts + 4 * p)
        depth + 1 > maxDepth && fail('profundidad', part)
        ;(visits -= 4) < 0 && fail('estructura', part)
        rings(part, 1, true)
      }
    }
    else rings(g, kind === 3 ? 1 : kind === 5 ? 2 : 0, false) > 1 && kind === 1 && fail('estructura', g)
    t.close(KIND[kind])
  }

  let read = 0
  while (total ? read < total : pos < len) {
    pos + 4 > len && fail('truncado', pos)
    const size = view.getUint32(pos, true)
    lo = pos + 4
    hi = lo + size
    hi > len && fail('truncado', pos)
    budget = size / 16
    visits = size

    const f       = t.feature()
    const feature = ref(lo)
    const shape   = slot(feature, 0)
    const props   = vector(feature, 1, 1)
    slot(feature, 2) && stats.foreignMembers++
    props < 0 || t.attributes(f, props, props + count(props))
    // `maxDepth` es opción pública: con una cota alta la pila se agota antes que la cota, y eso es
    // 'profundidad', no un RangeError crudo (§1.5), como en TopoJSON.
    try { shape && geometry(ref(shape), type, 0) }
    catch (e) { if (e instanceof RangeError) fail('profundidad', shape); throw e }
    pos = hi
    read++
  }
  pos < len && fail('estructura', pos)

  // Propiedades: pares (uint16 columna, valor) según `Header.columns`. Lanza si el vector miente; el
  // sellado lo convierte en FormatError('properties').
  const properties = (data, from, to) => {
    const values = new DataView(data.buffer, data.byteOffset, data.length)
    const out    = []
    const need   = (p, n) => p + n <= to || fail('properties', p)
    for (let p = from; p < to;) {
      need(p, 2)
      const c = values.getUint16(p, true)
      c < names.length || fail('properties', p)
      const kind = types[c]
      p += 2
      need(p, SIZE[kind])
      if (kind < 11) {
        out.push([names[c], SCALAR[kind](values, p)])
        p += SIZE[kind]
        continue
      }
      const length = values.getUint32(p, true)
      p += 4
      need(p, length)
      out.push([names[c], kind === 14 ? data.slice(p, p + length) : utf8.decode(data.subarray(p, p + length))])
      p += length
    }
    // `fromEntries` y no asignación: una columna `__proto__` es una clave, no el prototipo. Una columna
    // repetida gana la última, como antes.
    return Object.fromEntries(out)
  }

  return t.seal({ source, bytes, properties, id: () => null })
}
