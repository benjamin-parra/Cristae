// Tipos del entry `cristae/map` (mapa WebGL: Leaflet + glify con shaders propios).
// Importarlo REGISTRA los custom elements <cristae-*> (side effect). Mantener
// sincronizado con src/index.js; el núcleo de datos vive en ./core.d.ts.

export type {
  SourceAccessors,
  CristaeSource,
  CristaeFilter,
  CristaeListener,
} from "./core";
export { createSource, defineSource, makeFilter, makeListener } from "./core";

// ── IconSets (src/atlas/IconSet.js) ─────────────────────────────────────────
/** Tipo opaco del IconSet — se asigna a `layer.iconSet`; `sprite()` reusa el tile fuera del mapa. */
export type IconSet = {
  readonly __iconSet: unique symbol;
  /** `true` si el iconSet rota el sprite por `headingOf`. */
  readonly rotates: boolean;
  /** Canvas rasterizado de UNA variante (mismo tile del atlas GPU) para reusar el icono
   *  fuera del mapa (celda de tabla, leyenda). Cachear el dataURL por variante. */
  sprite(variant: string): HTMLCanvasElement;
};

export interface IconDescriptor {
  shape: string;
  [k: string]: unknown;
}

export interface IconSetConfig {
  rotates?: boolean;
  /** Variantes preseed (cero regrow en runtime). */
  variants?: string[];
  sizes?: { default?: number; canvas?: number };
  /** Debe ser TOTAL: cualquier string (o null/undefined) → descriptor completo. */
  describe: (variant: string | null | undefined) => IconDescriptor;
  renderers: Record<
    string,
    (ctx: CanvasRenderingContext2D, size: number, descriptor: IconDescriptor) => void
  >;
  /** Espera previa a la rasterización del atlas (fuentes web: sin esto el glifo queda "tofu"). */
  prerender?: () => Promise<void> | void;
}

export interface ClusterIconSetConfig {
  /** Thresholds ascendentes de conteo (buckets de variante). */
  buckets?: number[];
  sizes?: { default?: number; canvas?: number };
  /** `dim` = burbuja expandida (spiderfy); `marked` = contiene ids marcados (eje `markedIds`). */
  draw: (
    ctx: CanvasRenderingContext2D,
    size: number,
    count: number,
    plus: boolean,
    dim?: boolean,
    marked?: boolean,
  ) => void;
}

export function defineIconSet(config: IconSetConfig): IconSet;
export function defineClusterIconSet(config: ClusterIconSetConfig): IconSet;
/** Devuelve un `prerender` que espera a que las fuentes web indicadas estén disponibles. */
export function prerenderFonts(...families: string[]): () => Promise<void>;

// ── Polígonos (addPolygonLayer / <cristae-polygon-layer>) ───────────────────
export interface PolygonAccessors<T> {
  idOf: (g: T) => string | number;
  /** Anillos Leaflet `[[lat,lng],…]` o multi-anillo `[[[lat,lng],…],…]`. */
  ringsOf: (g: T) => number[][] | number[][][];
  /** Opciones de `L.polygon` (color, fillColor, weight, opacity, …). */
  styleOf?: (g: T) => Record<string, unknown>;
}

// ── Labels (src/render/LabelLayer.js) ───────────────────────────────────────
/** Painter default de etiquetas (inyectable en la label-layer vía `paint`). */
export function drawLabel(
  ctx: CanvasRenderingContext2D,
  point: { x: number; y: number },
  label: string,
  hovered: boolean,
  style?: Record<string, unknown>,
): void;

// ── Tiles (src/tiles/presets.js) ─────────────────────────────────────────────
export const tilePresets: Record<
  string,
  { url: string; maxZoom?: number; attribution?: string }
>;

// ── Motor y custom elements ──────────────────────────────────────────────────
// Declaraciones MÍNIMAS: la superficie rica de instancia (props por ref, eventos del
// bus, sesión de cluster, eje marked) es amplia y evoluciona con cada eje — el
// consumidor la tipa/castea según lo que use (ver docs/ y SKILL.md). Acá se garantiza
// la identidad de las clases exportadas.
export class MapEngine {
  constructor(options: Record<string, unknown>);
  readonly ready: Promise<unknown>;
  readonly camera: unknown;
  setTileProvider(tile: Record<string, unknown>): void;
  getLeafletMap(): unknown;
  getLayer(id: string): unknown;
  syncSize(): void;
  on(event: string, ...args: unknown[]): () => void;
}

export class CristaeMap extends HTMLElement {}
export class CristaePointLayer extends HTMLElement {}
export class CristaePolygonLayer extends HTMLElement {}
export class CristaeLabelLayer extends HTMLElement {}
export class CristaeCluster extends HTMLElement {}
export class CristaeOverlay extends HTMLElement {}
export class CristaeToolbar extends HTMLElement {}
export class CristaePopup extends HTMLElement {}
