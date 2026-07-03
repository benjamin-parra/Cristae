# Changelog

Todas las versiones notables de Cristae se documentan en este archivo. El formato sigue
[Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y el versionado [SemVer](https://semver.org/lang/es/).

## [Sin publicar]

### Añadido
- **Eventos de la sesión de expansión de cluster (`cluster:expand` / `cluster:update` / `cluster:dismiss`).**
  `<cristae-cluster>` publica su estado de spiderfy por el **bus del motor** (`map.on('cluster:expand', cb)
  → off`), con el mismo estilo delta que `hover:start`/`hover:end` (no un `CustomEvent` bespoke del
  elemento). `expand` = se abrió una burbuja base (nueva sesión); `update` = la sesión activa cambió (se
  drilleó/cerró una **subburbuja** — antes esto NO emitía nada — o la membresía creció/encogió por poda);
  `dismiss` = cerró (colapso/zoom/`enabled=false`) o el ancla desapareció. El payload es un POJO agrupado y
  heterogéneo-safe: `{ id, center, count, entities:[{layerId,id,item}], groups:[{id,count,expanded,entities}] }`
  — `entities` plano para "buscar todo", `groups` = subburbujas con la drilleada marcada (`expanded`), `[]`
  si el base es plano (≤ `splitThreshold`). La membresía es el **snapshot congelado** de la sesión (sólo
  re-emite en cambios estructurales, nunca por un `move`), pensado para alimentar un panel/tabla en vivo
  desde la misma Source. Lectura imperativa: getter `cluster.session`. Arquitectura: `Cluster.sessionStructure`
  + `#partitionGroups` (partición lógica separada del render); `MapEngine.apply()` es el emisor ÚNICO
  (compara sesión previa↔nueva por id + firma) → cubre toda causa de cierre y elimina la asimetría en que
  el click de subburbuja no emitía. Reemplaza los `cristae:cluster-expand`/`cristae:cluster-collapse`
  previos (sin consumidores).

- **Keep-in-view opt-in `fit` en `<cristae-popup>`** (`fit="flip shift clip"`, `fit-padding`,
  `data-side`): la tarjeta se mantiene a la vista **moviéndose ella** (no la cámara) — clave cuando
  la capa vive en un `<cristae-cluster>`, donde el auto-pan recolapsaría el spiderfy. Los tokens
  activan etapas de un pipeline fijo lado→corrimiento→recorte (su **orden es irrelevante**): `flip`
  elige encima/debajo según dónde entre la caja (más espacio como desempate), `shift` desliza lo
  mínimo, y `clip` recorta contra el borde **real** del mapa (`fit-padding` sólo anticipa
  flip/shift, nunca corre el corte). La geometría es pura y sin DOM (`popupPlacement.js`, con test
  propio en `test/popup-placement.test.mjs`); la caja se computa entera por frame desde (ancla
  proyectada, tamaño, viewport − insets) y se escribe literal — sin transform ni estado entre
  frames. `fit`/`fit-padding` se normalizan en el punto de uso, así funcionan igual por atributo o
  por propiedad (frameworks que asignan propiedades no pasan por el converter, p. ej. React 19);
  atributo removido o vacío ⇒ vuelve al camino legacy. **Sin `fit`, nada cambia.**

### Corregido
- **`viewport-insets` reactivo en runtime.** El atributo de `<cristae-map>` sólo se aplicaba al
  crear el motor; cambiarlo después (abrir/cerrar un panel interno del consumidor) no actualizaba
  la región visible. Ahora re-aplica `camera.insets` y emite `viewportchange` — los overlays
  anclados (popup, botón central del cluster) se re-encuadran al instante. El botón central,
  además, ahora respeta los insets (se oculta bajo la franja ocluida), igual que el recorte del
  popup.

- **Medida de la tarjeta desactualizada si el contenido cambia tras `open`.** La medida única de
  `open` quedaba vieja cuando el contenido crecía después (datos async, imágenes) y el recorte
  operaba sobre una caja distinta a la pintada. Un ResizeObserver re-mide y re-encuadra al cambiar
  el tamaño — event-driven, el reposicionamiento por frame sigue sin forzar reflow.

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
