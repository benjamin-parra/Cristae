# Cristae

Web components de alto rendimiento para **datos en tiempo real**: una tabla virtual y un mapa WebGL
con shaders propios, hospedado en Leaflet, sobre un **núcleo de datos reactivo** compartido. Miles de
updates/seg con hot-path *zero-alloc*. Piel declarativa `<cristae-*>` + motor headless `MapEngine`.

> El nombre viene de las *cristae* mitocondriales —los pliegues de la membrana interna donde se
> produce la energía—: una membrana (envoltura declarativa del mapa) que además es el
> sitio de potencia.

## Instalación (vía GitHub)

```bash
npm install github:benjamin-parra/Cristae   # o: git+https://github.com/benjamin-parra/Cristae.git#v0.1.0
```

`leaflet` y `lit` son **peerDependencies** (los provee el consumidor). `supercluster` y
`geographiclib-geodesic` viajan como dependencias normales; la última sólo la usa el elipsoide de
`cristae/geometry` ([geometría](docs/geometry.md)). Se publica sólo como UMD: un bundler que sirve
Cristae desde la fuente sin pre-empaquetarla (Vite con `optimizeDeps.exclude: ['cristae']`) la
pre-empaqueta aparte, con `optimizeDeps.include: ['cristae > geographiclib-geodesic']`.

## Leaflet

Leaflet es el **anfitrión** del mapa —cámara, tiles y entrada del navegador— y un detalle interno: la API
habla en valores propios (`{ lat, lng }`, `{ x, y }`, `{ south, west, north, east }`) y las capas se dibujan
con la superficie WebGL de Cristae. Un mapa Leaflet que ya existe se entrega al motor con
`adoptLeafletHost(map, { leaflet })`, el único punto de integración con un Leaflet ajeno
([SPECS §6](SPECS.md)), donde también consta que `engine.getLeafletMap()` está fuera de contrato. Se
retira en v0.47.0 ([deprecado](#deprecado-se-retira-en-v0470)).

## Uso mínimo

```html
<cristae-map initial-center="-35.5,-71.5" initial-zoom="5" style="height:100%">
  <cristae-point-layer id="fleet" interactive></cristae-point-layer>
</cristae-map>
```

```js
import 'cristae/map'                          // registra los <cristae-*> de mapa
import { createSource, defineIconSet } from 'cristae/map'
// ...crear Source, asignar iconSet y source a la capa
```

## Entry points

| Specifier          | Trae                                                        | Registra           |
|--------------------|-------------------------------------------------------------|--------------------|
| `cristae/map`      | mapa + núcleo (Leaflet/lit)                                 | `<cristae-*>` mapa |
| `cristae/table`    | tabla virtual + núcleo (solo `lit`)                         | `<cristae-table>`  |
| `cristae/core`     | solo el núcleo de datos (sin DOM)                           | —                  |
| `cristae/geojson`  | lector de GeoJSON a arrays tipados                          | —                  |
| `cristae/geometry` | distancias, áreas, formas, geodésica, terreno, cajas y path | —                  |
| `cristae/formats`  | KML, GPX, WKT/WKB, TopoJSON, EsriJSON, Shapefile y FGB      | —                  |

`table` y `map` nunca se importan entre sí: una tabla no baja Leaflet.

## Deprecado: se retira en v0.47.0

La v0.47.0 retira todo lo deprecado. Hasta entonces sigue funcionando, y el [CHANGELOG](CHANGELOG.md) da
la *Migración* de cada API. La política de retiro está en
[`docs/versionado.md`](docs/versionado.md#deprecación-y-retiro).

| API deprecada | Reemplazo |
|---------------|-----------|
| `engine.addPolygonGpuLayer`, con `PolygonGpuLayerConfig` y `PolygonGpuHandle` | `engine.addPolygonLayer({ geometry })` ([polígonos](docs/polygons.md)) |
| `engine.addCircleLayer` | `engine.addShapeLayer`, con `radiusOf` en vez de `radiusMetersOf`, o `<cristae-shape-layer>` ([formas](docs/shapes.md#migrar-desde-addcirclelayer)) |
| `CircleAccessors`, `CircleLayerConfig`, `CircleHandle` | `ShapeAccessors`, `ShapeLayerConfig`, `ShapeHandle` |
| `CircleHit` (`kind: 'circle'` en `Hit`), `CristaeCircleHit` | `ShapeHit`, `CristaeShapeHit` |
| `engine.getLeafletMap()` | La cámara ([SPECS §9](SPECS.md)), `setTileProvider`, `setCursor` y las señales del motor. Dibujar sobre el mapa de Leaflet crudo no tiene reemplazo |
| `<cristae-label-layer bind-to>`, `<CristaeLabelLayer>`, `engine.addLabelLayer` | `<cristae-labeled>`, `<CristaeLabeled>`, `engine.addLabels`, que envuelven la capa ([rótulos](docs/labeled.md)) |
| `CristaeLabelLayerProps`, `CristaeLabelLayerElement` | `CristaeLabeledProps`, `CristaeLabeledElement` |
| `<cristae-label-layer>` con `source` propio | `<cristae-text-layer>`, `<CristaeTextLayer>`, `engine.addTextLayer`: una capa base de texto ([texto suelto](docs/text-layer.md)) |
| `<cristae-label-layer slot="bubble">` dentro de `<cristae-cluster>` | Un `<cristae-labeled>` por fuera del cluster, con `textOf` sobre `{ count, leaves }` |

## Antes de empujar: el gate

Cristae se vendoriza en winglibraries (`packages/cristae`), cuyo pipeline de GitLab corre en `node:24-alpine` y
avisa a todo el equipo cuando falla. Por eso el hook `pre-push` deja subir un árbol que ya pasó el gate, y una
prueba que anda en un Node y no en el de la imagen aparece en local.

```bash
npm install            # activa el hook pre-push
npm run gate           # node scripts/ci-local.mjs [--ref <commit>]
```

### Qué corre

El gate clona lo commiteado y corre install, `npm run lint`, `npm test` y `npm run build` en dos imágenes:

| Imagen | Por qué |
| --- | --- |
| `node:24-alpine` (`IMAGEN_RUNNER` en `scripts/ci-local.mjs`) | Es la `default.image` del `.gitlab-ci.yml` de winglibraries |
| `node:26-alpine` (`IMAGEN_ACTUAL`) | El Node con que se desarrolla, en un clon limpio y sin la carga de la máquina local |

El lockfile está en `.gitignore`, así que el clon instala con `npm install`. Si algún día se commitea, pasa a
`npm ci`.

### Cómo se activa

- `npm install` corre el `prepare`, que apunta `core.hooksPath` a `.githooks/`. Un clon nuevo no tiene el hook
  hasta ese primer install, o hasta `node scripts/activar-hooks.mjs`.
- El hook valida cada ref que se empuja. Borrar una rama o un tag remoto no sube código y pasa sin validar.
- En verde, el gate guarda un sello con el hash del árbol en `<git-common-dir>/ci-local-sellos/`, fuera del repo.
  Un segundo push del mismo árbol no repite la corrida, y en rojo no se escribe sello.

### Dónde corre el contenedor

En Windows corre en docker dentro de WSL, y en Linux o macOS en `docker` o `podman` locales. Un host remoto por
ssh se configura en el clon de cada uno, nunca en el repo, o con las variables `CILOCAL_REMOTO`, `CILOCAL_MOTOR`
y `CILOCAL_CANDADO`:

```bash
git config cilocal.remoto <alias-ssh>      # host con podman o docker
git config cilocal.motor podman            # opcional
git config cilocal.candado <ruta-remota>   # opcional: serializa las corridas con flock
```

### Si el hook frena el push

- Se corrige la causa: el código, o la prueba si medía mal su invariante.
- Si el rojo no viene de los commits propios, no se empuja: se arregla primero en la rama base.
- `git push --no-verify` salta el hook, y el rojo llega igual al pipeline de winglibraries. En Claude Code, el
  hook de `.claude/settings.json` niega todo `git push` que lo salte.

## Documentación

- [`AGENTS.md`](AGENTS.md) — reglas de contribución y estilo JavaScript.
- [`SKILL.md`](SKILL.md) — guía práctica (instalación, API mínima, gotchas).
- [`MODELO.md`](MODELO.md) — arquitectura y decisiones de diseño.
- [`SPECS.md`](SPECS.md) — contrato formal e invariantes.
- [`docs/`](docs/) — una página por API pública.

## Build de la librería self-contained

`node build.mjs` produce `dist/cristae/` (ESM + UMD con todo bundleado, Leaflet incluido, skill y `llms.txt`) para
consumo sin npm/CDN. El código fuente vive bajo [`src/`](src/).

## Navegadores

| Motor                   | Mínimo | Lo fija                                                      |
|-------------------------|--------|--------------------------------------------------------------|
| Chromium (Chrome, Edge) | 92     | `Array.prototype.at`                                         |
| Firefox                 | 90     | campos y métodos privados (`#x`), `Array.prototype.at`       |
| Safari (macOS, iOS)     | 16     | campos públicos de clase: de 14.1 a 15.x tienen un fallo de alcance |

El build (`build.mjs`) emite `es2022` sin bajar sintaxis: los campos y métodos privados y los campos de
clase quedan nativos, y no hay bloques `static {}`, que subirían Safari a 16.4. Las cifras salen de
[MDN browser-compat-data](https://github.com/mdn/browser-compat-data) (`javascript/classes.json`,
`javascript/builtins/Array.json`); el mapa además pide WebGL2, que no sube ninguno de los tres mínimos.
Quien importa `src/` con su propio bundler hereda la misma sintaxis y puede bajarla con su `target`,
salvo `Array.prototype.at`, que es una API y no sintaxis.

La tabla es el mínimo del núcleo. `terrain` (de `cristae/geometry`) pide además `DecompressionStream`
para el PNG, que fija Safari 16.4 y Firefox 113, y `OffscreenCanvas` y `createImageBitmap` para el WebP
([`docs/geometry.md`](docs/geometry.md)). En un navegador sin ellos rechaza con un mensaje de entorno.

## Limitaciones conocidas

- **Un vuelo animado de cámara y el gesto de dos dedos dejan quietas las capas GL.** Con un modo de
  zoom animado, `camera.flyTo` encadena zoom y paneo sin transición que seguir: las capas GL quedan
  donde estaban mientras dura el vuelo y saltan a su lugar al cerrarlo (`zoomend`/`moveend`). El pinch
  abre un zoom desde su primer movimiento, con cualquier modo y aunque los dos dedos sólo se desplacen:
  las capas GL quedan quietas mientras dura el gesto y se asientan al soltar. El zoom animado (rueda,
  `+`/`−`) y el paneo —con un dedo o el ratón, la inercia o `camera.panTo`— sí se siguen.
  **Recomendación:** para el vuelo, dejar el modo de zoom en su default `'none'`, con el que `flyTo`
  salta sin animar, o mover con `camera.setView(...)`. El `followPoint` ya re-centra sin animación.

## Licencia

MIT © Benjamin Parra
