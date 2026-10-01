# Marcadores HTML — `HtmlLayer`, `<cristae-html-layer>`

> Pieza de [Cristae](../MODELO.md). Nodos DOM propios sobre la superficie del anfitrión — **GL-safe**
> (no abre otro contexto WebGL). Consume un [Source](./data.md). Complementa el [point-layer GPU](./render.md), no lo reemplaza.

El point-layer rasteriza sprites a un atlas GPU (canvas) — perfecto para **miles** de marcadores en
tiempo real, pero **no rinde HTML arbitrario** (un heroicon SVG, un glifo de fuente FontAwesome, una
letra con CSS). Para eso está `HtmlLayer`: monta un nodo por marcador con el HTML del consumidor. Su nicho son
los **badges de dominio de baja/media cardinalidad** (inicio/fin, evento, parada) que hoy los
consumidores dibujan a mano sobre el mapa de Leaflet — justo la fuente de esa deuda.

**Regla**: pocos marcadores con HTML rico → `html-layer`. Muchos / tiempo real → `point-layer` GPU.

---

## API

### Accessors (`HtmlAccessors`)

| Accessor | Tipo | Rol |
|---|---|---|
| `idOf` | `(m) => number` | id numérico |
| `positionOf` | `(m) => { lat, lng }` | posición del marcador |
| `htmlOf` | `(m) => string` | HTML del icono (heroicon SVG, `<i class="fv-*">`, letra, …) |
| `classNameOf?` | `(m) => string` | clase del nodo del icono (default `cristae-html-marker`) |
| `sizeOf?` | `(m) => [w, h]` | tamaño px; omitir = tamaño por CSS |
| `anchorOf?` | `(m) => [x, y]` | ancla px; default = centro del `sizeOf` |

### Declarativo

```html
<cristae-map>
  <cristae-html-layer id="hitos"></cristae-html-layer>
</cristae-map>
```
```js
document.getElementById('hitos').accessors = {
  idOf: h => h.id,
  positionOf: h => ({ lat: h.lat, lng: h.lng }),
  htmlOf: h => `<div class="badge">${h.letra}</div>`,   // o un heroicon SVG string
}
document.getElementById('hitos').data = hitos
```

### Imperativo

```js
const handle = engine.addHtmlLayer({ id: 'hitos', accessors, data })
handle.set(hitos)          // reconcilia por id
handle.setVisible(false)
```

`HtmlHandle`: `{ id, source, set(items), setVisible(v) }` — sólo **acciones**; posición/HTML son
estado (`positionOf`/`htmlOf`): para moverlos o recolorearlos se muta el item y se `set`/`patch`.

---

## Invariantes

- **GL-safe**: NO abre un contexto WebGL (contextos GL ∝ point/line-GL layers, no ∝ estos badges).
- **Sin dominio**: `htmlOf` es opaco; el core no sabe qué es un "hito" ni un "evento".
- **Posiciona por proyección**: la capa vive en su propio panel y cada marcador lleva un `translate3d`
  calculado con la cámara. El pan lo absorbe el panel (no reescribe nada); sólo un cambio de vista, de
  datos o de tamaño reubica nodos, y sólo escribe los que se movieron.
- **Zoom**: durante un zoom animado cada marcador viaja a su destino (lo calcula `zoomanim`) sin
  escalar su contenido; uno sin destino —pinch, `flyTo`, un salto sin animación— lo reubica en cada
  `move` hasta que la vista asienta. La capa nunca se esconde.
- **Foco por opacidad**: el foco atenúa el nodo, no lo reconstruye; sobrevive a los ticks de datos.
- **No captura el puntero**: la capa es transparente a él; el clic y el hover los resuelve por
  proximidad el motor de interacción.
- Picking `kind:'html'` por marcador más cercano al puntero (tolerancia px, crece con `sizeOf`).
- `anchorOf` fija qué punto del nodo cae sobre la posición; sin `anchorOf` ni `sizeOf` el nodo se centra.

## Deuda conocida

- **Reconciliación O(n)** en cada cambio del Source: reutiliza el nodo por id y reescribe sólo lo que
  cambió, pero recorre todos los marcadores; un patch por-marcador sería una optimización posterior.
- **O(n) nodos DOM**: por diseño es para baja/media cardinalidad. Para volumen, el point-layer GPU.
