// Tipos de los lectores de Shapefile y su `.dbf` (`cristae/formats`). Contrato en SPECS.md §19;
// mantener sincronizado con src/formats/shapefile.js y src/formats/dbf.js.
import type { FormatOptions, FormatRead } from './core'

export type ShapefileBytes = Uint8Array | ArrayBuffer | ArrayBufferView

/** Los archivos de una capa. Sin `.shx`: el `.shp` se recorre en orden. */
export interface ShapefileFiles {
  shp  : ShapefileBytes;
  /** Atributos: un registro por registro del `.shp`, en el mismo orden. Sin él, `propertiesOf` es `null`. */
  dbf? : ShapefileBytes | null;
  /** WKT1 del CRS. Sin él manda `options.crs`, y sin ella las coordenadas deben ser geográficas. */
  prj? : ShapefileBytes | string | null;
  /** Codificación del `.dbf`: una etiqueta o una página de códigos de Windows (`1252`, `65001`). */
  cpg? : ShapefileBytes | string | null;
}

export interface ShapefileOptions extends FormatOptions {
  /** Codificación del `.dbf` (etiqueta de `TextDecoder`). Gana al `.cpg`, al language driver y al
   *  default windows-1252. */
  encoding? : string;
  /** En un zip con varios `.shp`, el nombre del que se lee: su ruta en el zip, sin extensión. */
  layer?    : string;
}

/**
 * Síncrono. `propertiesOf(f)` devuelve `{ campo: valor }`: `C` texto recortado a la derecha, `N` y `F`
 * número o `null` en blanco, `L` booleano o `null`, `D` texto `YYYY-MM-DD`; memo y tipos fuera de la
 * tabla, `null`. `bytes` es el `.dbf`. Los polígonos se agrupan por orientación y contención.
 * `FormatError.at` es un offset del archivo que falló (`.shp` o `.dbf`).
 */
export declare function readShapefile(files: ShapefileFiles, options?: ShapefileOptions): FormatRead

/** Asíncrono por el inflado. Empareja `.dbf`, `.prj` y `.cpg` con el `.shp` por nombre base, sin
 *  distinguir mayúsculas en la extensión; lo inflado suma contra `maxBytes`. */
export declare function readShapefileZip(input: ShapefileBytes, options?: ShapefileOptions): Promise<FormatRead>
