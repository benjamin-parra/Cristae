// Tipos del entry `cristae/table` (tabla virtual sobre el contrato Source, SIN
// Leaflet). Importarlo registra el custom element <cristae-table> (side effect) y
// expone el motor headless `PagedTable` + `paginationModel` + el núcleo de datos.
// Mantener sincronizado con src/table/.

import type { CristaeSource } from "./core";

export type {
  SourceAccessors,
  CristaeSource,
  CristaeFilter,
  CristaeListener,
} from "./core";
export { createSource, defineSource, makeFilter, makeListener } from "./core";

/** Modelo puro de paginación con elipsis (botones de página; la elipsis lleva su
 *  propio `pageIndex` → es clickeable y salta a un punto intermedio). */
export function paginationModel(
  current: number,
  totalPages: number,
  capacity: number,
): Array<{ label: number | "..."; pageIndex: number; isCurrent: boolean }>;

export interface PageInfo {
  page: number;
  pageSize: number;
  total: number;
  pages: number;
  offset: number;
}

/** Meta que acompaña a cada slice visible (callback `onSlice`). */
export interface SliceMeta {
  page: number;
  pages: number;
  total: number;
  offset: number;
}

/** Opciones de construcción del motor headless. */
export interface PagedTableOptions<T = unknown> {
  /** Contenedor de filas (un <tbody> cuando se monta dentro de una <table>). */
  container: HTMLElement;
  /** Elemento con `overflow:auto` que define el viewport del scroll virtual. */
  scrollElement: HTMLElement;
  /** HTML de UNA fila con atributos `data-ref` (molde clonado al pool). */
  template: string;
  /** Llena los nodos `data-ref` de la fila clonada (sin reconstruir el árbol). */
  binder: (refs: Record<string, HTMLElement>, item: T, rowNumber: number) => void;
  /** Alto fijo de fila en px (default 28). */
  rowHeight?: number;
  /** Filas por página (default 50). */
  pageSize?: number;
  /** Orden del slice de la página. `null` ⇒ sin quickselect (camino rápido sin orden). */
  comparator?: ((a: T, b: T) => number) | null;
  /** Campo a buscar por ítem (habilita la búsqueda). */
  searchBy?: ((item: T) => unknown) | null;
  /** Predicado de match custom (default: `includes` case-insensitive). */
  searchFilter?: ((query: string, item: T, value: unknown) => boolean) | null;
  /**
   * Predicado de MEMBRESÍA por tabla (subconjunto de vista). Se aplica en el pipeline
   * ANTES del text-search. `null` (default) ⇒ sin filtro. N tablas comparten UNA Source
   * y cada una muestra su subconjunto sin afectar a las otras (a diferencia de
   * `source.addFilter`, compartido por todos los consumidores de la Source).
   */
  where?: ((item: T) => boolean) | null;
  /** Slice visible tras cada pipeline. */
  onSlice?: (slice: T[], meta: SliceMeta) => void;
  /** Cambio de página o de total (dirty-skip: no se dispara con `move`). */
  onPage?: (info: PageInfo) => void;
}

/** Motor imperativo de la tabla (scroll virtual con pool de DOM, [0-alloc] en estable). */
export class PagedTable<T = unknown> {
  constructor(options: PagedTableOptions<T>);
  /** Adjunta un Source vivo: snapshot inicial (hard) + re-read suave por notify. */
  attach(source: CristaeSource<T>): this;
  /** Ruta plana sin reactividad. `hard` resetea página + scroll. */
  setData(items: T[], hard?: boolean): this;
  setPage(page: number): this;
  setPageSize(size: number): this;
  setSearch(query: string): this;
  /** Cambia el predicado de membresía por tabla. `null` ⇒ sin filtro. */
  setWhere(fn: ((item: T) => boolean) | null): this;
  getPageInfo(): PageInfo;
  /** Ítem de una fila por su índice 1-based del DOM (vía slice visible). */
  itemAtRow(rowIndex: number): T | null;
  /**
   * Posición 0-based de `item` en la vista filtrada + ordenada vigente, o -1 si no está en el
   * dataset o no pasa el filtro. Inverso de `itemAtRow`: no toca el render. `item` debe ser una
   * referencia del dataset vigente (la que entregan `getSnapshot()`/`itemAtRow`). Determinista
   * mientras `comparator` sea un orden total (con empates, la posición dentro del bloque empatado
   * queda indefinida, igual que el particionado por quickselect del render).
   */
  indexOf(item: T): number;
  /** Página 0-based en la que cae `item` bajo el filtro + orden vigentes, o -1 si no está / no pasa el filtro. */
  pageOf(item: T): number;
  refresh(): this;
  destroy(): void;
}

/** Custom element <cristae-table> (chrome mínimo sobre el motor). */
export class CristaeTable extends HTMLElement {}
