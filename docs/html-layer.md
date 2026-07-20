# Marcadores HTML — `HtmlLayer`, `<cristae-html-layer>`

> Pieza de [Cristae](../MODELO.md). `L.divIcon` sobre Leaflet — **GL-safe** (no abre otro contexto
> WebGL). Consume un [Source](./data.md). Complementa el [point-layer GPU](./render.md), no lo reemplaza.

El point-layer rasteriza sprites a un atlas GPU (canvas) — perfecto para **miles** de marcadores en
tiempo real, pero **no rinde HTML arbitrario** (un heroicon SVG, un glifo de fuente FontAwesome, una
letra con CSS). Para eso está `HtmlLayer`: monta `L.divIcon` con el HTML del consumidor. Su nicho son
los **badges de dominio de baja/media cardinalidad** (inicio/fin, evento, parada) que hoy los
consumidores dibujan a mano abriendo `getLeafletMap()` — justo la fuente de esa deuda.

**Regla**: pocos marcadores con HTML rico → `html-layer`. Muchos / tiempo real → `point-layer` GPU.

---

## API

### Accessors (`HtmlAccessors`)

| Accessor | Tipo | Rol |
|---|---|---|
| `idOf` | `(m) => number` | id numérico |
| `positionOf` | `(m) => { lat, lng }` | posición del marcador |
| `htmlOf` | `(m) => string` | HTML del icono (heroicon SVG, `<i class="fv-*">`, letra, …) |
| `classNameOf?` | `(m) => string` | clase del `divIcon` (default `cristae-html-marker`) |
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
handle.set(hitos)          // rebuild
handle.setVisible(false)
```

`HtmlHandle`: `{ id, source, set(items), setVisible(v) }` — sólo **acciones**; posición/HTML son
estado (`positionOf`/`htmlOf`): para moverlos o recolorearlos se muta el item y se `set`/`patch`.

---

## Invariantes

- **GL-safe**: NO abre un contexto WebGL (contextos GL ∝ point/line-GL layers, no ∝ estos badges).
- **Sin dominio**: `htmlOf` es opaco; el core no sabe qué es un "hito" ni un "evento".
- **Leaflet reproyecta** los marcadores en pan/zoom (no van a `#glLayers`).
- Picking `kind:'html'` por marcador más cercano al puntero (tolerancia px).

## Deuda conocida

- **Rebuild O(n)** en cada cambio del Source (como el line-layer MVP); el patch por-marcador (mover
  sólo los sucios con `marker.setLatLng`) es una optimización posterior.
- **O(n) nodos DOM**: por diseño es para baja/media cardinalidad. Para volumen, el point-layer GPU.
