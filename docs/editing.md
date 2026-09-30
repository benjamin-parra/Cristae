# Edición de geometría — `addEditableLayer`, `<cristae-editable-*>`

> Pieza de [Cristae](../MODELO.md). No es una capa de dato: no consume un [Source](./data.md) ni tiene
> accessors. Su dato es UNA geometría y su contrato es el de un input controlado. Dibuja relleno, trazo
> y handles en una superficie WebGL2 propia (`render/EditSurface.js`), con el arena repartido en chunks
> (`geometry/ChunkedPath.js`) y su espejo en textura (`render/EditArena.js`).

Todas las demás capas responden a la pregunta *«¿cómo se ve este conjunto de ítems?»*. Ésta responde
otra: *«¿qué figura está dibujando el usuario ahora?»*. Por eso no tiene `data`, `source`, `idOf` ni
`styleOf`: no hay entidades que describir, hay una geometría que se está editando.

---

## Input controlado

`value` entra, los cambios salen. El editor **no es la fuente de la verdad**: el estado vive en el
consumidor, y el editor lo refleja.

| Salida | Cuándo | Para qué |
|---|---|---|
| `onChange` / `cristae:change` | **live** — cada frame del arrastre incluido | preview: pintar el área, mostrar el largo, habilitar el botón |
| `onCommit` / `cristae:commit` | **asentado** — una vez por gesto (soltar el arrastre, o una edición discreta) | persistir, apilar un undo, disparar la validación |

Que sean dos y no una es la diferencia entre persistir 60 veces por segundo o una vez por gesto. Sin
`onCommit` había que debouncear afuera, y un debounce no sabe dónde termina el gesto: adivina con un
reloj.

🔴 **El valor se PIDE, no se empuja.** `onChange` corre por frame de arrastre y serializar el trazo
asigna un par por vértice, así que empujarlo costaría O(n) por frame aunque nadie lo mire. Por eso el
callback recibe un **lector** (`onChange(leer)` → `leer()` devuelve el valor) y el `detail.value` del
evento es un **getter**: una emisión que nadie lee no serializa nada, y leerla dos veces serializa una.
Un editor sin listener de `cristae:change` cuesta lo mismo que no tenerlo.

### El eco: el valor que vuelve no reingresa

Un host controlado devuelve como `value` el valor que el editor acaba de emitir. Ese eco **no se
reingiere**, y no es una optimización: `setValue` suelta la interacción en curso, porque el vértice
que el dedo tiene tomado es POSICIONAL y sobre el valor nuevo direcciona otro. Reingerir el eco
cortaría el arrastre en su primer frame.

El elemento lo resuelve comparando la referencia con el último valor que cruzó el límite: cada emisión
serializa fresco, así que sólo coincide consigo misma. Lo que fija el eco es **leerlo** — quien no
leyó `detail.value` no recibió nada y no puede devolverlo. La consecuencia práctica es que esto
funciona tal cual, sin desacoplar el estado del ciclo del host:

```jsx
const [ruta, setRuta] = useState(puntos)

<CristaeEditablePolyline value={ruta} onChange={e => setRuta(e.detail.value)} />
```

🔴 El eco viaja **por referencia**. Un host que clona el valor en el camino (`[...value]`, un
normalizador, un reducer que reconstruye) rompe la comparación y vuelve a cortar el gesto: en ese caso
hay que guardar en el estado el valor tal como llegó, y clonar en el borde donde se persiste.

---

## Un elemento por forma

No hay un editor con prop `kind`: la forma se lee en el alta —cambiarla no mudaría el editor— así que
es un tipo, no configuración. Además es lo que fija la forma de `value`, que así se tipa exacto. La
entrada y la salida tienen la misma forma; las coordenadas entran en cualquiera de las formas de punto
de [geometría](./geometry.md) y salen como pares. En TypeScript, cada `Editable*Value` tipa lo que
entra, y lo emitido es el mismo tipo con pares: `EditablePolygonValue<[number, number]>`.

| Elemento | React | `value` | Gesto |
|---|---|---|---|
| `<cristae-editable-polygon>` | `<CristaeEditablePolygon>` | `[[lat,lng], …]` (anillo simple) o `[[[lat,lng], …], …]` (multi-anillo) | mover / agregar / borrar vértices; el XOR entre anillos abre el hueco |
| `<cristae-editable-polyline>` | `<CristaeEditablePolyline>` | `[[lat,lng], …]` | mover / insertar / borrar vértices |
| `<cristae-editable-point>` | `<CristaeEditablePoint>` | `[lat,lng]` o `null` | colocar / mover |
| `<cristae-editable-rectangle>` | `<CristaeEditableRectangle>` | `[[s,w],[n,e]]` o `null` | arrastrar una esquina (las otras tres la siguen) |

En `polygon`, la salida **espeja la entrada**: si entró un anillo simple, sale un anillo simple.

---

## El gesto y el click del mapa

El editor no oye el contenedor del mapa: el puntero le llega por la
[puerta del puntero](./interaction.md#la-puerta-del-puntero), que lo pone en el lugar de su capa en el
orden declarado.

En `mode: 'edit'`, la pulsación sobre un handle es del editor salvo que el hit de click de una capa
quede por encima: el mapa no se arrastra con ella y no es un click —ni `map:click` / `cristae:mapclick`,
ni el `click` de una capa debajo—, se mueva o no. Su `pointerdown` y su `pointerup` no siguen a la
burbuja; el `click` que el navegador despacha después sí, y Cristae no lo mira.

- Una capa interactiva por encima del editor con una feature sobre el handle se queda con la pulsación:
  es su click, y el mapa se arrastra con ella. Declararla después no alcanza, porque el editor se apila
  200 sobre su lugar del orden ([apilado](./elements.md#apilado--z--pane)): la sube su `z`.
- Un click en el vacío sigue siendo del mapa y sale como `map:click` / `cristae:mapclick`.
- Lo que cae fuera de la superficie del mapa —el zoom, la atribución o la UI de una zona— es suyo
  aunque tape un handle: la pulsación no toma el handle ni es un click, y el doble click no lo borra.
- El doble click que borra un vértice es del gesto, y el mapa no hace zoom. El que no borra —en
  `rectangle`, en `point` o en un trazo que ya está en su mínimo— sigue siendo del mapa, que hace zoom.
  Donde el navegador no despacha `dblclick` para el toque, Leaflet lo arma con los dos clicks y no pasa
  por la puerta: ahí un doble tap no borra un vértice ni cierra un trazo, y hace zoom.
- La pulsación sigue siendo del gesto aunque un `onCommit` a mitad de ella pase a `mode: 'draw'` o
  destruya el editor: no es un click, y en `draw` no agrega un vértice donde se soltó.
- El gesto es del puntero que lo tomó: otro dedo que se apoya mientras dura no toma otro handle, ni
  mueve o suelta el vértice tomado.

El cursor acompaña al gesto: `grab` con un handle bajo el puntero y `grabbing` mientras está tomado, por
encima del `cursor` que haya pedido el consumidor ([precedencia](./interaction.md#el-cursor-del-contenedor)).
El pase que reconoce el handle no bloquea, así que el cursor sigue a la última muestra del puntero ya
resuelta: con el puntero quieto justo al entrar o salir de un handle, lo corrige el próximo movimiento o
la pulsación.

En `mode: 'draw'` no hay gesto sobre handles: el click del mapa **es** la edición, y el doble click cierra
el trazo de un polígono o una polilínea con dos vértices o más, sin zoom.

---

## Declarativo

```html
<cristae-map>
  <cristae-editable-polygon id="geocerca" mode="draw"></cristae-editable-polygon>
</cristae-map>
```
```js
const editor = document.getElementById('geocerca')
editor.value = anillo
editor.geometryStyle = { color: '#278cff', fillOpacity: 0.3 }
editor.addEventListener('cristae:commit', e => guardar(e.detail.value))
```

`mode` es atributo; `value` y `geometryStyle` son props (objetos, por JS). `z` y `pane` salen de la
base común de las capas — ver [apilado](./elements.md#apilado--z--pane); `pane`, como la forma, se lee
en el alta.

> La prop de estilo se llama **`geometryStyle`** y no `style`, el nombre que usa el motor: una
> propiedad `style` pisaría `HTMLElement.style`. Toma `color`, `weight`, `fillColor` y `fillOpacity`,
> y es **parcial** — lo que no venga queda como estaba.

---

## React

```jsx
import { CristaeMap, CristaeEditablePolyline } from '@cristae/react'

<CristaeMap>
  <CristaeEditablePolyline
    mode={dibujando ? 'draw' : 'edit'}
    value={ruta}
    onChange={e => setRuta(e.detail.value)}
    onCommit={e => persistir(e.detail.value)}
  />
</CristaeMap>
```

Las salidas son CustomEvents del elemento (no canales del bus del motor, como el picking de las capas
de dato), así que las cabla el camino genérico del binding. `e.detail.value` ya viene tipado por el
componente: `EditablePolylineValue` acá, rings en `<CristaeEditablePolygon>`, y así.

---

## Imperativo — `engine.addEditableLayer`

Del lado del motor sigue habiendo UN alta, con `kind` como parámetro: la forma es config del editor y
lo que se reparte en cuatro es la superficie declarativa, donde el tipo tiene que ser estático.

```js
const handle = engine.addEditableLayer({
  id: 'geocerca', kind: 'polygon', value: anillo, mode: 'edit',
  style: { color: '#278cff' },
  onChange: leer => preview(leer()),            // por frame — `leer()` sólo si de verdad se usa
  onCommit: leer => guardar(leer()),
})
```

`EditableHandle`: `{ id, setValue, setMode, setStyle, getValue, handleMapClick, destroy }`.

`handleMapClick(latlng)` es la sub-pieza de captura de punto: en `mode: 'draw'` el editor ya recibe el
click del mapa, pero el consumidor que rutea su propia captura —porque el click también alimenta otra
cosa— lo llama a mano en vez de pelearse con el que le llega.

---

## Costo

La superficie de edición **toma un contexto WebGL** de los ~16 que concede el navegador, igual que una
capa de puntos o de líneas GL. Es un editor por vez: no hay razón para montar varios, y montarlos
gasta el presupuesto que necesitan las capas de dato. `destroy()` (o desmontar el elemento) lo libera.

El editor **dibuja la geometría entera** —relleno, trazo y handles—, así que no se le monta un display
aparte encima: se vería superpuesto al que ya pinta él.
