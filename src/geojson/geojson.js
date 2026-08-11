// Lector de coordenadas GeoJSON: bytes UTF-8 → geometría en arrays tipados, en una pasada y sin
// construir el grafo de `JSON.parse`. Contrato completo en SPECS.md §17.

export class GeoJsonError extends Error {
  constructor(code, at = -1, hint = null) {
    super(at >= 0 ? `geojson: ${code} (byte ${at})` : `geojson: ${code}`)
    this.name = 'GeoJsonError'
    this.code = code
    this.at   = at
    this.hint = hint
  }
}

export const GeoJsonKind = Object.freeze({
  Point: 1, MultiPoint: 2, LineString: 3, MultiLineString: 4, Polygon: 5, MultiPolygon: 6,
})

const COLLECTION = 7
const K_TYPE = 1, K_GEOMETRY = 2, K_GEOMETRIES = 3, K_COORDINATES = 4,
      K_PROPERTIES = 6, K_BBOX = 7, K_ID = 8

const KEY_PAIRS = [
  ['type', K_TYPE], ['geometry', K_GEOMETRY], ['geometries', K_GEOMETRIES],
  ['coordinates', K_COORDINATES], ['features', 5], ['properties', K_PROPERTIES],
  ['bbox', K_BBOX], ['id', K_ID],
]
const KIND_PAIRS = [
  ['Point', 1], ['MultiPoint', 2], ['LineString', 3], ['MultiLineString', 4],
  ['Polygon', 5], ['MultiPolygon', 6], ['GeometryCollection', COLLECTION],
]

const encoder = new TextEncoder()
const named   = pairs => pairs.map(([name, code]) => [encoder.encode(name), code])

const KEYS    = named(KEY_PAIRS)
const KINDS   = named(KIND_PAIRS)
const FOREIGN = named([['Topology', 1], ['displayFieldName', 2]])
const HINTS   = [null, 'topojson', 'esrijson']

// El camino con escapes decodifica y asigna: sólo entra cuando el string TRAJO una barra invertida.
const BY_NAME = new Map([...KEY_PAIRS, ...KIND_PAIRS.map(([name, code]) => [' ' + name, code])])

// Profundidad de `coordinates` por tipo. No identifica al tipo —MultiPoint y LineString comparten 2,
// MultiLineString y Polygon comparten 3— así que sólo valida lo leído contra lo declarado.
const DEPTH_OF = new Uint8Array([0, 1, 2, 2, 3, 3, 4])

// Una línea de un MultiLineString es una sub-geometría, y por lo tanto su propia parte; un anillo de
// un Polygon pertenece al mismo polígono que los demás.
const PART_PER_RING = new Uint8Array([0, 0, 0, 0, 1, 0, 0])

const matches = (bytes, from, to, table) => {
  const len = to - from
  for (let n = 0; n < table.length; n++) {
    const want = table[n][0]
    if (want.length !== len) continue
    let k = len
    while (k-- && bytes[from + k] === want[k]);
    if (k < 0) return table[n][1]
  }
  return 0
}

// El dueño de `x` es el único `i` con `a[i] <= x < a[i+1]`. Las tablas CSR tienen entradas repetidas
// por diseño —una geometría sin posiciones sale con 0 partes— así que la cota tiene que ser superior.
const owner = (table, count, x) => {
  let lo = 0, hi = count
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    table[mid] <= x ? lo = mid + 1 : hi = mid
  }
  return lo - 1
}

const grown = (arr, need) => {
  if (need <= arr.length) return arr
  const next = new arr.constructor(Math.max(need, arr.length * 2))
  next.set(arr)
  return next
}

const POW10 = Array.from({ length: 23 }, (_, k) => Number('1e' + k))
const SPLIT = 134217729                 // 2^27 + 1
const LIMB  = 900719925474099           // el mayor valor al que todavía se le puede anexar un dígito bajo 2^53

// Los dígitos que no entran en la mantisa de 2^53 van a un segundo limbo exacto: el valor es
// `a·10^nb + b`, una suma no evaluada de dos doubles que se divide corrigiendo por el residuo con las
// transformaciones de Dekker. El alcance son ~31 dígitos significativos; pasados, el llamador delega
// en `Number`, al que el estándar obliga a redondear correctamente.
const joinLimbs = (a, b, nb, dec, neg) => {
  const p    = a * POW10[nb]
  const ca   = SPLIT * a, ah = ca - (ca - a), al = a - ah
  const t    = POW10[nb], ct = SPLIT * t, th = ct - (ct - t), tl = t - th
  const perr = ((ah * th - p) + ah * tl + al * th) + al * tl
  const s    = p + b, db = s - p
  const lo   = (p - (s - db)) + (b - db) + perr
  const P    = POW10[dec]
  const q    = s / P
  const cq   = SPLIT * q, qh = cq - (cq - q)
  const cp   = SPLIT * P, ph = cp - (cp - P)
  const qp   = q * P
  const err  = ((qh * ph - qp) + qh * (P - ph) + (q - qh) * ph) + (q - qh) * (P - ph)
  const v    = q + (((s - qp) - err) + lo) / P
  return neg ? -v : v
}

const D_START = 0, D_KEY = 1, D_KIND = 2, D_FEATURE = 3, D_PROP0 = 4, D_PROP1 = 5,
      D_ID0 = 6, D_ID1 = 7, D_VMARK = 8, D_RMARK = 9, D_PMARK = 10, D_SLOTS = 11
const F_ARRAY = 1, F_KEY = 2, F_COORDS = 4, F_COLL = 8, F_THIN = 16

const NUMERIC = new Uint8Array(256)
'0123456789+-.eE'.split('').forEach(c => { NUMERIC[c.charCodeAt(0)] = 1 })

// §17.3-6: por tipo explícito y respetando `byteOffset`. Un `Buffer` de Node vive en un pool
// compartido, así que tomar su `.buffer` entero deja al escáner leyendo memoria de otras asignaciones.
const asBytes = input =>
  ArrayBuffer.isView(input)      ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
  : input instanceof ArrayBuffer ? new Uint8Array(input)
  : typeof input === 'string'    ? encoder.encode(input)
  : null

export const readGeoJson = (input, options = {}) => {
  const bytes = asBytes(input)
  if (bytes === null) throw new GeoJsonError('entrada')

  const len      = bytes.length
  // La otra opción que dimensiona un buffer. `| 0` trunca a int32, así que un valor enorme se aceptaba
  // en silencio y uno absurdo reventaba la asignación: las dos violan §17.10-3.
  const sizeHint = (hint, bytes) => {
    if (hint === undefined || hint === null) return (bytes / 24) | 0
    if (!Number.isInteger(hint) || hint < 1) throw new GeoJsonError('entrada')
    // Se acota a lo que el documento PUEDE contener en vez de a un tope inventado: un vértice no entra
    // en menos de un byte, así que `bytes` ya es cota superior. Es una pista, no una promesa.
    return Math.min(hint, bytes)
  }

  const maxDepth = options.maxDepth ?? 512
  // La cota es una opción del llamador y dimensiona dos buffers, así que un valor absurdo revienta en
  // la asignación. §17.10-3 no admite que salga una excepción cruda: se convierte en la de la entrada.
  if (!Number.isInteger(maxDepth) || maxDepth < 1) throw new GeoJsonError('entrada')
  let stack, flags
  try {
    stack = new Int32Array(maxDepth * D_SLOTS)
    flags = new Uint8Array(maxDepth)
  } catch { throw new GeoJsonError('entrada') }
  const empty    = new Uint32Array(8)
  const position = new Float64Array(3)
  const stats    = {
    openRings: 0, shortRings: 0, degenerateRings: 0, reversedRings: 0, slowNumbers: 0,
    extraOrdinates: 0, emptyGeometries: 0, foreignMembers: 0, bboxSkipped: 0, roots: 0,
  }

  let geometryAt = new Uint32Array(16), partAt = new Uint32Array(16), ringAt = new Uint32Array(16),
      vertexAt = new Uint32Array(16), kinds = new Uint8Array(16), featureOf = new Uint32Array(16),
      closed = new Uint8Array(16), ringArea = new Float64Array(16),
      propAt = new Uint32Array(16), idAt = new Uint32Array(16), z = null,
      xy = new Float64Array(Math.max(32, sizeHint(options.capacityHint, len)) * 2)

  let features = 0, geometries = 0, parts = 0, rings = 0, vertices = 0, roots = 0
  let depth = -1, key = 0, feature = -1, opaque = -1, grew = 0
  let foreign = 0, foreignAt = 0
  let inCoords = 0, posDepth = 0, ringLevel = 0, ordinates = 0, ringStart = 0, ringsHere = 0, area = 0
  let decoder = null
  let i = len >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF ? 3 : 0

  const fail = (code, at, hint) => { throw new GeoJsonError(code, at, hint) }

  // Un elemento de `geometries` sólo es geometría si el objeto que POSEE ese array también lo es: de
  // lo contrario un `"eometry"` mal tipeado seguiría entregando las hojas de su colección.
  // Itera en vez de recursar: `maxDepth` es opción pública y con una cota alta la recursión reventaba
  // el stack —excepción cruda, contra §17.10-3— con un documento de pocos KB.
  const geometryPos = d => {
    for (let n = d; ; n -= 2) {
      if (n === 0) return true
      if ((flags[n] & F_THIN) === 0 && stack[n * D_SLOTS + D_KEY] === K_GEOMETRY) return true
      if (n < 2 || (flags[n - 1] & (F_ARRAY | F_THIN)) !== F_ARRAY) return false
      if (stack[(n - 1) * D_SLOTS + D_KEY] !== K_GEOMETRIES) return false
    }
  }

  // Descartar lo que dejó un `coordinates` que resultó no serlo: duplicado, o miembro ajeno de una
  // colección. Las marcas se toman al abrir cada contenedor.
  const rewind = s => { vertices = stack[s + D_VMARK]; rings = stack[s + D_RMARK]; parts = stack[s + D_PMARK] }

  // `geometries` —o `type: "GeometryCollection"`— vuelve colección al objeto, y §17.3-2 exige que dé
  // igual en qué orden llegó: si se estaban juntando coordenadas eran de un miembro ajeno. Se borra la
  // marca además de deshacer, o un `coordinates` previo dejaría al objeto emitiendo la hoja del vecino.
  const collapse = s => {
    flags[depth] & F_COORDS && (rewind(s), posDepth = ringLevel = ringsHere = 0)
    flags[depth] = (flags[depth] & ~F_COORDS) | F_COLL
  }
  // Un anillo sin vértices entra por acá igual: las guardas de `n` lo dejan sin caja, sin área y sin
  // estadística, que es exactamente lo que corresponde.
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
    rings           = (rings + 1) | 0
    vertexAt[rings] = vertices
    ringsHere       = (ringsHere + 1) | 0
    ringStart       = vertices
    area            = 0
  }

  const closePart = () => {
    ringAt        = grown(ringAt, parts + 2)
    parts         = (parts + 1) | 0
    ringAt[parts] = rings
  }

  const openFeature = d => {
    geometryAt = grown(geometryAt, features + 2)
    geometryAt[features] = geometries
    stack[d * D_SLOTS + D_FEATURE] = features
    feature  = d
    features = (features + 1) | 0
  }

  while (i < len) {
    const c = bytes[i]

    switch (c) {
      // Todo blanco legal de JSON está acá y ningún byte estructural lo está.
      case 32: case 10: case 9: case 13:
        i = (i + 1) | 0
        continue

      case 44:
        (flags[depth] & F_ARRAY) || (flags[depth] |= F_KEY)
        key = 0
        i = (i + 1) | 0
        continue

      case 58:
        flags[depth] &= ~F_KEY
        i = (i + 1) | 0
        continue

      case 123: case 91: {
        depth < 0 && roots++
        depth = (depth + 1) | 0
        depth >= maxDepth && fail('profundidad', i)

        const s = depth * D_SLOTS

        // Un `[` sin clave abierto adentro de `coordinates` es una posición o una lista de anillos:
        // ahí sólo hace falta la PROFUNDIDAD, y hay uno por vértice.
        if (c === 91 && key === 0 && inCoords > 0 && depth > inCoords) {
          flags[depth] = F_ARRAY | F_THIN
          i = (i + 1) | 0
          continue
        }

        const parent = (depth - 1) * D_SLOTS
        stack[s + D_START]   = i
        stack[s + D_KEY]     = key
        stack[s + D_KIND]    = 0
        stack[s + D_FEATURE] = -1
        stack[s + D_PROP0]   = stack[s + D_PROP1] = stack[s + D_ID0] = stack[s + D_ID1] = 0
        stack[s + D_VMARK]   = vertices
        stack[s + D_RMARK]   = rings
        stack[s + D_PMARK]   = parts
        flags[depth] = c === 91 ? F_ARRAY : F_KEY

        key === K_PROPERTIES && opaque < 0 && (opaque = depth)

        const opensCoords = c === 91 && key === K_COORDINATES && opaque < 0 && depth > 0 &&
          !(flags[depth - 1] & F_COLL) && geometryPos(depth - 1)

        // Clave duplicada: gana la última (§17.9), así que lo que dejó la anterior se descarta.
        opensCoords && flags[depth - 1] & F_COORDS && rewind(parent)

        if (opensCoords) {
          flags[depth - 1] |= F_COORDS
          inCoords  = depth
          posDepth  = ringLevel = ordinates = ringsHere = area = 0
          ringStart = vertices
          empty.fill(0)
        }
        key = 0
        i = (i + 1) | 0
        continue
      }

      case 125: case 93: {
        const d = depth
        d < 0 && fail('sintaxis', i)
        ;(c === 93) === ((flags[d] & F_ARRAY) === 0) && fail('sintaxis', i)

        const s   = d * D_SLOTS
        const rel = inCoords > 0 && d >= inCoords ? d - inCoords + 1 : 0

        // Todavía sin nivel de posiciones: no se puede ubicar este contenedor vacío hasta conocer el
        // tipo, así que se anota por profundidad. El nivel 1 no cuenta: un `coordinates: []` es la
        // geometría vacía entera, 0 partes y 0 anillos (§17.9).
        rel >= 2 && !posDepth && rel < 8 && empty[rel]++

        // La posición cierra. Sin `else` con los de abajo: en un Polygon el mismo `]` cierra la lista
        // de anillos Y la única parte, y en un Point cierra la posición Y todo.
        if (rel && rel === posDepth) {
          ordinates < 2 && fail('posicion', i)
          ordinates > 3 && stats.extraOrdinates++

          if ((vertices + 1) * 2 > xy.length) {
            // Se recalibra UNA vez con la densidad real: la semilla es una conjetura, y terminar al
            // 70 % obliga a copiar todo al sellar.
            const estimate = grew || i === 0 ? 0 : ((vertices / i) * len * 1.05) | 0
            const next = new Float64Array(Math.max((vertices + 1) * 2, estimate * 2, xy.length * 2))
            next.set(xy.subarray(0, vertices * 2))
            xy = next
            grew = 1
            z === null || (z = grown(z, next.length >> 1))
          }
          ordinates >= 3 && z === null && (z = new Float64Array(xy.length >> 1).fill(NaN))

          xy[vertices * 2]     = position[0]
          xy[vertices * 2 + 1] = position[1]
          z === null || (z[vertices] = ordinates >= 3 ? position[2] : NaN)
          vertices > ringStart &&
            (area += xy[(vertices - 1) * 2] * position[1] - position[0] * xy[(vertices - 1) * 2 + 1])
          vertices  = (vertices + 1) | 0
          ordinates = 0
        }

        // El anillo cierra. En un Point su nivel ES la raíz de `coordinates`, no `posDepth - 1`.
        rel && rel === ringLevel && closeRing()

        // La parte cierra, y sólo existe explícita en un MultiPolygon: los demás la reparten al emitir.
        rel && posDepth >= 4 && rel === posDepth - 2 && closePart()

        // Sin marco no hay tipo que emitir, ni `inCoords`/`opaque` que cerrar, ni rango de miembro que
        // anotar: todo lo que sigue leería slots que nunca se escribieron.
        if (flags[d] & F_THIN) {
          depth = (d - 1) | 0
          key = 0
          i = (i + 1) | 0
          continue
        }

        const kind = c === 125 && opaque < 0 && geometryPos(d) ? stack[s + D_KIND] : 0

        // Un objeto que trajo `geometries` y ADEMÁS se declara hoja afirma dos cosas incompatibles: que
        // contiene geometrías y que es una. Las dos lecturas pierden algo —quedarse con el tipo tira las
        // hojas que §17.3-11 ya reconoció; quedarse con la estructura tira la hoja que el documento
        // declaró— así que se rechaza, igual que una geometría sin `type` (§17.3-1). El orden en que
        // llegaron los miembros no cambia el veredicto (§17.3-2).
        kind && kind !== COLLECTION && flags[d] & F_COLL && fail('estructura', i)

        // Una colección no emite geometría propia: sus hojas ya salieron aplanadas.
        kind === COLLECTION && (posDepth = ringLevel = ringsHere = 0)
        kind || !(flags[d] & F_COORDS) || c !== 125 || opaque >= 0 || !geometryPos(d) || fail('tipo', i)

        if (kind && kind !== COLLECTION) {
          (flags[d] & F_COORDS) || fail('estructura', i)
          const pd = DEPTH_OF[kind]
          posDepth && posDepth !== pd && fail('estructura', i)

          feature >= 0 || openFeature(0)

          // Contenedores que cerraron vacíos sin que se supiera el nivel: ahora el tipo los ubica.
          for (let k = posDepth || pd < 2 ? 0 : empty[pd - 1]; k > 0; k--) closeRing()
          for (let k = posDepth || pd < 4 ? 0 : empty[pd - 2]; k > 0; k--) closePart()

          // Un MultiLineString reparte una parte POR LÍNEA; los demás meten todos sus anillos en una.
          const spread = PART_PER_RING[kind]
          const upTo   = rings - ringsHere
          for (let k = pd < 4 ? (spread ? ringsHere : (ringsHere > 0 ? 1 : 0)) : 0; k > 0; k--) {
            ringAt        = grown(ringAt, parts + 2)
            parts         = (parts + 1) | 0
            ringAt[parts] = spread ? upTo + (ringsHere - k) + 1 : rings
          }

          kinds     = grown(kinds, geometries + 1)
          featureOf = grown(featureOf, geometries + 1)
          partAt    = grown(partAt, geometries + 2)
          kinds[geometries]     = kind
          featureOf[geometries] = stack[feature * D_SLOTS + D_FEATURE]
          geometries            = (geometries + 1) | 0
          partAt[geometries]    = parts
          partAt[geometries] === partAt[geometries - 1] && stats.emptyGeometries++
          ringsHere = posDepth = ringLevel = 0
        }

        // `posDepth` no se borra al cerrar el array: el emit ocurre al cerrar el OBJETO, un nivel más
        // afuera, y lo necesita para validar la forma contra el tipo.
        inCoords > 0 && d === inCoords && (inCoords = 0)
        opaque === d && (opaque = -1)

        // El rango de un miembro se anota en el objeto que lo CONTIENE: el dueño de `properties` es el
        // feature, no el objeto `properties`.
        const parent = (d - 1) * D_SLOTS
        const held   = d > 0 ? stack[s + D_KEY] : 0
        held === K_PROPERTIES && opaque < 0 &&
          (stack[parent + D_PROP0] = stack[s + D_START], stack[parent + D_PROP1] = i + 1)
        held === K_ID &&
          (stack[parent + D_ID0] = stack[s + D_START], stack[parent + D_ID1] = i + 1)
        held === K_BBOX && i + 1 - stack[s + D_START] > 256 && stats.bboxSkipped++

        if (stack[s + D_FEATURE] >= 0) {
          const f = stack[s + D_FEATURE]
          geometryAt = grown(geometryAt, f + 2)
          propAt     = grown(propAt, f * 2 + 2)
          idAt       = grown(idAt, f * 2 + 2)
          geometryAt[f + 1] = geometries

          // §17.4: el rango del VALOR de `properties` si el miembro existe; si no, el del envolvente.
          const own = stack[s + D_PROP1] > stack[s + D_PROP0]
          propAt[f * 2]     = own ? stack[s + D_PROP0] : stack[s + D_START]
          propAt[f * 2 + 1] = own ? stack[s + D_PROP1] : i + 1
          idAt[f * 2]       = stack[s + D_ID0]
          idAt[f * 2 + 1]   = stack[s + D_ID1]
          feature = -1
        }

        depth = (d - 1) | 0
        key = 0
        i = (i + 1) | 0
        continue
      }

      case 34: {
        const from = i + 1
        let j = from, esc = 0
        while (j < len) {
          const e = bytes[j]
          if (e === 92) { esc = 1; j = (j + 2) | 0; continue }
          if (e === 34) break
          j = (j + 1) | 0
        }
        j >= len && fail('truncado', from)
        depth < 0 && fail('formato', from, HINTS[matches(bytes, from, j, FOREIGN)])
        // Marca de otro formato en la RAÍZ. No alcanza con verla para rechazar —`Topology` puede ser
        // una property cualquiera—: se cobra al sellar, y sólo si el documento no entregó geometría.
        // Sin esto un TopoJSON se lee como cero features y el consumidor ve un mapa en blanco.
        if (depth === 0 && !foreign) foreign = matches(bytes, from, j, FOREIGN), foreignAt = from

        // `"coordinates"` es JSON legal y significa lo mismo. Deshacerlo asigna, así que sólo ocurre
        // cuando el string TRAJO una barra. Una barra que no abre un escape válido es un string mal
        // formado: §17.10-3 exige que salga como GeoJsonError, no como el SyntaxError de `JSON.parse`.
        let text = ''
        if (esc) {
          try { text = JSON.parse(`"${(decoder ??= new TextDecoder()).decode(bytes.subarray(from, j))}"`) }
          catch { fail('sintaxis', from) }
        }

        const s     = depth * D_SLOTS
        const isKey = !(flags[depth] & F_ARRAY) && (flags[depth] & F_KEY)

        if (isKey) {
          key = opaque >= 0 ? 0 : esc ? BY_NAME.get(text) ?? 0 : matches(bytes, from, j, KEYS)
          key || stats.foreignMembers++
          // El feature nace acá: el objeto que POSEE el miembro `geometry` (§17.3-12).
          key === K_GEOMETRY && stack[s + D_FEATURE] < 0 && feature < 0 && openFeature(depth)
          // `geometries` sólo existe en una colección, y una colección no tiene coordenadas propias:
          // si ya se estaban juntando, eran de un miembro ajeno y se descartan.
          key === K_GEOMETRIES && collapse(s)
        } else if (opaque < 0) {
          key === K_TYPE && (stack[s + D_KIND] = esc ? BY_NAME.get(' ' + text) ?? 0 : matches(bytes, from, j, KINDS))
          key === K_TYPE && stack[s + D_KIND] === COLLECTION && collapse(s)
          key === K_ID && (stack[s + D_ID0] = i, stack[s + D_ID1] = j + 1)
          key === K_PROPERTIES && (stack[s + D_PROP0] = i, stack[s + D_PROP1] = j + 1)
          key = 0
        } else key = 0

        i = (j + 1) | 0
        continue
      }

      case 116: case 102: case 110: {
        const n = c === 102 ? 5 : 4
        i + n > len && fail('truncado', i)
        depth < 0 && fail('formato', i)
        key === K_ID && opaque < 0 &&
          (stack[depth * D_SLOTS + D_ID0] = i, stack[depth * D_SLOTS + D_ID1] = i + n)
        key = 0
        i = (i + n) | 0
        continue
      }
    }

    NUMERIC[c] && c !== 43 && c !== 46 && c !== 101 && c !== 69 || fail('sintaxis', i)
    depth < 0 && fail('formato', i)

    const rel = inCoords > 0 ? depth - inCoords + 1 : 0
    let j = i

    // Fuera de una posición el número se atraviesa sin convertirlo: el autómata ya sabe por su estado
    // que este valor no va a ninguna tabla.
    if (!(inCoords > 0 && opaque < 0 && (posDepth === 0 || rel === posDepth))) {
      while (j < len && NUMERIC[bytes[j]]) j = (j + 1) | 0
      // El RFC admite `id` string o NÚMERO; el rango se toma acá igual que en las ramas de string y
      // de literal, que son las otras dos formas que puede tomar el miembro.
      key === K_ID && opaque < 0 &&
        (stack[depth * D_SLOTS + D_ID0] = i, stack[depth * D_SLOTS + D_ID1] = j)
      i = j
      continue
    }

    // Al descubrirse el nivel de las posiciones, los contenedores que cerraron vacíos ANTES ya se
    // pueden ubicar — y se materializan acá para que queden delante de los llenos.
    if (!posDepth) {
      posDepth  = rel
      ringLevel = rel > 1 ? rel - 1 : 1
      for (let k = rel >= 2 ? empty[rel - 1] : 0; k > 0; k--) closeRing()
      for (let k = rel >= 4 ? empty[rel - 2] : 0; k > 0; k--) closePart()
      empty.fill(0)
    }

    const neg = bytes[j] === 45
    neg && (j = (j + 1) | 0)
    let a = 0, b = 0, nb = 0, extra = 0, dec = 0, d = j < len ? bytes[j] : 0
    while (d >= 48 && d <= 57 && a < LIMB) { a = a * 10 + (d - 48); j = (j + 1) | 0; d = j < len ? bytes[j] : 0 }
    while (d >= 48 && d <= 57) {
      nb < 15 ? (b = b * 10 + (d - 48), nb++) : extra++
      j = (j + 1) | 0; d = j < len ? bytes[j] : 0
    }
    if (d === 46) {
      j = (j + 1) | 0
      d = j < len ? bytes[j] : 0
      while (d >= 48 && d <= 57 && a < LIMB && nb === 0) { a = a * 10 + (d - 48); dec = (dec + 1) | 0; j = (j + 1) | 0; d = j < len ? bytes[j] : 0 }
      while (d >= 48 && d <= 57) {
        nb < 15 ? (b = b * 10 + (d - 48), nb++) : extra++
        dec = (dec + 1) | 0; j = (j + 1) | 0; d = j < len ? bytes[j] : 0
      }
    }

    // El corte es el VALOR de la mantisa, no su cantidad de dígitos: con «≤15 dígitos» este camino
    // cubriría el 10 % de lo que emite `JSON.stringify`, y así el 85 %. `nb` y `extra` deciden las tres
    // ramas sin volver a mirar un dígito, que es lo que costaba el respaldo cuando re-escaneaba.
    const exponent = d === 101 || d === 69
    let v = 0
    if (!nb && !exponent && dec <= 22) v = neg ? -(a / POW10[dec]) : a / POW10[dec]
    else {
      stats.slowNumbers++
      if (!extra && !exponent && dec <= 22) v = joinLimbs(a, b, nb, dec, neg)
      else {
        while (j < len && NUMERIC[bytes[j]]) j = (j + 1) | 0
        v = Number((decoder ??= new TextDecoder()).decode(bytes.subarray(i, j)))
      }
    }
    Number.isFinite(v) || fail('numero', i)

    ordinates < 3 && (position[ordinates] = v)
    ordinates = (ordinates + 1) | 0
    i = j
  }

  depth >= 0 && fail('truncado', len)
  roots || fail('sintaxis', 0)
  foreign && geometries === 0 && fail('formato', foreignAt, HINTS[foreign])
  stats.roots = roots

  // Un `coordinates` descartado —duplicado, o miembro ajeno de una colección— pudo traer una tercera
  // ordenada y disparar la reserva de `z`; el rewind deshace sus vértices pero no esa reserva. `z` es
  // del DOCUMENTO (§17.1), así que lo decide lo RETENIDO: sin una sola altitud, el documento era 2D.
  z === null || z.subarray(0, vertices).some(a => !Number.isNaN(a)) || (z = null)
  // El sentido de giro sale del área acumulada al leer los vértices: el anillo 0 de una parte es el
  // exterior, y un área exactamente 0 no tiene sentido de giro que violar.
  for (let g = 0; g < geometries; g++) {
    if (kinds[g] !== 5 && kinds[g] !== 6) continue
    for (let p = partAt[g]; p < partAt[g + 1]; p++)
      for (let r = ringAt[p]; r < ringAt[p + 1]; r++)
        ringArea[r] === 0
          ? stats.degenerateRings++
          : (r === ringAt[p]) === (ringArea[r] < 0) && stats.reversedRings++
  }

  // Caja por geometría: una barrida al sellar, y sólo si se pidió — recorre TODOS los vértices y no
  // se paga sola. El rango de `xy` de una geometría es contiguo (todo se emite en orden), así que
  // alcanza con los extremos de su cadena. Una geometría vacía sale [∞, ∞, −∞, −∞]: el neutro de la
  // unión, y ningún punto la pasa.
  const bounds = options.bounds ? new Float64Array(geometries * 4) : null
  for (let g = 0, n = bounds ? geometries : 0; g < n; g++) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    const to = vertexAt[ringAt[partAt[g + 1]]]
    for (let v = vertexAt[ringAt[partAt[g]]]; v < to; v++) {
      const x = xy[v * 2], y = xy[v * 2 + 1]
      x < minX && (minX = x)
      x > maxX && (maxX = x)
      y < minY && (minY = y)
      y > maxY && (maxY = y)
    }
    bounds[g * 4]     = minX
    bounds[g * 4 + 1] = minY
    bounds[g * 4 + 2] = maxX
    bounds[g * 4 + 3] = maxY
  }

  // Recortar sin copiar cuando el llenado lo justifica: a 8M vértices `slice` son 128 MB de copia.
  const trim = (arr, n) => n * 4 >= arr.length * 3 ? arr.subarray(0, n) : arr.slice(0, n)

  const read = (table, f) => {
    geo.bytes === null && fail('liberado', -1)
    // Fuera de rango no hay miembro que leer. Sin este corte, `table[f*2]` es `undefined`, la guarda
    // de abajo no dispara y `subarray(undefined, undefined)` devuelve el documento entero.
    if (!Number.isInteger(f) || f < 0 || f >= features) return null
    const from = table[f * 2], to = table[f * 2 + 1]
    if (to <= from) return null
    try { return JSON.parse((decoder ??= new TextDecoder()).decode(geo.bytes.subarray(from, to))) }
    catch { return fail('properties', from) }
  }

  const geo = {
    geometryAt: trim(geometryAt, features + 1), partAt: trim(partAt, geometries + 1),
    ringAt: trim(ringAt, parts + 1),            vertexAt: trim(vertexAt, rings + 1),
    kinds: trim(kinds, geometries),             featureOf: trim(featureOf, geometries),
    closed: trim(closed, rings),                xy: trim(xy, vertices * 2),
    propAt: trim(propAt, features * 2),         idAt: trim(idAt, features * 2),
    z: z === null ? null : trim(z, vertices),
    bounds,
    bytes, stats,
    featureCount: features, geometryCount: geometries,
    partCount: parts, ringCount: rings, vertexCount: vertices,

    eachRing: cb => { for (let r = 0; r < rings; r++) cb(r, geo.vertexAt[r], geo.vertexAt[r + 1] - geo.vertexAt[r], geo.partOf(r)) },
    someRing: pred => {
      for (let r = 0; r < rings; r++)
        if (pred(r, geo.vertexAt[r], geo.vertexAt[r + 1] - geo.vertexAt[r], geo.partOf(r))) return true
      return false
    },
    partOf       : ring => owner(geo.ringAt, parts + 1, ring),
    geometryOf   : part => owner(geo.partAt, geometries + 1, part),
    featureOfRing: ring => geo.featureOf[geo.geometryOf(geo.partOf(ring))],
    propertiesOf : f => read(geo.propAt, f),
    idOf         : f => read(geo.idAt, f),
    release      : () => { geo.bytes = null },
  }

  return geo
}

// La geometría de ÁREA del documento (SPECS §17.6): las tablas del lector tal cual —sin copiar un
// solo vértice— más los ids de anillo y de parte de los `Polygon` y `MultiPolygon`. Un documento de
// puros polígonos selecciona todo.
export const areasOf = geo => {
  const { kinds, partAt, ringAt, geometryCount } = geo
  const isArea = g => kinds[g] === GeoJsonKind.Polygon || kinds[g] === GeoJsonKind.MultiPolygon

  let nParts = 0, nRings = 0
  for (let g = 0; g < geometryCount; g++) {
    if (!isArea(g)) continue
    nParts += partAt[g + 1] - partAt[g]
    nRings += ringAt[partAt[g + 1]] - ringAt[partAt[g]]
  }

  const parts = new Uint32Array(nParts)
  const rings = new Uint32Array(nRings)
  let ip = 0, ir = 0
  for (let g = 0; g < geometryCount; g++) {
    if (!isArea(g)) continue
    for (let p = partAt[g]; p < partAt[g + 1]; p++) {
      parts[ip++] = p
      for (let r = ringAt[p]; r < ringAt[p + 1]; r++) rings[ir++] = r
    }
  }

  return {
    xy        : geo.xy,
    vertexAt  : geo.vertexAt,
    ringAt    : geo.ringAt,
    closed    : geo.closed,
    ringCount : geo.ringCount,
    partCount : geo.partCount,
    rings,
    parts,
  }
}
