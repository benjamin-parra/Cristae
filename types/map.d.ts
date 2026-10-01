// Tipos del entry `cristae/map` (mapa WebGL: Leaflet + glify con shaders propios).
// Importarlo REGISTRA los custom elements <cristae-*> (side effect). Mantener
// sincronizado con src/index.js; el núcleo de datos vive en ./core.d.ts y la geometría pura
// que re-exporta, en ./geometry.d.ts.

// El re-export de abajo NO liga los nombres en este archivo: lo que se usa acá se importa.
import type { CristaeReadSource, CristaeSource, CristaeFilter, SourceAccessors } from "./core";
import type { Bounds, BoundsLike, LatLng, LatLngPath, LatLngPoint } from "./geometry";

export type {
  SourceAccessors,
  CristaeReadSource,
  CristaeSource,
  CristaeFilter,
  CristaeListener,
} from "./core";
export { createSource, defineSource, makeFilter, makeListener } from "./core";
export type { Bounds, BoundsLike, EarthModel, LatLng, LatLngPoint, LatLngPath } from "./geometry";
export { distance, sphere, toParts, sampleAlong } from "./geometry";

// ── IconSets (src/atlas/IconSet.js) ─────────────────────────────────────────
/** Tipo opaco del IconSet — se asigna a `layer.iconSet`; `sprite()` reusa el tile fuera del mapa. */
export type IconSet = {
  readonly __iconSet : unique symbol;
  /** `true` si el iconSet rota el sprite por `headingOf`. */
  readonly rotates   : boolean;
  /** Canvas rasterizado de UNA variante (mismo tile del atlas GPU) para reusar el icono
   *  fuera del mapa (celda de tabla, leyenda). Cachear el dataURL por variante. */
  sprite(variant: string): HTMLCanvasElement;
};

export interface IconDescriptor {
  shape  : string;
  /** Footprint scale OPCIONAL (> 0, default 1): multiplicador del tamaño en pantalla del sprite
   *  (gl_PointSize). Rinde un ícono más grande que su `sizeOf` sin re-rasterizar ni tocar el
   *  accessor — p. ej. un realce dibujado alrededor que excede el ícono. */
  scale? : number;
  [k: string]: unknown;
}

export interface IconSetConfig {
  rotates?   : boolean;
  /** Variantes preseed (cero regrow en runtime). */
  variants?  : string[];
  sizes?     : { default?: number; canvas?: number };
  /** Debe ser TOTAL: cualquier string (o null/undefined) → descriptor completo. */
  describe   : (variant: string | null | undefined) => IconDescriptor;
  renderers  : Record<
    string,
    (ctx: CanvasRenderingContext2D, size: number, descriptor: IconDescriptor) => void
  >;
  /** Espera previa a la rasterización del atlas (fuentes web: sin esto el glifo queda "tofu"). */
  prerender? : () => Promise<void> | void;
}

export interface ClusterIconSetConfig {
  /** Thresholds ascendentes de conteo (buckets de variante). */
  buckets? : number[];
  sizes?   : { default?: number; canvas?: number };
  /** `dim` = burbuja expandida (spiderfy); `marked` = contiene ids marcados (eje `markedIds`). */
  draw     : (
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

export type ShapePreset = "dot" | "pin" | "circle"
/** IconSet de una FORMA agnóstica (dot/pin/circle); la VARIANTE que pasa `variantOf` es el color de
 *  relleno (hex) → un tile por color distinto, sin escribir un renderer canvas. */
export function shapePresetIconSet(config?: { shape?: ShapePreset; size?: number }): IconSet;
/** Renderers de forma por nombre, para componer un IconSet propio reusando una forma. */
export const shapeRenderers: Record<
  string,
  (ctx: CanvasRenderingContext2D, size: number, descriptor: IconDescriptor) => void
>;

// ── Polígonos (addPolygonLayer / <cristae-polygon-layer>) ───────────────────
export interface PolygonAccessors<T> extends Pick<SourceAccessors<T>, "hashOf"> {
  idOf     : (g: T) => string | number;
  /** Anillos Leaflet `[[lat,lng],…]` o multi-anillo `[[[lat,lng],…],…]`. */
  ringsOf  : (g: T) => number[][] | number[][][];
  /** Opciones de `L.polygon` (color, fillColor, weight, opacity, …), salvo `interactive`, que se ignora:
   *  el picking es por índice. */
  styleOf? : (g: T) => Record<string, unknown>;
}

// ── Líneas (addLineLayer / <cristae-line-layer>) ────────────────────────────
// GPU (glify.Lines) + gradiente per-vértice por bufferSubData + picking CPU nearest-segment.
// `dash` lo dibujan los backends `gpu` y `leaflet`; `glify` no (ver docs/lines.md).
export interface LineAccessors<T> extends Pick<SourceAccessors<T>, "hashOf"> {
  idOf       : (l: T) => string | number;
  /** Vértices del path en orden, cada uno en cualquiera de las formas de `LatLngPoint`. Dos encodings
   *  (ver `toParts`): plano — un vértice que no es punto **corta** la línea (un track GPS con baches
   *  sale partido, no puenteado) — o anidado `[[punto,…],…]` con las partes explícitas. Una línea
   *  multi-parte sigue siendo UNA entidad: un id, un estilo, un hit. */
  pathOf     : (l: T) => LatLngPath;
  /** Estilo PLANO por línea. `color` = `"#RRGGBB"` o `[r,g,b,a]` (0..1); `weight` en px de pantalla.
   *  `dash` (patrón `stroke-dasharray` en px) y `cap` los dibujan los backends `gpu` y `leaflet`;
   *  `glify` los ignora. En `gpu` el patrón corre continuo a lo largo de cada parte y no depende del
   *  zoom; admite hasta 16 valores ya repetidos (los impares cuentan doble), y por dónde sale el
   *  error de uno más largo lo dice docs/lines.md.
   *  Un solo eje `dash` cubre todos los patrones tradicionales: `[8,6]` guiones · `[1,6]`+`cap:'round'`
   *  punteado · `[12,5,1,5]`+`cap:'round'` raya-punto (línea de eje). */
  styleOf?   : (l: T) => {
    color?   : string | number[];
    weight?  : number;
    opacity? : number;
    dash?    : number[];
    cap?     : "butt" | "round" | "square";
  };
  /** Escalar por vértice (genérico — el core NO lo interpreta) para colorear por gradiente.
   *  `vertexIndex` indexa la ENTRADA de `pathOf` (con el encoding plano, los cortes ocupan índice;
   *  con el anidado, los índices corren concatenados) → un array paralelo no se desincroniza. */
  scalarOf?  : (l: T, vertexIndex: number) => number;
  /** Rampa `valor → color` (`"#RRGGBB"` o `[r,g,b,a]` en 0..1). Con `scalarOf` presente gana sobre `styleOf.color`. */
  colorRamp? : (value: number) => string | [number, number, number, number];
}

/** Handle de una line-layer (retorno de `MapEngine.addLineLayer`) — SÓLO acciones (empujar datos /
 *  visibilidad). El estilo es ESTADO (`styleOf`): para recolorear una línea se muta su item y se
 *  set/patch la Source; NO hay `setStyle` imperativo. */
export interface LineHandle<T = unknown> {
  readonly id     : string;
  /** Lectura: el handle expone la Source que la capa consume, no la del dueño. */
  readonly source : CristaeReadSource<T>;
  /** Reemplaza el conjunto de líneas (ruta `data`; rebuild O(n)). */
  set(items: T[]): void;
  setVisible(visible: boolean): void;
}

// ── Hits de picking ─────────────────────────────────────────────────────────
// El resolver de cada capa aporta su parte y el registro la completa con layerId/kind/zIndex/order
// (ver docs/interaction.md). La lista llega ordenada top-first (zIndex desc, order asc, distancePx
// asc), así que `hits[0]` desambigua sin recalcular geometría.

/** Lo que el registro pone en TODO hit, sea cual sea la capa. */
export interface HitBase {
  layerId        : string;
  /** Id del DATO golpeado (`idOf` del ítem); `ref` es la referencia estable de la capa. */
  id             : string | number;
  ref            : string | number;
  /** Distancia en px del puntero al elemento (0 = dentro); sin geometría, `+Infinity`. */
  distancePx     : number;
  /** z del pane y orden de declaración: definen el desempate top-first. */
  zIndex         : number;
  order          : number;
  /** Posición con la que un overlay presentó el hit (la hoja del spider, ya desplegada). */
  latlng?        : LatLng;
  /** Capa que presentó este hit en lugar de la propia (hoja del cluster → su capa host). */
  presentedFrom? : string;
}
export interface PointHit extends HitBase {
  kind: 'point';
}

export interface PolygonHit extends HitBase {
  kind: 'polygon';
}

export interface HtmlHit extends HitBase {
  kind: 'html';
}

/** Sólo por `addCircleLayer` — no hay elemento declarativo de círculos. */
export interface CircleHit extends HitBase {
  kind: 'circle';
}

/** `vertexIndex` vive en el espacio de índices de la ENTRADA de `pathOf` — el MISMO que recibe
 *  `scalarOf` — y apunta al vértice donde arranca el segmento picado, para cruzar el hit con un
 *  array paralelo de dato. `partIndex` ubica la parte del path multi-parte (ver `toParts`). */
export interface LineHit extends HitBase {
  kind        : 'line';
  partIndex   : number;
  vertexIndex : number;
}

export type Hit = PointHit | PolygonHit | HtmlHit | CircleHit | LineHit

// ── Sesión de expansión del cluster (payloads de los canales `cluster:*`) ────

/** Una entidad desclusterizada de la sesión, con su capa de origen (un fold puede envolver varias
 *  capas). `layerId`/`item` son `null` si el id ya no resuelve en ninguna. */
export interface ClusterEntity<T = unknown> {
  layerId : string | null;
  id      : string | number;
  item    : T | null;
}

export interface ClusterGroup<T = unknown> {
  id       : string | number;
  count    : number;
  expanded : boolean;
  entities : ClusterEntity<T>[];
}

/** `groups` viene `[]` cuando la burbuja base es plana (pocas hojas): ahí se usa `entities`. */
export interface ClusterSession<T = unknown> {
  id       : string | number;
  center   : LatLng | null;
  count    : number;
  entities : ClusterEntity<T>[];
  groups   : ClusterGroup<T>[];
}

export interface ClusterDismiss {
  id     : string | number;
  reason : 'collapse' | 'zoom';
}

/** Level-triggered: la verdad completa de los ids marcados que quedaron OCULTOS dentro de una
 *  burbuja, con el centro de la burbuja que los tapa. Vacío = ninguno oculto. */
export interface ClusterMarked {
  hidden : Array<{ layerId: string | null; id: string | number; center: LatLng }>;
}

// ── Canales del bus ─────────────────────────────────────────────────────────
// Un canal por entrada; la firma es la que el bus invoca: los hits y lo que los originó. El click entrega
// el `pointerup` de la pulsación que lo sintetizó (SPECS §10) y el secundario, su evento del DOM; el hover
// y `pointer:move`, la muestra del puntero. En `pointer:move` no hay picking: los hits llegan vacíos, una
// lista por handler.

/** La muestra del puntero: su posición en grados y su píxel del contenedor. Es también el detail de
 *  `cristae:pointermove`, y llega congelada: la comparten los handlers y el picking del mismo evento. */
export interface PointerSample extends Readonly<LatLng>, Readonly<Point> {}

export interface BusChannels {
  'click'           : (hits: Hit[], event: PointerEvent) => void;
  'secondary-click' : (hits: Hit[], event: MouseEvent | null) => void;
  'hover'           : (hits: Hit[], sample: PointerSample) => void;
  'hover:start'     : (hits: Hit[], sample: PointerSample) => void;
  /** `null` cuando el hover cierra sin muestra (SPECS §10). */
  'hover:end'       : (hits: Hit[], sample: PointerSample | null) => void;
  'pointer:move'    : (hits: [], sample: PointerSample) => void;
  'cluster:expand'  : (session: ClusterSession) => void;
  'cluster:update'  : (session: ClusterSession) => void;
  'cluster:dismiss' : (detail: ClusterDismiss) => void;
  'cluster:marked'  : (snapshot: ClusterMarked) => void;
}

// ── Señales del motor ───────────────────────────────────────────────────────
// Lo que el motor avisa sin picking: un solo payload, sin hits ni filtro por capa. Salvo `move`, son
// también los `detail` de los `cristae:*` del elemento (SPECS §10).

/** La vista de la cámara que viaja en `viewportchange`; cuándo sale lo fija SPECS §10. */
export interface ViewportChangeDetail {
  center : LatLng;
  zoom   : number;
  bounds : Bounds;
}
/** Un click en el vacío, sin ningún hit. */
export interface MapClickDetail {
  latlng : LatLng;
}
export interface EngineSignals {
  'ready'            : (detail: Record<string, never>) => void;
  'viewportchange'   : (detail: ViewportChangeDetail) => void;
  /** Cada paso del movimiento, para lo que sigue la vista en continuo (SPECS §10). */
  'move'             : (detail: Record<string, never>) => void;
  /** Cambiaron los topes del zoom, aunque la vista no se haya movido (SPECS §10). */
  'zoomlevelschange' : (detail: { minZoom: number; maxZoom: number }) => void;
  'map:click'        : (detail: MapClickDetail) => void;
  'interactionstart' : (detail: Record<string, never>) => void;
  'interactionend'   : (detail: Record<string, never>) => void;
}

// ── Marcadores HTML (addHtmlLayer / <cristae-html-layer>) ───────────────────
// Nodos DOM propios sobre la superficie del anfitrión — GL-safe (NO abre otro contexto WebGL). Nicho:
// badges de dominio con HTML arbitrario (heroicon / glifo de fuente) + popup. COMPLEMENTA el point-layer
// GPU, no lo reemplaza.
export interface HtmlAccessors<T> extends Pick<SourceAccessors<T>, "hashOf"> {
  idOf         : (m: T) => string | number;
  positionOf   : (m: T) => { lat: number; lng: number };
  /** HTML del marcador (string) — heroicon SVG, glifo `<i class="fv-*">`, letra, etc. */
  htmlOf       : (m: T) => string;
  classNameOf? : (m: T) => string;
  /** Tamaño `[w,h]` px del icono; omitir = tamaño por CSS. */
  sizeOf?      : (m: T) => [number, number];
  /** Ancla `[x,y]` px; default = centro del `sizeOf`. */
  anchorOf?    : (m: T) => [number, number];
}

/** Handle de una html-layer (retorno de `MapEngine.addHtmlLayer`) — sólo acciones. */
export interface HtmlHandle<T = unknown> {
  readonly id     : string;
  readonly source : CristaeReadSource<T>;
  set(items: T[]): void;
  setVisible(visible: boolean): void;
}

// ── Labels (src/render/LabelLayer.js) ───────────────────────────────────────
/** Etiqueta resuelta que recibe el painter: posición, texto y acento opcional. */
/** Etiqueta de una label-layer. Opaca salvo `{id, lat, lng, text}`: el resto lo interpreta el
 *  painter (el default `drawLabel` lee `accent` para la franja lateral). */
export interface Label {
  id      : string | number;
  lat     : number;
  lng     : number;
  text    : string;
  accent? : string;
  [k: string]: unknown;
}
/** Paleta con la que se pinta la etiqueta. */
export interface LabelStyle {
  surface : string;
  text    : string;
  accent  : string;
}
/** Painter de etiqueta: recibe el ctx ya preparado y la etiqueta resuelta. */
export type LabelPaint = (
  ctx: CanvasRenderingContext2D,
  point: Point,
  label: Label,
  hovered: boolean,
  style: LabelStyle,
) => void;
/** Painter default de etiquetas (inyectable en la label-layer vía `paint`). */
export function drawLabel(
  ctx: CanvasRenderingContext2D,
  point: Point,
  label: Label,
  hovered: boolean,
  style?: LabelStyle,
): void;

// ── Tiles (src/tiles/presets.js) ─────────────────────────────────────────────
export const tilePresets: Record<
  string,
  { url: string; maxZoom?: number; attribution?: string }
>;

// ── Puntos (addPointLayer / <cristae-point-layer>) ──────────────────────────
export interface PointAccessors<T> extends Pick<SourceAccessors<T>, "hashOf"> {
  idOf       : (item: T) => string | number;
  positionOf : (item: T) => { lat: number; lng: number };
  /** Variante (string opaca) → tile del atlas. El core no la interpreta. */
  variantOf? : (item: T) => string;
  /** Tamaño en pantalla del sprite (px). Default = `iconSet.defaultSize`. */
  sizeOf?    : (item: T) => number;
  /** Rumbo en grados (0=N, 90=E). Sólo si el iconSet `rotates`. */
  headingOf? : (item: T) => number;
}

export interface ClusterConfig {
  radius?    : number;
  maxZoom?   : number;
  minPoints? : number;
  bubble?    : Record<string, unknown>;
}

export interface PointLayerConfig<T> {
  id           : string;
  accessors    : PointAccessors<T>;
  iconSet      : IconSet | string;
  /** Ruta `data` (el motor posee la Source) — mutuamente excluyente con `source`. */
  data?        : T[];
  /** Ruta `source` (el consumidor posee la Source; el motor sólo lee). */
  source?      : CristaeSource<T>;
  interactive? : boolean;
  pane?        : string;
  z?           : number;
  visible?     : boolean;
  enabled?     : boolean;
  where?       : (item: T) => boolean;
  filters?     : CristaeFilter<T>[];
  cluster?     : ClusterConfig;
}

/** Handle de una point-layer (retorno de `MapEngine.addPointLayer`). Acciones sobre la Source que el
 *  motor posee (ruta `data`); con ruta `source` los mutadores son no-op (el dueño es el consumidor). */
export interface PointHandle<T = unknown> {
  readonly id     : string;
  readonly source : CristaeReadSource<T>;
  readonly layer  : unknown;
  set(items: T[]): void;
  patch(items: T[], dirtyIds: Set<string | number>): void;
  move(id: string | number, lat: number, lng: number): void;
  remove(id: string | number): void;
  addFilter(filter: CristaeFilter<T>): void;
  removeFilter(filterId: unknown): void;
  /** Membresía por-capa: reconstruye SOLO esta capa (no toca la Source compartida). */
  setWhere(fn: ((item: T) => boolean) | null): void;
  preloadIcons(variants: string[]): void;
  /** Eje `focus` de la capa (ver `MapEngine.setLayerFocus`). */
  setFocus(ids?: Iterable<string | number> | null | false): void;
  refresh(): void;
  setVisible(visible: boolean): void;
  /** Membresía de la ENTIDAD (ortogonal a visible): off → aporta ∅ a sus modificadores. */
  setEnabled(enabled: boolean): void;
}

// ── Configs y handles de las demás capas ────────────────────────────────────
export interface PolygonLayerConfig<T> {
  /** Sustrato, leído al montar. `'gpu'` (default) rellena por stencil en una textura y toma UN contexto
   *  WebGL de los ~16 del navegador; `'leaflet'` monta un path por figura y no toma ninguno — conviene
   *  con pocas figuras o con varias capas de polígonos en la misma página. */
  backend?     : 'leaflet' | 'gpu';
  /** Opciones de path por default de la capa (las pisa `styleOf`). Sólo las usa el sustrato `gpu`. */
  color?       : string;
  weight?      : number;
  opacity?     : number;
  stroke?      : boolean;
  fill?        : boolean;
  fillColor?   : string;
  fillOpacity? : number;
  id           : string;
  /** Obligatorios salvo por la ruta `geometry`, donde no hay entidades que describir. */
  accessors?   : PolygonAccessors<T>;
  /** Ruta `data` (el motor posee la Source) — mutuamente excluyente con `source`. */
  data?        : T[];
  /** Ruta `source` (el consumidor posee la Source; el motor sólo lee). Se lee al montar. */
  source?      : CristaeSource<T>;
  /** Ruta `geometry`: las tablas del lector (`areasOf`), sin materializar un array. Implica
   *  `backend: 'gpu'` —un `L.polygon` no las sabe leer— y no admite mutación: no hay Source. */
  geometry?    : PolygonGpuGeometry;
  /** Id de la entidad. Sale de `accessors.idOf` cuando lo hay; por la ruta `geometry` recibe el índice
   *  de la FEATURE, y omitirlo ya identifica por feature (la geometría trae su `owner`). */
  idOf?        : (subject: T | number) => string | number;
  /** Estilo por entidad. Mismo criterio que `idOf` para el sujeto que recibe. El sustrato `gpu`
   *  entiende además `dash`, un patrón de trazo en px de pantalla (`null` o ausente: continuo). */
  styleOf?     : (subject: T | number) => Record<string, unknown>;
  pane?        : string;
  z?           : number;
  interactive? : boolean;
  visible?     : boolean;
}
export interface PolygonHandle<T = unknown> {
  readonly id      : string;
  /** `null` por la ruta `geometry`: la geometría tipada es inmutable y no hay Source que exponer. */
  readonly source? : CristaeReadSource<T> | null;
  set(items: T[]): void;
  setVisible(visible: boolean): void;
  /** Sólo sobre el sustrato `'gpu'`: el de Leaflet reproyecta solo y reevalúa `styleOf` con la Source. */
  redraw?(): void;
  style?(options: Record<string, unknown>): void;
}

// ── Círculos en METROS (addCircleLayer) — dibujados en la GPU, escalan con el zoom ──
export interface CircleAccessors<T> extends Pick<SourceAccessors<T>, "hashOf"> {
  idOf           : (c: T) => string | number;
  positionOf     : (c: T) => { lat: number; lng: number };
  /** Radio en METROS (escala con el zoom, a diferencia del sprite px fijo). */
  radiusMetersOf : (c: T) => number;
  /** Estilo por círculo, con el vocabulario de la capa de polígonos: `color`, `weight`, `opacity`,
   *  `fillColor`, `fillOpacity` y `dash`. Un `color` sin `fillColor` mueve también el relleno. */
  styleOf?       : (c: T) => Record<string, unknown>;
}
export interface CircleLayerConfig<T> {
  id           : string;
  accessors    : CircleAccessors<T>;
  data?        : T[];
  source?      : CristaeSource<T>;
  interactive? : boolean;
  pane?        : string;
  z?           : number;
  visible?     : boolean;
}
export interface CircleHandle<T = unknown> {
  readonly id     : string;
  readonly source : CristaeReadSource<T>;
  set(items: T[]): void;
  setVisible(visible: boolean): void;
}

// ── Heatmap (addHeatLayer) — canvas 2D, densidad acumulada ───────────────────
export interface HeatAccessors<T> extends Pick<SourceAccessors<T>, "hashOf"> {
  idOf       : (p: T) => string | number;
  positionOf : (p: T) => { lat: number; lng: number };
  /** Peso por punto (default 1); la densidad acumula por composición. */
  weightOf?  : (p: T) => number;
}
export interface HeatLayerConfig<T> {
  id         : string;
  accessors  : HeatAccessors<T>;
  data?      : T[];
  source?    : CristaeSource<T>;
  pane?      : string;
  z?         : number;
  visible?   : boolean;
  radius?    : number;
  blur?      : number;
  intensity? : number;
  colorRamp? : (t: number) => string | [number, number, number, number];
}
export interface HeatHandle<T = unknown> {
  readonly id     : string;
  readonly source : CristaeReadSource<T>;
  set(items: T[]): void;
  setVisible(visible: boolean): void;
  setRadius(radius: number): void;
  setBlur(blur: number): void;
  setIntensity(intensity: number): void;
  setColorRamp(ramp: (t: number) => string | [number, number, number, number]): void;
}

// ── Edición de geometría (addEditableLayer) — INPUT CONTROLADO. Ver docs/editing.md ──
export type EditableKind = "polygon" | "rectangle" | "polyline" | "point"
// La forma del `value` de cada editor, con el tipo de punto aparte: entra con los puntos en cualquiera
// de sus formas (el defecto) y sale con pares, `Editable*Value<[number, number]>`.
export type EditablePolygonValue<Point = LatLngPoint>   = Point[] | Point[][]
export type EditablePolylineValue<Point = LatLngPoint>  = Point[]
export type EditablePointValue<Point = LatLngPoint>     = Point | null
export type EditableRectangleValue<Point = LatLngPoint> = [Point, Point] | null
/** Parcial: lo que no venga queda como estaba. */
export interface EditableStyle {
  color?       : string;
  weight?      : number;
  fillColor?   : string;
  fillOpacity? : number;
}
export interface EditableConfig {
  id        : string;
  kind?     : EditableKind;
  style?    : EditableStyle;
  /** Geometría actual (controlada), con la forma del `Editable*Value` de su `kind`: los puntos entran
   *  en cualquiera de sus formas, y `onChange` / `onCommit` los devuelven como pares. */
  value?    : unknown;
  mode?     : "edit" | "draw";
  /** Cambio LIVE — cada frame de drag incluido. `leer()` devuelve el valor, con la forma de `value`. */
  onChange? : (leer: () => unknown) => void;
  /** Cambio ASENTADO — una vez por gesto (dragend / edición discreta). */
  onCommit? : (leer: () => unknown) => void;
  pane?     : string;
  z?        : number;
}
export interface EditableHandle {
  readonly id: string;
  setValue(value: unknown): void;
  setMode(mode: "edit" | "draw"): void;
  setStyle(style: EditableStyle): void;
  getValue(): unknown;
  /** Sub-pieza: captura de punto en modo draw (latlng de un click en espacio vacío). */
  handleMapClick(latlng: LatLngPoint): void;
  destroy(): void;
}

export interface LineLayerConfig<T> {
  id           : string;
  accessors    : LineAccessors<T>;
  data?        : T[];
  source?      : CristaeSource<T>;
  interactive? : boolean;
  pane?        : string;
  z?           : number;
  visible?     : boolean;
  /** Sustrato del trazo, leído al montar. `glify` (default) da picking y gradiente por vértice, pero el
   *  grosor sale de una brocha que barre `(4w+1)²` veces por feature y por frame. `gpu` dibuja un quad
   *  por segmento —grosor real, una pasada, sin picking ni gradiente— y toma UN contexto WebGL.
   *  `gpu` y `leaflet` dibujan dash. Ver docs/lines.md. */
  backend?     : 'glify' | 'gpu' | 'leaflet';
  /** Alias de `backend: 'leaflet'`. */
  vector?      : boolean;
}

export interface HtmlLayerConfig<T> {
  id           : string;
  accessors    : HtmlAccessors<T>;
  data?        : T[];
  source?      : CristaeSource<T>;
  interactive? : boolean;
  pane?        : string;
  z?           : number;
  visible?     : boolean;
}

export interface LabelLayerConfig<T = unknown> {
  id         : string;
  /** Id de la capa host cuyos ítems etiqueta (o standalone con `accessors`+`source`). */
  bindTo?    : string;
  pane?      : string;
  z?         : number;
  paint?     : LabelPaint;
  style?     : LabelStyle;
  textOf?    : (item: T) => string;
  accessors? : { idOf: (item: T) => string | number; positionOf: (item: T) => { lat: number; lng: number } };
  source?    : CristaeSource<T>;
}
export interface LabelHandle {
  readonly id: string;
  setLabels(labels: Array<{ id: string | number; lat: number; lng: number; text: string }>): void;
  setHovered(ids: Iterable<string | number>): void;
  setVisible(visible: boolean): void;
}

export interface OverlayConfig<T> {
  id         : string;
  /** Id del host de puntos: comparte su Source (posición viva) y su supresión de cluster. */
  hostId     : string;
  iconSet    : IconSet | string;
  variantOf? : (item: T) => string;
  sizeOf?    : (item: T) => number;
  where?     : (item: T) => boolean;
  visible?   : boolean;
}
export interface OverlayHandle<T = unknown> {
  readonly id     : string;
  readonly source : CristaeReadSource<T>;
  readonly layer  : unknown;
  refresh(): void;
  setWhere(fn: ((item: T) => boolean) | null): void;
  setVisible(visible: boolean): void;
}

// ── Overlay de interacción (addHighlightOverlay) ────────────────────────────
// El realce por-id (anillo/retículo de selección/seguimiento) como PASE DE COMPOSICIÓN SEPARADO: un
// canvas 2D anclado a la posición viva del host, O(K), SIN variantes de atlas ni acoplamiento a la
// rotación del sprite. Agnóstico: la CLAVE (p. ej. "select"/"follow") es opaca; el dibujo lo da el consumidor.
export interface HighlightOverlayConfig {
  id            : string;
  /** Id de la capa de puntos host (comparte su Source → posición viva, sin desincronía). */
  layerId       : string;
  /** Dibuja el tratamiento de una clave, con el ctx ya trasladado al punto proyectado. */
  drawHighlight : (ctx: CanvasRenderingContext2D, size: number, key: string) => void;
  z?            : number;
}
export interface HighlightOverlayHandle {
  readonly id: string;
  /** Ids resaltados → clave opaca. `null`/Map vacío = ninguno. Deriva de la selección/seguimiento del
   *  consumidor (el eje `focus` del motor no pasa por acá: lo resuelve cada capa en su dibujo). */
  setHighlighted(highlighted: Map<string | number, string> | null): void;
  redraw(): void;
  resize(): void;
  destroy(): void;
}

/** Control del cluster (retorno de `addCluster`): sesión de expansión (spiderfy), eje `marked`, etc.
 *  Superficie rica y en evolución por eje — el consumidor la castea según lo que use (ver docs/cluster.md). */
export type ClusterControl = Record<string, unknown>

// ── Cámara (MapEngine.camera) ────────────────────────────────────────────────
export interface Insets {
  top?    : number;
  right?  : number;
  bottom? : number;
  left?   : number;
}
/** Un píxel del contenedor del mapa. */
export interface Point {
  x : number;
  y : number;
}

/** Cámara: la ÚNICA vía de movimiento del viewport tras el montaje. Todo es ACCIÓN (imperativo). Los
 *  puntos entran en cualquier forma de `LatLngPoint` (lo que no lo es, SPECS §9), y lo que devuelve son
 *  objetos planos. */
export interface Camera {
  setView(latlng: LatLngPoint, zoom?: number): this;
  panTo(latlng: LatLngPoint): this;
  /** Vuela si la política de animación del zoom anima el cambio; si no, es un `setView` (SPECS §9). */
  flyTo(latlng: LatLngPoint, zoom?: number, options?: Record<string, unknown>): this;
  /** Encuadra una caja o un par de esquinas opuestas; lo que no lo es, `maxZoom` y `animate`: SPECS §9. */
  fitBounds(bounds: BoundsLike | null | undefined, options?: { insets?: Insets; maxZoom?: number; animate?: boolean }): this;
  fitToLayer(layerId: string, options?: { insets?: Insets; maxZoom?: number }): this;
  /** Enfoca un punto dejándolo visible (des-clusteriza subiendo el zoom si hace falta). */
  revealPoint(layerId: string, id: string | number, options?: { zoom?: number }): this;
  /** Sigue la posición VIVA de un id (re-centra en cada flush). `reveal` des-clusteriza al iniciar. */
  followPoint(layerId: string, id: string | number, options?: { zoom?: number; reveal?: boolean }): this;
  /** Encuadra (one-shot) el SUBCONJUNTO `ids` de una capa por sus posiciones válidas. */
  followBounds(layerId: string, ids: Iterable<string | number>, options?: { insets?: Insets; maxZoom?: number }): this;
  /** Navegación por conjunto: `mode:"fit"` encuadra el set; `mode:"track"` con UN id sigue su posición viva. */
  followPoints(layerId: string, ids: Iterable<string | number>, options?: { mode?: "fit" | "track"; zoom?: number; reveal?: boolean; insets?: Insets; maxZoom?: number }): this;
  focusPoints(layerId: string, ids: Iterable<string | number>, options?: { mode?: "fit" | "track" } & Record<string, unknown>): this;
  stopFollow(): this;
  getCenter(): LatLng;
  getZoom(): number;
  getBounds(): Bounds;
  /** Zoom mínimo efectivo: el límite `minZoom` si lo hay y, si no, el que permiten las capas. */
  getMinZoom(): number;
  /** Zoom máximo efectivo: el límite `maxZoom` si lo hay y, si no, la capacidad del tile. */
  getMaxZoom(): number;
  zoomIn(delta?: number): this;
  zoomOut(delta?: number): this;
  setZoom(zoom: number): this;
  panBy(offset: [number, number], options?: Record<string, unknown>): this;
  /** Proyección geográfica → píxel de contenedor (anclar overlays propios sin bajar a Leaflet). */
  latLngToContainerPoint(latlng: LatLngPoint): Point;
  containerPointToLatLng(point: Point | readonly [number, number]): LatLng;
}

// ── Motor y custom elements ──────────────────────────────────────────────────
declare const MAP_HOST: unique symbol

/** Un mapa de Leaflet adoptado para un `MapEngine`, que lo suelta en su `destroy()` (SPECS §6). */
export interface MapHost {
  readonly [MAP_HOST]: true;
}

/** Adopta un mapa de Leaflet que ya existe, construido por `leaflet`, para dárselo a un `MapEngine`
 *  (SPECS §6). */
export function adoptLeafletHost(map: unknown, options?: { leaflet?: unknown }): MapHost;

/** Con `host`, el motor trabaja sobre ese mapa y no lee `container`, `view` ni los límites; sin él, crea
 *  el suyo sobre `container`, sin controles (SPECS §6). */
export interface MapEngineOptions {
  host?               : MapHost;
  container?          : HTMLElement;
  /** Vista inicial del mapa propio. Default: `[0, 0]`, zoom 2. */
  view?               : { center?: LatLngPoint; zoom?: number };
  glify               : unknown;
  insets?             : Insets;
  hoverThrottleMs?    : number;
  /** Política de animación del zoom (SPECS §9). Sin ella, `"none"` en un mapa propio y la del dueño en
   *  uno adoptado. */
  zoomAnimation?      : "none" | "in-only" | "on";
  /** Cursor inicial del contenedor, con las reglas de `setCursor`. */
  cursor?             : string | null;
  /** Límites de la cámara del mapa propio, con las reglas de `setLimits`. */
  minZoom?            : number | null;
  maxZoom?            : number | null;
  maxBounds?          : BoundsLike | null;
  /** Cuánto resiste el borde de `maxBounds` al arrastre, de 0 (default) a 1. */
  maxBoundsViscosity? : number | null;
}

// Orquestador headless: monta sobre un mapa propio o adoptado, deriva panes por orden de declaración (el
// consumidor no toca z) y cablea registry + bus + Interaction (picking) + Camera. La superficie de
// INSTANCIA de las capas (props por ref del custom element, sesión de cluster) sigue siendo rica; el
// consumidor la castea según el eje que use (ver docs/ y SKILL.md).
export class MapEngine {
  constructor(options: MapEngineOptions);
  readonly ready  : Promise<MapEngine>;
  readonly camera : Camera;

  addPointLayer<T>(config: PointLayerConfig<T>): PointHandle<T>;
  addPolygonLayer<T>(config: PolygonLayerConfig<T>): PolygonHandle<T>;
  /** @deprecated Una sola puerta: `addPolygonLayer({ geometry, backend: 'gpu' })`. Se retira en 1.0. */
  addPolygonGpuLayer(config: PolygonGpuLayerConfig): PolygonGpuHandle;
  addLineLayer<T>(config: LineLayerConfig<T>): LineHandle<T>;
  addHtmlLayer<T>(config: HtmlLayerConfig<T>): HtmlHandle<T>;
  addLabelLayer<T>(config: LabelLayerConfig<T>): LabelHandle;
  addOverlay<T>(config: OverlayConfig<T>): OverlayHandle<T> | null;
  addHighlightOverlay(config: HighlightOverlayConfig): HighlightOverlayHandle | null;
  addCircleLayer<T>(config: CircleLayerConfig<T>): CircleHandle<T>;
  addHeatLayer<T>(config: HeatLayerConfig<T>): HeatHandle<T>;
  addEditableLayer(config: EditableConfig): EditableHandle;
  addCluster(config: { hostId: string } & ClusterConfig): ClusterControl | null;

  attachSource(id: string, source: CristaeSource): this;
  getLayer(id: string): unknown;
  /** Capa dueña de un objeto del pase de picking: el decodificador entrega (obj, chunk, local) y esto
   *  resuelve el primer eje. `null` si el id no está asignado (el 0 significa «nada»). */
  pickLayerOf(obj: number): { layerId: string; layer: unknown; obj: number } | null;
  removeLayer(id: string): boolean;
  setLayerVisibility(id: string, visible: boolean): boolean;
  setLayerEnabled(id: string, enabled: boolean): boolean;
  setLayerOpacity(id: string, alpha: number): void;

  /** Deja `ids` de CAPA a opacidad plena y atenúa el resto (`kinds` acota qué capas se atenúan). La capa
   *  nombrada queda además EXENTA del enfoque por ítem (ver `setLayerFocus`). */
  focus(ids: Iterable<string>, options?: { opacity?: number; kinds?: string[] }): void;
  unfocus(ids: Iterable<string>): void;
  unfocusAll(): void;

  /** Enfoque por ÍTEM: mientras alguna capa lo declare, `ids` queda a opacidad plena y se atenúa todo
   *  lo demás —el resto de esa capa y las otras capas también; el basemap NO—. Atenuado es
   *  presentación: sigue interactivo. Un id que la capa no dibuja (filtrado, clusterizado, sin posición
   *  finita) no aparece por estar enfocado. `ids` falsy = todo atenuado; `undefined` = la capa se
   *  retira del eje. Varias capas pueden declararlo a la vez (cross-layer). */
  setLayerFocus(layerId: string, ids?: Iterable<string | number> | null | false): this;

  /** Reapila una capa montada (z-index de su pane). `z` nulo vuelve al derivado en el alta. */
  setLayerZ(layerId: string, z?: number | null): this;

  /** Suscripción a un canal del bus o a una señal del motor (no es un CustomEvent del DOM: el payload
   *  llega DIRECTO al callback). Los canales de picking aceptan filtro por capa. Devuelve su función de
   *  baja. */
  on<K extends keyof BusChannels>(event: K, cb: BusChannels[K]): () => void;
  on<K extends keyof BusChannels>(event: K, layerIds: string | string[] | null, cb: BusChannels[K]): () => void;
  on<K extends keyof EngineSignals>(event: K, cb: EngineSignals[K]): () => void;
  registerIconSet(name: string, set: IconSet): this;
  createIcon(config: { size?: number; draw?: (ctx: CanvasRenderingContext2D, size: number) => void }): HTMLCanvasElement;
  setTileProvider(tile: { url: string; [k: string]: unknown }): this;
  /** Atribución del proveedor vigente, tal como se dio —HTML, como en Leaflet—, o `null`. El motor no la
   *  dibuja: docs/tiles.md#la-atribución. */
  getTileAttribution(): string | null;

  /** Política de animación del zoom, en vivo (SPECS §9). Aplica desde el zoom siguiente. */
  setZoomAnimation(mode: "none" | "in-only" | "on"): this;
  /** Límites de la cámara, en vivo: fija los cuatro, y el que falta o no es válido no limita (SPECS §9). */
  setLimits(limits: Pick<MapEngineOptions, "minZoom" | "maxZoom" | "maxBounds" | "maxBoundsViscosity">): this;
  /** Cursor del contenedor, en vivo: `null`, `''` o un valor que el CSS rechace es ninguno. Su precedencia
   *  frente al arrastre, el editor y el `pointer` automático: docs/interaction.md#el-cursor-del-contenedor. */
  setCursor(cursor: string | null): this;
  getLeafletMap(): unknown;
  syncSize(): void;
  invalidateCanvas(): void;
  /** Encuadra VARIAS capas a la vez (o todas las de datos si se omite `ids`) — multi-capa de camera.fitToLayer. */
  fitToLayers(ids?: Iterable<string> | null, options?: { insets?: Insets; maxZoom?: number }): this;
  destroy(): void;
}

export class CristaeMap extends HTMLElement {}
export class CristaePointLayer extends HTMLElement {}
export class CristaePolygonLayer extends HTMLElement {
  backend: 'leaflet' | 'gpu';
}
export class CristaeLineLayer extends HTMLElement {}
export class CristaeHtmlLayer extends HTMLElement {}
export class CristaeLabelLayer extends HTMLElement {}
export class CristaeCluster extends HTMLElement {}
export class CristaeOverlay extends HTMLElement {}
export class CristaeToolbar extends HTMLElement {}
export class CristaePopup extends HTMLElement {}

// ── Polígonos ESTÁTICOS en GPU (addPolygonGpuLayer) — stencil sobre geometría tipada ──
// Miles de anillos en una textura, sin Source: la geometría es inmutable y no se copia. La capa
// reactiva por items es `addPolygonLayer`.
export interface PolygonGpuGeometry {
  /** [2v] `xy[2i]` = lng, `xy[2i+1]` = lat — orden RFC. */
  xy         : Float64Array;
  /** [r+1] anillo → primer vértice. */
  vertexAt   : Uint32Array;
  /** [p+1] parte → primer anillo. */
  ringAt     : Uint32Array;
  /** [r] 1 = el último vértice repite al primero; la ingesta lo descuenta. */
  closed?    : Uint8Array;
  /** Totales de las tablas; `rings` y `parts` los reemplazan cuando vienen. */
  ringCount? : number;
  partCount? : number;
  /** Anillos a rellenar; sin él, todos. */
  rings?     : Uint32Array;
  /** Partes a indexar para hit-test; sin él, todas. */
  parts?     : Uint32Array;
}

export interface PolygonGpuLayerConfig {
  id           : string;
  geometry     : PolygonGpuGeometry;
  pane?        : string;
  z?           : number;
  /** Opciones de path de Leaflet, con sus mismos defaults. */
  color?       : string;   // trazo — '#3388ff'
  weight?      : number;   // ancho del trazo en px — 3
  opacity?     : number;   // opacidad del trazo — 1
  stroke?      : boolean;  // true
  fill?        : boolean;  // true
  fillColor?   : string;   // por defecto, `color`
  fillOpacity? : number;   // 0.2
  visible?     : boolean;
  /** Arma el índice point-in-poly; sólo entonces la capa retiene `geometry`. */
  interactive? : boolean;
  /** Parte → id de dominio del hit. Sin él, el id es el índice de parte. */
  idOf?        : (part: number) => unknown;
}

export interface PolygonGpuHandle {
  readonly id: string;
  redraw(): boolean;
  style(options?: { color?: string; opacity?: number }): boolean;
  setVisible(visible: boolean): boolean;
}
