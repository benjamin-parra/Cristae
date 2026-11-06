// Tipos del lector de TopoJSON 1.0 (`cristae/formats`). Contrato en SPECS.md §20; mantener sincronizado
// con src/formats/topojson.js.
import type { FormatInput, FormatOptions, FormatRead } from './core'

export interface TopoJsonOptions extends FormatOptions {
  /** Lee sólo el miembro de `objects` con este nombre. Si no está, `'formato'`. */
  object? : string;
}

/**
 * Una `Topology`: cada miembro de `objects` es una capa; si es `GeometryCollection`, cada hijo es un
 * feature, y si no, el objeto lo es. Con `transform`, los arcos se decuantizan (delta, escala y
 * traslación); `~i` recorre el arco `i` al revés. `propertiesOf(f)` y `idOf(f)` hacen `JSON.parse` de
 * `properties` e `id` del objeto que es feature. La expansión de arcos se acota con `maxBytes`
 * (`'tope'`). Sin `options.crs` se asume lon/lat WGS84: `crs` es `'EPSG:4326'`, y si las coordenadas
 * no caben en grados la lectura sigue con un aviso `'crs'` en `warnings`. Con `options.crs`, `crs` es
 * el declarado; uno inválido es `'crs'`.
 */
export declare function readTopoJson(input: FormatInput, options?: TopoJsonOptions): FormatRead
