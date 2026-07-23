// Tipos de @cristae/react (fundación). Props tipadas POR componente (reusando los configs de
// `cristae/map`: PointLayerConfig, HighlightOverlayConfig, …) es trabajo de la próxima pasada; por
// ahora la superficie es laxa. Sin dependencia de @types/react para no forzarla en el consumidor.

/** Aplica props a un custom element sin reconciliar su contenido (atributo / propiedad / evento),
 *  diffeando contra `prev`. El dato entra por propiedad. Devuelve el estado aplicado. */
export declare function applyElementProps(
  el: Element,
  prev: Record<string, unknown> | null,
  next: Record<string, unknown>,
  eventNameOf?: (key: string) => string,
): Record<string, unknown>;

/** Hook: enlaza un `<cristae-*>` a props React (layout effect + applyElementProps). Devuelve el ref. */
export declare function useCristaeElement(
  props: Record<string, unknown>,
  eventNameOf?: (key: string) => string,
): { current: HTMLElement | null };

export type CristaeComponentProps = Record<string, unknown> & { children?: unknown };
type CristaeComponent = (props: CristaeComponentProps) => unknown;

export declare const CristaeMap: CristaeComponent;
export declare const CristaePointLayer: CristaeComponent;
export declare const CristaeLineLayer: CristaeComponent;
export declare const CristaePolygonLayer: CristaeComponent;
export declare const CristaeHtmlLayer: CristaeComponent;
export declare const CristaeLabelLayer: CristaeComponent;
export declare const CristaeCluster: CristaeComponent;
export declare const CristaePopup: CristaeComponent;
