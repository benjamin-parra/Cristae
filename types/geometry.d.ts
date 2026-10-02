// Tipos del entry `cristae/geometry` (funciones puras sobre puntos, paths y zonas en grados).
// Sin efectos: no toca DOM, Leaflet, Lit ni el núcleo de datos. `cristae/map` re-exporta
// `distance`, `sphere`, `toParts` y `sampleAlong` desde acá. Mantener sincronizado con
// src/geometry/index.js.

/** Un par `[lat, lng]` en grados: un array, donde lo que siga —una altura— se ignora, o una vista
 *  tipada de dos o tres componentes, porque una más larga es un track intercalado. Es `number[]` y no
 *  una tupla para que entren los arrays que llegan de un JSON, y puede ser `readonly`: nada de este
 *  entry escribe su entrada. */
export type LatLngPair = readonly number[] | Float64Array | Float32Array;

/** Un punto en grados, en cualquiera de sus cuatro formas. Es un punto si sus dos componentes son
 *  números finitos y la latitud cae en [-90, 90]: no se coacciona un string. El orden `[lng, lat]` no
 *  entra. */
export type LatLngPoint =
  | LatLngPair
  | { readonly lat: number; readonly lng: number }
  | { readonly lat: number; readonly lon: number }
  | { readonly latitude: number; readonly longitude: number };

// Un punto o un hueco: null o undefined no son un punto ni un modelo, y cortan el recorrido.
type PointOrHole = LatLngPoint | null | undefined;

/** Un path: plano, donde un vértice que no es punto CORTA, o anidado con las partes explícitas, donde
 *  una parte nula no aporta nada. Es lo que devuelve `pathOf` en las capas de líneas y lo que
 *  normaliza `toParts`. */
export type LatLngPath = Iterable<PointOrHole> | Iterable<Iterable<PointOrHole> | null | undefined>;

/** Una zona en grados, como la acepta `ringsOf` en la capa de polígonos: un anillo `[p, …]`, un
 *  polígono `[exterior, ...huecos]` o un multipolígono `[polígono, …]`. Los niveles son arrays y los
 *  puntos van en cualquiera de sus cuatro formas. El anillo cierra solo: repetir el primer punto al
 *  final no cambia nada. El sentido de giro no importa. Un vértice que no es punto da `NaN`. */
export type LatLngPolygon =
  | readonly PointOrHole[]
  | readonly (readonly PointOrHole[] | null | undefined)[]
  | readonly (readonly (readonly PointOrHole[] | null | undefined)[] | null | undefined)[];

/** Una posición en grados, como la devuelven la cámara, los eventos y `boundsCenter`. */
export interface LatLng {
  lat : number;
  lng : number;
}

/** Una caja en grados: sus lados, con el sur bajo el norte y el oeste al oeste del este. Sus dos
 *  esquinas, `(south, west)` y `(north, east)`, siguen la regla de punto. La longitud no se envuelve
 *  (SPECS §18.1). */
export interface Bounds {
  south : number;
  west  : number;
  north : number;
  east  : number;
}

/** Lo que se acepta como caja: una `Bounds`, o un par de esquinas opuestas en cualquier forma de punto,
 *  cuya caja es la de los dos puntos. */
export type BoundsLike = Bounds | readonly [LatLngPoint, LatLngPoint];

/** Un modelo de la Tierra para `distance` y las medidas de zona, hecho con `sphere` o `ellipsoid`:
 *  inmutable y opaco. */
export type EarthModel = { readonly __earthModel: unique symbol };

// El argumento de path de las funciones de puntos variádicos, `distance` y `boundsOf`: un punto solo
// cuenta como un path de un punto.
type PathArgument = LatLngPath | PointOrHole;

/** Normaliza un path a partes: corta el encoding plano en cada vértice que no es punto y aplana el
 *  anidado. `from` = índice del primer vértice de la parte en la entrada (dentro de una parte son
 *  contiguos). Descarta partes de < 2 vértices. Los puntos salen como pares, sea cual sea su forma.
 *  Es la MISMA convención que aplica la line-layer y la que mide `distance` — exportada para decorar
 *  multi-parte sin reimplementarla. Puro, sin DOM. */
export function toParts(
  input: LatLngPath | null | undefined,
): Array<{ path: [number, number][]; from: number }>;

/** Muestrea `count` puntos equiespaciados a lo largo del path, con el rumbo (0=N, 90=E) del segmento
 *  en que caen. El espaciado es por largo en PANTALLA (EPSG:3857), para decorar: no es equidistante
 *  en metros. Acepta lo mismo que `toParts` y nunca muestrea sobre un hueco; componer con
 *  `toParts(p).flatMap(({ path }) => sampleAlong(path, n))` reparte `n` por parte en vez de sobre el
 *  total. Los puntos van a un point-layer con `headingOf` (flechas de dirección / ticks). Puro, sin
 *  DOM. */
export function sampleAlong(
  path: LatLngPath | null | undefined,
  count: number,
): Array<{ lat: number; lng: number; heading: number }>;

/** Largo en METROS del recorrido por los puntos, en orden: con dos, su distancia. Sin modelo mide la
 *  esfera de radio medio (6 371 008,8 m). Un punto inválido corta y el hueco no suma; si hubo alguno
 *  y no quedó ningún tramo, da `NaN`. Un modelo fuera del primer lugar lanza `TypeError`. Ver
 *  docs/geometry.md. */
export function distance(pointA: PointOrHole, pointB: PointOrHole, ...points: PointOrHole[]): number;
/** Largo en METROS de un path, plano o anidado —lo que acepta `toParts`—: la suma de sus partes, sin
 *  puentear los huecos. Un punto solo, o un path sin puntos, mide 0; lo que no es punto, ni iterable,
 *  ni nulo es un punto inválido y da `NaN`. */
export function distance(path: PathArgument): number;
/** El recorrido por los puntos, medido con `model`. */
export function distance(model: EarthModel, pointA: PointOrHole, pointB: PointOrHole, ...points: PointOrHole[]): number;
/** El path, medido con `model`. */
export function distance(model: EarthModel, path: PathArgument): number;

/** Área en m² de la zona: por polígono, el exterior menos sus huecos, y los polígonos se suman. Las
 *  aristas son geodésicas del modelo; sin modelo, la esfera de radio medio. De cada anillo cuenta la
 *  menor de las dos regiones que separa. Una zona nula, vacía o sin anillos mide 0. Un vértice que no
 *  es punto, o una zona que no es array, da `NaN`. Lanza `TypeError` si el modelo no va primero, si
 *  llega sin construir, si sobra un argumento o si el modelo no mide áreas. Ver docs/geometry.md. */
export function area(polygon: LatLngPolygon | null | undefined): number;
export function area(model: EarthModel, polygon: LatLngPolygon | null | undefined): number;

/** Largo en m de todos los bordes de la zona, huecos incluidos, con cada anillo cerrado. Los bordes y
 *  los errores son los de `area`, salvo el del modelo sin áreas: cualquier modelo sirve. */
export function perimeter(polygon: LatLngPolygon | null | undefined): number;
export function perimeter(model: EarthModel, polygon: LatLngPolygon | null | undefined): number;

/** La mayor distancia en m entre dos vértices de la zona, medida con el modelo. Con menos de dos
 *  vértices distintos, 0. Los bordes y los errores son los de `perimeter`, y además lanza `TypeError`
 *  con un terreno: mide en horizontal. Con un modelo de otra implementación, ver SPECS §18. */
export function diameter(polygon: LatLngPolygon | null | undefined): number;
export function diameter(model: EarthModel, polygon: LatLngPolygon | null | undefined): number;

/** Una esfera de radio `radius` en metros, con haversine. Sin argumento es el modelo por defecto de
 *  `distance`; otro radio sirve para reproducir las cifras de un sistema que mide con él. Lanza
 *  `RangeError` si el radio no es un número finito mayor que 0. */
export function sphere(radius?: number): EarthModel;

/** El elipsoide de revolución de semieje mayor `semiMajorAxis` (m) y achatamiento `flattening`: la
 *  geodésica por el problema inverso de Karney. Lanza `RangeError` si el semieje no es un número
 *  finito mayor que 0 o el achatamiento no está en [0, 1). Cuesta más que la esfera: ver
 *  docs/geometry.md. */
export function ellipsoid(semiMajorAxis: number, flattening: number): EarthModel;

/** El elipsoide WGS84: `ellipsoid(6378137, 1 / 298.257223563)`. */
export const WGS84: EarthModel;

/** La caja de los puntos, en las formas de llamada de `distance` sin el modelo: un vértice suelto entre
 *  dos cortes también cuenta. `null` si ningún punto es válido. Ver docs/geometry.md. */
export function boundsOf(pointA: PointOrHole, pointB: PointOrHole, ...points: PointOrHole[]): Bounds | null;
/** La caja de un path, plano o anidado, o de un punto solo. */
export function boundsOf(path: PathArgument): Bounds | null;

/** La caja agrandada por cada lado en `ratio` de su alto y de su ancho; negativo la achica. La latitud
 *  se acota a [-90, 90]. `null` si `bounds` no es una caja o si el ratio la invierte. */
export function boundsPad(bounds: BoundsLike | null | undefined, ratio: number): Bounds | null;

/** Si el punto cae en la caja, con los bordes adentro y sin envolver su longitud. `false` si alguno de
 *  los dos no es válido. */
export function boundsContain(bounds: BoundsLike | null | undefined, point: PointOrHole): boolean;

/** El centro de la caja, por promedio de sus lados. `null` si `bounds` no es una caja. */
export function boundsCenter(bounds: BoundsLike | null | undefined): LatLng | null;
