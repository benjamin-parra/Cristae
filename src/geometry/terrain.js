// Terreno: las alturas de una caja, cargadas de tiles de altura XYZ. Es un modelo de medida (distancia
// y área sobre el relieve), y de él se lee el relieve de una zona. Es lo único asíncrono del entry y lo
// único que toca la red, siempre por el `fetch` que se le pase. Ningún módulo de medida lo importa, así
// que no entra al bundle de quien no lo usa.
//
// La grilla es la de los tiles en Web Mercator: N = tileSize·2^zoom píxeles por vuelta, y cada píxel es
// una celda cuyo valor rige en su centro. El mosaico cubre la caja con un margen de 2 celdas, que le da
// a toda celda de la caja sus 8 vecinas. Las distancias y las áreas absolutas salen del modelo base,
// por fila (el ancho y el alto de dos celdas y el área de una), así que la pendiente queda en metros
// sobre ese modelo y no hereda la escala de Mercator. Lo que no llega —un tile 404 o 204, un píxel de
// alfa 0— queda NaN y no se rellena con el tile padre: mezclar resoluciones aparentaría un detalle que
// no hay.
import { AREA, ELEVATION, MODEL, RELIEF, byDefault, isModel } from './geodesic.js'
import { coordOf, isPoint } from '../data/path.js'
import { areaStep, foldRings } from './measure.js'
import { readBounds } from './bounds.js'
import { decodeTile } from './raster.js'

const D = Math.PI / 180

// La latitud donde la Mercator de los tiles llega al borde del mundo: atan(sinh π).
const MERCATOR_LIMIT = 85.0511287798066

// Una celda cuenta si su cobertura pasa de esto: lo de abajo es polvo del redondeo de la acumulación.
const DUST = 1e-9

// Proveedores públicos, sin key ni cuenta. Los dos cargan la misma grilla, 2^20 píxeles por vuelta: AWS
// a z12 con tiles de 256 y Mapterhorn a z11 con tiles de 512. Son 1,24″ por píxel, 38 m en el ecuador:
// cerca del 1″ de SRTM y de GLO-30, sin llegar a él.
export const terrainPresets = {
  aws: {
    url         : 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
    encoding    : 'terrarium',
    zoom        : 12,
    maxZoom     : 15,
    tileSize    : 256,
    attribution : 'United States 3DEP (formerly NED) and global GMTED2010 and SRTM terrain data courtesy of the U.S. Geological Survey.',
  },
  mapterhorn: {
    url         : 'https://tiles.mapterhorn.com/{z}/{x}/{y}.webp',
    encoding    : 'terrarium',
    zoom        : 11,
    maxZoom     : 17,
    tileSize    : 512,
    attribution : '© Mapterhorn (https://mapterhorn.com/attribution) · Copernicus GLO-30: © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved',
  },
}

const checkInteger = (name, value, min, max = Infinity) => {
  if (!(Number.isInteger(value) && value >= min && value <= max))
    throw new RangeError(`[terrain] ${name} tiene que ser un entero ${max < Infinity ? `en [${min}, ${max}]` : `≥ ${min}`}: ${value}`)
}

// La fila de una zona que no se puede describir (un vértice inválido o fuera de la caja) o que no tiene
// nada: sin celdas, y las áreas y lo sin dato en `value`, NaN o 0.
const blankRelief = (classes, value) => ({
  cells     : 0,
  elevation : { min: NaN, max: NaN, mean: NaN },
  slope     : { min: NaN, max: NaN, mean: NaN, areas: new Array(classes).fill(value) },
  noData    : value,
})

// La altura bilineal de la grilla en (u, v), en celdas desde el centro de la primera. Un vecino sin
// dato da NaN aunque su peso sea 0 (0·NaN), y una lectura fuera del mosaico —sólo en la fila de borde
// polar— también, porque `heights[k]` ahí es undefined. Pura y sin asignaciones: el camino de `distance`.
const bilinear = (heights, W, u, v) => {
  const i   = Math.floor(u)
  const j   = Math.floor(v)
  const fu  = u - i
  const fv  = v - j
  const k   = j * W + i
  const top = heights[k] + (heights[k + 1] - heights[k]) * fu
  const bot = heights[k + W] + (heights[k + W + 1] - heights[k + W]) * fu
  return top + (bot - top) * fv
}

// El modelo base, si viene, va primero, como en `distance`. Un terreno también se lee en ese lugar,
// para rechazarlo: no es una base, porque sus medidas ya son sobre el relieve. Todo error llega como
// rechazo, y lo síncrono se valida antes de mirar la señal y antes del primer pedido.
export const terrain = async (...args) => {
  const base = isModel(args[0]) ? args.shift() : byDefault
  if (typeof base[AREA] !== 'function' || base[RELIEF])
    throw new TypeError('[terrain] el modelo base tiene que medir áreas y no ser un terreno')
  const [source, bounds, options = {}] = args
  if (typeof source?.url !== 'string' || !['{z}', '{x}', '{y}'].every(key => source.url.includes(key)))
    throw new TypeError('[terrain] source.url tiene que llevar {z}, {x} e {y}')
  const attribution = source.attribution ?? ''
  if (typeof attribution !== 'string') throw new TypeError(`[terrain] attribution tiene que ser un string: ${attribution}`)
  if (source.encoding !== 'terrarium' && source.encoding !== 'mapbox')
    throw new RangeError(`[terrain] encoding desconocido: ${source.encoding}`)
  const { zoom, maxZoom = 24, tileSize: size = 256 } = source
  const { maxTiles = 32, signal, fetch: fetchTile = globalThis.fetch } = options
  checkInteger('maxZoom', maxZoom, 0, 24)
  checkInteger('zoom', zoom, 0, maxZoom)
  checkInteger('tileSize', size, 1)
  checkInteger('maxTiles', maxTiles, 1)
  const box = readBounds(bounds)
  if (!box) throw new TypeError('[terrain] bounds no es una caja')
  if (box.south < -MERCATOR_LIMIT || box.north > MERCATOR_LIMIT)
    throw new RangeError('[terrain] los tiles no cubren más allá de ±85,0511°')

  const { south, west, north, east } = box
  const N     = size * 2 ** zoom
  const X     = lng => (lng + 180) / 360 * N
  const Y     = lat => (0.5 - Math.atanh(Math.sin(lat * D)) / (2 * Math.PI)) * N
  const latOf = y => Math.atan(Math.sinh(Math.PI * (1 - 2 * y / N))) / D
  // Lleva la longitud a [west, west + 360), porque la caja no envuelve, restando un múltiplo de 360: una
  // longitud de la caja queda tal cual, y la de otra copia repite la suma de quien desenvolvió la caja,
  // así que su borde este no sale un ulp al este. Justo debajo de west + 360 puede caer un ulp al oeste
  // de west: por eso `boxed`, el único chequeo de caja, mira los dos lados.
  const inBox = lng => lng - 360 * Math.floor((lng - west) / 360)
  const boxed = (lat, lng) => lat >= south && lat <= north && lng >= west && lng <= east
  const px0   = Math.floor(X(west)) - 2
  const py0   = Math.max(0, Math.floor(Y(north)) - 2)
  // La posición en la grilla, en celdas desde el centro de la primera: el valor de un píxel rige en su
  // centro.
  const gridU = lng => X(lng) - px0 - 0.5
  const gridV = lat => Y(lat) - py0 - 0.5
  const W     = Math.ceil(X(east)) + 2 - px0
  const H     = Math.min(N, Math.ceil(Y(south)) + 2) - py0
  const tx0   = Math.floor(px0 / size)
  const ty0   = Math.floor(py0 / size)
  const cols  = Math.floor((px0 + W - 1) / size) - tx0 + 1
  const tiles = cols * (Math.floor((py0 + H - 1) / size) - ty0 + 1)
  if (tiles > maxTiles)
    throw new RangeError(`[terrain] la caja pide ${tiles} tiles a z=${zoom}; el tope es ${maxTiles}: baja el zoom o sube maxTiles`)
  signal?.throwIfAborted()

  // Por fila j, con la latitud de su centro: `ew` es el ancho de dos celdas y `ns` el alto de dos (de
  // la fila de arriba a la de abajo), los pasos de Horn; `cellArea` es el área de una celda. En
  // Mercator no dependen de la columna, así que se miden en λ = 0.
  const arc      = base[MODEL]
  const heights  = new Float32Array(W * H).fill(NaN)
  const ew       = new Float64Array(H)
  const ns       = new Float64Array(H)
  const cellArea = new Float64Array(H)
  const ring     = Float64Array.of(0, 0, 0, 360 / N, 0, 360 / N, 0, 0)
  for (let j = 0; j < H; j++) {
    const lat = latOf(py0 + j + 0.5)
    ew[j]       = arc(lat, 0, lat, 720 / N)
    ns[j]       = arc(latOf(py0 + j - 0.5), 0, latOf(py0 + j + 1.5), 0)
    ring[0]     = ring[2] = latOf(py0 + j + 1)
    ring[4]     = ring[6] = latOf(py0 + j)
    cellArea[j] = base[AREA](ring, 4)
  }

  // Seis pedidos en vuelo, el tope por host de HTTP/1.1. El primer error aborta los demás, y un tile
  // que termina de decodificar después del corte no escribe. El `fetch` se llama suelto: el del
  // navegador lanza con otro receptor. La señal del consumidor se enlaza a mano y se suelta al final,
  // para no colgar de una señal de vida larga.
  const inner  = new AbortController()
  const abort  = () => inner.abort()
  const wrap   = 2 ** zoom
  let next     = 0
  let served   = 0
  const worker = async () => {
    while (next < tiles && !inner.signal.aborted) {
      const tile    = next++
      const tx      = tx0 + tile % cols
      const ty      = ty0 + Math.floor(tile / cols)
      const url     = source.url.replaceAll('{z}', zoom).replaceAll('{x}', (tx % wrap + wrap) % wrap).replaceAll('{y}', ty)
      const unheard = cause => { throw new Error(`[terrain] ${url} no respondió`, { cause }) }
      const res     = await fetchTile(url, { signal: inner.signal }).catch(unheard)
      if (res.status === 404 || res.status === 204) continue
      if (!res.ok) throw new Error(`[terrain] ${url} respondió ${res.status}`)
      const { width, height, heights: values } = await decodeTile(new Uint8Array(await res.arrayBuffer().catch(unheard)), source.encoding)
        .catch(error => {
          throw error.message.startsWith('[terrain]') ? error : new Error(`[terrain] ${url} no es un tile legible: ${error.message}`, { cause: error })
        })
      if (width !== size || height !== size) throw new Error(`[terrain] ${url} mide ${width}×${height}; se esperaban ${size}×${size}`)
      if (inner.signal.aborted) return

      const x0 = Math.max(px0, tx * size)
      const x1 = Math.min(px0 + W, tx * size + size)
      const y1 = Math.min(py0 + H, ty * size + size)
      for (let y = Math.max(py0, ty * size); y < y1; y++)
        for (let x = x0; x < x1; x++) heights[(y - py0) * W + x - px0] = values[(y - ty * size) * size + x - tx * size]
      served++
    }
  }

  signal?.addEventListener('abort', abort, { once: true })
  try {
    await Promise.all(Array.from({ length: Math.min(6, tiles) }, worker))
    signal?.throwIfAborted()
  } catch (error) {
    throw signal?.aborted ? signal.reason : error
  } finally {
    inner.abort()
    signal?.removeEventListener('abort', abort)
  }
  if (!served) throw new Error(`[terrain] ningún tile de la caja trae datos a z=${zoom}`)

  // La cobertura de una zona ya leída (`polygons[p][0]` es el exterior y lo que sigue sus huecos), por
  // acumulación exacta (Levien, font-rs): da por celda la fracción que la zona cubre, en O(celdas que
  // cruza el borde + celdas de su caja), porque cada arista suma en su fila y la cobertura es la suma
  // corrida. Con k = 1 un anillo suma −S, su shoelace en píxeles, así que cada uno entra con el signo
  // que hace sumar al exterior y restar al hueco, sea cual sea su giro. Llama `visit(w, h, p)` por cada
  // celda que cuenta, con su peso w = cobertura·`cellArea`, su altura y su pendiente de Horn con los
  // pasos de su fila, la razón m/m. Una celda con dato tiene sus 9 alturas: si falta alguna, p es NaN,
  // y una pegada a un tile sin dato pierde la pendiente aunque tenga altura. Devuelve `false`, sin
  // visitar nada, si algún vértice cae fuera de la caja. Un anillo de menos de tres vértices no encierra
  // nada: como en `area`, aporta 0 aunque caiga fuera, así que no entra al chequeo de la caja, y en la
  // cobertura su shoelace es 0 exacto y se salta. Quien visita suma en los campos de un objeto y no en
  // `let` capturados: V8 guarda en una caja nueva cada double que una clausura reescribe, y una
  // asignación por celda duplica el costo.
  const eachCell = (polygons, visit) => {
    let lngMin  = Infinity
    let lngMax  = -Infinity
    let latMin  = Infinity
    let latMax  = -Infinity
    let longest = 0
    for (const rings of polygons)
      for (let r = 0; r < rings.length; r++) {
        const coords = rings[r]
        if (coords.length < 6) continue

        for (let i = 0; i < coords.length; i += 2) {
          const lat = coords[i]
          const lng = inBox(coords[i + 1])
          if (!boxed(lat, lng)) return false
          lngMin = Math.min(lngMin, lng)
          lngMax = Math.max(lngMax, lng)
          latMin = Math.min(latMin, lat)
          latMax = Math.max(latMax, lat)
        }
        longest = Math.max(longest, coords.length)
      }
    if (!longest) return true

    const bx0    = Math.floor(X(lngMin)) - px0
    const by0    = Math.floor(Y(latMax)) - py0
    const bw     = Math.ceil(X(lngMax)) - px0 - bx0
    const bh     = Math.ceil(Y(latMin)) - py0 - by0
    const stride = bw + 2
    const acc    = new Float64Array(stride * bh)
    const xy     = new Float64Array(longest)
    for (const rings of polygons)
      for (let r = 0; r < rings.length; r++) {
        const coords = rings[r]
        const n      = coords.length
        let twice    = 0
        for (let i = 0; i < n; i += 2) {
          xy[i]     = X(inBox(coords[i + 1])) - px0 - bx0
          xy[i + 1] = Y(coords[i]) - py0 - by0
        }
        for (let i = 0; i < n; i += 2) twice += xy[i] * xy[(i + 3) % n] - xy[(i + 2) % n] * xy[i + 1]
        if (!twice) continue

        const k = (r ? -1 : 1) * (twice < 0 ? 1 : -1)
        for (let e = 0; e < n; e += 2) {
          const ax = xy[e]
          const ay = xy[e + 1]
          const bx = xy[(e + 2) % n]
          const by = xy[(e + 3) % n]
          if (ay === by) continue

          const up   = ay < by
          const x0   = up ? ax : bx
          const y0   = up ? ay : by
          const y1   = up ? by : ay
          const dir  = up ? k : -k
          const dxdy = ((up ? bx : ax) - x0) / (y1 - y0)
          let x      = x0
          for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
            const dy  = Math.min(y + 1, y1) - Math.max(y, y0)
            const xn  = x + dxdy * dy
            const d   = dy * dir
            const xa  = Math.min(x, xn)
            const xb  = Math.max(x, xn)
            const i0  = Math.floor(xa)
            const i1  = Math.ceil(xb)
            const row = y * stride
            if (i1 <= i0 + 1) {
              const m = (x + xn) / 2 - i0
              acc[row + i0]     += d - d * m
              acc[row + i0 + 1] += d * m
            } else {
              const s  = 1 / (xb - xa)
              const f0 = xa - i0
              const f1 = xb - i1 + 1
              const a0 = s * (1 - f0) * (1 - f0) / 2
              const am = s * f1 * f1 / 2
              acc[row + i0] += d * a0
              if (i1 === i0 + 2) acc[row + i0 + 1] += d * (1 - a0 - am)
              else {
                const a1 = s * (1.5 - f0)
                acc[row + i0 + 1] += d * (a1 - a0)
                for (let i = i0 + 2; i < i1 - 1; i++) acc[row + i] += d * s
                acc[row + i1 - 1] += d * (1 - (a1 + (i1 - i0 - 3) * s) - am)
              }
              acc[row + i1] += d * am
            }
            x = xn
          }
        }
      }

    for (let j = 0; j < bh; j++) {
      const r   = by0 + j
      let cover = 0
      for (let i = 0; i < bw; i++) {
        cover += acc[j * stride + i]
        if (!(cover > DUST)) continue

        const q     = r * W + bx0 + i
        const above = q - W
        const below = q + W
        const h     = heights[q]
        const gx    = ((heights[above + 1] - heights[above - 1]) / ew[r - 1]
          + 2 * (heights[q + 1] - heights[q - 1]) / ew[r]
          + (heights[below + 1] - heights[below - 1]) / ew[r + 1]) / 4
        const gy    = (heights[below - 1] + 2 * heights[below] + heights[below + 1]
          - heights[above - 1] - 2 * heights[above] - heights[above + 1]) / (4 * ns[r])
        visit(cover * cellArea[r], h, Number.isNaN(h) ? NaN : Math.sqrt(gx * gx + gy * gy))
      }
    }
    return true
  }

  // El relieve. El área absoluta es la del modelo base, A, repartida entre las celdas en proporción a
  // su peso w. Cada celda con dato suma a su clase su peso de superficie, w·√(1 + p²); lo sin dato, el
  // horizontal.
  const reliefCore = (polygons, breaks) => {
    const bins   = new Float64Array(breaks.length + 1)
    const sums   = { cells: 0, weight: 0, lost: 0, sumH: 0, sumP: 0, minH: Infinity, maxH: -Infinity, minP: Infinity, maxP: -Infinity }
    const inside = eachCell(polygons, (w, h, p) => {
      if (Number.isNaN(p)) {
        sums.lost += w
        return
      }

      let k = 0
      while (k < breaks.length && breaks[k] <= p) k++
      bins[k] += w * Math.sqrt(1 + p * p)
      sums.cells++
      sums.weight += w
      sums.sumH   += w * h
      sums.sumP   += w * p
      sums.minH    = Math.min(sums.minH, h)
      sums.maxH    = Math.max(sums.maxH, h)
      sums.minP    = Math.min(sums.minP, p)
      sums.maxP    = Math.max(sums.maxP, p)
    })
    if (!inside) return blankRelief(breaks.length + 1, NaN)

    const { cells, weight, lost, sumH, sumP, minH, maxH, minP, maxP } = sums

    const addRing = areaStep(base[AREA])
    const total   = polygons.reduce((acc, rings) =>
      rings.reduce((part, coords, r) => addRing(part, coords, coords.length / 2, r > 0), acc), 0)
    const scale   = cells ? total / (weight + lost) : 0
    return {
      cells,
      elevation : { min: cells ? minH : NaN, max: cells ? maxH : NaN, mean: sumH / weight },
      slope     : { min: cells ? minP : NaN, max: cells ? maxP : NaN, mean: sumP / weight, areas: Array.from(bins, v => v * scale) },
      noData    : cells ? lost * scale : total,
    }
  }

  // El área de un anillo sobre el relieve: la del modelo base, que es exacta, por el factor medio
  // de superficie de las celdas que cubre, √(1 + p²) ponderado por cobertura. Con una celda que cuenta
  // y no tiene dato, o con un vértice fuera de la caja, es NaN. En terreno plano el factor es 1 exacto,
  // porque las dos sumas son la misma, y el área es la de la base bit a bit.
  const areaCore = (coords, count) => {
    const ring   = coords.subarray(0, count * 2)
    const sums   = { weight: 0, surface: 0 }
    const inside = eachCell([[ring]], (w, h, p) => {
      sums.weight  += w
      sums.surface += w * Math.sqrt(1 + p * p)
    })
    if (!inside) return NaN

    const flat = base[AREA](ring, count)
    return sums.weight ? flat * (sums.surface / sums.weight) : flat
  }

  // La altura en un punto válido, o NaN si cae fuera de la caja.
  const elevationCore = (lat, lng) => {
    const l = inBox(lng)
    return boxed(lat, l) ? bilinear(heights, W, gridU(l), gridV(lat)) : NaN
  }

  // La distancia sobre el relieve. El tramo se muestrea cada media celda en línea recta en píxeles, o
  // sea en Mercator, y cada paso suma la hipotenusa de su parte de la distancia de la base y de su
  // desnivel: sobre una rampa la bilineal es exacta y da la distancia de la base por √(1 + s²) en el
  // sentido de la pendiente. El tramo en Mercator se aparta del geodésico menos que una celda hasta
  // decenas de km (docs/geometry.md da la cifra). El bucle es [0-alloc], sólo números locales; la
  // llamada al modelo base asigna lo que asigne ese modelo (la esfera, nada).
  const modelCore = (lat1, lng1, lat2, lng2) => {
    const l1 = inBox(lng1)
    const l2 = inBox(lng2)
    if (!(boxed(lat1, l1) && boxed(lat2, l2))) return NaN

    const u1   = gridU(l1)
    const v1   = gridV(lat1)
    const du   = gridU(l2) - u1
    const dv   = gridV(lat2) - v1
    const n    = Math.max(1, Math.ceil(2 * Math.sqrt(du * du + dv * dv)))
    const h    = arc(lat1, lng1, lat2, lng2) / n
    let low    = bilinear(heights, W, u1, v1)
    let total  = 0
    for (let k = 1; k <= n; k++) {
      const high = bilinear(heights, W, u1 + du * k / n, v1 + dv * k / n)
      total += Math.sqrt(h * h + (high - low) * (high - low))
      low    = high
    }
    return total
  }

  return Object.freeze({
    [MODEL]     : modelCore,
    [AREA]      : areaCore,
    [ELEVATION] : elevationCore,
    [RELIEF]    : reliefCore,
    bounds      : Object.freeze({ south, west, north, east }),
    zoom,
    cellSize    : ew[H >> 1] / 2,
    attribution,
  })
}

// El relieve de una zona: los cortes se validan acá, la zona se lee con la regla de las medidas y el
// cálculo lo hace el terreno, por su marca, así que sirve con un terreno de otra copia de la librería.
export const relief = (terrain, polygon, breaks = []) => {
  const core = terrain?.[RELIEF]
  if (typeof core !== 'function') throw new TypeError('[relief] el primer argumento tiene que ser un terreno: await terrain(…)')
  if (!Array.isArray(breaks)) throw new TypeError('[relief] breaks tiene que ser un array de cortes')
  if (breaks.findIndex((b, i) => !(Number.isFinite(b) && b >= 0 && !(b <= breaks[i - 1]))) >= 0)
    throw new RangeError('[relief] breaks: números finitos ≥ 0, en orden estrictamente creciente')

  const polygons = foldRings(polygon, (list, coords, count, hole) => {
    if (hole) list.at(-1).push(coords)
    else list.push([coords])
    return list
  }, [])
  return polygons ? core(polygons, Float64Array.from(breaks)) : blankRelief(breaks.length + 1, NaN)
}

// La altura del terreno en un punto, en metros, bilineal sobre la grilla; NaN si el punto no es válido
// o cae fuera de la caja. La lee por su marca, así que sirve con un terreno de otra copia.
export const elevation = (terrain, point) => {
  const core = terrain?.[ELEVATION]
  if (typeof core !== 'function') throw new TypeError('[elevation] el primer argumento tiene que ser un terreno: await terrain(…)')
  return isPoint(point) ? core(coordOf(point, 0), coordOf(point, 1)) : NaN
}
