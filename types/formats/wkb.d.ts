// Tipos del lector de WKB y EWKB (`cristae/formats`). Contrato en SPECS.md §20; mantener sincronizado
// con src/formats/wkb.js.
import type { FormatOptions, FormatRead } from './core'

/** Bytes, o un `string` que es su HEXADECIMAL (la salida de PostGIS), nunca texto WKT. */
export type WkbInput = string | Uint8Array | ArrayBuffer | ArrayBufferView

/**
 * Una geometría y un feature. El byte de orden se respeta en cada sub-geometría; se aceptan los
 * tipos ISO (+1000 Z, +2000 M, +3000 ZM) y las banderas de EWKB, con su SRID. `POINT EMPTY` (x e y
 * en NaN) es una geometría de 0 partes. Bytes de más después de la geometría son `'estructura'`.
 */
export declare function readWkb(input: WkbInput, options?: FormatOptions): FormatRead
