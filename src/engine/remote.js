// Carga de una capa por `url`: descarga, resolución del formato y lectura con el lector que corresponde.
// Los lectores se importan DIFERIDOS, uno por formato: una página que sólo usa GeoJSON no baja el parser
// de KML, y una que no usa `url` no baja ninguno. Es el primer `import(` del repo y es a propósito: la
// alternativa, importarlos de entrada, deja cada lector en el bundle de quien nunca lo invoca.

import { fetchBytes, RemoteError } from '../data/remote-fetch.js'

// Un `import()` por entrada, con la ruta literal: un empaquetador sólo parte en chunks lo que ve escrito.
const LECTORES = {
  geojson         : () => import('../geojson/geojson.js').then(m => m.readGeoJson),
  kml             : () => import('../formats/kml.js').then(m => m.readKml),
  kmz             : () => import('../formats/kml.js').then(m => m.readKmz),
  gpx             : () => import('../formats/gpx.js').then(m => m.readGpx),
  wkt             : () => import('../formats/wkt.js').then(m => m.readWkt),
  wkb             : () => import('../formats/wkb.js').then(m => m.readWkb),
  topojson        : () => import('../formats/topojson.js').then(m => m.readTopoJson),
  esrijson        : () => import('../formats/esrijson.js').then(m => m.readEsriJson),
  // Un `.shp` suelto se lee sin `.dbf`: una URL apunta a un archivo, no a un juego de ellos.
  shapefile       : () => import('../formats/shapefile.js').then(m => bytes => m.readShapefile({ shp: bytes })),
  'shapefile-zip' : () => import('../formats/shapefile.js').then(m => m.readShapefileZip),
  flatgeobuf      : () => import('../formats/flatgeobuf.js').then(m => m.readFlatGeobuf),
}

// Un zip no dice qué lleva: se pide a `detectFormat`.
const DETECTAR = 'zip'

const POR_EXTENSION = {
  geojson: 'geojson', json: 'geojson', kml: 'kml', kmz: 'kmz', gpx: 'gpx', wkt: 'wkt', wkb: 'wkb',
  topojson: 'topojson', zip: DETECTAR, shp: 'shapefile', fgb: 'flatgeobuf',
}

const POR_CONTENT_TYPE = {
  'application/geo+json': 'geojson',
  'application/vnd.google-earth.kml+xml': 'kml',
  'application/vnd.google-earth.kmz': 'kmz',
  'application/gpx+xml': 'gpx',
}

const extensionDe = url => /\.([a-z0-9]+)$/i.exec(url.split(/[?#]/, 1)[0])?.[1].toLowerCase()

const contentTypeDe = headers => {
  const raw = typeof headers?.get === 'function' ? headers.get('content-type') : null
  return typeof raw === 'string' ? POR_CONTENT_TYPE[raw.split(';', 1)[0].trim().toLowerCase()] : undefined
}

const detectar = async bytes => (await import('../formats/core/detect.js')).detectFormat(bytes)

// Un lector que lanza su error propio dice qué y dónde en `code` y `at`; es lo que se reenvía.
const esErrorDeLector = e => e?.name === 'GeoJsonError' || e?.name === 'FormatError'

export const loadRemote = async (url, { format, fetch, signal } = {}) => {
  const { bytes, headers } = await fetchBytes(url, { fetch, signal })

  // Orden: lo que pidió quien llama, la extensión, el Content-Type y, al final, los bytes.
  let name = format ?? POR_EXTENSION[extensionDe(url)] ?? contentTypeDe(headers)
  if (name === undefined || name === DETECTAR) name = await detectar(bytes)
  const load = typeof name === 'string' && Object.hasOwn(LECTORES, name) ? LECTORES[name] : null
  if (load === null) throw new RemoteError('unsupported', url, `${url}: no hay lector para ${name === null || name === undefined ? 'este contenido' : `'${name}'`}`)

  const reader = await load()
  signal?.throwIfAborted?.()
  try {
    // Los lectores no son cancelables: abortar corta la descarga y descarta el resultado, pero no el parseo que ya
    // corre. El piso de `refresh` (1000 ms) acota cuántas lecturas solapadas puede acumular un archivo pesado.
    const read = await reader(bytes)
    signal?.throwIfAborted?.()
    return { read, format: name }
  } catch (e) {
    if (!esErrorDeLector(e)) throw e
    throw new RemoteError('format', url, `${url}: ${e.code}${e.at >= 0 ? ` (byte ${e.at})` : ''}`)
  }
}
