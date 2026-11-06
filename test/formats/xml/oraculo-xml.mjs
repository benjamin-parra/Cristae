// Oráculo de KML y GPX (DISENO-INTEROP §5-2): recorre el árbol del `DOMParser` de jsdom y arma las
// mismas tablas CSR que los lectores, con las reglas de §3.1 y §3.2 escritas de nuevo y sin compartir
// código con ellos. Es deliberadamente ingenuo: arrays comunes, recursión y `Number` sobre cada token.
//
// Sólo arbitra documentos bien formados y legales: los errores se asiertan por código en el corpus.

import { JSDOM } from 'jsdom'

const { DOMParser } = new JSDOM('').window

export const parsearXml = texto => {
  const doc = new DOMParser().parseFromString(texto, 'application/xml')
  if (doc.getElementsByTagName('parsererror').length) throw new Error('el oráculo no arbitra XML mal formado')
  return doc
}

const hijos   = el => Array.from(el.children)
const local   = el => el.localName
const hijo    = (el, nombre) => hijos(el).find(h => local(h) === nombre)
const delTodo = el => hijos(el).filter(h => local(h) === 'coordinates')

const nuevaLectura = () => ({
  geometryAt: [0], partAt: [0], ringAt: [0], vertexAt: [0], kinds: [], featureOf: [], closed: [],
  xy: [], z: [], layerOf: [], layers: [],
  stats: { openRings: 0, shortRings: 0, degenerateRings: 0, reversedRings: 0, extraOrdinates: 0,
           emptyGeometries: 0, foreignMembers: 0, skippedGeometries: 0 },
  feature: -1,
})

// Un anillo ya escrito en `xy`: `closed`, abiertos, cortos y área firmada con el cierre implícito.
const cerrarAnillo = (L, desde) => {
  const hasta = L.xy.length / 2
  const n     = hasta - desde
  const igual = n >= 2 && [0, 1].every(k => Object.is(L.xy[desde * 2 + k], L.xy[(hasta - 1) * 2 + k])) &&
                Object.is(L.z[desde], L.z[hasta - 1])
  n >= 2 && !igual && L.stats.openRings++
  n >= 1 && n < 4 && L.stats.shortRings++
  let area = 0
  for (let v = desde; n >= 3 && v < hasta; v++) {
    const w = v + 1 < hasta ? v + 1 : desde
    area += L.xy[v * 2] * L.xy[w * 2 + 1] - L.xy[w * 2] * L.xy[v * 2 + 1]
  }
  L.closed.push(igual ? 1 : 0)
  L.vertexAt.push(hasta)
  return area
}

// `partes`: lista de partes, cada una lista de anillos, cada anillo lista de posiciones [x, y, z].
const emitir = (L, kind, partes) => {
  partes.forEach(anillos => {
    anillos.forEach((posiciones, r) => {
      const desde = L.xy.length / 2
      posiciones.forEach(([x, y, z]) => {
        L.xy.push(x, y)
        L.z.push(z)
      })
      const area = cerrarAnillo(L, desde)
      if (kind !== 5 && kind !== 6) return
      area === 0 ? L.stats.degenerateRings++ : (r === 0) === (area < 0) && L.stats.reversedRings++
    })
    L.ringAt.push(L.vertexAt.length - 1)
  })
  partes.length || L.stats.emptyGeometries++
  L.partAt.push(L.ringAt.length - 1)
  L.kinds.push(kind)
  L.featureOf.push(L.feature)
}

const abrirFeature = (L, capa) => {
  L.feature = L.layerOf.length
  L.layerOf.push(capa)
}

const sellar = L => {
  const geometrias = L.kinds.length
  for (let f = 0; f < L.layerOf.length; f++)
    L.geometryAt.push(L.featureOf.filter(g => g <= f).length)
  const conZ = L.z.some(v => !Number.isNaN(v))
  return {
    geometryAt    : Uint32Array.from(L.geometryAt),
    partAt        : Uint32Array.from(L.partAt),
    ringAt        : Uint32Array.from(L.ringAt),
    vertexAt      : Uint32Array.from(L.vertexAt),
    kinds         : Uint8Array.from(L.kinds),
    featureOf     : Uint32Array.from(L.featureOf),
    closed        : Uint8Array.from(L.closed),
    xy            : Float64Array.from(L.xy),
    z             : conZ ? Float64Array.from(L.z) : null,
    layerOf       : Uint32Array.from(L.layerOf),
    layers        : L.layers.length ? L.layers : [{ name: null, parent: -1 }],
    stats         : L.stats,
    featureCount  : L.layerOf.length,
    geometryCount : geometrias,
    partCount     : L.partAt.at(-1),
    ringCount     : L.ringAt.at(-1),
    vertexCount   : L.xy.length / 2,
  }
}

// ── KML (OGC 07-147r2) ─────────────────────────────────────────────────────────────────────────

// `lon,lat[,alt]` separadas por espacio en blanco; el corpus legal no trae espacios dentro de una tupla.
const tuplasKml = (L, el) => el.textContent.trim().split(/\s+/).filter(Boolean).map(tupla => {
  const n = tupla.split(',').map(Number)
  n.length > 3 && L.stats.extraOrdinates++
  return [n[0], n[1], n.length > 2 ? n[2] : NaN]
})

const ATRIBUTOS_PLACEMARK = new Set(['name', 'description', 'styleUrl', 'ExtendedData'])
const SALTADAS            = new Set(['Model', 'Track', 'MultiTrack'])

const geometriaKml = (L, el) => {
  const nombre = local(el)
  const coords = () => delTodo(el)[0]
  const ajenos = permitidos => hijos(el).forEach(h => permitidos.includes(local(h)) || L.stats.foreignMembers++)

  if (nombre === 'Point' || nombre === 'LineString' || nombre === 'LinearRing') {
    ajenos(['coordinates'])
    const posiciones = coords() ? tuplasKml(L, coords()) : []
    return emitir(L, nombre === 'Point' ? 1 : 3, posiciones.length ? [[posiciones]] : [])
  }
  if (nombre === 'Polygon') {
    ajenos(['outerBoundaryIs', 'innerBoundaryIs'])
    const anillos = []
    hijos(el).filter(h => local(h) === 'outerBoundaryIs' || local(h) === 'innerBoundaryIs').forEach(borde => {
      hijos(borde).forEach(h => local(h) === 'LinearRing' || L.stats.foreignMembers++)
      hijos(borde).filter(h => local(h) === 'LinearRing').forEach(anillo => {
        hijos(anillo).forEach(h => local(h) === 'coordinates' || L.stats.foreignMembers++)
        const c = hijo(anillo, 'coordinates')
        anillos.push(c ? tuplasKml(L, c) : [])
      })
    })
    return emitir(L, 5, anillos.length ? [anillos] : [])
  }
  if (nombre === 'MultiGeometry') return hijos(el).forEach(h => geometriaKml(L, h))
  SALTADAS.has(nombre) ? L.stats.skippedGeometries++ : L.stats.foreignMembers++
}

const contenedorKml = (L, el, capa) => hijos(el).forEach(h => {
  const nombre = local(h)
  if (nombre === 'Document' || nombre === 'Folder') {
    const nueva = L.layers.push({ name: hijo(h, 'name')?.textContent ?? null, parent: capa }) - 1
    return contenedorKml(L, h, nueva)
  }
  if (nombre === 'Placemark') {
    capa < 0 && (capa = L.raiz ??= L.layers.push({ name: null, parent: -1 }) - 1)
    abrirFeature(L, capa)
    return hijos(h).forEach(g => ATRIBUTOS_PLACEMARK.has(local(g)) || geometriaKml(L, g))
  }
  nombre === 'name' && capa >= 0 && el !== L.documento || L.stats.foreignMembers++
})

export const oraculoKml = texto => {
  const raiz = parsearXml(texto).documentElement
  const L    = nuevaLectura()
  L.documento = raiz
  contenedorKml(L, raiz, -1)
  return sellar(L)
}

// ── GPX 1.1 (gpx.xsd) ──────────────────────────────────────────────────────────────────────────

const ATRIBUTOS_GPX = new Set(['name', 'cmt', 'desc', 'src', 'link', 'type', 'number'])

const puntoGpx = (L, el, atributosPropios) => {
  hijos(el).forEach(h => local(h) === 'ele' || (atributosPropios && ATRIBUTOS_GPX.has(local(h))) || L.stats.foreignMembers++)
  const ele = hijo(el, 'ele')
  return [Number(el.getAttribute('lon')), Number(el.getAttribute('lat')), ele ? Number(ele.textContent) : NaN]
}

export const oraculoGpx = texto => {
  const raiz = parsearXml(texto).documentElement
  const L    = nuevaLectura()
  hijos(raiz).forEach(el => {
    const nombre = local(el)
    if (nombre === 'wpt') {
      abrirFeature(L, 0)
      return emitir(L, 1, [[[puntoGpx(L, el, true)]]])
    }
    if (nombre === 'rte') {
      abrirFeature(L, 0)
      hijos(el).forEach(h => local(h) === 'rtept' || ATRIBUTOS_GPX.has(local(h)) || L.stats.foreignMembers++)
      const puntos = hijos(el).filter(h => local(h) === 'rtept').map(p => puntoGpx(L, p, false))
      return emitir(L, 3, puntos.length ? [[puntos]] : [])
    }
    if (nombre === 'trk') {
      abrirFeature(L, 0)
      hijos(el).forEach(h => local(h) === 'trkseg' || ATRIBUTOS_GPX.has(local(h)) || L.stats.foreignMembers++)
      const segmentos = hijos(el).filter(h => local(h) === 'trkseg').map(s => {
        hijos(s).forEach(h => local(h) === 'trkpt' || L.stats.foreignMembers++)
        return [hijos(s).filter(h => local(h) === 'trkpt').map(p => puntoGpx(L, p, false))]
      })
      return emitir(L, 4, segmentos)
    }
    L.stats.foreignMembers++
  })
  return sellar(L)
}
