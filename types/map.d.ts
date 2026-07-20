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
  /** Footprint scale OPCIONAL (> 0, default 1): multiplicador del tamaño en pantalla del sprite
   *  (gl_PointSize). Rinde un ícono más grande que su `sizeOf` sin re-rasterizar ni tocar el
   *  accessor — p. ej. un realce dibujado alrededor que excede el ícono. */
  scale?: number;
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

// ── Líneas (addLineLayer / <cristae-line-layer>) ────────────────────────────
// GPU (glify.Lines) + gradiente per-vértice por bufferSubData + picking CPU nearest-segment.
// `dash` y el grosor real por triángulos NO están (deuda documentada — ver docs/lines.md).
export interface LineAccessors<T> {
  idOf: (l: T) => number;
  /** Vértices del path en orden, `[lat, lng]`. Dos encodings (ver `toParts`): plano — un vértice no
   *  finito **corta** la línea (un track GPS con baches sale partido, no puenteado) — o anidado
   *  `[[[lat,lng],…],…]` con las partes explícitas. Una línea multi-parte sigue siendo UNA entidad:
   *  un id, un estilo, un hit. */
  pathOf: (l: T) => Iterable<[number, number]> | Iterable<Iterable<[number, number]>>;
  /** Estilo PLANO por línea. `color` = `"#RRGGBB"` o `[r,g,b,a]` (0..1); `weight` en px de pantalla.
   *  `dash` (patrón `stroke-dasharray` en px) y `cap` SÓLO los dibuja el backend Leaflet
   *  (`vector:true`); el backend GL los ignora. Un solo eje `dash` cubre todos los patrones
   *  tradicionales: `[8,6]` guiones · `[1,6]`+`cap:'round'` punteado · `[12,5,1,5]`+`cap:'round'`
   *  raya-punto (línea de eje). */
  styleOf?: (l: T) => {
    color?: string | number[];
    weight?: number;
    opacity?: number;
    dash?: number[];
    cap?: "butt" | "round" | "square";
  };
  /** Escalar por vértice (genérico — el core NO lo interpreta) para colorear por gradiente.
   *  `vertexIndex` indexa la ENTRADA de `pathOf` (con el encoding plano, los cortes ocupan índice;
   *  con el anidado, los índices corren concatenados) → un array paralelo no se desincroniza. */
  scalarOf?: (l: T, vertexIndex: number) => number;
  /** Rampa `valor → color` (`"#RRGGBB"` o `[r,g,b,a]` en 0..1). Con `scalarOf` presente gana sobre `styleOf.color`. */
  colorRamp?: (value: number) => string | [number, number, number, number];
}

/** Handle de una line-layer (retorno de `MapEngine.addLineLayer`) — SÓLO acciones (empujar datos /
 *  visibilidad). El estilo es ESTADO (`styleOf`): para recolorear una línea se muta su item y se
 *  set/patch la Source; NO hay `setStyle` imperativo. */
export interface LineHandle<T = unknown> {
  readonly id: string;
  readonly source: CristaeSource<T>;
  /** Reemplaza el conjunto de líneas (ruta `data`; rebuild O(n)). */
  set(items: T[]): void;
  setVisible(visible: boolean): void;
}

/** Normaliza lo que devuelve `pathOf` a partes: corta el encoding plano en cada vértice no finito y
 *  aplana el anidado. `from` = índice del primer vértice de la parte en la entrada (dentro de una
 *  parte son contiguos). Descarta partes de < 2 vértices. Es la MISMA convención que aplica la
 *  line-layer — exportada para decorar multi-parte sin reimplementarla. Puro, sin DOM. */
export function toParts(
  input:
    | Iterable<[number, number]>
    | Iterable<Iterable<[number, number]>>
    | null
    | undefined,
): Array<{ path: [number, number][]; from: number }>;

/** Hit de una línea (`kind:'line'`). `vertexIndex` vive en el espacio de índices de la ENTRADA de
 *  `pathOf` — el MISMO que recibe `scalarOf` — y apunta al vértice donde arranca el segmento picado,
 *  para poder cruzar el hit con un array paralelo de dato. `partIndex` ubica la parte. */
export interface LineHit {
  ref: number;
  id: number;
  distancePx: number;
  partIndex: number;
  vertexIndex: number;
}

/** Muestrea `count` puntos equiespaciados por longitud a lo largo del path `[lat,lng][]`, con el
 *  rumbo (0=N, 90=E) del segmento en que caen. Para DECORAR una línea componiendo: los puntos van a
 *  un point-layer con `headingOf` (flechas de dirección / ticks). Multi-parte: componer con
 *  `toParts(p).flatMap(({ path }) => sampleAlong(path, n))` para no muestrear sobre los huecos.
 *  Puro, sin DOM. */
export function sampleAlong(
  path: [number, number][],
  count: number,
): Array<{ lat: number; lng: number; heading: number }>;

// ── Marcadores HTML (addHtmlLayer / <cristae-html-layer>) ───────────────────
// L.divIcon sobre Leaflet — GL-safe (NO abre otro contexto WebGL). Nicho: badges de dominio con HTML
// arbitrario (heroicon / glifo de fuente) + popup. COMPLEMENTA el point-layer GPU, no lo reemplaza.
export interface HtmlAccessors<T> {
  idOf: (m: T) => number;
  positionOf: (m: T) => { lat: number; lng: number };
  /** HTML del marcador (string) — heroicon SVG, glifo `<i class="fv-*">`, letra, etc. */
  htmlOf: (m: T) => string;
  classNameOf?: (m: T) => string;
  /** Tamaño `[w,h]` px del icono; omitir = tamaño por CSS. */
  sizeOf?: (m: T) => [number, number];
  /** Ancla `[x,y]` px; default = centro del `sizeOf`. */
  anchorOf?: (m: T) => [number, number];
}

/** Handle de una html-layer (retorno de `MapEngine.addHtmlLayer`) — sólo acciones. */
export interface HtmlHandle<T = unknown> {
  readonly id: string;
  readonly source: CristaeSource<T>;
  set(items: T[]): void;
  setVisible(visible: boolean): void;
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
export class CristaeLineLayer extends HTMLElement {}
export class CristaeHtmlLayer extends HTMLElement {}
export class CristaeLabelLayer extends HTMLElement {}
export class CristaeCluster extends HTMLElement {}
export class CristaeOverlay extends HTMLElement {}
export class CristaeToolbar extends HTMLElement {}
export class CristaePopup extends HTMLElement {}
