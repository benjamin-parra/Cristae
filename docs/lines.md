# Líneas — `<cristae-line-layer>`, picking nearest-segment

> Pieza de [Cristae](../MODELO.md). Cuarta forma geométrica junto a [puntos](./render.md),
> polígonos y [etiquetas](./labels.md). Consume un [Source](./data.md) y reusa la proyección
> inlineada de `render/project.js`. Render GL propio (un quad por segmento); picking CPU (`geometry/polyline.js`).

Las líneas se dibujan **siempre en GPU**, con un único sustrato: el mismo `StrokePass` que dibuja el
contorno de los polígonos, con `closed: false`. Los vértices viven en una textura y el vertex shader
arma un quad por segmento desde `gl_VertexID`, con uniones miter y tapas `butt | round | square`.
Panear y hacer zoom no reescriben un byte, y el conteo de draws **no depende del grosor ni del largo**:
es uno por parte. Es una primitiva **sin dominio**: una línea es N vértices con estilo, no un
"recorrido" ni una "ruta" — eso lo compone el consumidor.

Cada capa toma UNO de los ~16 contextos WebGL de la página; una capa aguanta muchísimas líneas, así
que no se hace una por línea.

---

## Cómo cambia lo dibujado

Los vértices viven en un arena mutable (`LineStore`) con un hueco por parte, y un cambio sube sólo lo
que tocó:

| Cambio | Costo | Qué se sube |
|---|---|---|
| pan / zoom | [0-alloc] | nada: sólo cambia la matriz |
| `patch` de unos ids | O(vértices de esos ids) | las filas de la textura que ocupan |
| `append(id, ...points)` | O(puntos agregados) | las filas de lo agregado; si el hueco se agota, la parte se muda a uno del doble |
| `set` con otra membresía, filtro | O(n) | textura nueva |

> **El estilo es ESTADO, no una acción.** Recolorear una línea NO es un método `setStyle`: es cambiar
> lo que devuelve `styleOf(item)` (o `scalarOf`) y `set`/`patch` la Source. Igual que un punto no tiene
> `setColor`: mueve/patchea el item y `variantOf` decide.

---

## API

### Accessors (`LineAccessors`)

| Accessor | Tipo | Rol |
|---|---|---|
| `idOf` | `(item) => number` | id numérico (picking / restyle) |
| `pathOf` | `(item) => Iterable<punto>` *(o de partes)* | vértices del path, en orden, en cualquiera de las [formas de punto](./geometry.md#formas-de-punto) — ver **multi-parte** abajo |
| `styleOf?` | `(item) => { color?, weight?, opacity? }` | estilo **plano** por línea. `color` = `"#RRGGBB"` o `[r,g,b,a]` (0..1); `weight` en px de pantalla |
| `scalarOf?` | `(item, vertexIndex) => number` | escalar por vértice, **genérico** (el core no lo interpreta) |
| `colorRamp?` | `(value) => [r,g,b,a]` | rampa `valor → color` (0..1). Con `scalarOf` presente, **gana** sobre `styleOf.color` |
| `hashOf?` | `(item) => number \| string` | hash de cambio, el de `SourceAccessors` (default = `idOf`). Un `set` sólo reescribe las líneas cuyo hash cambió: la que conserva su id y cambia de recorrido o de estilo lo declara |

### Declarativo — `<cristae-line-layer>`

```html
<cristae-map>
  <cristae-line-layer id="ruta" interactive></cristae-line-layer>
</cristae-map>
```
```js
const layer = document.getElementById('ruta')
layer.accessors = {
  idOf: r => r.id,
  pathOf: r => r.puntos,                       // [[lat,lng], ...]
  styleOf: r => ({ color: '#278cff', weight: 3 }),
}
layer.data = rutas                              // el elemento posee la Source interna
```
`data` (el elemento posee la Source) y `source` (una `Source` compartida del consumidor) son las dos
entradas de dato, como en `<cristae-point-layer>`. `interactive`/`visible` son atributos;
`accessors`/`data`/`source` son props (funciones/objetos).

### Multi-parte — una línea con huecos sigue siendo UNA entidad

Una línea puede tener partes disjuntas (un track GPS con baches de señal, un tramo por tierra y otro
por mar). Se expresa con **dos encodings del mismo `pathOf`**, y ambos colapsan a la misma
representación (`toParts`):

```js
pathOf: r => r.puntos                 // plano: un vértice que NO es punto CORTA la línea
pathOf: r => r.tramos                 // anidado: [[[lat,lng],…],…] — partes explícitas
```

El path y cada parte pueden ser cualquier iterable, y un vértice, cualquiera de las
[formas de punto](./geometry.md#formas-de-punto).

> 🔴 **Un vértice que no es punto corta, no se descarta.** Si se descartara, los vértices vecinos quedarían
> unidos por una **recta que no existe** — el mapa dibujaría un tramo que el móvil nunca hizo. Cortar
> es lo correcto; el hueco se ve como hueco. Las partes de < 2 vértices se descartan (no hay segmento).

Multi-parte **no** es multi-entidad: un id, un estilo, y **un solo hit** (gana la parte más cercana,
que el hit reporta como `partIndex` + `vertexIndex`). Cada parte es un rango de la textura y su
propia pasada de dibujo.
`scalarOf(item, vertexIndex)` indexa la **entrada** de `pathOf` — con el encoding plano los cortes
ocupan índice, con el anidado los índices corren concatenados — así un array paralelo de escalares
nunca se desincroniza.

Para **decorar** una línea multi-parte hay que respetar sus huecos. `sampleAlong` ya los respeta y
reparte sus muestras sobre el largo total; `toParts` está exportado para decorar por parte sin
reimplementar la convención:

```js
import { toParts, sampleAlong } from 'cristae/map'

const flechas = toParts(ruta.puntos).flatMap(({ path }) => sampleAlong(path, 4))   // 4 por parte
```

### Gradiente por un escalar per-vértice

```js
layer.accessors = {
  idOf: r => r.id,
  pathOf: r => r.puntos,
  scalarOf: (r, i) => r.velocidad[i],           // el dominio ("velocidad") vive afuera
  colorRamp: v => rampaAzulNaranjaRojo(v),      // v → [r,g,b,a] en 0..1
}
```

Cada vértice lleva su color (una textura RGBA8 junto a la de posiciones) y el color se interpola a lo
largo del segmento. Con `scalarOf` presente el color de `styleOf` se ignora; `opacity`, no. La textura
de colores sólo existe cuando hay gradiente.

Con `append`, `scalarOf` se llama también para los índices agregados, que continúan los del path: el
escalar de lo que crece tiene que poder responderse con el mismo `item` (un array paralelo que el
consumidor también extiende).

### Imperativo — `engine.addLineLayer`

```js
const handle = engine.addLineLayer({ id: 'ruta', accessors, data, interactive: true })
handle.set(rutas)                               // empuja el dataset (acción)
handle.append('ruta-1', [-33.4, -70.6])         // suma puntos al final de un track
handle.setVisible(false)                        // toggle de visibilidad (espeja el estado `visible`)
// Recolorear = ESTADO: cambiar styleOf(item) y re-empujar — NO hay handle.setStyle.
ruta.color = '#c20b00'
ruta.version++                                  // con hashOf: r => r.version; sin él, el mismo id no cuenta como cambio
handle.set(rutas)                               // la capa reescribe sólo esa línea
```

`LineHandle`: `{ id, source, set(items), append(id, ...points), setVisible(v) }` — sólo **acciones**; el
estilo va por `styleOf`. En el elemento, `layer.controls.append(id, ...points)`, con la capa montada:
`append` sin más es el del DOM.

`addLineLayer` rechaza `backend` y `vector` (ver *Migración* en el CHANGELOG): ya no hay sustrato que
elegir.

### Un track que crece — `append`

`append(id, ...points)` suma puntos al final del path de `id` en O(puntos): lo que llega por un
WebSocket no rearma el path del consumidor. Lo sumado **continúa el último tramo abierto** del path
(el final de uno plano, la última parte no vacía de uno anidado: una parte vacía al final no abre
tramo); un punto que no es punto corta, como en cualquier path, y lo que le sigue abre un tramo
nuevo. Un único punto suelto al final espera al siguiente para dibujar.

La Source dueña es quien lo guarda (`createSource(...).append`): requiere `pathOf`, lanza
`RangeError` con un id que no tiene, y no hace nada sin puntos. El handle suma sobre la Source que
posee la capa (ruta `data`); si la capa lee una `source` del consumidor, lanza `TypeError`: se suma
con el `append` de esa Source. El path del consumidor no se toca, y un `set`, `patch` o `remove` del
id descarta lo sumado: desde ahí manda el path que el consumidor entrega. Sobre una Source de lectura
(`defineSource`) no hay `append`.

### Foco

`applyFocus(ids, dim)` —el foco por ítem que dirige `focus-ids`— atenúa en la **opacidad** de cada
línea y es exacto: no se atenúa el pane. Es estado de la capa, así que un `patch` o un `append` lo
conservan.

### Picking

Con `interactive`: `kind:'line'`, `distancePx` real (nearest-segment), `partIndex` + `vertexIndex`. La
tolerancia es 8 px más la mitad del grosor mayor: el trazo grueso capta desde su borde, no desde su
eje. El índice espacial guarda **una entrada por parte** (bboxes ajustadas: las partes lejanas de un
track disjunto se descartan por separado en el broad-phase) y `nearest` devuelve **un hit por id**.

🔴 **`vertexIndex` vive en el espacio de índices de la ENTRADA de `pathOf`** — el mismo que recibe
`scalarOf` — y apunta al vértice donde arranca el segmento picado. Sin eso el hit no sería cruzable
con el dato: un índice local a la parte no dice nada sobre el array paralelo del consumidor.

El índice se arma al primer pedido de hit y se mantiene al día con cada `patch` y `append`, sin
reconstruirse. Ve lo que se dibuja: lo que `append` sumó en una ventana todavía abierta entra con el
flush que la cierra. Los hits fluyen por el `LayerRegistry` con el desempate estándar
(`zIndex desc, order asc, distancePx asc`) — el consumidor escucha `click`/`hover` como en cualquier
capa.

### Curva geodésica

Con curva —la pide `<cristae-geodesic>` envolviendo la capa, o `engine.addGeodesic({ hostId })`, que
devuelve con qué volver a rectas— la capa parte cada tramo sobre la geodésica del
[modelo del mapa](elements.md#cristae-map) con la regla de [`geodesic`](geometry.md#geodésica--geodesic):
sólo se parte lo que se aparta más de 0,1 m de la recta de Mercator, así que un track GPS se dibuja byte a
byte igual. La cifra vale en tramos de hasta 1 000 km; en uno más largo, como los vuelos de abajo, la cota
de `geodesic` se queda corta y la cuerda puede pasarla. De una sola densificación salen el dibujo, el
picking y la caja:

- **`vertexIndex` sigue en la entrada.** Un hit sobre un punto insertado da el vértice que abre su tramo.
- **Con `scalarOf`, los puntos insertados interpolan el escalar** entre los dos vértices, y `colorRamp` lo
  colorea: no se mezclan colores.
- **`append` curva lo agregado desde el último vértice del path** y sube sólo eso.
- **La capa informa la caja de la curva**, que es la que encuadran `fitToLayers` y `camera.fitToLayer`;
  sin curva, el encuadre lee la Source.
- **Panear y hacer zoom no re-teselan**: la tolerancia está en metros, no en píxeles.
- **Costo.** Un track GPS paga sólo el prefiltro: 100 000 puntos se rearman en 37 ms en vez de 32. Cada
  punto insertado cuesta ~0,8 µs en la esfera y ~15 µs en WGS84, y un tramo de miles de kilómetros llega
  al tope de 4 096: cien vuelos de 9 000 km se rearman en 0,3 s en la esfera y en 6 s en WGS84. El
  primer hit y la caja densifican otra vez, porque el índice nace al primer pedido y la caja no se
  retiene.

---

## Invariantes

- **Sin dominio**: `pathOf`/`scalarOf`/`colorRamp` son opacos; el core no sabe qué es una velocidad.
- **Multi-mapa**: todo el estado vive en la instancia de la capa; cero `let` de módulo.
- **El ancla de una parte** (el centro de su caja) se fija al escribirla y no se mueve al agregar: un
  vértice muy lejano de ella pierde algo de precisión float32 antes que reescribir todo el rango.
- **Apilado** por orden de hijos en el light DOM.

## Trazo: patrones y decoración

### Patrones de trazo — un solo eje (`dash`), no un flag por patrón

`styleOf.dash` es un patrón `stroke-dasharray` en px. **No hay flags `dotted`/`dashDot`**: los
patrones tradicionales son todos el mismo eje (generalidad por composición, no por enumeración):

| Patrón | `dash` | `cap` |
|---|---|---|
| sólido | — | — |
| guiones `- - -` | `[8, 6]` | — |
| **punteado** `· · ·` | `[1, 6]` | `'round'` ← el cap redondo **es** lo que hace el punto |
| **raya-punto** `-·-·-` (línea de eje) | `[12, 5, 1, 5]` | `'round'` |
| raya-punto-punto `-··-··` | `[12, 5, 1, 5, 1, 5]` | `'round'` |

Con `cap:'butt'` (default) un tramo de largo 1 sale como un cuadradito, no como un punto — por eso el
punteado y el raya-punto piden `cap:'round'`.

El patrón se mide en px de
pantalla y corre **continuo a lo largo de cada parte**, sin reiniciarse en los vértices, y no cambia al
hacer zoom: lo que crece con el zoom es la longitud de la línea, no el período. Un número impar de
valores se repite, como en `stroke-dasharray`, y uno inválido —vacío, con un valor negativo o
no finito, o de suma cero— deja la línea sólida. Admite hasta 16 valores ya repetidos: más es un
`RangeError` que la capa levanta al tomar los datos, nunca en un repintado, y la capa queda como
estaba. Los datos le llegan por el `Source`, así que el error sale por el canal de un suscriptor que
lanza —consola, sin cortar a los demás—; sólo el alta sobre un `Source` que ya trae datos lo lanza al
llamador. Sin `dash`, `cap` redondea o cuadra las dos puntas de cada parte; las
uniones intermedias siguen siendo miter. La distancia acumulada vive en una textura R32F que se sube
la primera vez que una línea pide dash, así que una capa que no lo usa no paga ni memoria ni subida, y
el conteo de draws no cambia: un `drawArrays` por parte.

### Flechas de dirección — se COMPONEN, no son una propiedad del trazo

Una flecha es **un punto con rumbo**, no un atributo de la línea (misma separación que el cabezal
animado, que es un punto que se mueve sobre la línea). El point-layer ya rota sprites con `headingOf`,
así que se compone con el helper puro `sampleAlong`:

```js
import { sampleAlong } from 'cristae/map'

// N flechas equiespaciadas a lo largo del recorrido, orientadas según el tramo
const flechas = sampleAlong(ruta.path, 8)     // → [{ lat, lng, heading }, …]

puntosLayer.accessors = {
  idOf: (f, i) => i,
  positionOf: f => ({ lat: f.lat, lng: f.lng }),
  headingOf: f => f.heading,                  // el sprite rota solo
  variantOf: () => 'flecha',                  // iconSet con la punta de flecha
}
puntosLayer.data = flechas
```

Ventaja de componer en vez de meter `arrows:true` en la línea: las flechas heredan **gratis** todo el
point-layer (atlas GPU, clustering opcional, picking, popup, `enabled`/`visible`), y el consumidor
decide cuántas, con qué ícono y cuándo recalcularlas (p. ej. al cambiar el zoom).
