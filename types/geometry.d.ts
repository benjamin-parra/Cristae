// Tipos del entry `cristae/geometry` (funciones puras sobre puntos, paths y zonas en grados, y la carga
// de un terreno). Sin efectos: no toca DOM, Leaflet, Lit ni el núcleo de datos. `cristae/map`
// re-exporta `distance`, `sphere`, `toParts`, `sampleAlong` y `arc` desde acá. Mantener sincronizado
// con src/geometry/index.js.

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

/** Un modelo de la Tierra para `distance` y las medidas de zona, hecho con `sphere`, `ellipsoid` o
 *  `terrain`: inmutable y opaco. */
export type EarthModel = { readonly __earthModel: unique symbol };

/** De dónde salen las alturas. Es un dato, como `tilePresets`: se pasa tal cual o con spread y
 *  overrides (`{ ...terrainPresets.aws, zoom: 14 }`). */
export interface TerrainSource {
  /** Plantilla XYZ con `{z}`, `{x}` y `{y}`; la `y` crece hacia el sur. */
  readonly url          : string;
  /** `terrarium`: h = R·256 + G + B/256 − 32768. `mapbox` (Terrain-RGB): h = −10000 + (R·65536 + G·256 + B)·0,1. */
  readonly encoding     : 'terrarium' | 'mapbox';
  /** El zoom al que se cargan las alturas: entero en [0, maxZoom]. */
  readonly zoom         : number;
  /** El zoom más alto que sirve el proveedor, como en `tilePresets`. Sin él, el techo es 24. */
  readonly maxZoom?     : number;
  /** El lado del tile en píxeles: un entero ≥ 1, 256 por defecto. */
  readonly tileSize?    : number;
  /** Lo que el proveedor pide mostrar junto a lo que se calcula con sus datos. */
  readonly attribution? : string;
}

export interface TerrainOptions {
  /** El tope de tiles por carga, 32 por defecto. Si la caja pide más, rechaza con `RangeError` antes
   *  de pedir ninguno. */
  readonly maxTiles? : number;
  /** Cancela la carga: la promesa rechaza con `signal.reason`. */
  readonly signal?   : AbortSignal;
  /** Reemplaza al `fetch` global. Sirve para un servidor con autenticación, URLs firmadas, reintentos,
   *  un caché propio o un stub. */
  readonly fetch?    : (url: string, init: { signal: AbortSignal }) =>
    Promise<Pick<Response, 'ok' | 'status' | 'arrayBuffer'>>;
}

/** Las alturas de una caja, ya cargadas: el primer argumento de `relief` y de `elevation`. Es un
 *  modelo de la Tierra que mide sobre el relieve: pasado a `distance`, `area` o `perimeter` da
 *  distancias y áreas sobre la superficie, y fuera de su caja o sobre celdas sin dato, `NaN`.
 *  `diameter` lo rechaza con `TypeError`. Es inmutable y no se transfiere entre hilos. */
export type Terrain = EarthModel & {
  readonly __terrain   : unique symbol;
  /** La caja pedida, copiada y congelada. */
  readonly bounds      : Bounds;
  /** El zoom de los tiles: `source.zoom`. */
  readonly zoom        : number;
  /** El lado en m de una celda en el centro de la caja, medido con el modelo base. */
  readonly cellSize    : number;
  /** `source.attribution`, o `''` si la fuente no trae. */
  readonly attribution : string;
};

/** El relieve de una zona. Las alturas van en m y las pendientes como razón (m/m), la tangente del ángulo. */
export interface Relief {
  /** Las celdas del DEM con dato que la zona toca. Con 0, alturas y pendientes son `NaN`. */
  readonly cells     : number;
  /** De las celdas con dato: mínimo y máximo de celda, y media ponderada por área. */
  readonly elevation : { readonly min: number; readonly max: number; readonly mean: number };
  readonly slope     : {
    readonly min   : number;
    readonly max   : number;
    readonly mean  : number;
    /** El área DE SUPERFICIE (m², sobre el relieve) de cada clase de pendiente: `breaks.length + 1`
     *  valores, la clase k es [breaks[k−1], breaks[k]), con 0 abajo e ∞ arriba. Sin celdas sin dato,
     *  su suma es `area(terrain, polygon)`. */
    readonly areas : readonly number[];
  };
  /** El área HORIZONTAL (m²) de la zona que cae en celdas sin dato: sin alturas no hay relieve que
   *  medir. La parte horizontal con dato es `area(base, polygon) − noData`. */
  readonly noData    : number;
}

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
 *  aristas son geodésicas del modelo; sin modelo, la esfera de radio medio. Con un terreno, el área
 *  de la superficie del relieve, y `NaN` si un vértice cae fuera de su caja o la zona toca una celda
 *  sin dato. De cada anillo cuenta la menor de las dos regiones que separa, y uno de 1 o 2 vértices
 *  aporta 0 sin consultar el modelo, aunque caiga fuera de la caja. Una zona nula, vacía o sin
 *  anillos mide 0. Un vértice que no es punto, o una zona que no es array, da `NaN`. Lanza
 *  `TypeError` si el modelo no va primero, si llega sin construir, si sobra un argumento o si el
 *  modelo no mide áreas. Ver docs/geometry.md. */
export function area(polygon: LatLngPolygon | null | undefined): number;
export function area(model: EarthModel, polygon: LatLngPolygon | null | undefined): number;

/** Largo en m de todos los bordes de la zona, huecos incluidos, con cada anillo cerrado. Con un
 *  terreno, sobre el relieve. Los bordes y los errores son los de `area`, salvo dos: cualquier modelo
 *  sirve, y un anillo de 1 o 2 vértices mide sus aristas, ida y vuelta. */
export function perimeter(polygon: LatLngPolygon | null | undefined): number;
export function perimeter(model: EarthModel, polygon: LatLngPolygon | null | undefined): number;

/** La mayor distancia en m entre dos vértices de la zona, medida con el modelo. Con menos de dos
 *  vértices distintos, 0. Los bordes y los errores son los de `perimeter`, y además lanza `TypeError`
 *  con un terreno: mide en horizontal. Con un modelo de otra implementación, ver SPECS §18. */
export function diameter(polygon: LatLngPolygon | null | undefined): number;
export function diameter(model: EarthModel, polygon: LatLngPolygon | null | undefined): number;

/** Una forma en METROS: círculo, elipse, sector o sector de elipse. Es lo que reciben `ring` y `arc`. Se
 *  lee por contenido, sin un `type`. Ver docs/geometry.md. */
export interface Shape<Point = LatLngPoint> {
  /** Entra en cualquier forma de punto. La longitud queda continua con la del centro y no se envuelve. */
  center   : Point;
  /** METROS. Un número: círculo. `[a, b]`: elipse, `a` sobre `heading` y `b` de través; no hace falta
   *  a ≥ b. Tiene que ser finito y mayor que 0. */
  radius   : number | readonly [number, number];
  /** Grados, 0 = N, 90 = E, horario. Orienta el semieje `a` de la elipse y la dirección del sector.
   *  Ausente (`null` o `undefined`): norte. Un círculo entero no lo lee. */
  heading? : number | null;
  /** Grados que abre el sector, centrados en `heading`: finito y mayor que 0. Ausente, o 360 o más:
   *  la figura entera. */
  sweep?   : number | null;
}

/** El anillo de la forma en pares `[lat, lng]`, sin repetir el primero: lo que miden `area` y
 *  `perimeter`, y lo que acepta una zona. El vértice 0 va en `heading` —el norte en un círculo— y el
 *  resto sigue en sentido horario; un sector es `[centro, radio, arco, radio]`. Los vértices son los del
 *  modelo, así que `area(model, ring(model, forma))` mide la forma, y la cuerda no se aparta del borde
 *  verdadero más de 0,1 m, salvo con el tope de 4096 segmentos. Una forma que no cumple la regla —centro
 *  que no es punto, radio o `sweep` que no son finitos y mayores que 0, `heading` que se usa y no es
 *  finito— da `[]`, como `null`. Sin modelo usa la esfera de radio medio. Lanza `TypeError` si el modelo
 *  no va primero, si no ubica destinos, o si es un terreno: la forma se coloca en horizontal, y se mide
 *  después con el terreno. Ver docs/geometry.md. */
export function ring(shape: Shape | null | undefined): [number, number][];
export function ring(model: EarthModel, shape: Shape | null | undefined): [number, number][];

/** El borde curvo del sector como path abierto, de `heading − sweep/2` a `heading + sweep/2`. Con la
 *  figura entera, el contorno cerrado: el anillo, repitiendo el primer vértice. La forma y los errores
 *  son los de `ring`. */
export function arc(shape: Shape | null | undefined): [number, number][];
export function arc(model: EarthModel, shape: Shape | null | undefined): [number, number][];

/** Proveedores públicos, sin key ni cuenta. Son datos y no un camino de código. */
export const terrainPresets: { readonly aws: TerrainSource; readonly mapterhorn: TerrainSource };

/** Carga las alturas de `bounds` y devuelve un terreno apoyado en `model`, que por defecto es la
 *  esfera de radio medio. Es lo único asíncrono del entry: todo error llega como rechazo. Un tile 404
 *  o 204 no es error: sus celdas quedan sin dato. Ver docs/geometry.md. */
export function terrain(source: TerrainSource, bounds: BoundsLike, options?: TerrainOptions): Promise<Terrain>;
export function terrain(model: EarthModel, source: TerrainSource, bounds: BoundsLike, options?: TerrainOptions): Promise<Terrain>;

/** El relieve de la zona sobre un terreno. `breaks` son los cortes de pendiente, como razón, finitos,
 *  ≥ 0 y en orden estrictamente creciente. Una zona vacía no tiene celdas, y un anillo de 1 o 2
 *  vértices no cuenta, aunque caiga fuera de la caja; un vértice que no es punto, o fuera de
 *  `terrain.bounds`, da todos los campos `NaN`. Lanza `TypeError` si `terrain` no es un terreno o
 *  `breaks` no es un array, y `RangeError` con un corte inválido. Ver docs/geometry.md. */
export function relief(terrain: Terrain, polygon: LatLngPolygon | null | undefined, breaks?: readonly number[]): Relief;

/** La altura del terreno en un punto, en m, interpolada bilinealmente entre los centros de celda.
 *  `NaN` si el punto no es válido, cae fuera de `terrain.bounds`, toca una celda sin dato o cae en la
 *  media celda pegada al límite de la proyección. Lanza `TypeError` si `terrain` no es un terreno. Ver
 *  docs/geometry.md. */
export function elevation(terrain: Terrain, point: LatLngPoint | null | undefined): number;

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
