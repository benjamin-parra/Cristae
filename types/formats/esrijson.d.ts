// Tipos del lector de EsriJSON (`cristae/formats`). Contrato en SPECS.md §20; mantener sincronizado con
// src/formats/esrijson.js.
import type { FormatInput, FormatOptions, FormatRead } from './core'

/**
 * Un `FeatureSet`, un feature suelto o una geometría suelta de la API REST de ArcGIS. Point, Multipoint,
 * Polyline, Polygon y Envelope; los anillos de un Polygon se agrupan por orientación (exterior horario)
 * y contención, y un hoyo sin exterior sale como exterior propio (`stats.orphanHoles`). `hasZ` y `hasM`
 * deciden la tercera ordenada; la M se descarta (`stats.extraOrdinates`). Las curvas suman
 * `stats.skippedGeometries` y el feature queda sin geometría. `spatialReference` (`latestWkid`, `wkid` o
 * `wkt`) declara el CRS; `propertiesOf(f)` hace `JSON.parse` de `attributes` e `idOf(f)` es `null`.
 */
export declare function readEsriJson(input: FormatInput, options?: FormatOptions): FormatRead
