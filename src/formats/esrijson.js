// Lector de EsriJSON (DISENO-INTEROP §3.6): un FeatureSet, un feature o una geometría de la API REST de
// ArcGIS → las tablas CSR de `readGeoJson`. Qué es la tercera ordenada lo dicen `hasZ` y `hasM`, que
// pueden llegar después de las coordenadas: la primera fase guarda hasta cuatro ordenadas por posición
// y anota un programa de emisión, y la segunda decide y emite.

import { FormatError } from './core/error.js'
import { asBytes, bomSkip } from './core/input.js'
import { createTables, CW } from './core/tables.js'
import { crsFromEpsg, crsFromWkt, optionCrs } from './core/crs.js'
import { createScanner, digit, grown, limits, names } from './json-scan.js'

const FORMAT = 'esrijson'

const K_FEATURES = 1, K_GEOMETRY = 2, K_ATTRIBUTES = 3, K_X = 4, K_Y = 5, K_Z = 6, K_M = 7,
      K_POINTS = 8, K_PATHS = 9, K_RINGS = 10, K_XMIN = 11, K_YMIN = 12, K_XMAX = 13, K_YMAX = 14,
      K_HASZ = 15, K_HASM = 16, K_SR = 17, K_CURVE = 18, K_WKID = 19, K_LATEST = 20, K_WKT = 21,
      K_TYPE = 22

const KEYS = names([
  ['features', K_FEATURES], ['geometry', K_GEOMETRY], ['attributes', K_ATTRIBUTES],
  ['x', K_X], ['y', K_Y], ['z', K_Z], ['m', K_M],
  ['points', K_POINTS], ['paths', K_PATHS], ['rings', K_RINGS],
  ['xmin', K_XMIN], ['ymin', K_YMIN], ['xmax', K_XMAX], ['ymax', K_YMAX],
  ['hasZ', K_HASZ], ['hasM', K_HASM], ['spatialReference', K_SR],
  ['curvePaths', K_CURVE], ['curveRings', K_CURVE],
  ['wkid', K_WKID], ['latestWkid', K_LATEST], ['wkt', K_WKT], ['type', K_TYPE],
])

// En qué objeto interpreta el lector cada miembro. En otro, el miembro es ajeno.
const ROOT = 1, FEATURE = 2, GEOMETRY = 4
const ROLES = new Uint8Array(K_TYPE + 1)
ROLES[K_FEATURES] = ROOT
ROLES[K_GEOMETRY] = ROLES[K_ATTRIBUTES] = ROOT | FEATURE
;[K_X, K_Y, K_Z, K_M, K_POINTS, K_PATHS, K_RINGS, K_XMIN, K_YMIN, K_XMAX, K_YMAX, K_HASZ, K_HASM, K_SR, K_CURVE]
  .forEach(k => { ROLES[k] = ROOT | GEOMETRY })

// Lo que delata a otro formato en la raíz, para el `hint` de 'formato'.
const HINTS = names([
  ['Topology', 1], ['FeatureCollection', 2], ['Feature', 2], ['Point', 2], ['MultiPoint', 2],
  ['LineString', 2], ['MultiLineString', 2], ['Polygon', 2], ['MultiPolygon', 2], ['GeometryCollection', 2],
])

const S_POINT = 1, S_POINTS = 2, S_PATHS = 3, S_RINGS = 4, S_ENVELOPE = 5, S_CURVE = 6, S_EMPTY = 7

// El programa: operaciones de 5 ranuras, [op, a, b, c, d]; una ranura en 0 es NOP.
const OP_FEATURE = 1, OP_GEOMETRY = 2, OP_PATH = 3, OP_END = 4

const encoder = new TextEncoder()

export const readEsriJson = (input, options = {}) => {
  const fail  = (code, at = -1, hint = null, detail = null) => { throw new FormatError(FORMAT, code, at, hint, detail) }
  const bytes = asBytes(input)
  bytes === null && fail('entrada')

  const { maxDepth } = limits(options, FORMAT)
  const fallback     = optionCrs(options.crs, FORMAT)

  const sc  = createScanner(bytes, FORMAT, maxDepth)
  const pos = sc.pos

  let prog = new Int32Array(80), ops = 0
  let raw = new Float64Array(64), ords = new Uint8Array(16), nPos = 0          // stride 4
  let declared = null, rootZ = -1, rootM = -1, hinted = 0
  let extra = 0, foreign = 0, skipped = 0

  const emit = (op, a = 0, b = 0, c = 0) => {
    prog = grown(prog, ops * 5 + 5)
    const s = ops * 5
    prog[s]     = op
    prog[s + 1] = a
    prog[s + 2] = b
    prog[s + 3] = c
    prog[s + 4] = 0
    return ops++
  }

  // x, y, z del Point y xmin, ymin, xmax, ymax del Envelope del objeto en curso: escalares que llegan
  // sueltos y se emiten al cerrar. Una geometría no anida otra, así que alcanza uno por lectura.
  const vals = new Float64Array(7)

  const push = (x, y, z, n) => {
    raw  = grown(raw, nPos * 4 + 4)
    ords = grown(ords, nPos + 1)
    raw[nPos * 4]     = x
    raw[nPos * 4 + 1] = y
    raw[nPos * 4 + 2] = z
    raw[nPos * 4 + 3] = n > 3 ? pos[3] : NaN
    ords[nPos++]      = Math.min(n, 255)
  }

  // Una posición de `points`, `paths` o `rings`. La M sin dato puede venir como `null` (§1.6-4).
  let posDepth = 0
  const position = v => {
    const e = sc.position(v, posDepth, true)
    sc.n < 2 && fail('posicion', v)
    push(pos[0], pos[1], sc.n > 2 ? pos[2] : NaN, sc.n)
    return e
  }
  const path = v => {
    const start = nPos
    const e = sc.elements(v, posDepth - 1, position)
    emit(OP_PATH, start, nPos - start)
    return e
  }

  // Un escalar de Point o Envelope: número, o `null` (el vacío que documenta Esri) o `"NaN"` [inf.: la
  // página «Geometry objects» sólo documenta `null`] (§1.6-4). Ambos quedan en `sc.value` como NaN.
  const scalar = v => {
    if (bytes[v] === 110) return sc.value = NaN, sc.literal(v)
    if (bytes[v] !== 34) return sc.number(v)
    const e = sc.string(v)
    sc.text() === 'NaN' || fail('posicion', v)
    sc.value = NaN
    return e
  }

  const flag = v => {
    bytes[v] === 116 || bytes[v] === 102 || fail('estructura', v)
    sc.value = bytes[v] === 116 ? 1 : 0
    return sc.literal(v)
  }

  // El código de `spatialReference`, o NaN si el miembro trae otra cosa.
  const wkidAt = (v, d) => {
    if (bytes[v] !== 45 && !digit(bytes[v])) return sc.value = NaN, sc.skip(v, d)
    return sc.number(v)
  }

  // `latestWkid` antes que `wkid`, y `wkt` si no hay código (§3.6). Una lectura publica UN CRS (§2.5).
  const spatialReference = (v, d) => {
    if (bytes[v] === 110) return sc.literal(v)
    let wkid = NaN, latest = NaN, wkt = null
    const e = sc.members(v, d, w => {
      const k = sc.code(KEYS)
      switch (k) {
        case K_WKID: case K_LATEST: {
          const e = wkidAt(w, d + 1)
          k === K_WKID ? wkid = sc.value : latest = sc.value
          return e
        }
        case K_WKT: {
          if (bytes[w] !== 34) return sc.skip(w, d + 1)
          const e = sc.string(w)
          wkt = sc.text()
          return e
        }
        default: return foreign++, sc.skip(w, d + 1)
      }
    })
    if (Number.isNaN(latest) && Number.isNaN(wkid) && wkt === null) return e

    const named = crsFromEpsg(latest) ?? crsFromEpsg(wkid)
    const found = named ?? (wkt === null ? null : crsFromWkt(encoder.encode(wkt)))
    found === null && fail('crs', v, null, wkt ?? `wkid:${Number.isNaN(latest) ? wkid : latest}`)
    declared !== null && declared.name !== found.name && fail('crs', v, null, found.name)
    declared = found
    return e
  }

  // Un objeto en el rol que le toca. La raíz se resuelve al cerrar: FeatureSet si trajo `features`,
  // feature si trajo `geometry` o `attributes`, geometría si trajo coordenadas; dos a la vez es
  // 'estructura'.
  const object = (v, d, role) => {
    const feature  = role === GEOMETRY ? -1 : emit(OP_FEATURE)
    const geometry = role === FEATURE ? -1 : emit(OP_GEOMETRY)
    const mark     = ops, posMark = nPos
    let shape = 0, shapeAt = v, hz = -1, hm = -1, af = 0, at = 0, listed = false, nested = false
    let seen = 0
    vals.fill(NaN)

    const take = (s, w) => {
      shape && shape !== s && fail('estructura', w)
      shape   = s
      shapeAt = w
    }
    // Clave duplicada: gana la última, así que lo que dejó la anterior se descarta.
    const rewind = () => {
      ops  = mark
      nPos = posMark
    }

    const end = sc.members(v, d, w => {
      const k = sc.code(KEYS)
      if (k === K_TYPE && role === ROOT && bytes[w] === 34) {
        const e = sc.string(w)
        hinted = sc.code(HINTS)
        return foreign++, e
      }
      if (!(ROLES[k] & role)) return foreign++, sc.skip(w, d + 1)

      switch (k) {
        case K_FEATURES:
          rewind()
          listed = true
          return sc.elements(w, d + 1, f => object(f, d + 2, FEATURE))
        case K_GEOMETRY:
          rewind()
          nested = true
          return bytes[w] === 110 ? sc.literal(w) : object(w, d + 1, GEOMETRY)
        case K_ATTRIBUTES:
          af = w
          nested = true
          return at = sc.skip(w, d + 1)
        case K_X: case K_Y: case K_Z: {
          k === K_Z || take(S_POINT, w)
          const e = scalar(w)
          vals[k - K_X] = sc.value
          seen |= 1 << (k - K_X)
          return e
        }
        case K_M: {
          const e = scalar(w)
          Number.isNaN(sc.value) || extra++
          return e
        }
        case K_POINTS: {
          take(S_POINTS, w)
          rewind()
          posDepth = d + 2
          const start = nPos
          const e = sc.elements(w, d + 1, position)
          emit(OP_PATH, start, nPos - start)
          return e
        }
        case K_PATHS: case K_RINGS:
          take(k === K_PATHS ? S_PATHS : S_RINGS, w)
          rewind()
          posDepth = d + 3
          return sc.elements(w, d + 1, path)
        case K_XMIN: case K_YMIN: case K_XMAX: case K_YMAX: {
          take(S_ENVELOPE, w)
          const e = scalar(w)
          vals[3 + k - K_XMIN] = sc.value
          seen |= 8 << (k - K_XMIN)
          return e
        }
        case K_HASZ: case K_HASM: {
          const e = flag(w)
          k === K_HASZ ? hz = sc.value : hm = sc.value
          return e
        }
        case K_SR   : return spatialReference(w, d + 1)
        case K_CURVE: return take(S_CURVE, w), sc.skip(w, d + 1)
      }
    })

    if (role === ROOT) {
      // EsriJSON no tiene `type`: una raíz que se declara Topology o GeoJSON es de otro formato,
      // aunque traiga `features`.
      const roles = (listed ? 1 : 0) + (nested ? 1 : 0) + (shape ? 1 : 0)
      hinted && fail('formato', v, hinted === 1 ? 'topojson' : 'geojson')
      roles === 0 && fail('formato', v)
      roles > 1 && fail('estructura', v)
      rootZ = hz
      rootM = hm
      listed && (prog[feature * 5] = 0)
      ;(listed || nested) && (prog[geometry * 5] = 0)
    }
    if (feature >= 0 && !listed) {
      prog[feature * 5 + 1] = af
      prog[feature * 5 + 2] = at
    }
    if (geometry < 0 || prog[geometry * 5] === 0) return end

    // Sin miembros de geometría el objeto no aporta ninguna: es un `geometry: {}` [inf.: ArcGIS no
    // lo define; se lee como `geometry: null`].
    if (!shape || shape === S_CURVE) {
      shape === S_CURVE && skipped++
      prog[geometry * 5] = 0
      ops = mark
      return end
    }
    const [x, y, z, xmin, ymin, xmax, ymax] = vals
    if (shape === S_POINT) {
      (seen & 3) === 3 || fail('estructura', shapeAt)
      if (Number.isNaN(x)) shape = S_EMPTY
      else {
        Number.isNaN(y) && fail('posicion', shapeAt)
        push(x, y, z, Number.isNaN(z) ? 2 : 3)
        emit(OP_PATH, nPos - 1, 1)
      }
    }
    if (shape === S_ENVELOPE) {
      (seen & 120) === 120 || fail('estructura', shapeAt)
      // Vacío: un Polygon de 0 partes.
      if (Number.isNaN(xmin + ymin + xmax + ymax)) shape = S_RINGS
      else {
        // Horario, como el exterior de Esri.
        const start = nPos
        push(xmin, ymin, NaN, 2)
        push(xmin, ymax, NaN, 2)
        push(xmax, ymax, NaN, 2)
        push(xmax, ymin, NaN, 2)
        push(xmin, ymin, NaN, 2)
        emit(OP_PATH, start, 5)
      }
    }
    prog[geometry * 5 + 1] = shape
    prog[geometry * 5 + 2] = hz
    prog[geometry * 5 + 3] = hm
    emit(OP_END)
    return end
  }

  const start = sc.ws(bomSkip(bytes))
  start >= bytes.length && fail('sintaxis', start)
  bytes[start] === 123 || fail('formato', start)
  const end = sc.ws(object(start, 1, ROOT))
  end < bytes.length && fail('sintaxis', end)

  const t = createTables(FORMAT, { capacityHint: options.capacityHint ?? nPos, bounds: options.bounds ?? false, orientation: CW })
  let shape = 0, zAt = -1, keep = 2, paths = 0

  for (let o = 0; o < ops; o++) {
    const s = o * 5
    switch (prog[s]) {
      case OP_FEATURE: t.attributes(t.feature(), prog[s + 1], prog[s + 2]); break
      case OP_GEOMETRY: {
        const hz = prog[s + 2] >= 0 ? prog[s + 2] : rootZ
        const hm = prog[s + 3] >= 0 ? prog[s + 3] : rootM
        shape = prog[s + 1]
        // Con `hasM` y sin `hasZ`, la tercera ordenada es la M. Sin ninguna de las dos banderas, se lee
        // como Z, igual que el WKT sin modificador (§3.3) [inf.: ArcGIS no lo define]. El Point no
        // depende de las banderas: su z y su m son miembros con nombre.
        zAt   = shape === S_POINT || hz === 1 || (hz === -1 && hm !== 1) ? 2 : -1
        keep  = zAt === 2 ? 3 : 2
        paths = 0
        t.geometry()
        ;(shape === S_RINGS || shape === S_ENVELOPE) && t.part()
        break
      }
      case OP_PATH: {
        const from = prog[s + 1], to = from + prog[s + 2]
        if (to === from && shape === S_POINTS) break
        shape !== S_RINGS && shape !== S_ENVELOPE && t.part()
        t.ring()
        paths++
        for (let p = from; p < to; p++) {
          ords[p] > keep && extra++
          t.vertex(raw[p * 4], raw[p * 4 + 1], zAt === 2 ? raw[p * 4 + 2] : NaN)
        }
        break
      }
      case OP_END:
        shape === S_RINGS || shape === S_ENVELOPE ? t.closeRings()
        : t.close(shape === S_POINT || shape === S_EMPTY ? 1 : shape === S_POINTS ? 2 : paths > 1 ? 4 : 3)
        break
    }
  }

  const stats = t.stats
  stats.extraOrdinates    += extra
  stats.foreignMembers    += foreign
  stats.skippedGeometries += skipped
  stats.slowNumbers       += sc.slow
  stats.roots              = 1

  const source = declared ?? fallback
  let decoder = null
  const parse = (b, from, to) => JSON.parse((decoder ??= new TextDecoder()).decode(b.subarray(from, to)))
  return t.seal({ source, bytes, properties: parse, id: null })
}
