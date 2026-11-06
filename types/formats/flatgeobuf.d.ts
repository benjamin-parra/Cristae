// Tipos del lector de FlatGeobuf (`cristae/formats`). Contrato en SPECS.md §20; mantener sincronizado
// con src/formats/flatgeobuf.js.
import type { FormatOptions, FormatRead } from './core'

export type FlatGeobufInput = Uint8Array | ArrayBuffer | ArrayBufferView

/**
 * Síncrono y secuencial: el índice se salta. Versión mayor 3. `propertiesOf(f)` devuelve
 * `{ columna: valor }` según `Header.columns`: enteros y reales como `number` (los de 64 bits como
 * `bigint` si no caben exactos), `Bool` como `boolean`, `String`, `Json` y `DateTime` como texto y
 * `Binary` como `Uint8Array` copiado. Curvas, superficies y TIN se saltan y suman `skippedGeometries`.
 */
export declare function readFlatGeobuf(input: FlatGeobufInput, options?: FormatOptions): FormatRead
