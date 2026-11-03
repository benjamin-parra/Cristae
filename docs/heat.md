# Campo de calor — `addHeatLayer`, `<cristae-heat-layer>`

> Pieza de [Cristae](../MODELO.md). Densidad de puntos en un canvas 2D sobre la superficie del anfitrión:
> no abre un contexto WebGL. Consume un [Source](./data.md).

Cada punto estampa una brocha radial con un alpha chico proporcional a su peso. Donde los puntos se
agolpan, el alpha se acumula, y una segunda pasada lo traduce a color con una rampa. Es el equivalente de
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

- Cada redibujo estampa los puntos visibles, lee el framebuffer con `getImageData` y lo escribe
  colorizado. Es O(puntos visibles + píxeles del contenedor).
- Un cambio de la Source redibuja en el mismo frame en que llega, ya coalescido por la Source. Los
  eventos del mapa y los setters se agrupan en un rAF.
- El canvas va en px CSS, sin escalar por DPR: un campo difuso no lo necesita.
- `colorRamp` se muestrea 256 veces al cambiar. En React se compara por referencia, así que una función
  escrita en línea en el render rehace la paleta en cada render: conviene declararla fuera del componente
  o con `useCallback`.

## Límites

- `focus-ids` atenúa el pane entero: el calor no atenúa puntos sueltos.
- El campo no sigue el zoom animado: se oculta al empezar y reaparece al asentar.
- No se pica.
