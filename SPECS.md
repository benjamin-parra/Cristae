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
- **Tipos:** notación TypeScript-like, ilustrativa. El código es JS (sin tipos en runtime). `LatLng = { lat: number, lng: number }`.
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
| `patch(items, dirtyIds)` | O(k) | rebuild solo si cambia membresía de filtro/cluster (o un regrow de atlas, §4.2); si no, **k escrituras de slot** (mismo mecanismo que `move`/recolor, §13) — O(k) **[0-alloc]**, sin `setData` |
| `move(id, lat, lng)` | O(1), **[0-alloc]** en WebGL2 | nunca rebuild: `bufferSubData` al slot del vértice en el buffer de glify (no `setData`/`resetVertices`). Ver MODELO §17.5 |
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
new MapEngine({ leaflet: L, container: HTMLElement, /* defaults neutros */ }) → engine
```

| Método | Tipo | Complejidad | Notas |
|---|---|---|---|
| `addPointLayer(cfg) → handle` | acción | O(1) + preseed | crea capa + store interno |
| `addPolygonLayer(cfg) → handle` | acción | O(1) | |
| `addLabelLayer(cfg) → handle` | acción | O(1) | standalone o `bindTo` |
| `attachSource(id, source)` | acción | O(1) | ruta B/C; interno del setter `.source` de la capa |
| `removeLayer(id)` / `getLayer(id)` | acción | O(1) | |
| `registerIconSet(name, set)` | acción | O(1) | resuelve capas pendientes por nombre |
| `createIcon(descriptor)` | acción | O(1) | |
| `on(event, layerId?, cb) → off` | acción | O(1) | suscripción por capa |
| `getLeafletMap()` | escape | O(1) | el `L.map` crudo |
| `getUnsafeHandler()` | escape | O(1) | el `MapWidget` con sus métodos internos, **sin garantías de estabilidad** |
| `destroy()` | acción | O(layers) | cancela rAF pendientes, quita listeners, libera bindings |
| `ready: Promise` | — | — | resuelve tras el primer render |

- **Invariante de Leaflet:** una sola instancia de `L` en la página (provider en el constructor); guard en runtime si se detecta otra. glify vendorizado/re-exportado (MODELO §empaquetado).
- **Borde eliminado:** `window.L.glify` global y orden de `<script>` → ya no aplican (L inyectado).

---

## 7. Elemento `<cristae-map>` (Lit)

### 7.1 Atributos / props reactivas (estado → reactivo, MODELO §5.4)

| Nombre | Tipo | Atributo serializable | Reactivo a | Efecto |
|---|---|---|---|---|
| `tile` | `{url, attribution, maxZoom, className, updateWhenIdle?, keepBuffer?}` | sí (JSON) | cambio | re-provee tiles |
| `theme` | CSS vars sobre `:host` | vía CSS | — | label-layers leen `--cristae-*` |
| `initial-center` | `LatLng` | sí | **no** (solo al montar) | fija la vista inicial una vez (uncontrolled, como `defaultValue`). Recentrar vivo = cámara imperativa (§9) |
| `initial-zoom` | number | sí | **no** (solo al montar) | idem |
| `world-copies` | boolean | sí | cambio | `noWrap` |
| `viewport-insets` | `{top,right,bottom,left}` | sí | cambio | compensa UI que ocluye; lo usan `panTo/flyTo/fitBounds/fitToLayer` |
| `hover-throttle` | ms | sí | cambio | throttle de `pointermove`→picking |
| `stale-tolerance-px` | px | sí | cambio | tolerancia de staleness del picking (avanzado) |

- **`initial-center`/`initial-zoom` uncontrolled:** se aplican una vez al montar; el gesto del usuario y la API de cámara mueven el mapa libremente sin reescribir nada. El recentrado vivo (seguir/buscar/encuadrar) es **acción** (§9), no estado — ver MODELO §5.4 para el porqué (el híbrido controlado-una-vía hace que "volver a X" sea no-op por idempotencia). El gesto igual emite `cristae:viewportchange` por si el consumidor quiere observar. **Borde eliminado:** loop de feedback atributo↔gesto (no existe prop reactiva de centro).

### 7.2 Métodos (acción → imperativo)

`addPointLayer`, `addPolygonLayer`, `addLabelLayer`, `removeLayer`, `getLayer`, `attachSource`, cámara (§9), `createIcon`, `registerIconSet`, `syncSize()`, `invalidateCanvas()`, `getLeafletMap()`, `getUnsafeHandler()`, `destroy()`, `ready`.

- **`syncSize()`**: resize del contenedor — `map.invalidateSize()` + reajuste del FBO de picking + **redibujo de las capas de puntos** (`invalidateSize()` solo emite `move`/`moveend` si el resize desplaza el centro, así que un resize simétrico limpiaría el canvas glify sin redibujarlo). Llamado por el `ResizeObserver` interno del elemento; el consumer raramente lo necesita.
- **`invalidateCanvas()`**: reposiciona y redibuja todas las capas de puntos. Escape hatch manual: con `<cristae-map>`, resize y show-tras-`display:none` ya se auto-curan vía el observer → `syncSize()`; este método es para el motor headless (sin elemento, sin observer) o el raro show sin cambio de tamaño. **`destroy()` además notifica a los hermanos automáticamente** (multi-mapa).

### 7.3 Lifecycle

- **Montaje:** `firstUpdated` monta el motor (`await` glify, async; guard `#mounted`). En **reconexión** tras un `disconnectedCallback`, `connectedCallback` **re-monta** (firstUpdated no re-dispara) con un motor **nuevo**; las capas hijas se re-encolan solas (su `connectedCallback` vuelve a pedir montaje y, como `#mount` es async, llegan a la cola antes de que exista el motor).
- **Destrucción:** `disconnectedCallback` → `engine.destroy()` (con `ownsMap`: `L.Map.remove()` + contexto WebGL). Desconectar el elemento del DOM (`remove`/reparent/`innerHTML` en un ancestro) **destruye el mapa** — no es un `<div>` reposicionable.
- **No cachear handles:** `engine`/`camera`/`getLeafletMap()` son getters vivos sobre el motor **actual**; tras un re-mount son otra instancia. El consumidor lee siempre el getter, nunca una copia.
- **Readiness:** `ready` es una promesa **one-shot por instancia** (creada en construcción → disponible síncrona; resuelve al primer motor listo). El evento `cristae:ready` se **re-emite en cada (re)montaje** — es la señal para reenganchar tras un reattach.
- `ResizeObserver` sobre el host → `engine.syncSize()` (`invalidateSize` + `syncPickingSize`). El consumidor **no** llama resize a mano; crear oculto (`display:none`) y mostrar después se sincroniza solo.
- **Apilado:** orden de los hijos en light DOM = orden de render (atrás→adelante); atributo `z` opcional. El motor deriva los panes; el consumidor no toca z-index (MODELO §6).
- **Borde eliminado:** doble-montaje (guard `#mounted`); capa/iconSet declarados "tarde" (reactividad orden-independiente).

---

## 8. Elementos de capa hijos

### 8.1 `<cristae-point-layer>`

| Entrada | Tipo | Reactiva | Efecto |
|---|---|---|---|
| `.data` (prop) | `Item[]` | sí | `set` → patch/rebuild (§5.3 MODELO) |
| `.accessors` (prop) | objeto de accessors | sí | reemplazo → re-deriva + rebuild |
| `.iconSet` (prop) / `icon-set` (attr nombre) | IconSet / string | sí | reseed + rebuild (§5) |
| `.filters` (prop) | `[{id, predicate, deps?, rebuild?}]` | sí | reconciliación **por `deps`** (mismo `id` + `deps` distinto = replace; `deps` igual = no-op; sin `deps` = identidad de `predicate`) + rebuild. Ver MODELO §5.3 |
| `visible`/`opacity`/`interactive` | bool/num/bool (attrs) | sí | aplica en el próximo frame |
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
| `visible/opacity/interactive` | — | |

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
`data/` + `lit` (invariante de capas, MODELO §3.1; sin Leaflet/glify). Consume **solo la cara de
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
| `row-height` / `page-size` / `max-buttons` (attr) | number | sí | layout / paginación |
| `search` / `count-label` / `scroll-height` (attr) | string | sí | búsqueda controlada / pie / alto |
| **acceso** | `controls` → `PagedTable` (`setPage/setSearch/setPageSize/refresh/itemAtRow`) | acción | — |
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
- **Reposición continua:** `viewportchange` solo llega en moveend/zoomend (baja frecuencia por contrato), así que para seguir el paneo/inercia EN CONTINUO la tarjeta engancha además el `move` crudo del `L.Map` (vía `engine.getLeafletMap()`); se re-vincula por montaje en `cristae:ready`. Sin esto, la tarjeta y su clip saltaban recién al detenerse el mapa.
- Escucha los eventos de la lib en el **elemento mapa** (no en el engine) → sobrevive a un re-mount y lee la cámara viva.
- **`pinned` (default ON):** re-proyecta el ancla en cada reposición → la tarjeta sigue el pan/zoom. `pinned="false"` congela el punto de contenedor inicial (por tarjeta) → fija en pantalla, ajena a pan/zoom y al ancla viva (acompaña solo el scroll del widget).
- **`clip` (default ON):** `#applyClip` setea `clip-path: inset(...)` con la fracción que sobresale de la **región visible = rect del mapa − `viewport-insets`** (los mismos insets que usa auto-pan; así la tarjeta no se monta sobre los widgets/paneles). Geometría derivada del **tamaño cacheado al renderizar** (open/re-render; re-medido por `ResizeObserver` si el contenido cambia) + transform base-centro → **cero `getBoundingClientRect` del nodo por frame** (el único rect leído por reposición es el del mapa, que ya se leía). Recorte de compositor, sin relayout.
- **Auto-pan al abrir (solo `pinned`):** si la caja se sale de la región visible (contenedor − `viewport-insets`), `open` llama `camera.panBy` con el delta en px justo para meterla + `auto-pan-padding`. Mismo cálculo que el `_adjustPan` de Leaflet pero contra los insets del mapa. El `panBy` re-dispara `viewportchange` → reubica sobre el ancla viva (no re-evalúa auto-pan: solo `open`). Sin `pinned`, panear no movería la tarjeta → se omite.

---

## 9. Cámara

Todo **acción** (no estado): es la **única** vía de movimiento de viewport tras el montaje. Las props `initial-center`/`initial-zoom` solo fijan la vista inicial (§7.1). No hay prop reactiva de centro (MODELO §5.4). Aplica `viewport-insets`.

| Método | Complejidad | Notas |
|---|---|---|
| `setView(latlng, zoom)` / `panTo(latlng)` | O(1) | inmediato |
| `flyTo(latlng, zoom)` | O(1) | animado (easing es opción de `flyTo`, no un método aparte) |
| `fitBounds(bounds, {insets})` | O(1) | |
| `fitToLayer(layerId, {insets, maxZoom})` | O(n) (bounds de n puntos) | encuadra una capa |
| `revealPoint(layerId, id, {zoom})` | O(results·log maxZoom) si clusteriza | enfoca un punto (one-shot) dejándolo **visible individualmente**: si su capa clusteriza, sube el zoom al mínimo que lo desclusteriza. Sin cluster (o si ya está solo) = `setView` |
| `zoomIn(delta?)` / `zoomOut(delta?)` / `setZoom(zoom)` | O(1) | **ortogonal al follow**: el zoom no cancela un `followPoint` (ajusta escala, no reposiciona) |
| `panBy(offset, options?)` | O(1) | desplaza por delta en **px** de contenedor; **ortogonal al follow** (ajuste fino). Lo usa el auto-pan del popup (§8.5) |
| `followPoint(layerId, id, {zoom, reveal})` | O(1) por update | la cámara sigue la posición **viva** (se actualiza con `move`/`patch` del Source); **sin que el consumidor bombee**. `reveal:true` arranca al zoom mínimo desclusterizado |
| `stopFollow()` | O(1) | |
| `getCenter()/getZoom()/getBounds()` | O(1) | |
| `latLngToContainerPoint(latlng)` / `containerPointToLatLng(point)` | O(1) | proyección píxel ↔ geo **relativa al contenedor**; ancla overlays HTML en light DOM sin bajar a `getLeafletMap()` |

- **`followPoint` (clave):** el motor re-centra cuando la posición del `id` seguido cambia en el Source, coalescido a rAF. Reemplaza el bombeo manual `onVehicleUpdate→panToSmooth` (MODELO §14.1-6).
- **Test:** `followPoint('fleet', 7)`; luego `handle.move(7, lat, lng)` → la cámara re-centra **sin** llamadas del consumidor; un `move` de otro id no mueve la cámara.
- **`revealPoint` / `reveal`:** el zoom mínimo de desclusterización lo calcula `Cluster.declusterZoomFor` (§8.3, puro) y el motor lo **inyecta** en la cámara (`declusterZoomOf(layerId,id)`) leyendo el fold de la capa. La cámara no conoce el cluster — misma inyección que `resolveSource`. Enfocar un elemento seleccionado y que no quede escondido en una burbuja es así un one-shot (`revealPoint`) o un follow que arranca visible (`followPoint({reveal})`).

---

## 10. Eventos

MODELO §8. En el elemento como `CustomEvent` (prefijo `cristae:`) y en el motor vía `engine.on`.

```ts
Hit = { layerId, kind: 'point'|'polygon', ref, id, distancePx, zIndex, order }
// orden top-first: zIndex desc, order asc, distancePx asc
```

| Evento | `detail` | Complejidad de emisión |
|---|---|---|
| `cristae:ready` | `{}` | — |
| `cristae:pointermove` | `{lat,lng,x,y}` | O(1), throttled — **barato** (sin picking) |
| `cristae:hover` | `{hits, added, removed, x, y}` | O(H) — solo cuando **cambia** el set; trae deltas |
| `cristae:click` | `{hits, lat, lng, x, y, originalEvent}` | O(H) — todos los hits ordenados; el consumidor desambigua |
| `cristae:viewportchange` | `{center, zoom, bounds}` | O(1) — moveend/zoomend |
| `cristae:interactionstart` / `…end` | `{}` | O(1) — para que el consumidor frene su emitter |

- **Cursor automático (affordance de interactividad):** el motor pone `cursor:pointer` cuando el puntero cae sobre una feature de una capa interactiva con demanda de **click _u_ hover**, y lo restaura. **No requiere suscribir `cristae:hover`:** una capa clickeable (listener de `cristae:click`) ya muestra el puntero, igual que `.leaflet-interactive` en Leaflet. Para conseguirlo, la sesión de picking de hover (la que sabe si el puntero cae sobre una feature) corre también bajo demanda de click — aunque los EVENTOS `cristae:hover` se sigan emitiendo solo si hay demanda de hover. Implica que un mapa solo-click paga el picking de hover (throttled por `hover-throttle`) por el cursor. El consumidor no toca el cursor (vive en shadow DOM).
- **Sin `onDisambiguate` en el core:** `click` entrega todos los hits; el popup de desambiguación lo arma el consumidor con los `x,y` provistos.
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

**Objetivo de estado estable** (miles de updates/seg): la ruta caliente —`move`/recolor → encode → `bufferSubData` → draw— es **O(1) por elemento y [0-alloc]**, *bajo precondición de set sin cambios* (id con slot vigente) — path incremental, MODELO §17.5. Es la única garantía de alloc incondicional. Si una implementación asigna por elemento en esta ruta, está mal. **El rebuild NO tiene esa garantía:** `set`/filtro/cluster pasa por el `setData` de glify, que es O(n) y aloca O(n) (glify stock no tiene update in-place). El coalescing acota la *tasa* a ≤1 rebuild/flush de rAF, **no** el costo: si el set cambia cada frame se paga O(n)/frame. Mantener barato el rebuild es responsabilidad del *uso* (que el set cambie poco), no del scheduler (MODELO §17 intro).

---

## 13. Reglas de rendimiento (obligatorias en el hot-path)

(MODELO §17.) Render, picking, `Atlas.sync`, `notify`, `dispatch`:
- **Dos paths, dos presupuestos (MODELO §17 intro):** el **incremental** (`move`/recolor, los miles/seg) es `bufferSubData` al slot → **[0-alloc]** obligatorio (precondición: id con slot vigente). El **rebuild** (`set`/filtro/cluster) pasa por `setData` de glify → O(n) alloc inevitable; el coalescing acota su *tasa* (≤1/flush rAF), no su costo agregado ni garantiza que sea raro. Las reglas [0-alloc] aplican al incremental, no al rebuild.
- **Path incremental = escribir el buffer de glify, no forkear (mecanismo verificado, MODELO §17.5):** O(1) por bypass de la instancia (`instance.gl`/`typedVertices`/`getBuffer('vertices')`), sin fork ni monkey-patch. Funda: `mapCenterPixels` es fijo de por vida (`base-gl-layer.ts:164`, nunca recalculado) → el vértice es función pura del latLng → update puntual real. `move`: escribir `projX0(lng)-cx`, `projY0(lat)-cy` en `typedVertices[slot*7 .. +2]` + `gl.bufferSubData(.., base*4, verts, base, 2)` (forma de 5 args WebGL2 → sin `subarray`, **[0-alloc]**). Recolor: `encodeColor(tileIdx, norm, i, verts, base+2)` sobre `[base+2 .. +6]`.
  - **`[0-alloc]` exige proyección inlineada:** `map.project()` aloca (`Point` + `LatLng`); usar `projX0/projY0` (EPSG:3857 zoom-0, que glify ya exige — `points.ts:100`). `projX0(lng)=256*(lng/360+0.5)`; `projY0(lat)=256*(0.5 − 0.25/π·ln((1+s)/(1−s)))` con `s=sin(clamp(lat,±85.0511)·π/180)`.
  - **Invariantes:** (1) **recapturar `typedVertices` + reconstruir `id→slot` tras cada rebuild** (el `Float32Array` se reemplaza en `render()`, `points.ts:114`; el `WebGLBuffer` es estable); (2) **assert `instance.bytes===7`** + offsets → fallar ruidoso si glify cambia el layout; (3) hover/click nativo deshabilitado (`sensitivity:0`): el path no toca `allLatLngLookup` (stale, no usado — el picking lee el buffer, que sí está fresco; `GlifyLayer.js:88-94` comparte buffer). `DYNAMIC_DRAW` se logra re-emitiendo `bufferData` sobre el buffer capturado (sin tocar glify).
- **Arrays de instancia reusados** + truncado de `length` (no `new Array`, no `.map`/`.filter` que asignan; usar `for`/`forEach`).
- **Objeto scratch mutado-y-retornado** **solo en el path de rebuild** (callback `color:(i)=>…` de glify): `encodeColor` devuelve un único `{r,g,b,a}` reusado — seguro porque glify hace `{...colorFn(i), a}` sincrónicamente (`points.ts:136`). El path incremental no usa scratch-objeto (escribe el slot).
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
| `Source`/handle | version igual ⇒ 0 rebuild; `move` ⇒ 0 `setData` (espiar): hace `bufferSubData` y [0-alloc] (allocation profiler); `set` en zoom ⇒ update no descartado |
| buffer incremental | `move`/recolor escribe el slot correcto del `typedVertices` (leer de vuelta el buffer GL); assert de layout falla si `bytes ≠ 7`; tras `setData` el mirror se resetea desde `data` |
| reactividad | N asignaciones/tick ⇒ 1 rebuild con el valor final |
| filtros | mismo `id` + `deps` distinto ⇒ predicado reemplazado y re-evaluado; `deps` igual ⇒ 0 rebuild aunque el predicado sea otra instancia |
| cámara | `followPoint` re-centra sin bombeo; insets aplicados |
| eventos | `hover` solo emite al cambiar el set; `click` entrega hits ordenados; cursor automático |
| lifecycle | StrictMode doble-mount ⇒ 1 motor; `destroy()` cancela rAF y quita listeners (sin leak) |

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
| `window.L.glify` global / orden de `<script>` | L inyectado en constructor (§6) |
| doble-montaje StrictMode | guard `#mounted` + reuse de `L.map` (§7.3) |
| shader recompila al crecer iconos | dims son uniforms, no literales GLSL (§4.2) |

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
| Leaflet de versión/instancia distinta | guard en runtime → error claro al construir |
| filtro recompilado con el mismo `id` (cambio de modo) | reconciliar por `deps`: mismo `id` + `deps` distinto = replace + re-evalúa; `deps` igual = no-op (§8.1). Reconciliar solo por `id` dejaría el predicado viejo activo |
| upgrade de glify cambia el layout de vértices | assert `instance.bytes === 7` + offsets en construcción → fallar ruidoso, nunca corromper el buffer en silencio (§13, MODELO §17.5) |
| capa con 0 ítems | render vacío válido (no caso especial) |

---

## 16. Invariantes globales (un implementador no debe violarlas)

1. **Cero estado mutable de módulo/singleton.** Todo estado vive en una instancia (engine/capa/binding) o se inyecta. (Mata multi-mapa y embebido seguro.)
2. **El core no conoce dominio.** Ningún nombre público/interno con `vehicle`, `geofence`, `connection`, `etapa`. `variant`/`text` son strings opacas.
3. **No se forkea ni se reescriben los algoritmos de glify.** El rebuild (`setData`/`resetVertices`), supercluster y picking migran intactos. Se **añade** un path incremental (`move`/recolor) que escribe el buffer interleaved de glify por `bufferSubData` desde el motor — sobre los recursos GL de la instancia, **sin** forkear glify ni mutar su prototipo (mismo patrón que el draw de picking ya existente). El `[0-alloc]`/O(1) vive en ese path; el rebuild sigue siendo O(n) coalescido (MODELO §17.5, §17 intro).
4. **Estado → reactivo; acción → método.** Sin terceros casos (§11).
5. **Cero-alloc en caliente.** (§13.)
6. **El atlas se reusa y se le agrega; nunca se reconstruye desde cero** salvo regrow por capacidad.
7. **Una sola instancia de Leaflet**, inyectada.

> Si una decisión de implementación obliga a violar una invariante, **es la implementación la que está mal**, no la invariante. Volver a MODELO.md/SPECS.md antes de improvisar.
