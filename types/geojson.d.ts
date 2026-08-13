// Tipos del entry `cristae/geojson` (lector de coordenadas: bytes UTF-8 → geometría en arrays
// tipados, en una pasada y sin construir el grafo de `JSON.parse`).
// Segmento puro: no toca DOM, Leaflet, Lit ni el núcleo de datos. Contrato en SPECS.md §17;
// mantener sincronizado con src/geojson/.

// ── Entrada (SPECS §17.2) ───────────────────────────────────────────────────
export interface GeoJsonOptions {
  /** Caja por geometría en una barrida al sellar. Default `false`. */
  bounds?       : boolean;
  /** Vértices esperados; `0` estima del largo de la entrada. Evita el recrecido. */
  capacityHint? : number;
  /** Tope de anidamiento (cota anti-bomba). Default `512`; pasarlo lanza `'profundidad'`. */
  maxDepth?     : number;
}

export type GeoJsonInput = Uint8Array | ArrayBuffer | ArrayBufferView | string

/** Códigos de tipo. `GeometryCollection` no tiene: se aplana (§17.1). */
export declare const GeoJsonKind: Readonly<{
  Point           : 1;
  MultiPoint      : 2;
  LineString      : 3;
  MultiLineString : 4;
  Polygon         : 5;
  MultiPolygon    : 6;
}>

export type GeoJsonKindCode = 1 | 2 | 3 | 4 | 5 | 6

export type GeoJsonErrorCode =
  | "entrada" | "sintaxis" | "truncado" | "numero" | "posicion" | "estructura"
  | "tipo" | "profundidad" | "formato" | "properties" | "liberado"

/** A qué se PARECE el documento cuando no es GeoJSON, o `null`. */
export type GeoJsonHint = "topojson" | "esrijson" | null

export declare class GeoJsonError extends Error {
  readonly name : "GeoJsonError";
  readonly code : GeoJsonErrorCode;
  /** Offset de BYTE donde se detectó; `-1` si no aplica. */
  readonly at   : number;
  readonly hint : GeoJsonHint;
}

// ── Contadores de lo que el lector vio y NO corrigió (SPECS §17.4bis) ───────
export interface GeoJsonStats {
  /** Anillos con 2+ vértices cuya última posición NO repite a la primera. */
  openRings       : number;
  /** Anillos con 1..3 vértices (el RFC pide 4 o más). */
  shortRings      : number;
  /** Anillos de área firmada 0 — ni horarios ni antihorarios. */
  degenerateRings : number;
  /** Exteriores horarios + interiores antihorarios (regla de la mano derecha violada). */
  reversedRings   : number;
  /** Números que cayeron fuera del camino exacto de Clinger (§17.5). */
  slowNumbers     : number;
  /** Posiciones con 4 o más números; los extras se descartan. */
  extraOrdinates  : number;
  emptyGeometries : number;
  /** Miembros que el lector atravesó sin interpretar. */
  foreignMembers  : number;
  bboxSkipped     : number;
  /** Valores raíz; más de 1 ⇒ secuencia RFC 8142. */
  roots           : number;
}

// ── Salida: la vista CSR de cuatro niveles (SPECS §17.1) ────────────────────
export interface GeoJson {
  /** [f+1] feature → rango de geometrías (1:N por `GeometryCollection`). */
  readonly geometryAt : Uint32Array;
  /** [g+1] geometría → rango de partes. */
  readonly partAt     : Uint32Array;
  /** [p+1] parte → rango de anillos. */
  readonly ringAt     : Uint32Array;
  /** [r+1] anillo → rango de vértices. */
  readonly vertexAt   : Uint32Array;
  /** [g] `GeoJsonKind`; el 0 no sobrevive al sellado. */
  readonly kinds      : Uint8Array;
  /** [g] geometría → feature dueño. */
  readonly featureOf  : Uint32Array;
  /** [r] 1 = el último vértice repite al primero (§17.6). */
  readonly closed     : Uint8Array;
  /** [2v] `xy[2i]` = lng, `xy[2i+1]` = lat — orden RFC, sin invertir. */
  readonly xy         : Float64Array;
  /** [v] `NaN` donde la posición era 2D; `null` si el documento entero lo era. */
  readonly z          : Float64Array | null;
  /** [4g] minLng minLat maxLng maxLat. `null` salvo `bounds: true`. */
  readonly bounds     : Float64Array | null;
  /** [2f] rango de BYTE de los atributos del feature (§17.4). */
  readonly propAt     : Uint32Array;
  /** [2f] rango de BYTE de `id`. */
  readonly idAt       : Uint32Array;
  /** La entrada retenida; `null` tras `release()`. */
  readonly bytes      : Uint8Array | null;
  readonly stats      : GeoJsonStats;

  readonly featureCount  : number;
  readonly geometryCount : number;
  readonly partCount     : number;
  readonly ringCount     : number;
  readonly vertexCount   : number;

  /** Recorrido sin cortar. El 4º argumento es la PARTE dueña. */
  eachRing(cb: (ring: number, first: number, count: number, part: number) => void): void;
  /** Corte temprano con la semántica nativa de `some` — la vía para hit-test. */
  someRing(pred: (ring: number, first: number, count: number, part: number) => boolean): boolean;

  /** Ascenso por la cadena CSR: `upperBound(a, x) - 1`. */
  partOf(ring: number): number;
  geometryOf(part: number): number;
  featureOfRing(ring: number): number;

  /** `JSON.parse` del fragmento. NO cachea. Lanza `'liberado'` tras `release()`. */
  propertiesOf(feature: number): unknown;
  idOf(feature: number): unknown;

  /** Suelta `bytes`. La geometría sobrevive; `propertiesOf`/`idOf` dejan de servir. */
  release(): void;
}

export declare function readGeoJson(input: GeoJsonInput, options?: GeoJsonOptions): GeoJson

// ── Selección de área (SPECS §17.6) ────────────────────────────────────────
/** Las tablas del lector, sin copiar, más los ids de anillo y de parte de `Polygon`/`MultiPolygon`. */
export interface GeoJsonAreas {
  readonly xy        : Float64Array;
  readonly vertexAt  : Uint32Array;
  readonly ringAt    : Uint32Array;
  readonly closed    : Uint8Array;
  /** Totales del documento; el largo de la selección lo dan `rings` y `parts`. */
  readonly ringCount : number;
  readonly partCount : number;
  /** Anillos a rellenar. */
  readonly rings     : Uint32Array;
  /** Partes a indexar para hit-test. */
  readonly parts     : Uint32Array;
  /** Dueño de cada parte: la FEATURE que la contiene. Indexado por id de parte —como `ringAt`—, no por
   *  posición en la selección. Es lo que deja que una entidad de varias piezas conteste UNA vez. */
  readonly owner     : Uint32Array;
}

export declare function areasOf(geo: GeoJson): GeoJsonAreas
