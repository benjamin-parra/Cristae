# Cluster — agrupamiento espacial worldwide

> Pieza de [Cristae](../MODELO.md). Implementa [SPECS §8.3](../SPECS.md) (cluster). Motor
> *headless*: produce datos (qué ids se suprimen + qué burbujas dibujar); el motor conecta esos
> datos a una capa de puntos de burbujas y a la supresión de la capa anfitriona.

`Cluster` agrupa puntos cercanos en **burbujas** usando [`supercluster`](https://github.com/mapbox/supercluster).
No conoce el dominio: opera sobre `{id, lat, lng}` extraídos por accessors. No dibuja nada y no toca
Leaflet — solo calcula.

---

## Por qué "worldwide" (depende solo del zoom)

El cluster del framework de referencia clusterizaba contra el **viewport** (`map.getBounds()`): cada
pan recalculaba, y un punto podía entrar/salir de un cluster solo por desplazar la vista. Eso obliga
a reclusterizar en cada `moveend` y produce parpadeo.

`Cluster` clusteriza siempre contra **bounds del mundo entero** `[-180, -90, 180, 90]`. Consecuencia:

- El resultado depende **solo del zoom**, nunca del viewport → el pan no recalcula nada.
- Cada punto es, de forma determinista, **solo** (visible en su capa, en su posición real) o
  **clustered** (suprimido, reemplazado por una burbuja). No hay estados intermedios.
- `clusteredIds = allIds − soloIds` es **algebraicamente completo**: worldwide garantiza que cada id
  indexado aparece en el resultado, así que la resta no deja huérfanos.

El pan revela puntos y burbujas naturalmente porque el buffer GL es global (todos los solos y todas
las burbujas ya están en el buffer; ver [render.md](./render.md)).

---

## Dos productos

| Producto | Tipo | Estabilidad | Uso |
|---|---|---|---|
| `clusteredIds` | `Set<id>` | **ref estable**, mutado in-place (`clear()`+`add()`) | la capa anfitriona la asigna **una vez**; queda sincronizada en cada recluster sin re-asignar |
| `bubbles` | `Array<{id, lat, lng, count}>` | **array nuevo** por recluster | alimenta un `Source` → rebuild de la capa de burbujas |

La estabilidad de `clusteredIds` es deliberada: un sibling que guarda la referencia (`layer.clusteredIds = cluster.clusteredIds`) ve los cambios sin volver a leer.

---

## API pública

Construcción: `new Cluster({ radius = 80, maxZoom = 18, minPoints = 2 })`.

| Método / prop | Firma | Complejidad | Notas |
|---|---|---|---|
| `clusteredIds` | getter `→ Set` | O(1) | ref estable; ids realmente dentro de un cluster |
| `bubbles` | getter `→ Array` | O(1) | burbujas del último recluster |
| `index(items, idOf, positionOf)` | `(Item[], fn, fn) → void` | O(n) extracción + O(n log n) build | construye features e indexa. Omite posiciones no finitas. Llamar cuando cambian los datos |
| `recluster(zoom)` | `(number) → boolean` | O(1) query + O(results) firma | reagrupa al zoom dado; devuelve `true` solo si el set **cambió** (firma distinta). Llamar en cambio de zoom |
| `radius` / `maxZoom` / `minPoints` | setters | O(n log n) si cambia | **reactivos**: recrean el índice y recargan las features ya extraídas. Idempotentes (mismo valor → no-op) |
| `reset()` | `() → void` | O(1) | limpia todo y recrea el índice vacío |

**La firma evita trabajo redundante:** `recluster` arma una firma `zoom:` + lista de
`c{clusterId}:{count}` / `s{soloId}` y la compara con la anterior; si es idéntica devuelve `false`
sin re-propagar. Datos nuevos (`index`) o reconfig invalidan la firma.

---

## Invariantes

1. **`clusteredIds` nunca se reasigna** — solo `clear()` + `add()`. Quien tenga la referencia queda
   sincronizado.
2. **`recluster` es idempotente por firma**: dos llamadas al mismo zoom sin cambio de datos →
   la segunda devuelve `false` y no muta nada.
3. **Warmup opcional, no obligatorio**: el [Atlas append-only](./atlas.md) hace que pre-fijar el nº
   de iconos de cluster **nunca** sea necesario para la corrección — un bucket no preseed se
   rasteriza on-demand y, si desborda, el regrow lo acomoda sin corromper índices. Aun así, el
   **default** de `defineClusterIconSet` (sin `buckets`) **preseed-ea el ladder fino completo
   (~278 variantes)**: no por necesidad del atlas, sino para que el conteo mostrado sea **fiel**
   (exacto < 100, redondeo a decena/centena arriba) y no haya regrow en runtime. Ver
   [icons.md](./icons.md).
4. **La supresión es un set compartido, no una copia.** `clusteredIds` (ref estable) lo observan
   **dos** renderers del host: la capa de puntos (lo omite del buffer GL) y **toda label ligada al
   host** (no pinta etiquetas flotantes de lo clusterizado). El motor re-filtra las labels en cada
   recluster — sin esto aparecen labels sin su marcador. Ver [labels.md](./labels.md).

---

## Ejemplo de uso

```js
import { Cluster } from './src/cluster/Cluster.js'

const cluster = new Cluster({ radius: 88, maxZoom: 18, minPoints: 2 })

const idOf = v => v.id
const positionOf = v => ({ lat: v.lat, lng: v.lng })

// 1) Datos nuevos → indexar (O(n log n), solo en cambio de datos).
cluster.index(vehiculos, idOf, positionOf)

// 2) En cada zoomend → reclusterizar; rebuild solo si cambió.
map.on('zoomend', () => {
  if (cluster.recluster(map.getZoom())) {
    bubbleSource.set(cluster.bubbles)        // capa de burbujas → rebuild
    fleetLayer.refresh()                     // anfitriona suprime cluster.clusteredIds
  }
})

// 3) La capa anfitriona consulta clusteredIds (ref estable) para omitir los suprimidos.
const oculto = id => cluster.clusteredIds.has(id)

// Reconfig reactiva en runtime (sin recrear la capa).
cluster.radius = 120
```

> La capa de burbujas es una `PointLayer` normal alimentada por `cluster.bubbles`, con un IconSet de
> `defineClusterIconSet({ draw })` (ladder fino por defecto → conteo fiel) y
> `variantOf = item => set.variantForCount(item.count)` (ver [icons.md](./icons.md)). El cableado
> anfitriona↔burbujas↔supresión lo arma el motor, que además re-filtra las labels ligadas al host.
