// Tipos del lector de WKT y EWKT (`cristae/formats`). Contrato en SPECS.md §19; mantener sincronizado
// con src/formats/wkt.js.
import type { FormatOptions, FormatRead } from './core'

/** Texto (`string`) o sus bytes UTF-8. */
export type WktInput = string | Uint8Array | ArrayBuffer | ArrayBufferView

/**
 * Una o más geometrías WKT separadas por espacio en blanco o `;`; cada una es un feature y
 * `stats.roots` las cuenta. `SRID=n;` declara el CRS y debe ser el mismo en todas. Las curvas de
 * SQL/MM son `'tipo'`. La M se descarta y se cuenta en `stats.extraOrdinates`.
 */
export declare function readWkt(input: WktInput, options?: FormatOptions): FormatRead
