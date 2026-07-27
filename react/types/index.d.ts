// Tipos de @cristae/react. Props tipadas POR componente, reusando los configs/accessors de `cristae/map`
// (PointAccessors, IconSet, ClusterConfig, …) — así el editor guía cada capa y un `data`/`accessors` mal
// formado se marca en compilación. El binding es un adaptador fino: React monta el custom element y el
// dato entra por PROPIEDAD (sin reconciliación en el hot-path); estos tipos describen esa superficie.
//
// La dependencia de tipos es `cristae` (peer): en un consumidor con cristae instalado, los imports
// `from 'cristae/map'` resuelven a sus .d.ts. React viene por `@types/react` (peer de facto de todo
// consumidor React+TS), igual que cualquier binding (@react-leaflet).

import type { FC, ReactElement, ReactNode } from 'react'
import type {
  PointAccessors,
  LineAccessors,
  PolygonAccessors,
  HtmlAccessors,
  IconSet,
  Insets,
  CristaeSource,
  CristaeFilter,
} from 'cristae/map'

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

// ── Detalles de los CustomEvent cristae:* (los emite el <cristae-map>) ───────
// Los handlers `onX` se cablean con addEventListener → reciben el CustomEvent del DOM; el dato útil
// viaja en `event.detail`.

export type CristaeLatLng = { lat: number; lng: number };

/** Un hit de picking (punto/línea/polígono/html). La forma varía por tipo de capa; estos campos son
 *  los comunes que consume el ruteo de clicks/hover. */
export interface CristaeHit {
  layerId: string;
  id: string | number;
  ref?: number;
  latlng?: CristaeLatLng;
  kind?: string;
  distancePx?: number;
  /** Capa que un overlay presentó en lugar de la propia (hoja → entidad). */
  presentedFrom?: string;
  [k: string]: unknown;
}

export interface CristaeViewportChangeDetail {
  center: CristaeLatLng;
  zoom: number;
  /** `L.LatLngBounds` (opaco — la lib no lo tipa hacia afuera). */
  bounds: unknown;
}
export interface CristaeMapClickDetail { latlng: CristaeLatLng }
export interface CristaeClickDetail { hits: CristaeHit[]; originalEvent?: Event }
export interface CristaeHoverDetail { hits: CristaeHit[] }
export type CristaePointerMoveDetail = { lat: number; lng: number; x: number; y: number } | null;

/** Handler de un evento cristae:* — recibe el CustomEvent del DOM; leer `event.detail`. */
export type CristaeEventHandler<D> = (event: CustomEvent<D>) => void;

// ── Props base ──────────────────────────────────────────────────────────────
// `className`/`style` NO se exponen a propósito: el aplicador imperativo los mapearía mal
// (`className` → atributo `class-name`); estilar el contenedor del `<CristaeMap>` desde el padre.
interface CristaeBaseProps {
  /** En una capa, fija su id de capa en el motor (si se omite, la capa lo auto-genera). En el map /
   *  popup es el `id` del DOM. */
  id?: string;
  /** Zona del overlay del `<cristae-map>` donde se coloca el hijo (top-left, center, bottom-right, …),
   *  o `bubble`/`center` dentro de un `<cristae-cluster>`. */
  slot?: string;
  children?: ReactNode;
}

/** Props comunes a toda CAPA (no al `<CristaeMap>`), espejo de `CristaeLayerElement`. */
interface CristaeLayerProps extends CristaeBaseProps {
  /** Eje `focus` por ítem. Ids enfocados → esos quedan plenos y TODO lo demás (esta capa y las otras)
   *  se atenúa; el basemap no. Falsy (`null`/`[]`) = todo atenuado; omitido = la capa no participa.
   *  Se llama `focusIds` y no `focus` porque una prop `focus` pisaría `HTMLElement.focus()`. */
  focusIds?: Iterable<string | number> | null;
}

export interface CristaeTileProvider {
  url: string;
  maxZoom?: number;
  attribution?: string;
  subdomains?: string | string[];
  [k: string]: unknown;
}

// ── <CristaeMap> ─────────────────────────────────────────────────────────────
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
}
export declare const CristaeMap: FC<CristaeMapProps>;

// ── Capas de dato (genéricas sobre el ítem T) ────────────────────────────────
// `data` (el motor posee la Source) y `source` (el consumidor la posee y la comparte entre vistas) son
// las dos entradas de dato. Ambas por PROPIEDAD → los updates fluyen por el core reactivo, sin React.

export interface CristaePointLayerProps<T = unknown> extends CristaeLayerProps {
  data?: T[];
  source?: CristaeSource<T>;
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
export declare function CristaePointLayer<T = unknown>(props: CristaePointLayerProps<T>): ReactElement | null;

export interface CristaeLineLayerProps<T = unknown> extends CristaeLayerProps {
  data?: T[];
  source?: CristaeSource<T>;
  accessors?: LineAccessors<T>;
  interactive?: boolean;
  visible?: boolean;
  /** Backend Leaflet-nativo (dash real) en vez de GL. */
  vector?: boolean;
}
export declare function CristaeLineLayer<T = unknown>(props: CristaeLineLayerProps<T>): ReactElement | null;

export interface CristaePolygonLayerProps<T = unknown> extends CristaeLayerProps {
  data?: T[];
  accessors?: PolygonAccessors<T>;
  interactive?: boolean;
  visible?: boolean;
}
export declare function CristaePolygonLayer<T = unknown>(props: CristaePolygonLayerProps<T>): ReactElement | null;

export interface CristaeHtmlLayerProps<T = unknown> extends CristaeLayerProps {
  data?: T[];
  source?: CristaeSource<T>;
  accessors?: HtmlAccessors<T>;
  interactive?: boolean;
  visible?: boolean;
}
export declare function CristaeHtmlLayer<T = unknown>(props: CristaeHtmlLayerProps<T>): ReactElement | null;

export interface CristaeLabelLayerProps<T = unknown> extends CristaeLayerProps {
  /** Id de la capa host cuyos ítems etiqueta (attachment); o standalone con `source`+`accessors`. */
  bindTo?: string;
  source?: CristaeSource<T>;
  accessors?: { idOf: (item: T) => string | number; positionOf: (item: T) => CristaeLatLng };
  textOf?: (item: T) => string;
  /** Painter inyectable de la etiqueta (default `drawLabel`). */
  paint?: unknown;
  style?: Record<string, unknown>;
  visible?: boolean;
}
export declare function CristaeLabelLayer<T = unknown>(props: CristaeLabelLayerProps<T>): ReactElement | null;

// ── Modificadores de composición (envuelven capas de puntos) ─────────────────
export interface CristaeClusterProps extends CristaeBaseProps {
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
  /** Ids de dato marcados (eje `marked`): las burbujas que los contengan usan la variante `marked`. */
  markedIds?: Array<string | number>;
}
export declare const CristaeCluster: FC<CristaeClusterProps>;

export interface CristaeOverlayProps<T = unknown> extends CristaeBaseProps {
  /** IconSet del badge (rotates:false). Objeto por ref o nombre registrado. */
  iconSet?: IconSet | string;
  variantOf?: (item: T) => string;
  sizeOf?: (item: T) => number;
  /** Sólo los ítems que tienen badge entran. */
  where?: (item: T) => boolean;
  visible?: boolean;
}
export declare function CristaeOverlay<T = unknown>(props: CristaeOverlayProps<T>): ReactElement | null;

// ── <CristaePopup> ───────────────────────────────────────────────────────────
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
  /** Contenido de la tarjeta para un ítem — string HTML o Node. Es la vía de contenido (no `children`). */
  contentOf?: (item: T) => string | Node;
}
export declare function CristaePopup<T = unknown>(props: CristaePopupProps<T>): ReactElement | null;

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
export declare const CristaeToolbar: FC<CristaeToolbarProps>;
