// Formatos de `cristae/formats` en el mapa: `detectFormat` elige el lector por los bytes, la lectura
// sale en las tablas de `readGeoJson` y la dibujan las capas de siempre. Las muestras salen del corpus de
// test/formats/; KMZ, Shapefile, WKB y FlatGeobuf no tienen archivo en el corpus y se arman con los
// escritores de prueba, en el navegador. NO es código de la librería: es QC visual (examples/).

import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { MapEngine, adoptLeafletHost, shapePresetIconSet } from '../src/index.js'
import { readGeoJson, areasOf, GeoJsonKind } from '../src/geojson/index.js'
import {
  detectFormat, FormatError, readKml, readKmz, readGpx, readWkt, readWkb, readTopoJson, readEsriJson,
  readShapefile, readShapefileZip, readFlatGeobuf,
} from '../src/formats/index.js'
import { zip } from '../test/formats/kml/zip-de-prueba.mjs'
import { escribirShp, escribirDbf, escribirZip } from '../test/formats/shapefile/escritor.mjs'
import { escribirFgb } from '../test/formats/flatgeobuf/escritor.mjs'
import { escribirWkb } from '../test/formats/wkb/generador.mjs'
import kmlCarpetas from '../test/formats/kml/corpus/felices/carpetas-anidadas.kml?raw'
import kmlTruncado from '../test/formats/kml/corpus/adversarios/truncado.kml?raw'
import gpxCompleto from '../test/formats/gpx/corpus/felices/completo.gpx?raw'
import gpxDtd from '../test/formats/gpx/corpus/adversarios/dtd.gpx?raw'
import topoCapas from '../test/formats/topojson/corpus/felices/capas.json?raw'
import topoFuera from '../test/formats/topojson/corpus/adversarios/indice-fuera-de-rango.json?raw'
import esriPoligonos from '../test/formats/esrijson/corpus/felices/featureset-poligonos.json?raw'
import esriTruncado from '../test/formats/esrijson/corpus/adversarios/truncado.json?raw'

const CENTER = [-37, -72]
const AREA   = '#22d3ee'
const LINEA  = '#f59e0b'
const PUNTO  = '#f472b6'

const $   = id => document.getElementById(id)
const utf = s => new TextEncoder().encode(s)
const log = msg => { $('log').textContent = msg + '\n' + $('log').textContent }

/* ── Mapa + motor ────────────────────────────────────────────────────────────────────────────────── */

const map    = L.map('map', { center: CENTER, zoom: 6, preferCanvas: true, zoomControl: true })
const engine = new MapEngine({ host: adoptLeafletHost(map, { leaflet: L }) })
await engine.ready
engine.setTileProvider({ url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', maxZoom: 19, attribution: '© OpenStreetMap' })

const iconSet = shapePresetIconSet({ shape: 'dot', size: 12 })

/* ── Lectores ────────────────────────────────────────────────────────────────────────────────────── */

// Lo que devuelve `detectFormat` → el lector. `zip` sin `.kml` ni `.shp` no tiene lector: cae al error.
const LECTOR = {
  kml             : readKml,
  kmz             : readKmz,
  gpx             : readGpx,
  wkt             : readWkt,
  wkb             : readWkb,
  topojson        : readTopoJson,
  esrijson        : readEsriJson,
  geojson         : readGeoJson,
  shapefile       : shp => readShapefile({ shp }),
  'shapefile-zip' : readShapefileZip,
  flatgeobuf      : readFlatGeobuf,
}

/* ── Muestras ────────────────────────────────────────────────────────────────────────────────────── */

const feature = (geometry, properties = {}) => ({ type: 'Feature', geometry, properties })

// Exterior horario y hoyo antihorario: la convención de Shapefile y EsriJSON (§2.4).
const RODAL = { type: 'Polygon', coordinates: [
  [[-72, -37], [-72, -36], [-71, -36], [-71, -37], [-72, -37]],
  [[-71.8, -36.8], [-71.2, -36.8], [-71.2, -36.2], [-71.8, -36.2], [-71.8, -36.8]],
] }
const CAMINO = { type: 'LineString', coordinates: [[-73, -38], [-72.4, -37.6], [-71.9, -37.9], [-71.2, -37.4]] }

const kmz = () => zip([['doc.kml', utf(kmlCarpetas), 8]])
const shz = () => escribirZip([
  { nombre: 'rodales.shp', bytes: escribirShp({ features: [feature(RODAL)] }) },
  { nombre: 'rodales.dbf', bytes: escribirDbf([{ nombre: 'NOMBRE', tipo: 'C', largo: 20 }], [['Rodal 1']]) },
])
const fgb = () => escribirFgb({ features: [feature(CAMINO, { nombre: 'Camino 4' })] }, { columnas: [{ nombre: 'nombre', tipo: 11 }] })
const wkb = () => escribirWkb({ type: 'GeometryCollection', geometries: [CAMINO, { type: 'Point', coordinates: [-72.5, -36.5] }] })

const corta = bytes => bytes.slice(0, Math.floor(bytes.length * 0.6))

// [nombre, lector, muestra, corrupta]: cada muestra, una función que da los bytes (o el texto). El lector
// va explícito porque una corrupta puede no dejarse detectar —un zip truncado ya no lista sus entradas—,
// y lo que se prueba ahí es el error del lector, no el de la detección.
const MUESTRAS = [
  ['KML', 'kml', () => kmlCarpetas, () => kmlTruncado],
  ['KMZ', 'kmz', kmz, () => zip([['doc.kml', utf(kmlCarpetas), 8]], { crc: 0 })],
  ['GPX', 'gpx', () => gpxCompleto, () => gpxDtd],
  ['WKT', 'wkt', () => 'GEOMETRYCOLLECTION(POINT(-72.5 -36.5), LINESTRING(-73 -38, -72 -37), POLYGON((-72 -37, -71 -37, -71 -36, -72 -36, -72 -37)))',
    () => 'POLYGON((-72 -37, -71 -37, -71 -36'],
  ['WKB', 'wkb', wkb, async () => corta(wkb())],
  ['TopoJSON', 'topojson', () => topoCapas, () => topoFuera],
  ['EsriJSON', 'esrijson', () => esriPoligonos, () => esriTruncado],
  ['Shapefile zip', 'shapefile-zip', shz, async () => corta(await shz())],
  ['FlatGeobuf', 'flatgeobuf', fgb, async () => corta(fgb())],
]

/* ── Lectura y dibujo ────────────────────────────────────────────────────────────────────────────── */

let capas = []

const limpiar = () => {
  capas.forEach(id => engine.removeLayer(id))
  capas = []
  $('error').style.display = 'none'
  ;['formato', 'crs', 'nFeatures', 'nGeometrias', 'nPartes', 'nAnillos', 'nVertices', 'dibujado', 'capas', 'ms']
    .forEach(id => $(id).textContent = '—')
}

const mostrarError = e => {
  const caja = $('error')
  caja.style.display = 'block'
  caja.innerHTML = e instanceof FormatError
    ? `<code>FormatError</code> · lector <b>${e.format}</b> · código <code>${e.code}</code> · byte ${e.at}${e.hint ? ` · se parece a ${e.hint}` : ''}`
    : `<code>${e.name}</code> · ${e.code ? `código <code>${e.code}</code> · ` : ''}${e.message}`
  log(`error: ${e.message}`)
}

// Las líneas y los puntos se recorren por anillo: en una línea el anillo es el tramo, y en un punto, su
// único vértice. Las áreas no pasan por acá: las dibuja la capa de polígonos con `areasOf`.
const dibujar = read => {
  const lineas = []
  const puntos = []
  const { xy, kinds } = read
  read.eachRing((ring, first, count, part) => {
    const kind = kinds[read.geometryOf(part)]
    const path = Array.from({ length: count }, (_, k) => [xy[(first + k) * 2 + 1], xy[(first + k) * 2]])
    kind === GeoJsonKind.LineString || kind === GeoJsonKind.MultiLineString
      ? lineas.push({ id: ring, path })
      : kind === GeoJsonKind.Point || kind === GeoJsonKind.MultiPoint
        ? path.forEach(([lat, lng], k) => puntos.push({ id: `${ring}-${k}`, lat, lng }))
        : null
  })
  const areas = areasOf(read)

  areas.rings.length && capas.push(engine.addPolygonLayer({ id: 'areas', geometry: areas, color: AREA, weight: 2, fillOpacity: 0.3 }).id)
  lineas.length && capas.push(engine.addLineLayer({ id: 'lineas', data: lineas,
    accessors: { idOf: l => l.id, pathOf: l => l.path, styleOf: () => ({ color: LINEA, weight: 3 }) } }).id)
  puntos.length && capas.push(engine.addPointLayer({ id: 'puntos', data: puntos, iconSet,
    accessors: { idOf: p => p.id, positionOf: p => ({ lat: p.lat, lng: p.lng }), variantOf: () => PUNTO } }).id)

  // Encuadre por los vértices: la lectura sin `bounds` no trae caja.
  if (read.vertexCount) {
    let s = 90, w = 180, n = -90, e = -180
    for (let v = 0; v < read.vertexCount; v++) {
      w = Math.min(w, xy[v * 2]); e = Math.max(e, xy[v * 2])
      s = Math.min(s, xy[v * 2 + 1]); n = Math.max(n, xy[v * 2 + 1])
    }
    map.fitBounds([[s, w], [n, e]], { paddingTopLeft: [400, 40], paddingBottomRight: [40, 40], maxZoom: 12, animate: false })   // el panel tapa la izquierda
  }
  return `${areas.parts.length} · ${lineas.length} · ${puntos.length}`
}

const informar = (read, ms, dibujado) => {
  $('crs').textContent         = read.crs ?? 'sin declarar'
  $('nFeatures').textContent   = String(read.featureCount)
  $('nGeometrias').textContent = String(read.geometryCount)
  $('nPartes').textContent     = String(read.partCount)
  $('nAnillos').textContent    = String(read.ringCount)
  $('nVertices').textContent   = String(read.vertexCount)
  $('dibujado').textContent    = dibujado
  $('capas').textContent       = read.layers ? read.layers.map(c => c.name ?? '∅').join(' / ') : '—'
  $('ms').textContent          = ms.toFixed(2)
  const stats = Object.entries(read.stats).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(' ')
  const props = read.featureCount ? JSON.stringify(read.propertiesOf(0)) : '—'
  log(`${read.format ?? 'geojson'}: stats ${stats || '—'}\n  propiedades de la feature 0: ${props}`)
}

// `entrada`: bytes o texto, o `{ shp, dbf?, prj?, cpg? }` cuando llegan los archivos sueltos de un Shapefile.
// `lector` fuerza uno (las muestras); si la detección dice otra cosa, se muestran los dos.
const cargar = async (origen, entrada, lector) => {
  limpiar()
  $('origen').textContent = origen
  const suelto  = entrada.shp !== undefined
  const formato = suelto ? 'shapefile' : detectFormat(entrada)
  const usado   = lector ?? formato
  $('formato').textContent = (formato ?? 'no reconocido') + (usado === formato ? '' : ` → se lee como ${usado}`)
  const leer = suelto ? readShapefile : LECTOR[usado]
  if (!leer) return mostrarError(new Error(formato === 'zip' ? 'zip sin .kml ni .shp' : 'formato no reconocido'))
  try {
    const t0   = performance.now()
    const read = await leer(entrada)
    const ms   = performance.now() - t0
    informar(read, ms, dibujar(read))
  } catch (e) {
    mostrarError(e)
  }
}

/* ── Entrada: archivos y muestras ────────────────────────────────────────────────────────────────── */

const bytesDe = async file => new Uint8Array(await file.arrayBuffer())
const extension = file => file.name.slice(file.name.lastIndexOf('.') + 1).toLowerCase()

const recibir = async files => {
  if (!files.length) return
  const shp = files.find(f => extension(f) === 'shp')
  if (files.length === 1 || !shp) return cargar(files[0].name, await bytesDe(files[0]))
  const pieza = async ext => (f => f && bytesDe(f))(files.find(f => extension(f) === ext))
  const [dbf, prj, cpg] = await Promise.all(['dbf', 'prj', 'cpg'].map(pieza))
  return cargar(files.map(f => f.name).join(' + '), { shp: await bytesDe(shp), dbf, prj, cpg })
}

const zona = $('zona')
$('archivo').onchange = e => recibir([...e.target.files])
zona.ondragover  = e => { e.preventDefault(); zona.classList.add('sobre') }
zona.ondragleave = () => zona.classList.remove('sobre')
zona.ondrop      = e => {
  e.preventDefault()
  zona.classList.remove('sobre')
  recibir([...e.dataTransfer.files])
}

const boton = (texto, clase, accion) => {
  const b = document.createElement('button')
  b.textContent = texto
  b.className   = clase
  b.onclick     = accion
  return b
}

MUESTRAS.forEach(([nombre, lector, sana, rota]) => {
  const etiqueta = document.createElement('span')
  etiqueta.textContent = nombre
  $('muestras').append(
    etiqueta,
    boton('muestra', 'buena', async () => cargar(`${nombre} · muestra`, await sana(), lector)),
    boton('corrupta', 'mala', async () => cargar(`${nombre} · corrupta`, await rota(), lector)),
  )
})
