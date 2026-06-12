# Web components `<cristae-*>` — Cristae

La piel declarativa del motor. Cada elemento es un *carrier* de configuración en light DOM sobre
el `MapEngine` headless (SPECS §7): `<cristae-map>` monta el motor; las capas hijas se montan
top-down cuando el motor está listo. Importar el módulo **registra** los custom elements (efecto
de lado, idempotente):

```js
import 'cristae/map'                   // define <cristae-map>, <cristae-point-layer>, …
// o, si además se necesita el API imperativo:
import { MapEngine, defineIconSet, defineSource, createSource } from 'cristae/map'
```

> **Markup primero.** Conviene escribir los `<cristae-*>` directamente en el HTML y dejar que el JS solo los
> **referencie** (`document.querySelector`): es un custom element, así que el navegador lo upgradea al
> importar el módulo. Crearlos por JS (`document.createElement('cristae-map')` + `appendChild`) es
> válido y a veces necesario (un panel que no existe en el markup), pero el árbol declarativo es
> preferible — queda versionable, las capas hijas se auto-montan y no hay orden de inserción que
> orquestar. Sea cual sea la ruta, **el montaje es conectar al DOM** y desconectar destruye el motor
> (ver *Ciclo de vida*).

---

## La regla: atributos vs props

| | Va en | Por qué |
|---|---|---|
| **Atributos** — escalares serializables (`initial-zoom`, `orientation`, `interactive`) | el **HTML** | son strings/números/booleanos; el markup es el lugar natural |
| **Props** — objetos y funciones (`accessors`, `iconSet`, `data`, `tile`, `items`) | el **JS** | no serializan a atributo; referencian constantes/funciones del módulo o el engine |

```html
<!-- estructura + atributos escalares -->
<cristae-map initial-center="-35.5,-71.5" initial-zoom="6" hover-throttle="30">
  <cristae-point-layer id="fleet" interactive></cristae-point-layer>
  <cristae-toolbar slot="center-left" orientation="vertical"></cristae-toolbar>
</cristae-map>
```
```js
// props objeto/función
const mapEl = document.querySelector('cristae-map')
mapEl.tile = { url: 'https://{s}.tile.osm.org/{z}/{x}/{y}.png', maxZoom: 19, attribution: '© OSM' }

const fleet = document.getElementById('fleet')        // <cristae-point-layer>
fleet.accessors = ACCESSORS
fleet.iconSet   = iconSet
fleet.data      = MOVILES
```

**Timing:** las props objeto se pueden asignar síncronas justo después de tomar la referencia y
llegan a tiempo. El `<cristae-map>` monta el motor de forma **asíncrona** (`await` de glify), y las
capas hijas se encolan y montan recién cuando el motor existe; cualquier prop seteada en el tick
síncrono del módulo ya está puesta antes de ese montaje. No hay carrera. (Ver *Ciclo de vida*.)

---

## `<cristae-map>`

Contenedor. Monta el `MapEngine`, expone cámara/engine y reenvía los eventos del motor como
`CustomEvent` `cristae:*` (burbujean y cruzan shadow).

| Miembro | Tipo | Atributo / prop |
|---|---|---|
| `initial-center` | `"lat,lng"` \| `[lat,lng]` | atributo (o prop `initialCenter`) |
| `initial-zoom` | number | atributo |
| `hover-throttle` | number (ms) | atributo |
| `world-copies` | boolean | atributo |
| `no-zoom-control` | boolean | atributo |
| `zoom-animation` | `"none"` (default) \| `"in-only"` | atributo |
| `viewport-insets` | object | prop `viewportInsets` |
| `tile` | `{ url, maxZoom?, attribution?, subdomains?, … }` | **prop** |

> **`no-zoom-control`:** quita el control +/− nativo de Leaflet. Para reemplazarlo con uno propio,
> se usa un `<cristae-toolbar>` en un slot del overlay con items que llamen `camera.zoomIn()`/`camera.zoomOut()`.

> **`tile`:** objeto reactivo; reasignarlo **re-provee** los tiles (con snapshot de la capa anterior para
> evitar flash). Las opciones extra van tal cual a `L.tileLayer` (`maxZoom`, `attribution`, `subdomains`
> para `{s}`, …). **`world-copies`** controla `noWrap`: por defecto el mundo **no** se repite en
> horizontal (`noWrap:true`); se activa `world-copies` para permitir las copias. (El setter es
> `setTileProvider`; con el web component no se llama directamente.) Presets públicos listos en `tilePresets`
> (`map.tile = tilePresets.osm`) — ver [`tiles.md`](./tiles.md).

Acceso (getters/métodos): `el.engine`, `el.camera` (ver *Cámara* abajo), `el.ready`, `el.on(event,
[layerId], cb)`, `el.getLayer(id)`, `el.invalidateCanvas()`. `el.engine` es la **escotilla de bajo
nivel** para lo no declarativo (`createIcon`, `getLeafletMap()`, etc.). Compartir una Source es
declarativo (prop `.source` de la capa); `engine.attachSource` es el interno que ese setter usa,
no API de consumidor.

> **`invalidateCanvas()`:** reposiciona y redibuja todas las capas de puntos del mapa. Para `<cristae-map>`
> **rara vez hace falta**: el `ResizeObserver` interno llama `syncSize()` (que ahora redibuja), así que
> tanto el resize simétrico (cambia el alto, maximizar columna) como el show tras `display:none` (un tab
> panel que se activa, un modal con el mapa ya montado — el tamaño salta de 0 a N y dispara el observer)
> se **auto-curan**. `invalidateCanvas()` es el escape hatch manual para el motor headless (`MapEngine`
> sin elemento, sin observer) o el raro caso de volver a visible sin cambiar de tamaño. **Multi-mapa:**
> cuando un `<cristae-map>` se destruye, sus hermanos vivos reciben el reset **automáticamente** — el
> consumer no necesita hacer nada para ese caso.

`el.engine`/`el.camera` son **`null` hasta montar** y getters **vivos**: no deben cachearse en una variable
(tras un reattach apuntan al motor muerto — ver *Ciclo de vida*). `el.ready` es una promesa **one-shot por
instancia** (resuelve al primer montaje, con su propio tiempo si hay varios mapas); el evento
`cristae:ready` se re-emite en **cada** montaje (sirve para reenganchar tras un reattach).

### Eventos

| Evento | `detail` |
|---|---|
| `cristae:ready` | `{}` — el motor existe; aquí ya se pueden leer `controls` e items del toolbar |
| `cristae:click` | `{ hits, originalEvent }` — `hits` ordenados top-first (ver `interaction.md`) |
| `cristae:hover` | `{ hits }` |
| `cristae:pointermove` | `{ lat, lng, x, y }` |
| `cristae:viewportchange` | `{ … }` |
| `cristae:interactionstart` / `cristae:interactionend` | `{}` |

```js
mapEl.addEventListener('cristae:ready', () => { /* engine listo */ })
mapEl.addEventListener('cristae:click', (e) => use(e.detail.hits))
```

**Dos APIs, cuándo cada una.** El `CustomEvent` de arriba es la idiomática del DOM (burbujea, una
suscripción ve **todas** las capas; los datos van en `e.detail`). `el.on(event, layerId, cb)` es la del
motor: **filtra por capa** y entrega los hits **directos** al callback, sin `e.detail`.

```js
el.on('click', 'fleet', (hits, ev) => abrir(hits[0]))   // solo capa 'fleet'
el.on('hover', ['fleet', 'alertas'], hits => resaltar(hits))   // varias capas
```

Regla: `addEventListener` por defecto; `el.on` cuando solo importa una (o pocas) capas y se prefiere el
filtro hecho. Solo eventos de picking (`click`/`hover`/`hover:start`/`hover:end`/`pointer:move`) aceptan
filtro por capa; el resto (`viewportchange`, `interaction*`) son del mapa.

---

## Cámara — `el.camera`

Tras montar, **todo movimiento es acción** (no hay prop reactiva de centro; `initial-center`/`initial-zoom`
solo fijan la vista inicial). Es la **única** vía recomendada de viewport — evita bajar a `getLeafletMap()`.

| Método | Notas |
|---|---|
| `setView(latlng, zoom)` · `panTo(latlng)` · `flyTo(latlng, zoom, opts?)` | un gesto imperativo **cancela** un `followPoint` en curso |
| `fitBounds(bounds, {insets?})` · `fitToLayer(layerId, {insets?, maxZoom?})` | encuadre; `fitToLayer` usa los bounds de los puntos finitos de la capa |
| `zoomIn(delta?)` · `zoomOut(delta?)` · `setZoom(zoom)` | el zoom es **ortogonal al follow**: no lo cancela (ajusta escala, no reposiciona) |
| `followPoint(layerId, id, {zoom?})` · `stopFollow()` | sigue la posición **viva** del id (se actualiza con `move`/`patch` del Source), sin que el consumidor bombee |
| `getCenter()` · `getZoom()` · `getBounds()` | lectura |
| `latLngToContainerPoint(latlng)` · `containerPointToLatLng(point)` | proyección píxel ↔ geo **relativa al contenedor**, para anclar overlays HTML propios en light DOM |

Los métodos de movimiento devuelven `this` (encadenables). Aplican `viewport-insets`: el objetivo cae en
el centro de la región **visible**, no detrás de un panel.

---

## Zonas de overlay y slots

El mapa expone una grilla 3×3 de zonas como slots nombrados. Un hijo con `slot="<zona>"` se ancla
ahí; **la zona decide la posición, el componente decide la orientación**.

```
top-left      top-center      top-right
center-left   center          center-right
bottom-left   bottom-center   bottom-right
```

El overlay no captura el puntero (deja pasar drag/zoom); cada hijo sloteado lo reactiva.

---

## Capas

### `<cristae-point-layer>` — puntos WebGL

| Miembro | Tipo | Atributo / prop |
|---|---|---|
| `id` | string | atributo (= id de capa) |
| `interactive` | boolean | atributo |
| `visible` | boolean (default `true`) | atributo |
| `auto-fit` | `"once"` | atributo — encuadra la capa al llegar los **primeros** puntos (una vez), vía `camera.fitToLayer` |
| `icon-set` | string (nombre registrado) \| objeto IconSet | atributo (string) o prop `iconSet` (objeto) |
| `data` | `Item[]` (ruta A) | **prop** |
| `source` | `Source` (ruta B/C) | **prop** |
| `accessors` | `{ idOf, positionOf, variantOf?, headingOf?, sizeOf?, hashOf? }` | **prop** |
| `filters` | `{id,f}[]` | **prop** |

Dos entradas de dato **simétricas**:

- **`.data`** (ruta A) — array plano; el elemento posee la Source internamente. Para control
  imperativo fino sobre esa Source interna → `controls` (abajo).
- **`.source`** (ruta B/C) — una `Source` que el **consumidor** posee (`createSource` /
  `defineSource`). La misma Source puede ir a varias vistas: `mapA.querySelector('#fleet').source =
  fleet; mapB...source = fleet`. El filtro/estado vive en la Source (se computa una vez), no por
  componente. `.source` gana sobre `.data` si ambas están.

### `<cristae-polygon-layer>` — polígonos + hit-test

| Miembro | Tipo | Atributo / prop |
|---|---|---|
| `id` | string | atributo |
| `interactive` | boolean (default `true`) | atributo |
| `visible` | boolean (default `true`) | atributo |
| `data` | `Item[]` | **prop** |
| `accessors` | `{ idOf, ringsOf, styleOf? }` | **prop** |

### `<cristae-label-layer>` — etiquetas canvas

Standalone (con `source`/`accessors`) o **attachment** (`bind-to="<idHost>"`: deriva posiciones del
host, resuelto por nombre, orden-independiente).

| Miembro | Tipo | Atributo / prop |
|---|---|---|
| `id` | string | atributo |
| `bind-to` | string (id de la capa host) | atributo |
| `visible` | boolean (default `true`) | atributo |
| `source` | Source | **prop** |
| `accessors` | `{ idOf, positionOf }` | **prop** |
| `textOf` | `(item) => string` | **prop** |
| `paint` / `style` | función / objeto | **prop** |

### `<cristae-cluster>` — clustering declarativo

Envuelve la capa **host** (hijo sin slot) y, opcional, una capa hija `slot="bubble"` (point o
label) que define cómo se ven las burbujas. Sin bubble → icon-set de cluster por defecto.

| Miembro | Tipo | Atributo |
|---|---|---|
| `radius` | number | `radius` |
| `max-zoom` | number | `max-zoom` |
| `min-points` | number | `min-points` |

```html
<cristae-cluster radius="88" min-points="2">
  <cristae-point-layer id="fleet" interactive></cristae-point-layer>          <!-- host -->
  <cristae-point-layer slot="bubble" icon-set="clusters"></cristae-point-layer> <!-- opcional -->
</cristae-cluster>
```

**Qué es automático y qué no.** El cluster reagrupa **solo por zoom** (worldwide; el pan no recalcula),
suprime del host los puntos agrupados y re-filtra las labels ligadas a él — sin código. **No** trae
interacción de burbuja (p. ej. zoom-in al click): la burbuja default es no-interactiva. Para tenerla,
se declara la capa `slot="bubble"` con `interactive` y se maneja su `cristae:click`.

**Ruta imperativa** (headless o capa declarada por JS): `engine.addCluster({ hostId, radius, minPoints,
maxZoom, bubble })` → `{ setConfig({ radius?, maxZoom?, minPoints? }), dispose() }`. El `<cristae-cluster>`
es azúcar sobre esto (su `controls` expone solo `{ id }` del host: quitar el elemento arrastra el `dispose`).

### `<cristae-toolbar>` — dock flotante

| Miembro | Tipo | Atributo / prop |
|---|---|---|
| `slot` | zona del overlay | atributo |
| `orientation` | `vertical` (default) \| `horizontal` | atributo |
| `items` | `{ id, title, icon, onClick, active?, badge?, color?, bgColor?, selectedColor? }[]` | **prop** |

`icon` es markup SVG/HTML; `title` es el nombre accesible. Métodos: `addItem(item)`,
`removeItem(id)`, `setActive(id)`. Los items suelen necesitar el `engine`, así que se asignan en
`cristae:ready`.

### `<cristae-popup>` — tarjeta HTML anclada al dato

**No es una capa** (no dibuja en GL): es un overlay del consumidor en **light DOM** (un nodo flotante en
`document.body`, así el CSS de la página lo estiliza — un popup de Leaflet caería en el shadow root y no).
Hijo de `<cristae-map>`. Se abre al click sobre la capa `for`, se posiciona proyectando la posición del
item con la cámara, y se reubica en viewport/scroll. Cierra al click fuera o con `Escape`.

| Miembro | Tipo | Atributo / prop |
|---|---|---|
| `for` | string (id de la capa que lo abre) | atributo |
| `contentOf` | `(item) => string \| Node` | **prop** |
| `offset` | `[dx, dy]` px (default `[0, -12]`) | **prop** |
| `pinned` | boolean (default `true`) | atributo — fija la tarjeta al **punto geográfico**: se mueve con el mapa. `pinned="false"` la deja fija en pantalla (ignora pan/zoom) |
| `clip` | boolean (default `true`) | atributo — recorta la parte de la tarjeta que sobresalga de la región visible (mapa menos `viewport-insets`). `clip="false"` la deja desbordar |
| `auto-pan` | boolean (default `true`) | atributo — al abrir, panea la cámara para meter la caja si se sale del recuadro; `auto-pan="false"` lo apaga |
| `auto-pan-padding` | `[x, y]` px (default `[20, 20]`) | atributo — margen entre la caja y el borde de la región visible al panear |
| **métodos** | `open(item, { lat, lng })`, `close()` | acción |

**Pinned** (default ON): la tarjeta está anclada al dato y **sigue al mapa** — al panear/zoom se
re-proyecta sobre su punto. Con `pinned="false"` queda fija en su posición de pantalla sobre el mapa
(no sigue pan/zoom; solo acompaña el scroll del propio widget en la página).

**Clip** (default ON): si la tarjeta se sale de la **región visible** —el mapa menos los
`viewport-insets` (la franja que ocupan los widgets/paneles)— la fracción que sobresale **no se
muestra** (recorte vía `clip-path` en el compositor), así no se monta sobre los widgets. Sin insets,
recorta contra el borde del mapa. No cuesta por frame: usa el tamaño medido al abrir, así reposicionar
no fuerza reflow. Con `clip="false"` desborda.

**Auto-pan** (como Leaflet, solo con `pinned`): al abrir, si la tarjeta no entra en la **región
visible** —el contenedor menos los `viewport-insets` del mapa (la UI que ocluye)— la cámara panea lo
justo para meterla con `auto-pan-padding` de margen. Respeta los mismos insets que `panTo/flyTo/
fitBounds`. Se apaga con `auto-pan="false"` si la página ya garantiza que la tarjeta cabe.

```html
<cristae-map>
  <cristae-point-layer id="fleet" interactive></cristae-point-layer>
  <cristae-popup for="fleet"></cristae-popup>
</cristae-map>
```
```js
popup.contentOf = m => `<div class="card"><b>${m.patente}</b><br>${m.estado}</div>`
```

La librería resuelve el item desde la `Source` de la capa (`itemById` del hit), así que `contentOf`
recibe el objeto de dominio. El contenedor se estiliza con `.cristae-popup`. **Cuándo:** click → tarjeta con
HTML; para texto estático sobre cada punto se usa `<cristae-label-layer>` (canvas, más liviano).


**Apilado (z-index):** la tarjeta es un nodo en `document.body`, así que su orden de apilado lo decide la
página. Para que el popup quede **por debajo de los widgets/paneles**, se le asigna un `z-index` explícito en
`.cristae-popup` menor al de esos elementos; si no, lo normal es dejarlo por **orden** (sin z-index, gana
el que viene después en el DOM / la regla de apilado por defecto).

---

## `<cristae-table>` — tabla (standalone)

**No** es una capa ni se monta dentro de `<cristae-map>`: es un componente independiente que vive en
`table/` y solo consume el contrato `Source`. Render en **light DOM** (las filas son markup del
consumidor). Comparte la misma `.source`/`.data` que las capas → una fuente alimenta mapa y tabla a
la vez. Su `controls` es el engine `PagedTable` (no un handle de capa). Documentación completa de la
API, optimizaciones y ejemplos en [`table.md`](./table.md).

| Miembro | Tipo | Atributo / prop |
|---|---|---|
| `source` / `data` | `Source` / `Item[]` (simétricas; `source` gana) | **prop** |
| `template` / `binder` | `string` HTML / `(refs, item, rowNumber) => void` | **prop** |
| `comparator` / `searchBy` / `searchFilter` | funciones | **prop** |
| `row-height` / `page-size` / `max-buttons` | number | atributo |
| `search` / `count-label` / `scroll-height` | string | atributo / prop |

Importarlo solo (`import 'cristae/table'`) **no** arrastra Leaflet/glify. Evento
`cristae:rowclick` → `{ item, row }`.

---

## `controls` — handle imperativo de la capa

`elemento.controls` devuelve el **handle público** que el motor entregó al montar la capa — lo
mismo que retorna `engine.addPointLayer(...)`. Es el camino correcto para operar una capa
**declarada** (en HTML o por props) sin perforar campos privados. Es `null` hasta que el
contenedor la monta, así que **se lee dentro de `cristae:ready`** (o tras `mapEl.ready`).

### Declarativo vs `controls` — cuándo cada uno

| Para… | Acción | Vía |
|---|---|---|
| reemplazar todo el dataset | `fleet.data = nuevo` | declarativo |
| mostrar/ocultar la capa | `fleet.visible = false` | declarativo |
| mover un ítem O(1), patch O(k) | `fleet.controls.move(id, lat, lng)` / `.patch(items, dirty)` | imperativo |
| filtrar en runtime | `fleet.controls.addFilter(f)` / `.removeFilter(id)` | imperativo |
| forzar redibujo / preseed de iconos | `fleet.controls.refresh()` / `.preloadIcons(variants)` | imperativo |

Regla: si existe una prop declarativa para lo que se busca, conviene usarla; `controls` es para las ops que
**no** tienen equivalente declarativo (move/patch/filtros/refresh).

### Qué expone `controls` por tipo de capa

| Capa | Handle |
|---|---|
| point | `{ id, source, layer, set, patch, move, remove, addFilter, removeFilter, preloadIcons, refresh, setVisible }` |
| polygon | `{ id, set, setVisible }` |
| label | `{ id, setLabels, setHovered, setVisible }` |
| cluster | `{ id }` (id del host; quitar el `<cristae-cluster>` arrastra el cluster) |

### Ejemplo (banco de pruebas)

```js
mapEl.addEventListener('cristae:ready', () => {
  const handle = fleet.controls                    // público; null antes del montaje

  handle.set(MOVILES)                              // reemplazo total
  handle.move(MOVILES[0].id, lat, lng)             // O(1), sin rebuild
  handle.addFilter(makeFilter('vel', m => m.speed > 0))
  fleet.visible = false                            // visibilidad: declarativo en el elemento
})
```

---

## Ciclo de vida y montaje

1. Importar el módulo → `customElements.define(...)` upgradea los elementos ya parseados.
2. Cada capa, al conectarse, pide montaje a su `<cristae-map>` ancestro; si el motor aún no existe,
   queda **encolada**.
3. El mapa monta el motor en `firstUpdated` (`await` de glify, asíncrono), aplica `tile`, cablea
   eventos y entrega el motor a las capas encoladas **top-down**.
4. Una capa monta cuando coinciden **motor + config mínima** (`mountReady`: una capa de puntos
   necesita `source` o `accessors`; un polígono `accessors`; una etiqueta `bind-to` o `source`).
   El montaje es **independiente del orden de asignación**: la config son objetos/funciones que
   se asignan por JS y pueden llegar antes o después de que el motor monte (la carrera depende de cuándo
   resuelve glify — inmediato en el bundle UMD, diferido en ESM). La capa difiere hasta tener su
   config y monta en cuanto llega.
5. Cambios de props **después** del montaje se reenvían al handle: `data → controls.set`,
   `source → attachSource`, `visible → setVisible`, config de cluster → `setConfig`.
6. Quitar una **capa** del DOM (`disconnectedCallback`) la desmonta (`removeLayer`). Quitar el
   **`<cristae-map>`** destruye el motor entero (`engine.destroy()` → `L.Map.remove()` + contexto WebGL).
   Al destruirse, **notifica automáticamente** a los demás `<cristae-map>` de la página para que
   reposicionen sus capas de puntos (el teardown de glify compartido dejaría sus canvas obsoletos
   sin esta notificación).
7. **Reconexión:** si el `<cristae-map>` vuelve al DOM, se **re-monta** con un motor **nuevo** (las capas
   hijas se re-encolan solas). Por eso `el.engine`/`el.camera` son getters vivos y **no deben cachearse**:
   tras un reattach son otra instancia. Si el layout reconstruye el DOM, conviene insertar lo demás alrededor del
   nodo vivo en vez de detachar el mapa.

Las capas hijas de un `<cristae-cluster>` **no** se auto-montan: las monta el cluster (y si su
config llega tarde, avisan al cluster para que reintente).

---

## Nota — handlers de hover/click con JS puro

Los handlers de `cristae:hover`/`cristae:click` (alta frecuencia, identidad estable por keys) deben
manipularse con **JS puro sobre el DOM**, no con wrappers que reconstruyan el árbol ante un cambio
de estado interno (p. ej. un re-render de React). Detalle y razones en `interaction.md`.
