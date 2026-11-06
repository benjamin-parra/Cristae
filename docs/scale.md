# `<cristae-scale>` — escala gráfica

> Pieza de [Cristae](../MODELO.md). Control de UI del elemento, como `<cristae-toolbar>`: no es una capa,
> no entra a la gramática y no toca el anfitrión.

Muestra una barra con la distancia que representa en el centro de la vista, en metros, en unidades
imperiales o en las dos. Es el equivalente de `L.control.scale` de Leaflet.

```html
<cristae-map>
  <cristae-scale slot="bottom-left" units="metric imperial" max-width="100"></cristae-scale>
</cristae-map>
```

Va en cualquier zona del overlay por `slot` ([zonas](elements.md#zonas-de-overlay-y-slots)). Fuera de un
`<cristae-map>` no dibuja nada y no lanza.

## Atributos

| Atributo | Prop | Default | Qué |
|---|---|---|---|
| `units` | `units` | `metric` | tokens separados por espacio: `metric`, `imperial`. Un token desconocido se ignora, y una lista sin ninguno conocido vale `metric`. La métrica va siempre primero |
| `max-width` | `maxWidth` | `100` | px a lo largo de los que se mide. Un valor no finito o ≤ 0 vale 100 |

Los dos se aplican en vivo.

## Cómo mide

- Toma la fila central del contenedor y mide, con el `model` del `<cristae-map>` (la esfera por defecto),
  la distancia entre su píxel 0 y su píxel `max-width`.
- Redondea **hacia abajo** a 1, 2, 3 o 5 × 10ⁿ, y la barra se acorta en la misma proporción: su ancho queda
  entre la mitad y el total de `max-width`, y mide exactamente lo que dice su rótulo, sin redondear a px.
- Desde 1000 m pasa a `km`, y desde una milla (5280 ft), a `mi`. Bajo 1 m sigue en decimales (`0.5 m`),
  donde Leaflet sube a `1 m` y la barra pasa de `max-width`.
- Las abreviaturas (`m`, `km`, `ft`, `mi`) no se traducen.

Como la escala de Mercator cambia con la latitud, la barra cambia con el paneo y no sólo con el zoom. Sigue
el paneo en continuo, a lo más una vez por cuadro, y se asienta con `cristae:viewportchange`. Tras un
re-montaje del mapa lee el motor y la cámara nuevos sola.

## Bordes

- **Antes de `cristae:ready`**, o con el contenedor de alto 0 (`display: none`): no hay barra. Vuelve con
  el `viewportchange` que trae la vista o el tamaño.
- **Vista que cruza el antimeridiano:** se mide el arco corto, no hace falta corregir nada.
- **Zoom bajo con el mapa más chico que `max-width`:** se mide igual a lo largo de `max-width` px, y la
  barra puede pasar de media vuelta al mundo. Leaflet hace lo mismo.

## Aspecto

Imita el de Leaflet: borde de 2 px sin el de arriba, fondo blanco translúcido, y la segunda barra con el
borde invertido. No toma el puntero, así que el arrastre pasa al mapa.

| Part | Qué |
|---|---|
| `scale` | el contenedor de las barras |
| `scale-metric` | la barra métrica |
| `scale-imperial` | la barra imperial |

Cada barra lleva `role="img"` y un `aria-label` con su rótulo.

```css
cristae-scale::part(scale-metric) { background: #0f172acc; color: #fff; border-color: #fff; }
```

## React

```jsx
<CristaeMap>
  <CristaeScale slot="bottom-left" units="metric imperial" maxWidth={120} />
</CristaeMap>
```
