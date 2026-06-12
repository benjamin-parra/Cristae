# Atlas — valor CPU del atlas de iconos

> Pieza de [Cristae](../MODELO.md). Implementa [SPECS §4.1](../SPECS.md). Es la mitad CPU
> del atlas evolutivo; la mitad GPU (`GpuAtlasBinding`, SPECS §4.2) es un espejo por contexto
> que consume este valor y no se documenta acá.

El `Atlas` es un **valor puro de CPU**: cero WebGL, cero DOM (solo recibe un bitmap/canvas ya
rasterizado por el `IconSet` y lo guarda). Resuelve un único problema: dar a cada variante de
icono un **índice entero estable** y una **celda fija** en una grilla, de forma que crecer el
conjunto de iconos **no corrompa** los marcadores ya dibujados ni obligue a recompilar el shader.

---

## Por qué append-only + capacidad fija + generación

El atlas de referencia (`IconBuilder`) mezclaba tres responsabilidades en un objeto con flags
mutables compartidos, y tenía dos bugs de raíz (MODELO §7.1):

1. **Corrupción de marcadores existentes al crecer.** Codificaba el tile como
   `r = idx / (tiles.length - 1)`: el **denominador cambiaba con cada alta**. Como el shader
   horneaba el `n` viejo, al entrar una variante nueva *todos* los marcadores ya emitidos se
   decodificaban contra un denominador distinto → icono equivocado o desaparecido.

2. **2º-mapa-en-blanco.** Un booleano `#dirty` *consume-once*: el primer contexto GL que leía el
   atlas lo apagaba; un segundo mapa creía "ya subí" y quedaba en blanco.

El `Atlas` elimina ambos **por construcción**, no con `if`-checks:

- **Capacidad fija `C` por generación.** La grilla se dimensiona a una capacidad con headroom
  (elegida por el caller), no a `ceil(√count)` que reescala en cada alta. `tileChannel(index)`
  normaliza por `C` **constante** → el color de un punto ya emitido **no cambia de significado**
  mientras viva la generación. Inmune al `append`.

- **Append-only, la celda nunca se mueve.** `append` asigna la siguiente celda libre y la fija.
  No hay repack dentro de la generación.

- **Sin flag mutable.** No existe `#dirty`. La señal de "hay algo nuevo" es **intrínseca**:
  el binding compara su cursor `uploaded < count`. La señal de regrow es la **identidad** del
  objeto (`binding.atlas !== atlas`). Nada que limpiar, ningún orden a respetar, multi-mapa gratis.

- **Regrow = objeto nuevo, no mutación.** Al desbordar `C` no se muta: se produce un `Atlas`
  nuevo con `generation+1`. Es el **único** repack.

---

## API pública

Construcción: `new Atlas(capacity, tileSize)`. Internamente
`cols = ceil(√C)`, `rows = ceil(C / cols)`.

Propiedades de solo lectura: `generation`, `capacity` (C), `count` (ocupadas ≤ C),
`cols`, `rows`, `tileSize`.

| Método | Firma | Complejidad | Notas |
|---|---|---|---|
| `indexOf(variant)` | `(string) → number` | O(1) | índice estable de la variante, o `-1` si ausente |
| `append(variant, bitmap)` | `(string, bitmap) → number` | O(1) amort. | asigna la siguiente celda (índice = `count++`), registra variante+bitmap, devuelve el índice. Si está lleno (`count === capacity`) devuelve `-1` y **no muta** (el caller hace regrow) |
| `cellOf(index)` | `(number) → {col,row}` | O(1) **[0-alloc]** | escribe `col = index % cols`, `row = (index/cols)|0` en el scratch compartido `this.cell` y lo retorna (muta-y-retorna). El binding ubica `texSubImage2D` en `(col*tileSize, row*tileSize)` |
| `tileAt(index)` | `(number) → bitmap` | O(1) | el bitmap/canvas registrado para ese índice |
| `tileChannel(index)` | `(number) → number` | O(1) **[0-alloc]** | canal `r` del color de tile = `index / max(C-1, 1)`, normalizado por **capacidad fija**. **Solo el canal de tile** — el shader recupera `floor(r*(C-1)+0.5)` |
| `Atlas.grow(previous)` | `(Atlas) → Atlas` | O(C) | factory estática: nuevo Atlas (`generation+1`, capacidad doble) que **preserva todo mapeo variante→índice y bitmap**; los índices existentes siguen válidos |

**Notas [0-alloc]:** `cellOf` y `tileChannel` están en el hot-path del render
(se llaman por celda en cada `sync`, y `tileChannel` por punto en cada recolor). No deben
asignar. `cellOf` usa un objeto scratch reusado (`this.cell`) que se muta y se retorna —
nunca un objeto de coordenadas nuevo por llamada; las divisiones/módulos son enteros inline.
`tileChannel` devuelve un primitivo.

**Lo que el Atlas NO compone:** el ángulo (`g`, derivado de `headingOf`) y el id de picking
(`b`,`a`, derivado del slot del punto) los arma el slot-writer de la **capa** (SPECS §13),
no el atlas. El atlas solo aporta el canal de tile (`r`).

---

## Invariantes

1. **La celda de un índice es estable** durante toda la vida de la generación: `append` nunca
   mueve celdas.
2. **El significado de `tileChannel` es estable** dentro de la generación: el denominador es `C`
   (fijo), no `count` (variable).
3. **No hay `#dirty`**: el `append` solo incrementa `count`; el cursor del binding (`uploaded < count`)
   es la única señal de pendiente.

---

## La historia del regrow

Cuando `append` devuelve `-1` (capacidad agotada), el caller llama `Atlas.grow(previous)`:

- Se crea un **objeto nuevo** con el doble de capacidad y `generation+1`.
- Cada variante conserva **el mismo índice** (el re-append es en orden, índice `i` → celda `i`),
  así ningún marcador existente cambia de icono.
- El caller cambia su referencia al nuevo Atlas.
- Cada `GpuAtlasBinding` detecta el cambio **por identidad de objeto** (`!==`) y re-sube la textura
  completa en su próximo `sync`.
- La **capa re-encoda el buffer de puntos** porque `C` cambió → el denominador `C-1` de
  `tileChannel` es otro (SPECS §15.2). El regrow es un rebuild, no solo re-subir la textura.

Esto ocurre rara vez si el `IconSet` declara su espacio `variants` (preseed con headroom → cero
regrow en runtime). Es la red de seguridad para variantes no declaradas que desbordan `C`.

---

## Ejemplo de uso

```js
import Atlas from './src/atlas/Atlas.js'

// Capacidad con headroom elegida por el caller (p. ej. variantes declaradas × 2).
let atlas = new Atlas(64, 128)

// Alta de variantes (el IconSet rasteriza; el Atlas solo guarda + direcciona).
let idx = atlas.indexOf('activo')
if (idx === -1) {
  idx = atlas.append('activo', rasterizar('activo'))
  if (idx === -1) {           // capacidad agotada → regrow
    atlas = Atlas.grow(atlas)  // objeto nuevo, índices preservados, generation+1
    idx = atlas.append('activo', rasterizar('activo'))
  }
}

// En el hot-path del render: dónde va el tile y qué canal r emitir.
const { col, row } = atlas.cellOf(idx)        // [0-alloc] — scratch reusado
const r = atlas.tileChannel(idx)              // [0-alloc] — primitivo, normalizado por C fijo
// El binding GPU sube tileAt(idx) a (col*tileSize, row*tileSize);
// la capa compone el color [r, angleNorm, idHi, idLo] por punto.
```
