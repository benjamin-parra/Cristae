# Formas — círculos, elipses y sectores en metros

> Pieza de [Cristae](../MODELO.md). La capa de formas dibuja **en GPU** círculos, elipses, sectores y
> sectores de elipse mezclados, cada uno con su tamaño en **metros**: crecen al acercar y encogen al
> alejar. Es el nicho de las coberturas, los radios de acción y los haces de una antena; un sprite de
> tamaño fijo en px es el de la capa de puntos.

```js
engine.addShapeLayer({ id: 'antenas', data: antenas, accessors: {
  idOf: a => a.id, positionOf: a => a.pos, radiusOf: a => a.alcance,
  headingOf: a => a.azimut, sweepOf: a => a.haz,                    // sin `haz`: omnidireccional
} })
```

Cada ítem es una forma, la misma `{ center, radius, heading?, sweep? }` que coloca `ring` en
[`cristae/geometry`](geometry.md#formas--ring-y-arc), leída de los accessors:

| Accessor | Qué da | Default |
|---|---|---|
| `idOf` | el id de la forma | — |
| `positionOf` | el centro, `{ lat, lng }` | — |
| `radiusOf` | **metros**: un número es un círculo; `[a, b]`, una elipse con `a` sobre el rumbo y `b` de través | — |
| `headingOf?` | grados, 0 = N, 90 = E: orienta el semieje `a` y la dirección del sector; el círculo entero no lo lee | norte |
| `sweepOf?` | los grados que abre el sector, centrados en el rumbo; 360 o más es la figura entera | la figura entera |
| `styleOf?` | el estilo de la forma, con el vocabulario de los [polígonos](polygons.md#estilo) | el de los polígonos |

`radiusOf` es geometría del ítem en metros; el `radius` de una capa o de un modificador —cluster,
calor— es configuración en px. Y `shapePresetIconSet({ shape: 'circle' })` dibuja un sprite en px,
no una forma.

El handle es `{ id, source, set, setVisible, style }`; `interactive` y `visible` valen `true`, y el pane
por defecto es `cristae-shape-<id>`.

## Estilo

El de la capa son las opciones de los [polígonos](polygons.md#estilo) —`color`, `weight`, `opacity`,
`fillColor`, `fillOpacity`, `stroke` y `fill`—, y `styleOf` pisa por forma todas menos `stroke` y `fill`.
Una capa de radios de acción, sólo el contorno:

```js
engine.addShapeLayer({ id: 'radios', data, accessors, color: '#0f766e', weight: 2, fill: false })
```

`handle.style({ color, weight, … })` cambia el de la capa y repinta sin llamar a `styleOf`: cada forma
pisa con lo que devolvió al publicarse en la Source. Una clave `undefined` no se toca, y `stroke` y `fill`
se fijan al crearla.

## Declarativo y React

```html
<cristae-map>
  <cristae-shape-layer id="antenas" focus-ids="a7 a9" color="#0f766e" fill="false"></cristae-shape-layer>
</cristae-map>
```
```js
antenas.accessors = { idOf: a => a.id, positionOf: a => a.pos, radiusOf: a => a.alcance,
  headingOf: a => a.azimut, sweepOf: a => a.haz }
antenas.data = lista                       // reasignarla reemplaza todas las formas
```
```jsx
// `acc` definido a nivel de módulo
<CristaeShapeLayer data={zonas} accessors={acc} fill={false} onClick={hits => abrir(hits[0].id)} />
```

Los miembros del elemento están en
[`elements.md`](./elements.md#cristae-shape-layer--círculos-elipses-y-sectores-en-metros). Sus hits llevan
`kind: 'shape'`, y es una capa hoja: ningún modificador de composición la consume.

## Validez

Una sola regla, la de `ring`: `null` o `undefined` toman el default, y un número presente que la forma
usa y no es finito la descarta, como un radio o un `sweep` que no son mayores que 0. La capa descarta
además un centro que no es un lugar y la forma cuyo borde alcanza un polo —con el semieje mayor—, que
en Mercator no tiene contorno finito. Una forma descartada no se dibuja ni pica, y las demás siguen.

Las que pasan de ±85,05° sin alcanzar el polo se dibujan aplastadas contra el borde del mapa.

## Picking y estado

- **El hit es lo dibujado.** El picking es punto-en-anillo sobre el mismo anillo que va a la GPU, así
  que un punto pica si cae en la figura que se ve. El hit es `{ kind: 'shape', id, ref: id,
  distancePx: 0 }`, y de varias formas superpuestas sale primero la de arriba, que es la última de
  `data`.
- **La copia del mundo.** La forma se dibuja una vez, en la copia de su centro, con la longitud
  continua pasado el antimeridiano, y pica sólo ahí.
- **Estado.** La posición, el radio, el rumbo, la apertura y el estilo se mutan en el ítem y se
  publican con `set`/`patch`/`move` en la Source; `Source.move` mueve el centro. El estilo de la capa, por
  `handle.style`.
- **Foco.** `setLayerFocus` atenúa por forma y `focus(ids, { kinds: ['shape'] })` por capa, como en los
  polígonos.
- **Encuadre.** `fitToLayers` y `camera.fitToLayer` encuadran las figuras enteras, no sólo los centros.
  Si la `version` de la Source ya avanzó, dibujan lo nuevo antes de que emita; con `defineSource` sin
  `version` propia, recién después del aviso. Un accessor que lanza le llega al primero que lee el
  cambio, el encuadre o la emisión, y la capa sigue con lo anterior hasta el próximo cambio.
- **Modelo.** Las formas se colocan y se pican sobre el modelo de la Tierra del mapa, la esfera de radio
  medio salvo que se pase otro. Es una opción del alta, y cambiarla después no re-tesela:

  ```js
  import { WGS84 } from 'cristae/geometry'
  new MapEngine({ container, model: WGS84 })      // <CristaeMap model={WGS84}> en React
  ```

  El borde y el hit coinciden en cualquier modelo, y los vértices caen sobre la curva de `ring` con ese
  modelo, con la densidad que pide el zoom. El modelo tiene que ubicar destinos y rumbos —`sphere()`,
  `ellipsoid()` y `WGS84`—: un terreno o un modelo sin esas marcas lanza `TypeError` en el alta, junto
  con el resto de las opciones del mapa. El alias de círculos no lo lee.

## Costo

- **Contexto WebGL.** Uno por capa, del techo de ~16 del navegador: círculos, elipses y sectores van en
  la misma.
- **Cambio de la Source.** Rehace todos los anillos y sube la textura entera, una vez: la emisión no
  rehace lo que un encuadre ya dibujó. Una `defineSource` sin `version` propia compartida entre capas
  avanza su versión una vez por capa, así que el primer encuadre tras el aviso puede rehacer una vez más.
- **Zoom.** Al asentar, rehace los anillos sólo si alguna forma pide otro número de vértices.
- **Picking.** Descarta por caja y prueba el anillo sólo de las formas cuya caja contiene el punto.

Cada forma lleva los vértices que mantienen la cuerda a menos de 0,2 px de la curva al zoom vigente,
con 16 a 4096 en la figura entera; la elipse, los de su semieje mayor. El arco de un sector lleva la
parte que le toca de ese número, y cada radio los tramos que mantienen la geodésica a 0,1 m.

Mil formas a zoom 15 en Node 26, sin GPU (mediana de 7):

| Mil… | rehacer los anillos | zoom 15 ↔ 17 | un hit |
|---|---|---|---|
| círculos de 500 m | 29 ms | 41 ms | 5,4 µs |
| elipses de 800 × 300 m | 83 ms | 133 ms | 6,0 µs |
| sectores de 5 km y 90° | 51 ms | 63 ms | 6,2 µs |

Con `WGS84` cada vértice pide un `Direct` de la geographiclib, que asigna: ~1,7 µs contra ~0,25 µs de la
esfera. Las mismas mil formas:

| Mil… con `WGS84` | rehacer los anillos | zoom 15 ↔ 17 | un hit |
|---|---|---|---|
| círculos de 500 m | 129 ms | 253 ms | 4,4 µs |
| elipses de 800 × 300 m | 262 ms | 489 ms | 5,6 µs |
| sectores de 5 km y 90° | 144 ms | 290 ms | 5,7 µs |

El zoom re-tesela sólo las formas cuyo número de vértices cambia, así que ese costo se paga en cada
`zoomend` y no en cada frame. Un hit no consulta el modelo: prueba el anillo ya teselado. Arrastrar el
centro o la manija de radio de un editor de círculo, de elipse o de sector cuesta ~0,1 a 0,25 ms por
frame con cualquiera de los dos: durante el gesto el modelo sólo ubica la manija —y la de radio le pide
además una distancia y un rumbo—, y el anillo se rehace con él al soltar, en ~0,5 a 1,2 ms. Las cifras
salen de `node bench/formas.mjs`.

Los vértices de todas las formas entran en una textura del lado máximo del contexto. Si no caben, la
capa baja a la mitad los vértices de todas hasta que entren, sin avisar, con un piso de 16 por figura
entera; si ni así caben, el cambio se rechaza y la capa sigue dibujando lo anterior. El borde se aparta
entonces más de 0,2 px de la curva, y también con el tope de 4096 vértices y durante un zoom animado,
antes de que asiente.

## El borde curvo, en una capa de líneas

El arco no tiene capa ni opción: es [`arc`](geometry.md#formas--ring-y-arc) dibujado por la capa de
líneas, que trae el `dash`, el `cap: 'round'`, el gradiente por `scalarOf` y el picking por segmento
más cercano. `arc` sale de `cristae/map` porque compone con una capa, como `toParts` y `sampleAlong`;
las funciones puras no ven el mapa, así que colocan la forma sobre la esfera por defecto o sobre el
modelo que se les pase:

```js
import { arc } from 'cristae/map'
engine.addLineLayer({ id: 'barrido', data: radares,
  accessors: { idOf: r => r.id, pathOf: arc, styleOf: () => ({ dash: [6, 4], cap: 'round' }) } })
```

El contorno con los radios es la capa de formas sin relleno: `fill: false`. La
capa de líneas no re-tesela por zoom, así que el arco lleva los vértices de la tolerancia sin vista, 0,1 m.

## Migrar desde `addCircleLayer`

`addCircleLayer` sigue funcionando, como alias de la capa de formas, y se retira en 1.0. Se migra cambiando
el nombre del accessor del radio:

```js
// antes
engine.addCircleLayer({ id, data, accessors: { idOf, positionOf, radiusMetersOf, styleOf } })
// después
engine.addShapeLayer({ id, data, accessors: { idOf, positionOf, radiusOf: radiusMetersOf, styleOf } })
```

El alias dibuja el mismo anillo: sobre la esfera por defecto aunque el mapa traiga otro `model`; sus hits
salen en el orden del snapshot de su Source (el de `data`), con `kind: 'circle'`; el pane por defecto es
`cristae-circle-<id>`; el handle es `{ id, source, set, setVisible }`; lee sólo `radiusMetersOf`, y sólo si es
un número; e ignora `headingOf`, `sweepOf` y el estilo de capa. Sin migrar cambian tres cosas: el hit es
punto-en-anillo y difiere del analítico en 0,2 px a lo sumo; `fitToLayers` y `camera.fitToLayer` encuadran los
círculos enteros, y para encuadrar sólo los centros está `camera.followBounds(id, ids)`; y si los vértices no
caben en la textura, el alias los baja como la capa de formas en vez de quedarse sin dibujar. Al migrar a la
capa de formas también cambia:

- `hit.kind` pasa de `'circle'` a `'shape'`, y `focus({ kinds: ['circle'] })` a `['shape']`;
- el pane por defecto pasa a `cristae-shape-<id>`;
- los hits salen de arriba hacia abajo;
- la capa usa el modelo del mapa;
- hay elemento, `<cristae-shape-layer>`, y `<CristaeShapeLayer>` en React.

El `kind` del hit y del foco es el de la capa; `EditableKind: 'circle'` es la figura de un editor.
