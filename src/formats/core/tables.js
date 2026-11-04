// Constructor de tablas CSR compartido por los lectores de formatos (DISENO-INTEROP §2.3). Reproduce el
// sellado de `readGeoJson` (SPECS §17.1, §17.3, §17.4bis) para que `areasOf` y `RingStore` consuman la
// salida sin cambios.

import { FormatError } from './error.js'
import { toLngLat, isGeographic } from './crs.js'

// Convención de orientación del exterior del formato (§1.3): RFC 7946, KML y Simple Features la
// quieren antihoraria; Shapefile y EsriJSON, horaria.
export const CCW = 0, CW = 1

const grown = (arr, need) => {
  if (need <= arr.length) return arr
  const next = new arr.constructor(Math.max(need, arr.length * 2))
  next.set(arr)
  return next
}

// El dueño de `x` es el único `i` con `a[i] <= x < a[i+1]` (SPECS §17.3-8).
const owner = (table, count, x) => {
  let lo = 0, hi = count
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    table[mid] <= x ? lo = mid + 1 : hi = mid
  }
  return lo - 1
}

// Recortar sin copiar cuando el llenado lo justifica, como `readGeoJson`.
const trim = (arr, n) => n * 4 >= arr.length * 3 ? arr.subarray(0, n) : arr.slice(0, n)

// Errores de programación del lector, no de la entrada: nunca llegan al consumidor de un lector correcto.
const need = (ok, what) => {
  if (!ok) throw new Error(`createTables: ${what}`)
}

// Una pista que dimensiona un buffer: lo que no es entero ≥ 0 es 'entrada', y el tope evita que un valor
// absurdo reviente la asignación [inf.: 2^20 vértices, el resto lo da el crecimiento].
const MAX_HINT = 1 << 20

export const createTables = (format, { capacityHint = 0, bounds = false, orientation = CCW } = {}) => {
  const hint = capacityHint ?? 0
  if (!Number.isInteger(hint) || hint < 0) throw new FormatError(format, 'entrada')

  const stats = {
    openRings: 0, shortRings: 0, degenerateRings: 0, reversedRings: 0, slowNumbers: 0,
    extraOrdinates: 0, emptyGeometries: 0, foreignMembers: 0, bboxSkipped: 0, roots: 1,
    skippedGeometries: 0, deletedRecords: 0, orphanHoles: 0,
  }
  const layers   = []
  const warnings = []
  const fail     = (code, at = -1) => { throw new FormatError(format, code, at) }

  let geometryAt = new Uint32Array(16), partAt = new Uint32Array(16), ringAt = new Uint32Array(16),
      vertexAt = new Uint32Array(16), kinds = new Uint8Array(16), featureOf = new Uint32Array(16),
      closed = new Uint8Array(16), ringArea = new Float64Array(16), layerOf = new Uint32Array(16),
      propAt = new Uint32Array(32), idAt = new Uint32Array(32), z = null,
      xy = new Float64Array(Math.max(32, Math.min(hint, MAX_HINT)) * 2)

  let features = 0, geometries = 0, parts = 0, rings = 0, vertices = 0
  let open = 0, partOpen = 0, ringOpen = 0, ringStart = 0, area = 0
  let markParts = 0, markRings = 0, markVertices = 0, markOpenRings = 0, markShortRings = 0

  // Buffers de trabajo de `closeRings`: crecen y no se reasignan por geometría (§2.4).
  let box = new Float64Array(16), role = new Int32Array(4), from = new Uint32Array(4),
      count = new Uint32Array(4), wClosed = new Uint8Array(4), wArea = new Float64Array(4),
      wXy = new Float64Array(16), wZ = null

  const closeRing = () => {
    const n    = vertices - ringStart
    const last = vertices - 1
    const same = n >= 2 && Object.is(xy[ringStart * 2], xy[last * 2]) &&
      Object.is(xy[ringStart * 2 + 1], xy[last * 2 + 1]) &&
      (z === null || Object.is(z[ringStart], z[last]))

    n >= 2 && !same && stats.openRings++
    n >= 1 && n < 4 && stats.shortRings++

    vertexAt = grown(vertexAt, rings + 2)
    closed   = grown(closed, rings + 1)
    ringArea = grown(ringArea, rings + 1)
    closed[rings]   = same ? 1 : 0
    ringArea[rings] = n >= 3
      ? area + (xy[last * 2] * xy[ringStart * 2 + 1] - xy[ringStart * 2] * xy[last * 2 + 1])
      : 0
    rings           = rings + 1
    vertexAt[rings] = vertices
    ringOpen        = 0
  }

  const closePart = () => {
    ringOpen && closeRing()
    ringAt        = grown(ringAt, parts + 2)
    parts         = parts + 1
    ringAt[parts] = rings
    partOpen      = 0
  }

  const commit = kind => {
    kinds     = grown(kinds, geometries + 1)
    featureOf = grown(featureOf, geometries + 1)
    partAt    = grown(partAt, geometries + 2)
    kinds[geometries]     = kind
    featureOf[geometries] = features - 1
    geometries            = geometries + 1
    partAt[geometries]    = parts
    partAt[geometries] === partAt[geometries - 1] && stats.emptyGeometries++
    open = 0
    return geometries - 1
  }

  // Punto en anillo con el primer vértice del hoyo que no cae sobre el borde (§2.4-2). Si todos caen
  // sobre el borde, el hoyo se da por contenido [inf.: no lo fija ninguna de las dos especificaciones].
  const inside = (outer, hole) => {
    const ef = vertexAt[outer], et = vertexAt[outer + 1]
    for (let p = vertexAt[hole]; p < vertexAt[hole + 1]; p++) {
      const px = xy[p * 2], py = xy[p * 2 + 1]
      let crossing = false, border = false
      for (let i = ef, j = et - 1; i < et && !border; j = i++) {
        const xi = xy[i * 2], yi = xy[i * 2 + 1], xj = xy[j * 2], yj = xy[j * 2 + 1]
        border = (xj - xi) * (py - yi) - (yj - yi) * (px - xi) === 0 &&
          px >= Math.min(xi, xj) && px <= Math.max(xi, xj) && py >= Math.min(yi, yj) && py <= Math.max(yi, yj)
        if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) crossing = !crossing
      }
      if (!border) return crossing
    }
    return true
  }

  const tables = {
    stats,

    // Lo que no impide leer pero el consumidor tiene que saber (SPECS §19.1). Devuelve `undefined`.
    warn: (code, detail = null) => { warnings.push({ code, detail }) },

    layer: (name = null, parent = -1) => {
      need(layers.length > 0 || features === 0, 'layer() después de features en la capa implícita')
      need(Number.isInteger(parent) && parent >= -1 && parent < layers.length, 'capa padre inexistente')
      layers.push({ name, parent })
      return layers.length - 1
    },

    layerName: (l, name) => {
      need(l >= 0 && l < layers.length, 'capa inexistente')
      layers[l].name = name
    },

    feature: (layer = 0) => {
      need(!open, 'feature() con una geometría abierta')
      need(Number.isInteger(layer) && layer >= 0 && (layer < layers.length || (layer === 0 && !layers.length)), 'capa inexistente')
      geometryAt = grown(geometryAt, features + 2)
      propAt     = grown(propAt, features * 2 + 2)
      idAt       = grown(idAt, features * 2 + 2)
      layerOf    = grown(layerOf, features + 1)
      geometryAt[features] = geometries
      layerOf[features]    = layer
      return features++
    },

    attributes: (f, propFrom, propTo, idFrom = 0, idTo = 0) => {
      need(Number.isInteger(f) && f >= 0 && f < features, 'feature inexistente')
      propAt[f * 2]     = propFrom
      propAt[f * 2 + 1] = propTo
      idAt[f * 2]       = idFrom
      idAt[f * 2 + 1]   = idTo
    },

    geometry: () => {
      need(features > 0, 'geometry() sin feature')
      need(!open, 'geometry() con otra geometría abierta')
      open           = 1
      partOpen       = ringOpen = 0
      markParts      = parts
      markRings      = rings
      markVertices   = vertices
      markOpenRings  = stats.openRings
      markShortRings = stats.shortRings
    },

    part: () => {
      need(open, 'part() sin geometría abierta')
      partOpen && closePart()
      partOpen = 1
    },

    ring: () => {
      need(partOpen, 'ring() sin parte abierta')
      ringOpen && closeRing()
      ringOpen  = 1
      ringStart = vertices
      area      = 0
    },

    // [0-alloc] salvo al crecer. El primer z que no es NaN reserva `z` (SPECS §17.3-4).
    vertex: (x, y, zv = NaN) => {
      if (!ringOpen) throw new Error('createTables: vertex() sin anillo abierto')
      const v = vertices
      if ((v + 1) * 2 > xy.length) {
        const next = new Float64Array(xy.length * 2)
        next.set(xy.subarray(0, v * 2))
        xy = next
        z === null || (z = grown(z, next.length >> 1))
      }
      xy[v * 2]     = x
      xy[v * 2 + 1] = y
      if (z !== null) z[v] = zv
      else if (zv === zv) {
        z = new Float64Array(xy.length >> 1).fill(NaN)
        z[v] = zv
      }
      v > ringStart && (area += xy[(v - 1) * 2] * y - x * xy[(v - 1) * 2 + 1])
      vertices = v + 1
    },

    close: kind => {
      need(open, 'close() sin geometría abierta')
      need(Number.isInteger(kind) && kind >= 1 && kind <= 6, 'kind fuera de 1..6')
      partOpen && closePart()
      return commit(kind)
    },

    // §2.4: los anillos de la ÚNICA parte abierta, sin agrupar, pasan a polígonos por orientación y
    // contención. Reagrupar mueve vértices dentro del rango de la geometría.
    closeRings: () => {
      need(open && partOpen && parts === markParts, 'closeRings() pide una sola parte abierta')
      ringOpen && closeRing()
      partOpen = 0

      const r0 = markRings, n = rings - r0
      if (n === 0) return commit(5)

      box     = grown(box, n * 4)
      role    = grown(role, n)
      from    = grown(from, n)
      count   = grown(count, n)
      wClosed = grown(wClosed, n)
      wArea   = grown(wArea, n)

      const outerSign = orientation === CW ? -1 : 1
      for (let k = 0; k < n; k++) {
        const r = r0 + k
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
        for (let v = vertexAt[r]; v < vertexAt[r + 1]; v++) {
          const x = xy[v * 2], y = xy[v * 2 + 1]
          x < minX && (minX = x)
          x > maxX && (maxX = x)
          y < minY && (minY = y)
          y > maxY && (maxY = y)
        }
        box[k * 4]     = minX
        box[k * 4 + 1] = minY
        box[k * 4 + 2] = maxX
        box[k * 4 + 3] = maxY
        // −1 exterior, −2 hoyo sin dueño todavía. Área 0 es exterior (§2.4-4).
        role[k] = ringArea[r] === 0 || ringArea[r] * outerSign > 0 ? -1 : -2
      }

      // Cada hoyo va al exterior MÁS CHICO que lo contiene; los exteriores candidatos son sólo los
      // originales, así que el resultado no depende del orden de los hoyos. −3 = huérfano.
      for (let h = 0; h < n; h++) {
        if (role[h] !== -2) continue
        let best = -3, bestArea = Infinity
        for (let e = 0; e < n; e++) {
          const ae = Math.abs(ringArea[r0 + e])
          if (role[e] !== -1 || ae === 0 || ae >= bestArea) continue
          if (box[h * 4] < box[e * 4] || box[h * 4 + 1] < box[e * 4 + 1] ||
              box[h * 4 + 2] > box[e * 4 + 2] || box[h * 4 + 3] > box[e * 4 + 3]) continue
          if (!inside(r0 + e, r0 + h)) continue
          best     = e
          bestArea = ae
        }
        role[h] = best
        best === -3 && stats.orphanHoles++
      }

      const v0 = vertexAt[r0], span = vertices - v0
      wXy = grown(wXy, span * 2)
      for (let k = 0; k < span * 2; k++) wXy[k] = xy[v0 * 2 + k]
      if (z !== null) {
        wZ = wZ === null ? new Float64Array(Math.max(16, span)) : grown(wZ, span)
        for (let k = 0; k < span; k++) wZ[k] = z[v0 + k]
      }
      for (let k = 0; k < n; k++) {
        from[k]    = vertexAt[r0 + k] - v0
        count[k]   = vertexAt[r0 + k + 1] - vertexAt[r0 + k]
        wClosed[k] = closed[r0 + k]
        wArea[k]   = ringArea[r0 + k]
      }

      let r = r0, v = v0
      const emit = k => {
        for (let c = 0; c < count[k] * 2; c++) xy[v * 2 + c] = wXy[from[k] * 2 + c]
        if (z !== null) for (let c = 0; c < count[k]; c++) z[v + c] = wZ[from[k] + c]
        closed[r]   = wClosed[k]
        ringArea[r] = wArea[k]
        vertexAt[r] = v
        v          += count[k]
        r          += 1
        vertexAt[r] = v
      }

      for (let e = 0; e < n; e++) {
        if (role[e] >= 0) continue
        emit(e)
        for (let h = 0; h < n; h++) role[h] === e && emit(h)
        ringAt        = grown(ringAt, parts + 2)
        parts         = parts + 1
        ringAt[parts] = r
      }
      return commit(parts - markParts === 1 ? 5 : 6)
    },

    discard: () => {
      need(open, 'discard() sin geometría abierta')
      vertices         = markVertices
      rings            = markRings
      parts            = markParts
      stats.openRings  = markOpenRings
      stats.shortRings = markShortRings
      open             = partOpen = ringOpen = 0
    },

    seal: ({ crs = null, source = null, bytes = null, properties = null, id = null } = {}) => {
      need(!open, 'seal() con una geometría abierta')
      geometryAt = grown(geometryAt, features + 1)
      geometryAt[features] = geometries

      // La inversa va sobre `xy` en sitio y antes de `bounds` (§2.5). Sin CRS de la fuente las
      // coordenadas tienen que caber en el rango geográfico: un UTM sin `.prj` no se dibuja en el océano.
      if (source !== null) toLngLat(source, xy, 0, vertices) || fail('crs')
      else isGeographic(xy, 0, vertices) < 0 || fail('crs')

      // `z` es del documento y lo deciden las posiciones retenidas (SPECS §17.3-4).
      z === null || z.subarray(0, vertices).some(a => !Number.isNaN(a)) || (z = null)

      // Sentido de giro contra la convención del FORMATO (§1.3). El área sale de las coordenadas de
      // origen, y las tres familias de CRS conservan la orientación [inf.].
      const sign = orientation === CW ? -1 : 1
      for (let g = 0; g < geometries; g++) {
        if (kinds[g] !== 5 && kinds[g] !== 6) continue
        for (let p = partAt[g]; p < partAt[g + 1]; p++)
          for (let r = ringAt[p]; r < ringAt[p + 1]; r++)
            ringArea[r] === 0
              ? stats.degenerateRings++
              : (r === ringAt[p]) === (ringArea[r] * sign < 0) && stats.reversedRings++
      }

      const box = bounds ? new Float64Array(geometries * 4) : null
      for (let g = 0, n = box ? geometries : 0; g < n; g++) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
        const to = vertexAt[ringAt[partAt[g + 1]]]
        for (let v = vertexAt[ringAt[partAt[g]]]; v < to; v++) {
          const x = xy[v * 2], y = xy[v * 2 + 1]
          x < minX && (minX = x)
          x > maxX && (maxX = x)
          y < minY && (minY = y)
          y > maxY && (maxY = y)
        }
        box[g * 4]     = minX
        box[g * 4 + 1] = minY
        box[g * 4 + 2] = maxX
        box[g * 4 + 3] = maxY
      }

      let released = false
      // La guarda de `read` de geojson.js: liberado, fuera de rango y par vacío. Una excepción del
      // decodificador sale como 'properties', salvo que ya sea un FormatError con su propio código.
      const read = (table, f, decode) => {
        released && fail('liberado')
        if (!Number.isInteger(f) || f < 0 || f >= features) return null
        const from = table[f * 2], to = table[f * 2 + 1]
        if (to <= from || decode === null || result.bytes === null) return null
        try { return decode(result.bytes, from, to) }
        catch (e) { if (e instanceof FormatError) throw e; return fail('properties', from) }
      }

      const result = {
        format, crs,
        geometryAt: trim(geometryAt, features + 1), partAt: trim(partAt, geometries + 1),
        ringAt: trim(ringAt, parts + 1),            vertexAt: trim(vertexAt, rings + 1),
        kinds: trim(kinds, geometries),             featureOf: trim(featureOf, geometries),
        closed: trim(closed, rings),                xy: trim(xy, vertices * 2),
        propAt: trim(propAt, features * 2),         idAt: trim(idAt, features * 2),
        layerOf: trim(layerOf, features),
        layers: layers.length ? layers : [{ name: null, parent: -1 }],
        z: z === null ? null : trim(z, vertices),
        bounds: box,
        bytes, stats, warnings,
        featureCount: features, geometryCount: geometries,
        partCount: parts, ringCount: rings, vertexCount: vertices,

        eachRing: cb => { for (let r = 0; r < rings; r++) cb(r, result.vertexAt[r], result.vertexAt[r + 1] - result.vertexAt[r], result.partOf(r)) },
        someRing: pred => {
          for (let r = 0; r < rings; r++)
            if (pred(r, result.vertexAt[r], result.vertexAt[r + 1] - result.vertexAt[r], result.partOf(r))) return true
          return false
        },
        partOf       : ring => owner(result.ringAt, parts + 1, ring),
        geometryOf   : part => owner(result.partAt, geometries + 1, part),
        featureOfRing: ring => result.featureOf[result.geometryOf(result.partOf(ring))],
        propertiesOf : f => read(result.propAt, f, properties),
        idOf         : f => read(result.idAt, f, id),
        release      : () => { result.bytes = null; released = true },
      }
      return result
    },
  }

  return tables
}
