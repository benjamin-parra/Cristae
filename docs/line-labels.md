# Texto sobre líneas

`<cristae-line-label-layer>` dibuja un texto que sigue el trazo de una línea: centrado, al inicio o
repetido a lo largo, con un desplazamiento perpendicular, y siempre derecho para quien lee. Es el
equivalente de `polyline.setText` de Leaflet.TextPath.

```html
<cristae-line-layer id="rutas"></cristae-line-layer>
<cristae-line-label-layer bind-to="rutas" repeat="200" offset="-6"></cristae-line-label-layer>
```

```js
document.querySelector('cristae-line-label-layer').textOf = ruta => ruta.nombre
```

Sin `textOf`, el texto es `String(idOf(item))`.

## Ligada o standalone

- **`bind-to`**: el id de una `<cristae-line-layer>`. Toma su Source, su `idOf` y su `pathOf`. Si la capa
  todavía no existe, queda pendiente y se liga cuando aparece. Un `bind-to` a una capa que no es de líneas
  también queda pendiente.
- **`source`** (y opcionalmente `accessors` con `idOf` y `pathOf`): standalone. Sin `accessors`, salen
  de la Source.

`textOf`, `source` y `accessors` se leen al montar. Una lambda nueva en cada render no redibuja.

## Estilo

| Clave | Atributo | Por defecto | Qué |
| --- | --- | --- | --- |
| `placement` | `placement` | `'center'` | `'center'` o `'start'`; con `repeat` no se usa |
| `repeat` | `repeat` | sin repetir | px entre los centros, finito y > 0 |
| `offset` | `offset` | `0` | px perpendiculares; positivo, a la izquierda del sentido de lectura |
| `orientation` | `orientation` | `'auto'` | `'auto'` se da vuelta para leerse derecho; `'path'` sigue el sentido del path |
| `maxAngle` | `max-angle` | `45` | grados en (0, 180); una colocación que gira más entre dos glifos se omite |
| `font`, `color`, `halo`, `haloWidth` | — | los de `<cristae-label-layer>` | pintura; `haloWidth: 0` apaga el halo |

Los atributos se mezclan sobre la prop `style`, y cualquier cambio se aplica en vivo, sin remontar. Un
atributo quitado devuelve su clave al valor por defecto. Un valor inválido lanza `TypeError` y deja el
estilo como estaba.

Imperativo:

```js
const texto = engine.addLineLabelLayer({ id: 'texto', bindTo: 'rutas', style: { repeat: 200 } })
texto.style({ offset: -6 })
texto.setVisible(false)
```

## Cómo se coloca

- `center` pone el centro del texto en la mitad del largo de cada parte; `start`, el comienzo en el
  inicio. Con `repeat`, los centros van en `repeat/2 + k·repeat` desde el inicio de cada parte.
- Una colocación que no cabe en su parte, que pisaría a la anterior o que gira más de `maxAngle` se
  omite. Nunca se dibuja desbordada ni ilegible.
- Con `'auto'`, cada colocación se lee de izquierda a derecha según la cuerda que va de su comienzo a su
  final; una vertical exacta se lee de arriba abajo. Dos repeticiones de una línea sinuosa pueden leerse
  en sentidos opuestos: cada una queda derecha.
- El `offset` se mide desde el sentido de lectura, así que con `offset` positivo el texto queda arriba
  para quien lee. En una línea que pasa por la vertical, el texto cambia de lado del trazo.
- Cada parte de una línea multi-parte se rotula por separado.

## Visibilidad, z e interacción

- La visibilidad es independiente de la del host: ocultar la línea no oculta su texto.
- Oculta, la capa no pinta: ni con los avisos de la Source ni al mover la vista.
- Sin `z`, queda sobre su host, en la banda de las etiquetas.
- No se pica: el click lo resuelve la capa de líneas.

## Límites

- **Geodésica:** bajo `<cristae-geodesic>` el texto sigue los vértices de `pathOf`, la cuerda en
  Mercator, y no la curva dibujada. En una línea larga queda lejos del trazo.
- **RTL y ligaduras:** se coloca glifo por glifo, así que el árabe pierde las ligaduras y el hebreo sale
  invertido. Sólo se garantiza texto LTR sin ligaduras.
- **Colisión:** no hay. Con muchas líneas superpuestas, los textos se pisan.
- **Append en vivo:** cada aviso de la Source redibuja todas las líneas, a lo más una vez por frame.
- **Baja del host:** la capa queda ligada a la Source del host dado de baja, y un host nuevo con el mismo
  id no se vuelve a ligar. Es el comportamiento de `<cristae-label-layer>`.
- **Fuentes web:** se remide una vez, al resolverse `document.fonts.ready`. Una fuente que carga después
  conserva los anchos de la de reemplazo hasta que cambie `font`.
