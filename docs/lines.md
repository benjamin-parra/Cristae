# Líneas — `LineLayer`, `<cristae-line-layer>`, picking nearest-segment

> Pieza de [Cristae](../MODELO.md). Cuarta forma geométrica junto a [puntos](./render.md),
> polígonos y [etiquetas](./labels.md). Consume un [Source](./data.md) y reusa la proyección
> inlineada de `render/project.js`. Render GL sobre `glify.Lines`; picking CPU (`geometry/polyline.js`).

`LineLayer` dibuja polilíneas sobre WebGL apoyándose en `glify.Lines` **sin forkearlo**: reusa su
rebuild (`setData`) y su draw (`gl.LINES`) tal cual, y le **añade** lo que su API no expone — el
**color por vértice** para un gradiente, escribiendo el buffer interleaved por `bufferSubData` (el
mismo patrón de bypass que `PointLayer` sobre `glify.points`). Es una primitiva **sin dominio**: una
línea es N vértices con estilo, no un "recorrido" ni una "ruta" — eso lo compone el consumidor.

---

## La idea central: glify da menos de lo que su buffer permite

`glify.Lines` asigna el color **por feature** (`colorFn(featureIndex, feature)`), pero lo **guarda
por vértice** (`[x, y, r, g, b, a]`, `bytes=6`) y su shader **interpola** `_color` entre vértices. Es
decir: el degradado ya es físicamente posible en el pipeline — sólo falta escribir los canales de
color de cada vértice. Eso hace `LineLayer`:

| Path | Cuándo | Costo | Mecanismo |
|---|---|---|---|
| **rebuild** | cambió el set de líneas / filtro / estilo / geometría | O(n), aloca O(n) | `glify.Lines.setData` |
| **gradiente** | tras cada rebuild, si hay `scalarOf`+`colorRamp` | O(vértices), sólo en rebuild | escribe `r,g,b,a` por vértice y sube el buffer |
| **patch incremental** *(interno, etapa 3)* | set y largos estables; sólo cambian `styleOf`/geometría de algunos ids | O(Σ vértices sucios), [0-alloc] | reescribe sólo los rangos sucios por `bufferSubData` — lo decide el motor leyendo `dirtyIds`, **no** hay API imperativa de restyle |
| pan / zoom | — | [0-alloc] | glify sólo re-compone la matriz (`_reset` NO re-ejecuta `resetVertices`) → el color escrito **sobrevive** |

> **El estilo es ESTADO, no una acción.** Recolorear una línea NO es un método `setStyle`: es cambiar
> lo que devuelve `styleOf(item)` (o `scalarOf`) y `set`/`patch` la Source. El motor decide reescribir
> sólo el color (incremental) o reconstruir — el `bufferSubData` es la *implementación* del patch, no
> parte de la API. Igual que un punto no tiene `setColor`: mueve/patchea el item y `variantOf` decide.

Un feature de `K` puntos ocupa `2·(K−1)` vértices (glify duplica los interiores para `gl.LINES`); el
vértice `v` de un feature mapea al punto de path `⌈v/2⌉` — así el gradiente colorea segmento a segmento.

---

## API

### Accessors (`LineAccessors`)

| Accessor | Tipo | Rol |
|---|---|---|
| `idOf` | `(item) => number` | id numérico (picking / restyle) |
| `pathOf` | `(item) => Iterable<[lat, lng]>` *(o de partes)* | vértices del path, en orden — ver **multi-parte** abajo |
| `styleOf?` | `(item) => { color?, weight?, opacity? }` | estilo **plano** por línea. `color` = `"#RRGGBB"` o `[r,g,b,a]` (0..1); `weight` en px de pantalla |
| `scalarOf?` | `(item, vertexIndex) => number` | escalar por vértice, **genérico** (el core no lo interpreta) |
| `colorRamp?` | `(value) => [r,g,b,a]` | rampa `valor → color` (0..1). Con `scalarOf` presente, **gana** sobre `styleOf.color` |

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
entradas de dato, como en `<cristae-point-layer>`. `interactive`/`visible` son atributos; `accessors`/
`data`/`source` son props (funciones/objetos).

### Multi-parte — una línea con huecos sigue siendo UNA entidad

Una línea puede tener partes disjuntas (un track GPS con baches de señal, un tramo por tierra y otro
por mar). Se expresa con **dos encodings del mismo `pathOf`**, y ambos colapsan a la misma
representación (`toParts`):

```js
pathOf: r => r.puntos                 // plano: un vértice NO finito CORTA la línea
pathOf: r => r.tramos                 // anidado: [[[lat,lng],…],…] — partes explícitas
```

> 🔴 **Un vértice no finito corta, no se descarta.** Si se descartara, los vértices vecinos quedarían
> unidos por una **recta que no existe** — el mapa dibujaría un tramo que el móvil nunca hizo. Cortar
> es lo correcto; el hueco se ve como hueco. Las partes de < 2 vértices se descartan (no hay segmento).

Multi-parte **no** es multi-entidad: un id, un estilo, y **un solo hit** (gana la parte más cercana,
que el hit reporta como `partIndex` + `segmentIndex`). En el backend GL sale como un `MultiLineString`
(glify emite una tirada de vértices por parte, contiguas y en orden); en el Leaflet, como un
`L.polyline` multi-path. `scalarOf(item, vertexIndex)` indexa la **entrada** de `pathOf` — con el
encoding plano los cortes ocupan índice, con el anidado los índices corren concatenados — así un array
paralelo de escalares nunca se desincroniza.

Para **decorar** una línea multi-parte hay que respetar sus huecos; `toParts` está exportado para no
reimplementar la convención:

```js
import { toParts, sampleAlong } from 'cristae/map'

const flechas = toParts(ruta.puntos).flatMap(({ path }) => sampleAlong(path, 4))
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

### Imperativo — `engine.addLineLayer`

```js
const handle = engine.addLineLayer({ id: 'ruta', accessors, data, interactive: true })
handle.set(rutas)                               // empuja el dataset (acción)
handle.setVisible(false)                        // toggle de visibilidad (espeja el estado `visible`)
// Recolorear = ESTADO: cambiar styleOf(item) y re-empujar — NO hay handle.setStyle.
ruta.color = '#c20b00'
handle.set(rutas)                               // el motor reescribe el color (incremental/rebuild)
```

`LineHandle`: `{ id, source, set(items), setVisible(v) }` — sólo **acciones**; el estilo va por `styleOf`.

### Picking

`kind:'line'`, `distancePx` real (nearest-segment), `partIndex` + `vertexIndex`. El índice espacial
guarda **una entrada por parte** (bboxes ajustadas: las partes lejanas de un track disjunto se
descartan por separado en el broad-phase) y `nearest` devuelve **un hit por id**.

🔴 **`vertexIndex` vive en el espacio de índices de la ENTRADA de `pathOf`** — el mismo que recibe
`scalarOf` — y apunta al vértice donde arranca el segmento picado. Sin eso el hit no sería cruzable
con el dato: un índice local a la parte no dice nada sobre el array paralelo del consumidor.

Los hits fluyen por el `LayerRegistry` con el
desempate estándar (`zIndex desc, order asc, distancePx asc`) — el consumidor escucha `click`/`hover`
como en cualquier capa. El hit-test nativo de glify se apaga (`sensitivity:0`); el índice espacial
(`geometry/polyline.js`) se reconstruye en cada rebuild.

---

## Invariantes

- **Sin dominio**: `pathOf`/`scalarOf`/`colorRamp` son opacos; el core no sabe qué es una velocidad.
- **No se forkea glify**: sólo se escribe su buffer por `bufferSubData` (bypass sobre los recursos GL
  de la instancia), como `PointLayer`. `setData`/`render`/`resetVertices`/draw/shaders intactos.
- **Multi-mapa**: todo el estado vive en la instancia de `LineLayer`; cero `let` de módulo. (Una
  instancia glify = un contexto WebGL → **una** line-layer aguanta muchísimas líneas en un contexto;
  no hacer una instancia por línea.)
- **Apilado** por orden de hijos en el light DOM.

## Dos backends: GL (glify) vs Leaflet (`vector`)

`addLineLayer({ vector: true })` (o `<cristae-line-layer vector>`) usa un **backend Leaflet**
(`L.polyline`) en vez de glify. Mismo contrato (accessors, handle, hit `kind:'line'` nearest-segment),
distinto sustrato:

| | GL (default) | Leaflet (`vector: true`) |
|---|---|---|
| Sustrato | glify.Lines (WebGL) | `L.polyline` |
| `dash` | ✗ (ignora `styleOf.dash`) | **✓ dibuja `styleOf.dash`** (ej. `[6,6]`) |
| Gradiente `scalarOf` | ✓ | ✗ (color plano) |
| Volumen / tiempo real | ✓ (buffer GPU) | pocas líneas |
| Reproyección | el motor (path incremental) | Leaflet nativo |
| Contexto WebGL | +1 | **0** (no abre contexto) |

Regla: **dash / pocas líneas → `vector`; gradiente / volumen → GL**.

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

## Deuda conocida (NO en este incremento)

- **Grosor (backend GL)**: glify no dibuja líneas gruesas — barre una línea de 1px con una **brocha**
  de radio `w` en pasos de 0.5, así que rinde `2w+1` px de ancho y **`(4w+1)²` draw-calls por feature**.
  `styleOf.weight` es px de pantalla en AMBOS backends: la capa convierte px → radio (`(px−1)/2`) antes
  de pasárselo a glify. Aun convertido, el costo de *draw* sigue siendo cuadrático en el grosor (8 px →
  225 pasadas por feature y por frame): no escala a muchas líneas gruesas. El grosor real por triángulos
  queda para un draw propio futuro. (El backend Leaflet no tiene este problema, pero no rinde volumen.)
- **`dash` en el backend GL**: `gl.LINES` no lo soporta → usar `vector: true` para líneas punteadas.
- **Track vivo (`extend`)**: crecer una línea por la punta hoy pasa por rebuild coalescido; el append
  incremental [0-alloc] al tail es una etapa posterior.
