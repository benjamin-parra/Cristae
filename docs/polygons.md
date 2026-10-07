# Polígonos — dibujo en GPU

> Pieza de [Cristae](../MODELO.md). La capa de polígonos dibuja **en GPU**: relleno por stencil y
> contorno, todo en una textura. Consume un `Source` con sus accessors, o las tablas del lector, y
> contesta picking por índice.

```js
engine.addPolygonLayer({ id: 'geocercas', data, accessors })
```

```html
<cristae-polygon-layer id="geocercas" interactive></cristae-polygon-layer>
```

La Source puede ser del consumidor y compartirse con otra vista —una tabla, un segundo mapa—; el
elemento la toma por propiedad, igual que la capa de puntos, y con ella viajan los accessors:

```js
document.querySelector('#geocercas').source = geocercas
```

`source` se lee **al montar**: reasignarla no remonta la capa.

---

## Costo

| Aspecto | Polígonos |
|---|---|
| escala cómoda | miles de figuras |
| reproyección | el pane traslada el canvas; repinta en vista asentada |
| costo por repintado | una paridad por anillo + una cobertura por polígono, **sólo de lo que toca el viewport** |
| contexto WebGL | **uno por capa**, del techo de ~16 del navegador |

El costo que hay que tener en la cabeza no es el de dibujo sino el de **contexto**: cada capa abre el
suyo, y el navegador da unos ~16 en total; pasado el techo empieza a evictar los viejos. Con varias
capas de polígonos en la misma página conviene juntarlas en una, con un `styleOf` que las distinga.
No hay sustrato que elegir: `addPolygonLayer` rechaza un `backend`, y el elemento no tiene el atributo.

## Estilo

Las opciones son las de la gramática de la librería: `color` `#3388ff`, `weight` 3, `opacity` 1,
`fillColor` = `color`, `fillOpacity` 0.2 y `dash`, un patrón de trazo en píxeles de pantalla (`null` o
ausente, trazo continuo) con las reglas del de las
[líneas](lines.md#patrones-de-trazo--un-solo-eje-dash-no-un-flag-por-patrón). Un `color` que pone
`styleOf` mueve también el relleno, salvo que el mismo estilo o la capa fijen `fillColor`. El `styleOf`
de los accessors recibe **la entidad** y pisa esos defaults por figura; `applyFocus(ids, dim)` atenúa lo
que queda fuera del foco. `stroke` y `fill` (en `true`) prenden o apagan el trazo y el relleno **de la
capa entera** y no se pisan por figura: una figura sin relleno lleva `fillOpacity: 0`, y una sin borde,
`opacity: 0` o `weight: 0`. `interactive` es la excepción y se ignora: el picking es por índice, y los
eventos salen por `cristae:click`/`cristae:hover` con `interactive` en la capa. El estilo se resuelve
**una vez por polígono**, no por frame: cuando la selección o el filtro lo mueven, se reevalúa con
`refresh()`.

## Agujeros contra solapes

La distinción sale de la geometría, no de una opción: **un agujero es otro anillo de la misma parte;
un solape es otra parte**. Los anillos de una parte componen su paridad y comparten cobertura —eso
abre el agujero—, y cada parte estrena la suya —eso apila el solape en vez de restarlo—. Las piezas
de un multipolígono son partes distintas de la misma entidad, así que se apilan entre sí y el picking
contesta **una vez** por entidad.

## Geometría tipada, sin Source

La misma puerta acepta las tablas CSR del [lector](geojson.md) sin pasar por arrays:

```js
engine.addPolygonLayer({ id: 'geocercas', geometry: areasOf(readGeoJson(bytes)) })
```

El elemento la hereda, así que también entra por markup: `polygonLayer.geometry = areasOf(doc)`.
`addPolygonGpuLayer` sigue existiendo como delegador **deprecado** y se retira en 1.0.

`rings` y `parts` van juntas o no van: con una sola, el relleno y el picking mirarían conjuntos
distintos y la capa contestaría por figuras que no dibujó.

La identidad viaja con la geometría: `areasOf` trae el `owner` de cada parte, así que **no hace falta
escribir `idOf`** — un multipolígono contesta una vez, con el índice de su feature. `idOf` queda como
override, y recibe el DUEÑO de la parte: la entidad por la ruta de `Source`, el índice de feature por
la tipada. Para usar el `id` del propio documento es una línea:

```js
const doc = readGeoJson(bytes)
engine.addPolygonGpuLayer({ id: 'geocercas', geometry: areasOf(doc), idOf: f => doc.idOf(f) })
```

Con tablas armadas a mano, sin `owner`, el sujeto sigue siendo la parte.

## Curva geodésica

Con curva, las tablas se densifican sobre la geodésica al entrar, con la regla de
[`geodesic`](geometry.md#geodésica--geodesic) y también en la arista de cierre, y el relleno, el picking y
el encuadre leen las curvadas: el punto-en-anillo coincide con el borde que se ve. Anillos, partes y la
selección `rings`/`parts` conservan su numeración, así que un hit da la misma parte que sin curva, y los
anillos que la selección deja afuera pasan rectos. La densificación corre cuando entra la geometría, nunca
por zoom, y un polígono de aristas de 10 a 100 m no gana vértices: mil geocercas de 20 vértices quedan
iguales, y veinte zonas de 10° pasan de 800 a 16 000 vértices, en 11 ms en la esfera y 160 ms en WGS84.
Con Source, cada cambio entra curvado. Una capa tipada se curva sólo si es `interactive`, porque sólo
entonces retiene sus tablas, y mientras curva retiene las dos: las curvadas que lee el picking y las rectas
a las que vuelve.

## Lo que todavía no hace

- **No hay `z` por entidad**: el orden de dibujo es el de la geometría.

El contorno une por **miter**: cada extremo se desplaza sobre la bisectriz de sus dos segmentos, así que
los dos quads que comparten un vértice caen sobre las mismas dos esquinas —sin hueco y sin solape—. Eso
importa con `opacity < 1`: un trazo que se pisa a sí mismo mezcla el alfa dos veces y deja el vértice
más oscuro. En un codo muy cerrado el desplazamiento se topea, y como los dos segmentos aplican el
mismo tope siguen compartiendo esquina: el codo se corta plano en vez de abrirse.
