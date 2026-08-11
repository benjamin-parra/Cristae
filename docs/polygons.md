# Polígonos — los dos sustratos y cuándo usar cada uno

> Pieza de [Cristae](../MODELO.md). La capa de polígonos dibuja con **`L.polygon`** (un path por
> figura) o **en GPU** (relleno por stencil y contorno, todo en una textura). Los dos consumen el
> mismo `Source`, los mismos accessors y contestan el mismo picking.

```js
engine.addPolygonLayer({ id: 'geocercas', data, accessors, backend: 'gpu' })
```

```html
<cristae-polygon-layer id="geocercas" interactive backend="gpu"></cristae-polygon-layer>
```

`backend` se lee **al montar**: cambiarlo en caliente no remonta la capa.

---

## Cuál elegir

| | `leaflet` (default) | `gpu` |
|---|---|---|
| sustrato | un `L.polygon` por figura | stencil + textura, un contexto WebGL |
| escala cómoda | decenas o cientos de figuras | miles |
| reproyección | la hace Leaflet | el pane traslada el canvas; repinta en vista asentada |
| costo por repintado | O(figuras) nodos DOM | una paridad por anillo + una cobertura por polígono, **sólo de lo que toca el viewport** |
| contexto WebGL | ninguno | **uno**, del techo de ~16 del navegador |

El `gpu` gana cuando el DOM es el cuello. Con pocas figuras el sustrato de Leaflet no tiene rival:
no toma un contexto, reproyecta solo y trae los eventos nativos del path.

## Estilo

Las opciones son las de un path de Leaflet, con sus mismos defaults — `color` `#3388ff`, `weight` 3,
`opacity` 1, `fillColor` = `color`, `fillOpacity` 0.2, `stroke` y `fill` en `true`. El `styleOf` de
los accessors recibe **la entidad** y pisa esos defaults por figura; `applyFocus(ids, dim)` atenúa lo
que queda fuera del foco. El estilo se resuelve **una vez por polígono**, no por frame: cuando la
selección o el filtro lo mueven, se reevalúa con `refresh()`.

## Agujeros contra solapes

La distinción sale de la geometría, no de una opción: **un agujero es otro anillo de la misma parte;
un solape es otra parte**. Los anillos de una parte componen su paridad y comparten cobertura —eso
abre el agujero—, y cada parte estrena la suya —eso apila el solape en vez de restarlo—. Las piezas
de un multipolígono son partes distintas de la misma entidad, así que se apilan entre sí y el picking
contesta **una vez** por entidad.

## Geometría tipada, sin Source

`addPolygonGpuLayer` monta la capa sobre las tablas CSR del [lector](geojson.md) sin pasar por arrays:

```js
engine.addPolygonGpuLayer({ id: 'geocercas', geometry: areasOf(readGeoJson(bytes)), interactive: true })
```

`rings` y `parts` van juntas o no van: con una sola, el relleno y el picking mirarían conjuntos
distintos y la capa contestaría por figuras que no dibujó.

## Lo que el sustrato `gpu` todavía no hace

- **El contorno no tiene uniones.** Cada segmento es un quad independiente, así que en un codo cerrado
  queda una muesca, y con `opacity < 1` el solape de los dos quads se pinta dos veces: en cada vértice
  aparece un punto más oscuro. Se nota sobre todo con figuras atenuadas.
- **El descarte por viewport ignora el ancho del trazo**, que se expande en píxeles de pantalla: un
  polígono justo afuera del encuadre puede perder unos píxeles de borde hasta que entra.
- **No hay `z` por entidad**: el orden de dibujo es el de la geometría.
