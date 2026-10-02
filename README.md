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
([SPECS §6](SPECS.md)), donde también consta que `engine.getLeafletMap()` está fuera de contrato.

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

| Specifier          | Trae                                        | Registra           |
|--------------------|---------------------------------------------|--------------------|
| `cristae/map`      | mapa + núcleo (Leaflet/lit)                 | `<cristae-*>` mapa |
| `cristae/table`    | tabla virtual + núcleo (solo `lit`)         | `<cristae-table>`  |
| `cristae/core`     | solo el núcleo de datos (sin DOM)           | —                  |
| `cristae/geojson`  | lector de GeoJSON a arrays tipados          | —                  |
| `cristae/geometry` | distancias, áreas, cajas y contrato de path | —                  |

`table` y `map` nunca se importan entre sí: una tabla no baja Leaflet.

## Documentación

- [`AGENTS.md`](AGENTS.md) — reglas de contribución y estilo JavaScript.
- [`SKILL.md`](SKILL.md) — guía práctica (instalación, API mínima, gotchas).
- [`MODELO.md`](MODELO.md) — arquitectura y decisiones de diseño.
- [`SPECS.md`](SPECS.md) — contrato formal e invariantes.
- [`docs/`](docs/) — una página por API pública.

## Build de la librería self-contained

`node build.mjs` produce `dist/cristae/` (ESM + UMD con todo bundleado, Leaflet incluido, skill y `llms.txt`) para
consumo sin npm/CDN. El código fuente vive bajo [`src/`](src/).

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
