// Lector de TopoJSON 1.0 (DISENO-INTEROP §3.5): bytes → las tablas CSR de `readGeoJson`. Los
// miembros de un objeto llegan en cualquier orden, así que `arcs` puede venir después de `objects`:
// la primera fase recorre el documento una vez y anota un programa de emisión; la segunda lo
// reproduce sobre los arcos ya decodificados, sin volver a los bytes.

import { FormatError } from './core/error.js'
import { asBytes, bomSkip } from './core/input.js'
import { createTables } from './core/tables.js'
import { optionCrs } from './core/crs.js'
import { createScanner, digit, grown, limits, names } from './json-scan.js'

const FORMAT = 'topojson'

const K_TYPE = 1, K_ARCS = 2, K_COORDINATES = 3, K_GEOMETRIES = 4, K_PROPERTIES = 5, K_ID = 6,
      K_BBOX = 7, K_OBJECTS = 8, K_TRANSFORM = 9, K_SCALE = 10, K_TRANSLATE = 11, K_ESRI = 12

const KEYS = names([
  ['type', K_TYPE], ['arcs', K_ARCS], ['coordinates', K_COORDINATES], ['geometries', K_GEOMETRIES],
  ['properties', K_PROPERTIES], ['id', K_ID], ['bbox', K_BBOX], ['objects', K_OBJECTS],
  ['transform', K_TRANSFORM], ['scale', K_SCALE], ['translate', K_TRANSLATE],
  ['features', K_ESRI], ['geometryType', K_ESRI], ['spatialReference', K_ESRI], ['displayFieldName', K_ESRI],
])

const POINT = 1, MULTIPOINT = 2, LINESTRING = 3, MULTILINESTRING = 4, POLYGON = 5, MULTIPOLYGON = 6,
      COLLECTION = 7, TOPOLOGY = 8, GEOJSON = 9, NULL = 10

const KINDS = names([
  ['Point', POINT], ['MultiPoint', MULTIPOINT], ['LineString', LINESTRING],
  ['MultiLineString', MULTILINESTRING], ['Polygon', POLYGON], ['MultiPolygon', MULTIPOLYGON],
  ['GeometryCollection', COLLECTION], ['Topology', TOPOLOGY],
  ['Feature', GEOJSON], ['FeatureCollection', GEOJSON],
])

// El programa: operaciones de 5 ranuras, [op, a, b, c, d]. Una ranura en 0 es NOP, así que anular un
// tramo es llenarlo de ceros.
const OP_LAYER = 1, OP_FEATURE = 2, OP_GEOMETRY = 3, OP_PART = 4, OP_ARCS = 5, OP_POINTS = 6, OP_END = 7

export const readTopoJson = (input, options = {}) => {
  const fail  = (code, at = -1, hint = null) => { throw new FormatError(FORMAT, code, at, hint) }
  const bytes = asBytes(input)
  bytes === null && fail('entrada')

  const { maxDepth, maxBytes } = limits(options, FORMAT)
  const only = options.object
  only === undefined || typeof only === 'string' || fail('entrada')
  const source = optionCrs(options.crs, FORMAT)

  const sc  = createScanner(bytes, FORMAT, maxDepth)
  const pos = sc.pos

  let prog = new Int32Array(80), ops = 0
  let refs = new Int32Array(64), nRefs = 0
  let points = new Float64Array(48), nPoints = 0                         // stride 3: x, y, z
  let arcXy = new Float64Array(64), arcZ = null, arcAt = new Uint32Array(16), nArcs = 0, nArcPos = 0
  let sx = 1, sy = 1, tx = 0, ty = 0, quantized = 0
  let type = 0, typeAt = 0, esri = 0, found = 0, extra = 0, foreign = 0, bboxSkipped = 0
  const layerNames = []

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

  const bbox = (v, d) => {
    const e = sc.skip(v, d)
    e - v > 256 && bboxSkipped++
    return e
  }

  // Un arco de N posiciones: la z vive aparte y con NaN donde la posición era 2D (§17.3-4).
  const arcPosition = v => {
    const e = sc.position(v, 4, false)
    sc.n < 2 && fail('posicion', v)
    sc.n > 3 && extra++
    arcXy = grown(arcXy, nArcPos * 2 + 2)
    arcXy[nArcPos * 2]     = pos[0]
    arcXy[nArcPos * 2 + 1] = pos[1]
    if (sc.n >= 3 || arcZ !== null) {
      if (arcZ === null || arcZ.length <= nArcPos) {
        const next = new Float64Array(arcXy.length >> 1).fill(NaN)
        arcZ === null || next.set(arcZ)
        arcZ = next
      }
      arcZ[nArcPos] = sc.n >= 3 ? pos[2] : NaN
    }
    nArcPos++
    return e
  }

  const arc = v => {
    arcAt = grown(arcAt, nArcs + 2)
    arcAt[nArcs] = nArcPos
    const e = sc.elements(v, 3, arcPosition)
    arcAt[++nArcs] = nArcPos
    return e
  }

  // Clave duplicada: gana la última, como en `JSON.parse`.
  const arcs = v => {
    nArcs = nArcPos = 0
    arcZ = null
    return sc.elements(v, 2, arc)
  }

  const transform = v => {
    let scale = 0, translate = 0
    const e = sc.members(v, 2, w => {
      const k = sc.code(KEYS)
      if (k !== K_SCALE && k !== K_TRANSLATE) return foreign++, sc.skip(w, 3)
      const e = sc.position(w, 3, false)
      sc.n === 2 || fail('estructura', w)
      k === K_SCALE ? (sx = pos[0], sy = pos[1], scale = 1) : (tx = pos[0], ty = pos[1], translate = 1)
      return e
    })
    scale && translate || fail('estructura', v)
    quantized = 1
    return e
  }

  // Posiciones propias de Point y MultiPoint: cuantizadas pero sin delta (§2.1.2). Sólo el Point
  // admite la posición vacía, que es la geometría vacía.
  const point = (v, d, empty = false) => {
    const e = sc.position(v, d, false)
    if (empty && sc.n === 0) return e
    sc.n < 2 && fail('posicion', v)
    sc.n > 3 && extra++
    points = grown(points, nPoints * 3 + 3)
    points[nPoints * 3]     = pos[0]
    points[nPoints * 3 + 1] = pos[1]
    points[nPoints * 3 + 2] = sc.n >= 3 ? pos[2] : NaN
    nPoints++
    return e
  }
  let pointDepth = 0
  const multiPoint = v => point(v, pointDepth)

  const ref = v => {
    bytes[v] === 45 || digit(bytes[v]) || fail('estructura', v)
    const e = sc.number(v)
    const r = sc.value
    Number.isInteger(r) && r >= -2147483648 && r <= 2147483647 || fail('estructura', v)
    refs = grown(refs, nRefs + 1)
    refs[nRefs++] = r
    return e
  }

  const ring = (v, d) => {
    const start = nRefs
    const e = sc.elements(v, d, ref)
    emit(OP_ARCS, start, nRefs - start, v)
    return e
  }

  // §2.1.4: las formas son las de GeoJSON con índices de arco en lugar de posiciones, y la tabla
  // tipo → partes y anillos es la de §17.1. Un contenedor vacío ocupa ranura donde cierra (§17.3-14).
  const body = (kind, v, d) => {
    emit(OP_GEOMETRY, kind)
    if (kind <= MULTIPOINT) {
      const start = nPoints
      pointDepth = d + 1
      const e = kind === POINT ? point(v, d, true) : sc.elements(v, d, multiPoint)
      nPoints > start && (emit(OP_PART), emit(OP_POINTS, start, nPoints - start))
      emit(OP_END, kind)
      return e
    }
    if (kind === LINESTRING) {
      const start = nRefs
      const e = sc.elements(v, d, ref)
      nRefs > start && (emit(OP_PART), emit(OP_ARCS, start, nRefs - start, v))
      emit(OP_END, kind)
      return e
    }
    let opened = 0
    const e = sc.elements(v, d, w =>
      kind === MULTILINESTRING ? (emit(OP_PART), ring(w, d + 1))
      : kind === POLYGON ? (opened++ || emit(OP_PART), ring(w, d + 1))
      : (emit(OP_PART), sc.elements(w, d + 1, x => ring(x, d + 2))))
    emit(OP_END, kind)
    return e
  }

  // `role`: 0 es un miembro de `objects`, 1 un hijo de una colección de `objects` y 2 lo que está más
  // adentro. Los dos primeros son features; lo de adentro se aplana en el suyo (§17.1).
  const object = (v, d, role) => {
    const feature = role < 2 ? emit(OP_FEATURE) : -1
    const mark    = ops
    let kind = -1, kindAt = v, arcsAt = -1, coordsAt = -1, collected = false, pf = 0, pt = 0, idf = 0, idt = 0

    const end = sc.members(v, d, w => {
      switch (sc.code(KEYS)) {
        case K_TYPE: {
          kindAt = w
          if (bytes[w] !== 34) return kind = bytes[w] === 110 ? NULL : 0, sc.skip(w, d + 1)
          const e = sc.string(w)
          kind = sc.code(KINDS)
          return e
        }
        case K_ARCS        : return arcsAt = w, sc.skip(w, d + 1)
        case K_COORDINATES : return coordsAt = w, sc.skip(w, d + 1)
        case K_GEOMETRIES  :
          ops = mark
          collected = true
          return sc.elements(w, d + 1, x => object(x, d + 2, role === 0 ? 1 : 2))
        case K_PROPERTIES  : return pf = w, pt = sc.skip(w, d + 1)
        case K_ID          : return idf = w, idt = sc.skip(w, d + 1)
        case K_BBOX        : return bbox(w, d + 1)
        default            : return foreign++, sc.skip(w, d + 1)
      }
    })

    kind > 0 && (kind <= COLLECTION || kind === NULL) || fail('tipo', kindAt)
    collected !== (kind === COLLECTION) && fail('estructura', kindAt)

    if (kind < COLLECTION) {
      const at = kind <= MULTIPOINT ? coordsAt : arcsAt
      at < 0 && fail('estructura', kindAt)
      body(kind, at, d + 1)
    }

    if (feature >= 0) {
      const s = feature * 5
      if (role === 0 && kind === COLLECTION) prog[s] = 0
      else {
        prog[s + 1] = pf
        prog[s + 2] = pt
        prog[s + 3] = idf
        prog[s + 4] = idt
      }
    }
    return end
  }

  // Cada miembro es una capa. Un nombre repetido no tiene lectura única: `JSON.parse` lo deja en la
  // posición del primero con el valor del último, y la opción `object` no sabría cuál elegir.
  // Las colecciones anidadas recursan y `maxDepth` es opción pública: con una cota alta la pila se
  // agota antes que la cota, y eso es 'profundidad', no un RangeError crudo (§1.5).
  const objects = v => {
    ops = found = 0
    layerNames.length = 0
    try {
      return sc.members(v, 2, w => {
        const name = sc.text()
        layerNames.includes(name) && fail('estructura', w)
        if (only !== undefined && name !== only) return sc.skip(w, 3)
        found = 1
        emit(OP_LAYER, layerNames.push(name) - 1)
        return object(w, 3, 0)
      })
    } catch (e) {
      if (e instanceof RangeError) fail('profundidad', v)
      throw e
    }
  }

  const start = sc.ws(bomSkip(bytes))
  start >= bytes.length && fail('sintaxis', start)
  bytes[start] === 123 || fail('formato', start)

  const end = sc.members(start, 1, v => {
    switch (sc.code(KEYS)) {
      case K_TYPE: {
        typeAt = v
        if (bytes[v] !== 34) return sc.skip(v, 2)
        const e = sc.string(v)
        type = sc.code(KINDS)
        return e
      }
      case K_OBJECTS   : return objects(v)
      case K_ARCS      : return arcs(v)
      case K_TRANSFORM : return transform(v)
      case K_BBOX      : return bbox(v, 2)
      case K_ESRI      : esri = 1
      // fall through
      default          : return foreign++, sc.skip(v, 2)
    }
  })
  sc.ws(end) < bytes.length && fail('sintaxis', sc.ws(end))
  type === TOPOLOGY ||
    fail('formato', typeAt, type > 0 && type !== TOPOLOGY ? 'geojson' : esri ? 'esrijson' : null)
  only === undefined || found || fail('formato')

  // §2.1.2 y §2.1.3: con `transform`, cada arco es delta desde su primera posición, y todo escala y traslada.
  for (let a = 0, n = quantized ? nArcs : 0; a < n; a++) {
    let x = 0, y = 0
    for (let p = arcAt[a]; p < arcAt[a + 1]; p++) {
      x += arcXy[p * 2]
      y += arcXy[p * 2 + 1]
      arcXy[p * 2]     = x * sx + tx
      arcXy[p * 2 + 1] = y * sy + ty
      Number.isFinite(arcXy[p * 2]) && Number.isFinite(arcXy[p * 2 + 1]) || fail('numero')
    }
  }
  for (let p = 0, n = quantized ? nPoints : 0; p < n; p++) {
    points[p * 3]     = points[p * 3] * sx + tx
    points[p * 3 + 1] = points[p * 3 + 1] * sy + ty
    Number.isFinite(points[p * 3]) && Number.isFinite(points[p * 3 + 1]) || fail('numero')
  }

  // §1.6-3: un arco referido muchas veces multiplica la salida sin pasar por los bytes, así que se
  // suma lo que se va a emitir antes de reservar. Al unir arcos se omite la primera posición de cada
  // uno salvo el primero, porque repite la última del anterior.
  let total = 0
  for (let o = 0; o < ops; o++) {
    const s = o * 5
    if (prog[s] === OP_POINTS) total += prog[s + 2]
    if (prog[s] !== OP_ARCS) continue
    for (let k = 0; k < prog[s + 2]; k++) {
      const r = refs[prog[s + 1] + k], a = r < 0 ? ~r : r
      a >= nArcs && fail('estructura', prog[s + 3])
      const n = arcAt[a + 1] - arcAt[a]
      total += k && n ? n - 1 : n
    }
  }
  total * 16 > maxBytes && fail('tope')

  const t = createTables(FORMAT, { capacityHint: options.capacityHint ?? total, bounds: options.bounds ?? false })
  let layer = 0, kind = 0
  for (let o = 0; o < ops; o++) {
    const s = o * 5
    switch (prog[s]) {
      case OP_LAYER    : layer = t.layer(layerNames[prog[s + 1]]); break
      case OP_FEATURE  : t.attributes(t.feature(layer), prog[s + 1], prog[s + 2], prog[s + 3], prog[s + 4]); break
      case OP_GEOMETRY : t.geometry(); kind = prog[s + 1]; break
      case OP_PART     : t.part(); break
      case OP_END      : t.close(kind); break
      case OP_POINTS:
        t.ring()
        for (let p = prog[s + 1], to = p + prog[s + 2]; p < to; p++)
          t.vertex(points[p * 3], points[p * 3 + 1], points[p * 3 + 2])
        break
      case OP_ARCS:
        t.ring()
        for (let k = 0; k < prog[s + 2]; k++) {
          const r = refs[prog[s + 1] + k], a = r < 0 ? ~r : r
          const from = arcAt[a], to = arcAt[a + 1]
          if (r >= 0)
            for (let p = k ? from + 1 : from; p < to; p++) t.vertex(arcXy[p * 2], arcXy[p * 2 + 1], arcZ === null ? NaN : arcZ[p])
          else
            for (let p = k ? to - 2 : to - 1; p >= from; p--) t.vertex(arcXy[p * 2], arcXy[p * 2 + 1], arcZ === null ? NaN : arcZ[p])
        }
        break
    }
  }

  const stats = t.stats
  stats.extraOrdinates += extra
  stats.foreignMembers += foreign
  stats.bboxSkipped    += bboxSkipped
  stats.slowNumbers    += sc.slow
  stats.roots           = 1

  let decoder = null
  const parse = (b, from, to) => JSON.parse((decoder ??= new TextDecoder()).decode(b.subarray(from, to)))
  // TopoJSON no fija un CRS: sin `options.crs` se asume lon/lat WGS84 y se declara. Fuera de rango
  // avisa en `warnings` en vez de fallar, para que una topología proyectada sin la opción no pase muda.
  return t.seal({ crs: source?.name ?? 'EPSG:4326', source, assumed: source === null, bytes, properties: parse, id: parse })
}
