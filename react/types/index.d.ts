// Tipos de @cristae/react. Props tipadas POR componente, reusando los configs/accessors de `cristae/map`
// (PointAccessors, IconSet, ClusterConfig, …) — así el editor guía cada capa y un `data`/`accessors` mal
// formado se marca en compilación. El binding es un adaptador fino: React monta el custom element y el
// dato entra por PROPIEDAD (sin reconciliación en el hot-path); estos tipos describen esa superficie.
//
// Dos canales de evento, y el tipo del handler dice cuál es: `CristaeEventHandler<D>` recibe el
// CustomEvent `cristae:*` del DOM (los emite el `<cristae-map>`); `CristaeHitsHandler` recibe los hits
// DIRECTOS del BUS del motor (`map.on(canal[, layerId], cb)`), que no viaja por el DOM — ningún
// addEventListener lo recibe. El escape imperativo (cámara, motor, handle de capa) va por el `ref`.
//
// Los tipos del núcleo se importan RELATIVO (`../../types/map`) y no por el specifier `cristae/map`:
// el binding viaja DENTRO del paquete, cuyo nombre publicado no es `cristae`, así que el specifier bare
// sólo resolvería en un consumidor que además aliasee el paquete a ese nombre. React viene por
// `@types/react` (peer de facto de todo consumidor React+TS), igual que cualquier binding.

import type { ForwardRefExoticComponent, ReactElement, ReactNode, RefAttributes } from 'react'
import type {
  PointAccessors,
  LineAccessors,
  PolygonAccessors,
  HtmlAccessors,
  IconSet,
  Insets,
  Camera,
  MapEngine,
  PointHandle,
  LineHandle,
  PolygonHandle,
  HtmlHandle,
  LabelHandle,
  Label,
  LabelStyle,
  LabelPaint,
  CristaeReadSource,
  CristaeFilter,
} from '../../types/map'

/** Re-export de conveniencia: los tipos de Source con los que se anotan las props de dato. Una Source
 *  de `defineSource` es `CristaeReadSource`; sólo `createSource` devuelve la `CristaeSource` mutable. */
export type { CristaeReadSource, CristaeSource } from '../../types/map'

// ── Núcleo del binding (imperativo) ─────────────────────────────────────────

/** Aplica props a un custom element sin reconciliar su contenido, diffeando contra `prev`:
 *  string/número → atributo (kebab-case); booleano/objeto/función → propiedad (acá entra el dato);
 *  `on[A-Z]…` función → addEventListener. Devuelve el estado aplicado (para el próximo diff). */
export declare function applyElementProps(
  el: Element,
  prev: Record<string, unknown> | null,
  next: Record<string, unknown>,
  eventNameOf?: (key: string) => string,
): Record<string, unknown>;

/** Teardown de desmontaje: da de baja SÓLO los event listeners aplicados (atributos y propiedades
 *  mueren con el nodo). Lo llama `useCristaeElement` en su cleanup. */
export declare function detachElementListeners(
  el: Element,
  applied: Record<string, unknown>,
  eventNameOf?: (key: string) => string,
): void;

/** Hook: enlaza un `<cristae-*>` a props React (layout effect + applyElementProps; teardown de
 *  listeners al desmontar). Devuelve el ref del elemento. */
export declare function useCristaeElement(
  props: Record<string, unknown>,
  eventNameOf?: (key: string) => string,
): { current: HTMLElement | null };

// ── Hits de picking ─────────────────────────────────────────────────────────
// La lista llega ordenada top-first (`zIndex` desc, `order` asc, `distancePx` asc), así que el
// consumidor desambigua con `hits[0]` sin recalcular geometría (ver docs/interaction.md).

/** Campos que el registro pone en TODO hit, sea cual sea la capa. */
export interface CristaeHitBase {
  layerId: string;
  /** Id del DATO golpeado (`idOf` del ítem); `ref` es la misma referencia estable de la capa. */
  id: string | number;
  ref: string | number;
  /** Distancia en px del puntero al elemento (0 = dentro); sin geometría, `+Infinity`. */
  distancePx: number;
  /** z del pane y orden de declaración: definen el desempate top-first. */
  zIndex: number;
  order: number;
  /** Posición con la que un overlay presentó el hit (la hoja del spider, en su lugar desplegado). */
  latlng?: CristaeLatLng;
  /** Capa que presentó este hit en lugar de la propia (hoja del cluster → su capa host). */
  presentedFrom?: string;
}
export interface CristaePointHit extends CristaeHitBase { kind: 'point' }
export interface CristaePolygonHit extends CristaeHitBase { kind: 'polygon' }
export interface CristaeHtmlHit extends CristaeHitBase { kind: 'html' }
/** Sólo por `engine.addCircleLayer` (no hay elemento declarativo de círculos). */
export interface CristaeCircleHit extends CristaeHitBase { kind: 'circle' }
export interface CristaeLineHit extends CristaeHitBase {
  kind: 'line';
  /** Parte del path multi-parte que fue picada (ver `toParts`). */
  partIndex: number;
  /** Vértice donde arranca el segmento picado, en el espacio de índices de la ENTRADA de `pathOf`
   *  —el mismo que recibe `scalarOf`— para cruzar el hit con un array paralelo de dato. */
  vertexIndex: number;
}
export type CristaeHit =
  | CristaePointHit
  | CristaePolygonHit
  | CristaeHtmlHit
  | CristaeCircleHit
  | CristaeLineHit;

// ── Detalles de los CustomEvent cristae:* (los emite el <cristae-map>) ───────
// Los handlers `onX` de esta familia se cablean con addEventListener → reciben el CustomEvent del
// DOM; el dato útil viaja en `event.detail`.

export type CristaeLatLng = { lat: number; lng: number };

export interface CristaeViewportChangeDetail {
  center: CristaeLatLng;
  zoom: number;
  /** `L.LatLngBounds` (opaco — la lib no lo tipa hacia afuera). */
  bounds: unknown;
}
export interface CristaeMapClickDetail { latlng: CristaeLatLng }
export interface CristaeClickDetail { hits: CristaeHit[]; originalEvent?: Event }
export interface CristaeHoverDetail { hits: CristaeHit[] }
/** El elemento emite el evento con detail falsy si el motor no entrega estado. */
export type CristaePointerMoveDetail = { lat: number; lng: number; x: number; y: number } | null | undefined;

/** Handler de un evento cristae:* — recibe el CustomEvent del DOM; leer `event.detail`. */
export type CristaeEventHandler<D> = (event: CustomEvent<D>) => void;

/** Handler de un canal de picking del BUS del motor (`map.on('click' | 'hover' | …)`): NO es un
 *  CustomEvent — recibe los hits directos (filtrados por la capa que lo declara) y el evento del
 *  puntero que los originó (`null` en un `hover:end` derivado de una capa que dejó de resolver). */
export type CristaeHitsHandler = (hits: CristaeHit[], event: Event | null) => void;

// ── Props base ──────────────────────────────────────────────────────────────
// `className`/`style` NO se exponen a propósito: el aplicador imperativo los mapearía mal
// (`className` → atributo `class-name`); estilar el contenedor del `<CristaeMap>` desde el padre.

/** Zonas del overlay 3×3 del `<cristae-map>`, más el hueco del estado "sin datos". */
export type CristaeMapSlot =
  | 'top-left' | 'top-center' | 'top-right'
  | 'center-left' | 'center' | 'center-right'
  | 'bottom-left' | 'bottom-center' | 'bottom-right'
  | 'empty';
/** Slots de un `<cristae-cluster>`: `bubble` = cómo se ven las burbujas, `center` = botón central. */
export type CristaeClusterSlot = 'bubble' | 'center';

interface CristaeBaseProps {
  /** En una capa, fija su id de capa en el motor (si se omite, la capa lo auto-genera). En el map /
   *  popup es el `id` del DOM. */
  id?: string;
  slot?: CristaeMapSlot | CristaeClusterSlot;
  children?: ReactNode;
}

/** Props comunes a toda CAPA (no al `<CristaeMap>`), espejo de `CristaeLayerElement` — el cluster y
 *  el overlay también son capas y por eso participan del eje focus. */
interface CristaeLayerProps extends CristaeBaseProps {
  /** Eje `focus` por ítem. Ids enfocados → esos quedan plenos y TODO lo demás (esta capa y las otras)
   *  se atenúa; el basemap no. `[]` = participa sin ninguno → todo atenuado; omitir la prop = la capa
   *  no participa. No acepta `null`: un valor nulo se aplica como baja de ATRIBUTO y nunca llegaría al
   *  setter, dejando vivos los ids anteriores — para atenuar todo va `[]`.
   *  Se llama `focusIds` y no `focus` porque una prop `focus` pisaría `HTMLElement.focus()`. */
  focusIds?: Iterable<string | number>;
}

/** Capas HOJA — las que dan de alta una capa en el motor y por eso declaran su APILADO. Los
 *  modificadores (cluster / overlay) no lo declaran: sus capas las crea la gramática, y un solo `z`
 *  no mapearía a una sola capa. */
interface CristaeLeafLayerProps extends CristaeLayerProps {
  /** Pane propio de la capa; por default el motor le crea uno (`cristae-<kind>-<id>`). Se lee en el
   *  alta: cambiarlo después no muda la capa de pane. */
  pane?: string;
  /** z-index del pane, reactivo. Sin él el motor lo DERIVA del orden de declaración (`400 + orden·10`),
   *  así que las mismas capas montadas en otro orden apilan distinto. Panes nativos de Leaflet que
   *  conviven en el mismo mapa: tiles 200 · overlay 400 · marker 600 · tooltip 650 · popup 700. */
  z?: number;
}

/** Capas de DATO: además del apilado y el eje focus, sus canales de picking. Cada handler se suscribe al BUS del
 *  motor FILTRADO por esta capa (`map.on(canal, layerId, cb)`) — no hay CustomEvent que escuchar en
 *  el elemento de capa: los emite el mapa y burbujean hacia ARRIBA. El filtro sale del handle vivo, y
 *  antes de montar, del `id` declarado; una capa sin `id` queda a la espera y se cabla sola en el
 *  `cristae:ready` (el mapa monta las pendientes antes de emitirlo). */
interface CristaeDataLayerProps extends CristaeLeafLayerProps {
  onClick?: CristaeHitsHandler;
  /** Botón secundario / long-press (canal discreto del motor, sin CustomEvent). */
  onSecondaryClick?: CristaeHitsHandler;
  onHover?: CristaeHitsHandler;
  /** Entrada/salida del set de hover (deltas que deriva el EventBus). */
  onHoverStart?: CristaeHitsHandler;
  onHoverEnd?: CristaeHitsHandler;
}

export interface CristaeTileProvider {
  url: string;
  maxZoom?: number;
  attribution?: string;
  subdomains?: string | string[];
  [k: string]: unknown;
}

// ── <CristaeMap> ─────────────────────────────────────────────────────────────

/** El `<cristae-map>` vivo, por `ref`: la única puerta a la cámara y al motor. `engine`/`camera` son
 *  getters VIVOS y `null` hasta montar — tras un detach+reattach son OTRA instancia, así que no se
 *  cachean en una variable. */
export interface CristaeMapElement extends HTMLElement {
  /** Resuelve con el motor en el PRIMER montaje (one-shot por instancia); el evento `cristae:ready`
   *  se re-emite en cada montaje. */
  readonly ready: Promise<MapEngine>;
  readonly engine: MapEngine | null;
  readonly camera: Camera | undefined;
  /** Suscripción al bus del motor, con filtro por capa: `on('click', 'fleet', cb)`. Devuelve la baja.
   *  Único miembro que NO es nil-safe (a diferencia de `getLayer`/`invalidateCanvas`): lanza si el
   *  motor todavía no montó — usarlo dentro de `onReady` / `ready.then(…)`, o `engine?.on(…)`. */
  on: MapEngine['on'];
  getLayer(id: string): unknown;
  invalidateCanvas(): void;
}

export interface CristaeMapProps extends CristaeBaseProps {
  /** Proveedor de tiles (capa base). Objeto → propiedad; el shell suele derivarlo del tema. */
  tile?: CristaeTileProvider;
  worldCopies?: boolean;
  noZoomControl?: boolean;
  /** Franjas del contenedor ocluidas por UI del consumidor (paneles) — reactivo. */
  viewportInsets?: Insets;
  hoverThrottle?: number;
  /** `[lat, lng]` o `"lat,lng"`. */
  initialCenter?: [number, number] | string;
  initialZoom?: number;
  /** El elemento lo reenvía verbatim al motor: `"on"` es contrato de `MapEngineOptions`, la doc del
   *  elemento sólo enumera `"none"` (default) y `"in-only"`. */
  zoomAnimation?: 'none' | 'in-only' | 'on';
  /** Mensaje del estado "sin datos" (o usar un hijo `slot="empty"`). */
  emptyMessage?: string;

  onReady?: CristaeEventHandler<Record<string, never>>;
  onViewportChange?: CristaeEventHandler<CristaeViewportChangeDetail>;
  /** Click en el MAPA (área libre, con latlng) — distinto de `onClick` (hits de features). */
  onMapClick?: CristaeEventHandler<CristaeMapClickDetail>;
  onClick?: CristaeEventHandler<CristaeClickDetail>;
  onHover?: CristaeEventHandler<CristaeHoverDetail>;
  onPointerMove?: CristaeEventHandler<CristaePointerMoveDetail>;
  onInteractionStart?: CristaeEventHandler<Record<string, never>>;
  onInteractionEnd?: CristaeEventHandler<Record<string, never>>;
  /** Canales del BUS (todas las capas, sin filtro): el motor no los puentea a CustomEvent. */
  onSecondaryClick?: CristaeHitsHandler;
  onHoverStart?: CristaeHitsHandler;
  onHoverEnd?: CristaeHitsHandler;
}
export declare const CristaeMap: ForwardRefExoticComponent<CristaeMapProps & RefAttributes<CristaeMapElement>>;

// ── Capas de dato (genéricas sobre el ítem T) ────────────────────────────────
// `data` (el motor posee la Source) y `source` (el consumidor la posee y la comparte entre vistas) son
// las dos entradas de dato. Ambas por PROPIEDAD → los updates fluyen por el core reactivo, sin React.
// El `ref` de cada capa expone su `controls`: el handle del motor, camino soportado de la ruta caliente
// (`move`/`patch`/`addFilter`/`setWhere`) sin re-render. Es `null` hasta que la capa monta.

export interface CristaePointLayerElement<T = unknown> extends HTMLElement { readonly controls: PointHandle<T> | null }
export interface CristaeLineLayerElement<T = unknown> extends HTMLElement { readonly controls: LineHandle<T> | null }
export interface CristaePolygonLayerElement<T = unknown> extends HTMLElement { readonly controls: PolygonHandle<T> | null }
export interface CristaeHtmlLayerElement<T = unknown> extends HTMLElement { readonly controls: HtmlHandle<T> | null }
export interface CristaeLabelLayerElement extends HTMLElement { readonly controls: LabelHandle | null }

export interface CristaePointLayerProps<T = unknown> extends CristaeDataLayerProps {
  data?: T[];
  source?: CristaeReadSource<T>;
  accessors?: PointAccessors<T>;
  iconSet?: IconSet | string;
  filters?: CristaeFilter<T>[];
  /** Membresía por-capa: filtra qué ítems entran a ESTA capa sin tocar la Source compartida. */
  where?: (item: T) => boolean;
  interactive?: boolean;
  visible?: boolean;
  /** Membresía de la entidad en la composición (default true): off → aporta ∅ a los modificadores. */
  enabled?: boolean;
  /** `"once"`: encuadra la capa al llegar los primeros puntos. */
  autoFit?: 'once';
}
export declare function CristaePointLayer<T = unknown>(
  props: CristaePointLayerProps<T> & RefAttributes<CristaePointLayerElement<T>>,
): ReactElement | null;

export interface CristaeLineLayerProps<T = unknown> extends CristaeDataLayerProps {
  data?: T[];
  source?: CristaeReadSource<T>;
  accessors?: LineAccessors<T>;
  interactive?: boolean;
  visible?: boolean;
  /** Backend Leaflet-nativo (dash real) en vez de GL. */
  vector?: boolean;
}
export declare function CristaeLineLayer<T = unknown>(
  props: CristaeLineLayerProps<T> & RefAttributes<CristaeLineLayerElement<T>>,
): ReactElement | null;

export interface CristaePolygonLayerProps<T = unknown> extends CristaeDataLayerProps {
  data?: T[];
  accessors?: PolygonAccessors<T>;
  interactive?: boolean;
  visible?: boolean;
}
export declare function CristaePolygonLayer<T = unknown>(
  props: CristaePolygonLayerProps<T> & RefAttributes<CristaePolygonLayerElement<T>>,
): ReactElement | null;

export interface CristaeHtmlLayerProps<T = unknown> extends CristaeDataLayerProps {
  data?: T[];
  source?: CristaeReadSource<T>;
  accessors?: HtmlAccessors<T>;
  interactive?: boolean;
  visible?: boolean;
}
export declare function CristaeHtmlLayer<T = unknown>(
  props: CristaeHtmlLayerProps<T> & RefAttributes<CristaeHtmlLayerElement<T>>,
): ReactElement | null;

/** Etiqueta de una label-layer. Opaca salvo `{id, lat, lng, text}`: el resto lo interpreta el painter
 *  (el default `drawLabel` lee `accent` para la franja lateral). */
// Alias de los tipos del núcleo (no copias): así `paint={drawLabel}` calza y no pueden divergir.
export type CristaeLabel = Label;
export type CristaeLabelStyle = LabelStyle;
/** Painter inyectable de la etiqueta (default `drawLabel` de `cristae/map`), con el ctx ya preparado. */
export type CristaeLabelPaint = LabelPaint;

export interface CristaeLabelLayerProps<T = unknown> extends CristaeLeafLayerProps {
  /** Id de la capa host cuyos ítems etiqueta (attachment); o standalone con `source`+`accessors`. */
  bindTo?: string;
  source?: CristaeReadSource<T>;
  accessors?: { idOf: (item: T) => string | number; positionOf: (item: T) => CristaeLatLng };
  textOf?: (item: T) => string;
  paint?: CristaeLabelPaint;
  style?: CristaeLabelStyle;
  visible?: boolean;
}
export declare function CristaeLabelLayer<T = unknown>(
  props: CristaeLabelLayerProps<T> & RefAttributes<CristaeLabelLayerElement>,
): ReactElement | null;

// ── Modificadores de composición (envuelven capas de puntos) ─────────────────

/** Una entidad desclusterizada de la sesión, con su capa de origen (un fold puede envolver varias
 *  capas). `layerId`/`item` son `null` si el id ya no resuelve en ninguna. */
export interface CristaeClusterEntity<T = unknown> {
  layerId: string | null;
  id: string | number;
  item: T | null;
}
export interface CristaeClusterGroup<T = unknown> {
  id: string | number;
  count: number;
  expanded: boolean;
  entities: CristaeClusterEntity<T>[];
}
/** Sesión de expansión (spiderfy) publicada por el bus. `groups` viene `[]` cuando la burbuja base es
 *  plana (pocas hojas): ahí el consumidor usa `entities`. */
export interface CristaeClusterSession<T = unknown> {
  id: string | number;
  center: CristaeLatLng | null;
  count: number;
  entities: CristaeClusterEntity<T>[];
  groups: CristaeClusterGroup<T>[];
}
export interface CristaeClusterDismiss { id: string | number; reason: 'collapse' | 'zoom' }
/** Eje `marked`, level-triggered: la verdad completa de los ids marcados que quedaron OCULTOS dentro
 *  de una burbuja (con el centro de la burbuja que los tapa). Vacío = ninguno oculto. */
export interface CristaeClusterMarked {
  hidden: Array<{ layerId: string | null; id: string | number; center: CristaeLatLng }>;
}

/** El `<cristae-cluster>` vivo, por `ref`. `bubbleLayerId`/`subBubbleLayerId` son los ids con los que
 *  suscribirse a los hits de las burbujas por el bus; `session`/`contentsOf` componen el panel de
 *  detalle. `clusterId` es EFÍMERO (id de Supercluster del frame actual): sólo vale recién obtenido. */
export interface CristaeClusterElement<T = unknown> extends HTMLElement {
  readonly session: CristaeClusterSession<T> | null;
  readonly marked: CristaeClusterMarked;
  readonly bubbleLayerId: string | null;
  readonly subBubbleLayerId: string | null;
  get markedIds(): Array<string | number>;
  set markedIds(ids: Iterable<string | number> | null);
  /** Ids desclusterizados, o `null` si el cluster ya no existe. */
  expand(clusterId: string | number): Array<string | number> | null;
  collapse(clusterId: string | number): void;
  collapseAll(): void;
  isExpanded(clusterId: string | number): boolean;
  /** Ids de dato de una burbuja BASE del frame actual (consulta pura). */
  contentsOf(clusterId: string | number): Array<string | number> | null;
}

export interface CristaeClusterProps<T = unknown> extends CristaeLayerProps {
  radius?: number;
  maxZoom?: number;
  minPoints?: number;
  /** Toggle de clustering (default true); off → sin agrupar, sin desmontar. */
  enabled?: boolean;
  /** Toggle de expand/collapse al click (default true). */
  expandable?: boolean;
  /** Al expandir, atenúa el resto del mapa (default false). */
  dimRest?: boolean;
  dimRestOpacity?: number;
  /** Con ids marcados, atenúa el resto del mapa (default false). */
  dimMarked?: boolean;
  /** Capas del consumidor que quedan brillantes al atenuar (por ref). */
  dimRestExcept?: unknown;
  /** Umbral círculo→espiral del spider (número o `"auto"`). */
  circleThreshold?: number | 'auto';
  spiralGap?: number;
  /** Fondo de sub-burbujas (+ traza si no hay `lineColor`). */
  accent?: string;
  /** Color de la traza que une los elementos de la espiral. */
  lineColor?: string;
  /** Ids de dato marcados (eje `marked`): las burbujas que los contengan usan la variante `marked`.
   *  El setter del elemento acepta cualquier iterable — un `Set` es lo natural en React. `[]` limpia
   *  las marcas; `null` no, por la misma razón que `focusIds` (se aplicaría como baja de atributo). */
  markedIds?: Iterable<string | number>;
  /** Sesión de expansión, por el BUS del motor (`cluster:*`): nueva sesión / cambio estructural
   *  (drill de sub-burbuja, poda o crecimiento) / cierre por colapso o zoom. */
  onClusterExpand?: (session: CristaeClusterSession<T>) => void;
  onClusterUpdate?: (session: CristaeClusterSession<T>) => void;
  onClusterDismiss?: (dismiss: CristaeClusterDismiss) => void;
  onClusterMarked?: (marked: CristaeClusterMarked) => void;
}
export declare function CristaeCluster<T = unknown>(
  props: CristaeClusterProps<T> & RefAttributes<CristaeClusterElement<T>>,
): ReactElement | null;

export interface CristaeOverlayProps<T = unknown> extends CristaeLayerProps {
  /** IconSet del badge (rotates:false). Objeto por ref o nombre registrado. */
  iconSet?: IconSet | string;
  variantOf?: (item: T) => string;
  sizeOf?: (item: T) => number;
  /** Sólo los ítems que tienen badge entran. */
  where?: (item: T) => boolean;
  visible?: boolean;
}
export declare function CristaeOverlay<T = unknown>(
  props: CristaeOverlayProps<T> & RefAttributes<HTMLElement>,
): ReactElement | null;

// ── <CristaePopup> ───────────────────────────────────────────────────────────

/** El `<cristae-popup>` vivo, por `ref`: abrir una tarjeta desde una fila de tabla, cerrar una por id
 *  de dato, o re-ejecutar `contentOf` de lo abierto (p. ej. al cambiar el idioma). */
export interface CristaePopupElement<T = unknown> extends HTMLElement {
  /** Sin `latlng` el ancla es VIVA (la posición del item en la Source de su capa `for`). */
  open(item: T, latlng?: CristaeLatLng): void;
  /** Por id de DATO; sin argumento cierra todas. */
  close(id?: string | number): void;
  refresh(): void;
}

export interface CristaePopupProps<T = unknown> extends CristaeBaseProps {
  /** Id(s) de capa cuyos clicks abren la tarjeta (token-list separada por espacios). */
  for?: string;
  /** `[dx, dy]` px desde el punto (default `[0, -12]`). */
  offset?: [number, number];
  autoPan?: boolean;
  autoPanPadding?: [number, number];
  pinned?: boolean;
  clip?: boolean;
  follow?: boolean;
  /** Tarjetas simultáneas (default 1 = abrir reemplaza). */
  maxOpen?: number;
  /** Keep-in-view opt-in: etapas `flip`/`shift`/`clip` (string "flip shift" o array). */
  fit?: string | Array<'flip' | 'shift' | 'clip'>;
  fitPadding?: [number, number];
  /** Contenido de la tarjeta para un ítem — string HTML o Node. Es la vía de contenido (no `children`).
   *  Devolver `null`/`undefined` ABORTA la apertura o el re-render. */
  contentOf?: (item: T) => string | Node | null | undefined;
}
export declare function CristaePopup<T = unknown>(
  props: CristaePopupProps<T> & RefAttributes<CristaePopupElement<T>>,
): ReactElement | null;

// ── <CristaeToolbar> ─────────────────────────────────────────────────────────
export interface CristaeToolbarItem {
  id: string;
  title?: string;
  /** Markup SVG/HTML del icono. */
  icon?: string;
  onClick?: (item: CristaeToolbarItem, event: Event) => void;
  active?: boolean;
  badge?: string | number;
  color?: string;
  bgColor?: string;
  selectedColor?: string;
}
export interface CristaeToolbarProps extends CristaeBaseProps {
  items?: CristaeToolbarItem[];
  orientation?: 'vertical' | 'horizontal';
}
export declare const CristaeToolbar: ForwardRefExoticComponent<CristaeToolbarProps & RefAttributes<HTMLElement>>;

// ── <CristaeTable> ───────────────────────────────────────────────────────────
// El OTRO entry de la lib (`import 'cristae/table'` registra el elemento — no lo arrastra `cristae/map`).
// No es una capa ni va dentro del `<CristaeMap>`: es standalone y consume el MISMO contrato Source, así
// que una fuente alimenta mapa y tabla a la vez.

// Sin `children` ni `slot`: el elemento renderiza en LIGHT DOM (su render root ES el elemento), así que
// un hijo de React lo pisaría el render de Lit; y al ser standalone no hay zona de overlay donde ubicarlo.
export interface CristaeTableProps<T = unknown> extends Omit<CristaeBaseProps, 'children' | 'slot'> {
  source?: CristaeReadSource<T>;
  data?: T[];
  /** HTML de UNA fila con atributos `data-ref` (molde clonado al pool). */
  template?: string;
  /** Llena los nodos `data-ref` de la fila clonada (sin reconstruir el árbol). */
  binder?: (refs: Record<string, HTMLElement>, item: T, rowNumber: number) => void;
  comparator?: (a: T, b: T) => number;
  /** Campo a buscar por ítem (habilita la búsqueda). */
  searchBy?: (item: T) => unknown;
  /** Predicado de match custom (default: `includes` case-insensitive). */
  searchFilter?: (query: string, item: T, value: unknown) => boolean;
  rowHeight?: number;
  pageSize?: number;
  maxButtons?: number;
  search?: string;
  countLabel?: string;
  scrollHeight?: string;
  /** `row` es el índice 1-based de la fila en el DOM (el que resuelve `itemAtRow`). */
  onRowClick?: CristaeEventHandler<{ item: T; row: number }>;
}
export declare function CristaeTable<T = unknown>(
  props: CristaeTableProps<T> & RefAttributes<HTMLElement>,
): ReactElement | null;
