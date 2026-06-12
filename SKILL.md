---
name: cristae
description: >-
  Reemplazar un mapa Leaflet + leaflet.glify por Cristae usando el web component <cristae-map> de
  forma lo más declarativa posible. Se usa cuando se tiene un L.map(...) con glify.points/shapes y
  callbacks imperativos y se quiere un árbol declarativo <cristae-map><cristae-point-layer>…, o cuando
  se dibujan miles de puntos WebGL que se actualizan en vivo y el setData O(n) de glify no rinde. Cubre
  la regla atributos-vs-props, el árbol declarativo completo, el JS mínimo (lo que no serializa) y el
  mapeo concepto-a-concepto glify→Cristae.
---

# Cristae — reemplazar un mapa Leaflet/glify (declarativo)

Cristae es Leaflet + glify **con los shaders reescritos** (atlas de iconos, rotación, picking GPU)
y un **path incremental [0-alloc]**: mover/recolorear un punto es O(1) sin reconstruir el buffer. La
piel es un web component `<cristae-map>`: el **HTML describe el mapa**, y un bloque JS chico solo
conecta lo que no serializa. Por dentro **es** un `L.Map`, así que el Leaflet de la página sigue sirviendo.

> Specifiers: `cristae/map` (mapa) · `cristae/core` (datos) · `cristae/table` (tabla).
> Detalle de cada elemento en [`docs/elements.md`](./docs/elements.md).

---

## Instalación — cómo cargar Cristae

Tres formas según dónde estés. En todas, **Leaflet y glify viajan dentro del bundle** (sin CDN, sin
`<script>` extra). Entries: `map` (mapa completo, re-exporta el núcleo) · `table` (`<cristae-table>`,
no arrastra Leaflet) · `core` (solo datos).

**1) Dentro de este monorepo** — se usan los aliases Vite ya configurados:

```js
import 'cristae/map'                                  // registra los <cristae-*> (efecto)
import { createSource, defineIconSet } from 'cristae/map'
```

**2) Proyecto externo, ESM** (recomendado) — el bundle servido desde `dist/cristae/` (lo produce
`npm run build:lib`). Importar el módulo registra los custom elements:

```html
<script type="module">
  import 'https://HOST/.../cristae/esm/map.js'      // registra <cristae-map>, <cristae-point-layer>, …
  import { createSource, defineIconSet } from 'https://HOST/.../cristae/esm/map.js'
</script>
```

**3) Proyecto externo, UMD** — un solo archivo self-contained vía `<script>` clásico → global `CristaeMap`:

```html
<script src="https://HOST/.../cristae/umd/map.js"></script>
<script>
  const { createSource, defineIconSet } = CristaeMap     // los <cristae-*> ya quedaron registrados
</script>
```

---

## La regla: atributos vs props

| | Va en | Por qué |
|---|---|---|
| **Estructura + escalares** — el árbol de elementos, `initial-zoom`, `interactive`, `slot`, `radius`, `bind-to`, `icon-set="nombre"` | **HTML** | son strings/números/booleanos: el markup es su lugar |
| **Objetos y funciones** — `tile`, `accessors`, `iconSet`, `source`/`data`, `items` del toolbar, `textOf` de labels | **JS** | no serializan a atributo; referencian datos/funciones del módulo |

Objetivo del reemplazo: **el HTML describe el mapa; el JS solo enchufa los datos**. Lo imperativo de
glify (crear capas, callbacks, `setData` por frame) desaparece del flujo.

---

## El reemplazo

### Antes — Leaflet + glify (imperativo)

```js
import L from 'leaflet'
import glify from 'leaflet.glify'

const map = L.map('map').setView([-35.5, -71.5], 6)
L.tileLayer('https://{s}.tile.osm.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OSM' }).addTo(map)

const layer = glify.points({
  map,
  data: MOVILES.map(m => [m.lat, m.lng]),     // tuplas
  size: 18,
  color: m => ({ r: 0.1, g: 0.6, b: 0.5 }),   // color por punto
  click: (e, point) => abrirDetalle(point),
})

ws.onMessage(msg => {                          // update en vivo
  const m = MOVILES.find(x => x.id === msg.id); m.lat = msg.lat; m.lng = msg.lng
  layer.setData(MOVILES.map(x => [x.lat, x.lng]))   // ⚠️ rebuild O(n) por mensaje
})
```

### Después — el árbol declarativo (HTML)

Toda la estructura y los escalares viven acá. Clustering, etiquetas y toolbar son hijos declarativos:

```html
<cristae-map initial-center="-35.5,-71.5" initial-zoom="6" hover-throttle="30"
             style="width:100%; height:100%">

  <!-- capa de puntos. id = id de capa; `interactive` habilita click/hover -->
  <cristae-point-layer id="fleet" interactive></cristae-point-layer>

  <!-- etiquetas atadas a la capa: derivan su posición del host por nombre, orden-independiente -->
  <cristae-label-layer bind-to="fleet"></cristae-label-layer>

  <!-- dock de acciones anclado a una zona del overlay -->
  <cristae-toolbar slot="bottom-center" orientation="horizontal"></cristae-toolbar>
</cristae-map>
```

¿Clustering? Se declara envolviendo la capa — sin código:

```html
<cristae-map initial-center="-35.5,-71.5" initial-zoom="6">
  <cristae-cluster radius="88" min-points="2">
    <cristae-point-layer id="fleet" interactive></cristae-point-layer>
  </cristae-cluster>
</cristae-map>
```

> **El `<cristae-map>` se coloca en el HTML (camino recomendado).** Como es un custom element, el
> navegador lo upgradea al cargar el módulo y el JS solo lo **referencia** (`document.querySelector`),
> sin crearlo. Así el árbol del mapa queda visible y versionable en el markup, las capas hijas se
> auto-montan top-down, y no hay que orquestar orden de inserción. **Ruta por JS (cuando el contenedor
> no existe en el markup):** se crea como cualquier elemento y se conecta al DOM —
> `const map = document.createElement('cristae-map'); contenedor.appendChild(map)` — y desde ahí se montan
> capas por props o `map.engine.addPointLayer(...)`. Funciona igual (montar = conectar al DOM), pero
> conviene reservarla para paneles dinámicos: se prefiere el markup declarativo siempre que el contenedor sea fijo.
> Conviene recordar que **desconectar el nodo destruye el motor** (ver *Ciclo de vida*), así que en la ruta JS
> se evita reparentar el elemento; el layout se inserta alrededor.

### Después — el JS mínimo (solo lo que NO serializa)

Cada línea está acá **porque es objeto o función**, no por elección:

```js
import 'cristae/map'                                  // registra <cristae-map>, <cristae-point-layer>, …
import { defineIconSet, createSource } from 'cristae/map'

const map   = document.querySelector('cristae-map')
const fleet = map.querySelector('#fleet')

// tile → objeto (no hay atributo `tile-url`)
map.tile = { url: 'https://{s}.tile.osm.org/{z}/{x}/{y}.png', maxZoom: 19, attribution: '© OSM' }

// accessors → funciones. Proyectan los objetos propios (id + posición), no tuplas [lat,lng].
// El source LOS TRANSPORTA: con `.source` NO se asigna `fleet.accessors` (los lleva adentro).
const source = createSource({
  idOf:       m => m.id,
  positionOf: m => ({ lat: m.lat, lng: m.lng }),
  variantOf:  m => m.estado,        // ← reemplaza el `color: p => …` de glify (color/forma por estado)
  headingOf:  m => m.rumbo,         // ← rotación de iconos (glify no lo hacía)
})

// iconSet → objeto. Dibujas el ícono UNA vez por variante; se cachea en el atlas (no por punto).
fleet.iconSet = defineIconSet({
  rotates: true,
  variants: ['activo', 'detenido', 'alerta'],            // preseed → cero regrow en runtime
  sizes: { default: 18 },
  describe: v => ({ shape: 'pin', color: v === 'alerta' ? '#e11' : v === 'detenido' ? '#888' : '#1a8' }),
  renderers: { pin: (ctx, s, d) => { ctx.fillStyle = d.color; ctx.beginPath(); ctx.arc(s/2, s/2, s*0.4, 0, 7); ctx.fill() } },
})

// datos → la capa. `.source` (vivo, compartible, trae sus accessors) …
fleet.source = source
source.set(MOVILES)                                       // alta inicial (1 rebuild)

// … o la ruta más simple si no compartes la fuente: `.accessors` + `.data` (la capa posee la Source).
//   fleet.accessors = { idOf: m => m.id, positionOf: m => ({ lat: m.lat, lng: m.lng }), variantOf: m => m.estado }
//   fleet.data = MOVILES
// El orden de estos seteos NO importa: la capa difiere el montaje hasta tener source (o accessors).
```

> **Aún más declarativo:** se registra el iconSet por nombre y se referencia por atributo —
> `map.engine.registerIconSet('flota', iconSet)` (en `cristae:ready`) + `<cristae-point-layer
> icon-set="flota">`. La registración sigue siendo una línea JS (el iconSet es un objeto), pero la
> *referencia* pasa al HTML. Mismo patrón para el toolbar: los `items` (con sus `onClick`) se asignan
> en JS dentro de `cristae:ready` porque llevan funciones.

### El update en vivo — one-liner

```js
ws.onMessage(m => source.move(m.id, m.lat, m.lng))        // O(1), sin rebuild — el reemplazo de setData O(n)
```

`move` reescribe el slot del punto en GPU; no reconstruye el buffer. Miles de updates/seg sin GC.
Para parches con más campos que la posición: `source.patch(items, dirtyIds)` (O(k)). `set` es solo
para alta/baja del conjunto.

---

## Interacción — de callbacks a eventos

glify resuelve el click contra **una** capa y te da el punto crudo. Cristae emite un `CustomEvent`
con los hits de **todas** las capas visibles, **ordenados top-first**:

```js
// Hit = { layerId, kind: 'point'|'polygon', ref, id, distancePx, zIndex, order }
map.addEventListener('cristae:click', (e) => {
  const top = e.detail.hits[0]
  if (top?.layerId === 'fleet') abrirDetalle(source.itemById(top.id))
})
map.addEventListener('cristae:hover', (e) => resaltar(e.detail.hits))
```

| glify | Cristae |
|---|---|
| `click: (e, point) => …` | `map.addEventListener('cristae:click', e => e.detail.hits)` |
| `hover: (e, point) => …` | `'cristae:hover'` (+ `hover:start`/`hover:end` derivados) |
| — | `'cristae:pointermove'` → `{ lat, lng, x, y }` · `'cristae:viewportchange'` · `'cristae:ready'` |

`'cristae:ready'` es el momento para tocar el engine (`map.engine`, items del toolbar, `registerIconSet`).

> **Dos APIs según el caso.** `addEventListener('cristae:click', e => e.detail.hits)` es la del DOM:
> burbujea, una suscripción ve los hits de **todas** las capas. `map.on('click', 'fleet', cb)` es la del
> motor: **filtra por capa** (`'fleet'` o `['a','b']`) y el callback recibe los hits directos
> (`cb(hits, ev)`), sin `e.detail`. Usa la del DOM por defecto; la del motor cuando solo te importa una capa.

---

## Cámara — de `map.setView` a `el.camera`

Tras montar, **todo movimiento es acción imperativa** (no hay prop reactiva de centro;
`initial-center`/`initial-zoom` solo fijan la vista inicial):

```js
await map.ready
map.camera.flyTo([-33.45, -70.66], 14)
map.camera.fitToLayer('fleet', { insets: { top: 40 } })
map.camera.followPoint('fleet', movilId)        // en glify se hacía panTo por cada msg; acá se declara una vez
map.camera.zoomIn(); map.camera.zoomOut()       // botones +/− (el zoom NO cancela un followPoint en curso)
```

La cámara además **proyecta** coordenadas ↔ píxeles del contenedor, para anclar overlays HTML propios
(p. ej. una tarjeta al hacer click) sin bajar al `L.Map` crudo:

```js
const { x, y } = map.camera.latLngToContainerPoint([lat, lng])   // dónde cae el punto, en px del contenedor
const latlng   = map.camera.containerPointToLatLng([x, y])
```

---

## Equivalencias glify → Cristae (chuleta)

| glify | Cristae |
|---|---|
| `L.map(el)` | `<cristae-map>` (HTML) |
| `L.tileLayer(url, opts).addTo(map)` | `map.tile = { url, ...opts }` (o `tilePresets.osm`) |
| `glify.points({ data, size, color })` | `<cristae-point-layer>` + `accessors` + `iconSet` + `source` |
| `data: [[lat,lng],…]` | `accessors.positionOf = m => ({ lat, lng })` (los objetos propios, sin tuplas) |
| `size: 18` / `size: p=>…` | `sizes.default` del IconSet / `accessors.sizeOf` |
| `color: p => ({r,g,b})` | `accessors.variantOf` + `IconSet.describe/renderers` (dibujo cacheado) |
| — (no existe) | `accessors.headingOf` → rotación de iconos |
| `layer.setData(arr)` | `source.set(arr)` (rebuild) · **`source.move(id,…)`** / `source.patch(…)` (incremental) |
| `glify.shapes({...})` | `<cristae-polygon-layer>` + `accessors:{ idOf, ringsOf, styleOf }` |
| `click/hover` callbacks | eventos `cristae:click`/`cristae:hover` → `e.detail.hits[]` |
| `map.setView/panTo/flyTo` · zoom `+/−` | `map.camera.setView/panTo/flyTo/zoomIn/zoomOut` |
| seguir un punto con `panTo` por update | `map.camera.followPoint(layerId, id)` (una vez) |
| `fitBounds` a mano tras cargar datos | `auto-fit="once"` en la capa (o `map.camera.fitToLayer('fleet')`) |
| `map.latLngToContainerPoint` para un overlay | `map.camera.latLngToContainerPoint(latlng)` |
| popup/tarjeta al click sobre un punto | `<cristae-popup for="fleet">` + `contentOf(item)` (HTML en light DOM) |
| labels/tooltips a mano | `<cristae-label-layer bind-to="fleet">` |
| clustering manual | `<cristae-cluster>` envolviendo la capa |
| `L.icon`/`divIcon` puntual | `map.engine.createIcon({ size, draw })` |

---

## Ciclo de vida — `<cristae-map>` ES un `L.Map`

El elemento **posee** un `L.Map` y su contexto WebGL, así que es un recurso con ciclo de vida, no un
`<div>` reposicionable. **Desconectarlo del DOM lo destruye** (`disconnectedCallback` → `engine.destroy()`):
`node.remove()`, reparentarlo, o un `innerHTML` en un ancestro matan el mapa. Al reconectar se **re-monta
solo**, pero con un motor **nuevo**. De ahí dos reglas:

- **No conviene cachear `engine`/`camera`/`getLeafletMap()`** en una variable: tras un reattach apuntan a la
  instancia muerta. Se lee siempre el getter vivo (`map.camera.flyTo(...)`, `map.engine.…`).
- **Si el layout reconstruye el DOM** (tabs, acordeones), lo demás se inserta **alrededor** del nodo vivo;
  no se debe desconectar el mapa para reposicionarlo.

**Readiness.** Antes de montar, `map.engine`/`map.camera` son `null`. Para esperar:

- `await map.ready` — promesa **one-shot por instancia** (resuelve cuando su motor está listo). Dos
  mapas en la página → cada uno tiene su propia `ready`, con su propio tiempo.
- evento `cristae:ready` — se **re-emite en cada (re)montaje**; se usa si se necesita el motor nuevo tras un reattach.

---

## Gotchas

- **El contenedor necesita altura** (como Leaflet) o no renderiza — se fija en el `<cristae-map>`.
- **No se debe llamar `invalidateSize`/`syncSize` a mano:** el elemento ya observa su tamaño (`ResizeObserver`
  interno) y `syncSize()` redibuja las capas de puntos. Crearlo oculto (`display:none`) y mostrarlo
  luego se sincroniza solo, igual que cualquier resize (cambio de alto, maximizar una columna kanban):
  el tamaño cambia → el observer redibuja el canvas GL. No se necesita un `ResizeObserver` propio ni
  llamar `invalidateCanvas()` para estos casos.
- **`map.invalidateCanvas()`** es el escape hatch manual: solo se necesita en el motor headless
  (`MapEngine` sin `<cristae-map>`, sin observer) o si el contenedor vuelve a ser visible **sin cambiar
  de tamaño** (no dispara resize). Con el elemento estándar, rara vez hace falta.
- **Múltiples mapas en la página:** al destruirse un `<cristae-map>`, los hermanos vivos reciben un
  reset automático de sus capas de puntos — no hay que hacer nada.
- **Shadow DOM:** el mapa vive en un shadow root; el CSS/JS de la página **no cruza** el borde (popups de
  Leaflet sin estilar, FontAwesome-JS que escanea `document` no ve adentro). Los overlays HTML propios
  (tarjeta al click) se renderizan en **light DOM** y se posicionan con `camera.latLngToContainerPoint`. Los
  `CustomEvent` `cristae:*` sí cruzan (son `composed`).
- **`describe` del IconSet debe ser _total_:** para cualquier `variant` posible devuelve un descriptor
  completo; deriva props de la variante misma (hash), no de una lista con `indexOf` (una prop faltante
  no lanza, degrada a ícono mal pintado). Ver [`docs/icons.md`](./docs/icons.md).
- **No mover con `set`:** `set` es rebuild O(n) (el viejo `setData`). Para mover se usa `move` (O(1)).
- **Una fuente, varias vistas:** el mismo `createSource` alimenta la capa del mapa y una
  `<cristae-table>` — el filtro se computa una vez ([`docs/table.md`](./docs/table.md)).
- **Timing:** las props objeto seteadas síncronas tras tomar la referencia llegan a tiempo; el motor
  monta async (`await` de glify) y las capas se montan cuando existe. Lo que necesite el engine
  (toolbar items, `registerIconSet`) va en `cristae:ready`.

---

## Si no se puede ir 100% declarativo

- **Migración incremental — envolver el `L.Map`:** no se usa el web component; se usa el motor headless y
  se le pasa el mapa. `new MapEngine({ leaflet: L, glify, map })` **no crea ni destruye** el `L.Map` (los
  controles/capas Leaflet siguen vivos); se migra capa por capa. `engine.getLeafletMap()` devuelve el
  `L.Map` crudo (también `map.engine.getLeafletMap()` desde el web component).
- **Headless puro** (otro framework, SSR): `MapEngine` es la API completa; `<cristae-map>` es ~200 LOC
  de piel encima. `engine.addPointLayer({ id, source, iconSet, interactive })`, `engine.on('click',
  'fleet', cb)`, `engine.setTileProvider({ url })`. El motor es framework-agnostic y testeable sin DOM.

```js
import { MapEngine, defineIconSet, createSource } from 'cristae/map'
import L from 'leaflet'; import glify from 'leaflet.glify'

const map = L.map('map').setView([-35.5, -71.5], 6)   // el mapa propio + controles + capas Leaflet
const engine = new MapEngine({ leaflet: L, glify, map })
await engine.ready
const fleet = createSource({ idOf: m => m.id, positionOf: m => ({ lat: m.lat, lng: m.lng }) })
engine.addPointLayer({ id: 'fleet', source: fleet, iconSet, interactive: true })
fleet.set(MOVILES)
ws.onMessage(m => fleet.move(m.id, m.lat, m.lng))
```
