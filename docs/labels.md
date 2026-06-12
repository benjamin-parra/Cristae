# LabelLayer — etiquetas de texto sobre canvas

> Pieza de [Cristae](../MODELO.md). Implementa [SPECS §8.3](../SPECS.md) (label-layer). Capa de
> presentación pura: posiciona etiquetas sobre el mapa; no resuelve hits ni conoce el dominio.

`LabelLayer` dibuja etiquetas de texto (píldoras) sobre un canvas overlay de Leaflet, ancladas a
coordenadas geográficas. Una sola capa genérica: el **glifo** lo pinta una función inyectable
(`paint`), así que el estilo (vehículo, lugar, lo que sea) es del consumidor, no de la capa.

---

## Por qué una sola capa genérica

La `ConstantLabelLayer` de referencia triplicaba el código: `vehicle`, `place` y `searchPlace`, cada
una con su pane, su set de hover y su función de dibujo casi idéntica. Tres caminos para el mismo
problema (anclar texto + cull + elevar el hover) → triple superficie de bug.

`LabelLayer` colapsa eso en **un** overlay de canvas (`CanvasOverlay`, una `L.Layer` mínima) más
**un** `paint(ctx, point, label, hovered, style)` inyectable. La diferencia visual entre "vehículo" y
"lugar" es solo un `paint` distinto (o el `drawLabel` por defecto con campos distintos en el label).
Cero dominio en la capa.

El overlay maneja lo no trivial: alineación con el mapa (`containerPointToLayerPoint`), nitidez en
pantallas HiDPI (`devicePixelRatio` + `setTransform`), y **se oculta durante el `zoom`** (si no, las
etiquetas se deslizarían desfasadas del mapa durante la animación) reapareciendo en `zoomend`.

---

## API pública

Construcción:
```js
new LabelLayer({ map, pane: { name, zIndex }, paint = drawLabel, boundsPad = 0.08, style })
```

| Método / prop | Firma | Notas |
|---|---|---|
| `setLabels(labels)` | `(Label[]) → void` | reemplaza el set y redibuja. `Label = { id, lat, lng, text, ...estilo }` |
| `setHovered(ids)` | `(Iterable<id>) → void` | marca ids resaltados (se dibujan **encima** del resto). Misma referencia que la anterior → no-op |
| `style` | setter | objeto de tema (`{ surface, text, accent }`) leído por `drawLabel`; redibuja |
| `setVisibility(visible)` | `(bool) → void` | muestra/oculta el pane |
| `clear()` | `() → void` | vacía labels + hover (no-op si ya estaba vacío) |
| `destroy()` | `() → void` | quita el overlay del mapa |

**`Label`** solo exige `{ id, lat, lng, text }`; cualquier otro campo (p. ej. `accent`) lo interpreta
el `paint`. El culling por bounds (`boundsPad` de padding) y la elevación de los hovered son de la
capa; el resto es del painter.

### `drawLabel` (painter por defecto, exportado)

`drawLabel(ctx, point, label, hovered, style)` pinta una píldora redondeada: fondo de superficie,
borde con tinte de acento (más opaco si `hovered`), texto recortado al ancho máximo, y —si el label
trae `accent`— una franja de acento a la izquierda. Memoiza el ancho medido (`measureText`) por
`fuente|texto`. Es genérico; para otro look, se inyecta un `paint` propio.

---

## Invariantes

1. **Cero dominio en la capa.** La capa no sabe qué es un "vehículo": recibe labels opacos y delega
   el dibujo. El estilo es del `paint`/`style`, inyectado.
2. **El hover se dibuja al final** → siempre por encima. La comparación de referencia (`setHovered`
   con el mismo array) evita redibujos redundantes.
3. **Se oculta en `zoom`** y se reposiciona en `moveend/zoomend/resize`; el canvas se redimensiona
   solo si cambió el tamaño o el `devicePixelRatio` (sin trabajo por frame de pan).

---

## Ejemplo de uso

```js
import { LabelLayer, drawLabel } from './src/render/LabelLayer.js'

// Standalone con el painter por defecto.
const labels = new LabelLayer({
  map,
  pane: { name: 'fleetLabelsPane', zIndex: 665 },
  style: { surface: '#fff', text: '#0f172a', accent: '#2563eb' },
})

labels.setLabels([
  { id: 1, lat: -33.40, lng: -70.60, text: 'TRACTO-001', accent: '#16a34a' },
  { id: 2, lat: -33.45, lng: -70.66, text: 'TRACTO-002' },
])

// Resaltar (se dibujan encima).
labels.setHovered([1])

// Painter propio: otro look sin tocar la capa.
const minimal = new LabelLayer({
  map,
  pane: { name: 'tagsPane', zIndex: 640 },
  paint: (ctx, point, label) => {
    ctx.fillStyle = '#000'
    ctx.fillText(label.text, point.x, point.y)
  },
})
```

> En el elemento `<cristae-map>`, una `<cristae-label-layer bind-to="fleet">` deriva las posiciones y
> el `textOf` de la capa anfitriona; ese cableado lo arma el motor. La `LabelLayer` en sí solo recibe
> `setLabels`.

### Las labels ligadas respetan la supresión del host

Una label `bind-to` un host **no es** un espejo ingenuo de `host.source.getSnapshot()`: omite los
ids que el host suprime (los clusterizados, ver [cluster.md](./cluster.md)). Sin esto, al activar un
cluster quedarían **labels flotantes** — etiquetas de vehículos cuyo marcador ya no se dibuja porque
está agrupado en una burbuja.

El motor lo garantiza tratando `cluster.clusteredIds` como un **set compartido** que observan tanto
la capa de puntos como la sincronización de labels (`if (host.suppressed?.has(id)) skip`). Como un
recluster por **zoom** no cambia los datos (la suscripción a la fuente no dispara), el motor reinvoca
explícitamente la sincronización de toda label ligada al host cuando la supresión cambia. Al quitar el
cluster, la supresión se vacía y las labels vuelven a mostrarse completas. Es coordinación del motor:
la `LabelLayer` sigue siendo presentación pura y no conoce clusters.
