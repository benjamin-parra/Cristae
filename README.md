# Cristae

Web components de alto rendimiento para **datos en tiempo real**: una tabla virtual y un mapa WebGL
(Leaflet + glify con shaders reescritos) sobre un **núcleo de datos reactivo** compartido. Miles de
updates/seg con hot-path *zero-alloc*. Piel declarativa `<cristae-*>` + motor headless `MapEngine`.

> El nombre viene de las *cristae* mitocondriales —los pliegues de la membrana interna donde se
> produce la energía—: una membrana (envoltura declarativa sobre Leaflet/glify) que además es el
> sitio de potencia.

## Instalación (vía GitHub)

```bash
npm install github:benjamin-parra/Cristae   # o: git+https://github.com/benjamin-parra/Cristae.git#v0.1.0
```

`leaflet` y `lit` son **peerDependencies** (los provee el consumidor; Leaflet debe ser una sola
instancia). `leaflet.glify` y `supercluster` viajan como dependencias normales.

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

| Specifier        | Trae                                   | Registra            |
|------------------|----------------------------------------|---------------------|
| `cristae/map`    | mapa + núcleo (Leaflet/glify/lit)      | `<cristae-*>` mapa  |
| `cristae/table`  | tabla virtual + núcleo (solo `lit`)    | `<cristae-table>`   |
| `cristae/core`   | solo el núcleo de datos (sin DOM)      | —                   |

`table` y `map` nunca se importan entre sí: una tabla no baja Leaflet.

## Documentación

- [`SKILL.md`](SKILL.md) — guía práctica (instalación, API mínima, gotchas).
- [`MODELO.md`](MODELO.md) — arquitectura y decisiones de diseño.
- [`SPECS.md`](SPECS.md) — contrato formal e invariantes.
- [`docs/`](docs/) — una página por API pública.

## Build de la librería self-contained

`node build.mjs` produce `dist/cristae/` (ESM + UMD con todo bundleado, skill y `llms.txt`) para
consumo sin npm/CDN. El código fuente vive bajo [`src/`](src/).

## Limitaciones conocidas

- **Movimiento forzado de cámara CON animación es inestable sobre la capa GL.** Mover el viewport por
  código con animación —`camera.flyTo`, `camera.panTo` (paneo animado de Leaflet) o un zoom-in/zoom-out
  animado— deja los puntos WebGL de glify **congelados durante el gesto**: la capa GL no se reproyecta
  mientras dura la transición y recién salta a su lugar al cerrar el movimiento (`moveend`). Se percibe
  como un arrastre lento con los marcadores desfasados del mapa base. **Recomendación:** mover la cámara
  por código de forma **instantánea** — `camera.setView(...)` (paneo/zoom directo) — y dejar el modo de
  zoom en su default `'none'`. El `followPoint` ya re-centra sin animación internamente.
  **No afecta** a los gestos del usuario: arrastrar el mapa y la inercia del arrastre se reproyectan bien;
  el problema es puntual del movimiento programático con animación.

## Licencia

MIT © Benjamin Parra
