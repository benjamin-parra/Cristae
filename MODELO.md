# MODELO — Cristae + `<cristae-map>`

> Documento de **modelo/diseño** (no implementación). Define:
> 1. El web component **`<cristae-map>`** (Lit) y su motor headless.
> 2. El refactor interno **Cristae → Cristae**: terminología portable, sin dominio, y los cambios **estructurales** (no algorítmicos — el render está ultra-optimizado y no se toca) que el wrapper necesita.
>
> Regla rectora: **la librería no sabe qué es un vehículo, una geocerca, una conexión ni una etapa.** Solo conoce *puntos, polígonos, etiquetas, clusters, cámara, tiles, iconos y eventos*. Todo lo de dominio se compone encima, como código del consumidor o un *recipe* externo.

---

## 0. Alcance y no-objetivos

**Dentro de Cristae (genérico):** render GL de puntos/marcadores, polígonos, etiquetas (canvas), clustering, atlas de iconos evolutivo, store reactivo + emitter, picking/hit-testing, eventos de puntero, cámara, tiles, lifecycle de widget, plugins (visibilidad/resize).

**Dentro de `<cristae-map>` (Lit):** piel declarativa (props/atributos → motor), eventos del motor → `CustomEvent`, métodos imperativos, Shadow DOM para la superficie de render, slots para UI del host, capas como elementos hijos en light DOM.

**Fuera (adaptador del consumidor / recipe, NO en la librería):** adquisición de datos (REST/WS/polling/dedupe), normalización de dominio (`Vehicle`, `Itinerary`, `connectionState`, etapas, puntualidad), máquina de estados de contexto (empresa/org), reglas de negocio (visibilidad GPS, tracking corrupto, latencia, emparejado tile↔tema), y la UI (sidebar/paneles/tooltip).

---

## 1. Principios de diseño

1. **Sin dominio en el core.** Nada de `vehicle`, `geofence`, `place`, `connection`, `etapa` en nombres públicos ni internos de Cristae. → §4.
2. **Composición, no especialización.** Una etiqueta es un *attachment/capa* con `textOf`, no un método `place-labels`. Un "overlay" es otra point-layer sobre el mismo `Source`. El "follow highlight" es una point-layer transitoria. → §6.
3. **Data-driven.** El componente recibe datos; no los busca. Un único contrato `Source` con azúcares (handle, prop). → §5.
4. **Reactividad de datos = decisión patch/rebuild encapsulada.** El consumidor declara `idOf`/`versionOf`; el motor decide redibujar vs reconstruir. → §5.3.
5. **Atlas evolutivo.** El atlas se reusa y **se le agregan** variantes (append por celda libre); nunca se reconstruye desde cero ni recompila el shader; nunca produce marcadores invisibles. → §7.
6. **Cambios estructurales, no algorítmicos.** El render (setData, draw, picking, supercluster) está ultra-optimizado y se conserva. Lo que cambia es terminología, fronteras de módulo, superficie de API y el esquema del atlas/encoding. → §13.
7. **Shadow para funcionamiento, light DOM + slots para lo explícito.** → §11.
8. **Portabilidad real.** Sirve igual para personas, sensores, drones, activos. El dominio vive en *recipes*. → §14.

---

## 2. Arquitectura en 3 capas

```
┌─ Capa 3 · Adaptadores / Recipes (fuera de la librería) ───────────────┐
│  WingLogistics: data-source (REST/WS/dedupe) + fleet-recipe            │
│  (Vehicle/connection/etapa/itinerario → accessors, variantOf, filtros, │
│  iconSets, choreografía follow/spotlight). UI React consume eventos.   │
└────────────────────────────────────────────────────────────────────────┘
        ▲ props/métodos                       │ CustomEvents
┌─ Capa 2 · <cristae-map> (Lit) ────────────────────────────────────────┐
│  Atributos/props reactivas → setters del motor. Eventos motor →        │
│  CustomEvent. Capas como hijos (<cristae-point-layer> …). Shadow DOM   │
│  para el render; <slot> para UI. ResizeObserver, lifecycle.            │
└────────────────────────────────────────────────────────────────────────┘
        ▲ API JS pura (framework-agnostic)
┌─ Capa 1 · MapEngine (núcleo headless de Cristae) ────────────────────┐
│  Posee map + MapWidget + layers + stores + atlas + picking + camera.   │
│  Cero Lit, cero React, cero dominio. Testeable sin DOM.                │
└────────────────────────────────────────────────────────────────────────┘
```

`<cristae-map>` es una piel fina (~200 LOC) sobre `MapEngine`. El motor puede usarse desde cualquier framework o vanilla. Es la decisión "estricta": la lógica pesada no vive en un `LitElement`.

---

## 3. Estructura de carpetas y docs de Cristae

```
shared/external/Cristae/          # raiz del paquete (se sirve por GitHub: git install)
├─ MODELO.md                     # este documento (fuente de verdad del diseño)
├─ SKILL.md                      # guía práctica de uso
├─ SPECS.md                      # contrato formal e invariantes
├─ package.json                  # name/exports (core·table·map → src/), peerDeps/deps
├─ build.mjs                     # build de la lib self-contained (→ dist/cristae)
├─ docs/                         # una página por API pública (atlas, data, render, …)
└─ src/                          # ── TODO el código fuente ──
   ├─ index.js                   # export público del mapa (registra <cristae-*>)
   ├─ element/                   # piel Lit (web components)
   │  ├─ base.js                 # CristaeLayerElement (montaje top-down, light DOM)
   │  ├─ CristaeMap.js           # <cristae-map>
   │  ├─ CristaePointLayer.js    # <cristae-point-layer>
   │  ├─ CristaePolygonLayer.js  # <cristae-polygon-layer>
   │  ├─ CristaeLabelLayer.js    # <cristae-label-layer>
   │  ├─ CristaeCluster.js       # <cristae-cluster>
   │  ├─ CristaeToolbar.js       # <cristae-toolbar>
   │  └─ CristaePopup.js         # <cristae-popup>
   ├─ engine/                    # motor headless (framework-agnostic)
   │  ├─ MapEngine.js            # orquestador
   │  ├─ Camera.js               # setView/panTo/fitBounds/flyTo/followPoint
   │  └─ Interaction.js          # hover/click/pointermove → eventos genéricos
   ├─ render/                    # render GL (sin cambios algorítmicos)
   │  ├─ PointLayer.js           # ex GlifyLayer
   │  ├─ Picking.js              # ex GlifyPicking (picking en GPU)
   │  ├─ LabelLayer.js           # sprites de etiqueta genéricos
   │  ├─ project.js              # proyección (coincide con los shaders)
   │  └─ shaders.js              # GLSL (atlas, rotación)
   ├─ atlas/                     # atlas de iconos
   │  ├─ Atlas.js                # atlas evolutivo (append por celda, dims uniform)
   │  ├─ GpuAtlasBinding.js      # textura + cursor por contexto GL
   │  └─ IconSet.js              # ex IconBuilder (variante → canvas), sin dominio
   ├─ cluster/                   # Cluster.js (supercluster worldwide)
   ├─ events/                    # EventBus.js + events.js (máscaras de canal)
   ├─ interaction/               # LayerRegistry.js + HitResolver.js
   ├─ geometry/                  # polygon.js (point-in-poly + índice espacial)
   ├─ tiles/                     # provider + ZoomSnapshotStore + presets
   ├─ data/                      # ── NÚCLEO compartido (no depende de nada) ──
   │  ├─ Store.js  Emitter.js    # store reactivo + emisor coalescido
   │  ├─ Source.js               # contrato Source + defineSource / createSource
   │  ├─ filters.js  safe.js     # filtros/listeners + helpers de error 0-alloc
   │  └─ index.js                # entry cristae/core
   └─ table/                     # ── TABLA (solo data/ + lit; sin Leaflet/glify) ──
      ├─ PagedTable.js           # engine headless: scroll virtual + pool + quickselect
      ├─ CristaeTable.js         # <cristae-table> (LitElement, light DOM)
      ├─ QuickSelect.js          # Floyd-Rivest qselect O(n)
      ├─ pagination.js           # paginationModel (función pura, elipsis)
      └─ index.js                # entry cristae/table (registra <cristae-table>)
```

`docs/` se reescribe con la terminología portable (§4) y ejemplos no-dominio (sensores/personas), más una página `recipes` que muestra cómo reconstruir el caso flota.

### 3.1 Frontera de capas y empaquetado (decisión cerrada)

El grafo de dependencias es un DAG con `data/` como núcleo y dos consumidores que **nunca se
importan entre sí**:

```
        data/   ← contrato Source, Store, Emitter, filters. Depende de NADA.
       ╱     ╲
   table/     engine/+element(mapa)/
  (lit)       (Leaflet/glify)
```

**Invariante:** `table/` importa **solo** de `data/` (y `lit`). Nunca `engine/`, `render/`,
Leaflet ni glify (verificable por grep; `src/table/PagedTable.js` ni siquiera importa `data/` en
runtime — duck-typea el `Source`). Esto permite el entry point `src/table/index.js`, que un consumidor
solo-tabla importa sin arrastrar el motor de mapa.

**Empaquetado a npm — un repo ahora, split al publicar.** El único beneficio de 3 paquetes
(`cristae/core` = `data/`, `cristae/table` = `table/`, `cristae/map` = `engine/`+`element/`) es
peso de instalación: una tabla no debe bajarse Leaflet+glify. Eso se consigue **hoy** con entry
points + `exports` map + `sideEffects:false` (tree-shake), sin versionar 3 paquetes. La frontera de
capas —ya enforzada— vuelve el split futuro un cambio de empaquetado, no un reescrito: cada
directorio pasa a ser el `main` de su paquete tal cual. El mismo `createSource` alimenta una capa de
puntos y una `<cristae-table>` → **un dataset filtrado, computado una vez, varias vistas** (mata el
"filtrar dos veces" de tener N vistas con filtro propio).

**Realizado (Opción A, in-repo).** Tres entry points + alias Vite, sin colisión con el `@cristae`
legacy (Rollup matchea `^@cristae(/|$)`, no captura `@cristae`):

| Specifier | Entry | Arrastra | Registra |
|---|---|---|---|
| `cristae/core` | `src/data/index.js` | nada (sin DOM/Lit/Leaflet) | — |
| `cristae/table` | `src/table/index.js` | `lit` (+ re-export del núcleo) | `<cristae-table>` |
| `cristae/map` | `index.js` | `leaflet`/`glify`/`lit` (+ re-export del núcleo) | `<cristae-*>` de mapa |

La garantía "una tabla no baja Leaflet" la da el **grafo de imports disjunto** (`table/` no importa
`engine/`/`render/`), no el `sideEffects`. `map` y `table` re-exportan la superficie del núcleo por
conveniencia (mismo módulo, una sola fuente de verdad en `data/`). El `package.json` declara el
`exports` map (dormido in-repo, los alias resuelven a archivo).

**Deltas para el publish a npm (Opción B):** (1) `sideEffects: false` por paquete con manejo
explícito de los módulos con efecto (registro de custom elements, `window.L` en `CristaeMap`);
(2) resolver `__DEBUG__` —global inyectado por Vite hoy— vía guard o reemplazo en el build del
paquete (sin esto, los artefactos publicados rompen); (3) `lit`/`leaflet`/`glify` como deps/peers.

> **VisibilityGuard.** El plugin que pausaba el render fuera de pantalla (monkey-patch de
> `rebuild`/`patch`) se **internalizó** en `PagedTable` como un flag + `IntersectionObserver`
> nativo: misma optimización, sin parcheo de métodos.

---

## 4. Terminología portable (renombrado Cristae → Cristae)

**Núcleo (renombrar / des-especializar):**

| Cristae (hoy) | Cristae | Motivo |
|---|---|---|
| `GlifyLayer` | `PointLayer` | el render real es de puntos; "glify" es detalle de impl. |
| `GlifyPicking` | `Picking` | idem |
| `MapEventBus` / `MapLayerRegistry` | `EventBus` / `LayerRegistry` | concisión |
| `IconBuilder` | `IconSet` | "set de variantes → canvas", no "builder" |
| `ComposableStore` | `Store` | |
| `IntervalEmitter` | `Emitter` | |
| `ClusterLayer`/`Clustering` | `Cluster` | unificar |
| `ConstantLabelLayer`/`CanvasPaneLayer` | `LabelLayer` | una sola primitiva de etiqueta |
| `vehiclesPane`, `placeMarkersPane`… | panes con nombre por capa (`<layerId>Pane`) | sin dominio |
| `connectionState`, `Vehicle`, `Itinerary`, `geofences.js` | **fuera del core** → `recipes/fleet` | dominio |

**Contrato de hit/evento:** `kind: 'glify'|'leaflet'` → **`kind: 'point'|'polygon'`** (tipo de capa, no backend de render).

**Lo que sale del core a `recipes/` (paquete aparte, opcional):**
`Vehicle`, `Itinerary`, `connection.js` (thresholds), helpers `geofences.js` (point-in-poly/index) → estos últimos pueden quedar como `geometry/` genérico (no son dominio: son geometría), pero `connection`/`Vehicle`/`Itinerary` son dominio puro y van a `recipes/fleet`.

> `geometry/` (point-in-poly, índice espacial, `pointInPoly/prepareIndex/idsFor`) **sí** es genérico y se queda en el core: lo usa el polygon-layer para hit-testing. Solo se renombra sin sufijo de dominio.

---

## 5. Datos: contrato `Source` + handle + prop

### 5.1 Contrato núcleo `Source`
Lo único que el motor necesita de una capa de datos (generaliza `Store`+`Emitter`):

```js
interface Source<Item> {
  // Identidad y geometría — accessors puros, sin dominio
  accessors: {
    idOf(item): string | number
    positionOf(item): { lat, lng }
    headingOf?(item): number          // ausente → la capa no rota
    sizeOf?(item): number             // px en pantalla
    variantOf?(item): string          // clave de icono en el IconSet
    textOf?(item): string             // para label-layer
  }
  variants?: string[]                 // espacio declarado para preseed del atlas (§7)
  getSnapshot(): Item[]               // estado actual (ref estable entre flushes)
  version(): number                   // dirty-check (== Store.dataVersion)
  subscribe(cb: () => void): () => void
  dirtyIds?(): Set<id> | null         // presente → patch parcial; ausente → diff por versionOf
}
```

Esto **es** el patrón `Store`+`Emitter` ya existente, generalizado. El motor: preseed desde `variants`, mantiene su render-store version-trackeado por capa, y aplica la decisión patch/rebuild (§5.3). Nunca expone `rebuild()` ni el atlas al consumidor.

### 5.2 Tres ergonomías apiladas (una sola lógica interna)

```
Source (contrato núcleo)                         ← B: layer.source = defineSource({...})  (reactividad ajena)
  ▲
  └ createSource(accessors, variants) → Source     ← C: const s = createSource({...}); layer.source = s; s.set/move/…
        ▲                                              (UN objeto: lectura = contrato, escritura = dueño)
        └ <cristae-point-layer .data .accessors>   ← A: azúcar declarativa (el elemento posee la Source)
```

- **B (attach):** el consumidor con store propio (WingLogistics) envuelve su `Store`/`Emitter` como `Source` → coste casi nulo, reaprovecha todo el version-tracking y filtros existentes.
- **C (handle):** proyecto sin store propio → `handle.set(items)`, `handle.patch(items, dirtyIds)`, `handle.move(id, lat, lng)`, `handle.remove(id)`. El motor crea el store internamente.
- **A (prop):** elemento hijo declarativo; `.data` llama `handle.set()`; `variants`/`iconSet` configuran preseed.

### 5.3 Política patch vs rebuild (generalizada, idéntica a la actual)
- **`set(items)`** → `store.update` → diff de set de IDs. Si **cambió el set** ó hay **cambio de filtro pendiente** ó **clusters cambiaron** → `rebuild` (deferido a rAF). Si solo cambiaron posiciones/variantes detectables por `versionOf` → `patch`.
- **`patch(items, dirtyIds)`** → `store.patch`. Cambio de membresía de filtro → `rebuild`; si no → `patch`.
- **`move(id, lat, lng)`** → mueve posición/label **sin rebuild**: escribe el slot del vértice (`id→slot`) en el buffer interleaved de glify vía `bufferSubData` (§17.5). O(1), [0-alloc] en WebGL2. **No** pasa por `setData`/`resetVertices`.
- **`refresh()`** (de **capa**, genérico) → re-evalúa `variantOf`/`versionOf` y redibuja (generaliza el "recompute por antigüedad": el consumidor lo llama en su timer; el motor no conoce "latencia"). Es re-evaluar el estado computado de **una capa** — distinto del `map.invalidateSize()` de Leaflet (dimensiones del contenedor tras resize, que el motor ya llama internamente en el `ResizeObserver`, §11). Se llama `refresh` (no `invalidate`) para no chocar con ese término de Leaflet.
- **Cambio de `iconSet`** (set inicial, swap en caliente, o resolución tardía de `icon-set="…"`) → **rebuild reactivo con reseed automático** (deferido a rAF, coalescido con cualquier `set`/`accessors`/`preloadIcons` del mismo tick). El motor reacciona al **valor**, no al momento ni al loader → §7.2.
- Hook de escape: `shouldRebuild?(prev, next)` override opcional.
- **Filtros:** en B viven en el store del consumidor (snapshot ya filtrado → el componente no necesita API de filtros). En C/A son **la misma cosa en dos capas** (no una elección): la prop `.filters = [{id, predicate, deps?, rebuild?}]` es el azúcar declarativo (A) sobre los imperativos `layer.addFilter(id, predicate)` / `removeFilter(id)` (C). **Nunca como atributo HTML** (son funciones).
  - **Reconciliación por `deps`, no solo por `id`** (semántica del array de dependencias de React). Empareja por `id`; si `deps` **cambió** (shallow-compare) → reemplaza el predicado y re-evalúa (rebuild si `rebuild:true` o si cambia membresía); si `deps` **igual** → conserva el predicado viejo y **no** re-evalúa (cero trabajo); si `deps` **ausente** → cae a comparar identidad de `predicate`. Esto es obligatorio: el caso real recompila el predicado bajo el **mismo `id`** cuando cambia un *modo* (`applyGpsVisibilityFilter(mode) → #applyStoreFilter(MAP_FILTER_IDS.offline, …, buildGpsVisibilityPredicate(mode))`, `ConfiguracionMapa.js:1185-1192`). Reconciliar solo por `id` dejaría el predicado del modo anterior activo. El `mode` **es** la dep: `{ id:'gps', predicate: buildGpsVisibilityPredicate(mode), deps:[mode], rebuild:true }`. Bonus: predicados recreados inline en cada render de React no disparan rebuild si las `deps` no cambian (evita rebuilds espurios sin pedir memoización manual).

### 5.4 Reactividad declarativa uniforme (ley, no caso por caso)
Toda **entrada declarativa** del componente —atributo o propiedad— es **reactiva y orden-independiente** por diseño: el motor reacciona al **valor**, no al instante en que llega ni al loader, y coalesce el efecto a rAF. El consumidor nunca orquesta orden ni llama un método imperativo equivalente. Las referencias **por nombre** resuelven cuando aparece el referente (montado tarde, reemplazado), igual que el cursor del `GpuAtlasBinding` (§7.2). La regla del `iconSet` (§7.2/§11) es **una instancia** de esta ley; se aplica idéntica a:

| Entrada | Reactiva a | Efecto automático |
|---|---|---|
| `iconSet` (prop) / `icon-set` (nombre) | (re)asignar / resolver pack | reseed + rebuild (§7.2); por nombre, default hasta resolver |
| `accessors` (prop) | reemplazar el objeto o un accessor (`variantOf`/`sizeOf`/`headingOf`/`textOf`) | re-deriva + rebuild. *(Distinto de `refresh()`, que re-evalúa los **mismos** accessors cuando su salida varía en el tiempo — recolor por antigüedad.)* |
| `filters` (prop) | reasignar el array | reconciliación **por `deps`** (diff add/remove/replace contra los activos; mismo `id` + `deps` distinto = replace) + rebuild — sin diffear a mano (§5.3) |
| `data` (prop) | nuevo snapshot | `set` → patch/rebuild (§5.3); ya reactivo |
| `<cristae-cluster>` `radius`/`max-zoom`/`min-points`/`icon-set` | cambiar el atributo/prop | reconfig en runtime (§13.3), sin recrear la capa |
| `bind-to` (label attachment, por nombre) | la capa host aparece / se reemplaza | (re)vincula posiciones+`textOf` cuando el host existe; orden-independiente |
| `initial-center`/`initial-zoom` (mapa) | — (solo al montar) | **NO reactivas**: fijan la vista inicial *una vez* (como `defaultValue` de un `<input>`). Todo movimiento vivo es **acción** (§9), nunca prop → ver nota al pie sobre por qué el recentrado no es estado |
| `visible`/`opacity`/`interactive`/`tile`/`theme`/`viewport-insets` | cambiar el atributo | aplica al motor en el siguiente frame |

**Principio rector:** **estado → atributo/prop reactiva; acción → método imperativo.** Los métodos (`set/patch/move`, cámara `flyTo/fitToLayer/followPoint`, `preloadIcons`, `refresh`) **conviven** como ruta de *acción puntual en el tiempo* (un push, un vuelo de cámara, un warm explícito), nunca como la forma de declarar *estado*. Un agente que implemente una entrada nueva decide su naturaleza con esa única pregunta — no hay bordes de orden que parchear caso a caso.

> **Por qué el centro/zoom NO es prop reactiva (decisión cerrada).** Un `center` controlado-una-vía es un híbrido tramposo: la prop guarda X, el gesto del usuario mueve el mapa a Y sin reescribir la prop, y por idempotencia (§11.1) reasignar X es no-op → **"volver a X" no funciona** declarativamente. El recentrado vivo —seguir un elemento, ir a un resultado de búsqueda, encuadrar— **es acción, no estado** (ocurre en un instante; no describe "cómo debe verse el mapa" de forma estable). Por eso `center`/`zoom` son `initial-center`/`initial-zoom` (uncontrolled, solo al montar) y **todo** movimiento posterior va por la API de cámara imperativa (§9). El caso real lo confirma: en `mapa_geotactico` el follow es `FollowManager.onVehicleUpdate → panToSmooth` (imperativo por update WS), no una prop de centro. *(Si algún consumidor necesitara dirigir la vista desde estado externo —sync con URL—, se agrega un modo **controlado-con-echo** explícito: el gesto emite `viewportchange` y el consumidor reescribe la prop; nunca el híbrido sin echo. No es objetivo inicial.)*

---

## 6. Primitivas de capa (cero capas de dominio)

| Primitiva | Es | Config genérica |
|---|---|---|
| **point-layer** | puntos GL (rota si hay `headingOf`) | `idOf, positionOf, headingOf?, sizeOf?, variantOf?`; `visible, opacity, interactive, pane` |
| **polygon-layer** | zonas (Leaflet polygons) | `idOf, ringsOf, styleOf?, hoverStyleOf?`; `visible, opacity, interactive` |
| **label-layer** | etiquetas canvas — **standalone o attachment** | `textOf, colorOf?, offset, font, visible`; `source` propio **o** `bindTo: <layerId>` |
| **cluster** | *attachment* sobre point-layer | `{ radius, maxZoom, minPoints, iconSet }` |

**label-layer como capa sola:** tiene su propio `Source` (posiciones + `textOf`) y se monta como cualquier capa. Como *attachment*, `bindTo:'fleet'` deriva posiciones del `Source` de la capa host y usa su `textOf`. Mismo objeto, dos modos:

```html
<!-- attachment: etiquetas siguen a la capa 'fleet' -->
<cristae-point-layer id="fleet">
  <cristae-label-layer bind-to="fleet"></cristae-label-layer>
  <cristae-cluster radius="88" max-zoom="18" min-points="2"></cristae-cluster>
</cristae-point-layer>

<!-- standalone: etiquetas con su propia fuente de datos -->
<cristae-label-layer id="labels"></cristae-label-layer>
```
(`.accessors`, `.iconSet`, `.data`, `.filters` se asignan como **propiedades JS** en cada hijo; los atributos son solo lo serializable: `id`, `radius`, `pane`, `visible`, etc.)

**Orden de apilado (declarativo, reemplaza los z-index de panes):** el orden de los hijos en el light DOM **es** el orden de render (atrás→adelante), como en SVG/HTML — una capa declarada después se dibuja encima. Atributo `z` opcional para forzar orden sin reordenar el markup. Esto reemplaza los ~12 panes con z-index numérico hardcodeado de hoy (`vehiclesPane 650`, `vehicleLabelsPane 665`, `placeMarkersPane 445`…): el motor deriva los panes de Leaflet del orden; **el consumidor nunca toca z-index**.

**Las 9 capas hardcoded de hoy → 0 en el core.** Se componen así (en un *recipe*, no en la librería):

| Hoy (hardcoded) | Composición genérica |
|---|---|
| vehicles | point-layer (`variantOf`=estado del consumidor) + cluster |
| vehicle-overlays | **otra** point-layer sobre el mismo `Source`, sin `headingOf`, su `variantOf`/`iconSet` |
| follow-highlight (+overlay) | point-layer transitoria ligada a un `Source` de 1 ítem, `sizeOf` mayor |
| itinerary-focus (veh+place) | composición: `camera.fitBounds` + `visible/opacity` por capa + capa de realce |
| place-markers / search | marker = point-layer sin rotación |
| geocercas | polygon-layer (+ label-layer attachment) |

---

## 7. Iconos y **Atlas evolutivo** (respuesta a "reusar + agregar")

### 7.1 Cómo funciona hoy (verificado en `IconBuilder.js`)
- `resolve(item)` → `from(item)` produce un canvas; si es nuevo, `#tiles.push`, `#dirty=true`.
- `encodeColor`: **`r = tileIdx / (tiles.length-1)`** → índice **normalizado por el conteo**.
- `#packAtlas()`: `cols=ceil(√n)`, `rows=ceil(n/cols)`, **redibuja TODOS** los tiles en un canvas nuevo.
- shaders (`fragmentShader`/`pickingShader`): **hornean `n`, `cols`, `rows`, `tileSize` como literales GLSL**; el programa se compila **una sola vez** al crear la capa.
- `buildAtlas`: `texImage2D` sube el atlas **completo**, y se invoca **una sola vez** al crear la capa.
- `#dirty` es un **booleano consume-once**: el primer getter que dispara `#packAtlas()` lo apaga; **no** modela "N contextos GL, cada uno sincronizado o no".
- A nivel capa (`GlifyLayer.#renderItems`, l. 212-215): una vez creada la capa solo corre `setData(points)` — **nunca** vuelve a llamar `buildAtlas` ni recompila shaders.

→ Consecuencia (peor de lo que parece): tras el primer bake, una variante nueva no solo deja **su** marcador invisible — como `r = idx/(n-1)` reescala el denominador mientras el shader mantiene `n` viejo, **los marcadores ya existentes se decodifican mal** (icono equivocado o desaparecen). Y con dos mapas, el `#dirty` consume-once hace que el 2º contexto crea "ya subí" y quede **en blanco**. Por eso hoy hacen falta parches: `ClusterIconBuilder.warmup()` pre-hornea ~278 buckets, `replaceLayer` reconstruye la capa entera, y `forceRebuildRef`.

### 7.2 Atlas2 — valor append-only + binding GPU por contexto (cambio **estructural**)

El problema no es "volver a subir": es que el `IconBuilder` mezcla **tres responsabilidades** en un objeto con flags mutables compartidos — rasterizar (CPU), componer/direccionar (CPU, función del set de tiles) y residencia GPU (por contexto). El fix correcto **no** es un contador de versión colgado del builder (frágil: canal lateral, consume-once, depende de "¿quién observó el flag?"). Es **separar el atlas-como-valor de su espejo en GPU**:

**A. `Atlas` — valor inmutable-por-generación, append-only (CPU, cero WebGL).**
- **Espacio de direccionamiento fijo por generación:** grilla dimensionada a una **capacidad** con headroom (no `ceil(√n)`, que reescala en cada alta). La celda `(col,row)` de cada tile **nunca se mueve** mientras viva la generación.
- **Índice de tile entero estable**, y el encoding normaliza por **capacidad fija**, no por `tiles.length` → el color de un punto ya emitido **no cambia de significado** al entrar variantes nuevas (hoy `r=idx/(n-1)` corrompe incluso los existentes, §7.1).
- **Crecer dentro de capacidad = append puro:** asignar la siguiente celda, registrar su bitmap. No invalida posiciones, colores ni shader.
- **Exceder capacidad = NO mutar:** se produce un **`Atlas` nuevo** (generación+1, otro objeto); el viejo se descarta. El regrow es el único repack.
- El atlas **no conoce WebGL** → testeable como dato puro; **compartible entre mapas** (rasterización + direccionamiento únicos).

**B. `GpuAtlasBinding` — recurso por contexto GL, propiedad de la capa.**
Posee **una** `WebGLTexture` para **un** `gl`, con un cursor. Antes de dibujar, la capa llama `binding.sync(atlas)`:
```
sync(atlas):
  if (this.atlas !== atlas)                    // regrow → atlas nuevo (identidad de objeto)
      realloc textura a capacidad; texImage2D completo; this.atlas = atlas; this.uploaded = atlas.count
  else while (this.uploaded < atlas.count)     // append → cursor sobre log append-only
      texSubImage2D(atlas.cellOf(this.uploaded), atlas.tileAt(this.uploaded)); this.uploaded++
```
- **Sin flag mutable compartido.** Las dos señales son intrínsecas y describen estado real en ambos lados: crecer = `uploaded < atlas.count`; regrow = `this.atlas !== atlas` (identidad de referencia). Nada que "limpiar", ningún orden a respetar.
- **Monótono y orden-independiente:** un 2º/3er mapa montado tarde arranca en cursor 0 y converge solo; agregar N mapas no toca nada. → **multi-mapa gratis** — la raíz del 2º-mapa-en-blanco (el `#dirty` consume-once) desaparece por construcción.
- **Dims (`cols/rows/tileSize`) como uniforms**, seteados por el binding una vez por generación → el shader **nunca recompila** (el regrow tampoco: solo cambian uniforms + textura). El programa de **picking** comparte el mismo `Atlas` vía su propio binding → deja de quedar con la textura vieja colgada (hoy `GlifyPicking` captura el handle una sola vez en `attach`, l. 38/256).

Es el patrón de los atlas de glyphs en renderers de texto / streaming buffers: **log append-only inmutable + cursor por consumidor**. El builder solo rasteriza; el `Atlas` solo direcciona; el `GpuAtlasBinding` es la única pieza GL-aware y es diminuta.

**Política (auto, sin fallar). El `iconSet` es una entrada reactiva de la capa:** asignarlo o reemplazarlo **en cualquier momento, por cualquier loader** (en el HTML, por `<script src type=module>`, por `import()` dinámico, o en caliente) reconstruye la capa con reseed automático. No hay momento ni loader privilegiado, y no hay nada que el consumidor deba orquestar.
- **(Re)asignar `iconSet`:** reseed automático del atlas desde el conjunto `variants` del pack **∪** las variantes presentes en los datos actuales (derivadas por `variantOf`) → `Atlas` nuevo (generación+1) que **cada** `GpuAtlasBinding` detecta por identidad (`this.atlas !== atlas`) y re-sube completo en su próximo `sync` (camino regrow, ya definido). Rebuild coalescido a rAF (§5.3). El swap **no** es caso especial ni corrupción: es el camino normal, idéntico para el pack que ya existía, el que llega tarde y el que se cambia en caliente.
- **Seeding manual (opcional):** `layer.preloadIcons(variants)` agrega variantes al conjunto de seed sin esperar a que aparezcan en los datos — p. ej. el pack nuevo en esa capa trae más estados de los que los datos actuales reflejan, o se anticipan variantes futuras. Idempotente; dispara el mismo reseed+rebuild.
- **Declarado:** `IconSet({ variants })` preseed-ea → atlas con capacidad+headroom y celdas ocupadas antes del primer render (ruta rápida, cero append en runtime).
- **No declarado (red de seguridad):** variante nueva → append por celda en el siguiente `sync` de **cada** binding; `console.warn` en debug. **Nunca** invisibles, **nunca** repack salvo agotar capacidad.
- **Regrow** (raro): nuevo `Atlas`; cada binding re-sube completo en su próximo `sync`, copiando el bitmap previo por `drawImage` (no redibujar canvases).
- **Hot-path cero-alloc (§17):** el atlas expone `tileChannel(index)` (canal r, `index/(C-1)`) y `cellOf` (que computa `col/row` como **enteros inline** `i%cols`, `(i/cols)|0`, sin objeto de coordenadas) — ambos O(1) [0-alloc], **sin concerns de picking/heading**. La composición del color por punto es **render-side**: `encodeColor` **muta-y-retorna un scratch compartido** (no `{r,g,b,a}` por punto — glify lo lee sincrónicamente en `resetVertices`) tomando r de `tileChannel`, g del `headingOf` y b,a del slot. `sync` en estado estable = 2 comparaciones.

> Dos propiedades que el diseño garantiza: **(1)** el atlas se **reusa y se le agregan** variantes (append por celda con `texSubImage2D`), nunca se reconstruye desde cero; **(2)** con **dos mapas no se rompe** — cada capa tiene su binding con cursor propio sobre el mismo `Atlas` compartido, y el `#dirty` global (booleano consume-once, raíz del 2º-mapa-en-blanco) desaparece, reemplazado por identidad intrínseca (cuenta + identidad de objeto).

### 7.3 IconSet — factory declarativa-imperativa (sin dominio)
```js
const fleetIcons = defineIconSet({
  rotates: true,
  variants: enumerateVariants(),          // espacio completo declarado → preseed
  sizes: { canvas: 160, default: 48 },
  // DECLARATIVO: variante → descriptor
  describe: (variant) => ({ shape:'arrow', fill: colorFor(variant), stroke:'#333', badge: badgeFor(variant) }),
  // IMPERATIVO: descriptor → canvas (renderers por forma)
  renderers: { arrow:(ctx,size,d)=>{…}, dot:(ctx,size,d)=>{…} },
  prerender: async () => {…},             // opcional (SVG/imágenes)
})
```
- `defineIconSet` resuelve preseed/atlas/encoding internamente.
- `variant` es **una string arbitraria** que el consumidor compone (estado de conexión, etapa, alerta de sensor, batería…). El core no la interpreta.
- `map.createIcon(descriptor)` para iconos sueltos (un marcador puntual) sin tocar el atlas de una capa.
- Cluster usa un `IconSet` keyed por *bucket de conteo* (genérico): `defineClusterIconSet({ buckets, draw })`.

**Pack de iconos de terceros = `IconSet` distribuible.** Un pack es un módulo JS que exporta `defineIconSet(...)`. Lleva funciones (`describe`/`renderers`/`prerender`) → no es un atributo HTML serializable; el dibujo de iconos es código, no marcado. Se enchufa en **dos capas apiladas, no una elección** (misma relación A↔C que datos y filtros, §5.2-5.3): la **imperativa** `layer.iconSet = pack` es la base; la **declarativa** `icon-set="flota"` en el markup es azúcar sobre `map.registerIconSet('flota', pack)`. El pack es **ciego al contexto GL** (solo rasteriza canvas) → multi-mapa-safe sin que el autor toque WebGL, y **reusable entre dominios** porque `variant` es una string que el core no interpreta (el mismo pack "flecha+badge" sirve para personas, sensores o flota). Contrato del autor: **exponer su espacio `variants`** para preseed (§7.2) cuando sea acotado → atlas con capacidad+headroom y cero regrow en runtime; si es abierto, la red de seguridad (append en `sync`) lo cubre. El **momento y el loader son indiferentes** (pack en el HTML desde el inicio, asignado por `<script src type=module>` al final, por `import()` dinámico, o reemplazado en caliente): `iconSet` es entrada reactiva → reseed automático + rebuild de la capa (§7.2/§5.3). Es por diseño, no por instruir al consumidor sobre cómo cargarlo.

---

## 8. Modelo de eventos (cuidado: genérico, sin dominio)

### 8.1 Contrato de hit
```js
Hit = {
  layerId: string,
  kind: 'point' | 'polygon',   // tipo de capa, NO backend de render
  ref: any,                    // el item del Source (o {ring,id} de polígono)
  id: string | number,
  distancePx: number,          // 0 para polígono
  zIndex: number,
  order: number,               // declaración (desempate)
}
// Hits ordenados top-first: zIndex desc, order asc, distancePx asc.
```

### 8.2 Eventos (en el elemento como `CustomEvent` y en el motor vía `engine.on`)

| Evento | `detail` | Cuándo |
|---|---|---|
| `cristae:ready` | `{}` | motor montado (tras primer render) |
| `cristae:pointermove` | `{ lat, lng, x, y }` | cada movimiento (throttled). **Barato**, para UI que sigue el cursor (tooltip). No requiere picking. |
| `cristae:hover` | `{ hits, added, removed, x, y }` | cuando **cambia el conjunto** de hits bajo el cursor. Trae deltas → el consumidor agrega nombres/ids sin ref-count manual. |
| `cristae:click` | `{ hits, lat, lng, x, y, originalEvent }` | click. `hits` vacío = click en vacío. **El consumidor decide** single vs múltiple (la desambiguación es de dominio, no del core). |
| `cristae:viewportchange` | `{ center, zoom, bounds }` | moveend/zoomend |
| `cristae:interactionstart` / `cristae:interactionend` | `{}` | pan/zoom inicio/fin (para que el consumidor frene su emitter si quiere; el motor ya coalesce su propio redraw). |

### 8.3 Decisiones de diseño de eventos
1. **`pointermove` separado de `hover`.** `pointermove` es continuo y barato (posición para tooltip). `hover` solo se emite cuando cambia el set de hits (tras el picking GPU async). Esto preserva el throttle (`hoverThrottle`) y la tolerancia a stale (`staleTolerancePx`) actuales, expuestos como config a nivel mapa.
2. **`hover` reporta `added`/`removed`.** Generaliza el ref-counting actual (solapamiento polígono+marcador): el motor entrega deltas; el consumidor decide cómo agregar (ref-count por nombre, mostrar todos, etc.). El core **no** conoce "nombres de geocerca".
3. **Sin `onDisambiguate` en el core.** `click` entrega **todos** los hits ordenados; abrir un popup de desambiguación o tomar el top es decisión del consumidor.
4. **Suscripción por capa (API imperativa).** `engine.on('click', 'fleet', cb)`, `engine.on('hover', ['places','zones'], cb)`. A nivel `CustomEvent` (global), el consumidor filtra por `detail.hits[].layerId`.
5. **Lifecycle de hover** (igual que hoy, generalizado): enter contenedor → sesión; `pointermove` throttled → picking async → diff de set → `hover`; leave → `hover` con `hits:[]`; suprimido durante zoom/pan.
6. **Cursor automático.** El motor ya conoce el set de hits → si ese set incluye una capa `interactive`, pone el cursor `pointer` y lo restaura al vaciarse. Reemplaza el `container.style.cursor='pointer'` que la página escribe hoy a mano; el consumidor no toca el cursor (el contenedor vive en el shadow DOM).

---

## 9. Cámara / centrado (nuevo en `MapWidget`/`Camera`)

Hoy hay que entrar a `.leaflet`. Cristae expone una API de cámara de primera clase (el "centrado" requerido):

```js
camera.setView(latlng, zoom)        camera.panTo(latlng)
camera.flyTo(latlng, zoom)          camera.fitBounds(bounds, { insets })
camera.fitToLayer(layerId, { insets, maxZoom })   // encuadra todos los puntos de una capa
camera.followPoint(layerId, id, { zoom })   camera.stopFollow()   // cámara sigue una posición viva
camera.getCenter() / getZoom() / getBounds()
```

- **El viewport vivo es 100% imperativo.** `initial-center`/`initial-zoom` (props, §5.4) fijan la vista *una vez* al montar; **toda** recolocación posterior —recentrar, seguir, encuadrar— es uno de estos métodos. No hay prop reactiva de centro (ver nota en §5.4). Esto elimina por construcción la trampa idempotencia↔gesto.
- **`viewport-insets`** (prop `{ top,right,bottom,left }`): compensación por UI que ocluye el mapa. **Reemplaza** el `document.querySelector('.wl-left-scroll')` actual (deuda de acoplamiento al DOM de la app que **no** migra). `panTo`/`flyTo`/`fitBounds`/`fitToLayer`/`followPoint` aplican estos insets. (Animado = `flyTo`; inmediato = `panTo`. No hay `panToSmooth`: el easing es una opción de `flyTo`, no un método aparte; el ajuste por paneles es `viewport-insets`, no proyección manual.)
- `followPoint` generaliza el "follow" sin UI: solo cámara siguiendo una posición que se actualiza por `move`/`patch` del Source, coalescido a rAF. Reemplaza el bombeo manual `onVehicleUpdate → panToSmooth` (que hoy proyecta/desproyecta y lee el DOM en cada update WS, `FollowManager.js:68-72`).

---

## 10. Tiles y tema

- `setTile(url, options)` / atributo `tile` (`{url, attribution, maxZoom, className, …}`). `worldCopies` configurable (afecta `noWrap`). Transición de tiles configurable (`tileTransition`).
- **Tema por CSS custom properties** sobre el `:host`. El `getThemeRoot` (ya inyectable) apunta al host → las label-layers leen variables (`--cristae-surface`, `--cristae-text`, …) del elemento. Se elimina el lookup a `.wl-shell`. El emparejado tile↔tema (claro/oscuro) es regla de negocio → vive en el consumidor.

---

## 11. Lifecycle del web component (Shadow + light DOM + slots)

- **Shadow DOM** = superficie de render: `<div>` del `L.map`, panes, canvases GL, canvas de labels. CSS de Leaflet inyectado con `adoptedStyleSheets` (constructable stylesheet) → glify/panes encapsulados.
- **Light DOM** = lo explícito: las **capas como elementos hijos** (`<cristae-point-layer>`, …) viven en light DOM, inspeccionables, y exponen su handle/props. (Su render real ocurre en el shadow; el hijo es solo declaración + canal de datos.)
- **Slots** = UI del host por encima del mapa: `<slot name="overlay">` para sidebar/tooltip/controles. El host proyecta su chrome; el mapa va debajo.
- `connectedCallback` → crea/monta el motor (idempotente, guard `#mounted`; reutiliza `L.map` entre re-mounts, como hoy con StrictMode). `disconnectedCallback` → `destroy()`. **`ResizeObserver`** sobre el host → `leaflet.invalidateSize()` + `syncPickingSize`. **`VisibilityGuard`** (ya incluido) pausa render en `display:none`.
- **`iconSet` reactivo — independiente del orden de parseo y del loader (por diseño, no por instrucción de uso).** La capa reacciona al **valor** de `iconSet`, no al instante en que llega: asignarlo o reemplazarlo —desde el HTML, un `<script src type=module>` al final, `import()` dinámico, o en caliente— dispara **reseed automático + rebuild** coalescido a rAF (§7.2/§5.3). El mismo camino cubre el pack que ya existía, el que llega tarde y el swap; nada que el consumidor tenga que orquestar. Mientras un `icon-set="…"` **por nombre** no resuelve a un pack registrado, la capa pinta con un **IconSet por defecto** (marcador genérico — nunca en blanco ni icono equivocado) y se reconstruye sola al resolver. `ready: Promise` sigue disponible como gate para código imperativo que prefiera `await`, pero **no** es necesario para el orden correcto de iconos.

---

## 12. Superficie pública (resumen)

**Mapa (props reactivas / atributos):** `tile`, `theme` (vía CSS vars), `world-copies`, `viewport-insets`, `hover-throttle`, `stale-tolerance-px`. **No reactivas (solo al montar):** `initial-center`, `initial-zoom` — el viewport vivo es imperativo (§9).

**Mapa (métodos):** `addPointLayer(cfg)→handle`, `addPolygonLayer(cfg)→handle`, `addLabelLayer(cfg)→handle`, `removeLayer(id)`, `getLayer(id)`, `attachSource(id, source)`, cámara (§9), `createIcon(descriptor)`, `registerIconSet(name, set)`, `getLeafletMap()` (escape hatch — el `L.map` crudo) / `getUnsafeHandler()` (escape hatch avanzado — el `MapWidget` con sus métodos internos, sin garantías de estabilidad), `destroy()`, `ready: Promise`.

**Capa (props/métodos):** `visible`, `opacity`, `interactive`, `data` / `source` (Source compartida) / `set`/`patch`/`move`/`remove`, `accessors`, `iconSet` (reactivo → reseed+rebuild), `preloadIcons(variants)`, `filters`/`addFilter`/`removeFilter`, `refresh()`; cluster/label como hijos o `attachCluster`/`attachLabel`.

**Eventos:** §8.2.

**Iconos:** `defineIconSet`, `defineClusterIconSet`, `createIcon`. §7.3.

---

## 13. Cambios estructurales requeridos en Cristae (lista precisa)

> Todos **estructurales** (terminología, fronteras, esquema). Los **algoritmos** de glify (rebuild `setData`/`resetVertices`, supercluster) y de picking **no** se reescriben ni se forkea glify. Se **añade** un path incremental (`move`/recolor) que escribe el buffer interleaved de glify por `bufferSubData` — código del motor sobre los recursos GL de la instancia, **no** un fork ni un monkey-patch del prototipo (§17.5). Es el mismo patrón que el framework ya usa para el draw de picking (`GlifyLayer.js:80-94` bypassa `drawOnCanvas`).

1. **Atlas como valor append-only + `GpuAtlasBinding` por contexto** (§7.2): `Atlas` inmutable-por-generación con capacidad fija e índice/encoding estables (CPU, sin WebGL); binding por capa con cursor (`uploaded` / identidad de objeto) que hace `texSubImage2D` en append y `texImage2D` en regrow; dims → uniforms. **Elimina `#dirty`** (booleano consume-once). *(El cambio más profundo; habilita reuse+append, arregla la corrupción de marcadores existentes y el 2º-mapa-en-blanco.)*
2. **API de cámara** en `MapWidget`/`Camera` (§9) — hoy inexistente (solo `.leaflet`).
3. **Reconfig runtime de cluster** (`radius/maxZoom/minPoints`) — hoy solo en constructor.
4. **Eventos `viewportchange` / `interactionstart|end`** en el `EventBus` — hoy hay que usar `.leaflet.on`.
5. **`hover` con `added/removed`** (deltas) en el `EventBus` — generaliza el ref-counting de la app.
6. **Hit `kind: 'point'|'polygon'`** (no `'glify'|'leaflet'`).
7. **`viewport-insets`** configurable; eliminar `document.querySelector('.wl-left-scroll'/'.wl-shell')` del pan/fit (des-acople del DOM de la app).
8. **`getThemeRoot` = host**, variables `--cristae-*` (eliminar dependencia de `.wl-shell`).
9. **Des-dominio del core** (§4): renombres + extraer `Vehicle/Itinerary/connection` a `recipes/fleet`; conservar `geometry/` genérico.
10. **Throttle de interacción internalizado**: el motor coalesce su propio redraw en pan/zoom (no muta el emitter del consumidor); paridad opcional vía `interactionstart|end`.
11. **`LabelLayer` unificada** standalone+attachment, `textOf` genérico (elimina `place/vehicle` label especializados y sus sprite builders de dominio).
12. **Eliminar `WorkerPool` global; fan-out síncrono cero-alloc** (§16-2, §17): el fan-out de listeners pasa a `safeDispatch(listeners, data, onError)` (`try/catch` centralizado en `safe`, sin array de tareas ni clausuras). Resuelve a la vez el cuelgue por excepción (hoy un listener que lanza mata el slot) y la asignación por-emit de `notifyChanges`. El coalescing ya vive en el `Emitter`/rAF, así que el pool no aporta.
13. **Erradicar singletons mutables de módulo** (§16-3/4): `connection.js thresholds`, `WorkerPool.instance`, `window.L.glify` → estado por-instancia / inyectado. (La config de dominio, como umbrales, sale al recipe.)
14. **`leaflet-edgebuffer` lazy/opt-in** contra el `L` provisto (§16-5): eliminar el `await import` top-level (vuelve async el módulo y parchea `L` global al evaluarse).
15. **Defaults neutros** (§16-6): quitar de `#initMap` el center Santiago `[-33.45,-70.65]`, zoom, URL OSM y `maxZoom` horneados → config con defaults neutros.
16. **`destroy()` en stores/emitters** (§16-7/8): `ComposableStore.destroy()` quita su listener del padre (hoy leak en `reactiveCompose`); `IntervalEmitter.destroy()` cancela el rAF pendiente; cap de intervalo configurable, no `[0,1000]` fijo.
17. **Diferir `patch()` durante zoom** (§16-9): hoy `rebuild` se difiere pero `patch` se descarta (se pierde un update que llega durante el zoom).
18. **Reactividad declarativa uniforme** (§5.4): cablear como reactivas (no imperativas) las entradas de *estado* — `accessors` (reemplazo → re-deriva+rebuild), `filters` (reasignar → reconcilia **por `deps`**, §5.3), cluster (`radius/maxZoom/minPoints/iconSet` en runtime), `bind-to` (resolución por nombre orden-independiente). Generaliza el fix de `iconSet`; elimina la clase entera de bordes "asignado tarde / cambiado en caliente". *(El centro/zoom NO entra acá: es `initial-*` uncontrolled + cámara imperativa, §5.4/§9.)*

---

## 14. Validación: reconstruir `mapa_geotactico` como *recipe* (sin perder funcionalidad)

El `fleet-recipe` (en el adaptador WingLogistics, fuera del core) reconstruye todo componiendo primitivas:

- **vehicles** = `addPointLayer({ accessors:{ idOf, positionOf, headingOf, sizeOf, variantOf: v=>estadoFlota(v) }, variants: VARIANTES_FLOTA, iconSet: fleetIcons })` + `attachCluster(...)` + `attachLabel({ textOf: v=>label(v, modo) })`.
- **overlay de conexión** = `addPointLayer` sobre el mismo `Source`, `iconSet: overlayIcons`, sin `headingOf`.
- **geocercas** = `addPolygonLayer({ ringsOf, styleOf })` + `attachLabel`.
- **place-markers / search** = `addPointLayer` sin rotación.
- **GPS visibility / corrupt-tracking / global filters** = `layer.addFilter(id, predicado)` (o filtros en el store del consumidor en ruta B).
- **latencia / recolor por antigüedad** = el recipe recomputa `variantOf` y llama `layer.refresh()` en su timer.
- **follow / itinerary-focus** = `camera.followPoint` / `camera.fitToLayer` + visibilidad/opacidad por capa + capa de realce transitoria.
- **datos REST/WS** = `data-source` que llama `handle.set/patch/move` (ruta C) **o** envuelve el `Store/Emitter` existentes como `Source` (ruta B, coste ~0).
- **contexto empresa/org, dedupe, tile↔tema** = quedan en el adaptador (nunca fueron lógica de mapa).

**Resultado:** cobertura completa de funcionalidad; 9 capas hardcoded → composición; atlas sin bug de invisibles; lo único que "sale" no es lógica de mapa. Lo más relevante para validar la generalización: **el andamiaje imperativo de hoy desaparece**, no se traduce. `forceRebuildRef`, `replaceLayer`, `preseed`/`warmup` (~278 buckets), el toggle manual de ~8 panes en focus, los 3× `mountMap`, el bombeo de cámara en cada update WS y el fan-out `settings→applyXyz` se vuelven **reactividad derivada** (§5.4). El hot-path —patch/rebuild, `dirtyIds`, emitter 500 ms + rAF, picking GPU— **no se reescribe**: migra intacto al motor (§13 cabecera). La ruta de datos de hoy **ya es** `store + emitter + version + patch/rebuild`, que es exactamente el contrato `Source` (§5.1) → la traducción es envolver, no reescribir.

**Huecos detectados en la validación estricta (los tres se cierran por diseño, sin escape hatch ni romper el paradigma):**
1. **Orden de apilado** — hoy 12 panes con z-index numérico. → orden del light DOM + atributo `z` (§6).
2. **Cursor en hover** — hoy la página escribe `container.style.cursor='pointer'`. → automático: una capa `interactive` cambia el cursor cuando el set de hits la incluye (el motor ya conoce el set; §8.3). El consumidor no lo maneja.
3. **Restyle de polígono en hover** (geocerca `setStyle({opacity})`) — presentación transitoria, no rebuild. → `hoverStyleOf?` en polygon-layer (restyle barato de path; §6).

La cámara (follow/fit/pan) queda imperativa **correctamente** (acción, no estado, §5.4), no es un hueco. Veredicto: **un caso de uso real y complejo se expresa por completo en el modelo declarativo, y al hacerlo elimina el ciclo de vida complejo** — la generalización queda validada en al menos este caso.

### 14.1 Ahorros de código en un uso real (antes → después)

Medido contra `mapa_geotactico` (citas de archivo verificadas). El patrón común: lo que hoy es *coreografía imperativa* se vuelve *una asignación reactiva* o *desaparece*.

**1. Cambio de pack de iconos** — hoy `#replaceVehicleBuilders` + `applyBuilder` + `forceRebuildRef` + `clusterLayer.refresh` + `rebuild` (`ConfiguracionMapa.js:398-422,1278-1296`, ~35 líneas):
```js
// AHORA — reseed + rebuild reactivo (§7.2):
layer.iconSet = nuevoPack
```

**2. Bootstrap sync→async del builder** — hoy `createIconBuilderSync()` para el primer paint y luego `await createIconBuilder()` + `replaceLayer` (`IconPackRegistry.js:85-152`):
```js
// AHORA — swap reactivo, orden-independiente (§7.2/§11):
layer.iconSet = packSync
fleetIcons.ready.then(p => { layer.iconSet = p })   // converge solo
```

**3. Ingesta de datos** — hoy `store.addListener` con ~35 líneas que deciden rebuild-vs-patch + `syncMapStore` + `clustersChanged` + `forceRebuildRef` + rAF (`ConfiguracionMapa.js:839-873`):
```js
// AHORA — el motor posee la decisión patch/rebuild (§5.3); ruta B coste ~0:
fleetLayer.source = defineSource({ getSnapshot: () => wingStore.filtered, subscribe, accessors })
```

**4. Filtros** — hoy `applyGpsVisibilityFilter`/`applyCorruptTrackingMode`/`applyGlobalVehicleFilter` + `forceRebuildRef.current = true` (`ConfiguracionMapa.js:1186,1222,1240`):
```js
// AHORA — reconciliación reactiva (§5.4); el forceRebuild interno desaparece:
layer.filters = [gpsPred, corruptPred, globalPred]
```

**5. Visibilidad en itinerary-focus** — hoy `#applyTransientVehicleVisibility` con 8× `setGlPaneVisible` + `setLayerVisibility` (`ConfiguracionMapa.js:640-665`):
```jsx
// AHORA — visibilidad derivada del estado, declarativa:
<cristae-point-layer id="fleet" visible={!focusActivo}/>
{focusActivo && <cristae-point-layer id="focus" .data=${[veh]}/>}
```

**6. Follow de cámara** — hoy `FollowManager.onVehicleUpdate → panToSmooth` (project/unproject + `document.querySelector('.wl-left-scroll')`) bombeado en **cada** update WS (`FollowManager.js:68-79`, `ConfiguracionMapa.js:1084-1104`):
```js
// AHORA — el motor re-centra solo sobre la posición viva; insets por prop (§9):
camera.followPoint('fleet', id)        // + viewport-insets
```

> Resumen del ahorro: desaparecen `forceRebuildRef`, `replaceLayer`, `preseed`/`warmup`, el toggleo manual de panes, el triple `mountMap` y el bombeo de cámara. No es que se escriban "más corto": es que **el estado pasa a derivarse**, y el consumidor deja de mantener un ciclo de vida. La superficie exacta de cada API y sus complejidades están en `SPECS.md`.

---

## 15. No-objetivos y decisiones cerradas

- **Nombres (cerrado):** elemento `<cristae-map>`, prefijo de eventos `cristae:`. El doc los usa de forma consistente; **no es una decisión abierta** — un rename global es trivial si algún día se requiere, pero nadie debe inventar nombres alternativos al implementar.
- **Persistencia de settings (cerrado):** fuera del core; las props son la fuente de verdad. Persistencia opt-in en el adaptador.
- **No-objetivo:** reescribir el hot-path de render, supercluster, o la lógica de picking (están ultra-optimizados).

---

## 16. Auditoría de fragilidades del framework actual

> Hallazgos verificados leyendo el código de `Cristae-Framework`. Severidad = impacto cuando un externo adopte la librería. Cada uno tiene su resolución estructural en Cristae (no algorítmica).

| # | Fragilidad | Archivo / evidencia | Sev. | Resolución Cristae |
|---|---|---|---|---|
| 1 | **Atlas: shaders/encoding horneados, `buildAtlas` y compile call-once, `#dirty` consume-once.** Variante tardía → su marcador invisible **y** corrupción de los existentes (`r=idx/(n-1)`); 2º mapa en blanco. | `IconBuilder.js` 13,42,52,78,150,164; `GlifyLayer.js` 212-215,234; `GlifyPicking.js` 38 | **Crítica** | §7.2 — `Atlas` append-only + `GpuAtlasBinding` por contexto |
| 2 | **`WorkerPool`: un listener que lanza mata el slot para siempre.** `slot.task()` sin aislamiento → `#drain` no corre → `idle=false` permanente; tras 4 lanzamientos el pool se cuelga y **ningún store vuelve a notificar**. | `WorkerPool.js` 59-64 | **Crítica** | Eliminar el pool; fan-out con `safeDispatch` síncrono + `safe` (try/catch centralizado, zero-alloc, §17) |
| 3 | **Singleton mutable de módulo: umbrales de conexión.** `let thresholds` compartido por toda la página; dos mapas no pueden diferir; last-writer-wins. | `connection.js` 6,12-15 | Media (dominio) | Sale al `recipe/fleet`; config **por-instancia** |
| 4 | **`window.L.glify` global read (singleton compartido).** Acopla a global; rompe SSR/portabilidad; orden de `<script>`. Con 2+ engines en la página, `destroy()` de uno deja el canvas del otro obsoleto hasta el próximo gesto del usuario. **Confirmado en producción.** | `GlifyLayer.js` 171,176,217 | Media | Fix de raíz: provider de `L` en constructor + glify re-exportado como factory por-instancia (sección empaquetado). **Mitigación aplicada:** (a) registro estático de engines vivos → `destroy()` notifica a hermanos para `resetCanvasReference()` automático; (b) `syncSize()` redibuja las capas de puntos tras `invalidateSize()` → el `ResizeObserver` interno de `<cristae-map>` cubre resize simétrico (sin desplazar centro) **y** show tras `display:none` (size 0→N) sin acción del consumer; (c) `invalidateCanvas()` expuesto en `MapEngine`/`<cristae-map>` como escape hatch para el path headless o el raro show sin cambio de tamaño. |
| 5 | **`await import('leaflet-edgebuffer')` top-level.** Vuelve **async** el módulo (afecta bundlers/consumidores) y parchea `L` global al evaluarse. | `MapWidget.js` 10-12 | Media | Carga lazy/opt-in contra el `L` provisto |
| 6 | **Defaults de dominio/locale horneados.** Center Santiago `[-33.45,-70.65]`, zoom 12, URL OSM, `maxZoom` 19, `edgeBufferTiles` 3 en un widget "genérico". | `MapWidget.js` 537-549 | Media (portab.) | Config con defaults neutros |
| 7 | **`ComposableStore` sin `destroy()` → leak de listener.** `reactiveCompose` registra un listener en el padre por `instanceId`; nada lo quita → un hijo descartado deja su callback vivo (y corre sobre un store muerto). | `ComposableStore.js` 62-70 | Media | `destroy()` → `parent.removeListener(instanceId)` |
| 8 | **`IntervalEmitter`: cap duro `[0,1000]` ms + rAF no cancelado en destroy.** Poll >1s imposible; `destroy()` no limpia `#scheduleEmit` → frame colgado y `#onFlush` post-destroy. | `IntervalEmitter.js` 173, 139-152, 165-170 | Baja/Media | Cap configurable; cancelar/guardar el rAF en destroy |
| 9 | **`patch()` durante zoom se descarta sin diferir.** `rebuild` usa `#rebuildPending`; `patch` solo `return` → un update que llega en el zoom se pierde hasta el próximo cambio. | `MapWidget.js` 382-383 | Baja | Diferir patch con el mismo mecanismo (o coalescer a rebuild) |
| 10 | **`GlifyPicking` asume WebGL2** (`fenceSync`/PBO en `request`/`collect`); sin guard, un contexto WebGL1 rompería (`pickSync` sí es WebGL1-safe). | `GlifyPicking.js` 82,152,163 | Baja | Documentar requisito o degradar a sync en WebGL1 |
| 11 | **`Math.random()` para identidad de instancia** (no es bug, es *smell*: la identidad no debe depender de RNG). | `ComposableStore.js` 41 | Baja | `Symbol()` sin random |
| 12 | **`VisibilityGuard` monkey-patcha métodos + props públicas** (`widget.rebuild/patch`, `_visibilityGuard`, `setMinimized`) → frágil ante doble-attach/colisión. | `VisibilityGuard.js` 37-60 | Baja | Composición explícita (estado en el engine) en vez de parcheo |
| 13 | **Asignaciones en hot-path (presión de GC).** `encodeColor` retorna `{r,g,b,a}` **nuevo por punto/render**; `notifyChanges` hace `.map(l=>()=>…)` → array + N clausuras **por emit**. A miles de updates/seg colapsa el GC en segundos. | `IconBuilder.js` 51-56; `ComposableStore.js` 227-233 | **Alta** | §17 — scratch reusado, `forEach`/`for`, `dispatch` directo |

**Dos patrones transversales:**
- **Estado global mutable de módulo/singleton** (hallazgos 2-4: pool, umbrales, `window.L`) — mismo anti-patrón que el `#dirty` del atlas a otra escala. Regla: **todo estado vive en una instancia (engine/capa/binding) o se inyecta; nada en variables de módulo.** Vuelve el motor seguro para multi-mapa y para embeberse sin colisionar con la app del externo.
- **Asignación en caliente** (hallazgos 1, 13): objetos/arrays/clausuras por-elemento o por-emit. Regla en **§17**: estado estable = cero-alloc (scratch reusado, `forEach`/`for`, `safe` por callbacks).

---

## 17. Rendimiento y manejo de errores en hot-path

> Contexto: en modo reactivo (`interval=0`) el productor emite **miles de updates/seg**. El cuello de botella **no es CPU, es presión de GC**: una sola asignación por-elemento × miles de puntos × decenas de emits/seg = pausas de GC que se ven como tirones en el mapa, y colapso en segundos. Estas reglas son obligatorias en render, picking, `Atlas.sync`, `notify` y `dispatch`.

> **Dos paths, dos presupuestos de alloc (clave — verificado en glify 3.3.1).** glify NO ofrece update in-place: `setData`→`render`→`resetVertices` es **siempre O(n) y aloca O(n)** (spreadea `{...color}` por punto en `points.ts:136`, crea un objeto-lookup por punto que en este uso ni se lee, y hace `new Float32Array`). Por eso:
> - **Path de rebuild** (`set` cambió el set / filtro / cluster): pasa por `setData` de glify → aloca O(n). El coalescing **acota la *tasa* a ≤1 rebuild por flush de rAF** (colapsa N pushes del `Source` del mismo tick en uno) — pero **no acota el costo agregado y no garantiza que el rebuild sea raro**. Si el *set* de ítems cambia en cada frame, se paga el alloc O(n) en **cada** frame; el diseño no lo evita ni el coalescing lo esconde. La condición para que este path sea barato es que **el conjunto cambie poco** (alta/baja/reorder/filtro), lo cual es propiedad del **uso del Source**, no del motor. La vía para que los "miles/seg" no toquen este path es enrutar el estado estable por `move`/`patch` (incremental). El scratch de `encodeColor` (§17.1) solo mantiene limpio *nuestro* lado; glify domina el alloc y no lo tocamos.
> - **Path incremental** (`move`/`patch`/recolor en estado estable, los "miles/seg"): **NO** pasa por `setData`. Es código del motor que escribe el buffer interleaved de glify por `bufferSubData` (§17.5). El **[0-alloc] real (WebGL2)** se cumple **bajo precondición**: el id tiene slot vigente (el set no cambió desde el último rebuild) → solo se reescribe posición/color de ese slot. Esa es la **única garantía de alloc incondicional del diseño**; el costo del rebuild no lo es, porque depende del *tipo de cambio*, no del scheduler. El presupuesto de §17 aplica a *este* path y a encode/dispatch/`Atlas.sync`, no al rebuild.

### 17.1 Estado estable = cero asignaciones
- **Arrays de instancia reusados + truncado de longitud** (`arr.length = idx`), nunca arrays nuevos por ciclo. Ya lo hace `GlifyLayer.#renderItems` con `points/meta/items`.
- **Objeto scratch mutado-y-retornado** para valores por-elemento **en el path de rebuild** (callback `color:(i)=>…` de glify). Ej.: `encodeColor` devuelve **un único** `{r,g,b,a}` reusado — seguro porque glify lo consume sincrónicamente: hace `chosenColor = {...colorFn(i), a}` en la misma iteración (`points.ts:136`), copia verificada. En el path incremental no hay scratch-objeto: `encodeColor(index, out, offset)` escribe directo en el slot del buffer (§17.5).
- **Enteros inline** en vez de objetos de coordenadas: `col = i % cols; row = (i/cols)|0` (no `{col,row}`).

### 17.2 `map`/`filter` que solo iteran → `forEach`/`for`
Un `.map(=>clausura)` usado solo para recorrer aloca **array + N clausuras**. `forEach` elimina el array (queda 1 clausura/emit); el `for` clásico lo deja en **0**.
```js
// ANTES — array + N clausuras por emit
dispatch(this.#listeners.map(l => () => l.callback(data)))
// forEach — sin array (1 clausura/emit)
this.#listeners.forEach(l => safe(l.callback, data, reportListenerError))
// for — cero asignaciones (call-site más caliente)
const ls = this.#listeners
for (let i = 0; i < ls.length; i++) safe(ls[i].callback, data, reportListenerError)
```
Regla: `forEach` por defecto; `for` donde hasta ese cierre cuente. (El fan-out a listeners ya viene empaquetado en `safeDispatch`, §17.3 — no reescribir el `for` a mano en cada call-site.)

### 17.3 Errores: `safe` + `safeDispatch` por callbacks (zero-alloc)
El `try/catch` vive **una sola vez**, dentro de estos **dos** helpers; ningún call-site lleva `try/catch` inline ni wrappers que aloquen.
```js
// safe.js — los dos únicos helpers de error en caliente.

// Aísla UNA llamada. Devuelve el valor en éxito; en error llama onError y devuelve undefined.
export function safe(fn, arg, onError) {
  try { return fn(arg) }
  catch (e) { onError(e, arg) }     // onError = ref de módulo estable → no aloca
}

// Fan-out aislado a N listeners — cero-alloc (sin array de tareas, sin clausuras).
export function safeDispatch(listeners, data, onError) {
  for (let i = 0; i < listeners.length; i++) safe(listeners[i].callback, data, onError)
}
```
**Uso (reemplaza `notifyChanges` + `WorkerPool.dispatch`):**
```js
function reportListenerError(e) { if (__DEBUG__) console.error('[store] listener lanzó', e) }

notifyChanges() { safeDispatch(this.#listeners, this.#selfFilteredData, reportListenerError) }
```
- `safe` cubre el caso "necesito el valor" por su **`return`** — no hace falta una variante con `onOk`.
- En **frío** (config/parseo de arranque) puede usarse un `Result` que aloque, pero **fuera de este archivo y nunca** en render/notify/picking.

**Prohibido en caliente:** `try/catch` inline esparcido; `.map(=>clausura)`; spread de objetos por-elemento; retornar literales por elemento; cualquier wrapper monádico que aloque por llamada.

### 17.4 Sin scheduler global: `safeDispatch` síncrono
Se **elimina** el `WorkerPool` (singleton `MessageChannel`): su propósito —trocear cadenas largas de listeners para no bloquear el render— ya lo cubre el coalescing del `Emitter`/rAF aguas arriba. El fan-out es `safeDispatch` **síncrono y cero-alloc**, sin pool ni por-engine. Un listener genuinamente pesado difiere su **propio** trabajo (responsabilidad del consumidor); la librería no carga un scheduler global. *(Decisión: no hay variante asíncrona "configurable" — un flag así sería justo el tipo de menú que invita a cablear la rama equivocada.)*

### 17.5 Path incremental: escritura directa del buffer de glify (mecanismo verificado)

Es lo que hace al `move()` O(1) y al `[0-alloc]` **reales**, no aspiracionales. La intención —actualización puntual O(1)— **es alcanzable por bypass** (operar sobre los recursos GL de la instancia), **sin fork y sin monkey-patch**. Todo lo que sigue está verificado contra el source de glify 3.3.1 (`src/points.ts`, `src/base-gl-layer.ts`, `src/index.ts`) y de Cristae-Framework.

**Por qué el bypass basta — cadena de hechos verificados:**

1. **El marco de coordenadas es fijo de por vida.** `mapCenterPixels` se asigna **una sola vez** en el constructor (`base-gl-layer.ts:164`) y **nunca se recalcula** (grep exhaustivo del paquete: solo lectura, en `drawOnCanvas`). El pan/zoom **no toca los vértices** — solo recompone la matriz por frame (`points.ts:312-327`). Corolario clave: el vértice de un punto es **función pura de su propio latLng**: `project(latLng,0) − mapCenterPixels`. Por eso actualizar un punto **no** depende de los demás → **O(1) genuino**, no O(n) disfrazado.
2. **Los handles son públicos:** `instance.gl`, `instance.typedVertices` (el `Float32Array` espejo, asignado en `points.ts:114`), `instance.getBuffer('vertices')` (devuelve el **mismo `WebGLBuffer` cacheado**, `base-gl-layer.ts:253-262`), `instance.bytes` (=7), `instance.mapCenterPixels`, `instance.map`. Nada `private` bloquea.
3. **Picking comparte el buffer.** `GlifyLayer.#drawPick` (`GlifyLayer.js:88-94`) hace `useProgram` + `enableVertexAttribArray` + `drawArrays`, **sin re-bindear buffer ni llamar `vertexAttribPointer`**: lee el mismo buffer `vertices`. → un `bufferSubData` actualiza **visual y picking a la vez**; el path incremental **no** necesita sincronizar ningún lookup de CPU.
4. **No se reescribe nada de glify.** No se llama `setData`/`render`/`resetVertices`; se escribe en el buffer existente. Es el patrón que el framework ya usa para picking. Monkey-patchear `Points.prototype` sería estado global compartido (rompe multi-mapa/embebido, anti-patrón §16) y no aporta nada que el bypass no dé; forkear es overkill de mantenimiento sin necesidad.

**Layout (verificado, glify 3.3.1):** `bytes = 7` floats interleaved por punto `[x, y, r, g, b, a, size]` (`points.ts` defaults: vertex start0/size2, color start2/size4, pointSize start6/size1).

**Proyección inlineada — esto es lo que logra el `[0-alloc]` (el detalle que faltaba):**
`map.project(latLng, 0)` **aloca** (un `Point` y, vía `toLatLng`, un `LatLng` interno) → por update × miles/seg = justo el GC que se quería evitar. Hay que **inlinear** la transformación EPSG:3857 a zoom 0 (glify ya **exige** EPSG:3857 — `points.ts:100` advierte si no lo es —, así que el acoplamiento ya está asumido). Derivada y simplificada de `SphericalMercator.project` + `Transformation` + `scale(0)=256` de Leaflet:

```js
const D = Math.PI / 180, MAXLAT = 85.0511287798
const projX0 = (lng) => 256 * (lng / 360 + 0.5)
const projY0 = (lat) => {
  const c = lat > MAXLAT ? MAXLAT : lat < -MAXLAT ? -MAXLAT : lat
  const s = Math.sin(c * D)
  return 256 * (0.5 - 0.25 / Math.PI * Math.log((1 + s) / (1 - s)))
}
// sanity: projX0(0)=128, projY0(0)=128  ✔ (mundo 256×256 a zoom 0, centro en 128,128)
```

**Mecánica (dos fases):**

```js
// ── (A) re-bind tras CADA rebuild del engine ──
// setData crea un typedVertices NUEVO (points.ts:114); el WebGLBuffer (objeto) es estable,
// pero el Float32Array espejo NO → recapturar referencia y reconstruir id→slot.
bindToInstance(instance, items) {
  this.gl    = instance.gl
  this.buf   = instance.getBuffer('vertices')   // estable entre rebuilds
  this.verts = instance.typedVertices           // ← NUEVO cada rebuild: recapturar siempre
  this.cx    = instance.mapCenterPixels.x        // fijos de por vida
  this.cy    = instance.mapCenterPixels.y
  if (instance.bytes !== 7)                       // assert de layout (ver invariantes)
    throw new Error('[cristae] glify layout != 7; abortar path incremental')
  this.slot.clear()                               // id → índice de slot (orden del último render)
  for (let i = 0; i < items.length; i++) this.slot.set(items[i].id, i)
  this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.buf)
  this.gl.bufferData(this.gl.ARRAY_BUFFER, this.verts, this.gl.DYNAMIC_DRAW) // hint apto a updates
}

// ── (B) move(id, lat, lng): O(1), [0-alloc] en WebGL2 ──
move(id, lat, lng) {
  const i = this.slot.get(id)
  if (i === undefined) return false               // sin slot vigente → lo toma patch/rebuild
  const base = i * 7                              // vertex.start = 0
  this.verts[base]     = projX0(lng) - this.cx
  this.verts[base + 1] = projY0(lat) - this.cy
  const gl = this.gl
  gl.bindBuffer(gl.ARRAY_BUFFER, this.buf)
  gl.bufferSubData(gl.ARRAY_BUFFER, base * 4, this.verts, base, 2) // WebGL2: 2 floats, sin subarray
  this.scheduleRedraw()                           // coalescido a rAF por el engine
  return true
}
// recolor: idéntico sobre [base+2 .. base+6); encodeColor(tileIdx, angleNorm, i, this.verts, base+2)
// escribe r,g,b,a en el mirror — sin objeto por punto — y bufferSubData(.., base+2, 4).
```

- **[0-alloc] real en WebGL2:** la forma de 5 args `bufferSubData(target, dstByteOffset, srcData, srcOffset, length)` sube los floats **desde `typedVertices`** sin crear `subarray`. El picking ya exige WebGL2 (`GlifyPicking` `@requires WebGL2`, §16-10) → es el path primario.
- **WebGL1 (fallback):** sin la forma de 5 args → `gl.bufferSubData(ARRAY_BUFFER, base*4, this.verts.subarray(base, base+2))` (view minúsculo, no copia) o un scratch de 7 floats reusado.
- **`DYNAMIC_DRAW` se logra sin fork:** se re-emite `bufferData` con el hint sobre **nuestro** buffer capturado, una vez por rebuild en (A). No hay que tocar el código de glify.

**Invariantes de este path (condiciones de corrección, no recomendaciones):**
1. **Recapturar `typedVertices` y reconstruir `id→slot` tras cada rebuild** (fase A). El buffer-objeto es estable, pero el `Float32Array` espejo se reemplaza en cada `render()`; cachear la referencia vieja = escribir a un array huérfano que ya no respalda al GPU.
2. **Assert `instance.bytes === 7`** (y offsets de `shaderVariables`) en (A): si un upgrade de glify cambia el layout interleaved, **fallar ruidoso**, no corromper vértices en silencio. (Pinear la versión vendorizada acompaña; el assert es la red.)
3. **Hover/click nativo de glify deshabilitado** (`sensitivity:0`, picking propio por GPU): el path incremental **no** actualiza `latLngLookup`/`allLatLngLookup`, que quedan stale pero no se usan (el hit-test va por el buffer, que sí está fresco). Reactivar el hover nativo los corrompería.
