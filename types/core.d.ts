// Tipos del NÚCLEO de datos (entry `cristae/core`, re-exportado por `cristae/map` y
// `cristae/table`): el contrato Source que comparten el mapa, la tabla y cualquier
// consumidor headless. Mantener sincronizado con src/data/ (Source.js, filters.js).

/** Accessors que describen cómo leer cada ítem del consumidor. */
export interface SourceAccessors<T> {
  idOf: (item: T) => string | number;
  /** Geometría de PUNTO (point/label). Una de `positionOf` | `pathOf` es obligatoria. */
  positionOf?: (item: T) => { lat: number; lng: number };
  /** Geometría de LÍNEA (line-layer): vértices `[lat,lng]` del path, plano —donde un vértice no
   *  finito CORTA la línea— o anidado con las partes explícitas. Ver `toParts` en `./map`. */
  pathOf?: (item: T) =>
    | Iterable<[number, number]>
    | Iterable<Iterable<[number, number]>>;
  variantOf?: (item: T) => string;
  headingOf?: (item: T) => number;
  sizeOf?: (item: T) => number;
  hashOf?: (item: T) => string | number;
}

/**
 * Contrato de LECTURA: lo ÚNICO que el motor consume de una Source (capas del mapa,
 * tablas). Lo cumplen las dos primitivas y también un adaptador propio del consumidor,
 * por eso es el tipo que piden las vistas (`layer.source`, `PagedTable.attach`).
 * Los opcionales degradan: sin `itemById`/`dirtyIds` el consumidor rebuildea O(n).
 */
export interface CristaeReadSource<T = unknown> {
  accessors: SourceAccessors<T>;
  /** Conjunto vigente, ya filtrado. */
  getSnapshot(): T[];
  /** Alta de suscriptor; devuelve la baja. */
  subscribe(cb: () => void): () => void;
  /** Monótona: avanza en cada cambio observable (dirty-check de quien la observe). */
  version(): number;
  /** Variantes preseed del atlas. */
  variants?: string[];
  itemById?(id: string | number): T | undefined;
  /** Ids con cambio estructural de la ventana vigente → patch incremental O(k). */
  dirtyIds?(): Set<string | number> | null;
  /** Ids sólo movidos: la capa reescribe el slot de posición sin rebuild. */
  moveDirtyIds?(): Set<string | number> | null;
}

/**
 * Fuente de datos viva del DUEÑO: extiende la lectura con la mutación — `set`
 * (rebuild O(n)) para alta/baja del conjunto, `move`/`patch` (O(1)/O(k)) para el
 * tiempo real sin reconstruir buffers. Sólo la devuelve `createSource`.
 */
export interface CristaeSource<T = unknown> extends CristaeReadSource<T> {
  /** Reemplaza el conjunto completo (rebuild O(n)). */
  set(items: T[]): void;
  /** Mueve un punto en O(1) sin reconstruir el buffer GPU. */
  move(id: string | number, lat: number, lng: number): void;
  /** Parche incremental O(k) de varios campos. `dirtyIds` = Set de ids cambiados —
   *  REQUERIDO: la implementación lo itera sin guard. */
  patch(items: T[], dirtyIds: Set<string | number>): void;
  /** Quita un id del conjunto (rebuild). */
  remove(id: string | number): void;
  /** Agrega un filtro de MEMBRESÍA compartido: afecta a TODOS los consumidores de la
   *  Source (mapa + tablas quedan sincronizados con un solo cómputo). */
  addFilter(filter: CristaeFilter<T>): void;
  removeFilter(filterId: string): void;
  /** Libera buffers y suscripciones. Llamar al desmontar al dueño de la Source. */
  destroy(): void;
  itemById(id: string | number): T | undefined;
  dirtyIds(): Set<string | number>;
  moveDirtyIds(): Set<string | number>;
}

/** Crea una Source house-first (Store + Emitter propios del núcleo): lectura + dueño. */
export function createSource<T = unknown>(
  accessors: SourceAccessors<T>,
  variants?: string[],
): CristaeSource<T>;

/**
 * Ruta B genérica: adapta CUALQUIER librería de reactividad al contrato Source —
 * `subscribe` es el punto de intercepción de señales y `getSnapshot` el read. La
 * mutación queda del lado de esa librería, así que devuelve SÓLO lectura.
 */
export function defineSource<T = unknown>(config: {
  accessors: SourceAccessors<T>;
  getSnapshot: () => T[];
  subscribe: (cb: () => void) => () => void;
  variants?: string[];
  version?: () => number;
  dirtyIds?: () => Set<string | number> | null;
  itemById?: (id: string | number) => T | undefined;
}): CristaeReadSource<T>;

// ── Filtros / listeners (src/data/filters.js) ──
export interface CristaeFilter<T = unknown> {
  id: string;
  f: (item: T) => boolean;
}
export interface CristaeListener<T = unknown> {
  id: string;
  callback: (items: T[]) => void;
}
/** Filtro de membresía aplicable a una Source (`addFilter`). */
export function makeFilter<T = unknown>(
  id: string,
  predicate: (item: T) => boolean,
): CristaeFilter<T>;
export function makeListener<T = unknown>(
  id: string,
  callback: (items: T[]) => void,
): CristaeListener<T>;
