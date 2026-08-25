# Render GL — PointLayer, Picking, shaders, proyección

> Pieza de [Cristae](../MODELO.md). Implementa [SPECS §13](../SPECS.md) (reglas del hot-path) y
> [MODELO §17 / §17.5](../MODELO.md) (los dos paths de render). Consume el [Atlas](./atlas.md) +
> [IconSet](./icons.md) (residencia GPU vía `GpuAtlasBinding`) y un [Source](./data.md).

`PointLayer` dibuja miles de puntos sobre WebGL apoyándose en `leaflet.glify`, pero **sustituye sus
shaders** por unos propios (atlas de iconos, rotación, picking por color) y le añade lo que glify no
tiene: un **path incremental [0-alloc]** para mover/recolorear un punto sin reconstruir el buffer.

---

## Los dos paths (la idea central)

glify solo sabe `setData(data)` → reconstruye todo el buffer interleaved: **O(n) con O(n) de
allocations**. Sirve para el alta/baja del set, pero pagar O(n) por mover un punto cada frame es
inviable a miles de updates/seg. Por eso `PointLayer` tiene **dos presupuestos** (SPECS §12-13):

| Path | Cuándo | Costo | Mecanismo |
|---|---|---|---|
| **rebuild** | el set cambió (`set`/filtro/cluster/regrow, o cambió el tamaño del snapshot) | O(n), aloca O(n) | `glify.setData` |
| **incremental** | el set NO cambió; solo se movieron/recolorearon ids con slot vigente | **O(1) por elemento, [0-alloc]** | escribir el slot del buffer con `bufferSubData` |

El `Source` ya coalesce los cambios a un rAF (vía el `Emitter`); `PointLayer` solo decide, en cada
flush, **cuál path** corresponde leyendo los acumuladores del Source (`moveDirtyIds`, `dirtyIds`).

---

## Por qué el path incremental es O(1) real (MODELO §17.5)

No es un fork ni un monkey-patch de glify. Se apoya en una invariante verificada de glify/Leaflet:

- `mapCenterPixels` se fija **una vez de por vida** de la capa (`base-gl-layer.ts:164`, nunca se
  recalcula). Por tanto el vértice de un punto es **función pura de su latLng** → se puede reescribir
  un vértice puntual sin tocar el resto.
- El layout del vértice es `[x, y, r, g, b, a, size]` (`bytes === 7`). `x,y` = posición proyectada;
  `r` = canal de tile (del Atlas); `g` = ángulo normalizado; `b,a` = índice local de picking
  (`local + 1`, 12 bits; el objeto y el chunk son uniform del draw); `size` = tamaño **signado** — la
  magnitud es el tamaño en px y el signo es el eje focus (ver *Foco por ítem*).
- **Mover** = reescribir `[x,y]` (2 floats). **Recolorear/patch** = reescribir los 7 floats del slot.
- `gl.bufferSubData(target, dstByteOffset, srcData, srcOffset, length)` (forma de 5 args de WebGL2)
  escribe un subrango **sin crear un `subarray`** → genuinamente **[0-alloc]**.

Para que sea [0-alloc] de verdad, la proyección debe ser inlineada: `map.project()` asigna
(`Point` + `LatLng`). En su lugar se usa `projX0/projY0` (EPSG:3857 a zoom 0, que glify ya exige):

```
projX0(lng) = 256 * (lng/360 + 0.5)
projY0(lat) = 256 * (0.5 − 0.25/π · ln((1+s)/(1−s))),  s = sin(clamp(lat, ±85.0511287798)·π/180)
```

`src/render/project.js` exporta `projX0`/`projY0`, verificadas para coincidir **exactamente** con
`map.project(latLng, 0)` de Leaflet.

### Dos invariantes que el path debe respetar
1. **Recapturar `typedVertices` + reconstruir `id→slot` tras cada rebuild.** glify reemplaza el
   `Float32Array` en cada `render()` (`points.ts:114`); el `WebGLBuffer` en cambio es estable. El
   método `#bind()` recaptura el array y el buffer, y re-emite `bufferData(..., DYNAMIC_DRAW)` (hint
   apto a updates puntuales) sobre el buffer capturado.
2. **`assert bytes === 7`.** Si glify cambiara el layout, fallar ruidoso en vez de corromper. El
   hover/click nativo de glify se apaga (`sensitivity: 0`): el path no usa `allLatLngLookup` (queda
   stale, no se lee); el picking lee el buffer, que sí está fresco.

---

## PointLayer

Construcción: `new PointLayer({ glify, map, pane, source, iconSet, interactive = false })`.
Se suscribe al `source` y reacciona en cada flush.

| Miembro | Tipo | Notas |
|---|---|---|
| `count` | getter | nº de puntos dibujados |
| `redraw()` | acción | fuerza un `redraw` de la capa glify |
| `applyFocus(ids, dim?)` | `(Set<id>\|null, number) → true` | eje focus por ítem: plenos los de `ids`, el resto a `dim` (`null` = sin foco). Ver *Foco por ítem* |
| `idForSlot(slot)` | `(number) → id` | traduce un hit de picking (slot) a id de dato |
| `requestHoverHit(cx, cy, meta)` | acción | encola un pick GPU no bloqueante (si `interactive`) |
| `collectHoverHit()` | `() → {slots, metadata}\|null` | recoge el resultado del pick encolado |
| `pickSync(cx, cy, meta)` | acción | pick síncrono (un solo punto) |
| `syncPickingSize()` | acción | reajusta el FBO de picking al tamaño del viewport |
| `destroy()` | acción | desuscribe, libera picking, binding y capa |

**Flujo de `#onChange` (por flush, ya coalescido):**
1. Sin capa aún, o el snapshot cambió de tamaño → **rebuild**.
2. Sin `source.itemById` (lookup O(1)) → rebuild seguro.
3. Drena `moveDirtyIds()` → `#writePosition` (2 floats) por id. Si un id no tiene slot → rebuild.
4. Drena `dirtyIds()` → `#writeSlot` (7 floats) por id. Si el Atlas cambió de identidad (regrow) →
   rebuild (re-encode total, porque cambió `C`).
5. Si el Atlas creció (append de variantes nuevas) → `binding.sync`. `redraw`.

Los acumuladores **no se limpian acá**: el `Source` los limpia al abrir la siguiente ventana de
flush, de modo que un 2º suscriptor (p. ej. una `LabelLayer`) vea el mismo set en este flush.

El **rebuild** reusa los arrays de instancia (`#positions`, `#meta`, `#idBySlot`) y trunca su
`length` (no `new Array`/`.map`/`.filter`) — sin allocations entre rebuilds salvo crecimiento del
set. Omite posiciones no finitas (§15.2) y ids duplicados (se queda con el primero).

---

## shaders.js

Tres fuentes GLSL, **genéricas por uniforms** (no literales horneados) → se compilan una vez y
**nunca recompilan**, ni en regrow:

- `POINT_VERTEX` — `gl_Position = matrix * vertex`, y parte el `size` en magnitud y bit:
  `gl_PointSize = abs(pointSize)`, `vAlpha = mix(uDim, 1.0, pleno)` y `gl_Position.z` en la banda que
  le toca (`pleno = step(0.0, pointSize)`).
- `POINT_FRAGMENT` — decodifica `tileIdx = floor(vColor.r · uMaxIndex + 0.5)`, ubica la celda con
  `uCols/uRows`, rota la UV por `vColor.g · 2π`, muestrea `uAtlas`, descarta `alpha < 0.01` y multiplica
  el alfa por `vAlpha`.
- `POINT_PICKING_FRAGMENT` — el MISMO cuerpo (una sola fuente, `discard` incluido) salvo la línea de
  salida: emite el id jerárquico sumándole el tag del draw (`uPickTag`). **No declara `vAlpha`** — el
  pick no depende del alfa de presentación — y el `abs` del vértice le deja al atenuado su silueta
  entera, así que sigue siendo pickeable.

Los uniforms `uCols/uRows/uTileSize/uMaxIndex` los setea el `GpuAtlasBinding` una vez por generación.

---

## Foco por ítem — el signo del `size`

El eje `focus-ids` / `setLayerFocus` (semántica de consumo en [`elements.md`](elements.md)) no tiene
canal propio: el `vec4` de color está lleno con tile, ángulo e id de picking. Se apoya en el **bit del
signo del `size`**, que nadie usaba porque un tamaño es siempre positivo: negativo = atenuado. Del signo
salen las dos cosas que el atenuado necesita, sin ampliar el vértice ni partir el draw:

| | Cómo | Efecto |
|---|---|---|
| **Alfa** | `vAlpha = mix(uDim, 1.0, pleno)` en el vértice; el fragment visual multiplica su salida por él | el atenuado pierde alfa en la proporción de `uDim`, que es un uniform: moverlo no escribe buffer |
| **Orden** | `gl_Position.z = (0.5 - pleno) * w` + `DEPTH_TEST`/`LEQUAL` | el pleno va a la banda de adelante: no queda velado por un atenuado que se dibuje después. Dentro de una banda (z igual) gana el último → la precedencia por slot queda intacta |

Consecuencias, que son el punto del diseño:

- **`#sizeFor` es el punto único** que devuelve el tamaño ya signado, así que cualquier rebuild ajeno
  (`set`/filtro/cluster/regrow) y cualquier patch incremental **reponen el atenuado solos**.
- `applyFocus` reescribe **sólo lo que cambió de estado**: `Set → Set'` por diferencia simétrica contra
  `#slot` (O(K+K′), sin recorrer el buffer); un cambio de sólo `dim` no toca ni un byte.
- La silueta ES la huella de z: el texel que el fragment descarta no escribe profundidad, así que el
  atenuado no tapa nada con su caja.
- Un id enfocado **sin slot** (clusterizado, filtrado, posición no finita) simplemente no existe en el
  buffer: no hay dónde pintar un fantasma.

Degradación: si el contexto no concede profundidad, el mismo camino dibuja sin `DEPTH_BUFFER_BIT` y el
orden vuelve al de slot — un flag, no un segundo camino.

---

## Picking (GPU, opcional — `interactive: true`)

`src/render/Picking.js` resuelve "¿qué punto está bajo el cursor?" **en GPU**, sin geometría en CPU:

- Un micro-FBO + `scissor` dibuja un **parche de 6×6 texeles** alrededor del cursor con el programa de
  picking (que emite el id por color). Su destino lleva **profundidad** y hereda el `DEPTH_TEST` de la
  capa: el pick devuelve **lo que se ve**, incluso si un atenuado se dibuja encima de un pleno.
- Lectura **no bloqueante** vía PBO + `fenceSync`/`clientWaitSync(0,0)`: `request()` encola,
  `collect()` recoge cuando el GPU terminó (sin frenar el hilo). `pickSync()` para el caso de un tiro.
- El id es **jerárquico** y entra en los 32 bits del píxel: objeto (14 bits) y chunk (6) por draw,
  índice local (12) por vértice con la convención `local + 1`. Los impactos se devuelven ordenados del
  texel más cercano al cursor hacia afuera (`PickHits`), que es la desambiguación entre vecinos.
- Comparte el **mismo buffer** que el render (no re-sube vértices) y el **mismo Atlas** vía un binding
  propio → el pick siempre ve la posición fresca escrita por el path incremental.

| Método | Notas |
|---|---|
| `request(cx, cy, batch, metadata)` | encola un pick (mailbox de un slot: un pedido nuevo pisa al pendiente); `true` si se encoló |
| `collect()` | `{ hits: PickHits, metadata }` o `null` si aún no está |
| `pickSync(cx, cy, batch, metadata)` | pick inmediato |
| `syncSize()` / `abort()` / `detach()` | lifecycle |

---

## Ejemplo de uso

```js
import { PointLayer } from './src/render/PointLayer.js'
import { defineIconSet } from './src/atlas/IconSet.js'
import { createSource } from './src/data/Source.js'
import glify from 'leaflet.glify'

const iconSet = defineIconSet({ /* describe + renderers, ver icons.md */ })
const source = createSource({
  idOf: v => v.id,
  positionOf: v => ({ lat: v.lat, lng: v.lng }),
  variantOf: v => v.estado,
})

const layer = new PointLayer({ glify, map, pane: 'overlayPane', source, iconSet, interactive: true })

// Alta del set → rebuild (O(n), una vez).
source.set([{ id: 1, lat: -33.4, lng: -70.6, estado: 'activo' }, /* … */])

// Mover un punto vivo → path incremental [0-alloc], sin reconstruir el buffer.
source.move(1, -33.41, -70.61)

// Picking bajo el cursor (no bloqueante).
layer.requestHoverHit(px, py, { /* meta */ })
const hit = layer.collectHoverHit()
if (hit) for (const slot of hit.slots) console.log('id bajo cursor:', layer.idForSlot(slot))
```
