# Campo de calor — `addHeatLayer`, `<cristae-heat-layer>`

> Pieza de [Cristae](../MODELO.md). Densidad de puntos que se acumula en la GPU, dentro del contexto WebGL
> de su [tramo](./render.md): comparte el contexto de sus vecinas GL y, solo, toma el suyo. Consume un [Source](./data.md).

Cada punto estampa una brocha radial con un alpha chico proporcional a su peso. Donde los puntos se
agolpan, el alpha se acumula en una textura, y una segunda pasada lo traduce a color con una rampa. Es el equivalente de
`leaflet.heat`. Un campo de calor no se pica: no tiene hit ni canales de click.

---

## API

### Accessors (`HeatAccessors`)

| Accessor | Tipo | Rol |
|---|---|---|
| `idOf` | `(p) => string \| number` | id del punto |
| `positionOf` | `(p) => { lat, lng }` | posición; una no finita se omite |
| `weightOf?` | `(p) => number` | peso; sin él, 1. Se normaliza por el peso máximo del snapshot |
| `hashOf?` | `(p) => unknown` | el de la [Source](./data.md) |

### Imperativo

```js
const calor = engine.addHeatLayer({
  id: 'densidad',
  accessors: { idOf: p => p.id, positionOf: p => ({ lat: p.lat, lng: p.lng }), weightOf: p => p.n },
  data: puntos,                 // o `source`, una Source compartida
  radius: 25,                   // px del núcleo; default 25
  blur: 15,                     // px de caída del núcleo a transparente; default 15
  intensity: 1,                 // multiplica el aporte de cada punto; >1 satura antes
  colorRamp: t => [t, 0, 1 - t, t],   // t en [0, 1] → [r, g, b, a] en 0..1 o un color CSS hex
  visible: true,
})
calor.setRadius(40)
calor.setVisible(false)
```

El handle es `{ id, source, set, setVisible, setRadius, setBlur, setIntensity, setColorRamp }`. Un
`radius` o `blur` negativo vale 0. `null` o `undefined` en un setter devuelve el default.

### Declarativo

```html
<cristae-map>
  <cristae-heat-layer id="densidad" radius="25" blur="15" intensity="1"></cristae-heat-layer>
</cristae-map>
```

```js
const capa = document.getElementById('densidad')
capa.accessors = { idOf: p => p.id, positionOf: p => ({ lat: p.lat, lng: p.lng }) }
capa.data      = puntos
```

| Miembro | Tipo | Atributo / prop |
|---|---|---|
| `id` | string | atributo (sin él, `heat-N`) |
| `radius` `blur` `intensity` | number | atributo |
| `visible` | boolean (default `true`) | atributo |
| `data` | `Item[]` | **prop** |
| `source` | `Source` | **prop**; gana sobre `data` |
| `accessors` | `HeatAccessors` | **prop** |
| `colorRamp` | `(t) => color` | **prop** |

- Monta cuando tiene `source` o `accessors`. Los dos se leen **al montar**: reasignarlos no remonta la
  capa.
- `data`, `visible`, `radius`, `blur`, `intensity` y `colorRamp` se aplican en vivo por el handle.
- Hereda `pane`, `z` y `focus-ids` de la base, y `controls` es el handle de arriba.
- Una capa de calor sin puntos cuenta para el estado vacío del mapa, como cualquier capa de datos.

En React es `<CristaeHeatLayer>`, con las mismas props.

---

## Visibilidad

Oculta, la capa deja de pintar: ni los cambios de la Source ni los movimientos del mapa la redibujan. Al
mostrarla repinta una vez con los datos y la vista de ese momento. Vale también para una capa que nace
oculta (`visible: false` en el alta).

## Costo

- Cada redibujo es O(n) instancias en la GPU, recortadas en el vértice, más una pasada de color sobre el
  contenedor. No hay `getImageData` ni recorrido de píxeles en JS.
- Un cambio de la Source sube los puntos una vez, O(n), y redibuja en el mismo frame en que llega, ya
  coalescido por la Source. La cámara sola (paneo, zoom asentado) no sube nada: sólo redibuja.
- Desde 20.000 puntos, la capa los junta por nivel de zoom entero en celdas de pantalla de R/20 px, con
  R = `radius` + `blur` (2 px con los valores por defecto, 8 px como mucho), y dibuja una muestra por celda
  en lugar de una por punto. Ver [Agregación](#agregación).
- La acumulación va en px CSS, sin escalar por DPR: un campo difuso no lo necesita.
- `colorRamp` se muestrea a 256 texeles al cambiar. En React se compara por referencia, así que una función
  escrita en línea en el render rehace la paleta en cada render: conviene declararla fuera del componente
  o con `useCallback`.

## Agregación

Con muchos puntos, lo que cuesta es el relleno de la GPU: cada punto pinta un cuadrado de 2R de lado. Desde
20.000 puntos válidos la capa junta los de cada celda de R/20 px en una muestra que lleva la suma de sus
aportes, su centroide ponderado y la covarianza de sus posiciones, y la GPU dibuja una muestra por celda:

- La muestra suma lo mismo que sus puntos: con aportes iguales, exactamente; con pesos distintos, salvo un
  término de segundo orden.
- La covarianza ensancha la brocha de la celda en la dirección en que se reparten sus puntos, así que el borde
  de una región densa queda donde lo dejan sus puntos más externos.
- Las celdas se rehacen cuando cambian los datos (un flush, un `move`), el nivel entero de zoom, el tamaño de
  celda (`radius`, `blur`) o `intensity`, y con `refresh()`. Un paneo, un zoom dentro del mismo nivel y la
  cámara sola no las tocan.
- Rehacerlas es O(n) en el hilo principal, dentro del dibujo que las necesita: hasta 8 ms con 100.000 puntos,
  de 12 a 50 ms con 500.000 y de 25 a 152 ms con 1 M, medido en un CPU de escritorio.
- Si las celdas no bajan los puntos a la mitad, la capa dibuja un splat por punto. Por debajo de 20.000
  puntos dibuja exactamente como sin agregación.

Lo que cambia la imagen, medido:

- Contra la suma exacta (acumulada en float32), menos del 0,1 % de los px con calor difiere en más de 8/255
  por canal, y ninguno en más de 2 niveles de la rampa si se admite un borde corrido 1 px.
- La excepción es el borde de las regiones con varios puntos por px², donde el campo pasa del vacío al tope
  en pocos px.
- Contra la imagen sin agregar la diferencia es algo mayor donde se apilan miles de splats por px. Esa imagen
  redondea a media precisión en cada suma del R16F, y la agregada queda más cerca de la suma exacta.

## Formato y respaldo

La acumulación elige su formato una vez por contexto, según las extensiones que éste ofrece, sin detectar
navegador:

| Formato | Cuándo | Mezcla |
|---|---|---|
| R16F | el contexto ofrece `EXT_color_buffer_float` o `EXT_color_buffer_half_float` | suma de logaritmos: el aporte de cada punto se acumula en coma flotante |
| RGBA8 | sin ninguna de las dos | `over` sobre el alfa de 8 bits |

El respaldo RGBA8 cuantiza cada aporte a 8 bits y el error crece con el solape: llega a 8 niveles de los 255.

Con la agregación, una celda junta sus n mezclas en una sola y cuantiza una vez, así que en las zonas densas
el respaldo queda más cerca del R16F que punto por punto.

Sin WebGL2 `addHeatLayer` lanza, como las demás capas GL, y el consumidor puede degradar a otra cosa. El calor en canvas 2D no
lo necesitaba: es un cambio de contrato (ver el CHANGELOG).

## Exactitud

El índice que pinta la GPU se valida contra la ley ideal calculada en float64: el error máximo es de 2
niveles en R16F y de 8 en RGBA8. El color puede diferir unos niveles del que daba el canvas 2D anterior; no
es un cambio de la rampa ni de la ley.

## Límites

- `focus-ids` atenúa el pane entero: el calor no atenúa puntos sueltos.
- El campo no sigue el zoom animado: se oculta al empezar y reaparece al asentar, porque lo compone el
  tramo y no un canvas que el navegador escale.
- No se pica.
