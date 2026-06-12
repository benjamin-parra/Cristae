# Tiles — retención de imagen durante el zoom

> Pieza de [Cristae](../MODELO.md). Capa de presentación sobre Leaflet, ortogonal al
> [atlas de iconos](./atlas.md) y al [pipeline de interacción](./interaction.md): no toca
> WebGL ni el dominio, solo el DOM de tiles. Resuelve un único defecto visual del zoom.

Cuando Leaflet hace zoom, la animación arranca **antes** de que lleguen los tiles del nuevo
nivel. Durante esos pocos frames el pane de tiles queda **gris** (el viejo nivel ya se está
podando y el nuevo todavía no carga). La retención de snapshots tapa ese hueco: al iniciar el
zoom toma una **foto** (canvas) de los tiles ya cargados, la mantiene visible y la
**reproyecta** en cada frame de la animación, hasta que el nuevo nivel termina de cargar.

---

## Proveedores listos — `tilePresets`

Para el caso común, `tilePresets` trae configs de proveedores públicos (sin API key) que se asignan directo
a `map.tile` (web component) o se pasan a `engine.setTileProvider(...)` (headless):

```js
import { tilePresets } from 'cristae/map'
map.tile = tilePresets.osm                              // o cartoLight / cartoDark / esriImagery
map.tile = { ...tilePresets.cartoDark, maxZoom: 17 }    // con override
```

| Preset | Proveedor |
|---|---|
| `osm` | OpenStreetMap |
| `cartoLight` / `cartoDark` | CARTO basemaps |
| `esriImagery` | Esri World Imagery (satelital) |

Son **datos**, no un code-path: un proveedor con key (Google, Mapbox) se arma como objeto `{ url, … }`.
El resto de este documento es la **retención de snapshots** durante el zoom (interno; no hace falta tocarlo).

---

## Por qué snapshots + scoring + seed prefetch

El problema tiene tres aristas y la solución ataca cada una sin tocar el render normal de
Leaflet (solo se engancha a sus eventos y difiere su prune):

1. **El hueco gris durante la animación.** Se captura un canvas con los tiles vivos al
   `zoomstart` y se transforma (`translate3d` + `scale`) por frame para seguir el viewport
   animado. El canvas vive en un **pane propio** (`pointer-events: none`) por encima del de
   tiles, así no interfiere con la interacción.

2. **El prune prematuro de Leaflet.** Si Leaflet poda los tiles viejos a media animación,
   reaparece el mismo hueco que se está tapando. La retención **monkey-patchea**
   `layer._pruneTiles`: durante la retención lo difiere (marca `pruneDeferred`) y lo ejecuta
   recién al `zoomend`. Al desactivar la capa restaura el método original.

3. **El primer frame tras un zoom grande.** Un solo snapshot del nivel actual cubre poco al
   saltar varios niveles. Por eso un **seed prefetch** precarga, en tiempo ocioso, tiles de
   niveles futuros (`+1, +2, +4, +8`) para tener material que reproyectar antes de que el
   usuario salte. El scoring de `ZoomSnapshotStore` elige entre todos los snapshots
   disponibles (capturados + seed) el mejor par para el viewport destino.

Ningún flag global, ningún estado compartido entre mapas: toda la retención vive en la
clausura que devuelve `createTileSnapshotRetention(map, …)`. Cada `L.map` tiene la suya.

---

## `ZoomSnapshotStore` — el almacén con scoring

Almacén de snapshots de tiles. Cada entrada es un canvas ya rasterizado con la región de
tiles de un zoom de origen, más su metadata de proyección (`sourceZoom`,
`sourcePixelTopLeft`). `select()` puntúa todos los candidatos contra el viewport destino y
devuelve el mejor par.

Construcción: `new ZoomSnapshotStore({ maxSnapshots = 8, maxSeedSnapshots = 3 })`.

| Método | Firma | Complejidad | Notas |
|---|---|---|---|
| `add(snapshot, { kind })` | `({element, meta}, {kind?: 'normal'\|'seed'}) → entry` | O(1) + trim | registra el canvas + metadata; `kind` por defecto `'normal'`. Tras agregar recorta (`#trim`) |
| `select({ targetZoom, pixelOrigin, viewportSize, zoomScale })` | `(ctx) → placement[]` | O(s) (s = snapshots) | puntúa cada candidato y devuelve `[]`, `[primary]` o `[secondary, primary]`. `zoomScale(target, source) → number` lo provee el caller (Leaflet) |
| `clear()` | `() → void` | O(s) | descarta todos los canvas (sale del DOM + colapsa dimensiones) y vacía |
| `ZoomSnapshotStore.discard(entry)` | `(entry) → void` | O(1) | estática: saca el canvas del DOM y pone `width = height = 0` para soltar memoria |

`add` recibe el snapshot tal como lo arma la retención: `{ element: canvas, meta: { sourceZoom,
sourcePixelTopLeft } }`. El `placement` que devuelve `select` es
`{ snapshot, frame: { left, top, right, bottom, scale }, visible, score }` — `frame` es el
canvas ya proyectado al espacio de píxeles del zoom destino; el caller aplica
`translate3d(left, top) scale(scale)`.

### Scoring primario y secundario

Los pesos son deliberados y están horneados en el código (no son configurables):

- **Primario** — el snapshot que mejor cubre el viewport destino. Se elige el de mayor
  `score = coverage⁴ · (0.65 + 0.35·centerCoverage²) · zoomQuality`:
  - `coverage⁴` prioriza **fuertemente** la cobertura total (un snapshot que cubre poco se
    vuelve despreciable).
  - el factor de centro (`centerCoverage²` sobre el rect central, 25 % de inset por lado)
    favorece lo que el usuario ve en el medio.
  - `zoomQuality = 1 / (1 + |sourceZoom − targetZoom|·0.45)` penaliza saltos de zoom grandes
    (un snapshot de un nivel lejano se escala feo).

- **Secundario** — vale solo por lo que aporta **fuera** del primario. Su puntaje se recalcula
  como `(residualArea/viewportArea)³ · score`: el cubo lo hace despreciable salvo que rellene
  una porción significativa del hueco que deja el primario. Se descarta si no supera
  `MIN_SECONDARY_SCORE` (0.01).

El resultado se devuelve **secundario primero** (`[secondary, primary]`) para que el caller lo
pinte por debajo (el primario tapa al secundario en la zona compartida).

---

## `createTileSnapshotRetention(map, opts)` — la retención

Engancha la retención a un `L.map`. Se auto-suscribe a los eventos de zoom de Leaflet y
gestiona internamente un `ZoomSnapshotStore` y el seed prefetch.

```js
createTileSnapshotRetention(map, {
  paneName = 'tileZoomSnapshotPane',  // pane propio para los canvas de snapshot
  paneZIndex = 150,                   // z-index del pane (por encima del de tiles)
})
```

Ciclo de eventos que cablea (todos sobre `map`):

| Evento Leaflet | Acción interna |
|---|---|
| `zoomstart` / `viewprereset` | captura snapshot de tiles vivos + muestra |
| `zoomanim` | reproyecta al destino animado (`event.zoom`, `event.center`) |
| `zoom` | reproyecta al estado intermedio |
| `zoomend` | último ajuste + ejecuta el prune diferido |

API devuelta:

| Método | Firma | Complejidad | Notas |
|---|---|---|---|
| `activateLayer(layer)` | `(L.TileLayer) → void` | O(1) | adopta la capa de tiles activa: difiere su `_pruneTiles`, invalida snapshots viejos y agenda el seed prefetch. No-op si ya es la activa o si la capa no tiene `_pruneTiles` |
| `invalidateSnapshots()` | `() → void` | O(s) | descarta todos los canvas y cancela el prefetch en vuelo. Para cuando cambia el **proveedor** de tiles (los snapshots viejos son de otro proveedor) |
| `destroy()` | `() → void` | O(s) | cancela prefetch, restaura el `_pruneTiles` original, limpia snapshots y des-suscribe todos los eventos |

`activateLayer` ya invalida snapshots internamente; `invalidateSnapshots` se expone como
contrato explícito para quien **reemplaza** la capa de tiles sin cambiar de objeto (ej:
cambia la URL del proveedor de la misma `L.TileLayer`).

---

## Seed prefetch — optimización en tiempo ocioso

Para tener material antes del salto, la retención precarga snapshots de niveles futuros:

- **Agendado con `requestIdleCallback`** (timeout 700 ms). Si el navegador no lo soporta, el
  prefetch simplemente no corre (el zoom sigue funcionando, solo con menos cobertura inicial).
  Nunca se agenda durante una retención activa ni si ya hay uno agendado.
- **Niveles objetivo:** `zoom + {1, 2, 4, 8}`, acotados a `maxZoom`. Por nivel se cargan hasta
  `MAX_SEED_TILES_PER_ZOOM` (24) tiles, ordenados por **cercanía al centro** (distancia
  Manhattan), así se prioriza lo que el usuario verá primero.
- **Generación cancelable.** Cada prefetch lleva un número de `generation`; cualquier
  `cancelSeedPrefetch` (lo dispara un nuevo zoom, `activateLayer`, `invalidateSnapshots` o
  `destroy`) **incrementa** la generación. Las descargas en vuelo chequean
  `generation !== currentGeneration()` entre tile y tile y se **abortan** descartando el
  trabajo. No hay race: una prefetch obsoleta nunca inyecta un canvas viejo.
- Los snapshots de seed se agregan con `kind: 'seed'` y se recortan con un cupo propio
  (`maxSeedSnapshots`) **antes** del recorte global, para que no desplacen a los snapshots
  reales capturados en el zoom.

## Prune diferido — optimización del prune de Leaflet

`activateLayer` reemplaza `layer._pruneTiles` por un wrapper: mientras `retaining` es `true` y
la capa es la activa, marca `pruneDeferred = true` y **no poda**. Al `zoomend` (`endRetention`)
ejecuta el `_pruneTiles` original una sola vez. Así los tiles viejos siguen disponibles para
capturar/mostrar durante toda la animación, y se podan recién cuando el snapshot ya no se
necesita. `destroy`/`resetLayer` restauran siempre el método original.

---

## Invariantes

1. **Un mapa, una retención.** Todo el estado vive en la clausura de
   `createTileSnapshotRetention`; no hay singletons ni estado compartido entre mapas.
2. **Prefetch obsoleto nunca contamina.** El check de `generation` aborta toda descarga cuya
   generación quedó atrás; un canvas de seed solo se agrega si su generación sigue vigente.
3. **El `_pruneTiles` original siempre se restaura** al desactivar la capa o destruir
   (`resetLayer`), aunque haya un prune diferido pendiente.
4. **Los canvas se liberan de verdad.** `discard` los saca del DOM y colapsa sus dimensiones a
   0 para soltar la memoria del bitmap, no solo la referencia.

---

## Ejemplo de uso

```js
import L from 'leaflet'
import { createTileSnapshotRetention } from './src/tiles/TileSnapshotRetention.js'

const map = L.map('mapa', { center: [-33.45, -70.66], zoom: 12 })
const tiles = L.tileLayer('https://tile.proveedor.com/{z}/{x}/{y}.png', {
  maxZoom: 19,
}).addTo(map)

// Adjuntar la retención al mapa y activarla sobre la capa de tiles.
const retention = createTileSnapshotRetention(map, { paneZIndex: 150 })
retention.activateLayer(tiles)
// A partir de acá, cada zoom mantiene la imagen visible sin hueco gris.

// Si más adelante se cambia de proveedor de tiles (misma o nueva capa):
retention.invalidateSnapshots()   // descarta fotos del proveedor viejo

// Al desmontar el mapa:
retention.destroy()
```
