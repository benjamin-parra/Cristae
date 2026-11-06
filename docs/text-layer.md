# Texto suelto — `<cristae-text-layer>`

> Pieza de [Cristae](../MODELO.md). Capa base de la gramática ([SPECS §8.10](../SPECS.md)): `{ role: 'leaf', produces: ['text'] }`.

`<cristae-text-layer>` pone texto en el mapa a partir de sus propios datos: nombres de ciudades, cotas,
leyendas que no rotulan a otra capa. Para rotular los ítems de una capa va [`<cristae-labeled>`](labeled.md);
esta capa usa su mismo vocabulario y sus mismos renderers, pero con `source` y `accessors` propios.

```html
<cristae-text-layer id="ciudades" placement="above" interactive></cristae-text-layer>
```

```js
const capa = document.querySelector('cristae-text-layer')
capa.accessors = { idOf: c => c.id, positionOf: c => ({ lat: c.lat, lng: c.lng }) }
capa.textOf    = c => c.nombre
capa.data      = ciudades
```

Con `canvas` o `html` no gasta contexto WebGL: el texto va al canvas de rótulos que comparte el mapa, o a un
pane HTML propio.

## Datos

| Prop | Qué |
| --- | --- |
| `data` | los ítems; la capa crea su Source |
| `source` | una Source del consumidor, que gana sobre `data`. Cambiarla en vivo pasa los textos a la nueva |
| `accessors` | `{ idOf, positionOf, hashOf? }`. Sin `positionOf`, el alta lanza `TypeError` |

Sin `textOf` ni `htmlOf`, el texto es el id. Un `textOf` que devuelve `null` o `''` deja al ítem sin texto.

## Props

Las de los rótulos tienen el significado de [`<cristae-labeled>`](labeled.md#props) y se aplican en vivo; una
prop quitada vuelve a su valor por defecto.

| Prop | Atributo | Por defecto | Qué |
| --- | --- | --- | --- |
| `textOf` | — | el id | `(item) => string \| number \| null` |
| `htmlOf` | — | — | `(item) => string \| Node \| null`; si está, el renderer por defecto es `html` |
| `renderer` | `renderer` | `html` si hay `htmlOf`; si no, `canvas` | `canvas` o `html`; `gl` lanza `TypeError`, como en `labeled` |
| `placement` | `placement` | `center` | `center`, `above`, `below` o `right` respecto del punto |
| `offset` | `offset` | `0` | px desde el ancla; positivo hacia arriba |
| `font` | `font` | la de los rótulos | fuente CSS |
| `color` | `color` | `#0f172a` | color del texto |
| `halo` | `halo` | `#ffffff` | color del halo; `none` lo apaga |
| `paint` | — | — | pintor propio en `canvas`, con `placement` `auto` o `center` |
| `interactive` | `interactive` | `false` | la capa se pica: click y hover. Se lee al montar |
| `visible` | `visible` | `true` | `visible="false"` oculta sin desmontar |

- `auto` es `center`: el texto suelto no tiene ícono y va sobre su punto. `above`, `below` y `right` lo
  separan 4 px.
- `along`, `repeat` y `orientation` no aplican: no hay trazo. `along` lanza `TypeError`.
- `interactive` es el de una capa base, no el de `<cristae-labeled renderer="html">`: el texto se pica como
  ítem de esta capa (`layerId` de la capa, `kind: 'text'`) y el nodo HTML no captura el puntero. Para un
  botón dentro del marcador va [`<cristae-html-layer>`](elements.md).
- `pane` y `z` no aplican: con `canvas`, el texto va en el plano de los rótulos, sobre las capas base y bajo
  las capas HTML, los editores y el cluster; con `html`, en un pane propio justo encima.

## Lo que comparte con las capas base

- **Foco.** Se atenúa con `focus()` si su kind, `'text'`, o `'label'` está en los `kinds`, y por ítem con
  `focus-ids`.
- **Picking.** Con `interactive`, un click o un hover sobre el texto entrega el ítem, en el z del plano de
  rótulos.
- **Baja.** `removeLayer` suelta el canvas compartido con el último rótulo que lo usa.

## React

```tsx
<CristaeTextLayer id="ciudades" data={ciudades} accessors={ciudadAccessors} textOf={c => c.nombre}
  placement="above" interactive onClick={abrir} />
```

## Imperativo

```js
const capa = engine.addTextLayer({ id: 'ciudades', accessors, data, textOf: c => c.nombre, placement: 'above' })
capa.set(otras)                   // reemplaza los ítems de la Source propia
capa.update({ color: '#b91c1c' }) // undefined no cambia; null vuelve al valor por defecto
capa.setVisible(false)
engine.attachSource('ciudades', source)
engine.removeLayer('ciudades')
```

Un valor inválido lanza `TypeError` antes de registrar la capa, y en `update` no cambia nada.

## Desde `<cristae-label-layer>`

Una `<cristae-label-layer>` con `source` propio pasa a `<cristae-text-layer>` con la misma Source; su
`textOf` va tal cual. La píldora de antes se pide con `paint={drawLabel}`. La equivalencia completa está en
[`labels.md`](labels.md#retiro-en-v0470).

## Límites

- **Sin colisión.** Los textos no se esquivan entre sí.
- **`html`** rinde cientos de textos; `canvas`, miles. Sus nodos viven en el shadow root del mapa: el CSS del
  documento no les llega, y el estilo va en línea ([`labeled.md`](labeled.md#cómo-se-dibuja)).
