# SPECS — Cristae + `<cristae-map>`

> Especificación **de API** (el *cómo*). Complementa a [`MODELO.md`](./MODELO.md) (la *arquitectura*, el *por qué*). Donde MODELO decide, SPECS define la firma exacta, la **complejidad asintótica**, un **ejemplo de uso**, un **caso de test** y los **casos de borde** que cada pieza debe soportar.
>
> **Regla sobre los bordes:** este documento **no** enumera todos los casos de borde imaginables. El diseño está hecho para que la **gran mayoría** quede **invalidada por arquitectura** (no hay que chequearla porque no puede ocurrir). §15 separa explícitamente los bordes *eliminados por construcción* de los *que sí requieren manejo*. Un implementador que agregue `if`-checks defensivos contra bordes de la primera lista está trabajando en contra del diseño.
>
> **Objetivo:** MODELO + SPECS deben bastar para que un agente implemente a exactitud y de forma óptima **sin iterar**. Si algo acá es ambiguo, es un bug de esta spec — corríjase la spec, no se improvise en el código.

---

## 0. Convenciones

- **Complejidad:** `n` = nº de ítems de una capa; `k` = nº de ítems sucios (`dirtyIds`); `f` = nº de filtros activos; `L` = nº de listeners; `C` = capacidad del atlas (celdas); `v` = nº de variantes vivas; `H` = nº de hits bajo el cursor. "amort." = amortizado.
- **`[0-alloc]`** marca una ruta que **no debe asignar** en estado estable (ni array, ni objeto, ni clausura). Es un requisito, no una sugerencia: a miles de updates/seg una sola asignación por elemento colapsa el GC en segundos (MODELO §17).
- **Tipos:** notación TypeScript-like, ilustrativa. El código es JS (sin tipos en runtime). `LatLng = { lat: number, lng: number }`, `Point = { x: number, y: number }` (píxel del contenedor) y `Bounds = { south, west, north, east }` (caja en grados, §18): objetos planos, los únicos valores de posición que cruzan la API. Ninguno es un objeto de Leaflet.
- **Reactivo vs imperativo:** una **entrada de estado** es reactiva (atributo/prop; el motor reacciona al valor, coalescido a rAF — MODELO §5.4). Una **acción** es un método (efecto puntual en el tiempo). La firma lo indica.
- **Coalescing a rAF:** "coalescido" = múltiples cambios en el mismo tick colapsan en **un** efecto en el próximo `requestAnimationFrame`. Es el mecanismo único de batching; no hay otro scheduler.

---

## 1. Helpers de error en caliente — `safe` / `safeDispatch`

Únicos dos helpers de aislamiento de errores. No hay `try/catch` en bloques en el hot-path (MODELO §17.3). No hay `Result` monádico (asigna).

```js
// safe.js
export function safe(fn, arg, onError) {
  try { return fn(arg) }
  catch (e) { onError(e, arg) }   // onError = ref de módulo estable → [0-alloc]
}
export function safeDispatch(listeners, data, onError) {
  for (let i = 0; i < listeners.length; i++) safe(listeners[i].callback, data, onError)
}
```

| API | Firma | Complejidad | Notas |
|---|---|---|---|
| `safe` | `(fn, arg, onError) → ReturnType<fn> \| undefined` | O(1) **[0-alloc]** | Devuelve el valor en éxito; `onError(e, arg)` en fallo. `onError` debe ser una referencia estable (de módulo), nunca una clausura creada en el call-site. |
| `safeDispatch` | `(listeners, data, onError) → void` | O(L) **[0-alloc]** | For-loop; sin array de tareas ni clausuras. Aísla cada listener: uno que lanza no detiene a los demás. |

- **Uso:** `notifyChanges() { safeDispatch(this.#listeners, this.#selfFilteredData, reportListenerError) }`.
- **Test:** `safeDispatch([{callback:()=>{throw 1}}, {callback:spy}], d, noop)` → `spy` recibe `d` (el throw del primero no lo bloquea); `reportListenerError` se llamó 1 vez.
- **Bordes que cubre:** predicado/listener que lanza (filtro, suscriptor de store, callback de color). **Borde eliminado:** el deadlock del `WorkerPool` (un task que lanza dejaba el slot ocupado para siempre) no existe — no hay pool (MODELO §13.12).

---

## 2. Contrato `Source<Item>`

Lo único que el motor necesita de una fuente de datos. Generaliza `Store` + `Emitter`. (MODELO §5.1.)

```ts
interface Source<Item> {
  accessors: {
    idOf(item): string | number          // identidad estable
    positionOf(item): LatLng
    headingOf?(item): number              // grados; ausente → la capa no rota
    sizeOf?(item): number                 // px en pantalla
    variantOf?(item): string              // clave de icono en el IconSet
    textOf?(item): string                 // para label-layer
  }
  variants?: string[]                     // espacio declarado → preseed del atlas (§6 de esta spec)
  getSnapshot(): Item[]                    // ref ESTABLE entre flushes (no copiar por emit)
  version(): number                       // dirty-check monotónico
  subscribe(cb: () => void): () => void    // retorna unsubscribe
  dirtyIds?(): Set<id> | null              // presente → patch parcial; ausente → diff por version
}
```

**Semántica obligatoria:**
- `getSnapshot()` retorna **la misma referencia de array** mientras no cambie el contenido estructural; el motor compara `version()` para decidir si releer. **No** devolver una copia nueva por llamada (rompe el dirty-check y asigna).
- `version()` es **monotónico creciente**; cambia sii cambió algo observable. El motor nunca compara contenido; confía en `version()`.
- `subscribe(cb)` → el motor se suscribe una vez por capa; `cb` se invoca tras cada cambio (el productor coalesce a su ritmo, p. ej. emitter 500 ms + rAF).

| Operación (motor sobre Source) | Complejidad | Dety |
|---|---|---|
| leer snapshot tras notificación | O(1) si `version` no cambió; O(n) si releer | |
| decidir patch vs rebuild | O(k) con `dirtyIds`; O(n) sin (diff de id-set) | §5.3 MODELO |

- **Ejemplo (ruta B, WingLogistics):** envolver el `ComposableStore`+`IntervalEmitter` existentes:
```js
const source = {
  accessors: { idOf: v=>v.id, positionOf: v=>v.tracking, headingOf: v=>v.tracking.angulo,
               sizeOf: v=>sizeOf(v), variantOf: v=>estadoFlota(v) },
  variants: VARIANTES_FLOTA,
  getSnapshot: () => store.filtered,
  version: () => store.dataVersion,
  subscribe: cb => { const id=Symbol(); emitter.on(id, cb); return () => emitter.off(id) },
  dirtyIds: () => store.lastDirtyIds ?? null,
}
fleetLayer.source = source     // prop declarativa (interno: engine.attachSource)
```
- **Test:** un `Source` falso con `version` constante y snapshot fijo → tras N `cb()` el motor hace **0** rebuilds (nada cambió). Cambiar `version` + `dirtyIds={id}` → exactamente 1 patch, 0 rebuild.
- **Bordes que requieren manejo:** snapshot con id duplicado (el motor toma el primero, ignora el resto — no lanza); `positionOf` no finito (el ítem se omite del render, no rompe la capa); `dirtyIds` con un id que no está en el snapshot (se ignora).
- **Borde eliminado:** "copiar el snapshot por emit" no es un riesgo de rendimiento porque el contrato lo prohíbe y el motor nunca copia.

---

## 3. `createSource` → Source (ruta C)

Para consumidores sin reactividad propia. El motor crea el Store+Emitter internamente. Devuelve
**un** objeto que ES el `Source` (§2, miembros de lectura) y además expone los de escritura del
dueño — no hay handle aparte. Se adjunta por la prop declarativa de la vista (`layer.source = src`,
§7) y el motor solo lee; la misma Source sirve a N vistas (filtro computado una vez, no por
componente).

```ts
createSource(accessors, variants?) → Source & Writable
interface Writable {
  set(items: Item[]): void                 // reemplazo total → diff de id-set
  patch(items: Item[], dirtyIds: Set<id>): void
  move(id, lat, lng): void                 // posición sin rebuild
  remove(id): void
  addFilter(f): void; removeFilter(id): void
  destroy(): void
}
```

| Método | Complejidad | Patch o rebuild |
|---|---|---|
| `set(items)` | O(n) diff de id-set | rebuild si cambió el set / filtro / clusters; si no, patch |
| `patch(items, dirtyIds)` | O(k) | rebuild solo si cambia membresía de filtro/cluster (o un regrow de atlas, §4.2); si no, **k escrituras de slot** (mismo mecanismo que `move`/recolor, §13) — O(k) **[0-alloc]**, sin rebuild |
| `move(id, lat, lng)` | O(1), **[0-alloc]** en WebGL2 | nunca rebuild: `bufferSubData` al slot del vértice en el VBO de la capa. Ver MODELO §17.5 |
| `remove(id)` | O(1) amort. | patch (o rebuild si afecta cluster/filtro) |

- **Ejemplo:** `const s = createSource(accessors); layer.source = s; ws.onMsg(m => s.move(m.id, m.lat, m.lng))`.
- **Test:** `s.set([a,b]); s.move(a.id, 1, 2)` → la posición de `a` cambia con **0** rebuilds (verificar contador interno de rebuild).
- **Borde eliminado:** `set` durante zoom/pan **no** descarta el update (MODELO §16-9): el rebuild se difiere pero el dato queda pendiente y se aplica al terminar la interacción.

---

## 4. Atlas + GpuAtlasBinding (la pieza crítica)

MODELO §7.2. Separación: `Atlas` = valor CPU inmutable-por-generación, append-only; `GpuAtlasBinding` = espejo GPU por contexto, con cursor. **Cero flag mutable compartido.**

### 4.1 `Atlas` (CPU, sin WebGL)

```ts
interface Atlas {
  readonly generation: number
  readonly capacity: number          // C — celdas totales (con headroom)
  readonly count: number             // celdas ocupadas (≤ C)
  readonly cols: number              // dims de la grilla (uniforms del shader)
  readonly rows: number
  readonly tileSize: number
  indexOf(variant: string): number   // variante → índice entero estable, o -1
  append(variant, bitmap): number    // registra y devuelve el índice; NO sube a GPU
  cellOf(index): void                // escribe col/row en scratch (ver abajo) [0-alloc]
  tileAt(index): ImageBitmap|Canvas  // bitmap de una celda
  tileChannel(index): number         // canal r del tile = index/(C-1); el resto del color lo compone la capa [0-alloc]
}
```

| Operación | Complejidad | Invariante |
|---|---|---|
| `indexOf(variant)` | O(1) (Map) | estable durante la generación |
| `append(variant, bitmap)` | O(1) amort. | asigna la siguiente celda libre; la celda **nunca se mueve** |
| `cellOf(index)` | O(1) **[0-alloc]** | `col = index % cols; row = (index/cols)|0` — enteros inline, sin objeto |
| `tileChannel(index)` | O(1) **[0-alloc]** | `r = index/(C-1)`, normalizado por **capacidad fija** `C` (no por `count`) → el color de un punto ya emitido no cambia de significado al crecer **dentro de la generación**. **Solo el canal de tile**; `g` (ángulo) y `b,a` (id de picking) los compone el slot-writer de la capa (§13), no el atlas |
| exceder capacidad | — | **NO muta**: produce un `Atlas` nuevo (`generation+1`, otro objeto); el viejo se descarta |

**Encoding (clave de la correctitud):** el atlas expone `tileChannel(index) = index/(C-1)` con `C` **constante por generación**; la **capa** compone el vector de color por punto `[tileChannel, angleNorm, idHi, idLo]` (ángulo del `headingOf`, id de picking del slot — concerns que no son del atlas). Hoy `IconBuilder` usa `idx/(n-1)` con `n = tiles.length` variable → corrompe los marcadores existentes con cada alta (MODELO §7.1). Acá el denominador es fijo dentro de la generación → inmune al append. **En regrow `C` cambia** → el `r` de cada punto cambia de significado, por eso el regrow re-encoda el buffer de puntos (rebuild), no solo re-sube la textura (§4.2, §15.2).

### 4.2 `GpuAtlasBinding` (por contexto GL, propiedad de la capa)

```ts
class GpuAtlasBinding {
  #atlas: Atlas | null = null
  #uploaded = 0
  #texture: WebGLTexture
  sync(atlas: Atlas): void
}
```

```js
sync(atlas) {
  if (this.#atlas !== atlas) {                       // regrow → atlas nuevo (identidad)
    realloc(this.#texture, atlas.capacity); texImage2D(/* atlas completo */)
    this.#atlas = atlas; this.#uploaded = atlas.count
  } else {
    while (this.#uploaded < atlas.count) {            // append → cursor sobre log
      texSubImage2D(atlas.cellOf(this.#uploaded), atlas.tileAt(this.#uploaded))
      this.#uploaded++
    }
  }
}
```

| Estado | Complejidad de `sync` | GPU |
|---|---|---|
| estable (sin cambios) | O(1) — 2 comparaciones **[0-alloc]** | nada |
| append de Δ variantes | O(Δ) | `texSubImage2D` × Δ |
| regrow | O(C) | `texImage2D` completo (copia el bitmap previo por `drawImage`, no redibuja canvases) |

- **Dims → uniforms:** `cols/rows/tileSize` se setean como uniforms una vez por generación → **el shader nunca recompila** (ni en regrow). El programa de picking comparte el mismo `Atlas` vía su propio binding.
- **Ejemplo:** una capa con 2 contextos (mapa A y B) tiene **un** `Atlas` compartido y **dos** bindings; cada uno converge a su ritmo.
- **Test 1 (append):** `atlas.append('x', bmp)` luego `binding.sync(atlas)` → 1 `texSubImage2D`, `uploaded == count`. Segundo `sync(atlas)` sin cambios → 0 llamadas GPU.
- **Test 2 (multi-mapa):** dos bindings sobre el mismo atlas; montar el 2º tarde (cursor 0) → re-sube completo y **renderiza** (no queda en blanco).
- **Test 3 (regrow):** superar `capacity` → nuevo objeto `Atlas`, `generation+1`; ambos bindings detectan `!==` y re-suben; ningún marcador previo cambia de icono.
- **Bordes ELIMINADOS por arquitectura (no chequear):**
  - 2º-mapa-en-blanco (era el `#dirty` consume-once) → imposible: la señal es intrínseca (`uploaded < count` / identidad de objeto), no un flag global.
  - marcador invisible por variante tardía → imposible: append asigna celda antes del próximo `sync`.
  - corrupción de marcadores existentes al crecer → imposible: encoding normalizado por `C` fijo.
  - orden de montaje de mapas → irrelevante: cada binding es monótono e independiente.

---

## 5. IconSet (sin dominio)

MODELO §7.3. Un pack de iconos es un `IconSet` distribuible (módulo JS).

```ts
defineIconSet(cfg: {
  rotates?: boolean
  variants?: string[]                         // espacio declarado → preseed
  sizes?: { canvas: number, default: number }
  describe(variant: string): Descriptor       // declarativo: variante → forma/color/badge
  renderers: Record<string, (ctx, size, d) => void>   // imperativo: forma → canvas
  prerender?(): Promise<void>                 // opcional: SVG/imágenes async
}) → IconSet & { ready: Promise<IconSet> }

defineClusterIconSet(cfg: { buckets: number[], draw(ctx, size, count) → void }) → IconSet
createIcon(descriptor) → IconHandle           // icono suelto, no toca el atlas de una capa
```

| Operación | Complejidad | Notas |
|---|---|---|
| preseed (de `variants`) | O(v) rasterizaciones, una vez | antes del primer render → 0 append en runtime |
| resolver variante nueva (no declarada) | O(1) append + O(1) sync | red de seguridad; `console.warn` en debug |
| `describe`/`renderers` | corren en **append**, no por frame | no tocan el hot-path de GC |

- **Contrato del descriptor (responsabilidad del consumidor):** `describe(variant)` debe ser **total** sobre el espacio de variantes — para *cualquier* string que llegue por `variantOf`, incluidas las que aparezcan recién en runtime (regrow), devuelve un `Descriptor` completo: `shape` ∈ `renderers` y **todas** las props que su renderer lea ya resueltas. El core no valida ni rellena defaults; una prop faltante **no lanza**, degrada en silencio al default del canvas (p. ej. `fillStyle` inválido → negro) → se ve como "ícono correcto, mal pintado". Anti-patrón: derivar una prop vía `LISTA.indexOf(variant)` sobre una lista cerrada precalculada (`-1` para variantes nuevas → prop `undefined`); derivar de la variante misma (hash/parseo) para que sea total por construcción.
- **Reactividad (clave):** asignar `layer.iconSet = pack` es **reactivo** (MODELO §5.4/§7.2): reseed automático (de `pack.variants` ∪ variantes presentes en datos) + rebuild, coalescido a rAF. Reasignar = swap controlado (genera `Atlas` nuevo). **Sin timing privilegiado** (HTML, `<script src module>`, `import()`, swap en caliente — idénticos).
- **`preloadIcons(variants)`** (método de capa): seeding manual idempotente — agrega variantes al seed sin esperar a que lleguen en los datos.
- **Ruta declarativa por nombre:** `map.registerIconSet('flota', pack)` + atributo `icon-set="flota"`; resuelve orden-independiente (mientras no resuelve, la capa usa un IconSet por defecto, nunca en blanco).
- **Test:** definir `variants:['a','b']`, render con datos que usan `'a'` → 0 append en runtime (todo preseed). Llega un `'c'` no declarado → exactamente 1 append, 0 repack, marcador visible.
- **Bordes ELIMINADOS:** los listados en §4.2 (todos derivan del atlas). **Borde que requiere manejo:** `prerender()` que rechaza → `ready` rechaza; la capa sigue con el IconSet por defecto (no rompe).

---

## 6. MapEngine (núcleo headless)

Framework-agnostic; sin Lit, sin React, sin dominio. `<cristae-map>` es una piel fina sobre esto.

```ts
new MapEngine({ container: HTMLElement, view?: { center, zoom }, /* defaults neutros */ }) → engine
new MapEngine({ host: adoptLeafletHost(map, { leaflet? }), … }) → engine
```

`model?: EarthModel` —`sphere()`, `ellipsoid()` o `WGS84`— es el modelo con que el motor coloca y pica la capa de formas, ubica las manijas de los editores de forma y curva `addGeodesic`. Sin él, la esfera por defecto. Se lee en el alta y no se cambia después: no re-tesela. Un valor que no es un modelo, un terreno o un modelo sin las marcas de destino y rumbo lanzan `TypeError` antes de crear nada. El alias `addCircleLayer` no lo lee: sigue en la esfera por defecto (§18).

| Método | Tipo | Complejidad | Notas |
|---|---|---|---|
| `addPointLayer(cfg) → handle` | acción | O(1) + preseed | crea capa + store interno |
| `addPolygonLayer(cfg) → handle` | acción | O(1) | |
| `addShapeLayer(cfg) → handle` | acción | O(1) | círculos, elipses y sectores en metros (§8.7) |
| `addEditableLayer(cfg) → handle` | acción | O(1) | editor de una geometría, input controlado (§8.8) |
| `addCircleLayer(cfg) → handle` | acción | O(1) | `@deprecated`, se retira en 1.0: alias de la capa de formas (§8.7) |
| `addLabelLayer(cfg) → handle` | acción | O(1) | standalone o `bindTo` |
| `attachSource(id, source)` | acción | O(1) | ruta B/C; interno del setter `.source` de la capa |
| `removeLayer(id)` / `getLayer(id)` | acción | O(1) | |
| `addGeodesic({ hostId }) → off \| null` | acción | O(1) + el rearmado del host | curva el host sobre la geodésica del modelo del mapa; `null` si no se curva (§8.6) |
| `registerIconSet(name, set)` | acción | O(1) | resuelve capas pendientes por nombre |
| `createIcon(descriptor)` | acción | O(1) | |
| `on(event, layerId?, cb) → off` | acción | O(1) | suscripción por capa |
| `getLeafletMap()` | escape | O(1) | el mapa de Leaflet, **fuera de contrato** (abajo) |
| `destroy()` | acción | O(layers) | cancela rAF pendientes, quita listeners, libera bindings y suelta el mapa (abajo) |
| `ready: Promise` | — | — | resuelve cuando el mapa tiene vista, y no si el motor se destruye antes; la señal `ready` sale en el mismo momento |

- **Leaflet es el anfitrión.** El motor lo usa para la cámara, la superficie donde dibujan las capas, los tiles y la entrada cruda del navegador —lo que costaría rehacer—; el dibujo, el picking, el cursor, los controles y el ruteo del puntero son de Cristae. Es un detalle interno: ningún valor de la API es un objeto suyo (§0), y `adoptLeafletHost` es el único punto de integración con un Leaflet ajeno.
- **El mapa:** sin `host`, el motor crea su propio mapa sobre `container` —con `preferCanvas`, sin el fundido de tiles ni la animación de marcadores de Leaflet y sin controles: el zoom y la atribución los dibuja `<cristae-map>`, y sin él la atribución la da `getTileAttribution()` ([`docs/tiles.md`](./docs/tiles.md#la-atribución))—, con la vista inicial de `view` (default `[0, 0]`, zoom 2) y los límites de la cámara (§9), y `destroy()` lo remueve. Con `host` trabaja sobre un mapa que ya existe, adoptado con `adoptLeafletHost(map, { leaflet })`: el mapa sigue siendo de quien lo creó, y `destroy()` le quita los listeners del ciclo de vista y del arrastre, la política de zoom de §9 y la capa de tiles que le puso, con el pane de su retención, le devuelve los límites de la cámara que tenía si el motor le puso los suyos (§9), y lo deja vivo. Un mapa adoptado es de un solo motor. `leaflet` es el Leaflet que construyó el mapa (default: el de Cristae): con dos copias en la página, las capas del motor tienen que salir de la del mapa.
- **`getLeafletMap()` está fuera de contrato.** El mapa de Leaflet es el anfitrión del motor y un detalle suyo: lo que se haga con el mapa crudo —un control, un evento, un pane— no tiene garantía entre versiones, y Cristae no lo prueba. Sigue devolviéndolo, y avisa por consola la primera vez que se lo pide cada motor. Se retira en 1.0; lo que se bajaba a buscar ahí lo dan la cámara (§9), los tiles (`setTileProvider`), el cursor (`setCursor`) y las señales del motor.
- **Sin globals:** el motor no lee ni escribe `window.L`, y `<cristae-map>` no registra plugins: los puntos, las líneas y los polígonos se dibujan con la superficie WebGL de cada capa ([`docs/render.md`](./docs/render.md)), y el Leaflet que usa el mapa propio es el de Cristae.

---

## 7. Elemento `<cristae-map>` (Lit)

### 7.1 Atributos / props reactivas (estado → reactivo, MODELO §5.4)

| Nombre | Tipo | Atributo serializable | Reactivo a | Efecto |
|---|---|---|---|---|
| `tile` | `{url, attribution, maxZoom, className, updateWhenIdle?, keepBuffer?}` | sí (JSON) | cambio | re-provee tiles |
| `theme` | CSS vars sobre `:host` o un ancestro | vía CSS | — | label-layers leen `--cristae-*`; `--cristae-map-background` y `--cristae-tile-filter` son, en vivo, el fondo del contenedor y el `filter` de los tiles y de la foto de la retención |
| `initial-center` | `LatLng` | sí | **no** (solo al montar) | fija la vista inicial una vez (uncontrolled, como `defaultValue`). Recentrar vivo = cámara imperativa (§9) |
| `initial-zoom` | number | sí | **no** (solo al montar) | idem |
| `world-copies` | boolean | sí | cambio | `noWrap`: los tiles se repiten fuera de ±180; no limita la cámara (§9) |
| `no-zoom-control` | boolean | sí | cambio | quita el zoom del elemento ([`docs/elements.md`](./docs/elements.md#cristae-map)) |
| `viewport-insets` | `{top,right,bottom,left}` | sí | cambio | compensa UI que ocluye; lo usan `panTo/flyTo/fitBounds/fitToLayer` |
| `hover-throttle` | ms | sí | cambio | throttle de `pointermove`→picking |
| `model` | `EarthModel` | **no** (objeto: prop) | **no** (solo al montar) | modelo de la Tierra de las formas y las geodésicas (§6); un terreno o un modelo sin las marcas lanza `TypeError` |
| `cursor` | valor CSS de `cursor` | sí | cambio | cursor del contenedor; precedencia en [`docs/interaction.md`](./docs/interaction.md#el-cursor-del-contenedor) |
| `zoom-animation` | `'none'` \| `'in-only'` \| `'on'` | sí | cambio | política de animación del zoom (§9); default `'none'` |
| `min-zoom` / `max-zoom` | number | sí | cambio | topes del zoom (§9) |
| `max-bounds` | `Bounds` \| `null` | sí (JSON) | cambio | caja de la que la cámara no sale (§9) |
| `max-bounds-viscosity` | 0..1 | sí | cambio | cuánto resiste al arrastre el borde de `max-bounds` (§9) |
| `drawingIndicator` | `(indicator: HTMLElement) => void` \| `null` | **no** (función: prop) | cambio | altera el indicador del estado de dibujo; `null` lo quita (abajo) |
| `stale-tolerance-px` | px | sí | cambio | tolerancia de staleness del picking (avanzado) |

- **Indicador de dibujo:** mientras el motor está en el estado de dibujo (`drawingstart`/`drawingend`, §10), el elemento muestra en su shadow root un elemento con `part="drawing-indicator"` que cubre el mapa entre el estado vacío y las zonas, sin puntero, con la base como hijo: `aria-hidden`, sin texto y en `currentColor`. El contenedor trae un color por defecto, que `::part(drawing-indicator) { color }` pisa. Que la base viva en los hijos y pinte en `currentColor` es contrato; su aspecto no. El elemento es nuevo en cada entrada al estado y se va entero al salir y en `disconnectedCallback`; un `draw→edit→draw` en el mismo update no lo rehace. Con el motor solo no hay indicador: el chrome es del elemento.
- **`drawingIndicator`:** recibe el indicador recién creado, ya conectado, y lo altera; no devuelve nada. Corre en `updated`, sin rAF, una vez por entrada al estado y otra al asignarle otra función mientras dura, siempre sobre un elemento nuevo, nunca sobre uno vaciado. Corre con `safe` (§1): lo que lance va a `console.error` y el update sigue. Ausente o `undefined`, queda la base; `null`, ningún indicador, y el estado sigue.
- **Lo que la función agrega vive en el shadow root:** no le llega el CSS de la página, y se estila con `style` o con un `part` propio. Un hijo con `pointer-events: auto` toma la pulsación antes que el editor. En React la prop va por propiedad y se compara por referencia, así que una lambda en línea rehace el indicador en cada render. Lo que la función toque fuera del indicador no se deshace al salir.
- **`initial-center`/`initial-zoom` uncontrolled:** se aplican una vez al montar; el gesto del usuario y la API de cámara mueven el mapa libremente sin reescribir nada. El recentrado vivo (seguir/buscar/encuadrar) es **acción** (§9), no estado — ver MODELO §5.4 para el porqué (el híbrido controlado-una-vía hace que "volver a X" sea no-op por idempotencia). El gesto igual emite `cristae:viewportchange` por si el consumidor quiere observar. **Borde eliminado:** loop de feedback atributo↔gesto (no existe prop reactiva de centro).

### 7.2 Métodos (acción → imperativo)

`addPointLayer`, `addPolygonLayer`, `addLabelLayer`, `removeLayer`, `getLayer`, `attachSource`, cámara (§9), `createIcon`, `registerIconSet`, `syncSize()`, `invalidateCanvas()`, `destroy()`, `ready`.

- **`syncSize()`**: resize del contenedor — `map.invalidateSize()` + reajuste del FBO de picking + **redibujo de las capas de puntos** (`invalidateSize()` solo emite `move`/`moveend` si el resize desplaza el centro, así que un resize simétrico limpiaría el canvas de la capa sin redibujarlo). Llamado por el `ResizeObserver` interno del elemento; el consumer raramente lo necesita.
- **`invalidateCanvas()`**: reposiciona y redibuja todas las capas de puntos. Escape hatch manual: con `<cristae-map>`, resize y show-tras-`display:none` ya se auto-curan vía el observer → `syncSize()`; este método es para el motor headless (sin elemento, sin observer) o el raro show sin cambio de tamaño. Varios motores en la página son independientes: cada capa tiene su contexto, así que `destroy()` de uno no toca a los demás.

### 7.3 Lifecycle

- **Montaje:** `firstUpdated` monta el motor (guard `#mounted`). En **reconexión** tras un `disconnectedCallback`, `connectedCallback` **re-monta** (firstUpdated no re-dispara) con un motor **nuevo**; las capas hijas montan solas (su `connectedCallback` vuelve a pedir montaje y, como el del mapa corre primero, ya encuentran el motor).
- **Destrucción:** `disconnectedCallback` → `engine.destroy()` (el mapa es propio del motor: lo remueve y suelta el contexto WebGL). Desconectar el elemento del DOM (`remove`/reparent/`innerHTML` en un ancestro) **destruye el mapa** — no es un `<div>` reposicionable.
- **No cachear handles:** `engine`/`camera` son getters vivos sobre el motor **actual**; tras un re-mount son otra instancia. El consumidor lee siempre el getter, nunca una copia.
- **Readiness:** `ready` es una promesa **one-shot por instancia** (creada en construcción → disponible síncrona; resuelve al primer motor listo). El evento `cristae:ready` se **re-emite en cada (re)montaje** — es la señal para reenganchar tras un reattach.
- `ResizeObserver` sobre el host → `engine.syncSize()` (`invalidateSize` + `syncPickingSize`). El consumidor **no** llama resize a mano; crear oculto (`display:none`) y mostrar después se sincroniza solo.
- **Apilado:** orden de los hijos en light DOM = orden de render (atrás→adelante); atributo `z` opcional. El motor deriva los panes; el consumidor no toca z-index (MODELO §6).
- **Borde eliminado:** doble-montaje (guard `#mounted`); capa/iconSet declarados "tarde" (reactividad orden-independiente).

---

## 8. Elementos de capa hijos

Ejes **comunes a toda capa hoja** (viven en la base, ninguna subclase los declara): `pane`/`z` (apilado, MODELO §6) y `focus-ids` (enfoque por ítem). Consumo detallado en [`docs/elements.md`](./docs/elements.md).

- **`pane` — un nodo por nombre.** Las capas con el mismo `pane` dibujan en el mismo nodo, que vive mientras quede una y se va con la última; un alta que lanza no lo sostiene. Un nombre que el mapa ya tenía —un pane de Leaflet, como `overlayPane`, o uno que creó el dueño de un mapa adoptado (§6)— se usa prestado: las capas lo configuran mientras lo usan, y al irse la última queda en el mapa con el estilo que tenía.
- **`focus-ids` — polaridad y tres estados.** Se declara lo que queda **brillante**; se atenúa todo lo demás. AUSENTE = la capa no participa del eje; presente con ids = esos ítems plenos; presente y **vacío** (`""`/`[]`) = participa sin ninguno → todo atenuado. El converter distingue los tres (colapsar ausente con vacío borra un estado, no un caso de borde). Imperativo equivalente: `engine.setLayerFocus(id, ids)`, con `undefined` para retirar la capa del eje.
- **Cross-layer, resuelto en un punto único.** Mientras **alguna** capa lo declare se atenúan todas las capas (el basemap no es capa) y cada una repone los suyos; las ligadas por `bind-to` siguen la suerte de foco de su host. El eje por CAPA (`engine.focus(ids, {opacity, kinds})`) **EXIME**: la capa que nombra queda plena **y fuera** del eje por ítem — contrato del spider de un cluster, que no declara ítems y no puede atenuarse a sí mismo. `kinds` acota **qué se atenúa**, no qué se recompone (el resolutor recorre todas las capas siempre). La atenuación del eje por ítem es propia y fija; `opacity` es el parámetro del eje por capa.
- **La membresía del dibujo manda sobre el foco.** El foco MODULA lo que la capa ya dibuja: un id enfocado que no está en el dibujo (filtrado, clusterizado, `positionOf` no finito, fuera del `where`, capa `enabled=false`) **no aparece**; ids inexistentes o de otra capa no pintan nada.
- **Atenuar es presentación, no gating.** Lo atenuado sigue **interactivo** (§10) y sigue contando para los modificadores que lo consumen. Sacar del dibujo es `visible`; sacar de la composición es `enabled`.
- **La opacidad de una capa no es estado declarativo:** es acción (`engine.setLayerOpacity(id, alpha)`). El atenuado declarativo es este eje.

### 8.1 `<cristae-point-layer>`

| Entrada | Tipo | Reactiva | Efecto |
|---|---|---|---|
| `.data` (prop) | `Item[]` | sí | `set` → patch/rebuild (§5.3 MODELO) |
| `.accessors` (prop) | objeto de accessors | sí | reemplazo → re-deriva + rebuild |
| `.iconSet` (prop) / `icon-set` (attr nombre) | IconSet / string | sí | reseed + rebuild (§5) |
| `.filters` (prop) | `[{id, predicate, deps?, rebuild?}]` | sí | reconciliación **por `deps`** (mismo `id` + `deps` distinto = replace; `deps` igual = no-op; sin `deps` = identidad de `predicate`) + rebuild. Ver MODELO §5.3 |
| `visible`/`interactive` | bool/bool (attrs) | sí | aplica en el próximo frame |
| `focus-ids` (attr) | token-list \| array \| vacío | sí | eje de enfoque por ítem (§8 intro) |
| `auto-fit` (attr) | `"once"` | — | encuadra la capa al primer snapshot no vacío (una vez), vía `camera.fitToLayer`; se desuscribe tras encuadrar |
| `pane` / `z` | string/number (attrs) | — | apilado |
| **métodos** | `set/patch/move/remove`, `addFilter/removeFilter`, `preloadIcons(variants)`, `refresh()` | acción | §3, §5 |

- **`refresh()`** (acción): re-evalúa los **mismos** accessors cuando su salida varía en el tiempo (recolor por antigüedad/latencia). Distinto de reemplazar `.accessors` (eso es reactivo). **No** es el `invalidateSize` de Leaflet (ese es resize de contenedor, interno).
- Complejidad: `refresh()` = O(n) re-evaluación de `variantOf`/`versionOf` + patch.

### 8.2 `<cristae-polygon-layer>`

| Entrada | Tipo | Notas |
|---|---|---|
| `.data`, `.accessors` (`idOf, ringsOf, styleOf?, hoverStyleOf?`) | — | hit-testing por `geometry/` (point-in-poly + índice espacial), O(log n) por query |
| `hoverStyleOf?` | `(item) → style` | restyle **transitorio** de path en hover (barato, sin rebuild) |
| `visible/interactive` | — | |
| `color/weight/opacity/fill-color/fill-opacity` (attrs o props) | string/number | estilo de capa, el de `addPolygonLayer`; reactivo por `handle.style`, y `styleOf` lo pisa por polígono |
| `stroke/fill` (attrs) | bool, default `true` | prenden o apagan el trazo y el relleno de la capa entera; se leen **al montar** |

### 8.3 `<cristae-label-layer>` y `<cristae-cluster>`

```html
<cristae-point-layer id="fleet">
  <cristae-label-layer bind-to="fleet"></cristae-label-layer>
  <cristae-cluster radius="88" max-zoom="18" min-points="2"></cristae-cluster>
</cristae-point-layer>
```

- **label-layer:** standalone (`source` propio) o attachment (`bind-to="<layerId>"`, deriva posiciones + `textOf` del host). `bind-to` resuelve por nombre, orden-independiente.
- **cluster:** `radius/max-zoom/min-points/icon-set` **reactivos en runtime** (reconfig sin recrear la capa). Supercluster: build O(n log n), query O(1) por zoom (no se reescribe — MODELO §13).
- **Borde eliminado:** `warmup()` de ~278 buckets de cluster → el atlas append-only lo hace innecesario.

### 8.4 `<cristae-table>` / `PagedTable` (standalone — fuera de `<cristae-map>`)

**No es una capa.** Vive en `table/`, no se monta dentro de `<cristae-map>` y solo importa de
`data/` + `lit` (invariante de capas, MODELO §3.1; sin Leaflet). Consume **solo la cara de
lectura** del `Source` (§2): `getSnapshot()` + `subscribe(cb)`; ignora `accessors`/`positionOf`/
`variants` (geometría de mapa). Proyecta filas con `template` (HTML con `data-ref`) + `binder`
(`(refs, item, rowNumber) → void`) — su análogo domain-free de los accessors. Doc completa:
[`docs/table.md`](./docs/table.md).

| Entrada | Tipo | Reactiva | Efecto |
|---|---|---|---|
| `.source` (prop) | `Source` | sí | `attach` → snapshot inicial (hard) + re-read por notify (suave). Gana sobre `.data`. |
| `.data` (prop) | `Item[]` | sí | `setData` (array plano, sin reactividad) |
| `.template` / `.binder` (prop) | string / función | sí | molde + poblado de la fila |
| `.comparator` / `.searchBy` / `.searchFilter` (prop) | funciones | sí | orden del slice / campo y predicado de búsqueda |
| `.where` (prop) | `(item) → boolean` | sí | membresía de ESTA tabla, antes del text-search (N tablas sobre una Source, cada una su subconjunto; `addFilter` es el filtro compartido) |
| `row-height` / `page-size` / `max-buttons` (attr) | number | sí | layout / paginación |
| `search` / `count-label` / `scroll-height` (attr) | string | sí | búsqueda controlada / pie / alto |
| **acceso** | `controls` → `PagedTable` (`setPage/setSearch/setPageSize/setWhere/refresh/itemAtRow`) | acción | — |
| **evento** | `cristae:rowclick` → `{ item, row }` | — | delegación vía slice visible |

- **Una source, N vistas:** el filtro/estado vive en el `Source` (computado una vez). La misma
  `createSource` adjunta a un point-layer y a una `<cristae-table>` no filtra dos veces.
- **Optimizaciones (no se tocan):** scroll virtual (pool DOM + spacers, O(v) nodos), quickselect
  Floyd-Rivest para el borde de página (O(n), no orden total), reuse de `workingSet` [0-alloc],
  batching a rAF, `ResizeObserver`. **Guard de visibilidad** nativo (flag + `IntersectionObserver`):
  fuera de pantalla no corre el pipeline; corre una vez al reaparecer. Reemplaza el plugin que
  parcheaba métodos (MODELO §3.1).
- **Complejidad del pipeline:** O(n) merge/filter + O(n) quickselect + O(k·log k) orden del slice +
  O(v) render, coalescido a 1 rAF. Notify del Source = refresh suave (conserva página/scroll).

### 8.5 `<cristae-popup>` (overlay — no es capa)

Tarjeta HTML anclada al dato. **No** dibuja en GL ni se monta como capa: vive en **light DOM** (nodo
flotante en `document.body`) para que el CSS de página aplique — un popup de Leaflet caería en el shadow
root del mapa. Hijo de `<cristae-map>`.

| Entrada | Tipo | Notas |
|---|---|---|
| `for` (attr) | string (token-list) | ids de las capas cuyos hits la abren — hermanas que presentan los MISMOS datos (idealmente la misma instancia de `Source`) |
| `contentOf` (prop) | `(item) → string \| Node` | la lib resuelve el item por `source.itemById(hit.id)` del hit |
| `offset` (prop) | `[dx, dy]` px | default `[0, -12]` |
| `follow` (attr) | boolean | default `true`; ancla VIVA (sigue la posición del item por flush del `Source`). `"false"` → congelada al punto de apertura |
| `max-open` (attr) | number | default `1` (abrir reemplaza); N>1 → una tarjeta por item, la más antigua cae al exceder el cupo |
| `pinned` (attr) | boolean | default `true`; fija al punto geo (sigue al mapa). `"false"` → fija en pantalla |
| `clip` (attr) | boolean | default `true`; recorta lo que sobresalga de la región visible (mapa − `viewport-insets`). `"false"` → desborda |
| `auto-pan` (attr) | boolean | default `true` (como Leaflet); `"false"`/`"0"` lo apaga |
| `auto-pan-padding` (attr) | `[x, y]` px | default `[20, 20]`; margen al borde visible |
| **métodos** | `open(item, latlng?)` / `close(id?)` / `refresh()` | acción — sin `latlng` el ancla es viva; `close(id)` cierra por id de dato, `close()` todas; `refresh()` re-ejecuta `contentOf` de lo abierto sin panear |

- Se posiciona con `camera.latLngToContainerPoint` (§9) y se reubica en `viewportchange`/scroll/resize.
- **Vida por flush del `Source`** (una suscripción por tarjeta, ya coalescida a rAF — mismo patrón que
  `Camera.followPoint`): (1) el id salió del dataset (remove / `set` sin el item / filtro que lo
  excluye — `itemById` lee la vista filtrada) → la tarjeta se cierra; (2) el objeto del item fue
  REEMPLAZADO (`set`/`patch`) → `contentOf` se re-ejecuta con el fresco; (3) su posición cambió y el
  ancla es viva → re-ancla SIN re-render (un `move` nunca re-ejecuta `contentOf`; comparación a
  primitivos, [0-alloc] en el camino caliente). El callback va aislado con `safe` (§ data/safe.js):
  un `contentOf` que lance no corta el fan-out del Emitter al resto de los suscriptores. Un `latlng`
  explícito en `open` congela el ancla (colocaciones presentadas por overlay/spider). El nodo
  `.cristae-popup` se crea por apertura y se remueve al cerrar (con `max-open` puede haber N nodos).
- **Reposición continua:** `viewportchange` llega al asentarse el movimiento, no durante (baja frecuencia por contrato, §10), así que para seguir el paneo/inercia EN CONTINUO la tarjeta oye además el `move` del motor (§10); se re-vincula por montaje en `cristae:ready`. Sin esto, la tarjeta y su clip saltaban recién al detenerse el mapa.
- Escucha los eventos de la lib en el **elemento mapa** (no en el engine) → sobrevive a un re-mount y lee la cámara viva.
- **`pinned` (default ON):** re-proyecta el ancla en cada reposición → la tarjeta sigue el pan/zoom. `pinned="false"` congela el punto de contenedor inicial (por tarjeta) → fija en pantalla, ajena a pan/zoom y al ancla viva (acompaña solo el scroll del widget).
- **`clip` (default ON):** `#applyClip` setea `clip-path: inset(...)` con la fracción que sobresale de la **región visible = rect del mapa − `viewport-insets`** (los mismos insets que usa auto-pan; así la tarjeta no se monta sobre los widgets/paneles). Geometría derivada del **tamaño cacheado al renderizar** (open/re-render; re-medido por `ResizeObserver` si el contenido cambia) + transform base-centro → **cero `getBoundingClientRect` del nodo por frame** (el único rect leído por reposición es el del mapa, que ya se leía). Recorte de compositor, sin relayout.
- **Auto-pan al abrir (solo `pinned`):** si la caja se sale de la región visible (contenedor − `viewport-insets`), `open` llama `camera.panBy` con el delta en px justo para meterla + `auto-pan-padding`. Mismo cálculo que el `_adjustPan` de Leaflet pero contra los insets del mapa. El `panBy` re-dispara `viewportchange` → reubica sobre el ancla viva (no re-evalúa auto-pan: solo `open`). Sin `pinned`, panear no movería la tarjeta → se omite.

### 8.6 `<cristae-geodesic>`

```html
<cristae-geodesic><cristae-line-layer id="vuelos"></cristae-line-layer></cristae-geodesic>
```

- **Modificador `map`**: `{ consumes: ['line', 'polygon'], produces: ['geodesic'], combine: 'map', arity: 'wrapper' }`, con una
  unit `geodesic` por host. Los editores de polilínea y de polígono producen `line` y `polygon`, así que los envuelve;
  envolver sólo algo que no se curva —rectángulo, formas, puntos, labels, html— es el error R2, y un hermano que
  no consume pasa intacto.
- **`enabled`** (default `true`; `"false"` o `"0"` como atributo): en `false` dibuja rectas sin desmontar al hijo. No lleva
  modelo ni tolerancia: la curva usa el modelo del mapa y los 0,1 m de `geodesic` (§18).
- **Ruta imperativa**: `engine.addGeodesic({ hostId })` llama `setCurve(model)` del host y devuelve su baja, o `null` si
  el host no es una capa de líneas o de polígonos ni un editor de polilínea o de polígono, o es una capa de polígonos
  tipada e `interactive: false`, que no retiene sus tablas. No hay registro ni id: la curva es estado del host y muere con
  él. La baja sólo limpia si la curva sigue siendo la suya —un segundo alta la reemplaza y deja inerte a la anterior— y no
  hace nada tras `removeLayer(host)`.
- **`_handle` es un marcador**: sin operaciones, no es una capa del motor. Quitar al hijo destruye su curva.

### 8.7 `<cristae-shape-layer>`

| Entrada | Tipo | Notas |
|---|---|---|
| `.data`, `.accessors` (`idOf, positionOf, radiusOf, headingOf?, sweepOf?, styleOf?`) | — | cada ítem es una forma `{ center, radius, heading?, sweep? }`: `radiusOf` en **metros**, un número es un círculo y `[a, b]` una elipse; con `sweepOf`, un sector |
| `.source` (prop) | `Source` | gana sobre `data`; se lee **al montar** |
| `visible`/`interactive` | bool, default `true` | — |
| `color/weight/opacity/fill-color/fill-opacity` | string/number | estilo de capa, el de §8.2; reactivo por `handle.style`; `styleOf` lo pisa por forma |
| `stroke/fill` | bool, default `true` | se leen **al montar** |
| `focus-ids`, `pane`/`z` | — | ejes comunes (§8) |

- **Hoja de la gramática**: `{ consumes: [], produces: ['shape'], combine: null, arity: 'leaf' }`; ningún modificador la consume. El handle es `{ id, source, set, setVisible, style }`.
- **Una regla de validez**, la de `ring` (§18): `null`/`undefined` toman el default, un número presente que la forma usa y no es finito la descarta, y el radio y `sweep` además si son ≤ 0.
- **El modelo es el del mapa** (§6): la forma se coloca y se pica con sus destinos, y el motor no admite un modelo que no los ubique.
- **El tamaño es de la figura entera**: `camera.fitToLayer`/`fitToLayers` encuadran la caja que la capa informa de lo dibujado, no sus centros.
- **Hit**: `{ kind: 'shape', id, ref: id, distancePx: 0 }`, resuelto por punto-en-anillo sobre las mismas tablas del dibujo, así que el borde que se ve es el que pica; de varias formas superpuestas sale primero la última de `data`. Los vértices por forma y el tope de textura, en [`docs/shapes.md`](./docs/shapes.md#costo).
- **Complejidad**: un cambio de la Source rehace todos los anillos y sube la textura entera, O(vértices); al asentar el zoom sólo rehace si alguna forma pide otro número de vértices. Sirve para cientos de formas, no para un feed de miles a alta frecuencia. Cifras en [`docs/shapes.md`](./docs/shapes.md#costo).
- **`addCircleLayer`** es un alias `@deprecated` de esta capa: dibuja y pica en la esfera por defecto aunque el mapa traiga otro `model`, lee sólo `radiusMetersOf`, ignora `headingOf`, `sweepOf` y el estilo de capa, devuelve `{ id, source, set, setVisible }` y sus hits llevan `kind: 'circle'` en el orden de `data`. Se retira en 1.0; la guía de migración está en [`docs/shapes.md`](./docs/shapes.md#migrar-desde-addcirclelayer).

### 8.8 `<cristae-editable-*>`

Siete elementos —`polygon`, `polyline`, `point`, `rectangle`, `circle`, `ellipse` y `sector`— y `engine.addEditableLayer({ kind, … })` como su alta imperativa. No son capas de dato: sin `source` ni accessors, su dato es **una** geometría y su contrato es el de un input controlado ([`docs/editing.md`](./docs/editing.md)).

- **Hoja de la gramática** `{ consumes: [], produces: ['edit'], combine: null, arity: 'leaf' }`; el de polilínea produce `line` y el de polígono, `polygon`, que `<cristae-geodesic>` consume (§8.6).
- **`value` entra, los cambios salen**: `cristae:change` por frame y `cristae:commit` una vez por gesto. El valor se lee con un getter, y el eco que vuelve por referencia no se reingiere.
- **`mode`**: `'edit'` (default) y `'draw'`; `'freehand'` sólo en `polygon` y `polyline`, y en los demás es inerte. En `draw`, la pulsación de un dedo o un lápiz es del editor: la figura empieza donde se apoya, el punto siguiente queda donde se levanta, y el mapa se mueve con dos dedos. En `freehand` el puntero traza y al soltar el trazo se simplifica en px (Douglas–Peucker, 2 px), se suaviza con una Catmull-Rom centrípeta que no se aparta de cada cuerda más que el trazo (así quedan vivas las esquinas) y se hornea como vértices de una polilínea o un anillo común, con un solo `change` y un solo `commit`. Continúa lo abierto y reemplaza lo cerrado: el trazo de la polilínea se suma al final del valor, y el del polígono lo reemplaza por un anillo simple.
- **Los de forma** (`circle`, `ellipse`, `sector`) editan una `Shape` con el radio de su tipo —`{ center, radius }`, `{ center, radius: [a, b], heading }`, `{ center, radius, heading, sweep }`— por las manijas de centro, radio, rumbo y apertura. Se ubican con el `model` del mapa y se dibujan con la esfera mientras dura el gesto. La rotación de toda forma es `heading`. El sector de elipse se dibuja en la capa de formas pero no se edita.
- **Mínimos, cierre y polo**: un radio no baja de 24 px a la vista y la apertura no acerca la punta a un borde a menos de eso; el borde que llega por detrás a esa distancia del otro, o que pasa al otro lado, fija `sweep` en 360 hasta que el puntero vuelve por su lado; y el arrastre que llevaría el borde a un polo no se aplica ni emite.
- **Curva geodésica**: envuelto por `<cristae-geodesic>`, el editor de polilínea o de polígono dibuja cada tramo sobre la geodésica del modelo del mapa; las manijas quedan en los vértices del `value`, que no gana puntos.
- **Contexto GL**: cada editor toma un contexto WebGL, del techo de ~16 del navegador: se monta uno por vez.

---

## 9. Cámara

Todo **acción** (no estado): es la **única** vía de movimiento de viewport tras el montaje. Las props `initial-center`/`initial-zoom` solo fijan la vista inicial (§7.1). No hay prop reactiva de centro (MODELO §5.4). Aplica `viewport-insets`.

| Método | Complejidad | Notas |
|---|---|---|
| `setView(latlng, zoom)` / `panTo(latlng)` | O(1) | inmediato; `latlng` en cualquier forma de punto (§18) |
| `flyTo(latlng, zoom)` | O(1) | vuela si la política de animación del zoom anima el destino (abajo), y si no es un `setView`; el easing es opción de `flyTo`, no un método aparte |
| `fitBounds(bounds, {insets, maxZoom, animate})` | O(1) | `bounds` es una caja (§18); lo que no lo es no mueve la cámara ni corta el follow. `maxZoom` topa el zoom antes de centrar —uno que no es un número finito no topa, como en los límites—, así que la caja queda en el medio de la región visible también cuando el tope corta. `animate: false` no anima nada; con `true` el paneo anima aunque sea largo. Un cambio de zoom anima sólo si además lo anima la política (abajo) |
| `fitToLayer(layerId, {insets, maxZoom})` | O(1) con la caja de la capa de formas o de polígonos; O(n + puntos insertados) con la de líneas curvadas, que densifica otra vez; O(n) (caja de n puntos) sin caja, o con la `version` de la Source de las formas avanzada y sin emitir, que se dibuja antes | encuadra una capa por la caja que informa de lo que dibuja —la de formas y la de polígonos: la figura entera, no sólo los centros; la de líneas, sólo la curva geodésica— o, sin ella, por sus posiciones; con el `maxZoom` de `fitBounds`. Lee los accessors de la capa: el error de uno le llega al llamador |
| `revealPoint(layerId, id, {zoom})` | O(results·log maxZoom) si clusteriza | enfoca un punto (one-shot) dejándolo **visible individualmente**: si su capa clusteriza, sube el zoom al mínimo que lo desclusteriza. Sin cluster (o si ya está solo) = `setView` |
| `zoomIn(delta?)` / `zoomOut(delta?)` / `setZoom(zoom)` | O(1) | **ortogonal al follow**: el zoom no cancela un `followPoint` (ajusta escala, no reposiciona) |
| `panBy(offset, options?)` | O(1) | desplaza por delta en **px** de contenedor; **ortogonal al follow** (ajuste fino). Lo usa el auto-pan del popup (§8.5) |
| `followPoint(layerId, id, {zoom, reveal})` | O(1) por update | la cámara sigue la posición **viva** (se actualiza con `move`/`patch` del Source); **sin que el consumidor bombee**. `reveal:true` arranca al zoom mínimo desclusterizado |
| `stopFollow()` | O(1) | |
| `getMinZoom()/getMaxZoom()` | O(1) | zoom efectivo en cada extremo: el límite si lo hay y, si no, lo que permiten las capas; cuando cambian sale `zoomlevelschange` (§10) |
| `getCenter()/getZoom()/getBounds()` | O(1) | `LatLng`, número y `Bounds`, con la longitud de la vista sin envolver: pasa de ±180 cerca del antimeridiano y con copias del mundo (§18.1) |
| `latLngToContainerPoint(latlng)` / `containerPointToLatLng(point)` | O(1) | proyección píxel ↔ geo **relativa al contenedor** → `Point` / `LatLng`; ancla overlays HTML en light DOM sin bajar a `getLeafletMap()` |

- **Posiciones:** los encuadres, `revealPoint` y el follow leen `positionOf` con la regla de lugar de §18 —números finitos y la latitud en [-90, 90]—; una posición que no la cumple no entra a la caja ni mueve la cámara. Un encuadre sin ninguna posición válida no encuadra ni aplica `maxZoom`.
- **Puntos:** `setView`, `panTo`, `flyTo` y `latLngToContainerPoint` leen `latlng` con la forma de punto de §18; lo que no la tiene, o no trae dos números, lanza. La latitud no se acota: la proyección la lleva al rango del mapa.
- **Animación del zoom** (`zoom-animation` del elemento, `zoomAnimation`/`setZoomAnimation` del motor): la política juzga cada zoom por sus dos extremos, lo pida quien lo pida —la rueda, el doble click, el teclado, los botones, la cámara, el cierre del pinch o `flyTo`—. `'none'` no anima ninguno; `'in-only'` anima los que no alejan, porque al alejar los tiles viejos se encogen mientras el fondo más amplio entra de golpe; `'on'` anima todos. El cierre del pinch lleva el zoom fraccionario del gesto al ajustado, y ese tramo es el que se juzga: con `'in-only'`, si el ajuste aleja, salta. El gesto mismo sigue a los dedos en todos los modos: cada cuadro redibuja las capas en la vista del gesto, y los tiles se piden durante él, también en un móvil. Un `flyTo` que la política no anima es un `setView` al destino, y un `setView` o un cierre del pinch que no cambian el zoom no son un zoom: su paneo lo anima Leaflet. Sin modo, `'none'` en un mapa propio; en uno adoptado (§6) no se interviene, y anima como lo configuró su dueño. Se cambia en vivo y aplica desde el zoom siguiente. Un zoom que se pide mientras otro anima no se juzga: Leaflet lo ignora, con cualquier modo.
- **Límites** (`min-zoom`, `max-zoom`, `max-bounds` y `max-bounds-viscosity` del elemento; las mismas opciones y `setLimits` del motor): el zoom queda entre `min-zoom` y `max-zoom`, lo pida quien lo pida, y el centro, donde la vista no salga de `max-bounds`; si la caja es más chica que la vista, la vista queda centrada en ella. `getMaxZoom()` da el tope que rige: `max-zoom` o, sin él, el de los tiles. La viscosidad va de 0 a 1 —fuera de ese rango se acota— y es cuánto resiste el borde al arrastre: con 0, el default, el arrastre lo cruza y la vista vuelve al soltar; con 1 no lo cruza. Los cuatro van juntos: `setLimits` los fija todos, y el que falta, es `null`, no es un número finito o no es una caja (§18) no limita. El mapa propio nace con ellos, así que la vista inicial ya los cumple; cambiarlos con la vista fuera la trae adentro con un movimiento. En un mapa adoptado (§6) el motor no lee esas opciones: rigen los del dueño hasta que se llame `setLimits`, y `destroy()` se los devuelve (§6). `world-copies` es otra cosa: dice si los tiles se repiten fuera de ±180, y `max-bounds`, hasta dónde llega la cámara. Un solo mundo es `max-bounds` con la caja del mundo y viscosidad 1; si a `min-zoom` el mundo es más angosto que el contenedor, a los costados se ven sus copias o nada, según `world-copies`.
- **`followPoint` (clave):** el motor re-centra cuando la posición del `id` seguido cambia en el Source, coalescido a rAF. Reemplaza el bombeo manual `onVehicleUpdate→panToSmooth` (MODELO §14.1-6).
- **Test:** `followPoint('fleet', 7)`; luego `handle.move(7, lat, lng)` → la cámara re-centra **sin** llamadas del consumidor; un `move` de otro id no mueve la cámara.
- **`revealPoint` / `reveal`:** el zoom mínimo de desclusterización lo calcula `Cluster.declusterZoomFor` (§8.3, puro) y el motor lo **inyecta** en la cámara (`declusterZoomOf(layerId,id)`) leyendo el fold de la capa. La cámara no conoce el cluster — misma inyección que `resolveSource`. Enfocar un elemento seleccionado y que no quede escondido en una burbuja es así un one-shot (`revealPoint`) o un follow que arranca visible (`followPoint({reveal})`).

---

## 10. Eventos

MODELO §8. En el elemento como `CustomEvent` (prefijo `cristae:`) y en el motor vía `engine.on`.

```ts
Hit = { layerId, kind: 'point'|'polygon'|'line'|'shape'|'html'|'circle', ref, id, distancePx, zIndex, order }
// 'circle' sólo lo emite addCircleLayer, deprecada; se retira en 1.0
// orden top-first: zIndex desc, order asc, distancePx asc
```

| Evento | `detail` | Complejidad de emisión |
|---|---|---|
| `cristae:ready` | `{}` | — |
| `cristae:pointermove` | `PointerSample = {lat,lng,x,y}` | O(1), throttled — **barato** (sin picking) |
| `cristae:hover` | `{hits}` | O(H) — el set vigente, en cada resolución que da hits; los cambios del set son los canales `hover:start`/`hover:end` del motor |
| `cristae:click` | `{hits, originalEvent}` | O(H) — todos los hits ordenados; el consumidor desambigua. `originalEvent` es el `pointerup` de la pulsación (un `PointerEvent`) |
| `cristae:mapclick` | `{latlng: LatLng}` | O(1) — click en el vacío, sin ningún hit |
| `cristae:viewportchange` | `{center: LatLng, zoom, bounds: Bounds}` | O(1) — moveend/zoomend, y al cambiar `viewport-insets` mientras el mapa tiene vista, hasta el teardown (sin vista y después, los insets sólo se guardan) |
| `cristae:interactionstart` / `…end` | `{}` | O(1) — para que el consumidor frene su emitter |

- **`move`, sólo en el motor:** `engine.on('move', fn)` avisa cada paso del movimiento —arrastre, inercia, `panBy`, vuelo—, con `{}`; es para lo que sigue la vista en continuo, como la tarjeta de `<cristae-popup>` (§8.5) y el botón central de `<cristae-cluster>`. No tiene evento `cristae:`: la vista que viaja es la asentada, en `viewportchange`.
- **`zoomlevelschange`, sólo en el motor:** `engine.on('zoomlevelschange', fn)` avisa con `{minZoom, maxZoom}` cada cambio de un tope de `getMinZoom()/getMaxZoom()` (§9) —un límite, o una capa que trae los suyos—. Abrir un tope no mueve la vista, así que no sale `viewportchange`; es para la UI que se deshabilita en los topes, como el zoom de `<cristae-map>`. No tiene evento `cristae:`.
- **`drawingstart` / `drawingend`, sólo en el motor:** marcan la entrada y la salida del estado de dibujo, no de un trazo, con `{}`. El estado dura mientras algún editor toma la pulsación para dibujar —`draw` en cualquier kind, o `freehand` en `polygon` y `polyline`—, con el criterio de la puerta del puntero y sin mirar el dispositivo: con el mouse en `draw` el mapa sigue paneando, y el estado igual. `drawingstart` sale con el primero que entra, con su capa ya registrada, y `drawingend` con el último que sale, también por `removeLayer`, con la capa ya quitada; `destroy()` no avisa. No tienen evento `cristae:`: `<cristae-map>` las sigue con su indicador (§7.1).
- **Cursor automático (affordance de interactividad):** el motor pone `cursor:pointer` cuando el puntero cae sobre una feature de una capa interactiva con demanda de **click _u_ hover**, y lo restaura. **No requiere suscribir `cristae:hover`:** una capa clickeable (listener de `cristae:click`) ya muestra el puntero, igual que `.leaflet-interactive` en Leaflet. Para conseguirlo, la sesión de picking de hover (la que sabe si el puntero cae sobre una feature) corre también bajo demanda de click — aunque los EVENTOS `cristae:hover` se sigan emitiendo solo si hay demanda de hover. Implica que un mapa solo-click paga el picking de hover (throttled por `hover-throttle`) por el cursor. El consumidor pide el suyo con `cursor` (§7.1), que gana sobre este y apaga ese picking.
- **Sin `onDisambiguate` en el core:** `click` entrega todos los hits; el popup de desambiguación lo arma el consumidor con el `originalEvent` provisto.
- **La muestra del puntero es una:** `PointerSample` es el detail de `cristae:pointermove`, el segundo argumento de los canales `pointer:move`, `hover`, `hover:start` y `hover:end` del motor y la entrada de los resolvers de cada capa. Llega congelada: la comparten los handlers y el picking del mismo evento. Un click trae la del píxel donde se soltó. Los canales `click` y `secondary-click` entregan el evento del DOM, nunca el de Leaflet.
- **El click lo sintetiza el motor:** es la pulsación quieta del botón primario que no tomó un handle de un editor, con la regla en [`docs/interaction.md`](./docs/interaction.md#la-puerta-del-puntero). El `click` que reconoce Leaflet —también el de `map.fire('click')`— no es un click de Cristae.
- **`hover:end` sin muestra:** cierra con `null` cuando no hay un puntero que lo explique: al salir del mapa, al empezar un gesto de zoom o pan, y al quitar, ocultar o deshabilitar la capa. Cuando un hit deja de estar bajo el puntero, cierra con la muestra que lo sacó.
- **Borde que requiere manejo:** hover suprimido durante zoom/pan (sesión de hover se reinicia en `leave`).

---

## 11. Contrato de reactividad (formal)

La **ley** (MODELO §5.4) formalizada como contrato que un implementador debe cumplir en **toda** entrada de estado:

1. **Idempotencia:** asignar el mismo valor dos veces ⇒ a lo sumo un efecto (o ninguno si no cambió). Comparación por identidad/valor antes de agendar.
2. **Coalescing:** N asignaciones (de cualquier mezcla de entradas) en un tick ⇒ **un** rebuild/patch en el próximo rAF.
3. **Orden-independencia:** el efecto depende del **valor final** del tick, no del orden de asignación dentro del tick.
4. **Resolución por nombre:** una referencia por nombre (`icon-set`, `bind-to`) resuelve cuando el referente existe (montado tarde o reemplazado); hasta entonces, comportamiento por defecto seguro (nunca error, nunca en blanco).
5. **Estado vs acción:** si la entrada describe *cómo debe verse el mapa* → prop reactiva. Si describe *algo que ocurre una vez* → método. Un implementador decide con esta única pregunta; no hay terceros casos.

- **Test del contrato:** en un tick, `layer.iconSet = A; layer.iconSet = B; layer.data = X; layer.filters = F` ⇒ exactamente **un** rebuild, con `iconSet==B`. Verificar contador de rebuild == 1.

---

## 12. Matriz de complejidad asintótica (consolidada)

| Ruta | Estable | Cambio incremental | Peor caso (raro) |
|---|---|---|---|
| `Source` notify → leer | O(1) (version igual) | O(k) patch | O(n) rebuild |
| `Atlas.sync` (por binding) | O(1) | O(Δ variantes) | O(C) regrow |
| `tileChannel` / `cellOf` | O(1) **[0-alloc]** | — | — |
| filtros (reconcile) | — | O(n·f) | O(n·f) |
| cluster (supercluster) | O(1) query | — | O(n log n) build |
| picking GPU | O(1) read | — | — |
| `hover` diff | — | O(H) | O(H) |
| `safeDispatch` | O(L) **[0-alloc]** | — | — |
| `followPoint` | O(1)/update | — | — |
| render (draw) | O(n_visibles) | — | — |
| `readGeoJson` (§17) | — | — | O(B) una pasada **[0-alloc]** en el bucle |
| ascenso CSR del lector (§17) | O(log n) **[0-alloc]** | — | — |
| `propertiesOf` (§17) | — | O(largo del rango) | — |
| `distance` (§18) | — | — | O(vértices), una pasada; un path de arrays no se copia, otro iterable se materializa una vez |
| `area` · `perimeter` (§18) | — | — | O(vértices); cada anillo se copia una vez a un `Float64Array` |
| `diameter` (§18) | — | — | O(n log n) + O(h·(1 + γh/2π)) llamadas al modelo; O(n²) si la zona pasa de 45° de radio angular |
| `terrain` (§18) | — | — | O(tiles) pedidos de red, a lo sumo 6 en vuelo, + O(píxeles) de decodificación + O(filas) llamadas al modelo base |
| `relief` (§18) | — | — | O(vértices + celdas de la caja de la zona); asigna 8 B por celda de esa caja |
| `elevation` (§18) | — | — | O(1) **[0-alloc]** |
| `ring` · `arc` (§18) | — | — | O(vértices) llamadas al destino del modelo; no es [0-alloc]: devuelve pares. El escritor que comparte con la capa de formas y los editores no crea arrays ni clausuras, salvo lo que asigne el destino del modelo (la esfera, nada): con él, el anillo que reescribe cada frame del gesto de un editor de forma es **[0-alloc]**; el frame entero no, porque convertir el píxel en lugar asigna |
| `geodesic` (§18) | — | — | O(vértices) con una cota por tramo que no llama al modelo; O(puntos insertados) llamadas al modelo, y con el elipsoide, el rumbo y la distancia por tramo y el destino de la geographiclib por punto; no es [0-alloc]: devuelve pares |
| `addGeodesic` (§6) | — | O(vértices + p) llamadas al modelo, con p los puntos insertados: rearma el host ([`docs/lines.md`](./docs/lines.md#curva-geodésica), [`docs/polygons.md`](./docs/polygons.md#curva-geodésica), [`docs/editing.md`](./docs/editing.md#curva-geodésica)), y la baja lo rearma recto sin llamar al modelo | — |
| `distance` con un terreno (§18) | — | — | O(L) pasos de media celda por tramo, **[0-alloc]** en el bucle de pasos; la distancia del modelo base, una por tramo, asigna lo que asigne ese modelo (la esfera, nada). `area` y `perimeter` con un terreno, como `relief` y como `distance` por arista |
| frame del arrastre de un editor con curva ([`docs/editing.md`](./docs/editing.md#curva-geodésica)) | — | O(puntos de los dos tramos del vértice): los reescribe la esfera por defecto con los segmentos congelados y sube sólo ese rango, **[0-alloc]**; el frame entero no, porque convertir el píxel en lugar asigna | O(puntos de la curva) llamadas al modelo al soltar y en cada edición discreta, y a la esfera en cada muestra de la mano alzada |

**Objetivo de estado estable** (miles de updates/seg): la ruta caliente —`move`/recolor → encode → `bufferSubData` → draw— es **O(1) por elemento y [0-alloc]**, *bajo precondición de set sin cambios* (id con slot vigente) — path incremental, MODELO §17.5. Es la única garantía de alloc incondicional. Si una implementación asigna por elemento en esta ruta, está mal. **El rebuild NO tiene esa garantía:** `set`/filtro/cluster reescribe y re-sube el buffer entero, O(n), y aloca cuando el set crece. El coalescing acota la *tasa* a ≤1 rebuild/flush de rAF, **no** el costo: si el set cambia cada frame se paga O(n)/frame. Mantener barato el rebuild es responsabilidad del *uso* (que el set cambie poco), no del scheduler (MODELO §17 intro).

---

## 13. Reglas de rendimiento (obligatorias en el hot-path)

(MODELO §17.) Render, picking, `Atlas.sync`, `notify`, `dispatch`:
- **Dos paths, dos presupuestos (MODELO §17 intro):** el **incremental** (`move`/recolor, los miles/seg) es `bufferSubData` al slot → **[0-alloc]** obligatorio (precondición: id con slot vigente). El **rebuild** (`set`/filtro/cluster) reescribe el buffer entero → O(n), con alloc al crecer el set; el coalescing acota su *tasa* (≤1/flush rAF), no su costo agregado ni garantiza que sea raro. Las reglas [0-alloc] aplican al incremental, no al rebuild.
- **Path incremental = escribir el slot del VBO propio (MODELO §17.5):** el vértice es función pura del latLng y del ancla, que sólo cambia en un rebuild —que reescribe todo— → update puntual real. `move`: escribir `projX0(lng)-ax`, `projY0(lat)-ay` en `verts[slot*7 .. +2]` + `gl.bufferSubData(.., base*4, verts, base, 2)` (forma de 5 args WebGL2 → sin `subarray`, **[0-alloc]**). Recolor/patch: los 7 floats del slot.
  - **`[0-alloc]` exige proyección inlineada:** `map.project()` aloca (`Point` + `LatLng`); usar `projX0/projY0` (EPSG:3857 zoom-0). `projX0(lng)=256*(lng/360+0.5)`; `projY0(lat)=256*(0.5 − 0.25/π·ln((1+s)/(1−s)))` con `s=sin(clamp(lat,±85.0511)·π/180)`.
  - **Invariantes:** (1) `id→slot` se reconstruye en cada rebuild; (2) el espejo CPU es la única copia de los datos: el path incremental lo parcha y sube ese rango, y el `WebGLBuffer` es estable (el rebuild reasigna su almacenamiento con `bufferData(.., DYNAMIC_DRAW)`).
- **Arrays de instancia reusados** + truncado de `length` (no `new Array`, no `.map`/`.filter` que asignan; usar `for`/`forEach`).
- **Enteros inline:** `col = i % cols; row = (i/cols)|0` (no objeto de coordenadas).
- **Sin `try/catch` en bloque:** solo `safe`/`safeDispatch`.
- **`onError`/callbacks estables** (refs de módulo), nunca clausuras por call.

---

## 14. Plan de pruebas mínimo (por módulo)

| Módulo | Test esencial |
|---|---|
| `safe`/`safeDispatch` | aislamiento (un throw no detiene al resto); 0 asignaciones (medir con allocation profiler) |
| `Atlas` | append no mueve celdas; encoding estable al crecer; exceder C → objeto nuevo |
| `GpuAtlasBinding` | append = `texSubImage2D` × Δ; multi-mapa converge; regrow re-sube sin recompilar shader |
| `IconSet` | preseed de `variants` ⇒ 0 append runtime; variante no declarada ⇒ 1 append visible |
| `Source`/handle | version igual ⇒ 0 rebuild; `move` ⇒ 0 `bufferData` (espiar): hace `bufferSubData` desde el mismo espejo y [0-alloc] (allocation profiler); `set` en zoom ⇒ update no descartado |
| buffer incremental | `move`/recolor escribe el slot correcto del espejo (leer de vuelta lo subido al buffer GL); un rebuild reescribe el espejo entero |
| reactividad | N asignaciones/tick ⇒ 1 rebuild con el valor final |
| filtros | mismo `id` + `deps` distinto ⇒ predicado reemplazado y re-evaluado; `deps` igual ⇒ 0 rebuild aunque el predicado sea otra instancia |
| cámara | `followPoint` re-centra sin bombeo, y lo que no es una caja no lo corta; insets aplicados; sobre el Leaflet real, ningún retorno lleva una instancia de Leaflet |
| eventos | `hover` emite el set vigente de cada resolución y `hover:start`/`hover:end` sus cambios; `click` entrega hits ordenados; una pulsación quieta sale por `click` con su hit y, en el vacío, por `map:click`, y el `click` que dispara Leaflet no cuenta; cursor automático; sobre el Leaflet real, ningún payload lleva una instancia de Leaflet |
| lifecycle | StrictMode doble-mount ⇒ 1 motor; `destroy()` cancela rAF y quita listeners (sin leak) |
| lector GeoJSON (§17) | corpus de conformidad contra un **oráculo diferencial** sobre `JSON.parse`, nunca contra la implementación; las cuatro formas de entrada dan salidas idénticas byte a byte; fuzzer de mutación sin lectura fuera de rango ni excepción cruda; ausencia de grafo (conteo de asignaciones, no milisegundos) |
| geometría (§18) | referencias independientes (radios a mano, fórmulas distintas, valores publicados del elipsoide), nunca la misma haversine; las formas de llamada y de punto miden lo mismo; los bordes de §18.1; el tree-shaking del elipsoide, empaquetando; el octante y la banda contra fórmulas cerradas; geographiclib con f = 0 como implementación independiente de la esfera, anillos polares incluidos, y el destino y el rumbo del protocolo; el diámetro contra la fuerza bruta; el terreno con stubs de `fetch`, PNG sintéticos, un tile real de fixture y rampas de pendiente conocida; una segunda copia empaquetada; el tree-shaking del terreno |

---

## 15. Casos de borde

### 15.1 ELIMINADOS por arquitectura — **no chequear** (no pueden ocurrir)

| Borde | Por qué no ocurre |
|---|---|
| 2º mapa en blanco | binding por contexto con cursor intrínseco; no hay `#dirty` global (§4.2) |
| marcador invisible por variante tardía | append asigna celda antes del próximo `sync` |
| corrupción de marcadores existentes al crecer el atlas | encoding normalizado por capacidad fija `C` |
| iconSet/capa/bind-to "declarado tarde" o cambiado en caliente | reactividad al valor, orden-independiente (§11) |
| colapso de GC bajo miles de updates/seg | hot-path [0-alloc] (§13) |
| deadlock por listener que lanza | no hay WorkerPool; `safeDispatch` aísla (§1) |
| thrashing `center`/`zoom` ↔ gesto | no existe prop reactiva de centro; `initial-*` uncontrolled + cámara imperativa (§7.1/§9) |
| "volver a X" no funciona (idempotencia) | no aplica: recentrar es acción (`flyTo`/`panTo`/`followPoint`), nunca prop (MODELO §5.4) |
| `window.L` global / orden de `<script>` | el motor no lee ni escribe globals; el mapa propio usa el Leaflet de Cristae y uno adoptado trae el suyo (§6) |
| doble-montaje StrictMode | guard `#mounted` (§7.3) |
| shader recompila al crecer iconos | dims son uniforms, no literales GLSL (§4.2) |
| ítem enfocado que se dibuja donde la capa no tiene nada (clusterizado / filtrado / sin posición) | el foco viaja **en el vértice** del ítem dibujado, no en una lista de ids aparte: un id sin slot no existe (§8 intro) |

### 15.2 Que SÍ requieren manejo explícito

| Borde | Manejo |
|---|---|
| `positionOf` no finito | omitir el ítem del render (no lanzar) |
| id duplicado en snapshot | tomar el primero, ignorar el resto |
| `dirtyIds` con id ausente del snapshot | ignorar ese id |
| `set`/`patch` durante zoom/pan | diferir el rebuild, **no** descartar el dato (MODELO §16-9) |
| exceder capacidad del atlas | regrow → `Atlas` nuevo (generación+1); todos los bindings re-suben la textura **y** la capa re-encoda el buffer de puntos con el nuevo `C` (rebuild). Si ocurre durante un `patch`/recolor incremental, **escala a rebuild** — nunca solo textura (el denominador `C-1` de `tileChannel` cambió) |
| `prerender()` rechaza | `ready` rechaza; la capa sigue con IconSet por defecto |
| predicado de filtro / callback que lanza | `safe` lo aísla; se reporta, no se rompe la capa |
| `destroy()` con rAF/patch en vuelo | cancelar el rAF, drenar o descartar el pending de forma limpia |
| Leaflet de otra versión que la probada | sin guard en runtime: el rango `peerDependencies` y los tests de contrato de `test/host` —uno por cada privado de Leaflet que el anfitrión toca— dicen qué se probó; el mapa ajeno trae su `leaflet` (§6) |
| filtro recompilado con el mismo `id` (cambio de modo) | reconciliar por `deps`: mismo `id` + `deps` distinto = replace + re-evalúa; `deps` igual = no-op (§8.1). Reconciliar solo por `id` dejaría el predicado viejo activo |
| capa con 0 ítems | render vacío válido (no caso especial) |

---

## 16. Invariantes globales (un implementador no debe violarlas)

1. **Cero estado mutable de módulo/singleton.** Todo estado vive en una instancia (engine/capa/binding) o se inyecta. (Mata multi-mapa y embebido seguro.)
2. **El core no conoce dominio.** Ningún nombre público/interno con `vehicle`, `geofence`, `connection`, `etapa`. `variant`/`text` son strings opacas.
3. **No se forkean dependencias.** supercluster se usa como viene. El `[0-alloc]`/O(1) de los puntos vive en el path incremental, que escribe el slot del VBO propio por `bufferSubData`; el rebuild sigue siendo O(n) coalescido (MODELO §17.5, §17 intro).
4. **Estado → reactivo; acción → método.** Sin terceros casos (§11).
5. **Cero-alloc en caliente.** (§13.)
6. **El atlas se reusa y se le agrega; nunca se reconstruye desde cero** salvo regrow por capacidad.
7. **Leaflet vive sólo en el anfitrión** (`src/host/`): fuera de él nada importa Leaflet ni toca un privado suyo, y ningún valor de la API es un objeto de Leaflet. Un mapa adoptado trae su propio Leaflet (§6).

> Si una decisión de implementación obliga a violar una invariante, **es la implementación la que está mal**, no la invariante. Volver a MODELO.md/SPECS.md antes de improvisar.

---

## 17. Lector de GeoJSON — `cristae/geojson`

> Va al final y no entre las secciones de API porque es un **segmento** (como `core`), no una pieza
> del mapa: se contrata entero acá —firmas, invariantes, bordes— sin depender de §0-§11. Guía de uso
> en [`docs/geojson.md`](./docs/geojson.md).

Lee bytes UTF-8 y produce geometría en arrays tipados **sin construir nunca el grafo de `JSON.parse`**.
Cero DOM, cero Leaflet, cero dependencias. Lo consume `RingStore` (§17.6) y sirve suelto.

Convenciones locales: `B` = bytes de entrada, `v` = vértices, `r` = anillos, `g` = geometrías,
`f` = features.

### 17.1 El modelo de salida: CSR de cuatro niveles

**feature → geometría → parte → anillo → vértice.** Cuatro tablas de offsets, cada una en formato CSR:
el rango de `i` es `a[i] .. a[i+1]`.

El nivel **parte** no es decorativo. Sin él, un `MultiPolygon` de dos polígonos donde el primero tiene
un hoyo entrega tres anillos y **nadie puede decidir** si el anillo 1 es hoyo del polígono 0 o exterior
del polígono 1: o el hoyo no se recorta, o el segundo polígono se dibuja como hoyo del primero.

```ts
interface GeoJsonRead {
  readonly geometryAt : Uint32Array   // [f+1] feature    → rango de geometrías  (1:N por GeometryCollection)
  readonly partAt     : Uint32Array   // [g+1] geometría  → rango de partes
  readonly ringAt     : Uint32Array   // [p+1] parte      → rango de anillos
  readonly vertexAt   : Uint32Array   // [r+1] anillo     → rango de vértices
  readonly kinds      : Uint8Array    // [g]   GeoJsonKind (1..6). 0 no sobrevive al sellado
  readonly featureOf  : Uint32Array   // [g]   geometría  → feature dueño
  readonly closed     : Uint8Array    // [r]   1 = el último vértice repite al primero (§17.6)
  readonly xy         : Float64Array  // [2v]  xy[2i]=lng  xy[2i+1]=lat   ← orden RFC, sin invertir
  readonly z          : Float64Array | null   // [v] NaN = la posición era 2D; null = documento 2D
  readonly bounds     : Float64Array | null   // [4g] minLng minLat maxLng maxLat; null salvo `bounds:true`
  readonly propAt     : Uint32Array   // [2f]  rango de BYTE de los atributos del feature (§17.4)
  readonly idAt       : Uint32Array   // [2f]  rango de BYTE de `id`
  readonly bytes      : Uint8Array | null     // la entrada retenida; null tras `release()`
  readonly stats      : GeoJsonStats
}
```

`GeometryCollection` **no sobrevive a la salida**: sus geometrías hoja se emiten aplanadas en
**recorrido en profundidad, en orden de documento** —no en anchura: con dos niveles de anidamiento los
dos órdenes dan `kinds` y `featureOf` distintos— y `featureOf` las ata a su feature. El aplanado en
profundidad es idempotente, así que el anidamiento —legal: el RFC dice SHOULD avoid, no MUST NOT— no
necesita un quinto nivel. Se pierde la forma del árbol, que para render es irrelevante.

**Tipo → partes y anillos.** Sin esta tabla no hay salida derivable, porque la profundidad de
anidamiento no alcanza (§17.3-1) y dos lecturas razonables dan `partAt`/`ringAt` distintos para el
mismo documento:

| tipo | partes | anillos por parte | vértices por anillo |
|---|---|---|---|
| `Point` | 1 | 1 | 1 |
| `LineString` | 1 | 1 | N |
| `Polygon` | 1 | N (exterior + hoyos) | N |
| `MultiLineString` | **N** (una por línea) | 1 | N |
| `MultiPolygon` | **N** (una por polígono) | N | N |
| `MultiPoint` | **1** | **1** | **N** |

La regla es una sola: **una parte es una sub-geometría, y el nivel existe para preservar la
pertenencia anillo→polígono.** `MultiPoint` es la única excepción y por eso mismo: un punto no tiene
interior, así que entre sus posiciones no hay ninguna pertenencia que preservar, y subdividir sólo
multiplicaría las tablas en el perfil de capa más común (N puntos ⇒ N partes ⇒ N anillos). Agrupar no
pierde información; en `MultiLineString` sí la perdería, porque meter N líneas en una parte diría que
son los anillos de un mismo polígono.

**Invariante de la cola de la cadena:** `vertexAt[ringCount] === vertexCount` y
`xy.length === 2 · vertexCount`. Sin ella, una implementación puede empujar a `xy` números que no
cuelgan de ningún anillo y pasar igual la aserción de §17.3-3.

### 17.2 Firmas

| API | Firma | Complejidad | Notas |
|---|---|---|---|
| `readGeoJson` | `(input, options?) → GeoJson` | O(B) tiempo · O(v) memoria | `input`: `Uint8Array` (canónico) \| `ArrayBuffer` \| `ArrayBufferView` \| `string`. Una sola pasada. |

```ts
interface GeoJsonOptions {
  bounds?       : boolean   // false — caja por geometría, en una barrida al sellar
  capacityHint? : number    // 0 — vértices esperados; 0 = estimar del largo de la entrada
  maxDepth?     : number    // 512 — tope de anidamiento; pasarlo es GeoJsonError('profundidad')
}
```

El tope de anidamiento es una **cota anti-bomba**, no un límite del formato: la geometría más profunda
del RFC anida 4 niveles dentro de `coordinates`, así que 512 deja margen de sobra para cualquier
documento honesto y corta un `[[[[…` de un megabyte antes de que consuma pila o tablas.
| `eachRing` | `(cb: (ring, first, count, part) → void) → void` | O(r) **[0-alloc]** | Recorrido sin cortar. El 4º argumento es la **parte** dueña, no relleno. |
| `someRing` | `(pred: (ring, first, count, part) → boolean) → boolean` | O(r) **[0-alloc]** | Corte temprano con la semántica nativa de `some` — la vía para hit-test. |
| `partOf` / `geometryOf` / `featureOfRing` | `(i) → number` | O(log n) **[0-alloc]** | Ascenso por la misma cadena CSR. |
| `propertiesOf` / `idOf` | `(feature) → unknown` | O(largo del rango) | `JSON.parse` del fragmento. **No cachea.** Lanza `'liberado'` tras `release()`. |
| `release` | `() → void` | O(1) | Suelta `bytes`. La geometría sobrevive; `propertiesOf`/`idOf` dejan de servir. |

```js
export const GeoJsonKind = Object.freeze({
  Point: 1, MultiPoint: 2, LineString: 3, MultiLineString: 4, Polygon: 5, MultiPolygon: 6,
})
// GeometryCollection no tiene código: se aplana (§17.1).

export class GeoJsonError extends Error {
  code   // 'entrada'|'sintaxis'|'truncado'|'numero'|'posicion'|'estructura'|'tipo'
         // |'profundidad'|'formato'|'properties'|'liberado'
  at     // offset de BYTE donde se detectó (-1 si no aplica)
  hint   // 'topojson'|'esrijson'|null — a qué se PARECE el documento
}
```

### 17.3 Semántica obligatoria

1. **`type` es entrada, no metadata.** La profundidad de anidamiento es ambigua —`MultiPoint` y
   `LineString` comparten profundidad 2; `MultiLineString` y `Polygon` comparten 3— así que la
   geometría **no se infiere de la forma**. Una geometría que cierra sin `type` reconocible es
   `GeoJsonError('tipo')`, nunca una geometría adivinada.
2. **El tipo se fija al CERRAR el objeto geometría**, retro-parchando `kinds`. El RFC §3 declara el
   orden de los miembros irrelevante: `type` puede llegar **después** de `coordinates`.
3. **La geometría se compromete de forma atómica.** `kinds`, `featureOf` y `partAt` se escriben en el
   mismo bloque del cierre; nunca se reserva una ranura en un sitio y se compromete en otro. Invariante
   verificada al sellar: `kinds.length === g && featureOf.length === g && partAt.length === g + 1`.
   Sin esto, un `coordinates` como miembro ajeno de una `GeometryCollection` —legal— corre la cadena
   CSR en uno **en silencio**, que es la clase de falla que este módulo existe para matar.
4. **Una posición son 2 o 3 números, y puede variar dentro del mismo anillo.** Es legal. `xy` tiene
   stride fijo 2 y la altitud vive en `z` con `NaN` donde la posición era 2D. Derivar el conteo con
   `largo >> 1` es la falla que trata la altitud como latitud.
   `z === null` significa **documento 2D**, y lo deciden las posiciones RETENIDAS: una altitud que
   apareció en un `coordinates` descartado —duplicado, o miembro ajeno de una colección— no vuelve 3D
   al documento. Sin esa precisión un miembro que el lector ni publica cambia la forma de la salida.
5. **El lector CUENTA las violaciones; no las corrige.** Anillos abiertos, regla de la mano derecha,
   anillos de menos de 4 posiciones: todo va a `stats`. Corregir geometría es dominio.
6. **La entrada se normaliza por tipo explícito**, sin heurística de forma: `ArrayBuffer` →
   `new Uint8Array(b)`; cualquier `ArrayBufferView` → `new Uint8Array(b.buffer, b.byteOffset,
   b.byteLength)`; `string` → codificar; nada más → `GeoJsonError('entrada')`. El `byteOffset` es
   obligatorio: un `Buffer` de Node vive en un **pool compartido**, y tomar su `.buffer` entero deja al
   escáner recorriendo memoria de otras asignaciones que después saldría por `propertiesOf`. El portón
   de tamaño se mide sobre la vista resultante, nunca sobre el `ArrayBuffer` subyacente. Un **BOM**
   (`EF BB BF`) al principio se saltea y no desplaza los offsets que el lector publica: son offsets
   dentro de la vista tal como se recibió, así que un rango de `propAt` sigue recortando el fragmento
   correcto.
7. **La clave se reconoce sólo en posición de clave**, y con escapes deshechos. Un *valor* de texto que
   diga `"coordinates"` no abre una geometría. Los escapes se deshacen igual en el **valor** de `type`
   (`"Point"` es JSON legal y significa `Point`): tratarlo distinto que a la clave sería una
   asimetría sin razón.
8. **El desempate del ascenso es `upperBound(a, x) - 1`, nunca `lowerBound`.** Las tablas CSR tienen
   entradas repetidas por diseño (una geometría sin posiciones sale con 0 partes), y el dueño de `x` es
   el único `i` con `a[i] <= x < a[i+1]`.
9. **`propertiesOf`/`idOf` capturan sólo en el rol que es dueño del feature.** `bbox` se descarta en
   documento, feature y geometría; `properties` e `id` sólo se capturan en el feature. Capturarlos en
   la geometría hace que el resultado dependa del **orden de los miembros**, que el RFC declara
   irrelevante.
10. **El resultado retiene la entrada.** Los rangos perezosos exigen que `bytes` siga vivo: en un
    documento con properties pesadas eso puede ser 5× lo que ocupa la geometría. `release()` es la vía
    para soltarlo, y está en la superficie por eso.
11. **Una geometría se reconoce por su POSICIÓN estructural, nunca por traer `coordinates`.** Son
    geometría, y sólo ellas: el valor de un miembro **`geometry`** —a cualquier profundidad—, un
    elemento del array **`geometries`**, y el **valor raíz** cuando la raíz misma es una geometría. Un
    objeto con forma de geometría bajo cualquier otro nombre **no** lo es. Sin esta regla,
    `{"estilo": {"type":"Point","coordinates":[…]}}` es indistinguible de la geometría real y el mismo
    documento sale con una, dos o tres geometrías según cómo se implemente.
    El **subárbol de `properties` no se recorre**: es un rango opaco (§17.4), así que una geometría
    escondida ahí adentro tampoco cuenta.
    El lector conoce los nombres estructurales del RFC (`type`, `geometry`, `geometries`,
    `coordinates`, `features`, `properties`, `bbox`, `id`) — no puede leer GeoJSON sin conocerlos. Lo
    que **no** asume es dónde puso el consumidor sus atributos ni cómo llamó al array que los contiene.
12. **El feature es el objeto que POSEE el miembro `geometry`.** No «el elemento de `features`»: esa
    lectura ata el lector al nombre de un array y deja afuera formas reales y legales —una colección de
    documentos bajo `docs`, `items` o cualquier otro nombre, cada uno con su `geometry` adentro—, que
    es justamente lo que §17.4 existe para soportar. Con la regla del poseedor los cuatro casos
    colapsan en uno: en una `FeatureCollection` cada elemento de `features` posee su `geometry` y es el
    feature; en la colección con nombre arbitrario, cada documento también; un `Feature` suelto en la
    raíz se posee a sí mismo; y una geometría desnuda en la raíz es su propio feature.
    Los features salen en **orden de documento**, por la posición de su miembro `geometry`.
    Corolario: `featureCount` nunca es 0 con geometrías presentes — si lo fuera, una geometría no
    caería en ningún rango de `geometryAt` y `featureOfRing` quedaría sin respuesta, contra §17.3-8.
13. **`closed[r] === 1` sii el anillo tiene 2 o más vértices y su última posición es idéntica a la
    primera**, comparando la posición **completa** —incluida la altitud cuando la hay— con la
    semántica de `Object.is`, para que `NaN` cuente igual a `NaN` y `-0` no se confunda con `0`. El
    piso de 2 vértices no es cosmético: §17.6 alimenta `RingStore` con `count - closed[r]`, y sin él un
    anillo de un vértice entregaría cero.
14. **Un contenedor vacío ocupa ranura en el nivel donde cierra.** `Polygon [[]]` es 1 parte / 1 anillo
    / 0 vértices; `MultiPolygon [[]]` es 1 parte / 0 anillos. Determinar el nivel exige el `type`, que
    llega al cerrar (§17.3-2): la forma de la salida se decide en el cierre, no al abrir el contenedor.
    Distinto de `"coordinates": []`, que es 0 partes y 0 anillos (§17.9).
15. **Un objeto que trae `geometries` y además se declara hoja es `GeoJsonError('estructura')`.**
    Afirma dos cosas incompatibles: que contiene geometrías y que es una. Las dos lecturas pierden
    algo —quedarse con el `type` tira las hojas que §17.3-11 ya reconoció como geometrías por su
    posición; quedarse con la estructura tira la hoja que el documento declaró— y elegir una es
    exactamente el adivinar que §17.3-1 prohíbe. Vale con `geometries` vacío: un `Point` que además
    dice contener geometrías está roto igual. El veredicto **no depende del orden de los miembros**
    (§17.3-2): ni de si `coordinates` llegó antes o después de `geometries`, ni de dónde cayó `type`.
    Sin esta regla el mismo objeto sale como error, como colección o como una hoja que reclama los
    vértices de sus propios hijos, según el orden — que fue lo que encontró el fuzzer.
    Un `type: "GeometryCollection"` con un `coordinates` suelto **no** entra acá: ahí no hay
    contradicción, el tipo dice contenedor y `coordinates` es un miembro ajeno que se descarta.

### 17.4 Los atributos, sin interpretarlos

El lector **no sabe** qué hay en los atributos: anota su rango de bytes y `propertiesOf(i)` corre un
`JSON.parse` de ese fragmento, a demanda. Quien no los pide, no los paga.

**Qué rango se anota, exactamente:**

| el feature… | `propAt[2i] .. propAt[2i+1]` |
|---|---|
| trae miembro `properties` | el rango del **valor** de `properties` |
| no lo trae | el rango del **objeto que envuelve a la geometría** |

La primera fila es el `Feature` del RFC y es lo que hace verdadero el `propertiesOf(f)?.nombre` del
ejemplo (§17.7). La segunda existe porque hay payloads reales y legales donde los atributos son
**hermanos** de `geometry` —una colección de documentos con `geometry` adentro— y un lector que sólo
mire un miembro llamado `properties` devuelve vacío justo para esa forma. Lo que no se asume es **dónde
puso el consumidor sus atributos**, no los nombres estructurales del RFC (§17.3-11).

Costo declarado de la segunda fila: el objeto envolvente incluye su `geometry`, así que ese
`JSON.parse` rearma las coordenadas de **ese** feature. Es perezoso y por feature — se paga sólo por lo
que se toca — pero es real y hay que saberlo antes de llamarlo en un bucle.

**Ausencia y centinela.** Cuando el miembro no está, el par es **vacío** (`propAt[2i] ===
propAt[2i+1]`) y `propertiesOf`/`idOf` devuelven **`null`**. Nunca lanzan: `JSON.parse('')` tira un
`SyntaxError` crudo, que violaría la invariante §17.10-3.

### 17.4bis `GeoJsonStats` — lo que el lector cuenta sin corregir

Todos los campos son enteros y se cuentan **por documento**. Son la base del test de regresión, así que
tienen forma cerrada: sin ella el oráculo no puede reproducirlos.

```ts
interface GeoJsonStats {
  openRings       : number   // anillos con 2+ vértices cuya última posición NO repite a la primera
  shortRings      : number   // anillos con 1..3 vértices (el RFC pide 4 o más)
  degenerateRings : number   // anillos de área firmada 0 — ni horarios ni antihorarios
  reversedRings   : number   // ver abajo la definición operativa
  slowNumbers     : number   // números que cayeron al respaldo fuera del camino de Clinger (§17.5)
  extraOrdinates  : number   // posiciones con 4 o más números; los extras se descartan
  emptyGeometries : number   // geometrías con 0 partes
  foreignMembers  : number   // miembros que el lector atravesó sin interpretar
  bboxSkipped     : number   // bbox que superó la cota y no se parseó (§17.9)
  roots           : number   // valores raíz (más de 1 ⇒ secuencia RFC 8142)
}
```

**`reversedRings`, operativo:** el anillo de índice 0 de una parte es el exterior y el resto son
interiores; se suma 1 por cada exterior **horario** y por cada interior **antihorario**. El área firmada
se calcula sobre las posiciones del anillo cerrándolo de forma implícita si viene abierto. Área
exactamente 0 no cuenta acá: va a `degenerateRings`, porque un anillo degenerado no tiene sentido de
giro y contarlo como violación sería inventar una.

### 17.5 Rendimiento

- El bucle del escáner es **[0-alloc]**: sin array, sin objeto, sin clausura por byte ni por vértice.
  Es una ruta donde el bucle explícito es la única forma verificable de cumplirlo, y por eso se aparta
  de las colecciones expresivas que manda `AGENTS.md` — declarado acá **antes** de escribirlo.
- **Conversión numérica, en dos caminos y los dos exactos.** El rápido es Clinger: mantisa **menor que
  2⁵³** y potencia de diez exacta ⇒ una sola división IEEE correctamente redondeada. La condición es
  sobre el VALOR de la mantisa, no sobre su cantidad de dígitos: con el corte en «≤15 dígitos» el
  camino rápido cubre el 10,45 % de las coordenadas que emite `JSON.stringify`, y con la condición
  real, el 85,38 % — medido, y bit a bit idéntico en los dos casos.
  El resto sigue en el mismo barrido: los dígitos que no entran en la mantisa van a un **segundo limbo
  exacto**, y el valor `a·10^nb + b` se divide con corrección por residuo (transformaciones de Dekker).
  No se vuelve a leer un dígito — un respaldo que reinicie el barrido cuesta ~40 ns por número, medido.
  Su alcance son ~31 dígitos significativos; **pasados, se delega en `Number`**, al que el estándar
  obliga a redondear correctamente.
  La paridad bit a bit con `JSON.parse` es **incondicional**, y esa delegación es lo que la sostiene:
  un doble-doble que intente cubrir todo el rango falla en los empates exactos desde 34 dígitos —26,5 %
  de ellos, medido—, y el corpus no lo detectaba porque ninguno de sus literales pasa de 31 dígitos.
  La cobertura de esa frontera es obligatoria (§17.8).
  Un respaldo que materialice un string por número **para todo el rango** no entra: medido, hunde el
  perfil de emisor JS de 1,40× a 0,73× contra `JSON.parse`+aplanar.
- **No se agrega una rama dedicada a saltear números fuera de `coordinates`.** Medido sobre un
  escáner plano: la variante con esa rama sale 3–7 % **más lenta** en los tres pesos de properties,
  dirección estable en 15 corridas — el relleno de un documento real es texto, que ya se atraviesa
  barato, y la rama cuesta más que los pocos números que evita. Lo que la medición **no** dice es que
  haya que convertir un número que se va a descartar: un autómata que ya sabe, por su estado, que no
  está dentro de una posición, lo consume sin acumular mantisa porque es el camino más corto, no
  porque sea una optimización.
- El presupuesto de memoria se expresa como **función de los conteos de la fixture**, no como una
  constante de bytes por vértice: un techo constante falla sobre documentos normales y un test que
  falla se relaja, llevándose puesta la única defensa contra el regreso del grafo.

### 17.6 Integración con `RingStore`

`RingStore` toma `xy` en orden RFC `[lng, lat]` por un **tercer bucle de ingesta**: los bucles no se
ramifican por vértice, cada uno queda monomórfico en la forma que consume.

**Cierre de anillo.** Los anillos del RFC vienen **explícitamente** cerrados (§3.1.6: la última
posición es idéntica a la primera); la cadena de render los asume **implícitamente** cerrados
—`RingStore.nextVertex` vuelve a 0 y `EditStrokeLayer` traza la costura del último vértice al
primero—. La ingesta descuenta ese vértice: el conteo que entra es `count - closed[r]`. `closed` es
superficie pública para eso.

**Una textura, N anillos, y el relleno consume VISTAS.** `RingStore` guarda todos los anillos
seleccionados en la misma textura: N anillos no son N texturas. El pase de paridad **encadena los
rangos que recibe** —el cierre de uno busca el primer vértice del siguiente—, así que con más de un
anillo el relleno consume `store.viewOf(r)`: una vista emite un solo rango y cierra contra sí misma.
La vista comparte textura, ancla y matriz; sólo el rango y la caja son propios.

**Nombres de las tablas.** La integración usa los del lector, sin traducir: `vertexAt` es anillo →
primer vértice y `ringAt` es parte → primer anillo.

**`Point` y `MultiPoint` no aportan anillos.** No tienen interior: ni suben a la textura ni entran
al índice de hit —un tramo de `LineString` tampoco, y además no cierra—. La selección la da
`areasOf`, que devuelve las tablas del lector sin copiar más los ids de anillo (`rings`) y de parte
(`parts`) de los `Polygon` y `MultiPolygon`, y `owner` — la feature dueña de cada parte, indexada por
id de parte como el resto de las tablas del documento.

### 17.7 Ejemplo

```js
import { readGeoJson, GeoJsonKind } from 'cristae/geojson'

const geo = readGeoJson(await (await fetch(url)).arrayBuffer())

geo.eachRing((r, first, count, part) => {
  const g = geo.geometryOf(part)
  if (geo.kinds[g] === GeoJsonKind.Point || geo.kinds[g] === GeoJsonKind.MultiPoint) return
  arenas[r] = new RingStore({ gl, xy: geo.xy, first, count: count - geo.closed[r], project })
})

etiquetaDe(r) { return geo.propertiesOf(geo.featureOfRing(r))?.nombre }   // se paga sólo lo que se toca
```

### 17.8 Test

Corpus de conformidad con la salida esperada derivada de un **oráculo diferencial** —un recorredor de
referencia sobre `JSON.parse` que produce las mismas tablas— nunca de la implementación. El mismo
documento entregado como `string`, `ArrayBuffer`, `Uint8Array` y `Buffer` pooled (`Buffer.concat` de
tres trozos) da salidas idénticas byte a byte. Fuzzer de mutación de bytes con presupuesto de tiempo:
ninguna lectura fuera de rango, ningún camino sin terminación, ninguna excepción cruda.

### 17.9 Bordes

**Eliminados por arquitectura** — no chequear:

| Borde | Por qué no ocurre |
|---|---|
| un valor de texto `"coordinates"` abre una geometría | la clave se reconoce sólo en posición de clave (§17.3-7) |
| geometría con el tipo adivinado por la profundidad | `type` es entrada obligatoria (§17.3-1) |
| tablas CSR corridas por una ranura huérfana | la geometría se compromete atómica + aserción al sellar (§17.3-3) |
| la altitud leída como latitud | `xy` con stride fijo 2 y `z` aparte (§17.3-4) |
| `propertiesOf` devolviendo memoria ajena | normalización por tipo con `byteOffset` (§17.3-6) |

**Que SÍ requieren manejo:**

| Borde | Manejo |
|---|---|
| `"coordinates": []` (geometría vacía, la emite `ST_AsGeoJSON`) | legal: 0 partes, 0 anillos. **No** es error de estructura |
| clave escrita con escapes (`"coordinates"`) | deshacer el escape al comparar; es JSON legal y significa lo mismo |
| `bbox` en cualquier rol | se atraviesa sin interpretar (§17.3-9): el lector no publica `bbox`. Para la caja está `bounds`, que sale de los vértices leídos y no de un miembro que puede mentir |
| `bbox` de largo desmedido | se cuenta en `stats.bboxSkipped` y se sigue: un `bbox` de más de 256 bytes no es una caja, es un documento que no dice la verdad sobre sí mismo |
| contadores de contenedores vacíos | enteros de 32 bits: un `Uint8Array` da la vuelta a los 256 y corrompe las tablas en silencio |
| `geometry: null` en un feature | feature sin geometrías: `geometryAt[i] === geometryAt[i+1]` |
| documento truncado | `GeoJsonError('truncado')` con el offset, nunca una salida parcial silenciosa |
| documento vacío o sólo espacios | `GeoJsonError('sintaxis')`. Distinto de `'truncado'`, que es una estructura que empezó y no cerró |
| raíz que no es un objeto (`null`, un número, un texto) | `GeoJsonError('formato')`, con `hint` cuando el documento se parece a otro formato conocido |
| documento sin ninguna estructura GeoJSON reconocible (un TopoJSON, un EsriJSON) | `GeoJsonError('formato')` + `hint`. **No** es una lectura válida de cero features: eso lo es una colección que se declara vacía, y confundirlos entrega un mapa en blanco sin diagnóstico |
| posición con 4 o más números | los extras se **descartan** y se cuentan en `stats.extraOrdinates`. El RFC dice SHOULD NOT extend, no MUST NOT: rechazar sería tirar salida real de exportadores que emiten M/measure |
| número no finito (`1e999` ⇒ `Infinity`) | `GeoJsonError('numero')`. Una coordenada infinita envenena toda caja y toda matriz aguas abajo; es más barato pararla acá que diagnosticarla en el shader |
| `type` reconocido y **sin** miembro `coordinates` | `GeoJsonError('estructura')`. Distinto de `"coordinates": []`, que sí es legal |
| `GeometryCollection` sin `geometries`, o con `geometries` que no es array | `GeoJsonError('estructura')` |
| clave duplicada en el mismo objeto | gana **la última**, que es la semántica de `JSON.parse`: la paridad con el oráculo lo exige |
| secuencia RFC 8142 (varias raíces) | se leen todas; `stats.roots > 1`. **`JSON.parse` no puede leerlas**, así que el oráculo no produce referencia para esta familia y su corpus se contrasta contra la lectura raíz por raíz |

### 17.10 Invariantes del segmento

1. **El lector no construye el grafo.** Ninguna ruta materializa objetos por vértice ni por posición.
   Un método que devuelva tuplas o arrays por anillo no entra a la superficie: publicado en un entry,
   sale en un major, y el primer consumidor con una capa Leaflet andando lo llamaría porque es lo único
   que sus APIs comen — deshaciendo la medición desde adentro del módulo escrito para arreglarla.
2. **Cero dominio.** `feature`, `ring`, `part` son términos del RFC 7946, no del negocio.
3. **Todo error es `GeoJsonError` con `code` y offset.** Ninguna excepción cruda escapa del lector.
4. **Toda escritura verifica capacidad para las N entradas que va a escribir**, no para una: hay
   cierres que escriben K entradas de una vez.

---

## 18. Geometría — `cristae/geometry`

> Entry sin efectos, como `cristae/geojson`: funciones puras sobre puntos, paths y zonas en grados, no
> piezas del mapa. Se contrata acá; la guía de uso y el costo medido están en
> [`docs/geometry.md`](./docs/geometry.md). `toParts` y `sampleAlong` viajan en el entry con el
> contrato de [`docs/lines.md`](./docs/lines.md), y `arc` sale también de `cristae/map`.

| API | Firma | Complejidad | Notas |
|---|---|---|---|
| `distance` | `(model?, pointA, pointB, ...points)` · `(model?, path) → number` | O(vértices), una pasada | Siempre metros. |
| `area` | `(model?, polygon) → number` | O(vértices) | m²; región menor por anillo. |
| `perimeter` | `(model?, polygon) → number` | O(vértices) | m; cada anillo cerrado, huecos incluidos. |
| `diameter` | `(model?, polygon) → number` | O(n log n) + O(h·(1 + γh/2π)) llamadas al modelo | Horizontal; todos los pares si ρ ≥ 45°. |
| `ring` | `(model?, shape) → [lat, lng][]` | O(n) llamadas al destino del modelo | El anillo de la forma, sin repetir el primer vértice; `[]` con un dato malo. |
| `arc` | `(model?, shape) → [lat, lng][]` | O(n) llamadas al destino del modelo | El borde curvo como path abierto; el contorno cerrado si la forma es entera. |
| `geodesic` | `(model?, path) → [lat, lng][][]` | O(v + p) llamadas al modelo, con p los puntos insertados | El path partido como `toParts`, cada tramo largo curvado sobre la geodésica del modelo; `[]` sin tramos. |
| `terrain` | `(model?, source, bounds, options?) → Promise<Terrain>` | O(tiles) de red + O(píxeles) | Lo único asíncrono; todo error es un rechazo. |
| `terrainPresets` | `{ aws, mapterhorn }` | — | Datos, como `tilePresets`. |
| `relief` | `(terrain, polygon, breaks?) → Relief` | O(vértices + celdas de la caja de la zona) | Alturas en m, pendiente en razón, áreas de superficie por clase. |
| `elevation` | `(terrain, point) → number` | O(1) **[0-alloc]** | m, bilineal entre centros de celda; `NaN` si el punto no es válido, sale de la caja o toca una celda sin dato. |
| `sphere` | `(radius = 6371008.8) → EarthModel` | O(1) | El modelo por defecto de `distance`. |
| `ellipsoid` | `(semiMajorAxis, flattening) → EarthModel` | O(1) | Geodésica por el inverso de Karney. |
| `WGS84` | `EarthModel` | — | `ellipsoid(6378137, 1 / 298.257223563)`. |
| `boundsOf` | `(pointA, pointB, ...points)` · `(path) → Bounds \| null` | O(vértices), una pasada | Las formas de llamada de `distance`, sin modelo. |
| `boundsPad` | `(bounds, ratio) → Bounds \| null` | O(1) | Cada lado crece `ratio` del alto o del ancho; la latitud se acota a [-90, 90]. |
| `boundsContain` | `(bounds, point) → boolean` | O(1) | Bordes incluidos. |
| `boundsCenter` | `(bounds) → LatLng \| null` | O(1) | Promedio de los lados. |

Un **punto** es `[lat, lng]` —un array, donde lo que siga se ignora, o una vista tipada de dos o tres
componentes—, `{ lat, lng }`, `{ lat, lon }` o `{ latitude, longitude }`, con componentes numéricos
finitos y la latitud en [-90, 90]. Es la regla de los paths de líneas y del `value` de los editores,
que emiten pares, como `toParts`.

Una **caja** es una `Bounds` `{ south, west, north, east }` cuyas esquinas `(south, west)` y
`(north, east)` son puntos, con `south ≤ north` y `west ≤ east`; o un par de esquinas opuestas
`[p, q]`, dos puntos en cualquier forma y orden, que se lee como la caja de los dos. Es la regla de lo
que reciben `boundsPad`, `boundsContain`, `boundsCenter` y `camera.fitBounds` (§9). Con lo demás, las
tres primeras dan `null` o `false`.

Una **zona** es un anillo `[p, …]`, un polígono `[exterior, ...huecos]` o un multipolígono
`[polígono, …]`, con arrays en cada nivel y los vértices en cualquier forma de punto. El nivel lo
decide la profundidad del primer vértice —lo que no es un array, o un array cuya lat o lng no es un
objeto—, en orden de lectura y saltando lo nulo y `[]`: a la primera la zona es un anillo, a la segunda
un polígono y a la tercera un multipolígono. Una lista sin vértices, como `[null, null]`, no decide, y
una zona donde nada decide no aporta. Dentro de un anillo cada vértice, una ranura vacía de un array
disperso incluida, tiene que ser punto: el anillo no se corta como un path, porque saltar el vértice
uniría a sus vecinos con una arista que no existe. Un anillo o un polígono nulo o vacío no aporta, y
un exterior nulo o vacío se lleva sus huecos sin leerlos. El primer anillo de cada polígono es el
exterior, sea cual sea su giro. El área de un polígono es |exterior| − Σ |hueco|, la de un
multipolígono la suma de sus polígonos, y cada anillo cuenta la menor de las dos regiones que separa;
un anillo de 1 o 2 vértices no encierra nada. `perimeter` suma todas las aristas de todos los anillos,
la de cierre incluida, sobre un solo total en el orden de lectura: con un anillo es, bit a bit,
`distance` del anillo cerrado. `diameter` es el máximo de la distancia del modelo entre dos vértices
cualesquiera de la zona. Lo busca en el casco de la zona, y mide todos los pares en una zona de 45° o
más de radio angular ρ, o de cot 2ρ ≤ 2·A, con A cuánto se aparta de 1 la razón entre la escala
norte–sur y la este–oeste del modelo en el ecuador. Fuera de esos casos es exacto sólo si la distancia
es la geodésica de un elipsoide de revolución, como la de `sphere` y `ellipsoid`: en la esfera está
demostrado, y en el elipsoide el umbral se midió contra la fuerza bruta con achatamientos de 1/298 a
0,95, donde la última falla está en cot 2ρ = 0,76·A.

Una **forma** es `{ center, radius, heading?, sweep? }`: el centro en cualquier forma de punto; `radius`, en
metros, un número —círculo— o `[a, b]` —elipse, con `a` sobre `heading` y `b` de través, y no hace falta
a ≥ b—; `heading`, en grados con 0 = N, es la única rotación, y orienta el semieje `a` y la dirección del
sector; `sweep`, los grados que abre el sector, centrados en `heading`. Se lee por contenido, sin `type`. La
regla de validez es una sola: `null` y `undefined` son ausentes y toman el default —norte, figura entera—;
un número presente que la forma usa y no es finito la descarta, y el radio y `sweep` además si no son mayores
que 0; un `sweep` de 360 o más es la figura entera. Un círculo entero no usa `heading`, así que ni lo lee ni
lo valida. Una forma descartada da `[]`, como `null`.

`ring(model?, shape)` y `arc(model?, shape)` colocan la forma con el modelo, que va primero y es opcional, con
el despacho de `area`: con dos argumentos el primero tiene que ser un modelo, y la forma no puede ser un
modelo ni una función, o lanza `TypeError`. Un terreno lanza `TypeError` por `RELIEF`: la forma se coloca en
horizontal, sobre el modelo base, y se mide después sobre el terreno. Un modelo sin la marca de destino lanza
`TypeError`, y no se le pide área ni rumbo. Cada vértice es `destination(centro, heading + atan2(v, u),
hypot(u, v))`, con `u = a·cos t` y `v = b·sin t`: la elipse se parametriza por la anomalía excéntrica, no por
el lugar focal, y la lng de cada vértice sigue a la del centro sin envolverse. Los polos no se rechazan, porque
`area` los mide. El anillo parte en `heading` —el norte en un círculo— y sigue en sentido horario, sin repetir
el primer vértice: tiene `n` vértices, con `n` la potencia de dos entre 16 y 4096 que mantiene la cuerda a
0,1 m del arco, `n = π / acos(1 − 0,1 / max(a, b))`, y con la elipse la flecha máxima es la del círculo de
radio igual al semieje mayor. Un sector es `[centro, radio, arco, radio]`, sin repetir el primer vértice: el
centro, `m` vértices del borde izquierdo (`heading − sweep/2`), el arco hasta el derecho y los `m − 1` del
borde derecho de vuelta. El sector de una elipse pasa el ángulo polar φ a paramétrico con
`t = atan2(a·sin φ, b·cos φ)`, y el arco es uniforme en `t` entre `−t` y `+t`; como la elipse es simétrica, sus
dos radios miden lo mismo. El arco tiene `⌈n·t/π⌉` tramos, así que su paso en `t` no pasa del `2π/n` de la
figura entera y su cuerda queda a 0,1 m. Con `a = b` es `⌈n·sweep/360⌉`, y se cuenta así: el redondeo de
`atan2` sumaría un tramo en los bordes exactos. Cada radio se parte en `m = ⌈√(L²·tan|φ| / 8R / 0,1)⌉` tramos,
la separación máxima entre su recta en Mercator y la geodésica, acotado a 4096; sus vértices intermedios son
destinos desde el centro al mismo rumbo, y la geodésica es exacta porque el azimut inicial es constante.
`arc` es el tramo del sector que va de su primer radio al último, y con la figura entera el anillo con el primer
vértice repetido. Un círculo entero sobre la esfera por defecto, que no alcance un polo, va por un camino
rápido, con las expresiones del destino de esa esfera y sin pasar por la marca. Esa fórmula pierde la lng
sobre el polo, y a 1 km de él unos 6 µm; por eso el círculo que alcanza uno va por la marca. Que la forma
alcance un polo se decide con la cota de la distancia angular del semieje mayor, `|lat| + max(a, b)/R ≥ 90°`.

`geodesic(model?, path)` devuelve el path partido como `toParts`, con cada tramo curvado sobre la geodésica
del modelo, que va primero y es opcional, con el despacho de `area`: con dos argumentos el primero tiene que
ser un modelo, y el path no puede ser un modelo ni una función, o lanza `TypeError`. Un terreno lanza
`TypeError` por `RELIEF`, como `ring`; un modelo sin la marca de destino o sin la de rumbo también. Cada punto
sale como un par `[lat, lng]` propio, y los puntos de entrada se conservan. Un tramo entre dos puntos válidos
se parte en los `m` segmentos iguales que da `stepsFor` con el largo `√(L·θ·R)` —`L` el del tramo en el modelo,
`θ` su ángulo central: la separación escala con el radio del modelo— y `φ` la mayor latitud de la geodésica, la
del vértice del círculo máximo cuando cae entre los extremos, cortada en ±85,0511°. Queda en 1, sin tocarse, si
esa separación ya cabe en 0,1 m, si es un meridiano, si `|Δlng| > 180` —quien lo escribió eligió el lado
largo—, o si los dos puntos son antípodas o los dos polos, que no tienen una sola geodésica. Los `m − 1`
puntos nuevos están a `k/m` del largo sobre la geodésica: sobre la esfera por defecto, por la interpolación
esférica de los dos vectores, con la lng relativa a la del primer punto, y sobre los demás modelos por
`destination(a, heading(a, b), (k/m)·distance(a, b))`, con el rumbo y la distancia resueltos una vez por
tramo. En los dos casos la lng sigue a la del primer punto sin envolverse, y la curva no salta en el
antimeridiano. La cuenta pasa primero por un prefiltro que no le pide la distancia al modelo: la misma cota con
`√1,005·R·(|Δlat| + |Δlng|)` en radianes y la latitud de los extremos más `(|Δlat| + |Δlng|)/2`, que no bajan
de los verdaderos en un modelo de radio hasta 1,005 R, ya dice 1 en un track de pasos cortos. Lo que la cota
cumple, y sus bordes medidos, está en docs/geometry.md.

Los tramos de la curva —`count(model, lat1, lng1, lat2, lng2)` y `at(model, lat1, lng1, lat2, lng2, t, out)`,
que escribe el `[lat, lng]` del punto a la fracción `t`— no se exportan del entry: los comparten `geodesic`,
las capas de líneas y de polígonos y los editores, que escriben donde necesitan y interpolan el escalar entre
los puntos nuevos. Cada parte del índice de picking de líneas lleva `src`, la posición en la entrada del
vértice original que abre cada tramo del path que se dibuja, curvado o no, y `nearest` devuelve ese vértice
como `vertexIndex`. Con curva, la capa de líneas densifica en un solo lugar, del que salen el dibujo, el
índice y la caja que informa, y la de polígonos curva sus tablas al entrar, con la misma numeración de
anillos, partes y selección.

El escritor que comparten `ring`, `arc`, la capa de formas —que arma con él sus anillos y los cierra— y los
editores de forma, y el módulo de densidad que da `segmentsFor`, `stepsFor` y las dos tolerancias, no se
exportan del entry. `segmentsFor(r, tol)` es la fórmula de arriba y `stepsFor(L, lat, tol)`
la de los radios. La tolerancia sin vista es 0,1 m y es la de `ring`, `arc` y los radios de un sector. La
tolerancia con vista es 0,2 px, llevada a metros con la escala de Mercator en la latitud más alta que la forma
toca: es la que usan la capa de formas y el anillo de los editores de forma, y en un círculo da el mismo `n` de
siempre.

El **protocolo de modelo** son marcas en el registro global de símbolos, así que un modelo de una
copia de la librería sirve en otra. Las marcas se agregan entre versiones y sus firmas no cambian:

| Marca | Firma | La traen | Contrato |
|---|---|---|---|
| `Symbol.for('cristae.geometry.model')` | `(lat1, lng1, lat2, lng2) → number` | todo modelo | los metros entre dos puntos válidos, en grados. Un terreno los mide sobre el relieve, y da `NaN` con un extremo fuera de su caja o un tramo que toca una celda sin dato |
| `Symbol.for('cristae.geometry.area')` | `(coords: Float64Array, count: number) → number` | `sphere(r)`, `ellipsoid(a, f)`, `WGS84`, los terrenos | `coords` intercala `[lat₀, lng₀, lat₁, lng₁, …]` en grados, y sus primeros `count ≥ 3` vértices son puntos válidos; la arista del último al primero está implícita. Devuelve los m² sin signo de la menor de las dos regiones que separa el anillo, en [0, A₀/2] (A₀, el área total del modelo). Un terreno devuelve esa área de su modelo base por el factor de superficie, que puede pasar de A₀/2, o `NaN` con un vértice fuera de su caja o una celda que cuenta sin dato. Sólo lee `coords`, y sólo durante la llamada |
| `Symbol.for('cristae.geometry.destination')` | `(lat, lng, heading, meters, out) → out` | `sphere(r)`, `ellipsoid(a, f)`, `WGS84` | escribe `out[0] = lat₂` y `out[1] = lng₂`, en grados y en ese orden, del punto al que se llega desde uno válido a ese rumbo (cualquier real, 0 = N, 90 = E) y esos metros (finito; un negativo mira al lado opuesto). La `lng₂` sigue a `lng` sin envolverse: hasta media circunferencia del modelo su diferencia con `lng` es la de la geodésica, y más allá cada modelo escribe el mismo punto con la lng que le sale. Sólo escribe `out[0..1]`, y sólo durante la llamada; no asigna en la esfera |
| `Symbol.for('cristae.geometry.heading')` | `(lat1, lng1, lat2, lng2) → number` | ídem | el rumbo inicial de la geodésica de un punto al otro, en [0, 360), con 0 = N y 90 = E. `NaN` si los dos puntos coinciden —la misma lat y una lng que difiere en un múltiplo de 360, o los dos en un mismo polo—. Entre antípodas es ambiguo y cada modelo da el suyo |
| `Symbol.for('cristae.geometry.elevation')` | `(lat: number, lng: number) → number` | sólo los terrenos | la altura en m en un punto válido, bilineal entre los centros de celda; `NaN` fuera de la caja o con un vecino sin dato |
| `Symbol.for('cristae.geometry.relief')` | `(polygons: Float64Array[][], breaks: Float64Array) → Relief` | sólo los terrenos | `polygons[p][0]` es el exterior y lo que sigue son sus huecos; cada anillo es un `Float64Array` intercalado de largo exacto 2·n, con n ≥ 1 y todos sus vértices válidos. `breaks` ya viene validado. Devuelve un objeto nuevo y no retiene ni muta los argumentos |

Un modelo sin la marca de área —de una copia anterior a las áreas, o de otra implementación— sigue
sirviendo a `distance`, `perimeter` y `diameter`, y lo mismo uno sin las de destino y rumbo, que además
no coloca formas con `ring` y `arc`, ni curva con `geodesic`, que pide también el rumbo, ni sirve de
`model` del mapa, que pide los dos. Un terreno es un modelo —trae `model` y `area`, y no `destination`
ni `heading`— que además trae `elevation` y `relief`, y se reconoce por la marca de relieve: `diameter`
lo rechaza como modelo, `terrain` como base y el motor como `model` del mapa. `relief` y `elevation` se
despachan por sus marcas, porque el cálculo necesita las alturas, que viven en la clausura de la copia
que cargó el terreno: su layout no es contrato.

Un **terreno** son las alturas de una caja leídas de tiles XYZ en Web Mercator, a `source.zoom`: con
N = `tileSize`·2^zoom píxeles por vuelta, cada píxel es una celda cuyo valor rige en su centro. La
carga cubre la caja con un margen de 2 celdas por lado, acotado a la fila 0 y a la N − 1, y pide los
tiles que tocan esa ventana, con la `x` envuelta módulo 2^zoom en la URL. Terrarium es
`R·256 + G + B/256 − 32768` y Terrain-RGB `−10000 + (R·65536 + G·256 + B)·0,1`; un píxel de alfa 0,
o un tile que responde 404 o 204, no tiene dato. Por fila, el modelo base mide el ancho y el alto de
dos celdas y el área de una, en la latitud de los centros. `cellSize` es la mitad del ancho de dos
celdas en la fila del medio de la ventana. Un punto está en el terreno si su latitud cae en
[south, north] y su longitud cae en [west, east], tal cual o llevada a [west, west + 360) con un
múltiplo de 360: una longitud de la caja, la de su borde este incluida, no se desplaza, y la de una
zona escrita envuelta da lo mismo que sumarle 360 al desenvolverla.

El **relieve** de una zona pondera cada celda por la fracción de su área que la zona cubre, con las
aristas rectas en Mercator: por polígono el exterior suma y los huecos restan, sea cual sea su giro,
y una celda cuenta si su cobertura pasa de 10⁻⁹. Una celda tiene dato si sus 9 alturas lo tienen, y
su pendiente es la de Horn con los pasos de su fila. `cells` cuenta las celdas con dato; la altura y
la pendiente dan el mínimo y el máximo de celda y la media ponderada por el área cubierta. La clase
de una celda es la cantidad de cortes ≤ p, así que las clases son [breaks[k−1], breaks[k]). Con A el
área de la zona sobre la base —exterior menos huecos, por polígono—, w el peso de una celda y W la
suma de los pesos de todas las celdas que cuentan, `slope.areas[k]` es Σ w·√(1 + p²)·A/W sobre las
celdas con dato de la clase k (superficie), y `noData` es Σ w·A/W sobre las celdas sin dato
(horizontal). Sin celdas con dato, las áreas son 0 y `noData` es A.

Como **modelo**, el terreno mide sobre el relieve. Su `model` ubica los extremos en la grilla en
(u, v), en celdas desde el centro de la primera, y recorre el tramo en línea recta en píxeles con
n = máx(1, ⌈2·L⌉) pasos, con L el largo en celdas. Con D los metros del modelo base entre los extremos
y d = D/n, suma Σ √(d² + Δz²) sobre las alturas bilineales de cada paso. Su `area` es la del modelo
base por Σ w·√(1 + p²) / Σ w, con la cobertura y la pendiente de Horn del relieve, y sin celdas que
cuenten es la del modelo base. En terreno plano las dos sumas coinciden y el área es la de la base bit
a bit. `elevation` es la bilineal de las cuatro celdas que rodean al punto, con el valor de cada píxel
en su centro. Los `NaN` de las tres están en §18.1.

### 18.1 Bordes

**Eliminados por arquitectura** — no chequear:

| Borde | Por qué no ocurre |
|---|---|
| un modelo de otra copia de la librería no se reconoce | la marca va en el registro global de símbolos, no es una clase |
| un modelo inválido a mitad de un track | las fábricas validan al construir |
| la librería geodésica en el bundle de quien no usa el elipsoide | ni `distance` ni las medidas de zona importan `ellipsoid.js`, y ningún módulo del entry figura en `sideEffects` |
| la composición de una zona —exterior menos huecos, suma de partes— atada al protocolo entre copias | el núcleo de área va por anillo; la composición vive en `area` |
| el terreno en el bundle de quien no lo importa | ningún módulo de medida importa `terrain.js`; `terrainPresets` son datos |
| un terreno como base de otro | `terrain` lo rechaza al construir |
| un terreno de otra copia de la librería | `distance`, `area`, `perimeter` y `elevation` lo leen por sus marcas |
| el layout del ráster como contrato entre copias | `relief` se despacha por la marca del terreno, que calcula con lo que guarda en su clausura |

**Que SÍ requieren manejo:**

| Borde | Manejo |
|---|---|
| `null` o `undefined` primero | no es un modelo: es un punto inválido. `distance(xs[0], xs[1])` sobre un array vacío da `NaN` |
| un modelo fuera del primer lugar, o una fábrica sin llamar | `TypeError` |
| un solo argumento después del modelo | un punto mide 0; nulo, o iterable que no es un punto, es un path; lo demás es un punto inválido |
| un punto inválido | corta: se suman los tramos que quedan, sin puentear el hueco |
| algún inválido y ningún tramo | `NaN`, no un 0 que se sumaría como tramo real |
| sin puntos, un solo punto, partes vacías o de un vértice | 0 |
| la latitud fuera de [-90, 90] | no es un punto: corta, con cualquier modelo |
| `[lng, lat]` | no entra: es un par igual en forma, y en latitudes medias no se distingue |
| una vista tipada de más de tres componentes | no es un punto: es un track intercalado, y leída como punto mediría 0. Corta, y sola es un path de números, que da `NaN` |
| el encoding de un path | lo decide su primer elemento que trae algo, un array por su lat y su lng; si nada decide, es anidado cuando trae un array |
| un par casi antípoda | la esfera acota el término de la haversine a [0, 1]; el elipsoide converge |
| un radio o un semieje no finito o ≤ 0, un achatamiento fuera de [0, 1) | `RangeError` al construir |
| un vértice suelto entre dos cortes, en `boundsOf` | entra a la caja: es un lugar aunque no haga tramo |
| `boundsOf` sin ningún punto válido | `null` |
| una longitud fuera de [-180, 180] | no se envuelve: la caja la conserva, aunque pase de 360° de ancho, y `boundsContain` compara el punto tal cual, así que uno de otra copia del mundo cae afuera |
| una caja que cruza el antimeridiano | lleva el este pasado de 180; con la longitud envuelta queda `west > east`, invertida, y no es una caja. `boundsOf` da la de los mínimos y máximos |
| una `Bounds` invertida | no se reordena: nombra sus lados, así que no es una caja |
| un `L.LatLngBounds` o cualquier objeto con métodos en vez de lados | no es una caja |
| un ratio que invierte la caja, o no finito | `boundsPad` da `null` |
| una zona `null`, `undefined`, `[]`, `[[]]` o `[null]` | `area`, `perimeter` y `diameter` dan 0 |
| un anillo de 1 vértice | 0 en las tres medidas |
| un anillo de 2 vértices a distancia d | `area` 0, `perimeter` 2d (ida y vuelta), `diameter` d |
| el primer vértice repetido al final | mide igual que sin repetir |
| un vértice inválido en cualquier anillo de la zona | `NaN` en las tres medidas |
| una zona que no es array ni nula (`{ lat, lng }`, un `Set`, `42`), o lo que no es array, ni nulo, ni `[]` en la posición de un anillo o de un polígono | `NaN` |
| un modelo o una función como zona; más de dos argumentos; dos y el primero no es modelo | `TypeError('[area] recibe (model?, polygon): …')`, con el nombre de cada medida |
| `area` con un modelo sin la marca de área | `TypeError('[area] este modelo no mide áreas: …')` |
| `diameter` con un modelo que trae `Symbol.for('cristae.geometry.relief')`, la marca de un terreno | `TypeError('[diameter] mide en horizontal: …')` |
| el sentido de giro de cualquier anillo | no cuenta: los anillos se miden sin signo y el rol lo da la posición |
| un anillo que rodea un polo | se corrige por su giro neto y mide la región polar que encierra |
| un vértice en un polo | vale con cualquier longitud |
| una zona que cruza el antimeridiano | mide lo mismo escrita con la longitud envuelta o sin envolver; la capa la dibuja bien sólo sin envolver |
| una arista con \|Δλ\| = 180° exacto | pasa por un polo y es ambigua: vale lo que dé la fórmula, sin contrato |
| un hueco más grande que su exterior | el área sale negativa, sin acotar: el signo delata la geometría |
| dos partes que se solapan | el solape cuenta dos veces, como lo apila la capa |
| un anillo que se corta a sí mismo | suma sus lóbulos con signo; corregir geometría es del consumidor |
| `terrain`: la base no es un modelo que mide áreas, o es un terreno | rechaza `TypeError('[terrain] el modelo base tiene que medir áreas y no ser un terreno')` |
| `terrain`: `source` no es un objeto, o su `url` no lleva `{z}`, `{x}` e `{y}` | rechaza `TypeError('[terrain] source.url tiene que llevar {z}, {x} e {y}')` |
| `terrain`: `attribution` que no es string | rechaza `TypeError` |
| `terrain`: `encoding` que no es `terrarium` ni `mapbox` | rechaza `RangeError('[terrain] encoding desconocido: …')` |
| `terrain`: `maxZoom` fuera de los enteros de [0, 24], `zoom` fuera de los de [0, maxZoom], `tileSize` o `maxTiles` que no es un entero ≥ 1 | rechaza `RangeError`, con el campo y el valor |
| `terrain`: `bounds` que no es una caja | rechaza `TypeError('[terrain] bounds no es una caja')` |
| `terrain`: una caja más allá de ±85,0511287798066° | rechaza `RangeError('[terrain] los tiles no cubren más allá de ±85,0511°')` |
| `terrain`: la caja pide más de `maxTiles` | rechaza `RangeError('[terrain] la caja pide K tiles a z=Z; el tope es M: …')` sin llamar a `fetch` |
| `terrain`: la señal abortada, antes o durante la carga | rechaza con `signal.reason` y aborta lo que está en vuelo; antes, sin llamar a `fetch` |
| `terrain`: un tile responde 404 o 204 | no es error: sus celdas quedan sin dato, sin rellenarlas con el tile padre |
| `terrain`: otro estado no OK (401, 403, 5xx…) | rechaza `Error('[terrain] <url> respondió <status>')` y aborta lo demás |
| `terrain`: `fetch` o la lectura del cuerpo rechaza sin abort | rechaza `Error('[terrain] <url> no respondió', { cause })` y aborta lo demás |
| `terrain`: bytes que no son un PNG legible de 8 bits RGB o RGBA, ni un WebP | rechaza `Error('[terrain] <url> no es un tile legible: <motivo>')` |
| `terrain`: un tile que no mide `tileSize` × `tileSize` | rechaza `Error('[terrain] <url> mide W×H; se esperaban T×T')` |
| `terrain`: PNG sin `DecompressionStream` (Safari < 16.4, Firefox < 113) | rechaza `Error('[terrain] este entorno no decodifica PNG: le falta DecompressionStream')` |
| `terrain`: WebP sin `createImageBitmap` u `OffscreenCanvas` (Node), o en un navegador que altera los píxeles que lee | rechaza con el mensaje de entorno o el del canario, que recomiendan una fuente PNG |
| `terrain`: todos los tiles responden 404 o 204 | rechaza `Error('[terrain] ningún tile de la caja trae datos a z=Z')` |
| `elevation`: el primer argumento no trae la marca de elevación | `TypeError('[elevation] el primer argumento tiene que ser un terreno: …')` |
| `elevation` con un punto que no es un punto, fuera de `terrain.bounds` o junto a una celda sin dato | `NaN` |
| `distance` o `perimeter` con un terreno, con un extremo fuera de la caja o un tramo que toca una celda sin dato | `NaN` |
| `area` con un terreno, con un vértice fuera de la caja o una celda que cuenta sin dato | `NaN`, salvo en un anillo de 1 o 2 vértices: no encierra nada y aporta 0 sin consultar el terreno |
| la fila de celdas pegada a ±85,0511°, el límite de la proyección, sin vecina hacia el polo | su pendiente es sin dato (`noData` en `relief`, `NaN` en `area`), y su media celda exterior no tiene altura (`NaN` en `elevation` y `distance`) |
| `relief`: el primer argumento no trae la marca de relieve | `TypeError('[relief] el primer argumento tiene que ser un terreno: …')` |
| `relief`: `breaks` que no es `undefined` ni un array | `TypeError('[relief] breaks tiene que ser un array de cortes')` |
| `relief`: un corte no finito, < 0 o fuera de orden estrictamente creciente, una ranura vacía incluida | `RangeError('[relief] breaks: …')` |
| `relief` de una zona nula, vacía o de anillos de 1 o 2 vértices, aunque caigan fuera de `terrain.bounds` | `cells: 0`, alturas y pendientes `NaN`, `areas` en 0 y `noData` 0 |
| `relief` con un vértice inválido, o una zona que no es array | todos los campos `NaN` y `cells: 0`, con `breaks.length + 1` áreas |
| `relief` con un vértice de un anillo de 3 o más fuera de `terrain.bounds` | todos los campos `NaN` y `cells: 0`: lo que mide queda dentro de la caja |
| una celda sin dato bajo la zona, o pegada a una sin dato | suma su área horizontal a `noData` |
| una zona menor que una celda | pesa su fracción y hereda la altura y la pendiente de las celdas que toca |
| una pendiente igual a un corte | cae en la clase de arriba |
| dos partes que se solapan, en `relief` | la celda pesa la suma de sus coberturas, como `area` cuenta el solape dos veces |
| un hueco fuera de su exterior, en `relief` | la celda con cobertura negativa no cuenta |

### 18.2 Test

`sphere()` da exactamente lo mismo que el defecto; `sphere(r)` escala en la razón de los radios;
WGS84 contra valores publicados (a·π/180, el cuadrante meridiano, Flinders Peak–Buninyong); la misma
medida y la misma caja por puntos variádicos, por un path plano y por uno anidado, en las cuatro formas
de punto; un par de esquinas en cualquier orden; cada borde de §18.1; empaquetar sólo `distance` no
trae la librería geodésica.

Las medidas de zona: el octante y una banda de 1° contra fórmulas cerradas, en la esfera y en WGS84;
anillos polares, anillos que se superponen a sí mismos, polígonos sembrados y mil cuadriláteros
irregulares de pocas hectáreas, en los dos giros, contra la geographiclib con f = 0, una
implementación independiente de la esfera; el antimeridiano escrito de las dos formas; huecos,
partes, cierre repetido y formas de punto con resultados idénticos, sobre anillos irregulares, y los
dos giros a 10⁻¹²; `perimeter` contra `distance` del anillo cerrado y contra el perímetro de
`PolygonArea`; `diameter` contra la fuerza bruta, en círculos sesgados de 1 a 3 000 km, nubes al azar
y zonas de casi 90° de ancho en el elipsoide, y su costo con un modelo que cuenta llamadas; un modelo de
otra versión y uno de terceros; una segunda copia empaquetada del entry que intercambia modelos con la
primera; empaquetar las medidas no trae la librería geodésica.

Destino y rumbo: la esfera contra la geographiclib con f = 0, en posición y en lng sin envolver, desde
orígenes sobre el polo y junto a él, a rumbos y distancias de signo y vuelta cualquiera; el elipsoide
contra el azimut y la llegada publicados de Flinders Peak a Buninyong y por ida y vuelta con
`distance` y `heading`; el antimeridiano por los dos lados; el rumbo en [0, 360) con un azimut apenas
negativo y uno en -0; el `NaN` de los puntos que coinciden —con la lng corrida una vuelta y en cada
polo—; que sólo se escriba `out[0..1]`; y que un terreno no traiga las marcas.

Las formas: el círculo contra el polígono regular inscrito en el casquete de la esfera, con su perímetro y
su área en forma cerrada, y la flecha de la cuerda contra la del triángulo rectángulo esférico, en la
esfera por defecto, en otra y en el centro del polo; cada vértice de círculo, elipse y sector de ambas, en la
esfera, WGS84 y un elipsoide achatado, contra el problema inverso de la geographiclib —la distancia y el
rumbo desde el centro, que son las coordenadas polares con que se colocó, y la anomalía excéntrica
uniforme—; la flecha de cada cuerda de la elipse y del arco de un sector de elipse contra la elipse
muestreada en el marco de la forma, que con la mitad de tramos ya no cumple; el sector entero, el reflejo y
el simétrico; los radios contra una geodésica muestreada en el plano de Mercator, que un solo tramo no
cumple; el arco abierto y el cerrado; cada caso de la regla de validez y de los `TypeError`; la cota del
polo por el semieje mayor; un modelo de otra implementación con sólo la marca de destino; el anillo de la
capa de formas contra `ring` a igual número de segmentos, y el del alias `addCircleLayer`, con el mapa en
WGS84, bit a bit contra la fórmula cerrada del destino sobre la esfera y cerrado, leídos de la geometría que
la capa entrega; el terreno que no coloca y la forma colocada que sí se mide sobre él; la tabla de segmentos
del círculo por (latitud, radio, zoom); y empaquetar `ring` y `arc` sin la librería geodésica.

La geodésica: un track GPS de pasos de 10 a 100 m, que no se parte en ningún modelo y sale igual, también a
89,9°; cien kilómetros a 37°, con la separación de cada cuerda de Mercator a la geodésica medida por fuerza bruta
con la distancia al círculo máximo de la esfera, que cumple 0,1 m con los segmentos que da la cuenta y no con la
mitad, y una tabla de tramos en cada hemisferio, entre ellos y de miles de kilómetros; dos tramos pasados los 80°
cuyo vértice sube sobre los extremos, que no cumplen con la latitud de los extremos; esferas de otro radio,
medidas en ellas; el polo y el meridiano, que no se parten; el prefiltro contra la cuenta armada por Clairaut en
3 000 tramos al borde del umbral de la esfera y de WGS84, y dos tramos fijos donde el margen y el medio camino
deciden; cada punto contra el problema directo a su fracción del largo, el cerrado de la esfera y el de la
geographiclib en el elipsoide; `at` alternando tramos y modelos; el camino rápido de la esfera contra la
composición de las marcas; la lng continua desde y hacia fuera de ±180, y un
tramo de media vuelta por el polo; los antípodas y los polos opuestos; un tramo de más de media vuelta intacto; la
entrada que no se toca ni se retiene; cada caso de los `TypeError`, también con el terreno; un modelo ajeno con
las tres marcas; el `vertexIndex` de la entrada que devuelve `nearest` con `src`; y empaquetar `geodesic` sin la
librería geodésica.

El terreno, con un `fetch` de stub que arma cada tile con una altura conocida en el centro de cada
píxel: los tiles pedidos con el margen, también sobre el antimeridiano; cada rechazo de §18.1 sin
llamar a `fetch` cuando es previo a la carga; el 404 sin dato y el 403 que aborta; la cancelación
antes y durante. El relieve: rampas en metros de pendiente conocida, norte–sur en Terrarium y en
Terrain-RGB, diagonal sobre la esfera y sobre un elipsoide achatado, y sobre celdas de cientos de km;
las clases de superficie √(1 + p²) en una rampa de 0,3; la altura de una celda sola, la del tile real
contra PIL y la media de un rectángulo y de un polígono con hueco; `noData` contra la fracción de
celdas contadas a mano y contra el recorte a mano de un triángulo; el invariante de las áreas y
`noData` contra el área de la base en terreno plano; una segunda copia empaquetada que describe un
terreno de la primera; empaquetar `terrainPresets` solo no trae el cargador.

El terreno como modelo: terreno plano contra la base (`area` bit a bit, `distance` y `perimeter` a
10⁻¹², con la esfera y con WGS84); una rampa de 0,3 contra la distancia de la base por √(1 + s²) a lo
largo de un meridiano y la de la base a lo largo de un paralelo, y contra el área de la base por
√(1 + s²), también en una zona menor que una celda; un quiebre de pendiente de 0,1 a 0,4 en un centro
de celda, contra la suma de las dos partes del tramo por su √(1 + s²) (meridiano, paralelo y
perímetro), que atrapa un muestreo más grueso que media celda y la grilla corrida en cualquiera de los
dos ejes; el mismo quiebre contra el factor de Horn calculado a mano por fila y ponderado por
cobertura·área, con una fila cubierta en un décimo; `Σ slope.areas = area(t, zona)` con `noData = 0`, a
10⁻¹² con un anillo y a 10⁻⁶ con un hueco; un elipsoide de achatamiento 0,2 sobre su propia rampa,
contra el área de esa base por √(1 + s²); los `NaN` por cada lado de la caja, a menos de una celda y
dentro del mosaico, y por un 404; `diameter` que lo rechaza; `elevation` contra una rampa diagonal,
donde medio píxel de corrimiento en cualquier eje da metros; y una segunda copia que mide con un
terreno de la primera.
