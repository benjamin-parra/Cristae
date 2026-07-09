// Tipos del NÚCLEO de datos (entry `cristae/core`, re-exportado por `cristae/map` y
// `cristae/table`): el contrato Source que comparten el mapa, la tabla y cualquier
// consumidor headless. Mantener sincronizado con src/data/ (Source.js, filters.js).

/** Accessors que describen cómo leer cada ítem del consumidor. */
export interface SourceAccessors<T> {
  idOf: (item: T) => string | number;
  positionOf: (item: T) => { lat: number; lng: number };
  variantOf?: (item: T) => string;
  headingOf?: (item: T) => number;
  sizeOf?: (item: T) => number;
  hashOf?: (item: T) => string | number;
}

/**
 * Fuente de datos viva: los consumidores (capas del mapa, tablas) se suscriben y el
 * dato se muta por acá — `set` (rebuild O(n)) para alta/baja del conjunto, `move`/
 * `patch` (O(1)/O(k)) para el tiempo real sin reconstruir buffers.
 */
export interface CristaeSource<T = unknown> {
  /** Reemplaza el conjunto completo (rebuild O(n)). */
  set(items: T[]): void;
  /** Mueve un punto en O(1) sin reconstruir el buffer GPU. */
  move(id: string | number, lat: number, lng: number): void;
  /** Parche incremental O(k) de varios campos. `dirtyIds` = Set de ids cambiados —
   *  REQUERIDO: la implementación lo itera sin guard. */
  patch(items: T[], dirtyIds: Set<string | number>): void;
  /** Quita un id del conjunto (rebuild). */
  remove(id: string | number): void;
  itemById(id: string | number): T | undefined;
  getSnapshot(): T[];
  subscribe(cb: () => void): () => void;
  /** Agrega un filtro de MEMBRESÍA compartido: afecta a TODOS los consumidores de la
   *  Source (mapa + tablas quedan sincronizados con un solo cómputo). */
  addFilter(filter: CristaeFilter<T>): void;
  removeFilter(filterId: string): void;
  /** Libera buffers y suscripciones. Llamar al desmontar al dueño de la Source. */
  destroy(): void;
  accessors: SourceAccessors<T>;
}

/** Crea una Source house-first (Store + Emitter propios del núcleo). */
export function createSource<T = unknown>(
  accessors: SourceAccessors<T>,
  variants?: string[],
): CristaeSource<T>;

/**
 * Ruta B genérica: adapta CUALQUIER librería de reactividad al contrato Source —
 * `subscribe` es el punto de intercepción de señales y `getSnapshot` el read.
 */
export function defineSource<T = unknown>(config: {
  accessors: SourceAccessors<T>;
  getSnapshot: () => T[];
  subscribe: (cb: () => void) => () => void;
  variants?: string[];
  version?: () => number;
  dirtyIds?: () => Set<string | number> | null;
  itemById?: (id: string | number) => T | undefined;
}): CristaeSource<T>;

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
