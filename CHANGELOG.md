# Changelog

Todas las versiones notables de Cristae se documentan en este archivo. El formato sigue
[Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y el versionado [SemVer](https://semver.org/lang/es/).

## [Sin publicar]

### Corregido
- **Cursor `pointer` para capas clickeables sin handler de hover.** El "cursor automático" que
  promete SPECS §eventos ("si el set de hits incluye una capa `interactive`, el motor pone
  `cursor:pointer`") solo se aplicaba cuando había demanda del canal **hover**: una capa
  interactiva con únicamente un listener de `cristae:click` (caso típico: abrir un popup al
  clickear) nunca mostraba el puntero al pasar por encima de sus puntos GPU — quedaba el cursor de
  arrastre del mapa. Ahora el cursor es una affordance de la **interactividad**, desacoplado de la
  entrega de eventos de hover: la sesión de picking corre bajo demanda de **click u hover**
  (`PICK_CHANNELS`) y marca el puntero sobre cualquier feature interactiva, mientras que los
  eventos `cristae:hover` se siguen emitiendo solo bajo demanda de hover. Alinea la implementación
  con la spec y con la convención de Leaflet (`.leaflet-interactive { cursor: pointer }`).
  Arquitectura: `events.js` expone `PICK_CHANNELS`; `LayerRegistry.hasHitForChannels()` responde la
  consulta del cursor por máscara de canal; `Interaction` separa `#hoverDemand` (eventos) de
  `#pickDemand` (picking/cursor) y restaura el cursor al cerrar la sesión. Coste: un mapa solo-click
  ahora paga el picking de hover (throttled por `hover-throttle`) para el cursor.

## [0.1.0] - 2026-06-12

Primera versión pública (rebrand de Fastlet2).

### Añadido
- Tres entry points desacoplados: `core` (núcleo de datos reactivo, sin DOM), `table` (tabla
  virtual, sin Leaflet) y `map` (mapa WebGL sobre Leaflet/glify). `table` y `map` nunca se
  importan entre sí.
- Web components `<cristae-*>` (Lit), motor headless `MapEngine`, y los factories
  `createSource` / `defineSource` del núcleo.
- Build self-contained (`node build.mjs` → `dist/cristae`, ESM + UMD) para uso sin bundler.
- Animación de zoom **desactivada por defecto** (`zoom-animation="none"`); `zoom-animation="in-only"`
  la reactiva (zoom-in animado, zoom-out instantáneo).

### Portabilidad
- Eliminado el global `__DEBUG__` (las validaciones de contrato quedan siempre activas; corren
  una sola vez en setup, fuera del hot path).
- CSS base de Leaflet vendorizado como string JS (sin la query `?inline` de Vite), inyectado en
  el shadow DOM de `<cristae-map>` → portable entre bundlers (Vite, webpack, esbuild, rollup).
