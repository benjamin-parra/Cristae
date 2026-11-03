// Tipos del entry `cristae/formats` (lectores por especificación: bytes → las tablas de `readGeoJson`,
// más `format`, `crs` y capas). Segmento puro: no toca DOM, Leaflet, Lit ni el núcleo de datos.
// Contrato en SPECS.md §19; mantener sincronizado con src/formats/index.js.

export type {
  FormatReader, FormatName, FormatInput, FormatOptions, FormatErrorCode, FormatStats, FormatLayer, FormatRead,
} from './formats/core'
export type { WktInput } from './formats/wkt'
export type { WkbInput } from './formats/wkb'
export type { TopoJsonOptions } from './formats/topojson'
export type { ShapefileBytes, ShapefileFiles, ShapefileOptions } from './formats/shapefile'
export type { FlatGeobufInput } from './formats/flatgeobuf'

export { FormatError, detectFormat } from './formats/core'
export { readKml, readKmz } from './formats/kml'
export { readGpx } from './formats/gpx'
export { readWkt } from './formats/wkt'
export { readWkb } from './formats/wkb'
export { readTopoJson } from './formats/topojson'
export { readEsriJson } from './formats/esrijson'
export { readShapefile, readShapefileZip } from './formats/shapefile'
export { readFlatGeobuf } from './formats/flatgeobuf'
