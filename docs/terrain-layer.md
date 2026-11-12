# Capa de terreno

Dibuja en planta el relieve de un modelo de elevación: sombreado, color por altura o por pendiente y curvas
de nivel. Es una capa GL que comparte el contexto de su [tramo](../SPECS.md) y se apila por orden de
declaración. No se pica: no emite `Hit` ni tiene `interactive`.

```html
<cristae-map tile="osm" initial-center="-37.55,-72.85" initial-zoom="14">
  <cristae-terrain-layer id="relieve" dem="aws" color-by="slope" slope-breaks="15% 30%"
                         slope-colors="#a6d96a #fdae61 #d7191c" contours="10" clip-to="predios"></cristae-terrain-layer>
  <cristae-polygon-layer id="predios" url="./datos/predios-relieve.geojson" fields='{"id":"rol"}'
                         fill="false" color="#111827" weight="2"></cristae-polygon-layer>
</cristae-map>
```

## Las tres maneras

| Manera | Alta | Cambiar algo |
|---|---|---|
| HTML sin script | `<cristae-terrain-layer>` | atributos |
| React | `<CristaeTerrainLayer>` | props |
| JS | `engine.addTerrainLayer(config)` | `handle.update(parcial)` |

El elemento y el componente llegan al mismo motor, así que las tres comparten reglas y errores.

## Opciones

| Atributo (HTML) | Prop / opción (React y JS) | Por defecto | En vivo |
|---|---|---|---|
| `id` | `id` | `terrain-N` en el elemento; obligatorio en JS | no |
| `dem` | `dem` | sin `dem` no monta y avisa una vez | sí |
| `hillshade` | `hillshade` | encendido con `color-by="none"`, apagado si se declara otro | sí |
| `color-by` | `colorBy` | `none` | sí |
| `slope-breaks` | `slopeBreaks` | sin cortes: rampa continua de 0 a 100 % | sí |
| `slope-colors` | `slopeColors` | de verde a rojo, interpolados | sí |
| `elevation-range` | `elevationRange` | se recalcula al asentar la vista | sí |
| `contours` | `contours` | sin curvas | sí |
| `clip-to` | `clipTo` | sin recorte | sí |
| `opacity` | `opacity` | 1 | sí |
| `visible` | `visible` | `true` | sí |
| `pane`, `z` | `pane`, `z` | los de toda capa | al montar |
| no hay | `fetch` | el global | al montar |
| `cristae:load`, `cristae:error` | no hay: `dataload` y `dataerror` del motor, más abajo | | |

- **`dem`:** el nombre de un preset de `terrainPresets` (`aws`, `mapterhorn`) o un `TerrainSource`. En HTML
  el JSON de una fuente propia va en el atributo. En React y JS vale el nombre o el objeto.
- **`hillshade`:** en HTML, `"false"` y `"0"` lo apagan.
- **`color-by`:** `none`, `elevation` o `slope`.
- **`slope-breaks`:** cortes en `%`, en grados (`17°` o `17deg`) o como razón m/m (`0.3`), separados por
  espacio o coma. Con n cortes hay n + 1 clases y la capa admite hasta 15 cortes.
- **`slope-colors`:** n + 1 colores. Sin cortes basta uno o más. El motor (JS y React) lee sólo hex y
  `rgb()`/`rgba()`; los nombres CSS (`tomato`) los resuelve sólo el elemento, y en el motor lanzan `TypeError`.
- **`elevation-range`:** dos metros, `"200 600"`. Con el atributo la rampa queda fija y la leyenda es estable.
- **`contours`:** el intervalo en metros. Ausente o `0`, sin curvas.

Un valor inválido lanza `TypeError` o `RangeError` en `addTerrainLayer` y en `update`, sin cambiar nada. El
elemento lo dice en consola y deja la capa como estaba.

## Unidades de pendiente

Por dentro todo es razón m/m, la unidad de [`relief()`](geometry.md#relieve). El elemento convierte `%` y
grados al leer.

| Pendiente | Razón m/m | Grados |
|---|---|---|
| 15 % | 0,15 | ≈ 8,5° |
| 30 % | 0,30 | ≈ 16,7° |
| 100 % | 1 | 45° |

Sin cortes, el color es una rampa continua de 0 a 100 %, igual que el `breaks = []` de `relief()`.

## Lo dibujado y lo medido

Las clases de pendiente se calculan con el filtro de Horn sobre las teselas al `zoom` del `dem`, el mismo que
usa `terrain()`. El color de cada celda y las cifras de `measure()` salen de las mismas teselas.

- **Coinciden** cuando la vista cabe en el mosaico de 2048 celdas por lado.
- **No coinciden** en la vista general: por encima de ese tope la capa baja al mayor zoom que cabe y dibuja
  sólo el sombreado, sin clases ni curvas.
- El sombreado puede usar celdas más gruesas que las del `dem`, y por eso no es una cifra medible.

## Recorte con `clip-to`

`clip-to` es el id de una capa de polígonos. Se resuelve por nombre y en cualquier orden, como `for` de
`<cristae-popup>`, y sigue los cambios de esa capa.

- Recorta el color y las curvas, no el sombreado.
- El recorte compone los anillos en una sola paridad: dos partes que se pisan se cancelan en el solape.
- **Sin resolver:** si el destino no existe, aún no cargó sus polígonos o no es una capa de polígonos, la
  capa dibuja sólo el sombreado hasta que se resuelva. Un destino que no es de polígonos avisa una vez.

## `elevationAt` y `measure`

```js
const capa = engine.addTerrainLayer({ id: 'relieve', dem: 'aws', colorBy: 'slope', slopeBreaks: [0.15, 0.3] })
capa.elevationAt([-37.55, -72.85])                       // m, síncrono; NaN sin teselas o fuera del mosaico
const r = await capa.measure(predios.geometryOf('101-1'))  // relief() con los cortes y las teselas de la capa
```

- `elevationAt(latlng)` lee las teselas ya cargadas y no pide nada.
- `measure(polygon, { signal })` devuelve un `Relief` con los cortes de la capa. Un `AbortSignal` lo cancela
  con `AbortError`.
- En React, el handle está en `ref.current.controls`.
- `geometryOf(id)` de las capas de polígonos entrega la zona en `[lat, lng]` y sirve directo
  ([polígonos](polygons.md#geometría-de-un-ítem)).

## Atribución

La capa no dibuja atribución propia. El proveedor del `dem` la exige y se muestra así:

- **En el elemento:** `<cristae-map>` suma el texto de `terrainPresets[nombre].attribution`, o el
  `attribution` de la fuente propia, a la del proveedor de tiles. Va como texto, nunca como HTML.
- **En JS:** `engine` no dibuja controles. Quien monta el mapa muestra `dem.attribution` donde le
  corresponda.

## Eventos

| Evento | Motor | Elemento | `detail` |
|---|---|---|---|
| carga | `dataload` | `cristae:load` | `{ layerId, url, count }` |
| error | `dataerror` | `cristae:error` | `{ layerId, url, code, message, status? }` |

- `count` son las teselas servidas del mosaico. Un mosaico sin ninguna tesela carga vacío con `count` 0.
- Los `code` son `unauthorized` (401), `forbidden` (403), `http` (otro 4xx o 5xx), `network`, `range` y
  `decode`. Un 401 o un 403 nunca pasa por «sin dato».
- Un 404 o un 204 es sin dato: no es un error.
- Un mosaico que falló se reintenta en la próxima vista asentada.
- Sin oyentes de `dataerror`, el motor vuelca el fallo una vez a la consola.

## Orden y apilado

La capa se apila por orden de declaración, como el resto. Declarada antes de los polígonos o las líneas
queda debajo de ellos. Un `z` explícito cambia ese lugar.

## Reservado

Nada de esto existe todavía y no debe usarse:

- `interactive` y `TerrainHit`
- `light`, `contour-index`, `contour-color` y `elevation-ramp`
- un `Terrain` ya cargado como `dem`
- `controls.terrain`

`relief` y `exaggeration` llegarán como atributos de `<cristae-map>`, con el suelo en 3D. Hoy la capa es sólo
planta.

## Requisitos

El `dem` se decodifica con la librería: el PNG pide `DecompressionStream` y el WebP pide `OffscreenCanvas` y
`createImageBitmap`, como `terrain()`. La capa pide además WebGL2 con texturas `R32F`. Ver el
[README](../README.md#navegadores).
