# Rótulos — `<cristae-labeled>`

> Pieza de [Cristae](../MODELO.md). Implementa [SPECS §8.9](../SPECS.md) y §19.3.

`<cristae-labeled>` pone un texto sobre cada ítem de la capa que envuelve: debajo de un punto, a lo largo de
una ruta, en el centro de un predio. Es un decorador de la gramática ([SPECS §8.10](../SPECS.md)): no tiene
`bind-to`, Source ni accessors propios, porque todo eso lo da la capa envuelta.

```html
<cristae-labeled placement="along" repeat="240" offset="6">
  <cristae-geodesic>
    <cristae-line-layer id="vuelos" interactive></cristae-line-layer>
  </cristae-geodesic>
</cristae-labeled>
```

```js
document.querySelector('cristae-labeled').textOf = vuelo => vuelo.codigo
```

Sin `textOf`, el texto es el id del ítem. Un `textOf` que devuelve `null` o `''` deja a ese ítem sin rótulo,
así que también sirve de filtro.

## Qué se rotula

El productor más cercano: lo que produce el hijo directo. La geodésica, el overlay y otro
`<cristae-labeled>` no crean ítems propios y se atraviesan; el cluster sí los crea, sus burbujas.

| Árbol | Se rotula |
| --- | --- |
| `labeled > puntos` | los puntos |
| `labeled > geodesic > línea` | las líneas, siguiendo la curva |
| `labeled > overlay > puntos` | los puntos, no los badges |
| `cluster > labeled > puntos` | los puntos; los agrupados pierden el rótulo con su marcador |
| `labeled > cluster > puntos` | las burbujas; los puntos que el cluster deja sueltos, no |
| `labeled > cluster > labeled > puntos` | las burbujas el de afuera y los puntos sueltos el de adentro |
| `labeled > labeled > línea` | la línea, una vez por cada uno |

Envolver sólo un calor, una imagen o un editor que no es de líneas ni de polígonos da R2: un decorador sin
capa que decorar. Un hermano que no se rotula pasa intacto.

Con varias capas hermanas, cada una toma su colocación natural: con `auto`, los camiones llevan el texto
debajo y los predios en su centro.

## Props

| Prop | Atributo | Por defecto | Qué |
| --- | --- | --- | --- |
| `textOf` | — | el id; en una burbuja, su `count` | `(item) => string \| number \| null` |
| `htmlOf` | — | — | `(item) => string \| Node \| null`, el contenido con `renderer="html"`. Si está, el renderer por defecto es `html` |
| `renderer` | `renderer` | `html` si hay `htmlOf`; si no, `canvas` | cómo se dibuja (abajo) |
| `placement` | `placement` | `auto` | `auto`, `along`, `center`, `above`, `below` o `right` |
| `repeat` | `repeat` | sin repetir | px entre centros sobre el trazo, > 0 |
| `offset` | `offset` | `0` | px desde el ancla; positivo hacia arriba para quien lee |
| `orientation` | `orientation` | `auto` | `path` deja el texto siempre del mismo lado del trazo |
| `font` | `font` | la de `<cristae-label-layer>` | fuente CSS |
| `color` | `color` | `#0f172a` | color del texto |
| `halo` | `halo` | `#ffffff` | color del halo de 3 px; `none` lo apaga |
| `paint` | — | — | pintor propio en `canvas`; `paint={drawLabel}` da la píldora de `<cristae-label-layer>` |
| `interactive` | `interactive` | `false` | sólo `html`: el nodo recibe el puntero |
| `visible` | `visible` | `true` | `visible="false"` oculta sin desmontar |

Todas se aplican en vivo, sin remontar la capa. Una prop quitada vuelve a su valor por defecto. Un `textOf`
nuevo en cada render no redibuja si los textos no cambiaron.

## Dónde va el texto

`auto` toma la colocación natural de la capa. Un `placement` explícito que la capa no admite lanza
`TypeError`.

| Capa | `auto` | Admite |
| --- | --- | --- |
| Puntos y HTML | `below` | `center`, `above`, `below`, `right` |
| Burbujas | `below` | `center`, `above`, `below`, `right` |
| Líneas | `along` | `along`, `center` |
| Polígonos | `center` | `along` (el borde de cada anillo), `center` |
| Formas | `center` | `center` |

- Sobre puntos y burbujas, `above`, `below` y `right` dejan el texto a 4 px del borde del ícono, alineado
  hacia afuera. `center` lo pone sobre el ícono. En una burbuja, `auto` lo deja debajo porque el ícono ya
  pinta el conteo; para el texto dentro de la burbuja va `placement="center"`.
- En una línea, `along` sigue el trazo y `center` pone el texto horizontal en la mitad del largo de cada
  parte. En un polígono, `center` es el punto más alejado del borde del anillo exterior más grande, que en
  un polígono en C queda adentro.
- `repeat` y `orientation` sólo valen donde la colocación resuelve a `along`. Con `auto` sobre hermanas de
  distinto tipo se ignoran en las demás; con un `placement` explícito que no es `along` lanzan `TypeError`.
- Sobre el trazo, cada colocación se lee de izquierda a derecha. La que no cabe en su parte, pisaría a la
  anterior o gira más de 45° entre dos letras se omite: nunca se dibuja desbordada.
- Bajo `<cristae-geodesic>`, por dentro o por fuera, el texto sigue la curva dibujada. Con `enabled="false"`
  vuelve a la recta.

## Cómo se dibuja

| | `canvas` | `html` |
| --- | --- | --- |
| Cantidad | miles con `center`; del orden de mil trazos con `along` | cientos |
| Curvado | sí, letra a letra | no: con `along` va en el punto medio, girado según el trazo |
| Fuentes | cualquier fuente CSS; se remide cuando carga | cualquier CSS que llegue al shadow root del mapa |
| Ligaduras, RTL y kerning | bien con `center`; se pierden con `along` | bien siempre |

`renderer="gl"` está pendiente y hoy lanza un `TypeError` que lo dice.

- **`canvas`** usa un solo canvas por mapa para todos los rótulos, en un plano propio: sobre todas las capas
  base y bajo las capas HTML, los editores y el cluster. Los rótulos de burbujas van en un canvas del
  cluster, sobre sus burbujas y bajo la espiral.
- **`paint`** recibe `(ctx, point, label, hovered, style)`, la misma firma de `<cristae-label-layer>`.
  `point` es el ancla del ítem desplazada por `offset`. Sólo vale en `canvas` con `placement` `auto` o
  `center`, y con `paint` `auto` es `center` en todas las capas: el pintor ya pone el rótulo donde quiere
  respecto del punto. Si devuelve su caja `{ x, y, w, h }`, el rótulo se pica; `drawLabel` la devuelve.
- **`html`** pone un nodo por rótulo. `textOf` va por `textContent`, sin interpretar HTML. `htmlOf` acepta un
  string, que va por `innerHTML`, o un `Node`; `null` o `''` dejan al ítem sin rótulo, como en `textOf`. El
  nodo es estable por ítem: `htmlOf` se llama otra vez sólo si el ítem cambió. Una línea con varias partes
  lleva un nodo por parte: el `Node` de `htmlOf` va tal cual en la primera y las demás llevan una copia
  (`cloneNode(true)`), sin sus listeners. Con `textOf`, el halo es una `text-shadow` que imita el trazo de
  `canvas`. Para CSS, el nodo de cada `<cristae-labeled>` lleva la clase `cristae-labels` y cada rótulo,
  `cristae-label`. Esos nodos viven en el shadow root de `<cristae-map>`, adonde no llega el CSS del
  documento: el estilo va en línea o en un `<style>` del propio contenido.
- **El orden de pintado** dentro del canvas compartido es el de alta de los rótulos, no el de su capa. Casi
  siempre coinciden; un `labeled` que se monta tarde sobre una capa vieja pinta sobre los de capas nuevas.

## Click y hover

El rótulo es parte de su ítem: tocarlo es tocar el ítem, con el mismo `layerId`, `kind` e `id`. Un
`<cristae-popup for="rutas">` abre la tarjeta de la ruta al tocar su nombre, y tocar el rótulo de una
burbuja la expande. El hover del rótulo realza el ítem.

- El rótulo se pica sólo si su capa es interactiva. `<cristae-line-layer>` no lo es por defecto: el rótulo de
  una ruta responde al click si la línea lleva `interactive`.
- Un rótulo queda sobre las capas declaradas después: tocar el nombre de un punto dentro de una geocerca
  interactiva abre el punto.
- Con `renderer="html"` e `interactive`, el nodo recibe el puntero: un botón dentro del rótulo responde, y un
  arrastre o un click que nace en él no mueve el mapa ni llega al ítem. Sin `interactive`, el nodo no
  captura el puntero.

## Lo que siguen de su capa

- **Visibilidad.** El rótulo se ve si `visible`, y además su capa está visible y habilitada. Ocultar la capa
  oculta sus rótulos.
- **Cluster.** Un ítem agrupado o fuera del `where` de su capa no lleva rótulo, con el cluster por dentro o
  por fuera.
- **Foco.** Los rótulos se atenúan con su capa. Con `'label'` en los `kinds` del foco se atenúan aunque el
  kind de la capa no esté.
- **Hover.** Con la capa interactiva, el rótulo del ítem bajo el puntero se pinta encima del resto.
- **Baja.** Los rótulos son estado de la capa y mueren con ella.
- **Source.** Si la capa cambia de Source (`attachSource`, o `.source` en `<cristae-point-layer>`), los rótulos
  pasan a la nueva.

## Burbujas

```html
<cristae-labeled placement="below">
  <cristae-cluster><cristae-point-layer id="flota"></cristae-point-layer></cristae-cluster>
</cristae-labeled>
```

```js
labeled.textOf = burbuja => `${burbuja.count} camiones`
```

Por cada burbuja, `textOf` y `htmlOf` reciben `{ count, leaves }`: cuántos ítems junta y los ítems mismos.
`leaves` se resuelve al leerse, así que un `textOf` que sólo usa `count` no paga la búsqueda. Es un objeto
por burbuja y por reagrupamiento: no se guarda.

## React

```tsx
<CristaeLabeled textOf={(r: Ruta) => r.nombre} repeat={240} visible={mostrarNombres}>
  <CristaeLineLayer id="rutas" accessors={rutaAccessors} data={rutas} />
</CristaeLabeled>
```

Para encender y apagar los rótulos va `visible`. Envolver la capa condicionalmente cambia su padre, y React
la desmonta y la vuelve a montar con su curva y su cluster.

## Imperativo

```js
const labels = engine.addLabels({ hostId: 'vuelos', textOf: v => v.codigo, placement: 'along', repeat: 240 })
labels.update({ offset: 6 })   // undefined no cambia; null vuelve al valor por defecto
labels.remove()                // idempotente
```

`addLabels` devuelve `null` si la capa no se rotula: un editor, el calor o la imagen. Un editor envuelto en
`<cristae-labeled>` avisa una vez en consola; su texto va en un elemento junto al editor.

## Validación

Un valor inválido lanza `TypeError` antes de tocar el motor, y en caliente no cambia nada:

- `htmlOf` o `interactive` sin `renderer="html"`, o `paint` sin `canvas`;
- `paint` con un `placement` que no es `auto` ni `center`;
- `repeat` u `orientation` con un `placement` explícito que no es `along`;
- `repeat ≤ 0`, un `offset` no finito, o un `renderer`, `placement` u `orientation` desconocido;
- un `placement` que la capa envuelta no admite, como `along` sobre puntos o `below` sobre una línea.

## Límites

- **Sin colisión.** Los rótulos no se esquivan entre sí: dos `labeled` con el mismo `offset` se pisan.
- **`along` en `canvas`** coloca grafema a grafema: pierde las ligaduras, el kerning entre grafemas y el
  orden RTL.
- **Editores:** no se rotulan en esta versión.
- **Formas con `along`:** no se admiten todavía.

## Desde `<cristae-label-layer>`

`<cristae-label-layer>` se retira en v0.40.0, y su reemplazo es `<cristae-labeled>` sobre la capa de puntos; con
`source` propio, [`<cristae-text-layer>`](text-layer.md). La
equivalencia prop por prop está en [`labels.md`](labels.md#retiro-en-v0400). `<cristae-line-label-layer>` no
llegó a publicarse: su reemplazo es `<cristae-labeled>` sobre la capa de líneas.
