// Tipos del lector de GPX 1.1 (`cristae/formats`). Contrato en SPECS.md §19; mantener sincronizado con
// src/formats/gpx.js.
import type { FormatInput, FormatOptions, FormatRead } from './core'

/**
 * GPX 1.1 (y 1.0 por nombre local). Cada `wpt` es un Point, cada `rte` un LineString y cada `trk` un
 * MultiLineString con una parte por `trkseg`. `ele` va a `z`; `time` y `extensions` se cuentan en
 * `stats.foreignMembers`. `propertiesOf(f)` devuelve `{ name, cmt, desc, src, type, number, link }`
 * con los presentes (`link` es el `href` del primero); `idOf` es `null`. Una sola capa.
 */
export declare function readGpx(input: FormatInput, options?: FormatOptions): FormatRead
