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
| `textOf` | `text-of` | el id; en una burbuja, su `count` | una función `(item) => string \| number \| null` (prop), o por atributo el nombre de un campo |
| `htmlOf` | — | — | `(item) => string \| Node \| null`, el contenido con `renderer="html"`. Si está, el renderer por defecto es `html` |
| `renderer` | `renderer` | `html` si hay `htmlOf`; si no, `canvas` | `canvas`, `html` o `gl`: cómo se dibuja (abajo) |
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

### `text-of`: el texto de un campo, sin función

```html
<cristae-labeled text-of="patente" placement="below">
  <cristae-point-layer id="flota" url="./datos/flota.geojson"></cristae-point-layer>
</cristae-labeled>
```

- **Es un nombre de campo**, con `.` para anidar (`text-of="conductor.nombre"`). Un campo ausente o `null` da `''` y el
  ítem queda sin texto: nunca lanza. Un número se escribe como texto y un objeto da `''`, no `[object Object]`.
- **Precedencia.** Una función en la prop `textOf` (o en `accessors`) gana sobre el atributo `text-of`, y éste sobre
  `fields.text` de la capa; un choque avisa una vez. Por JS, la misma entrada es `addLabels({ hostId, fields: { text: 'patente' } })`; en HTML, la propiedad `fields` de `<cristae-labeled>` (`fields='{"text":"patente"}'`), que con `text-of` pierde y avisa una vez.
- **En vivo.** Cambiar `text-of` se aplica con `update` y redibuja sólo si algún texto cambió.
- **Sin HTML por atributo.** El HTML de un campo no tiene atributo `-of`: va por `htmlOf` o, en un popup, por `<template>`.
- **No aplica a las burbujas** de un cluster: una burbuja no tiene los campos de los ítems, y su texto es el conteo.
  Se avisa una vez por capa y las burbujas conservan su `count`. Para otro texto en la burbuja va una función, que recibe
  `{ count, leaves }`.

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

| | `canvas` | `html` | `gl` |
| --- | --- | --- | --- |
| Cantidad | miles con `center`; del orden de mil trazos con `along` | cientos | miles, con casi nada de CPU por cuadro al mover el mapa |
| Curvado | sí, letra a letra | no: con `along` va en el punto medio, girado según el trazo | sí, letra a letra; se coloca al asentar el mapa y entre medio escala con él |
| Fuentes | cualquier fuente CSS; se remide cuando carga | cualquier CSS que llegue al shadow root del mapa | cualquier fuente CSS; se rasteriza de nuevo cuando carga |
| Ligaduras, RTL y kerning | bien con `center`; se pierden con `along` | bien siempre | ajuste por par en latino, griego y cirílico; árabe, hebreo e índicas como corrida entera; sin ligaduras entre grafemas; con `along`, grafema a grafema como `canvas` |
| Zoom animado | se oculta y vuelve al asentar | sigue al mapa | sigue a su ícono en cada cuadro |

`renderer="gl"` pinta los rótulos en la GPU, en el contexto WebGL de las capas de abajo; sin capa GL debajo abre
uno:

- `paint`, `htmlOf` e `interactive` lanzan `TypeError`, como con `canvas`.
- Sobre el trazo coloca cuando el mapa asienta, con lo que se ve más una pantalla por lado. Mientras se hace
  zoom el texto crece o se achica con el mapa, y al asentar se recoloca; lo que estaba a más de una pantalla
  aparece al asentar.
- Sin WebGL2 pinta con `canvas` y avisa una vez.
- Con 6.400 rótulos de texto a 1920×1080 en una GPU integrada (Intel UHD 730), el zoom da de 55 a 60 cuadros por
  segundo con `gl` y de 25 a 42 con `canvas`; la escala típica da 60 con los dos. Con las píldoras de `paint` en
  la misma escena, que siguen en `canvas`, el zoom con `gl` baja a 34-57.
- Dos cifras quedan fuera de los criterios de la versión y se publican como conocidas. A DPR 1,25 y 1,5 la tinta
  de `gl` da de 1,04 a 1,06 veces la del canvas, contra un tope de 1,04. Sobre el
  trazo, el asiento tras un zoom animado midió hasta 35,1 ms en la Intel UHD 730, contra 33 ms de criterio (dos
  cuadros); en la Arc B580 midió 29,2 ms como máximo.
- El defecto sigue siendo `canvas` y pasará a `gl` con el anfitrión GL: para conservarlo, `renderer="canvas"`.
- Un canvas que pinta más de 1.300 rótulos en un cuadro avisa una vez que `gl` existe.

### Pedir `gl`

Es el mismo valor en las tres maneras, sin opciones nuevas:

```html
<cristae-labeled renderer="gl" placement="below">
  <cristae-point-layer id="flota"></cristae-point-layer>
</cristae-labeled>
```

```tsx
<CristaeLabeled renderer="gl" textOf={(c: Camion) => c.patente}>
  <CristaePointLayer id="flota" data={camiones} accessors={camionAccessors} />
</CristaeLabeled>
```

```js
engine.addLabels({ hostId: 'flota', textOf: c => c.patente, renderer: 'gl' })
engine.addTextLayer({ id: 'comunas', accessors, data: comunas, textOf: c => c.nombre, renderer: 'gl' })
```

Avisos, una vez por página y en consola:

| Cuándo | Qué dice |
| --- | --- |
| `renderer="canvas"` (o el defecto) pinta más de 1.300 rótulos en un cuadro | que `renderer="gl"` los pinta en la GPU |
| `gl` sin WebGL2, o sin poder abrir el contexto | que los rótulos `gl` no pudieron montarse, con la causa, y que se pintan con `canvas` |
| los glifos distintos no caben en el atlas | que los que no caben no se dibujan |

Con `gl`, el orden entre plano de rótulos es: `gl` debajo de `canvas`. Una píldora de `paint` queda sobre el
texto de otro `labeled` que use `gl`.

- **`canvas`** usa un solo canvas por mapa para todos los rótulos, en un plano propio: sobre todas las capas
  base y las burbujas de los clusters, y bajo las capas HTML, los editores y la espiral. Los rótulos de
  burbujas van en un canvas del cluster, sobre sus burbujas y bajo los demás rótulos.
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

Aquí `text-of` no se aplica: `<cristae-labeled text-of="patente">` sobre un cluster deja a cada burbuja con su conteo,
porque la burbuja no es un ítem con campos. Sólo una función (`textOf`) cambia el texto de una burbuja.

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

- `htmlOf` o `interactive` sin `renderer="html"`, o `paint` sin `canvas` (con `gl` lanzan igual);
- `paint` con un `placement` que no es `auto` ni `center`;
- `repeat` u `orientation` con un `placement` explícito que no es `along`;
- `repeat ≤ 0`, un `offset` no finito, o un `renderer`, `placement` u `orientation` desconocido;
- un `placement` que la capa envuelta no admite, como `along` sobre puntos o `below` sobre una línea.

## Límites

- **Sin colisión.** Los rótulos no se esquivan entre sí: dos `labeled` con el mismo `offset` se pisan.
- **`along` en `canvas`** coloca grafema a grafema: pierde las ligaduras, el kerning entre grafemas y el
  orden RTL.
- **`gl` frente a `canvas`:** algún glifo puede quedar hasta medio px corrido, el texto de 9 a 10,5 px con DPR 1
  sale algo más suave y no hay ligaduras. Los glifos que todavía no están en el atlas aparecen unos cuadros
  después; con miles de ideogramas distintos, lo que no cabe en el atlas no se dibuja y avisa una vez.
- **Escrituras complejas con `gl`:** el atlas guarda unos 2.800 glifos distintos de ideogramas; con más, lo que
  no cabe no se dibuja y se avisa una vez. Árabe, hebreo e índicas van como una corrida entera por texto, y
  ocupan más. Una segunda página del atlas no está en esta versión.
- **Emoji con `gl`:** sale en color, como lo rasteriza el navegador; dentro de un texto con árabe o tailandés
  también, porque la corrida se parte en el emoji. Un símbolo que la fuente no trae en color (`❤` sin selector
  de variación) sale como silueta, del color del texto.
- **Vista inclinada y globo:** `gl` es del anfitrión plano; no hay rótulos `gl` inclinados ni sobre el globo.
- **Editores:** no se rotulan en esta versión.
- **Formas con `along`:** no se admiten todavía.

## Desde `<cristae-label-layer>`

`<cristae-label-layer>` se retira en v0.52.0, y su reemplazo es `<cristae-labeled>` sobre la capa de puntos; con
`source` propio, [`<cristae-text-layer>`](text-layer.md). La
equivalencia prop por prop está en [`labels.md`](labels.md#retiro-en-v0520). `<cristae-line-label-layer>` no
llegó a publicarse: su reemplazo es `<cristae-labeled>` sobre la capa de líneas.
