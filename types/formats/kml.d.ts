// Tipos de los lectores de KML 2.2 y KMZ (`cristae/formats`). Contrato en SPECS.md §19; mantener
// sincronizado con src/formats/kml.js.
import type { FormatInput, FormatOptions, FormatRead } from './core'

/**
 * KML 2.2 (OGC 07-147r2). `Point`, `LineString`, `LinearRing` suelto (LineString), `Polygon` y
 * `MultiGeometry` aplanada. `Document` y `Folder` forman `layers`. `propertiesOf(f)` devuelve
 * `{ name, description, styleUrl, ...Data, ...SimpleData }` con los presentes; `idOf(f)` el atributo
 * `id` del `Placemark`. Sin DTD (`'dtd'`), sólo entidades predefinidas, y `1, 2` es `'posicion'`.
 * `xy` sale en WGS84 `[lon, lat]` y `crs` es `'EPSG:4326'`.
 */
export declare function readKml(input: FormatInput, options?: FormatOptions): FormatRead

/**
 * KMZ: lee `doc.kml` de la raíz del zip o, si no está, la primera entrada `.kml`. Asíncrono por el
 * inflado; la promesa rechaza con `FormatError`. `bytes` es el KML inflado y `at` un offset en él.
 * `maxBytes` acota lo que se infla (`'tope'`).
 */
export declare function readKmz(input: Uint8Array | ArrayBuffer | ArrayBufferView, options?: FormatOptions): Promise<FormatRead>
