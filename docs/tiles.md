# Tiles — proveedor y retención de imagen durante el zoom

> Pieza de [Cristae](../MODELO.md). La faceta `tiles` del anfitrión, ortogonal al
> [atlas de iconos](./atlas.md) y al [pipeline de interacción](./interaction.md): no toca
> WebGL ni el dominio, solo el DOM de tiles. Resuelve un único defecto visual del zoom.

Cuando Leaflet hace un zoom sin animarlo **resetea** la vista: suelta todos los tiles de golpe, y
hasta que llega el nivel nuevo el pane de tiles queda **gris**. La retención de snapshots tapa ese
hueco: justo antes del reset toma una **foto** (canvas) de los tiles ya cargados y la deja,
**reproyectada** a la vista nueva, debajo del pane de tiles mientras el nivel nuevo carga encima.
Un zoom animado no resetea —la transición de Leaflet escala los tiles viejos hasta que llegan los
nuevos—, así que ahí la retención se hace a un lado. La política de animación del zoom
([SPECS §9](../SPECS.md)) decide cuál es cuál.

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
Las opciones que acepta un proveedor están en [`elements.md`](./elements.md) (`tile`).

## El proveedor lo pone el anfitrión

Ni el elemento ni el motor tocan la capa de tiles: `map.tile` y `engine.setTileProvider(tile)` se la
piden al anfitrión del mapa, que la crea y la agrega. Hay un proveedor a la vez: el nuevo suelta al
anterior, con su capa y sus fotos. Al destruirse el motor, el anfitrión le saca a un mapa adoptado la
capa y el pane de la retención que le puso. El filtro de los tiles y el fondo del mapa no son opciones
del proveedor: son custom properties, y dónde rige cada una está en [`<cristae-map>`](./elements.md#cristae-map).

## La atribución

`attribution` del proveedor es HTML, como en Leaflet, para que lleve el enlace a la licencia que piden
los proveedores. El mapa no la dibuja: `<cristae-map>` la pone al pie de su zona `bottom-right`, y
`engine.getTileAttribution()` la devuelve tal cual —o `null`— a quien use el motor sin el elemento.
Como se inserta como marcado en la página —el shadow root no aísla scripts—, es configuración del
integrador: un texto que venga de un usuario o de un tercero se escapa antes de ponerlo.

El resto de este documento es la **retención de snapshots** durante el zoom (interno; no hace falta tocarlo).

---

## Por qué snapshots + scoring + seed prefetch

El problema tiene dos aristas y la solución ataca cada una sin tocar el render normal de
Leaflet (solo se engancha a sus eventos):

1. **El hueco gris tras el reset.** Leaflet avisa el reset (`viewprereset`) antes de que la capa
   suelte sus tiles: ahí se captura un canvas con los tiles cargados. Al cerrar el reset
   (`viewreset`) el canvas se cuelga, escalado, en el lugar que ocupa en la vista nueva. Vive en un
   **pane propio** (`pointer-events: none`) por debajo del de tiles: los tiles nuevos lo tapan a medida
   que llegan, y no interfiere con la interacción.

2. **El primer frame tras un zoom grande.** Un solo snapshot del nivel actual cubre poco al
   saltar varios niveles. Por eso un **seed prefetch** precarga, en tiempo ocioso, tiles de
   niveles futuros (`+1, +2, +4, +8`) para tener material que reproyectar antes de que el
   usuario salte. El scoring de `ZoomSnapshotStore` elige entre todos los snapshots
   disponibles (capturados + seed) el mejor par para el viewport destino.

Un zoom animado empieza con `zoomstart` y sin reset: la foto visible sale del documento, porque el
pane de la retención no acompaña a la transición, y la próxima la elige el reset siguiente.

Ningún flag global, ningún estado compartido entre mapas: la retención es del anfitrión, una por
proveedor, y todo su estado vive en su clausura.

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
| `select({ targetZoom, pixelOrigin, viewportSize, zoomScale })` | `(ctx) → placement[]` | O(s) (s = snapshots) | puntúa cada candidato y devuelve `[]`, `[primary]` o `[secondary, primary]`. `pixelOrigin` y `viewportSize` son `{ x, y }`; `zoomScale(target, source) → number` lo provee el caller |
| `clear()` | `() → void` | O(s) | descarta todos los canvas (sale del DOM + colapsa dimensiones) y vacía |
| `ZoomSnapshotStore.discard(entry)` | `(entry) → void` | O(1) | estática: saca el canvas del DOM y pone `width = height = 0` para soltar memoria |

`add` recibe el snapshot tal como lo arma la retención: `{ element: canvas, meta: { sourceZoom,
sourcePixelTopLeft } }`, con la esquina como `{ x, y }` en píxeles de `sourceZoom`. El
`placement` que devuelve `select` es `{ snapshot, frame: { left, top, right, bottom, scale },
visible, score }` — `frame` es el canvas ya proyectado al espacio de píxeles del zoom destino;
el caller lo cuelga con `frameTransform(left, top, scale)` (`src/render/frame.js`).

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

## La retención

Vive en el anfitrión, que es el único que toca los privados de la capa de tiles. Al poner un
proveedor, el anfitrión crea la retención antes de agregar la capa: Leaflet reparte `viewprereset`
en el orden de suscripción, y la capa suelta sus tiles en el suyo. La retención gestiona su
`ZoomSnapshotStore` y el seed prefetch, y se suelta con el proveedor: cancela el prefetch, descarta
los canvas, se desuscribe y desmonta su pane.

Ciclo de eventos que cablea (todos sobre el mapa):

| Evento Leaflet | Acción interna |
|---|---|
| `viewprereset` | captura los tiles cargados de la capa y cancela el prefetch en vuelo |
| `zoomstart` | saca del documento la foto visible (queda en el almacén) |
| `viewreset` | muestra la mejor combinación para la vista nueva |

La foto cuelga del pane `tileZoomSnapshotPane` (z 150, `pointer-events: none`), que la superficie del
anfitrión monta en el primer reset. El canvas no lleva filtro propio: el pane lleva en línea el mismo
`--cristae-tile-filter` que la capa del proveedor, y la foto se ve como los tiles que reemplaza.

---

## Seed prefetch — optimización en tiempo ocioso

Para tener material antes del salto, la retención precarga snapshots de niveles futuros:

- **Agendado con `requestIdleCallback`** (timeout 700 ms). Si el navegador no lo soporta, el
  prefetch simplemente no corre (el zoom sigue funcionando, solo con menos cobertura inicial).
  Se agenda al retener la capa de un proveedor.
- **Niveles objetivo:** `zoom + {1, 2, 4, 8}`, acotados a `maxZoom`. Por nivel se cargan hasta
  `MAX_SEED_TILES_PER_ZOOM` (24) tiles, ordenados por **cercanía al centro** (distancia
  Manhattan), así se prioriza lo que el usuario verá primero.
- **La URL es la que Leaflet pediría a ese zoom.** Leaflet arma la URL de un tile con la grilla
  del zoom de sus tiles: el zoom de la URL, la vuelta al mundo de la x y el rango con que invierte
  la y (`tms`, `{-y}`). Para una semilla se le pone un momento la grilla del zoom de la semilla
  (`_tileZoom` + `_resetGrid`) y después se le devuelve la suya.
- **Generación cancelable.** Cada prefetch lleva un número de `generation`; un reset o soltar la
  retención la **incrementan**. Las descargas en vuelo la chequean entre tile y tile y se
  **abortan** descartando el trabajo. No hay race: una prefetch obsoleta nunca inyecta un canvas
  viejo.
- Los snapshots de seed se agregan con `kind: 'seed'` y se recortan con un cupo propio
  (`maxSeedSnapshots`) **antes** del recorte global, para que no desplacen a los snapshots
  reales capturados en el zoom.

---

## Invariantes

1. **Un proveedor, una retención.** El anfitrión la crea con la capa y la suelta al cambiar de
   proveedor o al destruirse; no hay singletons ni estado compartido entre mapas.
2. **Prefetch obsoleto nunca contamina.** El check de `generation` aborta toda descarga cuya
   generación quedó atrás; un canvas de seed solo se agrega si su generación sigue vigente.
3. **La capa vuelve a su grilla.** Armar la URL de una semilla le cambia la grilla un momento, y
   se le devuelve la suya en el mismo tick, aunque Leaflet lance al armarla.
4. **Los canvas se liberan de verdad.** `discard` los saca del DOM y colapsa sus dimensiones a
   0 para soltar la memoria del bitmap, no solo la referencia.

