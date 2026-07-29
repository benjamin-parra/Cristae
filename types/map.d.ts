// Tipos del entry `cristae/map` (mapa WebGL: Leaflet + glify con shaders propios).
// Importarlo REGISTRA los custom elements <cristae-*> (side effect). Mantener
// sincronizado con src/index.js; el núcleo de datos vive en ./core.d.ts.

// El re-export de abajo NO liga los nombres en este archivo: lo que se usa acá se importa.
import type { CristaeReadSource, CristaeSource, CristaeFilter } from "./core";

export type {
  SourceAccessors,
  CristaeReadSource,
  CristaeSource,
  CristaeFilter,
  CristaeListener,
} from "./core";
export { createSource, defineSource, makeFilter, makeListener } from "./core";

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
export interface PolygonAccessors<T> {
  idOf     : (g: T) => string | number;
  /** Anillos Leaflet `[[lat,lng],…]` o multi-anillo `[[[lat,lng],…],…]`. */
  ringsOf  : (g: T) => number[][] | number[][][];
  /** Opciones de `L.polygon` (color, fillColor, weight, opacity, …). */
  styleOf? : (g: T) => Record<string, unknown>;
}

// ── Líneas (addLineLayer / <cristae-line-layer>) ────────────────────────────
// GPU (glify.Lines) + gradiente per-vértice por bufferSubData + picking CPU nearest-segment.
// `dash` y el grosor real por triángulos NO están (deuda documentada — ver docs/lines.md).
export interface LineAccessors<T> {
  idOf       : (l: T) => string | number;
  /** Vértices del path en orden, `[lat, lng]`. Dos encodings (ver `toParts`): plano — un vértice no
   *  finito **corta** la línea (un track GPS con baches sale partido, no puenteado) — o anidado
   *  `[[[lat,lng],…],…]` con las partes explícitas. Una línea multi-parte sigue siendo UNA entidad:
   *  un id, un estilo, un hit. */
  pathOf     : (l: T) => Iterable<[number, number]> | Iterable<Iterable<[number, number]>>;
  /** Estilo PLANO por línea. `color` = `"#RRGGBB"` o `[r,g,b,a]` (0..1); `weight` en px de pantalla.
   *  `dash` (patrón `stroke-dasharray` en px) y `cap` SÓLO los dibuja el backend Leaflet
   *  (`vector:true`); el backend GL los ignora. Un solo eje `dash` cubre todos los patrones
   *  tradicionales: `[8,6]` guiones · `[1,6]`+`cap:'round'` punteado · `[12,5,1,5]`+`cap:'round'`
   *  raya-punto (línea de eje). */
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

// ── Hits de picking ─────────────────────────────────────────────────────────
// El resolver de cada capa aporta su parte y el registro la completa con layerId/kind/zIndex/order
// (ver HitResolver). La lista llega ordenada top-first (zIndex desc, order asc, distancePx asc), así
// que `hits[0]` desambigua sin recalcular geometría.

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
  latlng?        : { lat: number; lng: number };
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
  center   : { lat: number; lng: number } | null;
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
  hidden : Array<{ layerId: string | null; id: string | number; center: { lat: number; lng: number } }>;
}

// ── Canales del bus ─────────────────────────────────────────────────────────
// Un canal por entrada; la firma es la que el bus invoca (`callback(hits, baseEvent)`). En
// `pointer:move` no hay picking: los hits van `null` y la muestra viaja en el segundo argumento.

export interface PointerSample {
  lat : number;
  lng : number;
  x   : number;
  y   : number;
}

export interface BusChannels {
  'click'           : (hits: Hit[], event: MouseEvent | null) => void;
  'secondary-click' : (hits: Hit[], event: MouseEvent | null) => void;
  'hover'           : (hits: Hit[], event: MouseEvent | null) => void;
  'hover:start'     : (hits: Hit[], event: MouseEvent | null) => void;
  'hover:end'       : (hits: Hit[], event: MouseEvent | null) => void;
  'pointer:move'    : (hits: null, sample: PointerSample | null) => void;
  'cluster:expand'  : (session: ClusterSession) => void;
  'cluster:update'  : (session: ClusterSession) => void;
  'cluster:dismiss' : (detail: ClusterDismiss) => void;
  'cluster:marked'  : (snapshot: ClusterMarked) => void;
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
  point: { x: number; y: number },
  label: Label,
  hovered: boolean,
  style: LabelStyle,
) => void;
/** Painter default de etiquetas (inyectable en la label-layer vía `paint`). */
export function drawLabel(
  ctx: CanvasRenderingContext2D,
  point: { x: number; y: number },
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
export interface PointAccessors<T> {
  idOf       : (item: T) => string | number;
  positionOf : (item: T) => { lat: number; lng: number };
  /** Variante (string opaca) → tile del atlas. El core no la interpreta. */
  variantOf? : (item: T) => string;
  /** Tamaño en pantalla del sprite (px). Default = `iconSet.defaultSize`. */
  sizeOf?    : (item: T) => number;
  /** Rumbo en grados (0=N, 90=E). Sólo si el iconSet `rotates`. */
  headingOf? : (item: T) => number;
  /** Hash de cambio (default = idOf). Inclúyelo si el sprite depende de más que el id. */
  hashOf?    : (item: T) => string | number;
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
  id           : string;
  accessors    : PolygonAccessors<T>;
  data?        : T[];
  pane?        : string;
  z?           : number;
  interactive? : boolean;
  visible?     : boolean;
}
export interface PolygonHandle<T = unknown> {
  readonly id      : string;
  readonly source? : CristaeReadSource<T>;
  set(items: T[]): void;
  setVisible(visible: boolean): void;
}

// ── Círculos en METROS (addCircleLayer) — Leaflet-native, escala con el zoom ──
export interface CircleAccessors<T> {
  idOf           : (c: T) => string | number;
  positionOf     : (c: T) => { lat: number; lng: number };
  /** Radio en METROS (escala con el zoom, a diferencia del sprite px fijo). */
  radiusMetersOf : (c: T) => number;
  /** Opciones de `L.circle` (color, fillColor, weight, opacity, …). */
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
export interface HeatAccessors<T> {
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

// ── Edición de geometría (addEditableLayer) — INPUT CONTROLADO (Leaflet-native) ──
export type EditableKind = "polygon" | "rectangle" | "polyline" | "point"
export interface EditableConfig {
  id        : string;
  kind?     : EditableKind;
  /** Geometría actual (controlada): rings (polygon), `[lat,lng][]` (polyline), `[lat,lng]` (point),
   *  `[[s,w],[n,e]]` (rectangle). */
  value?    : unknown;
  mode?     : "edit" | "draw";
  /** Cambio LIVE — cada frame de drag incluido (misma forma que `value`). Para el preview del display. */
  onChange? : (value: unknown) => void;
  /** Cambio ASENTADO — una vez por gesto (dragend / edición discreta). Para persistir sin el spam del drag. */
  onCommit? : (value: unknown) => void;
  pane?     : string;
  z?        : number;
}
export interface EditableHandle {
  readonly id: string;
  setValue(value: unknown): void;
  setMode(mode: "edit" | "draw"): void;
  getValue(): unknown;
  /** Sub-pieza: captura de punto en modo draw (latlng de un click en espacio vacío). */
  handleMapClick(latlng: LatLngLike): void;
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
  /** Backend Leaflet-nativo (dash real) en vez de GL. */
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
  /** Ids resaltados → clave opaca. `null`/Map vacío = ninguno. Deriva de selectedIds/focus. */
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
export type LatLngLike = [number, number] | { lat: number; lng: number }

/** Cámara: la ÚNICA vía de movimiento del viewport tras el montaje. Todo es ACCIÓN (imperativo). */
export interface Camera {
  setView(latlng: LatLngLike, zoom?: number): this;
  panTo(latlng: LatLngLike): this;
  flyTo(latlng: LatLngLike, zoom?: number, options?: Record<string, unknown>): this;
  fitBounds(bounds: unknown, options?: { insets?: Insets }): this;
  fitToLayer(layerId: string, options?: { insets?: Insets; maxZoom?: number }): this;
  /** Enfoca un punto dejándolo visible (des-clusteriza subiendo el zoom si hace falta). */
  revealPoint(layerId: string, id: string | number, options?: { zoom?: number }): this;
  /** Sigue la posición VIVA de un id (re-centra en cada flush). `reveal` des-clusteriza al iniciar. */
  followPoint(layerId: string, id: string | number, options?: { zoom?: number; reveal?: boolean }): this;
  /** Encuadra (one-shot) el SUBCONJUNTO `ids` de una capa por sus puntos finitos. */
  followBounds(layerId: string, ids: Iterable<string | number>, options?: { insets?: Insets; maxZoom?: number }): this;
  /** Navegación por conjunto: `mode:"fit"` encuadra el set; `mode:"track"` con UN id sigue su posición viva. */
  followPoints(layerId: string, ids: Iterable<string | number>, options?: { mode?: "fit" | "track"; zoom?: number; reveal?: boolean; insets?: Insets; maxZoom?: number }): this;
  focusPoints(layerId: string, ids: Iterable<string | number>, options?: { mode?: "fit" | "track" } & Record<string, unknown>): this;
  stopFollow(): this;
  getCenter(): { lat: number; lng: number };
  getZoom(): number;
  getBounds(): unknown;
  /** Zoom máximo efectivo (capacidad del tile). */
  getMaxZoom(): number;
  zoomIn(delta?: number): this;
  zoomOut(delta?: number): this;
  setZoom(zoom: number): this;
  panBy(offset: [number, number], options?: Record<string, unknown>): this;
  /** Proyección geográfica → píxel de contenedor (anclar overlays propios sin bajar a Leaflet). */
  latLngToContainerPoint(latlng: LatLngLike): { x: number; y: number };
  containerPointToLatLng(point: { x: number; y: number }): { lat: number; lng: number };
}

// ── Motor y custom elements ──────────────────────────────────────────────────
export interface MapEngineOptions {
  leaflet          : unknown;
  glify            : unknown;
  container?       : HTMLElement;
  /** Mapa Leaflet existente a adoptar (en vez de crear uno con `container`). */
  map?             : unknown;
  mapOptions?      : Record<string, unknown>;
  insets?          : Insets;
  hoverThrottleMs? : number;
  zoomAnimation?   : "none" | "in-only" | "on";
  zoomControl?     : boolean;
}

// Orquestador headless: crea el L.map, deriva panes por orden de declaración (el consumidor no toca z)
// y cablea registry + bus + Interaction (picking) + Camera. La superficie de INSTANCIA de las capas
// (props por ref del custom element, sesión de cluster) sigue siendo rica; el consumidor la castea
// según el eje que use (ver docs/ y SKILL.md).
export class MapEngine {
  constructor(options: MapEngineOptions);
  readonly ready  : Promise<MapEngine>;
  readonly camera : Camera;

  addPointLayer<T>(config: PointLayerConfig<T>): PointHandle<T>;
  addPolygonLayer<T>(config: PolygonLayerConfig<T>): PolygonHandle<T>;
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
  removeLayer(id: string): boolean;
  setLayerVisibility(id: string, visible: boolean): boolean;
  setLayerEnabled(id: string, enabled: boolean): boolean;
  setLayerOpacity(id: string, alpha: number): void;

  /** Deja `ids` de CAPA a opacidad plena y atenúa el resto (`kinds` acota qué capas se atenúan). */
  focus(ids: Iterable<string>, options?: { opacity?: number; kinds?: string[] }): void;
  unfocus(ids: Iterable<string>): void;
  unfocusAll(): void;

  /** Enfoque por ÍTEM: mientras alguna capa lo declare, todas las capas se atenúan (el basemap NO) y
   *  los ítems enfocados se reponen brillantes encima. `ids` falsy = todo atenuado; `undefined` =
   *  la capa se retira del eje. Varias capas pueden declararlo a la vez (cross-layer). */
  setLayerFocus(layerId: string, ids?: Iterable<string | number> | null | false): this;

  /** Reapila una capa montada (z-index de su pane). `z` nulo vuelve al derivado en el alta. */
  setLayerZ(layerId: string, z?: number | null): this;

  /** Suscripción a un canal del bus (no es un CustomEvent del DOM: el payload llega DIRECTO al
   *  callback). Los canales de picking aceptan filtro por capa. Devuelve su función de baja. */
  on<K extends keyof BusChannels>(event: K, cb: BusChannels[K]): () => void;
  on<K extends keyof BusChannels>(event: K, layerIds: string | string[] | null, cb: BusChannels[K]): () => void;
  registerIconSet(name: string, set: IconSet): this;
  createIcon(config: { size?: number; draw?: (ctx: CanvasRenderingContext2D, size: number) => void }): HTMLCanvasElement;
  setTileProvider(tile: { url: string; [k: string]: unknown }): this;

  getLeafletMap(): unknown;
  /** Escape genérico al handler subyacente (Leaflet map, hoy). Usar sólo si falta una capacidad. */
  getUnsafeHandler(): unknown;
  syncSize(): void;
  invalidateCanvas(): void;
  /** Encuadra VARIAS capas a la vez (o todas las de datos si se omite `ids`) — multi-capa de camera.fitToLayer. */
  fitToLayers(ids?: Iterable<string> | null, options?: { insets?: Insets; maxZoom?: number }): this;
  destroy(): void;
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
