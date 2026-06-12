# Tabla — `PagedTable` / `<cristae-table>`

> Pieza de [Cristae](../MODELO.md). Consume el contrato [`Source`](./data.md) (solo la cara de
> **lectura**: `getSnapshot` + `subscribe`). Vive en `table/`, **aislada del mapa**: importa solo
> `lit` y el contrato de `data/` — nunca `engine/`, Leaflet ni glify (invariante de capas, MODELO).

Tabla paginada con **scroll virtual**: dibuja decenas de miles de filas manteniendo en el DOM solo
la ventana visible. La misma `Source` (`createSource`/`defineSource`) que alimenta un
`<cristae-point-layer>` alimenta esta tabla → **un dataset filtrado, computado una vez, dos vistas**
(la respuesta a "filtrar dos veces"). Dos piezas:

- **`PagedTable`** — engine headless (sin web component, sin DOM propio salvo el pool de filas).
- **`<cristae-table>`** — piel declarativa Lit en **light DOM** sobre el engine.

Convenciones de complejidad: `n` = ítems del dataset, `k` = filas de una página, `v` = filas
visibles (ventana). `[0-alloc]` = no asigna en estado estable.

---

## Las optimizaciones (no se tocan)

| Mecanismo | Qué evita | Costo |
|---|---|---|
| **Scroll virtual** (pool de DOM + spacers) | tener N filas en el DOM | O(v) nodos, no O(n) |
| **Quickselect Floyd-Rivest** (`QuickSelect.js`) | ordenar el dataset entero por página | O(n) borde de página vs O(n·log n) |
| **Reuse de `workingSet`** | re-alocar el buffer de filtrado por update | [0-alloc] en estable |
| **Batching a rAF** | re-render por cada mutación del mismo tick | ≤1 pipeline por frame |
| **`ResizeObserver`** | recálculo de alto en cada scroll | recomputa solo al cambiar el viewport |
| **Guard de visibilidad** (`IntersectionObserver`) | renderizar una tabla fuera de pantalla | 0 trabajo oculta; 1 corrida al reaparecer |

El quickselect reordena una **copia de referencias** (`workingSet`), nunca el snapshot del Source
(que debe mantener su ref estable). El guard de visibilidad es **nativo del engine** (un flag +
observer), no un plugin que parchea métodos.

---

## Proyección de la fila

La tabla no usa `accessors` (`idOf`/`positionOf` son de mapa). Su análogo domain-free es:

| Config | Tipo | Rol |
|---|---|---|
| `template` | `string` HTML de **una** fila, con atributos `data-ref` | molde clonado al pool |
| `binder` | `(refs, item, rowNumber) => void` | puebla los nodos `data-ref` (sin reconstruir el árbol) |

```js
const template = '<div class="row" style="display:flex;gap:8px"><span data-ref="n"></span><span data-ref="name"></span></div>'
const binder = (refs, item, rowNumber) => {
  refs.n.textContent = rowNumber          // 1-based, índice global en el set filtrado
  refs.name.textContent = item.nombre
}
```

`binder` se llama solo para las filas de la ventana visible y **repuebla** nodos existentes del
pool: cero `createElement` en estado estable.

---

## `<cristae-table>` — web component

**Standalone**: no se monta dentro de `<cristae-map>`. Render en **light DOM** (las filas son markup
del consumidor → su CSS las alcanza; el shadow las encapsularía).

| Miembro | Tipo | Atributo / prop |
|---|---|---|
| `source` | `Source` (vivo, compartible). Gana sobre `data`. | **prop** |
| `data` | `Item[]` (array plano sin reactividad) | **prop** |
| `template` | `string` | **prop** |
| `binder` | `(refs, item, rowNumber) => void` | **prop** |
| `comparator` | `(a, b) => number` (orden del slice) | **prop** |
| `searchBy` | `(item) => any` (campo a buscar) | **prop** |
| `searchFilter` | `(query, item, value) => boolean` (predicado custom; default `includes`) | **prop** |
| `row-height` | number (px, default 28) | atributo |
| `page-size` | number (default 50) | atributo |
| `max-buttons` | number (default 7) | atributo |
| `search` | string (controlado por el consumidor) | atributo / prop |
| `count-label` | string (default `elementos`) | atributo |
| `scroll-height` | string CSS de `max-height` (default `40vh`) | atributo |

Acceso: `el.controls` → el `PagedTable` subyacente (imperativo: `setPage`, `setSearch`, `refresh`,
…), `null` hasta el primer render. Evento `cristae:rowclick` con `detail: { item, row }` (burbujea
y cruza shadow).

Dos entradas de dato **simétricas** con el mapa: `.source` (vivo) o `.data` (plano). El **search es
controlado**: el consumidor cablea su propio input y setea `search`; la tabla no inyecta inputs.
La paginación se dibuja sola (botones con elipsis) desde `paginationModel`.

```html
<input id="q" type="search" placeholder="Buscar…">
<cristae-table id="grid" row-height="36" page-size="100" scroll-height="60vh" count-label="móviles">
</cristae-table>
```
```js
import 'cristae/table'                      // registra <cristae-table> (sin Leaflet)
import { createSource } from 'cristae/table'   // re-exportado del núcleo

const grid = document.getElementById('grid')
grid.template = '<div class="tr"><span data-ref="n"></span><span data-ref="patente"></span></div>'
grid.binder = (refs, item, n) => { refs.n.textContent = n; refs.patente.textContent = item.patente }
grid.searchBy = item => item.patente
grid.comparator = (a, b) => a.patente.localeCompare(b.patente)

const fleet = createSource({ idOf: m => m.id, positionOf: m => m.pos })
grid.source = fleet                          // declarativo; la MISMA source puede ir al mapa
fleet.set(MOVILES)

document.getElementById('q').addEventListener('input', e => { grid.search = e.target.value })
grid.addEventListener('cristae:rowclick', e => abrirDetalle(e.detail.item))
```

### Una source, dos vistas (mapa + tabla)

```js
const fleet = createSource(ACCESSORS); fleet.set(MOVILES)
document.querySelector('cristae-point-layer#fleet').source = fleet
document.querySelector('cristae-table#grid').source = fleet
fleet.addFilter(makeFilter('activos', m => m.activo))   // UNA vez → mapa y tabla se refrescan
```

---

## `PagedTable` — engine headless

Para usar la mecánica sin el web component (otra piel, vanilla, SSR-hidratado). Importa solo de
`data/` (de hecho, duck-typea el `Source`: nada en runtime).

Construcción: `new PagedTable({ container, scrollElement, template, binder, rowHeight?, pageSize?, comparator?, searchBy?, searchFilter?, onSlice?, onPage? })`.

| Método | Propósito | Firma | Complejidad |
|---|---|---|---|
| `attach(source)` | Adjunta un `Source`: snapshot inicial (hard) + re-read por notify (suave). | `(Source) → this` | O(1) + pipeline |
| `setData(items, hard?)` | Ruta A: array plano. `hard` resetea página+scroll. | `(Item[], boolean) → this` | pipeline |
| `setPage(i)` | Va a la página `i`. | `(number) → this` | pipeline |
| `setPageSize(n)` | Cambia el tamaño de página (hard). | `(number) → this` | pipeline |
| `setSearch(text)` | Filtra por `searchBy` (hard). | `(string) → this` | pipeline |
| `getPageInfo()` | `{ page, pageSize, total, pages, offset }`. | `() → object` | O(1) |
| `itemAtRow(rowIndex)` | Ítem de una fila (índice 1-based del DOM, vía slice visible). | `(number) → Item\|null` | O(1) |
| `refresh()` | Reprocesa con el dataset actual. | `() → this` | pipeline |
| `destroy()` | Desuscribe, corta observers y rAF, vacía el DOM. | `() → void` | O(1) |

`pipeline` = `O(n)` (merge+filter) + `O(n)` (quickselect del borde) + `O(k·log k)` (orden del slice)
+ `O(v)` (render de la ventana), coalescido a un rAF y salteado si la tabla está fuera de pantalla.

**Callbacks** (refs estables, no clausuras por tick): `onSlice(slice, meta)` recibe el slice visible
tras cada pipeline; `onPage(pageInfo)` se dispara solo cuando cambia página o total (dirty-skip).

**`attach` vs `setData`:** un notify del `Source` es un refresh **suave** (conserva página y scroll
— un dato vivo no debe patear al usuario a la página 0). El reset duro lo disparan `setSearch` /
`setPageSize` / `setData(items, true)`.

```js
import { PagedTable } from 'cristae/table'

const table = new PagedTable({
  container: document.querySelector('#rows'),
  scrollElement: document.querySelector('#scroll'),
  template: '<div class="tr"><span data-ref="t"></span></div>',
  binder: (refs, item) => { refs.t.textContent = item.nombre },
  pageSize: 200,
  onPage: info => renderPagination(info),
})
table.attach(source)               // o table.setData(items)
```

---

## Garantías

- **Una fuente, varias vistas:** el filtro/estado vive en el `Source` (computado una vez); la tabla
  solo lee. No se filtra dos veces aunque haya dos vistas.
- **Scroll virtual:** el DOM tiene O(v) filas, no O(n).
- **Borde de página O(n):** quickselect, no orden total; se ordena solo el slice de la página.
- **`[0-alloc]` en estable:** reuse de `workingSet`, repoblado del pool (sin `createElement`).
- **Fuera de pantalla = 0 trabajo:** el guard de visibilidad saltea el pipeline y corre una vez al
  reaparecer.
- **Sin singletons mutables de módulo:** todo el estado vive por instancia.
- **Lifecycle limpio:** `destroy()` desuscribe del `Source`, corta `Resize`/`Intersection` observers
  y el rAF pendiente, y vacía el contenedor.
```
