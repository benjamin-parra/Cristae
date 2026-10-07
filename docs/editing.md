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
| `<cristae-editable-polygon>` | `<CristaeEditablePolygon>` | `[[lat,lng], …]` (anillo simple) o `[[[lat,lng], …], …]` (multi-anillo) | mover / agregar / borrar vértices, o trazar a [mano alzada](#mano-alzada); el XOR entre anillos abre el hueco |
| `<cristae-editable-polyline>` | `<CristaeEditablePolyline>` | `[[lat,lng], …]` | mover / insertar / borrar vértices, o trazar a [mano alzada](#mano-alzada) |
| `<cristae-editable-point>` | `<CristaeEditablePoint>` | `[lat,lng]` o `null` | colocar / mover |
| `<cristae-editable-rectangle>` | `<CristaeEditableRectangle>` | `[[s,w],[n,e]]` o `null` | arrastrar una esquina (las otras tres la siguen) |
| `<cristae-editable-circle>` | `<CristaeEditableCircle>` | `{ center, radius }` o `null` | mover el centro / el radio |
| `<cristae-editable-ellipse>` | `<CristaeEditableEllipse>` | `{ center, radius: [a, b], heading }` o `null` | mover el centro / girar con `a` / ensanchar con `b` |
| `<cristae-editable-sector>` | `<CristaeEditableSector>` | `{ center, radius, heading, sweep }` o `null` | mover el centro / la punta / abrir con un borde |

En `polygon`, la salida **espeja la entrada**: si entró un anillo simple, sale un anillo simple.

### Círculo, elipse y sector

El valor es una [forma](./geometry.md#formas--ring-y-arc) con el radio de su tipo, en metros: un número
en el círculo y el sector, `[a, b]` en la elipse. Entra con la regla de validez de `ring` —`heading` y
`sweep` ausentes son norte y figura entera, y lo que no la cumple es `null`—, y además es `null` si su
borde alcanza un polo. La elipse no lee `sweep`: el sector de elipse se dibuja en la
[capa de formas](./shapes.md), pero no se edita.

Lo emitido es un objeto fresco por lectura, con `center` como par `[lat, lng]` —a diferencia de
`getCenter()`, que da `{ lat, lng }`—, `heading` en [0, 360) y `sweep` en (0, 360]. Es una `Shape`, así
que `area(ring(e.detail.value))` mide lo editado.

| Forma | Manijas | Arrastre |
|---|---|---|
| círculo | centro y radio | El centro traslada la figura y el radio es la distancia al puntero. La manija de radio entra al este y queda en el rumbo donde se soltó, hasta el próximo `value`. |
| elipse | centro, `a` (en `heading`) y `b` (en `heading + 90`) | `a` cambia el semieje y `heading`, así que también gira; `b` sólo cambia su semieje, y al soltar su manija vuelve al eje. |
| sector | centro, punta (en `heading`) y dos bordes | La punta cambia `radius` y `heading`. Un borde cambia sólo `sweep`, simétrico alrededor de `heading`: dos veces el ángulo entre el puntero y la punta, por el lado más corto. |

- **Mínimos.** Un radio no baja de 24 px a la vista, y la apertura no deja dos manijas a menos de eso:
  las manijas no se pisan. Un radio que ya es menor —porque entró así o porque se alejó el zoom— no se
  corrige, y la apertura se acota como en el radio mínimo.
- **Polo.** El arrastre que llevaría el borde a un polo no se aplica ni emite.
- **Modelo.** El valor y las manijas salen del modelo con que el mapa coloca las formas. Mientras dura el
  gesto el anillo se dibuja con la esfera de radio medio, y al soltar se rehace con el modelo: con
  `WGS84` lo dibujado en el gesto se aparta del final a lo sumo un 0,56 % del radio.
- `focus({ kinds: ['circle'] })` no alcanza a un editor de círculo: su capa es `kind: 'editable'`.

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
  `rectangle`, en `point`, en las formas o en un trazo que ya está en su mínimo— sigue siendo del mapa,
  que hace zoom.
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
el trazo de un polígono o una polilínea con dos vértices o más, sin zoom. Las figuras de tamaño fijo se
trazan por clicks, y el mapa sigue paneando entre ellos:

| Figura | Clicks |
|---|---|
| rectángulo | 2: una esquina y la opuesta |
| círculo | 2: el centro y el borde |
| elipse | 3: el centro, la punta de `a` y el borde de `b` |
| sector | 3: el centro, la punta y un borde |

Entre clicks una **vista previa** sigue al puntero sin emitir: el valor no cambia hasta el último click,
que emite `change` y `commit` una sola vez. En táctil no hay puntero que siga sin apoyar el dedo: entre
toques la vista previa sólo se mueve con el dedo que panea, y el valor sale igual de los toques.

### Mano alzada

`mode: 'freehand'` es un tercer modo de `polygon` y `polyline`: el dedo —o el mouse— traza y el editor
no tiene manijas. En los demás editores queda inerte, como cualquier `mode` desconocido.

```html
<cristae-editable-polygon mode="freehand"></cristae-editable-polygon>
```
```jsx
<CristaeEditablePolyline mode="freehand" value={ruta} onCommit={e => setRuta(e.detail.value)} />
```
```js
handle.setMode('freehand')
```

Una regla: **continúa lo abierto y reemplaza lo cerrado.**

- **Polilínea.** El trazo se agrega al final del `value`, así que se puede pausar para panear y seguir.
- **Polígono.** El trazo es un lazo y reemplaza el valor **entero** por un anillo simple, aunque el valor
  tuviera varios anillos. Un lazo que no llega a tres vértices tras suavizarse —una recta— no es un
  polígono: se descarta como una cancelación.

Mientras dura, `change` sale por cada muestra con el trazo crudo. Al soltar se **hornea** y sale un solo
`change` y un solo `commit` con el valor ya suave, que sigue siendo una polilínea o un anillo común con
vértices editables en `mode: 'edit'`:

1. Douglas–Peucker en píxeles, con 2 px de tolerancia, quita lo que la recta ya resume.
2. Una Catmull-Rom centrípeta —sin lazos ni cúspides— pasa por lo que queda; en el polígono es
   periódica, así que el cierre no tiene esquina.
3. Cada tramo se parte lo justo para que la polilínea no se aparte de la curva más de 1 px: con menos,
   los vértices se amontonarían y el modo `edit` no podría tomarlos.

No hay parámetros: las tolerancias son de pantalla.

- **La pulsación es del editor.** En este modo el editor toma toda la superficie: el mapa no panea con el
  dedo y no hay `map:click` ni `cristae:mapclick`. Una capa interactiva por encima de él sigue ganando la
  pulsación, igual que con un handle. Un toque sin recorrido (`CLICK_TOLERANCE`) no crea trazo ni toca el
  valor. La rueda sigue haciendo zoom, y el doble click no se consume.
- **Movimiento de la vista.** Entre `movestart` / `zoomstart` y `moveend` / `zoomend` no se muestrea: al
  retomar queda una cuerda recta entre la última muestra y la primera nueva. El trazo se guarda en
  lat/lng, así que un zoom a mitad no lo deforma. Un segundo dedo (pinch) mueve la vista, y la puerta del
  puntero no se lo avisa al editor: si el primer dedo sigue trazando mientras tanto depende del anfitrión.
- **`pointercancel`.** Descarta el trazo: el valor vuelve al de antes, con un `change` que lo informa, y
  no hay `commit`. `setMode`, `setValue` y `destroy` a mitad del trazo también lo sueltan y devuelven el
  arrastre del mapa, sin `commit`: `setMode` lo descarta como el cancel, con su `change`; `setValue` deja
  el valor que trae, y `destroy`, ninguno. Esos dos no emiten.
- **Cursor.** No se informa `HANDLE_HELD`: queda el del consumidor.

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
lo que se reparte en siete es la superficie declarativa, donde el tipo tiene que ser estático.

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
