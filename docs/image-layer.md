# Capa de imagen

Pone una imagen georreferenciada sobre el mapa, como `L.imageOverlay`. Es un nodo DOM en un pane propio, no
gasta un contexto WebGL y queda bajo las etiquetas y los marcadores HTML.

```js
engine.addImageLayer({ id: 'radar', url: 'radar.png', bounds: { south: -34, west: -72, north: -32, east: -70 }, opacity: 0.7 })
```

## Fuente y lugar

- **Fuente:** `url`, o `image`, que es un nodo propio (`<img>`, `<canvas>`, `<video>` o `<svg>`). Cubre
  `VideoOverlay` y `SVGOverlay` de Leaflet. Pasar las dos, o ninguna, lanza `TypeError`.
- **Lugar:** `bounds`, la caja de la API, o `corners`, cuatro puntos en el orden nw, ne, se, sw, en cualquier
  forma de punto. Con `corners` la imagen se rota o se deforma. Pasar las dos, o ninguna, lanza `TypeError`.
- **Lanzan `TypeError`** en el alta, en `setBounds` y en `setCorners`, sin tocar lo que se ve:
  - un número no finito;
  - `south > north`;
  - un cuadrilátero sin área, cóncavo o en moño.

  Las esquinas en sentido inverso dan la imagen espejada, que es válida.
- **Antimeridiano:**
  - con `bounds`, si `west > east` se suma 360 al este;
  - con `corners`, cada longitud queda a ±180 de la anterior.
- **Proyección:**
  - la imagen se estira sobre la caja proyectada en Mercator, como en Leaflet;
  - una imagen en EPSG:4326 queda deformada en latitud, porque no se reproyecta;
  - pasado ±85,0511 de latitud, la imagen se aplasta en el borde.

## Handle

`{ id, setUrl, setImage, setBounds, setCorners, setOpacity, setVisible }`.

- `setUrl` y `setImage` se reemplazan entre sí.
- Con `setUrl`, la imagen vigente sigue a la vista hasta que carga la nueva, y el `load` de una URL descartada
  no se aplica.
- `setOpacity` acota a [0, 1].
- `setBounds` y `setCorners` devuelven la caja nueva.
- La capa expone `bounds`, así que `camera.fitToLayer(id)` la encuadra.

## Carga

- La imagen de `url` nace oculta y aparece en `load`, que llama a `onLoad({ url })`.
- En `error` queda oculta y se llama a `onError({ url })`.
- Un `destroy` durante la carga suelta los oyentes, y ninguno de los dos corre.
- Los dos callbacks corren aislados: si uno lanza, la capa no se rompe.
- Con `crossOrigin` y un servidor sin CORS, la imagen no carga.
- Un nodo propio no emite `load` ni `error`.
- **El nodo propio, mientras está en la capa:**
  - la capa lo cuelga de su envoltorio;
  - le toma `display`, `width`, `height`, `maxWidth`, `maxHeight` y `objectFit`, y se los devuelve al soltarlo;
  - sale del lugar del documento donde estaba.

  Un `<svg>` que no debe conservar su proporción lleva `preserveAspectRatio="none"`.

## Interacción y foco

- Sin `interactive`, el arrastre y los clicks pasan al mapa.
- Con `interactive`, el click dentro del cuadrilátero llega por el bus de la capa como
  `{ kind: 'image', id, ref: id, distancePx: 0 }`.
- `focus-ids` atenúa el pane entero.

## Elemento

```html
<cristae-image-layer id="radar" url="radar.png" bounds='{"south":-34,"west":-72,"north":-32,"east":-70}' opacity="0.7"></cristae-image-layer>
```

- **Atributos:** `url`, `bounds` (JSON), `opacity`, `interactive`, `visible`, `cross-origin` y `alt`.
- **Props:** `image` y `corners`. Si se dan los dos de un par, mandan `image` y `corners`.
- **Montaje:** espera a tener una fuente y un lugar.
- **En vivo:** `url`, `image`, `bounds`, `corners`, `opacity` y `visible`.
- **Al montar:** `interactive`, `cross-origin` y `alt`.
- **Eventos:** `cristae:load` y `cristae:error`, con `bubbles` y `composed`. En React son `onLoad` y `onError`.
- **Composición:** no se envuelve en ningún modificador (R2).

## Zoom animado

Con `zoom-animation` activo, la transición CSS de un `matrix3d` puede hacer ondular un cuadrilátero rotado
durante 250 ms. Con la política por defecto, `'none'`, no hay transición.
