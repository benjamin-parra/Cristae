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

El handle es `{ id, source, set, setVisible }`, como el de las demás capas de datos; `interactive` y
`visible` valen `true`, y el pane por defecto es `cristae-shape-<id>`.

## Declarativo y React

```html
<cristae-map>
  <cristae-shape-layer id="antenas" focus-ids="a7 a9"></cristae-shape-layer>
</cristae-map>
```
```js
antenas.accessors = { idOf: a => a.id, positionOf: a => a.pos, radiusOf: a => a.alcance,
  headingOf: a => a.azimut, sweepOf: a => a.haz }
antenas.data = lista                       // reasignarla reemplaza todas las formas
```
```jsx
// `acc` definido a nivel de módulo
<CristaeShapeLayer data={zonas} accessors={acc} onClick={hits => abrir(hits[0].id)} />
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
  publican con `set`/`patch`/`move` en la Source; `Source.move` mueve el centro. No hay API de restyle.
- **Foco.** `setLayerFocus` atenúa por forma y `focus(ids, { kinds: ['shape'] })` por capa, como en los
  polígonos.
- **Encuadre.** `fitToLayers` y `camera.fitToLayer` encuadran las figuras enteras, no sólo los centros.
  Si la `version` de la Source ya avanzó, dibujan lo nuevo antes de que emita; con `defineSource` sin
  `version` propia, recién después del aviso. Un accessor que lanza le llega al primero que lee el
  cambio, el encuadre o la emisión, y la capa sigue con lo anterior hasta el próximo cambio.
- **Modelo.** Las formas se colocan y se pican sobre la esfera de radio medio, la misma de `ring` sin
  modelo.

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
| círculos de 500 m | 34 ms | 50 ms | 7,6 µs |
| elipses de 800 × 300 m | 83 ms | 147 ms | 7,3 µs |
| sectores de 5 km y 90° | 47 ms | 73 ms | 9,4 µs |

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

El contorno con los radios es la capa de formas sin relleno: `styleOf: () => ({ fillOpacity: 0 })`. La
capa de líneas no re-tesela por zoom, así que el arco lleva los vértices de la tolerancia sin vista, 0,1 m.
