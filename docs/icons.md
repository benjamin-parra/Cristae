# Iconos — rasterización de variantes al atlas

> Pieza de [Cristae](../MODELO.md). Implementa [SPECS §4.1](../SPECS.md). Es el productor de
> bitmaps que alimenta el [`Atlas`](./atlas.md): rasteriza cada **variante** a un canvas y la
> administra dentro del atlas. La residencia GPU (`GpuAtlasBinding`, SPECS §4.2) es del binding
> y no se documenta acá, igual que [atlas.md](./atlas.md) la delega.

El `IconSet` une dos mundos: una descripción **declarativa** (variante → descriptor) y un set
**imperativo** de dibujantes (forma → canvas). Su trabajo es responder, para cualquier
variante, **qué índice** ocupa en el atlas — rasterizándola la primera vez que se la pide y
sembrándola por adelantado cuando se la declara. No conoce el dominio: la `variant` es una
string opaca que **arma el consumidor** (estado de flota, severidad, lo que sea); el core no la
interpreta.

---

## Por qué declarativo + imperativo + preseed

- **Separar el "qué" del "cómo".** `describe(variant) → { shape, …props }` decide qué forma y
  con qué parámetros dibujar; `renderers[shape](ctx, size, descriptor)` solo sabe pintar esa
  forma. Agregar una variante nueva no toca a los dibujantes; agregar un estilo nuevo es un
  renderer más. El dominio vive en `describe` (del consumidor), no en el motor.

> **Contrato: `describe` debe ser _total_.** Para **cualquier** string que pueda llegar por
> `variantOf` —incluidas las que aparezcan recién en runtime y disparen un regrow— `describe`
> debe devolver un descriptor **completo**: `shape` ∈ `renderers` y **todas** las props que su
> renderer lea ya resueltas (color, badge, etc.). El core trata la variante como string opaca y
> **no valida ni rellena defaults**. Una prop faltante **no lanza**: degrada en silencio al
> default del canvas (p. ej. `ctx.fillStyle = undefined` deja el `#000000` por defecto → relleno
> negro), lo que se ve como "ícono correcto pero mal pintado", nunca como excepción.
>
> **Anti-patrón** que produce justo eso: derivar una prop con `LISTA.indexOf(variant)` sobre una
> lista **cerrada precalculada** — para una variante nueva `indexOf` da `-1`, el `-1 % n` de JS
> conserva el signo y `COLORS[-1]` es `undefined`. Derivar la prop **de la variante misma**
> (hash de la string, parseo) para que sea total por construcción:
>
> ```js
> // ❌ parcial: falla para toda variante fuera de TIPOS → color undefined → negro
> const colorOf = (v) => COLORS[TIPOS.indexOf(v) % COLORS.length]
>
> // ✅ total: hash de la string → siempre un color válido, para cualquier variante
> const colorOf = (v) => {
>   let h = 0
>   for (let i = 0; i < v.length; i++) h = (h * 31 + v.charCodeAt(i)) | 0
>   return COLORS[Math.abs(h) % COLORS.length]
> }
> ```

- **Preseed con headroom = cero regrow en runtime.** El regrow del atlas no corrompe nada (los
  índices se preservan, ver [atlas.md](./atlas.md)), pero igual cuesta O(C) y obliga a re-subir
  la textura y re-encodar la capa. Si el consumidor **declara** sus `variants`, el constructor
  dimensiona el atlas con headroom (`HEADROOM = 1.5`, mínimo `MIN_CAPACITY = 16`) y las siembra
  todas en `#init`. Resultado: **cero `append` en runtime** para lo declarado → cero regrow.

- **Red de seguridad para lo no declarado.** Si llega una variante que **no** se declaró,
  `resolve` la rasteriza y appendea igual; solo si desborda la capacidad dispara el regrow. La
  variante nunca queda invisible.

### Variante compuesta — varios atributos en una string

`variantOf` devuelve **una** string, pero se pueden codificar varios ejes (forma + color, tipo + estado)
concatenándolos, y `describe` los **parsea de vuelta**. Sigue siendo total (todo deriva de la string, sin
listas cerradas) y se cachea **un tile por combinación realmente usada**:

```js
variantOf: m => `${m.tipo}|${m.estado}`,           // "camion|activo", "grua|alerta", …
describe: (v) => {
  const [tipo, estado] = v.split('|')
  return { shape: tipo, color: estado === 'alerta' ? '#e11' : '#1a8' }   // forma por tipo, color por estado
},
renderers: { camion: dibujarCamion, grua: dibujarGrua },
```

Preseed solo las combinaciones que existen (`variants: ['camion|activo', …]`); una combinación nueva se
rasteriza on-demand igual, nunca queda invisible. Conviene usar esto en vez de varios IconSets cuando un mismo punto
varía en más de un eje a la vez.

---

## `IconSet`

Construcción vía la factory `defineIconSet(cfg)` (= `new IconSet(cfg)`):

```js
defineIconSet({
  rotates,        // bool — ¿los iconos rotan según heading? (default false)
  variants,       // string[] — variantes a presembrar (dimensiona el atlas)
  sizes,          // { default?: 32, canvas?: 128 } — tamaño lógico y de la celda raster
  describe,       // (variant) => ({ shape, ...props })  — DECLARATIVO
  renderers,      // { [shape]: (ctx, size, descriptor) => void }  — IMPERATIVO
  prerender,      // async () => void  — precarga assets antes de sembrar (fuentes, imágenes)
})
```

| Método / prop | Firma | Complejidad | Notas |
|---|---|---|---|
| `resolve(variant)` | `(string) → number` | O(1) (hit) / O(raster) (miss) | índice de la variante: `indexOf` → si falta, rasteriza + `append`; si el atlas está lleno, `Atlas.grow` + reintenta (red de seguridad, nunca invisible) |
| `seed(variants)` | `(string[]) → void` | O(m·raster) | preseed idempotente: `resolve` cada una. `resolve` ya es idempotente, así que llamarlo de nuevo no duplica |
| `atlas` (getter) | `→ Atlas` | O(1) | el atlas vivo. Su **identidad cambia** en regrow → el binding re-sube y la capa re-encoda |
| `ready` (prop) | `→ Promise<IconSet>` | — | resuelve cuando terminó `prerender` + preseed; esperarla antes del primer render |
| `rotates` (prop) | `→ bool` | — | si las variantes rotan según `headingOf` |
| `defaultSize` (prop) | `→ number` | — | tamaño lógico por defecto (`sizes.default ?? 32`) |

Notas:
- El canvas de raster es cuadrado de `sizes.canvas` (default 128) — es el `tileSize` del atlas.
- `#rasterize` lanza si `describe` devuelve un `shape` sin renderer registrado
  (`[IconSet] sin renderer para shape '…'`). Es un error de configuración, no de runtime.
- `resolve` es el punto de entrada del hot-path de la capa (la capa pide el índice por punto);
  en estado estable es siempre un hit O(1) sobre el `indexOf` del atlas.

### Flujo de `resolve`

```
indexOf(variant) ──hit──► devuelve índice (O(1))
        │ miss
        ▼
  rasterize(variant)  ──►  describe → renderer[shape] → canvas
        │
        ▼
  atlas.append(variant, canvas)
        │ -1 (lleno)
        ▼
  atlas = Atlas.grow(atlas)  ──►  append de nuevo  (red de seguridad)
```

### `prerender` — precarga async

Si la config trae `prerender`, `#init` lo **espera** antes del preseed. Sirve para cargar
recursos que el raster necesita (web fonts, imágenes base) de modo que el primer dibujo ya los
tenga. El consumidor espera `iconSet.ready` para saber que todo está sembrado.

**Patrón fuente web → glifo.** Para rasterizar glifos de una fuente de iconos (Unicons, Material) hay
que **esperar la fuente** antes de dibujar al canvas; si no, el primer raster sale en blanco/tofu. Eso es
lo que resuelve `prerender`:

```js
defineIconSet({
  variants: ['activo', 'alerta'],
  sizes: { default: 20, canvas: 64 },
  prerender: async () => {
    await document.fonts.load('16px "unicons-line"')   // fuerza la carga de la fuente…
    await document.fonts.ready                         // …y espera a que esté lista
  },
  describe: v => ({ shape: 'glyph', char: String.fromCharCode(v === 'alerta' ? 0xe91d : 0xe88a), color: v === 'alerta' ? '#e11' : '#1a8' }),
  renderers: {
    glyph: (ctx, s, d) => {
      ctx.font = `${s * 0.7}px "unicons-line"`; ctx.fillStyle = d.color
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(d.char, s / 2, s / 2)
    },
  },
})
```

Ese `prerender` manual tiene un atajo: **`prerenderFonts(...familias)`** devuelve exactamente esa función
de espera, lista para componer:

```js
import { defineIconSet, prerenderFonts } from 'cristae/map'
defineIconSet({ /* … */, prerender: prerenderFonts('unicons-line') })
```

Los codepoints de las fuentes de iconos suelen vivir en el área de uso privado (PUA): se pasan como
`String.fromCharCode(0xe91d)` (o el escape Unicode equivalente), nunca como carácter literal — un glifo
literal en el fuente es invisible y frágil.

---

## `defineClusterIconSet` — iconos de cluster por bucket de conteo

Un `IconSet` especializado donde la variante es un **bucket de conteo** (string del número). Un
cluster es agregación de conteo, no dominio: por eso vive en el core, **sin** suponer una escala.

```js
defineClusterIconSet({
  buckets,   // number[] — thresholds ascendentes. El consumidor fija la escala de SU dominio.
  draw,      // (ctx, size, count, plus, dim, marked) => void — pinta la burbuja; `plus` ⇒ marcar "+"
  sizes,     // { default?, canvas? }
})
```

**Flags de estado del `draw`.** Además de `count`/`plus`, el draw recibe dos booleans opcionales
(ignorarlos es válido): `dim` = burbuja **expandida** en spiderfy (convención: semitransparente) y
`marked` = burbuja que contiene **ids marcados** por el consumidor (convención: resaltada). Viajan
como prefijo de la variante (`'d'`/`'m'` + bucket) con round-trip en el `describe` interno; el sink de
burbujas usa `expandedVariant`/`markedVariant` **sólo si existen** — un icon-set custom sin ellos no
atenúa ni resalta, pero no rompe.

**Por qué buckets y no el conteo exacto.** Cada burbuja distinta es una variante = un tile del atlas.
Un tile por conteo posible explotaría el atlas. Los buckets acotan las variantes. **No importa cuántos
buckets** (el atlas es de texturas chicas, memoria trivial) → pueden ser finos; lo que importa es que
el número mostrado sea **honesto**.

**Los buckets son _thresholds_, no un rango de conteos.** El bucket más alto es un **"+"**: absorbe
todo conteo mayor. Así la estructura interna (una LUT, ver abajo) queda acotada por el **threshold
tope**, no por el conteo máximo posible — pasar `buckets: [..., 1000]` cubre un cluster de 50 000 sin
una tabla de 50 000 entradas.

**`plus` lo deriva el core de la topología de buckets, no de un umbral horneado.** Un bucket `V` es
"piso de un rango" (⇒ `plus = true`) cuando `V+1` **no** es bucket: entonces `V` representa `[V, …)` y
mostrarlo como `V+` es honesto. Si `V+1` sí es bucket, `V` es exacto (`plus = false`). El `draw` recibe
ese flag y decide el texto; el default del motor hace `plus ? count+'+' : ''+count`.

```js
// Ejemplo de dominio: exactos 1–10, luego thresholds. El "+" sale solo de la lista.
defineClusterIconSet({ buckets: [1,2,3,4,5,6,8,9,10,100,200,500,1000], draw })
//   count 8 → "8"   ·  10 → "10+"  ·  150 → "100+"  ·  500 → "500+"  ·  5000 → "1000+"
```

**Default (sin `buckets`):** ladder realista — exacto `< 100`, decena `100–999`, centena `1000–2000`,
tope `2000+`. Se puede cambiar si el dominio tiene otra escala.

| Conteo | Default muestra |
|---|---|
| 37 | `37` (exacto) |
| 523 | `520+` |
| 1 750 | `1700+` |
| 9 999 | `2000+` |

**Rendimiento — `variantForCount` es hot-loop.** Corre por ítem en cada rebuild y el host puede emitir
**miles de updates/seg**. Por eso NO hace búsqueda ni crea strings: en construcción se precomputan
**una vez** los strings de cada bucket (cacheados) y una **LUT `Uint16Array`** (conteo → índice de
bucket, piso). En runtime es una sola indexación — O(1), cero alloc, cero GC.

`describe: v => ({ shape:'cluster', count, plus, dim, marked })` y un único renderer `cluster` que
delega en el `draw` provisto. Devuelve el `IconSet` con métodos extra:

| Método | Firma | Complejidad | Notas |
|---|---|---|---|
| `variantForCount(count)` | `(number) → string` | **O(1), 0 alloc** | conteo real → variante (string del bucket) vía LUT + string cacheado. Lo usa la cluster-layer como `variantOf` |
| `expandedVariant(count)` | `(number) → string` | O(1) | variante atenuada (`'d'` + bucket) de la burbuja expandida en spiderfy |
| `markedVariant(count)` | `(number) → string` | O(1) | variante resaltada (`'m'` + bucket) de la burbuja que contiene ids marcados |

---

## Invariantes

1. **Sin dominio.** El `IconSet` no interpreta la variante; `describe` (del consumidor) decide
   forma y parámetros. La misma variante string siempre rasteriza el mismo bitmap.
2. **`resolve` idempotente.** Pedir dos veces la misma variante devuelve el **mismo índice**;
   no rasteriza ni appendea de nuevo (la segunda es un `indexOf` hit).
3. **Nunca invisible.** Una variante no declarada se rasteriza y appendea bajo demanda; si
   desborda, `Atlas.grow` la acomoda. No hay camino que deje un punto sin icono.
4. **Preseed = cero regrow.** Si todas las variantes usadas están en `variants`, el atlas se
   dimensiona con headroom y no hay `append` ni regrow en runtime.
5. **`describe` total.** Responsabilidad del consumidor: devuelve un descriptor válido para
   cualquier variante posible (props derivadas de la variante misma, no de una lista cerrada). El
   core no valida; una prop faltante degrada en silencio al default del canvas, no a una
   excepción. Ver el callout del contrato arriba.

---

## Ejemplo de uso

```js
import { defineIconSet, defineClusterIconSet } from './src/atlas/IconSet.js'

// IconSet de flota: variante = estado, declarativo (describe) + imperativo (renderers).
const flota = defineIconSet({
  rotates: true,
  variants: ['activo', 'detenido', 'alerta'],   // preseed → cero regrow en runtime
  sizes: { default: 32, canvas: 128 },
  describe: (variant) => ({
    shape: 'pin',
    color: variant === 'alerta' ? '#e11' : variant === 'detenido' ? '#888' : '#1a8',
  }),
  renderers: {
    pin: (ctx, size, d) => {
      ctx.fillStyle = d.color
      ctx.beginPath()
      ctx.arc(size / 2, size / 2, size * 0.35, 0, Math.PI * 2)
      ctx.fill()
    },
  },
})

await flota.ready                  // prerender + preseed listos
const idx = flota.resolve('activo')   // índice estable en el atlas (O(1))

// Cluster icon set: variante = bucket de conteo.
const clusters = defineClusterIconSet({
  buckets: [1, 10, 50, 200],
  sizes: { canvas: 128 },
  draw: (ctx, size, count) => {
    ctx.fillStyle = count >= 50 ? '#c33' : '#39c'
    ctx.beginPath()
    ctx.arc(size / 2, size / 2, size * 0.4, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#fff'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.font = `${size * 0.25}px sans-serif`
    ctx.fillText(String(count), size / 2, size / 2)
  },
})

// La cluster-layer usa variantForCount como su variantOf:
const variant = clusters.variantForCount(37)   // '10'
const cidx = clusters.resolve(variant)
```
