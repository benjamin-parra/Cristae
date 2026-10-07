# Geometría — `distance`, áreas, formas, terreno y cajas

> Pieza de [Cristae](../MODELO.md). Entry propio (`cristae/geometry`), sin efectos: no importa el
> motor, el [Source](./data.md) ni Leaflet, y sirve suelto en Node o en un worker. Trae también
> `toParts` y `sampleAlong` (ver [líneas](./lines.md)). Contrato normativo en [SPECS §18](../SPECS.md).

| API | Qué es |
|---|---|
| `distance(…)` | el largo de un recorrido o de un path, siempre en metros |
| `area(model?, zona)` | m² de un anillo, un polígono con huecos o un multipolígono |
| `perimeter(model?, zona)` | m de todos los bordes de la zona, huecos incluidos, cada anillo cerrado |
| `diameter(model?, zona)` | m entre los dos vértices más lejanos de la zona |
| `ring(model?, shape)` | el anillo `[lat, lng]` de un círculo, una elipse, un sector o un sector de elipse en metros, sin repetir el primer vértice |
| `arc(model?, shape)` | el borde curvo de la forma como path abierto, o su contorno cerrado si es entera |
| `terrain(model?, source, bounds, options?)` | carga las alturas de una caja desde tiles de altura: `Promise<Terrain>` |
| `terrainPresets` | datos: `{ aws, mapterhorn }`, dos proveedores públicos, como `tilePresets` |
| `relief(terrain, zona, breaks?)` | altura y pendiente de una zona, y m² de superficie por clase de pendiente |
| `elevation(terrain, point)` | la altura del terreno en un punto, en m, bilineal; `NaN` fuera de la caja o sin dato |
| `sphere(radius = 6371008.8)` | modelo esférico, con haversine; sin radio es el modelo por defecto |
| `ellipsoid(semiMajorAxis, flattening)` | modelo elipsoidal: la geodésica por el problema inverso de Karney |
| `WGS84` | `ellipsoid(6378137, 1 / 298.257223563)` |
| `boundsOf(…)` | la caja `{ south, west, north, east }` de unos puntos, con las formas de llamada de `distance` |
| `boundsPad(bounds, ratio)` · `boundsContain(bounds, point)` · `boundsCenter(bounds)` | agrandar, contener y centrar una caja |

`ellipsoid` y `WGS84` traen la dependencia `geographiclib-geodesic`, que entra sólo al bundle de quien
los importa: las medidas de zona tampoco la cargan si no se les pasa el elipsoide. Lo mismo vale para
el cargador de tiles de `terrain`, `relief` y `elevation`: no entra a quien no los importa, y
`terrainPresets` solo son datos. Por eso `cristae/map` re-exporta `distance`, `sphere`, `toParts`,
`sampleAlong` y `arc`, y no el elipsoide ni el terreno; el prearmado `esm/geometry.js`, en cambio, los
trae siempre.

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
- **Destino y rumbo.** Además de medir, `sphere(r)`, `ellipsoid` y `WGS84` resuelven los dos problemas
  geodésicos por marcas del protocolo, que las demás piezas leen sin exportarlas:
  `Symbol.for('cristae.geometry.destination')` da el punto a un rumbo y unos metros de otro, con la
  lng continua —sin envolver— al cruzar el antimeridiano, y `Symbol.for('cristae.geometry.heading')`
  da el rumbo inicial, en [0, 360), de un punto a otro, y `NaN` si coinciden. Un terreno mide sobre el
  relieve y no las trae. El contrato está en [SPECS §18](../SPECS.md).
- Las fábricas validan al construir y lanzan `RangeError` si el radio o el semieje no es un número
  finito mayor que 0, o si el achatamiento no está en [0, 1). Los modelos son inmutables.

El picking de `addCircleLayer` mide con la esfera por defecto, sin opción de modelo, y el contorno se
dibuja sobre esa misma esfera —cada vértice a `radius` metros del centro según `arcMeters`—: el borde
y el hit coinciden a cualquier latitud.

## Áreas, perímetro y diámetro

```js
import { area, diameter, perimeter, WGS84 } from 'cristae/geometry'

const zona = [
  [[-37.00, -73.00], [-37.00, -72.98], [-36.98, -72.98], [-36.98, -73.00]],     // exterior
  [[-36.995, -72.995], [-36.995, -72.99], [-36.99, -72.99], [-36.99, -72.995]], // hueco
]
area(zona)                  // m², esfera de radio medio
area(WGS84, zona)           // m², elipsoide
perimeter(WGS84, zona)      // m, el exterior y el hueco, cada uno cerrado
diameter(WGS84, zona)       // m, los dos vértices más lejanos
```

Una **zona** se escribe como la lee `ringsOf` en la [capa de polígonos](./polygons.md): un anillo
`[p, …]`, un polígono `[exterior, ...huecos]` o un multipolígono `[polígono, …]`, con los puntos en
cualquiera de sus cuatro formas. El anillo cierra solo, y repetir el primer punto al final no cambia
nada. Hay una diferencia a favor de la medida: un anillo de objetos `{ lat, lng }` se mide, mientras
que la capa no lo reconoce como polígono. Qué nivel tiene una zona, qué mide una vacía o una con un
vértice inválido y qué lanza lo fija [SPECS §18](../SPECS.md).

- **El modelo va primero y es opcional**, como en `distance`. Las aristas son las geodésicas del
  modelo —círculos máximos en la esfera, geodésicas en el elipsoide—, así que el área y el perímetro
  miden los mismos bordes que `distance`. El área es exacta para esas aristas. Un modelo de una copia
  de Cristae anterior a las áreas sirve a `perimeter` y `diameter`, pero no a `area`, que lanza.
- **El sentido de giro no importa.** De cada anillo cuenta la menor de las dos regiones que separa,
  así que una región de más de medio planeta no se puede expresar. El rol lo da la posición: el
  primer anillo de un polígono es el exterior.
- **Huecos y partes.** Por polígono, el exterior menos sus huecos; los polígonos de un multipolígono
  se suman. Con geometría válida se componen como los pinta la capa: XOR dentro de un polígono, OR
  entre partes. La región no es la misma, porque la capa traza rectas en grados y las aristas de la
  medida son geodésicas: la diferencia crece con la zona, de 10⁻⁶ en una caja de 1° a 0,25 % en una de
  10° entre 50° y 60° N. Con geometría inválida es el valor de la fórmula: un hueco más grande que su
  exterior da un área negativa, que delata el error, y dos partes que se solapan cuentan el solape dos
  veces, como lo apila la capa (ver [agujeros contra solapes](./polygons.md#agujeros-contra-solapes)).
  Corregir la geometría es cosa del consumidor.
- **Antimeridiano.** Las medidas aceptan la figura con la longitud envuelta o sin envolver, y miden lo
  mismo. La capa, en cambio, dibuja `179 → −179` por el lado largo: una figura que cruza el
  antimeridiano se escribe sin envolver, con el este pasado de 180, como las cajas.
- **El diámetro es horizontal** y sólo mira vértices: es la mayor distancia del modelo entre dos de
  ellos. Con un modelo de otra implementación, qué distancia lo deja exacto lo fija
  [SPECS §18](../SPECS.md).

La esfera de radio medio y WGS84 difieren en área según la latitud (un cuadrado de 0,01°):

| Latitud | 0° | 20° | 30° | 37° | 45° | 60° | 70° | 80° | 89° |
|---|---|---|---|---|---|---|---|---|---|
| esfera − WGS84 | +0,449 % | +0,292 % | +0,113 % | −0,038 % | −0,222 % | −0,557 % | −0,735 % | −0,851 % | −0,891 % |

Para una cifra que se compara con un catastro o un SIG, `area(WGS84, zona)`.

## Formas — `ring` y `arc`

```js
import { ring, arc, area, perimeter, WGS84 } from 'cristae/geometry'

area(ring({ center: [-33.45, -70.66], radius: 500 }))                       // m² de un círculo de 500 m
area(WGS84, ring(WGS84, { center, radius: [800, 300], heading: 45 }))       // una elipse, medida sobre WGS84
ring({ center, radius: 300, heading: 90, sweep: 60 })                       // un sector de 60° mirando al este
arc({ center, radius: 300, heading: 90, sweep: 60 })                        // su borde curvo, abierto
```

`arc` también sale de `cristae/map`, que lo compone con una capa de líneas:
[`pathOf: arc`](shapes.md#el-borde-curvo-en-una-capa-de-líneas).

Una **forma** es `{ center, radius, heading?, sweep? }`, con el centro en cualquier forma de punto y todo
lo demás en metros y grados. Se lee por contenido: no lleva un `type`.

- **`radius`** es un número —círculo— o `[a, b]` —elipse, con `a` sobre `heading` y `b` de través; no
  hace falta que `a ≥ b`—. La elipse se parametriza por la anomalía excéntrica, y no es el lugar focal.
- **`heading`** es 0 = N, 90 = E, como `sampleAlong`, y es la única rotación: orienta el semieje `a` y
  la dirección del sector. Sin él la forma mira al norte, y un círculo entero no lo lee.
- **`sweep`** son los grados que abre el sector, centrados en `heading`. Con `[a, b]` sale el sector de
  elipse, y su ángulo es el polar medido desde el centro. Sin él, o con 360 o más, sale la figura entera.
- **El anillo** parte en `heading` y sigue en sentido horario, sin repetir el primer vértice: es lo que
  miden `area` y `perimeter`. Un sector es `[centro, radio, arco, radio]`, del borde izquierdo al derecho.
  El arco de un sector abre de `heading − sweep/2` a `heading + sweep/2`, y el de la figura entera es el
  contorno cerrado, con el primer vértice repetido.
- **Un solo modelo.** Los vértices están a los metros pedidos del centro según el modelo, que va primero y
  es opcional: sin él, la esfera de radio medio. Cada radio de un sector es la geodésica del modelo. La
  longitud sigue a la del centro sin envolverse, así que una figura que cruza el antimeridiano no salta.
- **Los datos malos dan `[]`**, lo mismo que `ring(null)`, que es el valor de un editor antes de dibujar.
  `null` y `undefined` toman el default; un número presente que la forma usa y no es finito la descarta, y
  el radio y `sweep` además si no son mayores que 0. Los polos no se rechazan, porque `area` los mide.
- **Un terreno no coloca formas**: lanza `TypeError`. Se coloca sobre el modelo base y se mide después,
  `area(terreno, ring(WGS84, forma))`. Un modelo que no ubica destinos —una copia anterior de Cristae o
  una implementación ajena sin la marca— también lanza.

La tolerancia es de 0,1 m sin vista: la cuerda de cada tramo no se aparta del borde verdadero más que eso,
con 16 a 4096 vértices en la figura entera. En un círculo de 500 m son 256; pasado el tope de 4096, la
separación crece. Los radios de un sector se parten sobre la misma tolerancia, porque la geodésica se
curva en Mercator.

## Terreno

```js
import { area, boundsOf, elevation, relief, terrain, terrainPresets, WGS84 } from 'cristae/geometry'

const t = await terrain(WGS84, terrainPresets.aws, boundsOf(zona), { signal })
t.cellSize                      // m, el lado de una celda en el centro de la caja
relief(t, zona, [0.15, 0.3])    // ver «Relieve»
elevation(t, punto)             // m, bilineal sobre la grilla
area(t, zona)                   // m² de superficie (ver «Medir sobre el relieve»)
```

`terrain(model?, source, bounds, options?)` carga las alturas de una caja desde tiles XYZ de altura y
devuelve un **terreno**: las alturas, inmutables, con la caja (`bounds`, copiada), el `zoom`, el
`cellSize` y la `attribution` de la fuente. El modelo base va primero y es opcional, como en
`distance`: con él se miden el ancho, el alto y el área de cada celda, así que la pendiente queda en
metros sobre ese modelo y no hereda la escala de Mercator. Es lo único asíncrono del entry, y todo
error llega como rechazo; qué rechaza y con qué, [SPECS §18](../SPECS.md). Para un multipolígono la
caja es `boundsOf(zona.flat())`: `boundsOf` lee paths planos o anidados de un nivel.

- **Las fuentes son datos.** `terrainPresets.aws` son los PNG Terrarium de AWS (z12 con tiles de 256,
  hasta z15) y `terrainPresets.mapterhorn` los WebP Terrarium de Mapterhorn (z11 con tiles de 512,
  hasta z17 donde hay cobertura; en muchas regiones llega a menos, y un zoom sin cobertura rechaza
  con «ningún tile»). Los dos cargan la misma grilla, 2²⁰ píxeles por vuelta, así que sus cifras se
  comparan celda a celda: 1,24″ por celda, 38 m en el ecuador y ~30 m a 37°, cerca del 1″ de SRTM y
  de Copernicus GLO-30. Pedir Mapterhorn a z12 cuadruplica los tiles sin agregar información. Un
  preset se ajusta con spread, `{ ...terrainPresets.aws, zoom: 14 }`, y una fuente propia se arma con
  `url` (`{z}`, `{x}` e `{y}`), `encoding` (`terrarium` o `mapbox`, el Terrain-RGB) y `zoom`, y
  opcionalmente `maxZoom`, `tileSize` y `attribution`. Terrain-RGB de Mapbox pide token: va como
  fuente propia, con la key en la plantilla.
- **`zoom` es el que se carga y `maxZoom` el techo del proveedor**, como en `tilePresets`. El zoom es
  fijo: la misma zona da la misma pendiente sea cual sea la caja cargada. Pedir más que el techo
  rechaza con `RangeError` en vez de terminar sin datos.
- **`maxTiles`** (32 por defecto) acota la carga: si la caja pide más, rechaza antes de pedir ninguno.
  Un terreno ocupa 4 B por celda de la caja con su margen: con el tope, 8 MiB en tiles de 256 y
  32 MiB en tiles de 512.
- **`signal`** cancela: la promesa rechaza con `signal.reason` y se abortan los pedidos en vuelo.
- **`fetch`** reemplaza al global y es la única puerta para la autenticación, una URL firmada, un
  proxy, los reintentos (la librería no reintenta) o un caché propio:

  ```js
  terrain(fuentePropia, caja, {
    fetch: (url, init) => fetch(url, { ...init, headers: { Authorization: `Bearer ${token}` } }),
  })
  ```

  Un 404 o un 204 es un tile sin dato. Cualquier otro estado no OK rechaza, un 401 y un 403
  incluidos: una autenticación vencida no puede volverse «sin dato» en silencio.
- **Dónde corre.** El PNG se decodifica dentro de la librería con `DecompressionStream`, así que
  AWS anda igual en el navegador, en un worker y en Node ≥ 20; un navegador sin él (Safari < 16.4,
  Firefox < 113) rechaza con un mensaje de entorno. El WebP lo decodifica la plataforma
  (`createImageBitmap` y `OffscreenCanvas`): en Node rechaza, y también en un navegador que altera
  los píxeles que lee (protección anti-fingerprinting), lo que se verifica la primera vez con un
  canario. La fuente portable es AWS.
- **Un terreno no cruza hilos**: sus núcleos son clausuras. Para no bloquear la interfaz se importa
  `cristae/geometry` en el worker y se devuelven los números.
- **El terreno es el caché de su caja**: se carga una caja que cubra todas las zonas y se reusa.
  Entre cargas sirve el caché HTTP, y uno propio va en `fetch`.
- **Atribución.** `cristae/geometry` no dibuja: quien muestra las cifras muestra `t.attribution` junto
  a ellas. Sobre un mapa de Cristae, se suma a la del tile, que ya se pinta en la esquina:

  ```js
  mapa.tile = { ...tilePresets.osm, attribution: `${tilePresets.osm.attribution} · ${t.attribution}` }
  ```

Lo que no llega —un tile 404 o 204, un píxel de alfa 0— queda sin dato, y no se rellena con el tile
padre: mezclar resoluciones aparentaría un detalle que no hay.

## Lo que el DEM permite afirmar

1. **Los DEM libres son de superficie (DSM).** SRTM y Copernicus GLO-30 miden lo primero que ve el
   radar: en un bosque, el dosel. La altura, la pendiente y el área de superficie de un bosque
   describen las copas, y el borde de un claro aparece como un escalón de la altura de los árboles.
2. **La resolución acota lo que se puede afirmar.** Con 30 m por celda, una zona de una hectárea son
   ~11 celdas, y una de menos de una celda hereda el valor de las que toca. `relief(…).cells` dice
   cuántas entraron y `t.cellSize` cuánto mide cada una. La pendiente mira 60 m, así que suaviza una
   ladera más corta.
3. **Sobre el mar los proveedores difieren**: Mapterhorn no tiene tile (404, que suma a `noData`) y
   AWS da 0 m, que parece un dato.
4. **Exactitud vertical publicada**: SRTM, 16 m absoluta al 90 % (especificación de la misión);
   Copernicus GLO-30, menos de 4 m absoluta al 90 % (Copernicus DEM Product Handbook).
5. **Las aristas de una zona son geodésicas** y la capa dibuja rectas en Mercator. Se separan en
   ≈ L²·tan φ/(8R): 1,5 cm en un lado de 1 km y 1,5 m en uno de 10 km, a 37°.
6. **Un corte de pendiente tiene una banda gris.** Con alturas enteras, el redondeo de ±0,5 m desvía
   la pendiente con celdas de 30 m en ~0,004 (0,4 puntos de %) típicos y hasta ~0,019 en el peor
   caso.

## Relieve

```js
const r = relief(t, zona, [0.15, 0.3])
// { cells, elevation: { min, max, mean }, slope: { min, max, mean, areas: [3 clases] }, noData }
```

`relief(terrain, zona, breaks?)` describe la altura y la pendiente de la zona sobre un terreno. El
nombre junta las dos: no es sólo la amplitud (máximo − mínimo), que en geomorfología también se llama
así. La zona se lee como en `area`, y el cálculo lo hace el terreno, así que sirve con uno cargado por
otra copia de la librería.

- **Unidades.** Las alturas en m; la pendiente como **razón** (m/m), la magnitud SI: % = 100·p y
  grados = atan(p)·180/π. No hay opción de unidades: los grados no promedian lineal con el área.
- **La pendiente de una celda** es la de Horn sobre sus 8 vecinas, con el ancho y el alto de cada fila
  medidos con el modelo base: es el defecto de `gdaldem slope` y de ArcGIS, así que las cifras se
  cruzan en QGIS. Una celda tiene dato si sus 9 alturas lo tienen: la pegada a un tile sin dato pierde
  la pendiente aunque tenga altura, y cuenta como sin dato.
- **Ponderación.** Cada celda pesa el área que la zona le cubre: las celdas del borde pesan su
  fracción, y una zona menor que una celda hereda la altura y la pendiente de las que toca. Mínimo y
  máximo son de celda, no interpolados, como en las estadísticas zonales de GDAL; las medias van
  ponderadas por área, y la de la pendiente es la de la razón, no la del ángulo. `cells` cuenta las
  celdas con dato que la zona toca.
- **Clases.** `breaks` son cortes de pendiente en razón, finitos, ≥ 0 y estrictamente crecientes, sin
  valor por defecto: `[0.15, 0.3]` da [0, 0,15), [0,15, 0,3) y [0,3, ∞), y una pendiente igual a un
  corte cae en la clase de arriba. Sin cortes hay una sola clase.
- **`slope.areas` son m² de SUPERFICIE**, sobre el relieve: cada m² horizontal con pendiente p aporta
  √(1 + p²) m² a su clase. Un catastro informa áreas horizontales: la total es `area(base, zona)`, y
  la horizontal con dato, `area(base, zona) − noData`.
- **`noData`** son los m² HORIZONTALES de la zona que caen en celdas sin dato: sin alturas no hay
  relieve que medir. Con `noData = 0`, `Σ slope.areas` es el área de superficie de la zona,
  `area(t, zona)`.
- **Bordes.** Una zona vacía no tiene celdas: alturas y pendientes `NaN`, áreas y `noData` en 0. Un
  vértice que no es punto, o que cae fuera de `t.bounds`, da todos los campos `NaN`. El detalle está
  en [SPECS §18](../SPECS.md).

Un caso: la parte empinada de una zona, con un corte en 30 %.

```js
const r        = relief(t, zona, [0.3])
const empinada = r.slope.areas[1]                         // m² de superficie con pendiente ≥ 30 %
const fraccion = empinada / (r.slope.areas[0] + empinada) // sobre la superficie con dato
```

## Medir sobre el relieve

```js
distance(t, a, b)    // m sobre la superficie
area(t, zona)        // m² de superficie
perimeter(t, zona)   // m sobre la superficie
elevation(t, punto)  // m sobre el nivel del DEM
```

**El terreno es un modelo.** Pasado en el lugar del modelo a `distance`, `area` o `perimeter`, mide
sobre el relieve en vez de sobre el plano del modelo base. `diameter` lo rechaza con `TypeError`: el
diámetro de una zona es una medida horizontal. El terreno no se pasa como base de otro terreno.

- **`distance`** sigue el tramo en línea recta en Mercator, no por la geodésica, con una altura
  bilineal cada media celda. Sobre una rampa de pendiente s da la distancia de la base por √(1 + s²)
  en el sentido de la pendiente, y la de la base a lo largo de una curva de nivel. En terreno plano da
  la de la base con un error relativo ≤ 10⁻¹², no bit a bit, y el redondeo puede dejarla debajo. La
  recta en Mercator se aparta de la geodésica lo que dice el punto 5 de «Lo que el DEM permite
  afirmar»: menos que una celda hasta decenas de km. `perimeter` suma `distance` de cada arista.
- **`area`** es el área de la base por el factor medio de superficie √(1 + p²) de las celdas que la
  zona cubre, ponderado por cobertura, con la pendiente de Horn de `relief`. En terreno plano es la
  de la base bit a bit; sobre una zona menor que una celda rige la pendiente de las que toca.
- **`elevation`** lee la grilla con interpolación bilineal entre los centros de celda: el valor de un
  píxel rige en su centro. Un vecino sin dato da `NaN` aunque el punto caiga justo en el centro de
  una celda con dato.
- **`NaN` y no un cálculo parcial** si un extremo de `distance` o un vértice de `area` cae fuera de
  `t.bounds`, o si el tramo o la zona toca una celda sin dato: una cifra parcial parecería completa.
  La fila de celdas pegada al límite de la proyección, ±85,0511°, no tiene vecina hacia el polo: su
  pendiente es sin dato, y su media celda exterior no tiene altura.
- **Es de otra copia.** Como `relief`, el terreno se lee por sus marcas
  (`Symbol.for('cristae.geometry.model' | 'area' | 'elevation' | 'relief')`): el de una copia de la
  librería mide en otra con las mismas cifras.

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

Las medidas de zona leen cada anillo una vez a un `Float64Array` propio: `area` y `perimeter` asignan
16 B por vértice y por llamada, y `diameter`, que además proyecta y ordena, 84 B. `area` con WGS84
asigna además un acumulador de la librería geodésica por anillo. Con un círculo de 10 000 vértices y
2 km:

| Medida | esfera | WGS84 |
|---|---|---|
| `area` | 2,1 ms | 33 ms |
| `perimeter` | 1,7 ms | 39 ms |
| `diameter` | 15 ms | 76 ms |

`diameter` no mide todos los pares: busca el par sobre el casco de la zona, en O(n log n) más unas
llamadas al modelo por vértice del casco que crecen con lo ancha que es la zona. En ese círculo de
2 km son 1,5 por vértice; el mismo círculo a 3 000 km hace 1 138 por vértice y tarda 2,6 s con la
esfera, porque en zonas continentales con miles de vértices en el casco el costo crece como 0,11·h²
llamadas. Una zona de más de 45° de radio angular, unos 10 000 km de ancho, se mide sobre todos los
pares: n(n−1)/2 llamadas. Con el elipsoide el corte llega antes, tanto más cuanto más achatado: con
WGS84, en 44,6°. Dónde y por qué, [SPECS §18](../SPECS.md).

Con el terreno, el tiempo de `terrain` es el de la red: contra AWS, un tile en frío tardó 2,8 s
(DNS y TLS incluidos) y una caja de 30 tiles 3,6 s, con seis pedidos en vuelo. La CPU es la de
decodificar, de 6 a 11 ms por PNG de 256 (mediana 8 ms), y armar el mosaico y las tablas por fila
suma poco: 30 tiles servidos por un `fetch` local, unos 100 ms con la esfera o con WGS84. `relief`
asigna un acumulador de 8 B por celda de la caja de la zona y recorre las celdas que la zona toca:

| Celdas que toca la zona | `relief` |
|---|---|
| 300 × 300 | 8-12 ms |
| 1 000 × 1 000 | 90-120 ms |

La cobertura de la zona es lo de menos (unos 15 ms en 1 000 × 1 000); el resto es la pendiente de
cada celda. El número de vértices pesa lo que pesa `area` sobre la base: con la esfera, 200 o 10 000
en 300 × 300 celdas dan lo mismo, y con WGS84 los 10 000 suman unos 30 ms.

Medir con el terreno, en una caja de 13 × 13 km a z12 de tiles de 256 (~430 × 430 celdas), una
corrida de 2 000 a 200 000 llamadas según la medida:

| Con el terreno | Costo |
|---|---|
| `distance`, 10 km (unos 660 pasos) | 32 µs (0,7 µs la esfera sola) |
| `perimeter`, anillo de 4 vértices de 13 km | 0,12 ms |
| `area`, la caja entera | 15 ms |
| `elevation` | 0,3 µs |

El bucle de `distance` sobre el terreno no asigna: sólo usa números locales, y con la esfera como base
2 millones de llamadas no hacen crecer el montón en proporción. La distancia de la base, una por
tramo, asigna lo que asigne ese modelo: con el elipsoide, el resultado de la geodésica. `area` recorre
las celdas que la zona toca como `relief`.

`ring` y `arc` colocan cada vértice con la marca de destino del modelo y devuelven un array de pares.
Un círculo de 500 m, de 256 vértices, tarda 93 µs sobre la esfera por defecto —tiene un camino rápido
que no asigna por vértice—, 167 µs sobre otra instancia de `sphere()` y 550 µs sobre WGS84, que paga la
geodésica en cada vértice; la elipse y el sector cuestan lo mismo por vértice. Importar `ring` y `arc`
suma 1,5 KB al bundle de `distance` con `sphere`, y no carga la librería geodésica.

`sampleAlong` reparte sus muestras por largo en pantalla (EPSG:3857), para decorar: no quedan
equidistantes en metros.
