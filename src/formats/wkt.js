// Lector de WKT y EWKT: texto → las tablas CSR de `readGeoJson`, en una pasada y sin grafo.
// Gramática de OGC 06-103r4 §7 (§ a verificar) y el prefijo `SRID=n;` de PostGIS. Contrato en
// SPECS §19 (WKT).

import { FormatError }                 from './core/error.js'
import { asBytes, bomSkip }            from './core/input.js'
import { scanNumber, DECIMAL_GRAMMAR } from './core/number.js'
import { createTables }                from './core/tables.js'
import { crsFromEpsg, optionCrs }      from './core/crs.js'

const encoder = new TextEncoder()

const EMPTY = 8, Z = 9, M = 10, ZM = 11, SRID = 12

// TRIANGLE se lee como Polygon y TIN y POLYHEDRALSURFACE como MultiPolygon: comparten la gramática
// de lista de su equivalente. Una palabra fuera de la tabla, curvas de SQL/MM incluidas, es 'tipo'.
const WORDS = [
  ['point', 1], ['multipoint', 2], ['linestring', 3], ['multilinestring', 4], ['polygon', 5],
  ['multipolygon', 6], ['geometrycollection', 7], ['triangle', 5], ['tin', 6],
  ['polyhedralsurface', 6], ['empty', EMPTY], ['z', Z], ['m', M], ['zm', ZM], ['srid', SRID],
].map(([name, code]) => [encoder.encode(name), code])

// Niveles de paréntesis hasta la posición, y qué abre cada nivel: 1 = parte, 2 = anillo (§17.1).
// MultiPoint (2) tiene su propia gramática: el punto puede venir con o sin paréntesis.
const TOP  = new Uint8Array([0, 1, 0, 1, 2, 2, 3])
const OPEN = new Uint8Array([
  0, 0, 0, 0,
  0, 3, 0, 0,     // Point
  0, 0, 0, 0,
  0, 3, 0, 0,     // LineString
  0, 3, 0, 0,     // MultiLineString: cada línea es su parte
  0, 2, 1, 0,     // Polygon: una parte, un anillo por lista interior
  0, 2, 1, 0,     // MultiPolygon: una parte por polígono
])

const isLetter = c => ((c | 32) >= 97 && (c | 32) <= 122)
const isSpace  = c => c === 32 || c === 9 || c === 10 || c === 13

// El CRS de la fuente para el sellado (§2.5): el SRID declarado gana y, si no hay, manda `options.crs`
// (§1.5). Sin ninguno sale null y el sellado valida el rango geográfico.
export const sourceCrs = (format, epsg, at, option) => {
  const source = epsg > 0 ? crsFromEpsg(epsg) : optionCrs(option, format)
  if (epsg > 0 && source === null) throw new FormatError(format, 'crs', at, null, `SRID=${epsg}`)
  return { crs: source?.name ?? null, source }
}

const none = () => null

export const readWkt = (input, options = {}) => {
  const bytes = asBytes(input)
  if (bytes === null) throw new FormatError('wkt', 'entrada')

  const maxDepth = options.maxDepth ?? 512
  if (!Number.isInteger(maxDepth) || maxDepth < 1) throw new FormatError('wkt', 'entrada')

  const len    = bytes.length
  const fail   = (code, at, hint = null) => { throw new FormatError('wkt', code, at, hint) }
  const tables = createTables('wkt', { capacityHint: options.capacityHint, bounds: options.bounds })
  const stats  = tables.stats
  const out    = new Float64Array(2)
  const pos    = new Float64Array(4)
  let mods     = new Uint8Array(16)
  let i        = bomSkip(bytes)
  let kind     = 0, mod = 0, dims = 0

  const skip = () => { while (i < len && isSpace(bytes[i])) i++ }

  const letters = from => {
    let to = from
    while (to < len && isLetter(bytes[to])) to++
    return to
  }

  const word = (from, to) => {
    const n = to - from
    for (const [want, code] of WORDS) {
      if (want.length !== n) continue
      let k = n
      while (k-- && (bytes[from + k] | 32) === want[k]);
      if (k < 0) return code
    }
    return 0
  }

  const expect = c => {
    skip()
    i >= len && fail('truncado', len)
    bytes[i] === c || fail('sintaxis', i)
    i++
  }

  const comma = () => {
    skip()
    if (i >= len || bytes[i] !== 44) return false
    i++
    return true
  }

  const empty = () => {
    skip()
    const to = letters(i)
    if (to === i || word(i, to) !== EMPTY) return false
    i = to
    return true
  }

  // `NaN`, `inf` o `infinity`, con signo: el número existe pero no es finito (§1.6-4).
  const nonFinite = at => {
    const k = bytes[at] === 43 || bytes[at] === 45 ? at + 1 : at
    const a = bytes[k] | 32, b = bytes[k + 1] | 32, c = bytes[k + 2] | 32
    return (a === 110 && b === 97 && c === 110) || (a === 105 && b === 110 && c === 102)
  }

  // Tipo y modificador. PostGIS escribe la M pegada (`POINTM`): se acepta el sufijo z, m o zm.
  const header = inherited => {
    skip()
    const at = i, to = letters(i)
    to === at && fail(i >= len ? 'truncado' : 'sintaxis', at)

    let k = word(at, to), m = 0
    if (!k || k > 7) {
      const zm = to - at > 2 && (bytes[to - 2] | 32) === 122 && (bytes[to - 1] | 32) === 109
      const cut = zm ? 2 : 1
      k = word(at, to - cut)
      m = zm ? 3 : (bytes[to - 1] | 32) === 122 ? 1 : (bytes[to - 1] | 32) === 109 ? 2 : 0
      ;(k < 1 || k > 7 || !m) && fail('tipo', at)
    }
    i = to
    skip()
    const mt = letters(i), w = mt > i ? word(i, mt) : 0
    if (!m && w >= Z && w <= ZM) {
      m = w - Z + 1
      i = mt
    }
    inherited && m && m !== inherited && fail('posicion', at)
    kind = k
    mod  = m || inherited
    dims = mod === 3 ? 4 : mod ? 3 : 0
    return at
  }

  // Sin modificador, la primera posición fija la dimensión de la geometría: 3 números es el Z de
  // PostGIS y 4 es ZM. La M siempre se descarta y se cuenta (D-3).
  const position = () => {
    skip()
    const start = i
    let n = 0
    for (;;) {
      skip()
      const at = i, j = scanNumber(bytes, i, len, DECIMAL_GRAMMAR, out)
      ;(j === -2 || (j === -1 && i < len && nonFinite(at))) && fail('numero', at)
      if (j < 0) break
      out[1] && stats.slowNumbers++
      n < 4 && (pos[n] = out[0])
      n++
      i = j
      i < len && !isSpace(bytes[i]) && bytes[i] !== 44 && bytes[i] !== 41 && fail('sintaxis', i)
    }
    n || fail(i >= len ? 'truncado' : 'sintaxis', i)
    dims ||= n
    ;(n < 2 || n > 4 || n !== dims) && fail('posicion', start)

    const hasZ = mod === 1 || mod === 3 || (!mod && n > 2)
    ;(mod >= 2 || n === 4) && stats.extraOrdinates++
    tables.vertex(pos[0], pos[1], hasZ ? pos[2] : NaN)
  }

  // Un contenedor vacío por debajo del tope ocupa su ranura (§17.3-14): `POLYGON (EMPTY)` es una
  // parte con un anillo de 0 vértices, y `POLYGON EMPTY` es una geometría de 0 partes.
  const list = level => {
    const opens = OPEN[kind * 4 + level]
    if (empty()) {
      if (level === TOP[kind]) return
      opens & 1 && tables.part()
      opens & 2 && tables.ring()
      return
    }
    expect(40)
    opens & 1 && tables.part()
    opens & 2 && tables.ring()
    do level > 1 ? list(level - 1) : position()
    while (kind !== 1 && comma())
    expect(41)
  }

  // Un punto vacío no aporta vértice: la parte se abre con el primero que existe, así que
  // `MULTIPOINT (EMPTY)` sale como `MULTIPOINT EMPTY`, igual que en GeoJSON.
  const multiPoint = () => {
    if (empty()) return
    expect(40)
    let opened = false
    do {
      if (empty()) continue
      if (!opened) {
        tables.part()
        tables.ring()
        opened = true
      }
      skip()
      const paren = i < len && bytes[i] === 40
      paren && i++
      position()
      paren && expect(41)
    } while (comma())
    expect(41)
  }

  let roots = 0, srid = -1, sridAt = -1
  for (;;) {
    skip()
    if (roots && i < len && bytes[i] === 59) {
      i++
      skip()
    }
    if (i >= len) break

    const at = i
    if (!isLetter(bytes[at]))
      fail(roots ? 'sintaxis' : 'formato', at, roots || bytes[at] > 1 && bytes[at] !== 48 ? null : 'wkb')

    let s = -1
    const to = letters(at)
    if (word(at, to) === SRID) {
      i = to
      expect(61)
      skip()
      const d = i
      s = 0
      while (i < len && bytes[i] >= 48 && bytes[i] <= 57 && s < 1e9) s = s * 10 + bytes[i++] - 48
      i === d && fail(i >= len ? 'truncado' : 'sintaxis', i)
      expect(59)
      s ||= -1                // SRID=0 es «desconocido» en PostGIS: equivale a no declararlo
    }
    if (!roots) {
      srid   = s
      sridAt = at
    } else s !== srid && fail('crs', at)

    tables.feature()
    let sp = 0
    for (;;) {
      const gat = header(sp ? mods[sp - 1] : 0)
      if (kind === 7) {
        if (!empty()) {
          expect(40)
          sp + 2 > maxDepth && fail('profundidad', gat)
          if (sp === mods.length) {
            const next = new Uint8Array(sp * 2)
            next.set(mods)
            mods = next
          }
          mods[sp++] = mod
          continue
        }
      } else {
        tables.geometry()
        kind === 2 ? multiPoint() : list(TOP[kind])
        tables.close(kind)
      }
      while (sp && !comma()) {
        expect(41)
        sp--
      }
      if (!sp) break
    }
    roots++
  }

  roots || fail('sintaxis', 0)
  stats.roots = roots

  return tables.seal({
    ...sourceCrs('wkt', srid, sridAt, options.crs),
    bytes, properties: none, id: none,
  })
}
