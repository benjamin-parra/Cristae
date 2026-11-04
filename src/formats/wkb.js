// Lector de WKB y EWKB: bytes (o su hex) → las tablas CSR de `readGeoJson`, en una pasada y sin
// grafo. Codificación de OGC 06-103r4 §8.2 (códigos de tipo en 8.2.3, estructura en 8.2.8) y las banderas de EWKB de PostGIS.
// Contrato en SPECS §19 (WKB).

import { FormatError }       from './core/error.js'
import { asBytes, hexBytes } from './core/input.js'
import { createTables }      from './core/tables.js'
import { sourceCrs }         from './wkt.js'

// Tipo base → kind (§17.1); 7 es GeometryCollection, que se aplana. Triangle (17) se lee como
// Polygon y PolyhedralSurface (15) y TIN (16) como MultiPolygon. El 0 es 'tipo': curvas de SQL/MM
// (8 a 14) y lo desconocido.
const KIND  = new Uint8Array([0, 1, 3, 5, 2, 4, 6, 7, 0, 0, 0, 0, 0, 0, 0, 6, 6, 5])
// Tipo base que exige cada hijo de un contenedor homogéneo.
const CHILD = new Uint8Array([0, 0, 0, 0, 1, 2, 3, 0, 0, 0, 0, 0, 0, 0, 0, 3, 17, 0])

// Lo mínimo que ocupa una geometría: orden, tipo y un conteo en cero. Acota los conteos de
// geometrías antes de iterarlos (§1.6-1).
const MIN_GEOMETRY = 9

const none = () => null

export const readWkb = (input, options = {}) => {
  const bytes = typeof input === 'string' ? hexBytes(input, 'wkb') : asBytes(input)
  if (bytes === null) throw new FormatError('wkb', 'entrada')

  const maxDepth = options.maxDepth ?? 512
  if (!Number.isInteger(maxDepth) || maxDepth < 1) throw new FormatError('wkb', 'entrada')

  const len    = bytes.length
  const view   = new DataView(bytes.buffer, bytes.byteOffset, len)
  const fail   = (code, at, hint = null) => { throw new FormatError('wkb', code, at, hint) }
  const tables = createTables('wkb', { capacityHint: options.capacityHint, bounds: options.bounds })
  const stats  = tables.stats
  let counts   = new Uint32Array(16)
  let i        = 0, le = true, hasZ = false, hasM = false, srid = -1, sridAt = -1

  // §1.6-1 y §1.6-2: toda cuenta se prueba contra lo que queda antes de leer o de iterar.
  const need = n => len - i < n && fail('truncado', i)

  const u32 = () => {
    need(4)
    const v = view.getUint32(i, le)
    i += 4
    return v
  }

  const stride = () => 16 + (hasZ ? 8 : 0) + (hasM ? 8 : 0)

  // Cada geometría trae su byte de orden, y un hijo puede diferir del padre. Las banderas de EWKB y
  // los miles de ISO se aceptan juntos; el SRID puede venir en cualquier nivel y debe ser uno solo.
  const header = () => {
    const at = i
    need(5)
    const order = bytes[i]
    if (order > 1) {
      const c = order | 32
      fail(at ? 'estructura' : 'formato', at, !at && c >= 97 && c <= 122 ? 'wkt' : null)
    }
    le = order === 1
    i++
    const type  = u32()
    const code  = type & 0x1fffffff
    const base  = code % 1000, th = (code - base) / 1000
    th > 3 && fail('tipo', at)
    hasZ = (type & 0x80000000) !== 0 || th === 1 || th === 3
    hasM = (type & 0x40000000) !== 0 || th >= 2
    if (type & 0x20000000) {
      const s = u32() || -1      // 0 es «desconocido» en PostGIS
      if (sridAt < 0) {
        srid   = s
        sridAt = at
      } else s !== srid && fail('crs', at)
    }
    return base
  }

  // Un no finito es 'numero' (§1.6-4). La M se descarta sin mirarla (D-3).
  const vertex = () => {
    const at = i
    const x  = view.getFloat64(i, le), y = view.getFloat64(i + 8, le)
    const z  = hasZ ? view.getFloat64(i + 16, le) : NaN
    i += stride()
    hasM && stats.extraOrdinates++
    Number.isFinite(x) && Number.isFinite(y) && (!hasZ || Number.isFinite(z)) || fail('numero', at)
    tables.vertex(x, y, z)
  }

  const points = n => {
    need(n * stride())
    while (n--) vertex()
  }

  const open = () => {
    tables.part()
    tables.ring()
  }

  // `POINT EMPTY` es x e y en NaN [inf.: convención de PostGIS y GEOS, no de 06-103r4].
  const emptyPoint = () => {
    need(stride())
    const empty = Number.isNaN(view.getFloat64(i, le)) && Number.isNaN(view.getFloat64(i + 8, le))
    empty && (i += stride())
    return empty
  }

  // Suelta, una línea o un polígono sin elementos es una geometría de 0 partes; como hijo de un
  // contenedor ocupa su ranura (§17.3-14), igual que `MULTILINESTRING (EMPTY)` en WKT.
  const line = slot => {
    const n = u32()
    ;(n || slot) && open()
    points(n)
  }

  const polygon = slot => {
    const rings = u32()
    need(rings * 4)
    ;(rings || slot) && tables.part()
    for (let r = 0; r < rings; r++) {
      tables.ring()
      points(u32())
    }
  }

  // Un punto vacío no aporta vértice: la parte se abre con el primero que existe, como en WKT.
  const multi = base => {
    const n = u32()
    need(n * MIN_GEOMETRY)
    let opened = false
    for (let k = 0; k < n; k++) {
      const at = i
      header() === CHILD[base] || fail('estructura', at)
      if (base === 4) {
        if (emptyPoint()) continue
        opened || open()
        opened = true
        vertex()
      } else base === 5 ? line(true) : polygon(true)
    }
  }

  tables.feature()
  let sp = 0
  for (;;) {
    const at   = i
    const base = header()
    const kind = base < KIND.length ? KIND[base] : 0
    kind || fail('tipo', at)

    if (kind === 7) {
      const n = u32()
      need(n * MIN_GEOMETRY)
      if (n) {
        sp + 2 > maxDepth && fail('profundidad', at)
        if (sp === counts.length) {
          const next = new Uint32Array(sp * 2)
          next.set(counts)
          counts = next
        }
        counts[sp++] = n
        continue
      }
    } else {
      tables.geometry()
      if (base === 1) {
        if (!emptyPoint()) {
          open()
          vertex()
        }
      } else if (base === 2) line(false)
      else if (kind === 5) polygon(false)
      else multi(base)
      tables.close(kind)
    }

    while (sp && --counts[sp - 1] === 0) sp--
    if (!sp) break
  }

  // Un WKB es una geometría, no una secuencia.
  i < len && fail('estructura', i)
  stats.roots = 1

  return tables.seal({
    source: sourceCrs('wkb', srid, sridAt, options.crs),
    bytes, properties: none, id: none,
  })
}
