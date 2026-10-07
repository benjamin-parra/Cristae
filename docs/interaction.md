# Interacción — picking, registro de capas y bus de eventos

> Pieza de [Cristae](../MODELO.md). Implementa [SPECS §10](../SPECS.md) (forma del `Hit` y
> orden top-first). Es el pipeline que traduce un evento del puntero en una lista ordenada de
> impactos sobre las capas. Ortogonal al [atlas](./atlas.md) y a la
> [retención de tiles](./tiles.md).

El pipeline tiene tres etapas, cada una en una pieza independiente y genérica (ninguna conoce
el dominio):

```
puntero → resolver de cada capa → LayerRegistry        → EventBus
          (geometría)             (orden + gating)       (ruteo + diffing de hover)
```

Antes, la [puerta del puntero](#la-puerta-del-puntero) decide de quién es cada pulsación: lo que le
queda al mapa entra al pipeline.

1. **El resolver de cada capa** sabe su geometría: dada la muestra del puntero, produce las
   **partes** de hit (`{ ref, distancePx }`) —el pase de picking en GPU para los puntos, la
   geometría en CPU para polígonos, líneas, círculos, formas y marcadores HTML—.
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

## `LayerRegistry` — orden top-first y gating por demanda

Genérico sobre funciones resolver: no conoce capas de puntos ni de polígonos, solo entradas
con un par de resolvers (click/hover), z-index, orden de declaración, visibilidad y máscara de
canales activos. Construcción: `new LayerRegistry()`.

| Método | Firma | Complejidad | Notas |
|---|---|---|---|
| `upsertResolver(entry)` | `({layerId, kind, zIndex, declOrder, resolveClick?, resolveHover?, visible?, capture?, presentAs?}) → void` | O(1) | inserta/reemplaza la entrada de una capa; **preserva** la máscara activa previa si la nueva no la trae |
| `resolveHits(eventType, sample)` | `(string, {lat, lng, x, y}) → Hit[]` | O(n log n) | recolecta hits de capas **visibles**, solo de resolvers cuyo canal tiene demanda, y los devuelve **ordenados top-first** |
| `setLayerVisibility(layerId, visible)` | `(string, bool) → bool` | O(1) | gating por visibilidad; capa oculta no aporta hits |
| `isLayerVisible(layerId)` | `(string) → bool\|null` | O(1) | — |
| `setLayerDemandMask(layerId, mask)` | `(string, number) → bool` | O(1) | fija la máscara de canales activos de la capa (la calcula el motor desde el `EventBus`) |
| `demandMaskOf(layerId)` | `(string) → number` | O(1) | máscara activa actual (0 si no hay) |
| `hasHitForChannels(mask, sample)` | `(number, sample) → bool` | O(n) | ¿hay una feature bajo el puntero en alguna capa visible con demanda de esos canales? Corta al primer acierto; es la consulta del `pointer` del cursor |
| `removeByLayerId(layerId)` | `(string) → void` | O(1) | — |
| `layerIds()` | `() → string[]` | O(n) | — |

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
handler de hover, ningún hover se resuelve** — el resolver de hover de la capa no se invoca.
El picking de hover (que correría en cada `pointer:move`, lo más frecuente) solo se paga cuando
alguien lo escucha. `onDemandChange` dispara el recálculo justo cuando un contador cruza de 0 a
1 o de 1 a 0.

---

## La puerta del puntero

`engine/Interaction.js` es lo único que oye el puntero del contenedor: los eventos crudos del anfitrión
—`pointerdown`/`move`/`up`/`cancel`/`enter`/`leave`, `dblclick` y `contextmenu`—, nunca el click que
reconoce Leaflet. La pulsación y el doble click se oyen en captura, antes que el anfitrión; el resto, en
burbuja.

Un **participante** —el editor de geometría— se suma con `join(participant, zIndex, order)`, que
devuelve su baja, y reconoce sus handles con un resolver síncrono, `handleAt(x, y)`. El `pointerdown`
del botón primario es del primero que reconoce el píxel en el orden de los hits (`zIndex` desc, `order`
asc), salvo que el hit de click de una capa quede por encima: entonces es del mapa. Los hits se
resuelven sólo si algún participante reconoció el píxel.

| La pulsación es | El participante recibe | El mapa |
|---|---|---|
| de un participante | `down`, cada `move` de su puntero y `up`, también por `pointercancel`; el puntero queda capturado | no la ve: el `pointerdown` y el `pointerup` se consumen, y no hay click |
| del mapa | cada `move` como hover, y `click(sample)` si fue un click | la arrastra, o rutea su click |

- **El click lo sintetiza la puerta:** es la pulsación del mapa con el botón primario que se suelta sin
  haber recorrido `CLICK_TOLERANCE` px (|dx| + |dy|, la tolerancia de Leaflet), sin arrastrar el mapa
  y sin un segundo puntero. Sale con su `pointerup` por el canal `click` del bus —o como `map:click` sin
  hits— y después a cada participante. El `click` del DOM no se mira.
- **Un puntero que baja con otro apoyado no abre pulsación:** no toma un handle ni es un click, aunque el
  que se sumó antes ya se haya levantado. La pulsación del mapa en curso se suelta sin click; la de un
  participante sigue con su puntero. La puerta cuenta los apoyados en el contenedor, y el primario
  (`isPrimary`) vuelve la cuenta a uno: un `pointerdown` sintetizado sin `isPrimary` abre pulsación
  mientras cada uno tenga su `pointerup`.
- **El doble click** llega como propio al dueño del píxel, por el mismo orden (`dblclick(sample,
  true)`), y como del mapa a los demás. Si alguno devuelve `true`, la puerta llama a
  `host.input.suppressDoubleClickZoom` y el mapa no hace zoom.
- **Fuera de la superficie** (`host.input.onSurface`), en la UI que el anfitrión pone en el contenedor,
  una pulsación no toma handles ni es un click, y el doble click no llega a nadie.
- **Salir del contenedor** les llega a todos como `leave()`.
- **El píxel** de cada evento sale de la caja del contenedor, cacheada con su escala CSS y su borde; se
  relee al entrar el puntero, en cada pulsación y cuando el mapa cambia de tamaño.

---

## El cursor del contenedor

`engine/Interaction.js` es el **único** que escribe `container.style.cursor`, y sólo cuando el valor
efectivo cambia. Ninguna capa le compite: todas dibujan en su propia superficie o con nodos sin
puntero, así que no hay un hijo que imponga su `pointer`. El `interactive` de un `styleOf` se ignora.
Gana la primera fila que aplica:

| # | Cuando | Cursor |
|---|---|---|
| 1 | el usuario arrastra el mapa (de `dragstart` a que Leaflet lo da por terminado) | `grabbing` |
| 2 | un editor tiene un handle tomado | `grabbing` |
| 3 | hay un handle de un editor bajo el puntero (vértice o midpoint) | `grab` |
| 4 | el consumidor pidió uno: `cursor` de `<cristae-map>`, `engine.setCursor` | ese valor |
| 5 | hay una feature interactiva bajo el puntero | `pointer` |
| 6 | nada | `''` — queda el `grab` de Leaflet |

- **El arrastre es `dragstart`, no `movestart`**: un `flyTo` también mueve el mapa y no pisa el cursor
  del consumidor. Se escribe explícito porque Leaflet lo marca con `leaflet-dragging` en
  `document.body`, y desde el shadow root de `<cristae-map>` la regla `.leaflet-dragging .leaflet-grab`
  no lo alcanza.
- **Termina cuando Leaflet deja de darlo en curso** (`map.dragging.moving()`), no sólo en `dragend`: un
  segundo dedo —el pinch— o un segundo botón lo cortan sin emitirlo. El anfitrión relee el estado en lo
  que siempre les sigue: el `dragend`, el `moveend` del pinch, el `pointerup` del último botón o, si se
  soltó fuera del mapa, el `pointerenter` de la vuelta; nunca por `pointermove`.
- **Vacío, `null` o rechazado por `CSS.supports('cursor', …)` es ninguno**: el estilo ignoraría el valor
  y dejaría puesto el anterior. Sin `CSS` global —un DOM emulado— no hay con qué validar, y se acepta.
- **Reponer el vigente no hace nada**: se compara ya normalizado, así que reaplicarlo en cada movimiento
  del puntero no relanza el picking ni se salta `hover-throttle`.
- **El consumidor gana también sobre las features**, como `.leaflet-crosshair` sobre
  `.leaflet-interactive` en Leaflet. Con su cursor puesto, el picking que sólo decidía el `pointer` no
  corre: lo justifica únicamente la demanda de hover, y sólo en las capas que la tienen. Al quitarlo, el
  `pointer` se resuelve donde quedó el puntero, sin esperar a que se mueva.
- Los popups conservan su `cursor: auto`: la regla va en su pane. El zoom y la atribución del elemento
  viven fuera del contenedor, y el cursor de éste no los alcanza.
- El editor informa su nivel —ninguno, bajo el puntero, tomado— y el nombre del cursor lo pone el
  árbitro. Con varios editores manda el más fuerte.

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

1. **Top-first determinista:** `resolveHits` siempre ordena `zIndex` desc, `order` asc,
   `distancePx` asc; sin `distancePx` → al fondo.
2. **Gating doble en el registro:** capa invisible o sin la máscara del canal → no se pickea.
3. **Sin picking de canal sin demanda:** el conteo del bus garantiza que un canal sin handlers
   tenga máscara 0 y por tanto no se evalúe.
4. **Una pulsación, un dueño:** la de un participante no llega al mapa ni es un click; la del mapa no
   llega a ningún participante más que como hover y click.
5. **Hover consistente al desaparecer una capa:** `clearLayer` fuerza `hover:end` para que el
   estado externo no sobreviva a la capa que lo originó.

---

## Ejemplo de uso

```js
import { LayerRegistry } from './src/interaction/LayerRegistry.js'
import { EventBus } from './src/events/EventBus.js'

const registry = new LayerRegistry()

// El motor recalcula la máscara activa de una capa cuando cambia su demanda.
const bus = new EventBus(layerId => {
  if (layerId == null) registry.layerIds().forEach(refresh)
  else refresh(layerId)
})
const refresh = id => registry.setLayerDemandMask(id, bus.demandMaskFor(id))

// Una capa interactiva aporta su resolver: acá, un punto en el píxel (400, 300) que se toca a 10 px
// o menos.
const flota = { id: 7 }
const tocar = ({ x, y }) => {
  const distancePx = Math.hypot(x - 400, y - 300)
  return distancePx <= 10 ? [{ ref: flota, id: flota.id, distancePx }] : []
}
registry.upsertResolver({ layerId: 'flota', kind: 'point', zIndex: 400, declOrder: 0, resolveClick: tocar, resolveHover: tocar })

// Suscribir un handler de click sobre esa capa → activa su demanda de click.
const off = bus.on('click', 'flota', (hits) => {
  const top = hits[0]                       // ya viene ordenado top-first
  console.log('clic en', top.layerId, top.ref)
})
refresh('flota')                            // máscara: EVENT_CLICK

// El motor resuelve cada clic con su muestra —la `PointerSample` de SPECS §10, que arma con la
// cámara— y lo despacha con el evento del DOM:
const onClick = (sample, originalEvent) => bus.dispatch('click', registry.resolveHits('click', sample), originalEvent)

// Baja del handler (idempotente):
off()
```
