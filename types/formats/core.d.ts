// Tipos compartidos del entry `cristae/formats`: el contrato común de salida, de errores y de opciones de
// los lectores (SPECS.md §19; mantener sincronizado con src/formats/core/). El constructor de tablas, el
// zip y el CRS son internos y no tienen tipos públicos.
import type { GeoJson, GeoJsonErrorCode, GeoJsonStats } from '../geojson'

/** El lector que produjo la lectura. */
export type FormatReader =
  | 'kml' | 'kmz' | 'gpx' | 'wkt' | 'wkb' | 'topojson' | 'esrijson' | 'shapefile' | 'flatgeobuf'

/** Lo que `detectFormat` reconoce por bytes mágicos y primer token. */
export type FormatName =
  | 'geojson' | 'kml' | 'kmz' | 'gpx' | 'wkt' | 'wkb' | 'topojson' | 'esrijson'
  | 'shapefile' | 'shapefile-zip' | 'flatgeobuf' | 'zip'

export type FormatInput = Uint8Array | ArrayBuffer | ArrayBufferView | string

// ── Opciones comunes (§19, DISENO-INTEROP §1.5) ──────────────────────────────────────────────────
export interface FormatOptions {
  /** Caja por geometría en una barrida al sellar. Default `false`. */
  bounds?       : boolean;
  /** Vértices esperados. Evita el recrecido; es una pista, no una promesa. */
  capacityHint? : number;
  /** Tope de anidamiento. Default `512`; pasarlo lanza `'profundidad'`. Cubre también WKB y FlatGeobuf. */
  maxDepth?     : number;
  /** Tope de lo que la entrada hace crecer: inflado de un zip, expansión de arcos de TopoJSON. Default
   *  256 MiB; pasarlo lanza `'tope'`. */
  maxBytes?     : number;
  /** CRS de la fuente cuando ésta no declara uno: código EPSG (`32719`, `'EPSG:32719'`) o WKT1. Si la
   *  fuente declara uno, gana la fuente. */
  crs?          : number | string;
}

// ── Errores ──────────────────────────────────────────────────────────────────────────────────────
export type FormatErrorCode =
  | GeoJsonErrorCode
  | 'crs' | 'compresion' | 'tope' | 'entorno' | 'version' | 'codificacion' | 'dtd'

export declare class FormatError extends Error {
  readonly name   : 'FormatError';
  /** El lector que falló. */
  readonly format : string;
  readonly code   : FormatErrorCode;
  /** Offset de BYTE en la entrada que se publica en `bytes` (en KMZ, del KML inflado); `-1` si no aplica. */
  readonly at     : number;
  /** A qué formato se PARECE la entrada, o `null`. */
  readonly hint   : string | null;
}

// ── Contadores ───────────────────────────────────────────────────────────────────────────────────
/** Los diez de `GeoJsonStats` con la misma definición, salvo dos que se reinterpretan:
 *  `extraOrdinates` cuenta las posiciones con ordenadas descartadas (la M, o la cuarta en adelante), y
 *  `reversedRings` se mide contra la convención del formato (horaria en Shapefile y EsriJSON). */
export interface FormatStats extends GeoJsonStats {
  /** Geometrías fuera del subconjunto (curvas, `MultiPatch`, `Model`…). El feature sale sin ellas. */
  skippedGeometries : number;
  /** Registros del `.dbf` marcados borrados; se emiten igual. */
  deletedRecords    : number;
  /** Anillos interiores sin exterior que los contenga (Shapefile, EsriJSON); salen como exteriores. */
  orphanHoles       : number;
}

// ── Avisos ───────────────────────────────────────────────────────────────────────────────────────
/**
 * Lo que no impide leer: `'codificacion'`, un `.cpg` que no se reconoce o que `TextDecoder` no trae;
 * `'crs'`, una fuente sin CRS declarado ni pedido con coordenadas fuera de ±180/±90.
 */
export type FormatWarningCode = 'codificacion' | 'crs'

export interface FormatWarning {
  readonly code   : FormatWarningCode;
  /** Lo que motivó el aviso (la etiqueta del `.cpg`, el vértice fuera de rango); `null` si no hay. */
  readonly detail : string | null;
}

// ── Salida: el `GeoJson` de §17.1 más cuatro campos ──────────────────────────────────────────────
export interface FormatLayer {
  readonly name   : string | null;
  /** Índice de la capa contenedora, o `-1`. */
  readonly parent : number;
}

export interface FormatRead extends Omit<GeoJson, 'stats'> {
  readonly format   : FormatReader;
  /** El CRS DE LA FUENTE (`'EPSG:32719'`…) o el de `options.crs`. Sin ninguno, y en KML y GPX, es
   *  `'EPSG:4326'` (fuera de rango, con aviso `'crs'`). `xy` sale siempre en grados WGS84 `[lng, lat]`. */
  readonly crs      : string;
  /** [f] capa de cada feature. */
  readonly layerOf  : Uint32Array;
  /** `Document`/`Folder` de KML, `objects` de TopoJSON; una sola `{ name: null, parent: -1 }` en los
   *  formatos sin contenedores. */
  readonly layers   : readonly FormatLayer[];
  readonly stats    : FormatStats;
  /** Avisos no fatales, en el orden en que salieron; vacío si no hubo. */
  readonly warnings : readonly FormatWarning[];
}

/** Formato por bytes mágicos y primer token. Ningún lector la llama: leer no adivina. */
export declare function detectFormat(input: FormatInput): FormatName | null
