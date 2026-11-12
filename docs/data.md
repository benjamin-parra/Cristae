# Capa de datos — Cristae

La capa reactiva de datos del motor. Implementa el contrato `Source` (SPECS §2) sobre dos
piezas portadas del framework anterior — `Store` y `Emitter` — más el pegamento `Source`
con sus rutas de uso (B: adaptar/envolver una reactividad externa; C: empujar). El emitter
propio es **opcional**: en la ruta B genérica (`defineSource`) lo aporta la librería del consumidor.

Convenciones de complejidad: `n` = ítems de la capa, `k` = ítems sucios (`dirtyIds`),
`f` = filtros activos, `L` = listeners. `[0-alloc]` = no asigna en estado estable.

---

## `safe` / `safeDispatch`

Únicos dos helpers de aislamiento de errores en caliente. No hay `try/catch` en bloque en
el hot-path; vive una sola vez aquí dentro.

| API | Propósito | Firma | Complejidad |
|---|---|---|---|
| `safe` | Aísla una llamada; devuelve el valor en éxito, invoca `onError` en fallo. | `(fn, arg, onError) → ReturnType \| undefined` | O(1) `[0-alloc]` |
| `safeDispatch` | Fan-out a N listeners; uno que lanza no detiene al resto. | `(listeners, data, onError) → void` | O(L) `[0-alloc]` |

`onError` debe ser una **referencia estable de módulo**, nunca una clausura del call-site
(asignar por llamada colapsa el GC). `listeners` son `{ callback }`.

```js
import { safeDispatch } from './safe.js'
function reportError(e) { if (__DEBUG__) console.error('[x] listener lanzó', e) }
safeDispatch([{ callback: () => { throw 1 } }, { callback: d => use(d) }], data, reportError)
// el segundo listener recibe `data` igual; reportError se llamó 1 vez
```

---

## `filters` — `makeFilter` / `makeListener`

Factories diminutas (no clases). Validación mínima.

| API | Propósito | Firma | Complejidad |
|---|---|---|---|
| `makeFilter` | Construye un filtro componible. | `(id, predicate) → { id, f }` | O(1) |
| `makeListener` | Construye un listener para `safeDispatch`. | `(id, callback) → { id, callback }` | O(1) |

```js
import { makeFilter, makeListener } from './filters.js'
const activos = makeFilter('activos', it => it.activo)
const log = makeListener('log', data => console.log(data.length))
```

---

## `Store`

Store reactivo componible. Dos capas de filtros (heredados del padre + propios) sobre el
dato base, version-tracking opcional para `patch` O(k), fan-out síncrono cero-alloc.

Construcción: `new Store(items?, { versionTracker?: { idOf, hashOf } })`. Con
`versionTracker` se habilita el camino `patch`; sin él, todo cae a `update`.

| Método | Propósito | Firma | Complejidad |
|---|---|---|---|
| `update(items)` | Reemplazo total; re-genera filtrados. | `(Item[]) → this` | O(n·f) |
| `patch(items, dirtyIds)` | Re-evalúa solo los sucios; cae a `update` si uno cambia de membresía. | `(Item[], Set) → this` | O(k·f) (peor: O(n·f)) |
| `addFilter(filter)` | Agrega un filtro propio y re-filtra. | `({id,f}) → this` | O(n·f) |
| `removeFilter(id)` | Quita un filtro propio. | `(id) → this` | O(n·f) |
| `addListener(listener)` | Suscribe `{id, callback}`. | `({id,callback}) → this` | O(1) |
| `removeListener(id)` | Desuscribe por id. | `(id) → this` | O(L) |
| `notifyChanges()` | Fan-out cero-alloc del snapshot filtrado. | `() → void` | O(L) `[0-alloc]` |
| `reactiveCompose(parent)` | Hereda filtros del padre y re-genera ante sus cambios. | `(Store) → this` | O(n·f) inicial |
| `destroy()` | Quita su listener del padre y libera estado. | `() → void` | O(1) |
| `filtered` (getter) | Snapshot filtrado — **ref estable entre flushes**. | `→ Item[]` | O(1) |
| `version()` / `dataVersion` | Version monótona creciente. | `→ number` | O(1) |
| `dirtyIds` (getter) | Set reusable de ids sucios del último `update`. | `→ Set` | O(1) |

Notas:
- `filtered` devuelve la **misma referencia** mientras no cambie estructuralmente; no copiar
  por emit (rompe el dirty-check y asigna).
- `dirtyIds` es un Set reusable (se limpia y rellena en cada `update`); no reasignarlo afuera.
- id duplicado en el snapshot → se toma el primero (índice base).

```js
import { Store } from './Store.js'
import { makeFilter, makeListener } from './filters.js'

const store = new Store([], { versionTracker: { idOf: it => it.id, hashOf: it => it.v } })
store.addFilter(makeFilter('activos', it => it.activo))
store.addListener(makeListener('render', data => draw(data)))
store.update([{ id: 1, activo: true, v: 0 }])
// cambia solo el ítem 1 → patch O(k):
store.patch([{ id: 1, activo: true, v: 1 }], store.dirtyIds)
```

---

## `Emitter`

Difusor adaptativo. Coalesce y desacopla la tasa de emisión del ritmo del productor.

Construcción: `new Emitter({ source, version, interval?, onFlush?, defer?, maxInterval? })`.

| Método / prop | Propósito | Firma | Complejidad |
|---|---|---|---|
| `subscribe(id, cb)` | Agrega un suscriptor. | `(id, fn) → this` | O(1) |
| `unsubscribe(id)` | Quita un suscriptor. | `(id) → this` | O(1) |
| `notify()` | Entrada del tunnel reactivo (interval 0); no-op en throttled. | `() → void` | O(1)+O(subs) si emite |
| `sync()` | Avanza el tracker de version sin emitir. | `() → void` | O(1) |
| `interval` (get/set) | Cadencia en ms; `0` = tunnel reactivo. | `number` | O(1) |
| `defer` (get/set) | `'none'` \| `'raf'`. | `string` | O(1) |
| `snapshot` (getter) | Último dato emitido (ref estable). | `→ any` | O(1) |
| `destroy()` | Limpia timer **y rAF pendiente**, vacía subs. | `() → void` | O(1) |

Dos modos:
- **throttled** (`interval > 0`): un `setInterval` chequea `version()` cada tick; si cambió,
  lee `source()` una vez y emite a todos. Dirty-skip: si `version()` no cambió, cero trabajo.
- **tunnel reactivo** (`interval === 0`): sin loop; el productor llama `notify()` tras mutar.

`defer: 'raf'` coalesce múltiples cambios del mismo tick en **una** emisión en el próximo
`requestAnimationFrame` (guard contra doble-agendado). El cap de intervalo es configurable vía
`maxInterval` (por defecto `Infinity`). Fallback de rAF → `setTimeout(cb, 0)` si no existe rAF;
`destroy()` cancela con el canceller correcto.

```js
import { Emitter } from './Emitter.js'
const emitter = new Emitter({
  source: () => store.filtered,
  version: () => store.version(),
  interval: 0,        // tunnel reactivo
  defer: 'raf',       // coalesce a rAF
})
emitter.subscribe(Symbol('w1'), data => widget.patch(data))
store.update(items); emitter.notify()    // emite en el próximo frame
```

---

## `Source` — `defineSource` / `createSource`

Pegamento del contrato `Source<Item>` (SPECS §2). Un `Source` expone `accessors`,
`variants?`, `getSnapshot()`, `version()`, `subscribe(cb) → unsubscribe`, `dirtyIds?()`.

Dos primitivas, un solo eje — **quién posee la notificación**:

| Quién notifica | Primitiva | Cuándo |
|---|---|---|
| el consumidor (su reactividad) | `defineSource` | ya hay signals/zustand/rxjs y se quiere interceptar |
| el motor (Store+Emitter internos) | `createSource` | no hay librería; se muta imperativamente |

`Store`/`Emitter` son internos: `createSource` los posee y el consumidor nunca los ve.

**Acceso:** una Source se adjunta a una vista por la prop declarativa del elemento
(`pointLayer.source = src`), simétrica con `.data`. La **misma** Source puede adjuntarse a N vistas
(dos mapas, mapa + tabla): el motor solo llama a sus miembros de lectura, así que el filtro/estado
se computa una vez y todas las vistas lo reflejan. `engine.attachSource(id, src)` es el interno que
usa ese setter; no es API de consumidor.

### `defineSource` — ruta B genérica (cualquier librería de reactividad)

| API | Propósito | Firma | Complejidad |
|---|---|---|---|
| `defineSource` | Adapta una librería de reactividad a un `Source` sin Store/Emitter propios del motor. | `({ accessors, variants?, getSnapshot, subscribe, version?, dirtyIds?, itemById? }) → Source` | O(1) |

El **emitter deja de ser house-first**: `subscribe(notify)` es el punto de intercepción de
señales. La librería invoca `notify()` (sin args) cuando un dato cambia → el motor relee el
snapshot. Todo lo que no sea `accessors` + `getSnapshot` + `subscribe` es opcional y degrada:

| Provisto | Comportamiento del motor |
|---|---|
| solo `getSnapshot` + `subscribe` | **rebuild-on-notify** O(n) por cambio — correcto, simple |
| + `itemById` + `dirtyIds()` | **patch O(k)** incremental (solo re-encodea lo sucio) |
| + `version()` | dirty-check para consumidores que la observan; si falta, se sintetiza una monótona que avanza en cada notify |

`subscribe` puede devolver el teardown en cualquier forma común — función, objeto con
`unsubscribe()` (RxJS), objeto con `dispose()` (Solid root) o nada — `toUnsub` lo normaliza a
función de baja. **Requisito mínimo:** `accessors.idOf` + `accessors.positionOf` + `getSnapshot`
+ `subscribe` (validado solo en `__DEBUG__`).

```js
import { defineSource } from './Source.js'

const ACCESSORS = { idOf: m => m.id, positionOf: m => ({ lat: m.lat, lng: m.lng }), variantOf: m => m.tipo }

// Preact Signals — `effect` devuelve su dispose (función) → toUnsub lo usa tal cual.
import { signal, effect } from '@preact/signals-core'
const moviles = signal([])
const source = defineSource({
  accessors: ACCESSORS,
  getSnapshot: () => moviles.value,                 // ref estable mientras no se reasigne .value
  subscribe: (notify) => effect(() => { moviles.value; notify() }),
})
fleetLayer.source = source                            // declarativo, simétrico con .data
moviles.value = [...]                                 // un cambio → un re-read

// Zustand vanilla (dep del proyecto) — `subscribe` ya devuelve la baja.
import { createStore } from 'zustand/vanilla'
const store = createStore(() => ({ items: [] }))
defineSource({
  accessors: ACCESSORS,
  getSnapshot: () => store.getState().items,
  subscribe: (notify) => store.subscribe(notify),
})

// RxJS — el teardown es una Subscription con `.unsubscribe()` → toUnsub lo envuelve.
import { BehaviorSubject } from 'rxjs'
const flota$ = new BehaviorSubject([])
defineSource({
  accessors: ACCESSORS,
  getSnapshot: () => flota$.value,
  subscribe: (notify) => flota$.subscribe(() => notify()),
})

// Misma `source` sirve a la tabla y al mapa: ambos consumen el contrato Source (la tabla
// ignora `accessors` y proyecta con su template/binder). Un cambio refresca a los dos.
```

Para **alta frecuencia** (mover móviles muchas veces/segundo sin rebuild) usar `createSource`
(ruta C, `move` O(1) `[0-alloc]`), no `defineSource` — esta refresca por snapshot.

### `createSource` — ruta C (consumidor sin reactividad propia)

| API | Propósito | Firma | Complejidad |
|---|---|---|---|
| `createSource` | Devuelve **un** objeto que ES el `Source` (lectura) y que además se muta (dueño). | `(accessors \| { fields, ...accessors }, variants?) → Source` | O(1) |

Un solo objeto: los miembros de **lectura** son el contrato `Source`
(`getSnapshot`/`subscribe`/`version`/`itemById`/`dirtyIds`/`moveDirtyIds`/`appendedPoints`/`accessors`/`variants`) y
los de **escritura** son del dueño. Se adjunta tal cual (`layer.source = src`); el motor solo lee.
El `Emitter` interno corre en tunnel reactivo (interval 0, defer 'raf'). No hay handle aparte ni
`.source` anidada.

| Método de escritura | Propósito | Complejidad |
|---|---|---|
| `set(items)` | Reemplazo total → diff de id-set. | O(n) |
| `patch(items, dirtyIds)` | Patch parcial; rebuild solo si cambia membresía de filtro. | O(k) |
| `move(id, lat, lng, heading?)` | Reposiciona **sin rebuild** y, si se pasa `heading`, también rota. | O(1) `[0-alloc]` lado-dato |
| `remove(id)` | Quita un ítem. | O(n) (filtra) |
| `append(id, ...points)` | Suma puntos al final del path de un id (requiere `pathOf`); el path del consumidor no se toca. | O(puntos) |
| `addFilter(f)` / `removeFilter(id)` | Filtros sobre el Store interno (computados una vez). | O(n·f) |
| `destroy()` | Libera emitter, store y mapas. | O(1) |

**`move` (clave):** es O(1) y **no reconstruye**. Mantiene un `Map<id,{lat,lng}>` de overrides
de posición que `move` actualiza; el `positionOf` efectivo del `Source` devuelve el override si
existe. Marca el id en un Set reusable (`moveDirtyIds()`) y notifica (coalescido a rAF). La
escritura real al buffer GPU (slot-write sobre los dirty ids) la hace la PointLayer — aquí solo
vive el lado-dato.

**El rumbo de `move`.** `heading` es el rumbo en grados del ícono, si su set rota. Con uno que no es un número
finito, o sin él, el ítem conserva el rumbo que tenía; `set`, `patch` y `remove` lo descartan, igual que a la
posición movida. El `headingOf` efectivo del `Source` es el del `move`, luego el del ítem, luego `0`. La capa sube
la posición y el ángulo en **una** escritura al buffer, con la misma cuenta con que codifica un ítem.

**`append` (clave):** hace para el path lo que `move` para la posición: guarda lo sumado aparte, el
`pathOf` efectivo lo devuelve al final del path —copiándolo: O(path) por lectura, lo mismo que cuesta
recorrerlo— y la ventana lo anuncia por `appendedPoints()` —un `Map<id, puntos>`— para que la capa de
líneas escriba sólo eso. Un id desconocido lanza `RangeError`, sin puntos no hace nada, y un
`set`/`patch`/`remove` del id descarta lo sumado. Semántica de lo sumado: [`lines.md`](lines.md#un-track-que-crece--append).

```js
import { createSource } from './Source.js'
const sensors = createSource({ idOf: m => m.id, positionOf: m => m.pos })
sensorsLayer.source = sensors               // declarativo; mismo objeto a N vistas
sensors.set([{ id: 1, pos: { lat: 0, lng: 0 } }])
ws.onMsg(m => sensors.move(m.id, m.lat, m.lng, m.rumbo))   // 0 rebuilds; sin `m.rumbo`, el rumbo anterior
```

**`fields` — los accessors como nombres de campo.** Un accessor que sólo lee un campo se escribe como string, y
`createSource` lo compila a función. Es el mismo `fields` que lleva una capa por atributo
([`elements.md`](elements.md#los-atributos--of-y-fields)):

```js
const flota = createSource({
  fields: { id: 'patente', position: ['lat', 'lng'], variant: 'estado', heading: 'rumbo' },
})
flota.set([{ patente: 'AB-123', lat: -35.4, lng: -71.6, estado: 'activo', rumbo: 90 }])
```

- **Cada clave es un accessor sin el `Of`.** `id`, `position`, `variant`, `heading`, `text`; el valor es el
  nombre de un campo, con `.` para anidar (`'conductor.nombre'`). `position` admite el par `['lat', 'lng']`, o
  un campo que ya es `{ lat, lng }` o `[lat, lng]`.
- **Los ítems de una capa por `url`** toman por id el `id` del feature cuando el documento lo trae (el `id` de GeoJSON) y, sólo si falta, su índice en el archivo; `fields.id` manda sobre los dos.
- **`fields.id` basta:** `createSource` compila `fields` antes de exigir `idOf`. Sin ningún id, el `TypeError` es el de siempre.
- **Precedencia.** Una función en el mismo objeto gana sobre su campo, y avisa una vez por clave. Con una capa por
  `url`, el orden completo es: el valor por defecto de la capa, luego `fields`, luego las funciones.
- **Los lectores son totales.** Un ítem `null` o un campo ausente dan el neutro del canal: `id`, `variant` y `text` dan
  `''` y `heading` da `0`. Los demás canales devuelven el valor crudo. `heading` acepta también una cadena numérica
  (`"90"` da `90`) y `text` de un objeto da `''`. Un `id` ausente da `''` para todos los ítems que no lo traen: esos
  ítems comparten identidad, así que el dato debe llevar el campo del id.
- **Sin costo en estado estable.** El camino anidado se parte una vez, al compilar. El par `{ lat, lng }` armado de dos
  campos se guarda por ítem y se reusa mientras los dos valores no cambien, así que `move` y `patch` no asignan de más.
- **Lo que no hace.** No hay expresiones ni formateo: lo que se transforma va por una función en `accessors`.

### `Source` antes de `ready`

`<cristae-point-layer>.source` existe **desde la construcción** del elemento. Sin una `Source` del consumidor, es
una `Source` pendiente propia del elemento, que sirve antes de `ready`, con `data` o con `url`, y que tras el
montaje es **la misma** que `handle.source`: la identidad no cambia, tampoco si el elemento se desmonta y vuelve a
montarse.

```js
const flota = document.querySelector('#flota')       // <cristae-point-layer url="./flota.geojson" …>
ws.onMsg(m => flota.source.move(m.id, m.lat, m.lng, m.rumbo))   // sin esperar a `ready`
```

- **La cola.** Antes de `ready` la pendiente encola `set`, `patch`, `remove`, `move`, `append`, `addFilter` y
  `removeFilter`; los `move` del mismo id entre dos operaciones que no son `move` se colapsan en el último, y uno
  sin rumbo conserva el del anterior. Las lecturas dan el neutro (sin ítems).
- **Cuándo se aplica.** Al alta, el motor adopta la pendiente y reproduce la cola: con `data`, justo después de
  cargarlo; con `url`, tras la primera aplicación o el primer fallo de la carga. Un `move` sobre un id que el
  archivo no trae se ignora, como en cualquier `Source`.
- **La del consumidor gana.** Con una `Source` asignada, es ésa la que devuelve `el.source`.
- **Entre el alta y la primera carga.** Con `url`, la capa retiene lo escrito antes de `ready`. Un `move` hecho
  después del alta y antes de que llegue la primera carga va a la `Source` ya ligada, que aún no trae el ítem, y se
  ignora. Se espera al evento `cristae:data-load` para mover por `url`.
- **Un `set` reemplaza la cola.** Escribir `set` varias veces antes de `ready` retiene sólo el último, con los filtros.
- **Remontar.** Si el elemento se desconecta y se vuelve a conectar, conserva la misma `Source`, con los `accessors`,
  los `fields`, `id-of` y los `variants` del primer montaje, y con los ítems que ya tenía. Para cambiarlos, se
  asigna una `Source` propia o se crea un elemento nuevo.

**Compartir entre vistas** — el filtro vive en la Source, no por componente:

```js
const fleet = createSource(ACCESSORS); fleet.set(MOVILES)
mapA.querySelector('#fleet').source = fleet
mapB.querySelector('#fleet').source = fleet
fleet.addFilter(makeFilter('vel', m => m.speed > 0))   // UNA vez → ambos mapas
```

---

## Garantías

- **Refs estables:** `filtered` / `snapshot` no se copian por emit.
- **Dirty-skip:** sin cambio de `version()`, cero trabajo.
- **patch O(k):** solo cae a regenerado completo si un sucio cambia de membresía de filtro.
- **`[0-alloc]` en caliente:** `safeDispatch` y `notifyChanges` no asignan; `move` no rebuild.
- **Sin singletons mutables de módulo:** todo el estado vive por instancia.
- **Lifecycle limpio:** `Store.destroy()` quita su listener del padre; `Emitter.destroy()`
  cancela el rAF pendiente.
