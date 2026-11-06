// Entry de los LECTORES por especificación (`cristae/formats`): KML/KMZ, GPX, WKT/WKB, TopoJSON,
// EsriJSON, Shapefile y FlatGeobuf → las mismas tablas que `readGeoJson` (SPECS.md §20), más `format`,
// `crs` y capas. Segmento puro como `cristae/geojson`: cero DOM, cero Leaflet, cero Lit, sin efectos al
// importarse; sirve en Node o en un worker.
//
// El constructor de tablas, el tokenizador XML, el escáner JSON, el zip, el `.dbf` y el CRS quedan
// INTERNOS: un test de `entry-surface` congela esta lista.

export { FormatError } from './core/error.js'
export { detectFormat } from './core/detect.js'
export { readKml, readKmz } from './kml.js'
export { readGpx } from './gpx.js'
export { readWkt } from './wkt.js'
export { readWkb } from './wkb.js'
export { readTopoJson } from './topojson.js'
export { readEsriJson } from './esrijson.js'
export { readShapefile, readShapefileZip } from './shapefile.js'
export { readFlatGeobuf } from './flatgeobuf.js'
