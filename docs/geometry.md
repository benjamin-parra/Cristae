# Geometría — `distance`, los modelos y las cajas

> Pieza de [Cristae](../MODELO.md). Entry propio (`cristae/geometry`), sin efectos: no importa el
> motor, el [Source](./data.md) ni Leaflet, y sirve suelto en Node o en un worker. Trae también
> `toParts` y `sampleAlong` (ver [líneas](./lines.md)). Contrato normativo en [SPECS §18](../SPECS.md).

| API | Qué es |
|---|---|
| `distance(…)` | el largo de un recorrido o de un path, siempre en metros |
| `sphere(radius = 6371008.8)` | modelo esférico, con haversine; sin radio es el modelo por defecto |
| `ellipsoid(semiMajorAxis, flattening)` | modelo elipsoidal: la geodésica por el problema inverso de Karney |
| `WGS84` | `ellipsoid(6378137, 1 / 298.257223563)` |
| `boundsOf(…)` | la caja `{ south, west, north, east }` de unos puntos, con las formas de llamada de `distance` |
| `boundsPad(bounds, ratio)` · `boundsContain(bounds, point)` · `boundsCenter(bounds)` | agrandar, contener y centrar una caja |

`ellipsoid` y `WGS84` traen la dependencia `geographiclib-geodesic`, que entra sólo al bundle de quien
los importa. Por eso `cristae/map` re-exporta `distance`, `sphere`, `toParts` y `sampleAlong`, y no el
elipsoide; el prearmado `esm/geometry.js`, en cambio, la trae siempre.

## Formas de llamada

```js
import { distance, sphere, WGS84 } from 'cristae/geometry'

distance(origen, destino)                  // dos puntos: su distancia
distance(origen, parada, destino)          // el recorrido por los puntos, en orden
distance(recorrido.puntos)                 // un path, plano o anidado: el contrato de `toParts`
distance(WGS84, origen, destino)           // cualquiera de las anteriores, con un modelo primero
distance(modelo ?? sphere(), origen, destino)
```

Con **un** argumento después del modelo, un punto es un recorrido de un punto (0 m); `null`,
`undefined` o un iterable que no es un punto es un path; cualquier otra cosa es un punto inválido.
Con dos o más, cada argumento es un punto.

## Formas de punto

```js
distance([-33.45, -70.66], { lat: -33.05, lng: -71.62 })
distance({ lat: -33.45, lon: -70.66 }, { latitude: -33.05, longitude: -71.62 })
```

Un punto va en grados, en cualquiera de esas cuatro formas. Qué lo hace válido —incluido por qué el
orden `[lng, lat]` de GeoJSON no entra— y qué mide un recorrido con puntos inválidos, huecos o partes
vacías lo fija [SPECS §18](../SPECS.md). Es la misma regla de los paths de las [líneas](./lines.md)
—también al encuadrarlas— y del `value` de los [editores](./editing.md), que igual emiten pares. Los
anillos de `ringsOf` y las posiciones de `positionOf` tienen su propio contrato.

## El modelo va primero, y null no es un modelo

El modelo es opcional y va primero para que los puntos queden al final, variádicos. Se reconoce por
una marca en el registro global de símbolos, así que un modelo de una copia de la librería sirve en
otra cargada en la misma página. `null` y `undefined` no la tienen: delante de otros argumentos, son
un punto inválido. Así `distance(xs[0], xs[1])` sobre un array vacío da `NaN`, en vez de volverse en
silencio «el modelo por defecto y un punto». Con un modelo opcional se escribe
`distance(modelo ?? sphere(), …)`.

Un modelo en otro lugar, o una fábrica sin llamar (`sphere` por `sphere()`), lanza `TypeError`: es un
error del llamador, no un dato malo, y leerlo como un punto inválido mediría en silencio con la esfera.

## Los modelos

- **`sphere()` —el defecto— es la esfera de radio medio IUGG, R1 = 6 371 008,8 m.** El radio
  ecuatorial (6 378 137 m), el de la proyección EPSG:3857, sobreestima ~0,11 % como radio de una
  esfera de medir. Contra el elipsoide WGS84 la esfera se desvía hasta 0,56 % (tramos cortos
  norte–sur sobre el ecuador) y hasta 0,36 % entre 30° y 60° de latitud.
- **`sphere(radius)`** existe para reproducir las cifras de un sistema que mide con otro radio: mide
  en la razón exacta de los radios.
- **`ellipsoid` y `WGS84`** dan la geodésica del elipsoide, a precisión geodésica y también entre
  casi antípodas.
- Las fábricas validan al construir y lanzan `RangeError` si el radio o el semieje no es un número
  finito mayor que 0, o si el achatamiento no está en [0, 1). Los modelos son inmutables.

El picking de `addCircleLayer` mide con la esfera por defecto, sin opción de modelo, y el contorno se
dibuja sobre esa misma esfera —cada vértice a `radius` metros del centro según `arcMeters`—: el borde
y el hit coinciden a cualquier latitud.

## Cajas

```js
import { boundsOf, boundsPad, boundsContain, boundsCenter } from 'cristae/geometry'

const caja = boundsOf(recorrido.puntos)          // o boundsOf(origen, destino), como distance
boundsPad(caja, 0.1)                             // un 10 % más por cada lado
boundsContain(caja, { lat: -33.45, lng: -70.66 })
boundsCenter(caja)                               // { lat, lng }
```

`boundsOf` lee con las formas de llamada y de punto de `distance`, y las otras tres reciben una
`Bounds` o un par de esquinas opuestas `[[sur, oeste], [norte, este]]` en cualquier forma de punto y
orden. Qué cuenta como caja y sus bordes —el vértice suelto entre dos cortes, la caja sin ningún punto
válido, la longitud sin envolver, el acotado de la latitud— los fija [SPECS §18](../SPECS.md).

## Costo

Medido en Node 26; los tiempos son la mediana de siete corridas:

| Modelo | Dos puntos al azar | Track de 50 000 vértices | Asigna |
|---|---|---|---|
| esfera | 0,36 µs por llamada | 5,8 ms | ~130 B por llamada; por vértice, nada con pares |
| WGS84 | 5,6 µs por llamada | 127 ms | lo que asigne la geodésica: de ~4 a ~45 B por tramo |

Un path de arrays se lee en su lugar, en una pasada; otro iterable (un `Set`, un generador) se
materializa una vez. Con pares no asigna por vértice, aunque el proceso mezcle formas de punto. Con
vistas tipadas u objetos, según las formas que el proceso ya haya leído, V8 puede encajonar cada
componente: medido entre 0 y ~130 B por vértice.

`sampleAlong` reparte sus muestras por largo en pantalla (EPSG:3857), para decorar: no quedan
equidistantes en metros.
