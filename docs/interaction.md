# Interacción — picking, registro de capas y bus de eventos

> Pieza de [Cristae](../MODELO.md). Implementa [SPECS §10](../SPECS.md) (forma del `Hit` y
> orden top-first). Es el pipeline que traduce un evento del puntero en una lista ordenada de
> impactos sobre las capas. Ortogonal al [atlas](./atlas.md) y a la
> [retención de tiles](./tiles.md).

El pipeline tiene tres etapas, cada una en una pieza independiente y genérica (ninguna conoce
el dominio):

```
puntero → HitResolver  → LayerRegistry        → EventBus
          (geometría)    (orden + gating)        (ruteo + diffing de hover)
```

1. **`HitResolver`** sabe geometría Leaflet: dado un layer, produce las **partes** de hit
   (`{ ref, distancePx }`) eligiendo **una** estrategia según las capacidades del layer.
2. **`LayerRegistry`** registra capas sobre esos resolvers, las ordena **top-first** y solo
   pide picking de los canales con **demanda activa**.
3. **`EventBus`** rutea los hits ya resueltos hacia los handlers suscritos, deriva los eventos
   de hover (`start`/`end`) diffeando el set actual contra el anterior, y lleva el conteo de
   demanda que apaga el picking ocioso.

---

## La forma del `Hit`

El registro envuelve cada parte geométrica con la metadata de la capa para formar el `Hit`
completo ([SPECS §10](../SPECS.md)):

```js
Hit = { layerId, kind: 'point'|'polygon', ref, id, distancePx, zIndex, order }
// orden top-first: zIndex desc, order asc, distancePx asc
```

- `ref` — la referencia estable de la capa (objeto/función) que el resolver emite; el consumidor
  la usa para identificar **qué** fue golpeado.
- `id` — id opcional provisto por el resolver; si está, es la clave estable de diffing de hover.
- `distancePx` — distancia en píxeles del puntero al elemento (0 = dentro). Ausente cuenta como
  `+Infinity` (queda al fondo del desempate).
- `zIndex` / `order` — z del pane y orden de declaración; definen el desempate top-first.

Las **máscaras de canal** ([`events.js`](../src/events/events.js)) son el otro tipo público:

| Constante | Valor | Tipos de evento que la activan |
|---|---|---|
| `EVENT_CLICK` | `1` | `'click'` |
| `EVENT_HOVER` | `2` | `'hover'`, `'hover:start'`, `'hover:end'` |

`maskOfEventType(eventType) → number` mapea un tipo a su bit (los tres sabores de hover
comparten `EVENT_HOVER`; un tipo desconocido → `0`, sin demanda).

---

## `HitResolver` — geometría, una estrategia exclusiva

No conoce el dominio. Dado un `layer` y un `ref` estable, devuelve un resolver
`(baseEvent) => [{ ref, distancePx }]`. Construcción: `new HitResolver(map)`.

| Método | Firma | Complejidad | Notas |
|---|---|---|---|
| `createResolver(layer, ref)` | `(layer, ref) → (baseEvent) => parts[]` | O(1) build | capa agrupada (`eachLayer`) → resolver de grupo; capa simple → resolver de hoja |
| `zIndexOf(layer)` | `(layer) → number` | O(1) | z-index leído del pane de la capa; sin pane → 0 |

El resolver de **hoja** elige **una sola** estrategia, exclusiva y sin fallthrough, según las
capacidades geométricas del layer:

| # | Capacidad detectada | Estrategia | Capas típicas | `distancePx` |
|---|---|---|---|---|
| 1 | `_containsPoint` | basada en **trazo** (la más precisa) | Polygon, Polyline, Circle, CircleMarker, Rectangle | distancia al punto más cercano (`closestLayerPoint`) o 0 |
| 2 | `getLatLng` | basada en **punto** (centro + tolerancia) | Marker | distancia euclídea al centro, si ≤ radio de impacto |
| 3 | `getBounds` | basada en **área** | ImageOverlay, VideoOverlay, SVGOverlay | 0 si el latlng cae dentro de los bounds |

La tolerancia de la estrategia 2 (`#hitRadiusOf`) es el radio del círculo
(`getRadius`/`_radius`) o la media diagonal del icono (`iconSize`), o `DEFAULT_HIT_RADIUS`
(10 px). Todo resolver corta temprano si el evento no trae `latlng` o si la capa ya no está en
el mapa (`map.hasLayer`).

El resolver de **grupo** itera los hijos **en tiempo de resolución** (adds/removes dinámicos
funcionan), cacheando el resolver de cada hijo de forma lazy en un `WeakMap` (se libera solo
cuando el hijo se recolecta).

---

## `LayerRegistry` — orden top-first y gating por demanda

Genérico sobre funciones resolver: no conoce capas de puntos ni de polígonos, solo entradas
con un par de resolvers (click/hover), z-index, orden de declaración, visibilidad y máscara de
canales activos. Construcción: `new LayerRegistry(hitResolverOrMap)` (acepta un `HitResolver`
ya construido o un `map` para fabricar el por-defecto sobre Leaflet).

| Método | Firma | Complejidad | Notas |
|---|---|---|---|
| `registerLeafletLayer(layerId, layer, opts?)` | `(string, layer, {kind?, zIndex?, resolveClick?, resolveHover?, ref?, declOrder?}) → ref` | O(1) | deriva z-index y resolver del `HitResolver`; click/hover comparten el resolver geométrico salvo override |
| `upsertResolver(entry, layerObject?)` | `(entry, obj?) → void` | O(1) | inserta/reemplaza una entrada genérica; **preserva** la máscara activa previa si la nueva no la trae |
| `resolveHits(eventType, baseEvent)` | `(string, evt) → Hit[]` | O(n log n) | recolecta hits de capas **visibles**, solo de resolvers cuyo canal tiene demanda, y los devuelve **ordenados top-first** |
| `setLayerVisibility(layerId, visible)` | `(string, bool) → bool` | O(1) | gating por visibilidad; capa oculta no aporta hits |
| `isLayerVisible(layerId)` | `(string) → bool\|null` | O(1) | — |
| `setLayerDemandMask(layerId, mask)` | `(string, number) → bool` | O(1) | fija la máscara de canales activos de la capa (la calcula el motor desde el `EventBus`) |
| `demandMaskOf(layerId)` | `(string) → number` | O(1) | máscara activa actual (0 si no hay) |
| `getLayer(layerId)` | `(string) → obj\|null` | O(1) | el objeto de capa registrado |
| `getLayers()` | `() → {layerId, kind, zIndex, active}[]` | O(n log n) | vista ordenada top-first para inspección/UI; no resuelve hits |
| `removeByLeafletLayer(layer)` | `(layer) → string[]` | O(n) | quita todas las capas de ese objeto Leaflet; devuelve los layerIds removidos |
| `removeByLayerId(layerId)` | `(string) → void` | O(1) | — |
| `layerIds()` / `nextDeclOrder()` | — | O(n) / O(1) | utilidades |

El **gating doble** es la clave de eficiencia (`#resolveParts`): una capa solo se pickea si
(a) está visible **y** (b) su `activeMask` incluye el canal del evento. Para `click` se
consulta el resolver de click solo si `activeMask & EVENT_CLICK`; para hover, solo si
`activeMask & EVENT_HOVER`. Sin demanda de un canal, su geometría **ni se evalúa**.

El **orden top-first** del resultado (`zIndex` desc, `order` asc, `distancePx` asc) es el
contrato de [SPECS §10](../SPECS.md): el consumidor desambigua (qué quedó "arriba") sin
recalcular geometría.

---

## `EventBus` — ruteo, diffing de hover y conteo de demanda

Rutea los hits ya resueltos hacia los handlers suscritos por tipo de evento y por capa, deriva
los eventos de hover (`start`/`end`) diffeando el set actual contra el anterior por una clave
estable de elemento, y lleva el **conteo de demanda** que apaga el picking ocioso.
Construcción: `new EventBus(onDemandChange?)` — `onDemandChange(layerId|null)` notifica al
motor que recalcule la máscara activa (`null` = demanda global cambió, afecta a todas).

| Método | Firma | Complejidad | Notas |
|---|---|---|---|
| `on(type, callback)` | `(string, fn) → unsubscribe` | O(1) | escucha **todas** las capas |
| `on(type, layerIds, callback)` | `(string, id\|id[], fn) → unsubscribe` | O(1) | filtra por capa(s); la baja es idempotente |
| `dispatch(kind, hits, baseEvent)` | `('pointer:move'\|'click'\|'hover'\|'hover:out', Hit[], evt) → void` | O(H + L) | despacha según el `kind`; deriva hover:start/end |
| `clearLayer(layerId)` | `(string) → void` | O(active) | fuerza `hover:end` de los elementos de una capa que dejó de ser resoluble (oculta/removida) |
| `demandMaskFor(layerId)` | `(string) → number` | O(1) | máscara combinada = demanda global \| demanda de esa capa |

### Diffing de hover

`dispatch('hover', hits, …)` emite `'hover'` con el set vigente y además calcula los **deltas**:
mantiene un `Map<claveEstable, hit>` del hover anterior y, contra el nuevo set, emite
`'hover:start'` para las claves nuevas y `'hover:end'` para las que desaparecieron. La clave
estable (`#keyOf`) es `layerId#id` si el hit trae `id`, o `layerId#refId` derivando un entero
del `ref` vía `WeakMap` — así el mismo elemento se reconoce entre flushes aunque cambie el
objeto `hit`. `dispatch('hover:out', …)` cierra toda la sesión de hover (emite `hover:end` de
todo lo vigente).

### Por qué el conteo de demanda evita picking innecesario

Cada `on(...)` con un tipo que mapea a un canal **incrementa** un contador; la baja lo
**decrementa**. Hay dos niveles: `#globalDemand` (handlers que escuchan todas las capas) y
`#layerDemand` (por capa). `demandMaskFor(layerId)` combina ambos en una máscara de bits, que
el motor empuja al registro vía `setLayerDemandMask`. El efecto: **si nadie suscribió un
handler de hover, ningún hover se resuelve** — el `HitResolver` no se invoca para ese canal.
El picking de hover (que correría en cada `pointer:move`, lo más frecuente) solo se paga cuando
alguien lo escucha. `onDemandChange` dispara el recálculo justo cuando un contador cruza de 0 a
1 o de 1 a 0.

---

## Nota de consumo — hover/click con JS puro

Los handlers de `hover`/`click` (sea vía `bus.on(...)` o los `CustomEvent` `cristae:hover` /
`cristae:click` del `<cristae-map>`) deben manipularse con **JS puro sobre el DOM**, no a través
de wrappers que reconstruyen el árbol ante un cambio de estado interno (p. ej. un componente
React que re-renderiza). Dos motivos:

1. **Frecuencia.** El hover dispara en cada `pointer:move`; enrutarlo por el ciclo de
   render/reconciliación de un framework introduce trabajo y latencia por frame justo en el
   canal más caliente. La actualización debe ser una mutación puntual (toggle de clase, set de
   texto), no un re-render.
2. **Estabilidad del set.** Una reconstrucción del DOM mientras el puntero está sobre un
   elemento puede desincronizar el diffing de hover (`hover:start`/`hover:end` se derivan de
   claves estables): si el nodo objetivo se reemplaza, el estado externo deja de corresponder al
   set vigente. Se muta en sitio el nodo existente; nunca se recrea la lista para reflejar la
   selección.

Ejemplo del patrón: un picker de selección múltiple pinta los hits una vez y, al elegir,
**conmuta la clase `.sel`** sobre los botones existentes en lugar de re-renderizar la lista.

---

## Invariantes

1. **Una sola estrategia por capa simple** en `HitResolver`: exclusiva, sin fallthrough; la
   capacidad geométrica del layer la determina.
2. **Top-first determinista:** `resolveHits` siempre ordena `zIndex` desc, `order` asc,
   `distancePx` asc; sin `distancePx` → al fondo.
3. **Gating doble en el registro:** capa invisible o sin la máscara del canal → no se pickea.
4. **Sin picking de canal sin demanda:** el conteo del bus garantiza que un canal sin handlers
   tenga máscara 0 y por tanto no se evalúe.
5. **Hover consistente al desaparecer una capa:** `clearLayer` fuerza `hover:end` para que el
   estado externo no sobreviva a la capa que lo originó.

---

## Ejemplo de uso

```js
import L from 'leaflet'
import { LayerRegistry } from './src/interaction/LayerRegistry.js'
import { EventBus } from './src/events/EventBus.js'

const map = L.map('mapa').setView([-33.45, -70.66], 12)

// El motor recalcula la máscara activa de una capa cuando cambia su demanda.
const bus = new EventBus(layerId => {
  if (layerId == null) registry.layerIds().forEach(refresh)
  else refresh(layerId)
})
const refresh = id => registry.setLayerDemandMask(id, bus.demandMaskFor(id))

const registry = new LayerRegistry(map)   // fabrica el HitResolver por defecto

// Registrar una capa interactiva (un marcador).
const marker = L.marker([-33.45, -70.66]).addTo(map)
registry.registerLeafletLayer('flota', marker, { kind: 'point' })

// Suscribir un handler de click sobre esa capa → activa su demanda de click.
const off = bus.on('click', 'flota', (hits) => {
  const top = hits[0]                       // ya viene ordenado top-first
  console.log('clic en', top.layerId, top.ref)
})
refresh('flota')                            // máscara: EVENT_CLICK

// Al recibir un clic del mapa, resolver y despachar.
map.on('click', (ev) => {
  const hits = registry.resolveHits('click', ev)
  bus.dispatch('click', hits, ev.originalEvent)
})

// Baja del handler (idempotente):
off()
```
