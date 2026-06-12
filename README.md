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

## Licencia

MIT © Benjamin Parra
