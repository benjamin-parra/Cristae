# Capa de geometría editable en GPU — diseño

Cinco agentes sobre piezas disjuntas de la arquitectura, con la propuesta del líder como
hipótesis a instrumentar: render en GPU, traspaso a DOM de ≤3 handles bajo el cursor,
chunking con picking jerárquico, y relleno sin triangulación.

59 decisiones · 47 pasos · 49 riesgos

## Parámetros fijados — fuente única de verdad

Las áreas se diseñaron en paralelo y llegaron con dos nociones distintas de «chunk». Esto lo resuelve.
Cualquier número que aparezca más abajo y contradiga esta tabla está superado por ella.

| Parámetro | Valor | Consecuencia |
| --- | --- | --- |
| Destino de picking | `RGBA8` (sin gemelo ESSL3) | `obj + chunk` comparten 16 bits: es la restricción que ata todo lo demás |
| Reparto `A:B` | **14 / 2** | 16.384 objetos · 4 chunks |
| Índice local `R:G` | 16 bits | 65.536 **entradas** por chunk |
| Entrelazado | par = vértice · impar = midpoint | ⇒ 32.768 **vértices** por chunk |
| **C (capacidad de chunk)** | **32.768 vértices — el máximo** | Forzado por el reparto: con C=512 el techo caería a 2.048 vértices/objeto |
| **Techo por objeto** | **131.072 vértices** | `4 chunks × 32.768` |

La relación es `vértices por objeto = 2^bits_de_chunk × C`, así que **el tamaño de chunk no se elige
por separado del reparto de bits**: más bits de chunk dan más capacidad *y* chunks más chicos (e
inserciones más baratas), a costa de objetos. 14/2 privilegia generalidad de objetos.

Qué cuesta C al máximo: insertar o borrar un vértice desplaza media hoja ⇒ memmove acotado de
~256 KB. **No toca el arrastre**, que es O(1) (una escritura de un texel) independientemente de C —
el costo de C sólo aparece en ediciones estructurales, que ocurren a ritmo humano y no por frame.

Alternativa registrada por si un caso tensa el techo: **12 / 4** con C = 8.192 ⇒ 4.096 objetos ×
524.288 vértices, con inserciones de ~64 KB.

## Decisiones de diseño

### picking-jerarquico

#### Reparto de los 32 bits del píxel: A=objeto (8b, 1..255), B=chunk (8b, 0..255), R:G=índice LOCAL del vértice dentro del chunk (16b, valor almacenado = local+1). El objeto viaja en ALPHA y es a la vez el flag de "hay hit": obj 0 es el único significado de «nada», y coincide exactamente con el clear (0,0,0,0).

**Por qué.** Hoy `#decode` ya usa alpha como flag binario (`if (buf[i+3] === 0) continue`) y el fragment escribe alpha 1.0 fijo. Poner el objeto ahí no consume un bit extra: fusiona el flag con el dato, el guard existente sobrevive VERBATIM y desaparece la pregunta "¿qué combinación es nada?" — nada = alpha 0 = objeto 0, imposible de confundir con un objeto real porque los ids arrancan en 1. Además el clear es (0,0,0,0) con BLEND deshabilitado sobre un RGBA8 propio, así que el alpha se escribe literal (no premultiplicado) y el 0 es exacto. El id local conserva la convención `slot+1` de hoy, así que `id 0` dentro de un hit ya no es "reservado sin uso": significa «toqué el objeto pero no un vértice» (cuerpo del trazo / relleno) — la discriminación exacta que necesita la capa editable, gratis.

**Forma.**

Layout del píxel de picking (RGBA8):
  R = 8b  índice local HI   ← atributo  vColor.b   (por vértice)
  G = 8b  índice local LO   ← atributo  vColor.a   (por vértice)
  B = 8b  chunk  0..255     ← uniform   uPickTag.y (por draw)
  A = 8b  objeto 1..255     ← uniform   uPickTag.x (por draw)  0 = NADA
Capacidad: 255 objetos simultáneos × 256 chunks × 65.535 vértices = 16.776.960 vértices por objeto.
Packing por vértice (CPU, sin cambio respecto de hoy): `const id = local + 1`, `b = (id >> 8) / 255`, `a = (id & 255) / 255`.
Decode: `obj = buf[i+3]` · `chunk = buf[i+2]` · `slot = ((buf[i] << 8) | buf[i+1]) - 1`  (slot -1 = objeto sin vértice).

**Alternativa descartada.** Un bit de "hit" separado + objeto en 7 bits: gasta un bit, obliga a enmascarar en el decode y deja representable el estado inconsistente (hit=1, obj=0). También descartado reservar chunk 0: no hace falta, alpha ya desambigua, y forzar chunks 1-based ensucia la aritmética `local = global - chunkFirst`.

#### Objeto y chunk viajan como UNIFORM por draw call (`uniform highp vec2 uPickTag`), no como atributo por vértice. El índice local del vértice se queda donde YA está: los canales b,a del atributo `color` de glify. Cero cambios al layout de vértice (bytes=7).

**Por qué.** (1) ESPACIO: el layout de glify no tiene canal libre — r=tile, g=ángulo, b,a=id. Meter obj+chunk como atributo obliga a un segundo buffer + un `vertexAttribPointer` propio, y hoy el pase de picking NO bindea nada: hereda gratis el pointer que dejó montado glify (ése es el invariante que hace que un solo `bufferSubData` actualice visual y picking a la vez). El uniform cuesta 0 bytes por vértice y 0 cambios de layout. (2) COHERENCIA CON EL CHUNKING: el chunk ya ES la unidad de draw (rango acotado de `bufferSubData` + culling por bbox); si es un draw, su id es constante en el draw ⇒ es un uniform por definición. Como atributo habría que reescribirlo en cada vértice al renumerar un chunk, que es justo lo que el chunking existe para evitar. (3) ANCHO ÚTIL: con obj+chunk afuera, los 16 bits por vértice quedan ÍNTEGROS para el índice local — que es exactamente lo que el layout provee. Cualquier reparto que le dé al vértice ≠16 bits obliga a aritmética de empaquetado dentro del fragment en mediump, o a un atributo extra. (4) NEGOCIABILIDAD: el reparto obj/chunk vive SÓLO en el packer JS (dos bytes de un uniform); pasar de 8/8 a 4/12 o a 6/2+kind no toca una línea de GLSL, porque el shader escribe dos bytes opacos.

**Forma.**

En el fragment de picking (shaders.js):
  `uniform highp vec2 uPickTag;`  → `gl_FragColor = vec4(vColor.b, vColor.a, uPickTag.y, uPickTag.x);`
En `#begin`, por cada draw del batch: `gl.uniform2f(prog.uTag, draw.obj / 255, draw.chunk / 255)` (`uniform2f`, no `uniform2fv`: sin array intermedio, [0-alloc]).
El reparto de los 16 bits del tag es una constante JS. Reparto por defecto recomendado: obj(8)|chunk(8). Variante si hace falta distinguir handle/segmento/relleno del MISMO objeto: `A = obj(8)`, `B = kind(2)|chunk(6)` ⇒ 64 chunks × 65.535 = 4,19 M vértices por objeto y por kind — igualmente absurdo de alcanzar. El cambio es de dos líneas en el packer y dos en el decoder.
Precisión: en ESSL1 el calificador por variable es legal; `highp` en fragment está garantizado bajo un contexto WebGL2 (ES 3.0 lo exige). Con mediump el margen ya alcanzaría (ULP≈0,00098 vs paso 1/255=0,0039 ⇒ error ≤0,25 al multiplicar por 255, el round sigue exacto — es el mismo argumento que hace funcionar hoy los 16 bits en b,a), pero `highp` en el tag saca el tema de la mesa por 0 costo: el pase dibuja un puñado de puntos sobre 36 texeles.

**Alternativa descartada.** Atributo por vértice de 24 bits (obj+chunk+vtx) en un buffer aparte: +3 B/vértice mínimo (o +12 B a float), un `vertexAttribPointer` propio que rompe la herencia del pointer de glify, y renumeración masiva al reordenar. También descartado empaquetar chunk dentro de los 16 bits del vértice (ej. chunk 4b + local 12b): reduce el chunk a 4.096 vértices Y obliga a `floor/mod` en el fragment sobre un varying mediump — dos precios por nada.

#### `#decode` recorre el parche en orden CENTRO-HACIA-AFUERA (tabla precalculada por distancia al texel del cursor) y vuelca a un contenedor `PickHits` REUSADO, no a un `Set` nuevo. `hits[0]` es siempre el impacto más cercano al cursor.

**Por qué.** Hoy el decode devuelve un `Set` sin orden: con dos handles a 4 px (denso, normal en un recorrido editable) el consumidor no puede saber cuál está bajo el cursor y el resultado depende del orden de escaneo del buffer — eso es exactamente el "frágil en casos límite" que el requisito prohíbe. El parche de 6×6 actúa como dilatación de ±3 px de TODA silueta (es lo que da tolerancia de hover), así que ambigüedad de vecinos no es un caso raro: es el caso normal. El orden centro-afuera la resuelve de forma determinista y sin costo (36 índices, tabla estática). El contenedor reusado saca la asignación por pick de una ruta que corre en cada mousemove.

**Forma.**

```js
const ORDER = (() => {
  const idx = new Uint8Array(PATCH * PATCH)
  for (let i = 0; i < idx.length; i++) idx[i] = i
  const d = i => { const c = (i % PATCH) - HALF, r = ((i / PATCH) | 0) - HALF; return c * c + r * r }
  return idx.sort((a, b) => d(a) - d(b))
})()

class PickHits {
  objects = new Uint8Array(PATCH * PATCH)   // 1..255
  chunks  = new Uint8Array(PATCH * PATCH)   // 0..255
  slots   = new Int32Array(PATCH * PATCH)   // local; -1 = objeto sin vértice
  count   = 0
}
```
`#decode()` → `PickHits` (misma instancia siempre; válida hasta el próximo `collect()`/`pickSync()`). Sin dedup: con 36 entradas el consumidor toma el PRIMERO que le sirve; recorrer en orden ya es "el más cercano gana".
Índice global del vértice, del lado del consumidor: `global = chunkFirst[chunk] + slot`.
API de conveniencia sugerida: `firstOf(obj)` y `firstOf(obj, chunk)` — barrido lineal sobre ≤36, más barato que cualquier estructura.

**Alternativa descartada.** Seguir con `new Set()` por pick: pierde la distancia (dato que el buffer YA tiene), asigna en ruta caliente y obliga al consumidor a re-derivar la cercanía que se tiró. Descartado también dedupear: no aporta —el consumidor corta en el primer match— y el dedup destruiría el orden.

#### El destino de picking pasa de textura full-res + renderbuffer de profundidad a un ÚNICO renderbuffer RGBA8 de 6×6, sin depth. El offset del parche se absorbe con `gl.viewport(-ox, -oy, w, h)` — traslación del viewport, MANTENIENDO el tamaño (w,h) — y NO tocando la matriz de proyección. `syncSize()` queda como no-op.

**Por qué.** Ahorro exacto (color RGBA8 + depth16, drawingBuffer = CSS×DPR):
 · 1440×900 DPR1 → 5.184.000 + 2.592.000 = 7.776.000 B → 144 B  (−7,78 MB)
 · 1920×1080 DPR2 (3840×2160) → 33.177.600 + 16.588.800 = 49.766.400 B → 144 B  (−49,77 MB, factor 345.600×)
 · 2560×1440 DPR2 (5120×2880) → 58.982.400 + 29.491.200 = 88.473.600 B → 144 B  (−88,47 MB)
Y es piso: muchos drivers materializan DEPTH_COMPONENT16 como D24S8 (4 B/px), así que el depth real puede ser el doble. El depth es desperdicio puro y verificable: `#begin` nunca hace `gl.enable(gl.DEPTH_TEST)` y sólo dibuja `gl.POINTS`; nadie escribe ni lee profundidad.
El offset va por VIEWPORT y no por matriz porque un escalado de la proyección al recuadro 6×6 ACHICARÍA EL VOLUMEN DE CLIP, y en GL ES un punto se descarta entero si su CENTRO cae fuera del volumen de clip: un sprite de 40 px centrado a 15 px del cursor —que hoy sí cubre el píxel del cursor y sí se puede pickear— desaparecería. Sería una regresión silenciosa del picking pixel-perfect. La traslación del viewport no toca el volumen de clip (el clip lo define la matriz), conserva la escala NDC→píxel (y por lo tanto la semántica de `gl_PointSize`, que va en píxeles) y reproduce EXACTAMENTE la semántica de hoy: lo que hoy recorta el scissor, mañana lo recorta el borde del framebuffer.
Usar RENDERBUFFER en vez de textura para el color elimina de raíz el peligro que documenta el propio `#createFbo` (dejar la textura del FBO bindeada en TEXTURE0 y que el siguiente draw de glify salga en blanco): un renderbuffer no se puede bindear a una unidad de textura, y `readPixels` funciona igual desde un FBO con attachment de renderbuffer.

**Forma.**

```js
#createTarget() {
  const gl = this.#gl
  const prevRbo = gl.getParameter(gl.RENDERBUFFER_BINDING)
  const prevFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING)
  const old = this.#target
  if (old) { gl.deleteFramebuffer(old.framebuffer); gl.deleteRenderbuffer(old.color) }
  const color = gl.createRenderbuffer()
  gl.bindRenderbuffer(gl.RENDERBUFFER, color)
  gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, PATCH, PATCH)
  const framebuffer = gl.createFramebuffer()
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, color)
  gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo)
  gl.bindRenderbuffer(gl.RENDERBUFFER, prevRbo)
  this.#target = { framebuffer, color }
}

#begin(cx, cy, batch) {
  const gl = this.#gl
  const h  = gl.drawingBufferHeight
  const ox = Math.round(cx) - HALF                 // sin clamp: el borde ya no es caso especial
  const oy = (h - Math.round(cy)) - HALF
  gl.bindFramebuffer(gl.FRAMEBUFFER, this.#target.framebuffer)
  gl.viewport(-ox, -oy, gl.drawingBufferWidth, h)  // traslación pura: mismo clip, misma escala
  gl.disable(gl.BLEND)
  gl.clearColor(0, 0, 0, 0)
  gl.clear(gl.COLOR_BUFFER_BIT)
  … draws …
}
```
Desaparecen: `gl.enable/disable(SCISSOR_TEST)` + `gl.scissor(...)` (el framebuffer ES el parche), el clamping `sw = min(PATCH, w - sx)`, y los campos `sw/sh` de `#inFlight` (ahora constantes). `#buf` y el PBO quedan fijos en `PATCH*PATCH*4 = 144 B`. `readPixels(0, 0, PATCH, PATCH, …)` siempre.
Efecto colateral BUENO: el cursor cae SIEMPRE en el texel (col 3, fila 3) — índice de byte 84 — incluso pegado al borde del canvas, donde hoy el `Math.max(0, …)` descentra el parche y rompe la simetría de la tolerancia.
Qué se rompe: (a) `syncSize()` deja de tener trabajo — se conserva la firma (MapEngine la llama en resize) y pasa a `return` inmediato: se elimina la recreación de ~50 MB por evento de resize, que hoy ocurre al colapsar el sidebar o al mover la ventana entre monitores con distinto DPR; (b) se pierde la posibilidad teórica de un pick de área grande (lazo/rubber-band) contra el FBO completo — hoy nadie lo hace; si se necesitara, `#createTarget(size)` puede crecer bajo demanda para ese pase puntual; (c) `detach()` deja de borrar `depth`.

**Alternativa descartada.** Absorber el offset en la matriz con escala al recuadro 6×6: mata el picking pixel-perfect de sprites (clip por centro de punto). Descartada también la textura como attachment de color: obliga a guardar/restaurar `TEXTURE_BINDING_2D` y reintroduce el riesgo de dejarla bindeada; nadie la muestrea. Y descartado achicar sólo el depth: el depth se elimina, no se achica.

#### Plan B verificable si algún driver maltrata el viewport de origen negativo: matriz con traslación PURA en clip space (nunca escala), sobre un `Float32Array(16)` preasignado. Se elige por autodiagnóstico en `attach()`, no por configuración.

**Por qué.** El viewport negativo es legal por spec (sólo width/height están acotados por MAX_VIEWPORT_DIMS) y ANGLE lo maneja, pero no puedo verificarlo sin correrlo en las GPUs reales del parque. La traslación pura da la MISMA propiedad crítica que el viewport: no achica el volumen de clip (sólo lo desplaza medio pantallazo), así que los sprites vecinos siguen sobreviviendo al clip por centro. Con un `Float32Array` reusado sigue siendo [0-alloc].

**Forma.**

```js
// matriz' = T(tx,ty) ∘ matriz, con la proyección afín de glify (m[15] = 1, w_clip = 1)
const tx = -2 * (ox) / w, ty = -2 * (oy) / h        // ox,oy = origen del parche en píxeles de dispositivo
this.#m.set(matrix); this.#m[12] += tx; this.#m[13] += ty
gl.viewport(0, 0, w, h)
```
Autodiagnóstico en `attach()` (una vez, ~0,2 ms): dibujar un punto sintético en una posición conocida contra las dos rutas y comparar el píxel; si la ruta viewport no devuelve el id esperado, fijar `#offsetMode = 'matrix'`. Queda registrado en un getter `offsetMode` para diagnóstico.

**Alternativa descartada.** Dejar el FBO full-res "por las dudas": el costo (7,8–88,5 MB + churn de resize) no se paga por una duda que un self-test de 0,2 ms resuelve.

#### `request`/`pickSync` reciben un BATCH de draws en vez de `(count, matrix)`, y `Picking` pasa a ser un planificador de pases: registro de programas por clave + descriptores `PickDraw` propiedad de cada capa, mutados in place. Un solo clear, N draws, un `readPixels`.

**Por qué.** Es lo que hace posible que la jerarquía entre en UN píxel y UN pase: sin multi-draw, el nivel "objeto" no tiene para qué existir (con un solo draw por pick el objeto es implícito). Con multi-draw, un pick resuelve simultáneamente flota + handles + segmentos + varios objetos editables. Además el chunk-como-uniform EXIGE un draw por chunk, así que el batch no es un lujo: es la forma del problema. Y habilita el culling: sólo entran al batch los chunks cuyo bbox intersecta el parche, con lo cual el pase de pick deja de ser O(N total) —hoy `drawArrays(POINTS, 0, count)` recorre TODA la capa en cada mousemove— y pasa a ser O(vértices de 1–2 chunks). Sin orden de profundidad (no hay DEPTH_TEST), el último draw gana el píxel: el batch se emite de abajo hacia arriba en z y los handles van últimos, con lo que "el handle gana sobre el trazo y sobre la flota" sale del orden, sin mecanismo extra.

**Forma.**

```js
/** @typedef {{ key: string, bind: () => void, texture: WebGLTexture|null,
 *              mode: GLenum, first: number, count: number,
 *              obj: number, chunk: number }} PickDraw */
/** @typedef {{ draws: PickDraw[], length: number, matrix: Float32Array }} PickBatch */

registerProgram(key, { vertexSource, fragmentSource, visualProgram, attribs }) → WebGLProgram
attach(gl, visualProgram, atlasTexture) → WebGLProgram   // registra la clave 'point' (compatibilidad)
request(cx, cy, batch, metadata) → boolean
pickSync(cx, cy, batch, metadata) → { hits: PickHits, metadata } | null
collect() → { hits: PickHits, metadata } | null
abort() ; syncSize() /* no-op */ ; detach()
get pending() ; get busy()
```
`bind` es una función de identidad ESTABLE que la capa registra una vez (deja buffer + `vertexAttribPointer` + `enableVertexAttribArray` listos). La capa de puntos actual pasa un `bind` que NO hace nada: sigue heredando el pointer de glify, tal cual hoy.
En `#begin`, por draw: `if (draw.obj === 0) continue` (assert en dev) → `useProgram` si cambió → `bind()` → `bindTexture` si cambió → `uniformMatrix4fv` si cambió el programa → `uniform2f(uTag, obj/255, chunk/255)` → `drawArrays(draw.mode, draw.first, draw.count)`.
El batch lo posee y recicla el consumidor (nunca se crea por pick). El `PickDraw` de un chunk se muta cambiando `first/count/chunk`.

**Alternativa descartada.** Un pase (y un `readPixels`) por capa: multiplica la latencia por N capas y desperdicia el hallazgo de que b y a estaban libres — el objetivo explícito era un píxel, una lectura, un pase. Descartado también resolver el orden con DEPTH_TEST: exigiría de vuelta el depth que estamos sacando, para reproducir algo que el orden de emisión ya da.

#### Coalescing por MAILBOX de un solo slot: `request` nunca vuelve a rechazar por ocupado — si hay un pick en vuelo, el pedido nuevo PISA al pendiente (mutación in place) y se dispara en el mismo punto donde hoy se libera `#inFlight`, dentro de `collect()`. Cero rAF, cero timers. `abort()` pasa a significar invalidación completa: cancela el vuelo Y vacía el mailbox.

**Por qué.** Hoy `request` devuelve false y se PIERDE el pedido: con el cursor en movimiento se descartan picks y el hover queda en la posición vieja hasta que el usuario frena. El mailbox conserva SIEMPRE el último, que es el único que importa. Se descartó abortar-y-reemplazar (matar el vuelo y disparar el nuevo) porque con el cursor moviéndose a cada frame nunca terminaría ninguno: inanición garantizada, justo el tipo de fragilidad que el requisito prohíbe. Con el mailbox el régimen permanente entrega un resultado por completación, siempre con las coordenadas más recientes al momento de emitir. El disparo va en el punto exacto donde hoy se hace `this.#inFlight = null`: no hace falta ningún reloj nuevo, el pipeline ya tiene ese evento.

**Forma.**

Estados: IDLE (`!#inFlight && !#queued.active`) · FLIGHT · FLIGHT+QUEUED.
```js
#queued = { active: false, cx: 0, cy: 0, batch: null, metadata: null }   // reusado, nunca reasignado

request(cx, cy, batch, metadata) {
  if (!this.#gl) return false
  if (this.#inFlight) {
    const q = this.#queued
    q.active = true; q.cx = cx; q.cy = cy; q.batch = batch; q.metadata = metadata
    return true
  }
  return this.#issue(cx, cy, batch, metadata)
}
```
Transiciones:
 · `collect()` en IDLE → null
 · fence TIMEOUT_EXPIRED → null, sigue FLIGHT (no se toca el mailbox)
 · fence listo → **1)** `getBufferSubData` PBO→`#buf`, **2)** `#inFlight = null`, **3)** `#decode()`, **4)** `#flush()`, **5)** devolver el resultado
 · fence WAIT_FAILED → `#inFlight = null`, `#flush()`, devolver null  ← indispensable: si no se vacía acá, un fence perdido deja el mailbox trabado para siempre
 · `abort()` → `deleteSync` si hay, `#inFlight = null`, `#queued.active = false` → IDLE
 · `#flush()` → si `!q.active` return; `q.active = false`; `#issue(q.cx, q.cy, q.batch, q.metadata)`; si `#issue` devuelve false (degenerado) queda IDLE, no re-encolado
🔴 ORDEN OBLIGATORIO dentro de `collect()`: el `getBufferSubData` va ANTES del `#flush()`, porque el pedido nuevo hace `readPixels` sobre EL MISMO PBO y pisaría los bytes que todavía no se copiaron.
Contrato del `batch`: se guarda por referencia; la capa lo mantiene válido y actualizado hasta el flush (es deseable que refleje el estado más nuevo). Si la capa reconstruye sus descriptores, debe llamar `abort()`.
Se agrega `get busy() { return !!this.#inFlight || this.#queued.active }` para que el consumidor sepa cuándo dejar de pollear: con mailbox, resolver el ÚLTIMO hover puede requerir dos `collect()`.

**Alternativa descartada.** Abortar el vuelo y disparar el nuevo (inanición con el cursor en movimiento, más `readPixels` encadenados sobre un PBO con lectura pendiente = posible stall implícito). Descartada una cola de N pedidos: sólo el último tiene valor; una cola introduce latencia acumulada y resultados obsoletos. Descartado un rAF/timer que drene el mailbox: prohibido por requisito, y además innecesario — el evento de liberación ya existe.

#### El picking del vértice SIGUE siendo pixel-perfect heredando el `discard` por silueta: el handle se dibuja como point sprite del mismo atlas y usa el MISMO cuerpo de fragment. No necesita otra silueta. La factory de shaders se extiende con un parámetro `decls` (declaraciones extra) para que el cuerpo siga siendo UNA sola fuente compartida entre visual y picking.

**Por qué.** El cuerpo del fragment (muestreo del atlas + `if (tex.a < 0.01) discard;`) precede a `${outColor}`, así que cualquier variante generada por la factory hereda el recorte por alpha del tile. Como el handle es un sprite convexo y centrado, la silueta ES el área de agarre exacta. El parche de 6×6 dilata esa silueta ±3 px de dispositivo, lo que da la tolerancia de hover que el usuario espera sin agrandar el dibujo. La condición para que NO sea frágil no está en el shader sino en el TILE: con umbral 0,01 cualquier halo/sombra suave del alpha cuenta como impacto, y un handle con sombra de 4 px tendría un área de agarre 4 px más grande de lo que se ve. Con el orden centro-afuera eso no produce un bug (siempre gana el más cercano al cursor), sólo generosidad; por eso alcanza con una restricción de arte y no hace falta maquinaria nueva.

**Forma.**

Requisito del tile del handle: el canal alpha es la SILUETA DURA del handle (anillo + relleno). Sombra/glow: horneada en RGB, o alpha ≤ 2 px de expansión. Sin esa restricción el agarre se infla.
Escape hatch listo, si algún handle termina con halo ancho — `uniform float uPickCutoff` seteado por draw (`gl.uniform1f(prog.uCutoff, draw.cutoff ?? 0.01)`), con el umbral pasado a la factory como parámetro para que el cuerpo siga siendo una sola cadena:
```js
const fragment = (outColor, cutoff = '0.01', decls = '') => `…\n${decls}\nvoid main() { … if (tex.a < ${cutoff}) discard; ${outColor} }`
```
Con `cutoff = 0.5` el agarre se recorta al núcleo opaco, a propósito. NO se activa en el paso 1: es una divergencia deliberada entre silueta visual y silueta de pick, y sólo se paga si el arte lo obliga.
Orden dentro del batch (el último gana el píxel): relleno → segmentos → handles.

**Alternativa descartada.** Un shader de picking propio para handles con silueta analítica (círculo por `length(gl_PointCoord - 0.5)`): duplica la definición de la forma en dos lugares (tile y GLSL) y garantiza que se desincronicen al primer rediseño del handle; además pierde la propiedad de que un solo `bufferSubData` actualice visual y pick de forma consistente.

#### Los 3 vértices traspasados a DOM se apagan del pase GPU cambiando su tile a uno TRANSPARENTE, no bajando `gl_PointSize` ni poniendo su id en 0.

**Por qué.** El `discard` por silueta elimina el fragmento de las DOS salidas a la vez (visual y picking) con una sola escritura, así que el handle desaparece de la pantalla y del picking de forma consistente y atómica — imposible que queden desincronizados. Un `pointSize = 0` puede rasterizar 1 píxel en algunos drivers (fantasma pickeable invisible), y poner el id en 0 lo dejaría visible y encima seguiría tapando el segmento de abajo con su tag de objeto. Es el mismo mecanismo que ya sostiene el picking pixel-perfect, haciendo doble trabajo.

**Forma.**

Al activar el vértice v: escribir el canal r (tile) de v, v−1 y v+1 al índice de un tile 100 % transparente del atlas, con UN `bufferSubData` del rango [v−1, v+1] (3 vértices contiguos, 84 B). Al desactivar, restaurar el tile del handle con el mismo rango.
Requisito de correspondencia: el nodo DOM debe aparecer en la MISMA vuelta en que se escribe el tile transparente, en la posición que proyecta glify — si no, hay un frame con el handle ausente. Ver dependencia con el área de traspaso a DOM.

**Alternativa descartada.** Sacar los 3 vértices del rango del draw (`first/count`) — sólo funciona si están en el borde del chunk; en el medio partiría el chunk en dos draws por cada hover.

#### Draws con `obj === 0` se OMITEN en `#begin`, con assert en desarrollo.

**Por qué.** Si un consumidor olvida asignar el id de objeto, el uniform vale 0 por defecto, el alpha sale 0 y TODOS los picks de esa capa se leen como "nada": falla total y silenciosa, del tipo más caro de diagnosticar. Omitir el draw hace que la regla "obj 0 = nada" sea una sola, coherente en encode y decode, y convierte el olvido en un síntoma localizado (esa capa no responde) en vez de un misterio global.

**Forma.**

En el bucle de draws: `if (draw.obj === 0) continue`. En dev, `console.warn` una vez por clave de programa. Los ids 1..255 los asigna un free-list en el registro de capas de pick del motor (ver dependencias).

**Alternativa descartada.** Clampear a 1: enmascara el bug y colisiona con el objeto 1 legítimo.

#### OPCIONAL (requiere OK del líder por cambiar la tolerancia actual): dimensionar el parche en píxeles CSS y no en píxeles de dispositivo — `PATCH = clamp(round(7 * DPR), 6, 16)`, con `#buf` y PBO dimensionados al máximo (16·16·4 = 1024 B) y la tabla ORDER recalculada al cambiar el DPR.

**Por qué.** `#begin` interpreta `cx,cy` en píxeles de DISPOSITIVO (usa `drawingBufferHeight` para el flip), así que el parche fijo de 6 da 6 px de tolerancia a DPR 1 pero sólo 3 px CSS a DPR 2: en una pantalla HiDPI el hover es literalmente la mitad de tolerante, y eso se nota justo al agarrar handles chicos. Antes esto no se podía arreglar sin pagar memoria y ancho de lectura; con el micro-target el costo de agrandar el parche es despreciable (1 KB en el peor caso), así que la asimetría deja de tener excusa.

**Forma.**

`PATCH` pasa de constante de módulo a campo `#patch` fijado en `attach()`/`syncSize()` desde `devicePixelRatio`; `HALF = #patch >> 1`; `#buf = new Uint8Array(16*16*4)` una vez y se usan los primeros `#patch²·4` bytes; `ORDER` se recalcula sólo cuando cambia `#patch` (evento de DPR, no por frame). El PBO se crea al tamaño máximo.

**Alternativa descartada.** Dejar 6 fijo: barato, correcto, y sigue siendo el default si el líder prefiere no mover la sensación de hover existente.

### chunking — modelo de chunks y edición en tiempo constante de la geometría editable

#### El arena ES el modelo: `ChunkedPath` reemplaza a los arrays de pares como ALMACENAMIENTO de polygon/polyline. `#geom` pasa de `{rings:[[...pares]]}` / `{path:[...pares]}` a `{rings:[ChunkedPath]}` / `{path:ChunkedPath}`. `point` y `rectangle` NO entran al arena.

**Por qué.** Hoy hay UNA sola verdad y de ahí sale la corrección del drag: `#buildPath(coords)` guarda en `rec.coords` la MISMA referencia que `#geom.rings[i]`, y por eso `rec.coords[i] = toPair(ll)` en `#onVertexDrag` muta la geometría real sin copiar. Si el arena fuera un espejo del array, esa identidad se rompe y hay que sincronizar dos verdades por frame — exactamente el hazard que los hallazgos documentan para el backend de PUNTOS (glify regenera `typedVertices` desde `data`, y sin el espejo al día un re-render revierte los writes incrementales). Con el arena como verdad ese hazard no existe porque no hay array que quede atrás. Serializar sigue siendo un walk O(N) con N alocaciones de par, que es EXACTAMENTE lo que ya cuesta `#serialize` con `r.map(clonePair)`: el contrato no se encarece. `point` (1 marcador) y `rectangle` (4) no tienen problema de escala y se quedan tal cual — meterlos al arena sería complejidad sin beneficio.

**Forma.**

const path = new ChunkedPath({ id, closed, capacityHint })
// lectura
path.count            // vértices vivos, O(1) — reemplaza `rec.coords.length` del guard MIN_VERTICES
path.closed           // el `closed` de #buildPath
path.rev              // monótono: sube con CUALQUIER escritura  → es el hashOf de la Source de trazos
path.structRev        // sube SOLO con insert/remove/split/merge/grow → sella los picks en vuelo
path.vertexAt(slot, out)      // escribe [lat,lng] en un portador reusado — 0-alloc
path.prevVertex(slot) → slot|-1     // cruza chunks por la lista enlazada, O(1)
path.nextVertex(slot) → slot|-1
path.midSlot(slot) → slot + 1
path.forEachVertex(fn)              // walk en orden de trazo (serialización)
// escritura
path.move(slot, lat, lng)
path.insertAfter(vertexSlot, lat, lng) → slot
path.remove(vertexSlot) → bool
path.append(lat, lng) → slot
path.pop() → bool                   // el `coords.pop()` del cierre por dblclick
path.setClosed(bool)
path.reset(pairs)                   // ingest, O(N)
path.dirty                          // { n, chunks:Int32Array(8), lo:Uint16Array(8), hi:Uint16Array(8) }
path.clearDirty()

**Alternativa descartada.** Mantener `coords` como verdad y espejar al buffer. Dos verdades ⇒ o se sincroniza por frame (O(N), mata la propuesta) o se desincronizan (el bug que los hallazgos ya documentan para PUNTOS).

#### Chunk = 1024 ENTRADAS (512 vértices). El índice de chunk es la posición en el arena (`k = slot >> 10`), NO el orden en el trazo: el orden lo lleva una lista doblemente enlazada `next/prev`. Los chunks liberados vuelven a una free-list encadenada por `next`.

**Por qué.** 512 vértices por chunk acota el peor caso por operación a un memmove de ~9 KB (8 KB de `xy` float64 + 1 KB de `role`) más un `bufferSubData` de ≤12 KB — del orden del microsegundo, y sobre todo INDEPENDIENTE de N. Y 2^24 entradas / 1024 = 16.384 chunks por objeto, que es justo el presupuesto de bits (ver la decisión de picking). Desacoplar el índice de chunk del orden del trazo es lo que hace posible el tiempo constante: si el arena tuviera que quedar en orden, insertar en el medio obligaría a correr todo lo que sigue (O(N)); con la lista enlazada, insertar un chunk es escribir dos punteros.

**Forma.**

const CHUNK = {
  entradas:  1024,   // C — potencia de 2 ⇒ k = slot >> 10, offset = slot & 1023
  vertices:   512,   // V = C/2 (cada vértice va con su midpoint, ver entrelazado)
  fill:       256,   // objetivo al ingerir/append: medio chunk, deja holgura para insertar
  minVertices:256,   // = V/2 · por debajo se hace borrow o merge
}
// SoA por chunk, arrays paralelos indexados por k:
first: Uint16Array   // offset del run vivo dentro del chunk (siempre PAR)
used : Uint16Array   // entradas vivas del run (siempre PAR)
next : Int32Array    // -1 = fin · también encadena la free-list
prev : Int32Array
head, tail, freeHead

#### Entrelazado vértice/midpoint dentro del chunk: entrada PAR = vértice, entrada IMPAR = el midpoint del segmento que ARRANCA en ese vértice. En un path abierto el midpoint del último vértice existe pero queda `role = 0` (invisible), así `used` es siempre par y `first` siempre par.

**Por qué.** Disuelve la pregunta de los bordes: como cada vértice es DUEÑO del midpoint del segmento que empieza en él, NINGÚN segmento queda partido entre dos chunks. El único acceso cruzado es leer `first` del chunk siguiente para recalcular el midpoint del último vértice del chunk (y el del cierre del anillo, que apunta a `head.first`) — O(1) por la lista. Además cada operación toca UN solo rango contiguo (vértice y midpoint viajan pegados) en vez de dos bandas separadas, y regala el desempate del picking: los dos pases se dibujan sobre el MISMO buffer con offset 0 y offset 1 entrada, stride 2 entradas, y el pase de VÉRTICES va segundo — sin DEPTH_TEST gana la última escritura, así que en una geometría degenerada (vértices coincidentes) el vértice le gana a su propio midpoint sin código de desempate. La entrada desperdiciada del path abierto (una sola en todo el trazo) compra que toda la aritmética sea uniforme y sin casos especiales.

**Forma.**

run de un chunk:  [ V0 M0 V1 M1 V2 M2 … ]   desde `first`, `used` entradas
role: 0 libre · 1 vértice · 2 midpoint · 3 dom-activo (el shader lo descarta: lo dibuja el DOM)

data VBO  = 12 B/entrada  [x:f32, y:f32, role:f32]
  pase MIDPOINTS: stride 24 B, offset 12 B, count = entradasAsignadas/2   ← se dibuja PRIMERO
  pase VÉRTICES : stride 24 B, offset  0 B, count = entradasAsignadas/2   ← se dibuja SEGUNDO
slot VBO  =  4 B/entrada  [slot:f32]  · mismos offsets/stride
⇒ DOS drawArrays por objeto y por frame, sea N=3 o N=400.000

**Alternativa descartada.** (a) Banda separada de midpoints (`k*2C + C + j`): dos rangos por operación y dos flushes. (b) Ghost del primer vértice del chunk siguiente para que el aliasing cubra la costura: obliga a mantener una COPIA sincronizada de un vértice ajeno — una segunda verdad, justo lo que se está eliminando.

#### Run contiguo con `first` flotante dentro del chunk; insertar/borrar desplaza el LADO MÁS CORTO. Disciplina de hoja B-tree: relleno objetivo C/2 al ingerir, SPLIT a la mitad al desbordar, BORROW del vecino más gordo o MERGE cuando `used` cae por debajo de C/2.

**Por qué.** `first` flotante absorbe inserciones tanto en cabeza como en cola sin partir el chunk, y desplazar el lado corto acota el memmove a C/2 entradas en el caso típico y a C en el peor. El merge NO es opcional: sin él, borrar uno de cada dos vértices a lo largo de todo el trazo deja N chunks casi vacíos y el arena dibujado explota a N·C entradas — el requisito dice explícitamente que no puede ser frágil. Con minVertices = V/2 y la regla borrow-o-merge (si el vecino tiene más de V/2 se le pide una pareja vértice+midpoint; si no, la suma de ambos es ≤ V y caben en uno) la ocupación queda garantizada ≥ 50%, o sea entradas asignadas ≤ 2·(2N) + C, y el costo por operación sigue acotado por O(C).

**Forma.**

insertar en el chunk k:
  cabe (used+2 ≤ C) ⇒ si (m - first) < (first+used - m): copyWithin hacia la IZQUIERDA el tramo [first, m]  (requiere first ≥ 2)
                       si no                            : copyWithin hacia la DERECHA  el tramo (m, first+used) (requiere first+used+2 ≤ C)
                       (si el lado elegido no tiene aire, el otro SIEMPRE lo tiene porque used+2 ≤ C)
  no cabe          ⇒ split: chunk j de la free-list, se mueve la mitad alta del run (corte en frontera PAR),
                     relink k↔j, y se reintenta el insert en la mitad que contiene al vértice
borrar en el chunk k:
  quita 2 entradas, desplaza el lado corto
  used < C/2 ⇒ borrow(vecino con used > C/2) o merge(vecino) + relink + chunk a la free-list

**Alternativa descartada.** Sin merge, liberando sólo el chunk que queda vacío: más simple y suficiente para el uso típico (los borrados son raros), pero la geometría adversaria «borrar uno de cada dos» degrada el arena a N chunks de 1 vértice. Descartado por el requisito de no-fragilidad.

#### Las cuatro operaciones, con su rango de buffer. Ninguna recorre el trazo: todas leen `first/used/next/prev` del chunk implicado y a lo sumo de un vecino.

**Por qué.** El costo no depende de N porque (i) el vértice se localiza por aritmética sobre el slot (`k = slot>>10`), no por búsqueda; (ii) el vecindario {v-1, v, v+1} se resuelve por la lista enlazada, y como todo chunk vivo tiene ≥ 256 vértices (salvo un chunk único), el vecindario abarca a lo sumo DOS chunks; (iii) el único desplazamiento posible está acotado por C, que es constante; (iv) el midpoint afectado por un movimiento es siempre uno propio y uno del vértice anterior, nunca una cadena.

**Forma.**

MOVER(slot, lat, lng)
  escribe xy[2s], xy[2s+1] · recalcula el midpoint propio (s+1) y el del vértice previo (prevVertex(s)+1)
  ⇒ 3 entradas escritas, ≤2 chunks sucios · NO desplaza nada · los slots quedan intactos ⇒ el nodo DOM
    bajo el dedo conserva su identidad durante todo el gesto
INSERTAR(midSlot)                       // el pick de un midpoint; v = midSlot - 1
  hueco de 2 entradas tras midSlot (lado corto) · escribe el vértice nuevo = midpoint(v, next(v))
  recalcula los 2 midpoints que lo rodean · desborde ⇒ split
  ⇒ ≤ C entradas de copyWithin en xy y en role, 1 chunk sucio (2 si hubo split) · count++
BORRAR(slot)
  guard: count > (MIN_VERTICES[kind] ?? 1)   // hoy `rec.coords.length`, ahora un contador O(1)
  quita 2 entradas (lado corto) · recalcula el midpoint del vértice previo · borrow/merge si used < C/2
  ⇒ ≤ C entradas, ≤2 chunks sucios · count--
APPEND(lat, lng)                        // handleMapClick en modo draw
  dedup `samePoint(last, p)` leyendo la cola en O(1) · escribe 2 entradas en first+used del chunk cola
  recalcula el midpoint del que era último · cola llena ⇒ chunk de la free-list (first=0, used=2)
  free-list vacía ⇒ grow por duplicación (amortizado O(1)) + reescritura de slot[] + re-bind
  ⇒ 3 entradas, 1 chunk sucio
POP()                                   // el `coords.pop()` del cierre por dblclick: inverso del append, O(1)
setClosed(b)                            // el midpoint del último vértice cambia de role 0 ↔ 2, O(1)

#### El slot es POSICIONAL (posición en el arena), nunca ordinal en el trazo. Todo pick se sella con `structRev` y se descarta si cambió entre el request y la lectura.

**Por qué.** Si el slot fuera el ordinal del trazo, insertar en el medio obligaría a renumerar todo lo que sigue: O(N). Como es posicional, insertar sólo renumera lo que se desplazó dentro de UN chunk. La contracara es que un split/merge migra slots ajenos — y el picking es ASÍNCRONO (difiere con PBO + fenceSync, hallazgo verificado), así que un slot leído puede referirse a una entrada que ya migró. El sello lo resuelve sin sincronizar nada: `structRev` sólo sube en insert/remove/split/merge/grow, que son gestos DISCRETOS del usuario, así que el descarte cae siempre en un frame en el que el usuario acaba de hacer otra cosa — es invisible. Durante un drag `structRev` no se mueve (mover no desplaza), así que el gesto continuo nunca pierde un pick.

**Forma.**

pick.request({ x, y, seal: path.structRev })
// al leer:  seal === path.structRev ? resolver(objectId, slot) : descartar()
// + candado estructural: mientras hay un drag activo, insert/remove/split/merge/grow se RECHAZAN.
//   Las únicas fuentes de esas ops son gestos mutuamente excluyentes y `setValue`; `setValue`
//   durante un drag lo aborta (suelta los nodos DOM y re-ingiere) — mismo comportamiento observable
//   que hoy, donde el `clearLayers()` de #rebuild destruye el marcador en pleno gesto.

#### Empaquetado de picking en UNA tabla: `code = objectId·2^24 + slot`, con objectId ∈ [1..255] en el canal a y slot de 24 bits repartido en b,g,r. El shader NO conoce el chunk: la jerarquía objeto/chunk/vértice se completa en CPU con `k = slot >> 10`, `offset = slot & 1023`.

**Por qué.** Cuatro razones, la primera dura: (1) el atributo por vértice es un FLOAT y float32 sólo representa enteros exactos hasta 2^24 — un id de 32 bits en un atributo float es incorrecto por encima de 16,7 M; con el slot de exactamente 24 bits el límite del formato COINCIDE con el límite del presupuesto, no hay zona silenciosamente rota. (2) GLSL ES 1.00 no tiene operadores de bits: extraer tres bytes de UN valor es división/floor exacta sobre enteros pequeños; recomponer cuatro campos heterogéneos es aritmética frágil. (3) El objectId es constante por draw ⇒ va como UNIFORME: no ocupa atributo, no ocupa memoria, y no hay que reescribirlo nunca. (4) Como el chunk se deriva del slot en CPU, cambiar C es cambiar una constante — no toca shaders ni el formato del FBO. El reparto sigue siendo el de la propuesta en total (255 objetos × 16,7 M entradas por objeto) y sigue entrando en UN píxel, UN readPixels y UN pase; sólo cambia dónde se corta la jerarquía.

**Forma.**

const PICK_BITS = { object: 8, slot: 24 }     // única tabla; el resto del código la lee
  a = objectId            // 1..255 · el 0 NO se asigna ⇒ el píxel (0,0,0,0) del clear sigue siendo MISS
  b = floor(slot / 65536)
  g = floor(slot / 256) mod 256
  r = slot mod 256
// fragment (sin operadores de bits, seguro en GLSL ES 1.00; para gl.POINTS el varying es constante
// sobre la primitiva, así que empaquetar en el vertex shader e interpolar es exacto):
//   float b2 = floor(s / 65536.0);
//   float b1 = floor((s - b2*65536.0) / 256.0);
//   float b0 =  s - b2*65536.0 - b1*256.0;
//   gl_FragColor = vec4(b0, b1, b2, uObject) / 255.0;
// decode → { objectId, slot } → { chunk: slot >> 10, offset: slot & 1023, esVertice: (slot & 1) === 0 }
// capacidades: 255 anillos/paths editables a la vez · 16.384 chunks y 8.388.608 vértices por anillo

**Alternativa descartada.** El reparto literal a=objeto / b=chunk / rg=vértice-en-chunk: obliga al shader a conocer C (cambiar el tamaño de chunk pasa a ser un cambio de shader), necesita ensamblar tres campos con aritmética de floats sin operadores de bits, y el atributo por vértice tendría que llevar chunk y offset por separado o un id de 32 bits que float32 no representa.

#### El buffer de slots NO se entrelaza con el dato: `slot[i] = i` en un VBO aparte, escrito UNA sola vez al crecer y nunca más.

**Por qué.** Como el slot ES la posición, cualquier `copyWithin` que lo arrastrara lo dejaría mintiendo (el slot de una entrada movida debe ser su NUEVA posición, no la vieja). Sacarlo del interleave lo vuelve estructuralmente inmune a los desplazamientos: insertar, borrar, partir y fusionar no lo tocan jamás. En WebGL2 se puede eliminar por completo usando `gl_VertexID` (ahorra 6,4 MB de VBO a 400.000 vértices).

**Forma.**

data VBO [x,y,role] — se desplaza con las ediciones
slot VBO [slot]     — estático; se reescribe SÓLO en grow, junto con el re-bind

#### Sin espejo float32 persistente. La verdad es `xy: Float64Array` y la conversión a float32 se hace en el flush, sobre un staging REUSADO de C entradas.

**Por qué.** Elimina por construcción el hazard que los hallazgos documentan (un espejo CPU que queda atrás y revierte los writes incrementales): no hay espejo que olvidar. El float64 además es lo que hace exacto el round-trip `setValue(v) → getValue()`, que hoy se cumple porque `#geom` guarda los números originales de JS — con sólo float32 se perdería ~1,2e-5 grados y el contrato de input controlado se rompería en silencio. Y como el rango de flush está acotado por C por construcción, un staging fijo de 1024 entradas alcanza SIEMPRE, incluso en el split (que sube dos rangos, uno por chunk). Ahorra además 12,8 MB a 400.000 vértices.

**Forma.**

xy    : Float64Array(entradas * 2)   // [lat, lng] canónico — se desplaza con copyWithin
role  : Uint8Array(entradas)         // se desplaza con copyWithin
staging: Float32Array(CHUNK.entradas * 3)   // único, reusado, 0-alloc
flush(): por cada chunk sucio → convertir [lo,hi) al staging → gl.bufferSubData(k*C*12 + lo*12, …)
         WebGL2: bufferSubData(target, dstByteOffset, staging, 0, (hi-lo)*3)  → 0-alloc
         WebGL1: staging.subarray(0, (hi-lo)*3)                               → 1 vista por rango (≤3/frame)
// memoria a N=400.000 vértices: xy 25,6 MB + role 1,6 MB + slot 6,4 MB ≈ 34 MB
// (mismo orden que los ~50 MB que hoy desperdicia el FBO de picking para leer 144 bytes)

#### Los VÉRTICES no cuelgan de una Source; los TRAZOS sí. Un ítem por anillo/path sobre `createSource` tal cual, con `hashOf = ring.rev`.

**Por qué.** Verificado en Store.js: `patch(items, dirtyIds)` NO llama a `#rebuildBaseIndex()` — reutiliza el `ix.base` construido en la última `update()` y hace `items[ix.base.get(id)]`. Es decir, patch exige que el array de ítems conserve LARGO y ORDEN; un id nuevo simplemente se saltea con `continue`. Traducido: con un ítem por vértice, patch puede expresar MOVER pero jamás INSERTAR ni BORRAR, y esas dos tendrían que ir por `set()` → `update()` → `#scan` completo (un `hashOf` por vértice) + `#rebuildBaseIndex` + `#hardRegenerate` con refiltrado: O(N) por inserción, que es exactamente lo que la propuesta viene a matar. Encima el bookkeeping por ítem del Store (hashes, versions, dirtyIds, ix.base, ix.parent, ix.self, parentMembers, selfMembers — 3 Maps y 2 Sets tecleados por id) cuesta más memoria que el vértice que describe. A nivel TRAZO nada de eso pasa: N son unidades (anillos), el array de ítems es estable, `hashOf = r => r.rev` hace que cualquier edición de vértice sea `patch(items, {ringId})` en O(1), y el alta/baja de un anillo va por `set()` con un costo O(#anillos). Además así la geometría editable se consume con el MISMO contrato que todo lo demás del motor, y hereda gratis la disciplina de la ventana de flush: los Sets `structs`/`moves` no se reasignan nunca, sólo `clear()/add()`, y sólo se limpian al abrir la ventana siguiente tras un emit.

**Forma.**

const source = createSource({
  idOf:   r => r.id,
  hashOf: r => r.rev,        // el contador del ChunkedPath ⇒ #scanOne lo ve sucio
  pathOf: r => r.cursor,     // vista perezosa sobre el arena (ver dependencia con la capa de línea)
})
// ítem de trazo: { id, rev, structRev, closed, cursor, arena }   ← objeto MUTADO in place
// el array de ítems es el MISMO siempre: nunca cambia de largo ni de orden salvo alta/baja de anillo
edición de vértice → path.rev++ ; source.patch(items, dirtyRing)   // dirtyRing: Set reusado, 1 id
alta/baja de anillo → source.set(items)                            // O(#anillos)

**Alternativa descartada.** Un ítem por vértice (la lectura ingenua de «todo cuelga de una Source»). Da MOVER en O(1) por el override, pero INSERTAR y BORRAR caen en `update()` O(N) y el bookkeeping por id domina la memoria. Descartado por medición del código, no por gusto.

#### Cero timers y cero rAF propios: las operaciones marcan chunks sucios y notifican; el `bufferSubData` se descarga en el render de la capa, y la coalescencia por frame la hace el Emitter que la Source ya tiene (`interval: 0, defer: 'raf'`). Corolario: el vértice activo en DOM lleva `role = 3` y el shader lo descarta.

**Por qué.** Es el requisito literal, y además ya está resuelto aguas arriba: `createSource` construye el Emitter con defer rAF, así que N operaciones en un tick colapsan en un emit con todos sus ids. Poner un rAF nuestro encima sería el rAF doble que el requisito prohíbe, y un intervalo sería peor. La supresión del sprite GPU del vértice activo es lo que hace que el único frame de latencia del pipeline sea imperceptible: el handle bajo el dedo lo dibuja el DOM (Leaflet lo mueve en el mismo evento), y lo que llega un frame después son los midpoints vecinos — que además es justo el instante en que el trazo se parte visualmente en dos tramos alrededor del vértice activo.

**Forma.**

op → path.rev++ · marcarSucio(k, lo, hi) · source.patch(items, dirty)
                                              ↓ (Emitter, defer raf, interval 0 — ya existente)
                                          layer.render() → flush() → drawArrays ×2
// nada más. Ni setTimeout, ni requestAnimationFrame, ni doble rAF, ni polling de fences fuera del
// ciclo de render que el motor ya conduce.

#### `setValue(value)` gana un guard de identidad: si `value === #lastEmitted`, es no-op. No se toca nada más de su contrato.

**Por qué.** `setValue` sigue sin emitir `onChange` (la asimetría que es el corazón del input controlado se mantiene intacta: `#emit`/`#commit` son la vía del USUARIO, `#touch(ring)` es la vía del RENDER, y setValue sólo usa la segunda). Pero hoy `setValue` hace `#ingest` + `#rebuild`, o sea O(N) y `clearLayers()`. Un consumidor controlado de verdad (React con `value` + `onChange={setValue}`) devuelve el mismo valor que acaba de emitir el drag, así que reconstruiría el arena entero POR FRAME y — peor — destruiría el marcador bajo el dedo en pleno gesto, rompiendo el drag. El guard cuesta una comparación de referencia, es invisible (el estado resultante sería idéntico) y convierte el editor en un input controlado que de verdad funciona.

**Forma.**

setValue(value) {
  if (value === this.#lastEmitted) return     // el mundo está devolviendo NUESTRO valor: nada cambió
  this.#geom = this.#ingest(value)            // ingest → path.reset(pairs), O(N), un solo bufferData
  this.#drawAnchor = null
  this.#resolveActive()                       // ex #rebuild
}
// #emit() { const v = this.#serialize(); this.#lastEmitted = v; this.#onChange?.(v) }

**Alternativa descartada.** Comparación estructural del valor entrante (largo + muestreo): O(N) y adivinatoria. Si el consumidor CLONA el valor (immer, structuredClone) el guard de identidad no pega y se paga el O(N) — igual que hoy; se documenta, no se disfraza.

#### `#settle()` conserva su contrato (emitir + commitear + re-resolver handles) pero su cuerpo pasa de `clearLayers()` + 2N−1 marcadores a re-resolver la vecindad activa: como máximo 3 nodos DOM, en O(1).

**Por qué.** `#settle` existe porque «los índices corrieron» tras una edición discreta. Con slots posicionales lo único que puede haber corrido es la vecindad del vértice tocado (o los slots que migró un split/merge), y el conjunto activo son a lo sumo tres nodos — así que re-resolver es leer `prevVertex`/`nextVertex` y reposicionar. El nombre y el orden de efectos se conservan para que el resto de la máquina (drag emite live y sólo commitea al soltar; edición discreta emite+commitea+re-resuelve) no cambie en nada observable.

**Forma.**

#settle() { this.#emit(); this.#commit(); this.#resolveActive() }
#resolveActive() {
  const s = this.#activeSlot
  if (s < 0) return this.#releaseDom()
  const p = this.#path, prev = p.prevVertex(s), next = p.nextVertex(s)
  this.#placeDom(prev, s, next)     // ≤3 L.marker reposicionados, nunca recreados
  p.setRole(s, 3); prev >= 0 && p.setRole(prev, 3); next >= 0 && p.setRole(next, 3)
}
// máquina: IDLE → HOVER(slot) [el pick materializa ≤3 nodos] → DRAG(slot) [candado estructural]
//          → drop → HOVER → (salir) → IDLE [libera los nodos, role vuelve a 1]

#### El único O(N) que queda en el frame de drag es `#serialize()` dentro de `#emit()`, y es del contrato. Se ofrece `emitLive` como opción aditiva, con el default idéntico a hoy.

**Por qué.** Honestidad: `onChange` recibe el VALOR completo, así que emitirlo por frame de drag es O(N) con N alocaciones de par, hoy y después. El arena hace O(1) el trabajo de buffer, DOM y GPU; no puede hacer O(1) una función cuyo contrato es entregar N pares. A 400 vértices es irrelevante (es lo que ya pasa). A 100.000 pasa a ser el costo dominante del gesto, y ahí la salida correcta es que el consumidor use `onCommit` — que se invoca una vez por gesto, no por frame.

**Forma.**

new EditableGeometry({ …, emitLive: true })   // default: comportamiento actual, sin cambios
// emitLive:false ⇒ durante el drag no se llama onChange; onCommit sigue disparando en dragend
//                  y en cada edición discreta, con el valor completo.

**Alternativa descartada.** Reusar el array de salida entre emisiones (0-alloc). Rompe React (misma referencia ⇒ no re-renderiza) y le regala al consumidor una referencia que mutamos por debajo. Descartado.

### relleno-stencil

#### VIABLE, pero SÓLO con contexto WebGL propio: uno por instancia de mapa, creado perezosamente y jamás recreado. No se puede 'ascender' el contexto de glify.

**Por qué.** El stencil del framebuffer POR DEFECTO se decide en `getContext(...,{stencil:true})` y no se puede habilitar después; volver a llamar `getContext` sobre el MISMO canvas devuelve el MISMO contexto e IGNORA los atributos nuevos. glify fija sus propios atributos (no pide stencil) y es su canvas. Alternativa dentro del contexto de glify sería un FBO con DEPTH_STENCIL, pero eso reintroduce exactamente el defecto ya documentado del FBO de Picking (~33 MB color + ~17 MB depth para leer 144 bytes) y además obliga a componer dentro del render de glify. El costo real es +1 contexto POR MAPA (no por polígono ni por sesión de edición): el fill es UNA capa que atiende a TODOS los polígonos editables. Contra el presupuesto de ~16 del navegador es un +1 acotado y contable. Además `PolygonLayer` HOY no tiene contexto GL alguno (es `L.polygon` + `L.layerGroup`, picking CPU), así que no hay contexto existente que reusar por ese lado.

**Forma.**

`new StencilFill({ L, map, pane, antialias = true })` crea `canvas` + `gl = canvas.getContext('webgl2', { stencil: true, depth: false, alpha: true, premultipliedAlpha: false, preserveDrawingBuffer: false, antialias })`. Creación DIFERIDA al primer `attach()`. `destroy()` llama explícitamente `gl.getExtension('WEBGL_lose_context')?.loseContext()` — es la única vía fiable de devolver el contexto (el `removeLayer` del motor no lo libera; defecto conocido). Aparcado de memoria sin perder el contexto: cuando no hay objetos visibles, `canvas.width = canvas.height = 1` libera el drawing buffer y conserva el contexto (cero rotación de presupuesto); se restaura en el siguiente `#resizeIfNeeded()`.

**Alternativa descartada.** (a) FBO con DEPTH_STENCIL dentro del contexto de glify — repite el defecto de memoria de Picking y obliga a intervenir el render de glify. (b) 'INVERT por blending' sin stencil: `blendFunc(ONE_MINUS_DST_COLOR, ZERO)` con src=1 da `1-dst`, o sea una inversión de canal de color, y emula par-impar sin stencil; pero necesita un FBO R8 propio (≈8 MB en WebGL2, ≈33 MB en WebGL1 sin R8) MÁS un pase de composición inyectado en el pipeline de glify. Queda como Plan B documentado si el presupuesto de contextos resulta bloqueante, no como plan A.

#### Renderizado SIN NINGÚN VERTEX BUFFER: abanico generado en la GPU con `gl_VertexID` + `texelFetch` sobre una textura RG32F de posiciones. Los dos pases son attributeless.

**Por qué.** Mover un vértice pasa a ser UN `texSubImage2D` de 1×1 texel (8 bytes) — O(1) verdadero, sin expansión ni índice. Con buffer expandido (3n vértices) el mismo movimiento son 2 `bufferSubData` (el vértice aparece como esquina 2 de la arista k−1 y esquina 1 de la arista k) y 24 B/vértice de memoria, 3× redundante. Una textura de 4096×4096 texels da 16,7 M de vértices por objeto — el MISMO techo que el reparto de bits del picking jerárquico (a=objeto, b=chunk, rg=vértice), lo cual deja los dos subsistemas dimensionados igual sin coordinación extra.

**Forma.**

Textura `u_verts` RG32F, ancho W potencia de dos (2048 ⇒ 4,19 M vértices; 4096 ⇒ 16,7 M). Índice→texel: `ivec2(i & (W-1), i >> log2W)`. VS del pase 1: `int e = gl_VertexID/3, c = gl_VertexID%3; int k = c==1 ? e : (e+1==u_ringCount ? 0 : e+1); vec2 p = c==0 ? vec2(0.0) : texelFetch(u_verts, texel(u_ringStart+k), 0).xy; gl_Position = vec4((u_matrix*vec3(p,1.0)).xy, 0.0, 1.0);`. Draw: `drawArrays(TRIANGLES, 0, 3*ringCount)` — un draw por anillo (o por chunk). Pase 2: `drawArrays(TRIANGLE_STRIP, 0, 4)` con las esquinas derivadas de `u_rect` y `gl_VertexID`. Archivos nuevos: `src/render/StencilFill.js` + `src/render/stencil-shaders.js` (espejo de `src/render/shaders.js`).

**Alternativa descartada.** Buffer expandido de 3n vértices + `a_corner` estático (camino WebGL1). Se conserva DOCUMENTADO como fallback si el proyecto no acepta exigir WebGL2 en esta capa: mismo O(1) por movimiento (2 escrituras de 8 B), 24 B/vértice, y sin `texelFetch`. Descartado como principal por la memoria 3× y porque exige VTF/float-texture o duplicación explícita.

#### El ANCLA del abanico es también el ORIGEN DE PRECISIÓN: se congela al `attach()` en el centro del bbox y las posiciones se guardan RELATIVAS a él, en world0 px. La esquina 0 del triángulo es literalmente `vec2(0.0)` — el ancla no es ni uniform ni atributo.

**Por qué.** La paridad par-impar es independiente de DÓNDE esté el ancla (las contribuciones telescopian), así que la elección es libre y se puede gastar en otra cosa: float32 tiene 24 bits de mantisa y una posición world0 escalada a z18 ronda 2^22 px ⇒ ~0,25 px de error visible al arrastrar. Guardando todo relativo al ancla, las magnitudes quedan acotadas por la extensión del polígono y el desplazamiento absoluto entra en la traslación de `u_matrix`, calculada en float64 en CPU. Restricción DURA que esto impone: el ancla debe ser LA MISMA para todos los anillos y todos los chunks del mismo objeto, o la paridad no cancela. Como es implícita (`vec2(0)`), eso se cumple por construcción y el chunking compone gratis.

**Forma.**

`attach(id, { positions /* Float32Array world0 relativo al ancla */, rings: [{start,count}], anchorWorld /* {x,y} float64 */, style })`. `u_matrix` (mat3) mapea rel-world0 → clip y se recalcula por frame desde centro/zoom del mapa en float64. Re-baseline del ancla SÓLO en `setRings()` (inserción/borrado), nunca en `moveVertex()`.

**Alternativa descartada.** Ancla = v0 del anillo (hace degenerados los triángulos 0 y n−1, gratis) o ancla en el centro de pantalla. Descartadas: v0 pierde el beneficio de precisión (queda en el borde, no acota el radio) y el centro de pantalla cambia por frame ⇒ obligaría a reescribir nada, pero rompe el truco de `vec2(0)` y agrega un uniform sin ganancia.

#### El STENCIL SE AUTO-LIMPIA con el pase de cobertura: `stencilOp(KEEP, KEEP, ZERO)`. No hay clear global, ni clear por scissor, ni segundo pase INVERT.

**Por qué.** Con par-impar sobre 1 bit, tras el pase 1 los píxeles de ADENTRO valen 1 y los de AFUERA valen 0. El quad de cobertura pasa exactamente en los de adentro y, al pasar, los pone a 0; los de afuera fallan (`sfail = KEEP`) y ya valían 0. Resultado: el rect queda íntegramente en 0 y el siguiente polígono arranca limpio. La invariante es EXACTA porque el abanico entero vive dentro del casco convexo de {ancla} ∪ vértices, y el ancla es el centro del bbox ⇒ el bbox contiene todo el abanico. Un segundo pase INVERT sobre el mismo abanico costaría duplicar el pase caro (el de fill-rate); un `clear` con scissor es una llamada extra y en varias GPUs un clear parcial es un pase completo enmascarado.

**Forma.**

Máquina de estado por objeto, dentro de un único frame:
rect = intersect(padRect(bboxPantalla(obj), 1), rectViewport); si area(rect)===0 → skip
gl.scissor(rect)
PASO 1: colorMask(0,0,0,0); enable(STENCIL_TEST); stencilMask(0x01); stencilFunc(ALWAYS,0,0x01); stencilOp(KEEP,KEEP,INVERT); por anillo/chunk drawArrays(TRIANGLES,…)
PASO 2: colorMask(1,1,1,1); stencilFunc(NOTEQUAL,0,0x01); stencilOp(KEEP,KEEP,ZERO); drawArrays(TRIANGLE_STRIP,0,4)
POSTCONDICIÓN: bit0 del stencil = 0 en todo `rect`.
DEPTH_TEST y CULL_FACE explícitamente deshabilitados; BLEND con `SRC_ALPHA, ONE_MINUS_SRC_ALPHA`. Máscara 0x01 en ambos pases ⇒ los bits 1..7 quedan libres e intactos para un futuro clip/máscara.

**Alternativa descartada.** `clear(STENCIL_BUFFER_BIT)` con scissor entre polígonos, y segundo pase INVERT. El primero agrega una llamada por objeto y depende del costo del clear parcial; el segundo duplica el pase de fill-rate, que es justo el cuello de botella.

#### El bbox por objeto se mantiene MONÓTONO CRECIENTE: `moveVertex` hace la unión con la posición nueva y NUNCA reduce. Recomputo completo sólo en `setRings()` / salida de edición.

**Por qué.** Si el scissor y el quad se derivaran de un bbox recomputado, cada frame costaría O(n) en CPU — mata el objetivo. Un bbox SOBREDIMENSIONADO es CORRECTO: sigue conteniendo estrictamente el abanico, así que la invariante de auto-limpieza se conserva; sólo paga un poco más de área de scissor. Un bbox ENCOGIDO sería un bug de corrupción (el abanico se saldría del rect que se limpia).

**Forma.**

`#bbox: {minX,maxX,minY,maxY}` en rel-world0. `moveVertex` → 4 comparaciones. Por frame: transformar 2 esquinas con `u_matrix`, O(1). Guard obligatorio contra no-finitos: `bboxOfRings([])` devuelve todo `Infinity` y `bboxOfPoints` sobre un array vacío también ⇒ un rect NaN produce scissor inválido; `attach` rechaza geometrías con <3 vértices por anillo o coordenadas no finitas.

**Alternativa descartada.** Recomputar el bbox por frame (O(n)) o mantener un bbox exacto con estructura de máximos (heap/multiset por eje) — complejidad que no compra nada porque el sobredimensionamiento es inocuo.

#### REGLA DE RELLENO: par-impar con INVERT. No non-zero. Y no es una preferencia estética: es la regla que YA se ve hoy.

**Por qué.** (1) Es INDEPENDIENTE DE LA ORIENTACIÓN. Non-zero con INCR_WRAP/DECR_WRAP por facing exige que el anillo exterior y los agujeros vengan con winding opuesto y consistente; las geocercas del backend no lo garantizan, y ésa es exactamente la pregunta del enunciado. Con par-impar, un agujero es un agujero cualquiera sea su orientación: paridad 1 (exterior) XOR 1 (agujero) = 0. Isla dentro de laguna: 3 ⇒ 1 ⇒ rellena. Semántica GIS correcta, sin preproceso. (2) Cuesta UN BIT, no un contador: no existe el caso de desborde de INCR_WRAP a 255. (3) Es la misma regla que se está renderizando hoy: `L.Path` de Leaflet trae `fillRule: 'evenodd'` por defecto, y `PolygonLayer` no lo pisa (pasa `...focusedStyle(a.styleOf?.(item))` tal cual). Si eso se confirma, el cambio de renderer es de regla IDÉNTICA ⇒ cero regresión visual, incluida la auto-intersección, donde el lóbulo doblemente cubierto se ve vacío HOY también. Eso convierte 'no se rompe con auto-intersecciones' en 'se comporta igual que hoy', que es el requisito real.

**Forma.**

`stencilOp(KEEP, KEEP, INVERT)` con `stencilMask(0x01)` en el pase 1; `stencilFunc(NOTEQUAL, 0, 0x01)` en el pase 2. La variante non-zero queda como opción de UNA línea (`stencilOpSeparate(FRONT,…INCR_WRAP)` / `(BACK,…DECR_WRAP)` + `stencilFunc(NOTEQUAL,0,0xFF)`) detrás de un flag `fillRule`, no expuesta por defecto. Verificación previa a cerrar: un grep de `fillRule` en `Leaflet/src/layer/vector/Path.js` para confirmar el default (archivo fuera de mi lista).

**Alternativa descartada.** Non-zero winding. Gana sólo si se quisiera que una auto-intersección se vea como UNIÓN de lóbulos; a cambio exige orientación consistente (imposible de garantizar desde backend) y 8 bits de stencil.

#### ANTIALIASING: el contorno es el AA. `antialias` se pide `true` por defecto pero el diseño NO depende de él, y se documenta su factura de memoria medida.

**Por qué.** Con MSAA el stencil también es multimuestreado y la paridad se evalúa por MUESTRA, así que el pase de cobertura escribe color por muestra y el resolve da AA geométrico real — funciona. El problema es el precio: en 1920×1080 @DPR2 (3840×2160) con 4 muestras el framebuffer por defecto pasa de ~33 MB color + ~8 MB stencil ≈ 41 MB a ≈ 133 MB color + 33 MB stencil + 33 MB de resolve ≈ 200 MB, y además CUADRUPLICA el fill-rate del pase 1, que es justo el pase caro. En este proyecto 50 MB de FBO ya están catalogados como defecto (Picking), así que 200 MB no se acepta a ciegas. Y lo que se ve en un borde diagonal SIN MSAA: escalera de 1 píxel de dispositivo con pasos a ~45° — a DPR2 son 0,5 px CSS, imperceptible; a DPR1 es visible si el borde queda desnudo. Pero el borde NO queda desnudo: el contorno del polígono se dibuja igual como línea, con su propio AA y 2–3 px de ancho, CENTRADO sobre la frontera; la escalera del relleno cae dentro de ±0,5 px de esa frontera, o sea íntegramente debajo del trazo. Sólo se ve si el contorno se oculta, es de 1 px, o es del mismo color que el relleno.

**Forma.**

Opción de capa `antialias` (default `true`) fijada en la creación del contexto — NO se puede alternar después sin recrear el contexto, y recrear contextos es justo lo que el presupuesto prohíbe, así que se elige una vez. Instrumentación obligatoria en el arranque: `gl.getParameter(gl.SAMPLES)` (el navegador puede ignorar el hint o dar 2) al log de diagnóstico. Invariante de producto: el contorno SIEMPRE se dibuja mientras hay relleno; si una futura opción permite ocultarlo, el relleno debe seguir teniendo su borde propio.

**Alternativa descartada.** (a) Renderizar a un FBO 1× y hacer AA analítico en shader: necesita consultar la lista de aristas por píxel — caro y complejo. (b) Bajar la resolución del canvas de relleno y compensar con MSAA (2880×1620×4 ≈ 110 MB): el borde del relleno quedaría con distinta nitidez que el trazo. Ambas descartadas.

#### El HIT-TEST del relleno se queda en CPU (`idsFor`/`pointInPoly`), NO entra en el FBO jerárquico de picking. Pero hay que ARREGLAR `pointInPoly`, que hoy trata los multi-anillo como UNIÓN.

**Por qué.** 🔴 Hallazgo concreto: `polygon.js:23` hace `for (…) if (pip(lat,lng,rings[r])) return true` — un punto DENTRO DE UN AGUJERO devuelve `true`. La GPU con par-impar va a pintar ese agujero VACÍO. O sea: el relleno GPU va a EXPONER una discrepancia preexistente entre lo que se ve y lo que se puede clickear. El arreglo es una línea y además alinea CPU y GPU por construcción: XOR en lugar de OR es literalmente la regla par-impar. Por qué CPU y no GPU: un ray-cast de 50.000 vértices son ~50 k iteraciones ≈ 0,2 ms, y sólo para los objetos cuyo bbox contiene el cursor (el índice `prepareIndex`/`lowerBoundBy` ya descarta el resto en O(log n)). Consultar el stencil con un `readPixels` de 1×1 respondería '¿estoy adentro?' gratis en teoría, pero es una sincronización que frena la GPU — el mismo problema que el `request` de Picking ya resuelve con PBO+fence, y no vale reintroducirlo por una pregunta que la CPU contesta en 0,2 ms.

**Forma.**

En `src/geometry/polygon.js`, `pointInPoly` pasa de OR a XOR:
`let inside = false; for (let r = 0; r < rings.length; r++) inside = inside !== pip(lat, lng, rings[r]); return inside`
Se mantiene el atajo de anillo simple. `prepareIndex`/`idsFor`/`idFor` no cambian. `PolygonLayer.#hitsAt` no cambia. Efecto colateral deseado: el hit-test del `PolygonLayer` actual también deja de reportar clicks dentro de agujeros.

**Alternativa descartada.** Añadir el relleno al esquema a=objeto/b=chunk/rg=vértice del FBO. Sería un pase más con distinta primitiva (triángulos vs. puntos) y rompería el reuso del `vertexAttribPointer` de glify que hace barato el picking de puntos hoy.

#### El chunking del área (3) se mapea al relleno como RANGOS DE DRAW, no como buffers separados — y el relleno necesita que el chunk tenga CAPACIDAD FIJA CON HOLGURA.

**Por qué.** Como el ancla es implícita (`vec2(0)`) y compartida, la paridad compone entre chunks sin ningún cuidado especial: dibujar el chunk c es `drawArrays(TRIANGLES, 3*c*C, 3*C)`. Mover un vértice ya es O(1) SIN chunking (1 texel). El chunking le sirve al relleno para INSERTAR/BORRAR: en un layout compacto, insertar corre la cola ⇒ O(n) texels; con capacidad fija C y un contador vivo por chunk, insertar reescribe UN chunk ⇒ O(C). Es exactamente el mismo argumento de 'recrear pasa a ser tiempo constante' del enunciado, aplicado al buffer de posiciones.

**Forma.**

Un draw por chunk con `u_ringStart`, `u_ringCount` y `u_bridge` (vec2 = primer vértice del chunk SIGUIENTE, o del primer chunk del anillo si es el último) para la arista que cruza el límite: la última arista del chunk usa `u_bridge` en vez del `texelFetch`. Sin index buffer, sin vértice duplicado en la textura. Cantidad de draws por objeto y frame = #chunks + 1; con 50.000 vértices y C=4096 son 14 draws — despreciable.

**Alternativa descartada.** Cerrar cada anillo duplicando v0 al final de la textura para eliminar el módulo del shader. Ahorra un ternario pero mueve un centinela en cada inserción; el ternario es más barato que el invariante extra.

#### Ciclo de dibujo DIRIGIDO POR EVENTOS, con UN solo rAF de coalescencia. Cero intervals, cero rAF anidados, cero bucle permanente.

**Por qué.** El estado del relleno cambia sólo por: movimiento del mapa, resize, o escritura de geometría. Un `pointermove` de arrastre ya viene limitado por el navegador; escribir el texel y pedir un frame en el mismo handler basta. El rAF único existe únicamente para fusionar N escrituras de una misma tarea en UN draw, que es el idiom que el propio AGENTS.md ejemplifica (`const schedule = () => pending && requestFrame()`).

**Forma.**

`#pending = false`; `#schedule() { this.#pending ||= (requestAnimationFrame(this.#frame), true) }`; `#frame()` limpia `#pending` y dibuja. Suscripción a los MISMOS eventos de mapa que usan las capas GL del motor. Riesgo a cerrar con el área del motor: la animación de zoom de Leaflet, que glify resuelve con un transform CSS sobre su canvas y un redraw en `zoomend` — el relleno debe REPLICAR ese mecanismo exacto, no inventar el suyo, o durante el zoom se verá desfasado respecto del trazo.

**Alternativa descartada.** Bucle rAF permanente (quema batería y viola el mandato) y doble rAF para 'esperar el layout' (frágil, dependiente del render).

#### Honestamente: STENCIL para la sesión de EDICIÓN, earcut cacheado para el display ESTÁTICO. No es 'uno u otro'.

**Por qué.** Dónde gana earcut, sin adornos: (1) FILL-RATE. Un polígono triangulado rasteriza cada píxel ~1 vez; el abanico rasteriza la suma de |áreas| de n triángulos, que para una forma cóncava tipo costa puede ser 10–100× el área de pantalla. En 1080p@DPR2 (8,3 Mpx) un 100× son ~830 Mpx de stencil por frame: aun a 10–100 Gpix/s de relleno-sólo-stencil son ~8–80 ms. NO es gratis. (2) No necesita `stencil:true` ⇒ NO necesita el contexto 17: puede vivir en el contexto de glify. Ése es un argumento fuerte. (3) Sin MSAA, un triangulado no tiene el problema de bordes duros interiores... aunque sí puede tener grietas por T-junctions, que el abanico NO tiene (la regla top-left de rasterización garantiza que un píxel sobre una arista compartida lo cubre EXACTAMENTE UNO de los dos triángulos ⇒ paridad exacta, sin fisuras). Dónde pierde earcut, y es donde estamos: retriangular es O(n log n) típico / O(n²) peor caso — para n=400 son ~0,2–0,5 ms por frame de arrastre (tolerable), para n=50.000 son ~50–500 ms (inutilizable); el 'earcut incremental' real es CDT con flips locales, un proyecto grande en sí mismo, porque mover UN vértice puede invalidar orejas lejanas; y earcut NO soporta auto-intersecciones (produce triángulos solapados/basura) ni tolera agujeros mal anidados — o sea, falla justo en los casos límite que el requisito exige no romper. Cruce concreto: earcut gana con geometría ESTÁTICA redibujada por frame (pan/zoom) y n grande; stencil gana con geometría que CAMBIA y n grande. Mitigación del fill-rate del stencil: el scissor al bbox∩viewport, que es enorme cuando se edita con zoom (el caso normal: se está mirando de cerca el vértice que se arrastra, y el bbox visible es pequeño).

**Forma.**

Plan combinado: durante la edición manda `StencilFill`. Al salir de edición se triangula UNA vez (earcut) y se le entrega al `PolygonLayer` estático el index buffer cacheado, si y cuando esa capa pase a GPU. Mientras tanto el estático sigue siendo `L.polygon` (SVG), que para geocercas de 4–50 vértices ya es gratis. Regla de encendido: `StencilFill` se activa sólo en sesión de edición, así el contexto y su memoria no existen en el 99 % de las pantallas.

**Alternativa descartada.** Earcut retriangulado por frame de arrastre con throttling. Descartado dos veces: viola la prohibición de timers/intervals y da un relleno que 'salta' detrás del vértice, que es exactamente lo que el requisito de transparencia prohíbe.

#### Utilidades que FALTAN en `geometry/` y que hay que agregar (nada más; el resto ya está).

**Por qué.** Lo que ya existe y sirve: `bboxOfRings` (lat/lng), `bboxOfPoints` (world0 px, `{x,y}`), `rect/area/intersect` (justo el álgebra del scissor: `intersect(bboxPolígono, viewport)` y `area(...)===0` como guard de descarte), `pip` (par-impar por anillo — misma regla que la GPU) y `prepareIndex`/`idsFor` (índice de bbox ordenado con `lowerBoundBy`, que ya evita el ray-cast masivo). Lo que falta es el pegamento entre dos vocabularios de rectángulo que hoy conviven en el mismo módulo sin adaptador: `bboxOfPoints` devuelve `{minX,maxX,minY,maxY}` y `rect()` devuelve `{left,top,right,bottom}`.

**Forma.**

En `src/geometry/bbox.js`:
· `bboxToRect = b => rect(b.minX, b.minY, b.maxX, b.maxY)`
· `padRect = (r, px) => rect(r.left - px, r.top - px, r.right + px, r.bottom + px)`
· `isFiniteRect = r => Number.isFinite(r.left) && Number.isFinite(r.top) && Number.isFinite(r.right) && Number.isFinite(r.bottom)` (guard contra el bbox todo-`Infinity` que `bboxOfRings([])` devuelve hoy)
En `src/geometry/polygon.js`:
· el arreglo XOR de `pointInPoly` (ver decisión de hit-test)
· `flattenRings(rings, project, origin) → { positions: Float32Array, rings: [{start,count}] }` — aplana [lat,lng] a world0 relativo al origen, normalizando el anillo cerrado (descarta el vértice final si repite el primero: `L.polygon` usa anillos ABIERTOS, así que ésa es la convención de la casa)
· `signedArea(ring)` — no lo necesita par-impar; se agrega sólo si algún día se habilita la variante non-zero o se quiere detectar agujeros en CPU.

**Alternativa descartada.** Meter la conversión de rectángulos dentro de `StencilFill`. Se descarta porque el seam de los dos vocabularios de rect ya existe en `bbox.js` y ahí es donde se cierra, no en un consumidor.

### traspaso-dom (activación bajo demanda de ≤3 handles DOM sobre geometría editable en GPU)

#### El GESTO lo posee la capa GL / Interaction; el DOM es affordance pura y NO participa del arrastre (los 3 nodos llevan `pointer-events:none` y CERO listeners).

**Por qué.** Es la única resolución de la costura que no administra la ventana de latencia sino que la ELIMINA. El pick es asíncrono (PBO+fenceSync ≈ 1 frame de poll por `#scheduleTick`), así que si el drag depende de que el nodo exista hay una ventana real donde se pierde. Sacando el DOM del camino crítico, el handle puede aparecer tarde —o no aparecer— y el arrastre sigue siendo pixel-correcto. Además el contenedor YA es el host de todos los listeners (`#onDom`) y YA está conectado al documento: capturar sobre él es trivial, mientras que capturar sobre un nodo recién insertado depende de que esté `connected` y de que el navegador transfiera la captura a mitad de gesto.

**Forma.**

`container.setPointerCapture(e.pointerId)` en `#onPointerDown`; estado `#drag` dentro de `Interaction`; `HandleBank` crea los nodos sin ningún `addEventListener`; el pane lleva `style.pointerEvents='none'`.

**Alternativa descartada.** «el handle nace ya arrastrando»: crear el nodo en el pointerdown y capturar sobre él. Obliga a un `readPixels` síncrono en CADA pointerdown del mapa (también los que inician un pan), acopla el drag a la existencia del nodo, y mete inserción+captura dentro del mismo handler.

#### Atajo del pointerdown en dos tiempos: PRIMERO la caché por píxel de la última muestra ya resuelta; `pickHitSync` SÓLO si el píxel no coincide.

**Por qué.** Un pointerdown de mouse cae casi siempre en el MISMO píxel que el último pointermove que ya se resolvió (el puntero no se movió entre ambos eventos) ⇒ en el caso común hay 0 stalls de GPU. El caso que sí necesita el sync es el que no tiene hover previo: touch (pointerdown sin pointermove) y el mouse que entra y aprieta en el mismo píxel-primero. Y la caché no puede quedar rancia porque `#endHover()` —que ya se dispara en movestart/zoomstart/pointerleave/demanda-a-cero— la invalida: ningún valor cacheado sobrevive a un movimiento de cámara.

**Forma.**

`DomHandover.resolvedAt(x, y) → part|null` (compara `containerPoint` de `#handover.lastSample` con el del pointerdown). `#onPointerDown`: `const part = h.resolvedAt(cx, cy) ?? layer.pickHitSync(this.#sampleOf(p)); part && this.#beginDrag(part, event)`.

**Alternativa descartada.** `pickHitSync` incondicional en todo pointerdown (estanca el pipeline al arrancar cada pan) y, en el otro extremo, confiar sólo en el estado armado (pierde el primer tap en touch — el editor no serviría en móvil).

#### El drag REUSA `#beginInteraction()` / `#endInteraction()` como canal de gesto, en vez de inventar un estado paralelo.

**Por qué.** `#beginInteraction` ya hace exactamente las cuatro cosas que el drag necesita al arrancar: `#endHover()` (que desarma el banco y cancela el rAF de poll), `hover:out` en el bus, cursor limpio, y aviso al motor por `#onInteractionStart`. Y `#interacting` ya suprime el pipeline de hover en `#onPointerMove` (línea 151) y difiere `#tick` (línea 222). Cero estado nuevo, cero segundo mecanismo de supresión que pueda desincronizarse con el primero.

**Forma.**

`#beginDrag()` → `#beginInteraction()`; `#endDrag()` → `#endInteraction()`. `#endInteraction` gana el guard `if (!this.#interacting || this.#drag.active) return`.

**Alternativa descartada.** Un flag `#dragging` propio con su propia supresión de hover: duplica la lógica de las líneas 151/222 y deja al motor sin el aviso de gesto (el drag es tan gesto como el pan: conviene que el motor pause relayout de etiquetas / reindex de cluster igual).

#### Banco de EXACTAMENTE 3 nodos creados UNA sola vez en el constructor. «Activar» es escribir transform + clase; «desactivar» es una clase. Nunca se crea ni se destruye un nodo durante la interacción.

**Por qué.** Convierte el presupuesto «≤3 nodos» de una disciplina que hay que auditar en un invariante estructural: no se puede filtrar lo que no se puede asignar. Elimina de raíz la clase entera de bugs «quedó un handle vivo al soltar», que es justo lo que el banco de medición va a asertar.

**Forma.**

`HandleBank` con `#nodes = [prev, active, next]` de rol FIJO (así las clases por nodo son constantes y sólo cambia el transform) + `#host` focusable. API: `show(prevXY, activeXY, nextXY)` (rol con `null` → ese nodo apagado), `hide()`, `get visibleCount()`, `get host()`, `destroy()`.

**Alternativa descartada.** Crear/eliminar nodos por activación (aunque sean 3): reintroduce el ciclo de vida que hay que auditar y agrega layout/GC por cada entrada y salida de vértice.

#### Durante DRAGGING el banco queda APAGADO: 0 nodos visibles y 0 escrituras de DOM por frame. La continuidad visual la lleva GL con la variante «grabbing» del sprite.

**Por qué.** Si sólo uno de los dos renderers está visible, DOM y GL no pueden desincronizarse — desaparece el desfase de un frame entre el nodo y el sprite. Además el frame de drag baja a 1 rAF + ≤3 `bufferSubData`, sin ningún template string de transform por frame. Y sale gratis del reuso del punto anterior: `#beginDrag → #beginInteraction → #endHover → disarm()`.

**Forma.**

`#beginDrag` no toca el banco (lo apaga `#endHover`); `#endDrag` no lo prende (lo prende el próximo hover resuelto). Cursor `grabbing` mientras dura.

**Alternativa descartada.** Mover el handle activo por frame siguiendo el vértice: 1 template string por frame más la posibilidad permanente de que el nodo y el sprite muestren posiciones distintas si una de las dos escrituras se pierde.

#### Pane propio COLGADO DE `mapPane`, con los handles posicionados en coordenadas de CAPA (layerPoint) → cero reproyección por frame.

**Por qué.** Un pane hijo de `mapPane` cabalga el transform del mapa: el handle queda pegado durante el pan sin que nadie escriba nada por frame. El escalado CSS que Leaflet aplica a `mapPane` durante el zoom (que inflaría los handles) nunca se ve porque `zoomstart` → `#beginInteraction` → `#endHover` → banco apagado.

**Forma.**

`map.createPane('cristae-edit')` (por default nace dentro de `mapPane`), `pane.style.pointerEvents = 'none'`, `pane.style.zIndex` sólo para el apilado VISUAL. El zIndex del HIT se declara aparte en la entrada del registro — son dos cosas distintas y no deben derivarse una de la otra.

**Alternativa descartada.** Pane fuera de `mapPane` (o contenedor absoluto propio) con reproyección por frame: es exactamente el patrón que produce la vibración/teletransporte al deslizar.

#### La capa de edición se registra con DOS entradas: `edit:handles` (vértice+segmento, `capture: true`) y `edit:fill` (relleno, sin capture).

**Por qué.** `capture` es propiedad de la ENTRADA, no de la parte: con una sola entrada el relleno del polígono ocluiría los clicks de TODO lo que hay adentro mientras se edita (los móviles dentro de una geocerca dejarían de ser clickeables). Partido en dos, el vértice/segmento sí ocluye —que es lo que se quiere: agarrar un vértice no debe abrir el popup del camión de abajo— y el relleno no ocluye nada.

**Forma.**

`registry.upsertResolver({ layerId:'edit:handles', kind:'edit-geometry', zIndex: <banda de edición>, declOrder: <capturado UNA vez>, resolveClick: fn, resolveHover: fn, getLeafletLayer: () => null, visible:true, capture:true }, this)` y su gemela `edit:fill` con `capture:false` y zIndex bajo los marcadores. Apagar la edición = re-`upsertResolver` con `capture:false` (el método ya mueve la entrada dentro/fuera del Set `overlays`, líneas 99-100).

**Alternativa descartada.** Volver `capture` un predicado `(hit) => bool` en LayerRegistry: cambia una semántica compartida por todas las capas para resolver un caso que se expresa hoy con dos entradas y cero cambios de lib.

#### UN píxel del FBO = UNA parte. `distancePx: 0` siempre; el *kind* (vértice/segmento/relleno) viaja DENTRO del id decodificado.

**Por qué.** El readback devuelve un único id por píxel: la capa físicamente no puede devolver «vértice» y «segmento» a la vez para el mismo punto, así que el desempate por `distancePx` dentro de una misma entrada (línea 153 de LayerRegistry) es letra muerta para esta capa. Reconocerlo simplifica el resolver y hace que `#present` (que recorta con `hits.slice(0, i+1)`) sea exactamente correcto: el hit de arriba es el único que existe.

**Forma.**

Reparto propuesto para el pack jerárquico del área de picking: `a` = objeto(6 bits, 64 objetos editables) + kind(2 bits: 0 vértice / 1 segmento / 2 relleno / 3 reservado), `b` = chunk(8 bits), `rg` = índice dentro del chunk(16 bits) ⇒ 16,7 M de vértices por objeto y el kind entra en el MISMO píxel, sin pase ni readPixels extra.

**Alternativa descartada.** Un bit de kind robado a `rg` (halva el espacio de vértices por chunk) o una segunda consulta para desambiguar kind (rompe el «un readPixels»).

#### `LayerRegistry.resolveHitsForChannels(channelMask, baseEvent)` nuevo; `resolveHits` y `hasHitForChannels` quedan INTACTOS.

**Por qué.** El traspaso necesita la lista canónica ORDENADA Y PRESENTADA (no puede armar un vértice que está debajo de un overlay `capture`), y no puede colgarse del gate de HOVER: igual que el cursor, la capa de edición puede tener demanda sólo de CLICK y aun así debe armar el handle. `hasHitForChannels` corta al primer acierto en orden de INSERCIÓN del Map (líneas 179-185): sirve para un booleano, no para «cuál es el de arriba». Y tocar `resolveHits('hover')` para que gatee por máscara cambiaría qué overlays recortan la lista de hover que hoy ve el consumidor — regresión silenciosa.

**Forma.**

Extraer el cuerpo de `resolveHits` a `#collect(baseEvent, partsOf)` (recorrido + push + sort + `#present`). `resolveHits(type, e) => this.#collect(e, entry => this.#resolveParts(entry, type, e))`; `resolveHitsForChannels(mask, e) => this.#collect(e, entry => (entry.activeMask & mask) ? (entry.resolveHover?.(e) ?? []) : [])`. Se llama SÓLO cuando `handover.enabled` ⇒ costo cero en las pantallas sin edición abierta.

**Alternativa descartada.** Reimplementar la oclusión del lado del traspaso (preguntar «¿hay algo por encima de mi zIndex?»): duplica `#present` fuera del registro y se desincroniza al primer cambio de la regla de overlays.

#### El cursor tiene UN solo escritor con prioridad explícita: el traspaso gana, el hover es el fondo.

**Por qué.** Si el traspaso escribiera el cursor por su cuenta tendría que acordarse de restaurar el valor previo al desarmar, y ese baile de restauración es exactamente donde quedan cursores pegados. Con un único sitio de asignación no hay nada que restaurar.

**Forma.**

`#setCursor` pasa de booleano a string (`''` = apagado) conservando el guard de identidad `if (value === h.cursorValue) return`. Único sitio: `this.#setCursor(this.#handover?.cursor || (hit ? 'pointer' : ''))` — `||` y no `??`, porque el «apagado» del handover es `''` (cadena vacía, no nullish). Valores del handover: `'grab'` sobre vértice, `'crosshair'` sobre segmento (afordancia de inserción), `'grabbing'` durante el drag.

**Alternativa descartada.** Una pila de cursores con push/pop por subsistema: máquina de estados extra para un problema que se resuelve con una expresión de prioridad.

#### Lock de cámara durante el drag, por tabla y con snapshot de habilitación previa.

**Por qué.** `pointerdown` se dispara ANTES que el `mousedown` que arma `L.Draggable`, así que deshabilitar ahí evita que Leaflet llegue siquiera a armar el pan — sin necesidad de `preventDefault` (los listeners calientes son passive) ni de pelearse con el navegador. Y con la cámara clavada desaparece la clase entera de bugs «el mapa se movió abajo del drag» (rueda del mouse a mitad de arrastre, doble-click, box-zoom, flechas).

**Forma.**

`const DRAG_LOCK = ['dragging', 'scrollWheelZoom', 'doubleClickZoom', 'boxZoom', 'keyboard']` + `#drag.locks = new Uint8Array(5)` reusado: `#lockCamera()` guarda `enabled()` y deshabilita; `#unlockCamera()` re-habilita SÓLO lo que estaba habilitado (la app puede tener `dragging` ya apagado y no se le debe encender).

**Alternativa descartada.** `preventDefault`/`stopPropagation` sobre el pointerdown: obliga a listener no-passive en la ruta caliente y no cubre la rueda ni el teclado.

#### Supresión del click de cierre con slop de 3 px.

**Por qué.** Sin esto, soltar el vértice emite un `click` que el registro rutea al hit de abajo (o al `onEmptyClick`, línea 171) y el editor «hace cosas» al terminar cada arrastre. Con el slop, un drag real suprime el click y un click quieto sobre el vértice pasa normalmente y se resuelve como click sobre el vértice — que es lo que el usuario espera para seleccionarlo.

**Forma.**

`#drag.moved` se prende cuando `Math.hypot(dx, dy) > 3`; `#onClick` arranca con `if (this.#drag.suppressClick) { this.#drag.suppressClick = false; return }`; `#endDrag` setea `suppressClick = this.#drag.moved`.

**Alternativa descartada.** Suprimir el click siempre después de un drag: rompe el click de selección sobre el vértice.

#### Teclado: UN host con roving tabindex (`bank.host`, `tabindex=0`), los 3 handles `aria-hidden`/`tabindex=-1`. El nudge escribe por el MISMO camino que el drag.

**Por qué.** Es la razón real por la que hay DOM: el GL no puede dar foco, ni orden de tabulación, ni ARIA, ni `Escape`. Y nodos efímeros que aparecen y desaparecen con el hover son pésimos objetivos de tabulación — por eso el que tabula es el host permanente, no los handles. Un solo camino de escritura (el mismo `moveVertex`) garantiza que teclado y puntero no puedan divergir.

**Forma.**

`keydown` en el CONTENEDOR con `{ passive: false }` (los handles están dentro, burbujea): flechas = 1 px (Shift = 10 px) convertidos a latlng desde containerPoint; `Escape` durante el drag = cancelar restaurando `#drag.origin` (2 floats snapshotteados en `#beginDrag`, objeto reusado); `Delete`/`Backspace` = borrar vértice. `host.focus({ preventScroll: true })` al confirmar el pointerdown, para que las flechas nudgeen el vértice recién agarrado. `pointer-events:none` NO impide foco programático ni teclado.

**Alternativa descartada.** Hacer focusable cada handle: 3 objetivos de tabulación fantasma que entran y salen del orden de tabulación con el movimiento del mouse.

### integracion-gpu (PointLayer.js + LineLayer.js) — patrón canónico de capa GPU aplicado a la geometría editable

#### CONTRATO CANÓNICO DE CAPA GPU — checklist accionable extraído de PointLayer + LineLayer, que la capa editable debe cumplir entero

**Por qué.** Las dos capas comparten exactamente la misma forma y las divergencias son todas justificadas por el backend, no por gusto. Evidencia: constructor idéntico ({glify,map,pane,source,interactive}) + #unsub=source.subscribe(()=>this.#onChange()) + #onChange() inline; misma superficie de lifecycle (redraw/syncPickingSize/resetCanvasReference/refresh/destroy/get count); mismo teardown en ORDEN LITERAL (unsub → picking.detach → binding.destroy → cancelPendingRedraw(layer) → layer.remove() → loseGlContext(layer) → layer=null); misma bifurcación rebuild/incremental; misma esclusa de layout con throw (PointLayer.js:306 `bytes!==7`, LineLayer.js:264 `bytes!==BYTES`).

**Forma.**

CHECKLIST (11 puntos, todos obligatorios para EditableGeometryLayer):
1. Constructor: `constructor({ glify, map, pane, source, interactive=false, accessors=null, where=null })` → stash, `#accessors = accessors ?? source.accessors`, `#unsub = source.subscribe(() => this.#onChange())`, `this.#onChange()` SÍNCRONO (el primer build NO se difiere).
2. Superficie que el motor invoca: `redraw()`, `syncPickingSize()`, `resetCanvasReference()`, `refresh()`, `destroy()`, `get count()`, `resolveClick(baseEvent)`, `resolveHover(baseEvent)`; si hay picking GPU además `requestHoverHit(sample)`, `collectHoverHit()`, `cancelHoverHit()`, `get picking()`, `get hasPendingPick()`, `idForSlot(slot)`.
3. `refresh()` = `if (this.#layer) this.#rebuild(this.#source.getSnapshot())` — nunca reconstruye si no hay capa.
4. Setters de política (`set suppressed`, `set where`, `set enabled`) NO reconstruyen: sólo marcan; el caller llama `refresh()`. Copiar tal cual.
5. `getSnapshot()` se relee POR EMIT dentro de `#onChange()` (su referencia no es estable); lo estable es el objeto Source. Los Sets de dirty se toman por referencia UNA vez.
6. Guardarraíl de rebuild: `#onChange` cae a `#rebuild` si `!#layer` · `snap.length !== #snapLen` · `!source.itemById` · `!source.dirtyIds?.()` · id sucio sin slot y NO ausente-por-política · cambió la tabulación del buffer. Este último es el que la editable convierte en «rebuild DEL CHUNK».
7. Política de membresía en PUNTO ÚNICO (`#renderablePos` + `#absentByPolicy`), consultada en CADA lectura, jamás cacheada (PointLayer.js:233-246).
8. `#bind()` OBLIGATORIO después de cada `setData`: el WebGLBuffer es estable, el typed array espejo NO (`typedVertices` / `allVerticesTyped` se reasignan por render). `#bind()` re-captura buf+verts (+ mapCenterPixels en puntos), re-aplica lo pintado a mano en el espejo (`#applyGradient` en líneas → en la editable también `#applyCut`) y re-emite `bufferData(..., DYNAMIC_DRAW)`.
9. Ruta caliente [0-alloc]: `gl.bindBuffer(ARRAY_BUFFER, #buf)` + `gl.bufferSubData(ARRAY_BUFFER, elemOffset*4, verts, elemOffset, len)` — forma de 5 args de WebGL2, SIN `subarray()`. `elemOffset*4` en bytes, `elemOffset`/`len` en ELEMENTOS. Bucle explícito (no map/filter) dentro del write.
10. Coalescencia: NO la hace la capa. La aporta el Emitter de la Source (ya rAF) y el redraw agendado de glify (lo evidencia `cancelPendingRedraw`). La editable NO monta reloj propio.
11. Teardown: el orden de PointLayer.js:163-171 es normativo — `cancelPendingRedraw` ANTES de `remove()` (un redraw en vuelo correría con el mapa desprendido) y `loseGlContext` DESPUÉS (glify.remove no libera el contexto → leak acumulativo).
DIVERGENCIA QUE LA EDITABLE HEREDA DE PUNTOS Y NO DE LÍNEAS: `renderAtView(zoom, center)` (PointLayer.js:123-139) + `#suppressGlifyZoom()` (144-147). LineLayer NO las tiene y por eso durante el zoom animado la línea va por el `setTransform` de glify. Para el trazo eso es tolerable; para el RELLENO en canvas propio NO existe `_animateZoom` ⇒ el relleno quedaría CONGELADO durante el zoom animado. `EditableGeometryLayer.renderAtView` delega a las tres sub-capas y `EditFillLayer` implementa la receta literal: `nw = map.unproject(map.project(center, zoom).subtract(size.divideBy(2)), zoom)`, `off = map.project(nw, 0)`, `mapMatrix.setSize(canvas.width, canvas.height).scaleTo(2**zoom).translateTo(-off.x + mapCenterPixels.x, -off.y + mapCenterPixels.y)`, viewport → uniformMatrix4fv → clear → draw.

**Alternativa descartada.** Inventar una superficie propia «más limpia» para la editable. El motor tipa las capas por duck-typing sobre estos nombres exactos; cualquier renombre exige tocar MapEngine y desalinea la sexta capa respecto de las cinco existentes.

#### ASIMETRÍA DEL ESPEJO CPU: la editable es MIXTA — sus HANDLES son caso Points (espejo OBLIGATORIO) y su TRAZO es caso Lines (espejo no obligatorio para el buffer, pero obligatorio por otras dos razones)

**Por qué.** El código lo dice con precisión y hay que resolverlo por sub-capa, no por capa. (a) PointLayer.js:343-345 declara el motivo: glify regenera `typedVertices` DESDE `data` (=`#positions`) y los callbacks `color:i=>#colorAt(i)` / `size:i=>#meta[i].size` en cada render; por eso `#writePosition` escribe `#positions[s]` y `#writeSlot` escribe `#positions[s]` + `#meta[s]` ADEMÁS del buffer. (b) LineLayer.js:270 declara lo contrario: «El gradiente sobrevive pan/zoom: glify sólo re-compone la matriz en _reset, no re-ejecuta resetVertices» — por eso `#writeFeature` escribe sólo `#verts`. (c) PERO en líneas hay una asimetría MÁS FINA que no se puede pasar por alto: `weight` SÍ se lee por draw (`weight: i => this.#weightByPart[i]` lo consume `drawOnCanvas`), y por eso `#writeFeature` línea 169 actualiza `#weightByPart[feat.partStart+i]` en el path incremental; y `style.color` se actualiza «para mantener coherente el color per-feature» (línea 162) por si viene un rebuild. Conclusión: en Lines el espejo se necesita para todo lo que glify lee POR DRAW y para todo lo que el rebuild vuelve a leer.

**Forma.**

REGLA POR SUB-CAPA:
· HANDLES (glify.points, bytes=7) → ESPEJO OBLIGATORIO. Todo write incremental toca `#positions[slot]` (par [lat,lng]) y `#meta[slot]` (size, y variante si la hubiera) además de `#verts`. 🔴 COROLARIO QUE EVITA EL BUG: ocultar el handle activo escribiendo `size=0` SÓLO en `#verts[base+6]` produce un handle que REAPARECE al primer pan (glify regenera desde `#meta[i].size`). Por eso el diseño oculta los 3 handles promovidos a DOM con UNIFORMS DE RANGO en el vertex shader (`gl_PointSize = (id>=uHideLo && id<=uHideHi) ? 0.0 : aSize`), no con writes — cero bufferSubData y cero exposición al espejo en la transición más caliente.
· TRAZO (glify.lines, bytes=6) → sin espejo de coordenadas exigido por glify, PERO: (1) hay que mantener `#weightByPart` al día (glify lo lee por draw); (2) el corte por alpha y el gradiente se pierden en cada `setData` ⇒ se re-aplican DENTRO de `#bind()`, al lado de `#applyGradient()` — punto único, igual que hoy; (3) el GeoJSON que recibe `setData` debe estar al día con los vértices movidos, porque el rebuild vuelve a leer del dominio (`toParts(a.pathOf(item))`) ⇒ el modelo de dominio de la geometría es la fuente y siempre se mutó antes del write.
· RELLENO (contexto propio, sin glify) → no hay asimetría: el VBO es nuestro y su espejo es la única fuente.

VERIFICACIÓN — SECUENCIA QUE EXPONE EL BUG (test T-ESPEJO):
  1. Montar la editable con un anillo de 1.000 vértices.
  2. `source.move(id)` / `patch` del vértice 500 con Δ conocido (ruta incremental, NO rebuild). Assert: `layer.typedVertices[slot*7]` refleja Δ.
  3. Disparar el ciclo de vista que el motor ejecuta en `move`: `layer.layer._reset(); layer.layer.redraw()` (equivale a `resetCanvasReference()` + `redraw()`).
  4. RE-LEER `layer.typedVertices[slot*7]`. Si volvió al valor pre-Δ ⇒ falta el espejo. En puntos la revierte; en líneas no.
  5. Variante zoom: `renderAtView(z+0.5, center)` (no debe revertir nunca — sólo recompone matriz) y luego un `zoomend` real que sí invoca `_reset` (ahí aparece).
  Sin GPU real: el test corre contra un doble de `glify.points` que reimplemente `resetVertices` regenerando desde `data`+callbacks — es un test del CONTRATO, no del driver, y por eso es el único que atrapa esto en CI.
VERIFICACIÓN — T-BIND (el otro bug silencioso): tras cualquier `setData`, `this.#verts === this.#layer.typedVertices` debe ser TRUE inmediatamente después de `#bind()` y se chequea al entrar a cada write en build de desarrollo; si es FALSE el bufferSubData escribió un array huérfano y nada se ve.

**Alternativa descartada.** Asumir «como el trazo es líneas, toda la editable es caso Lines». Es el error exacto que produce el bug que sólo aparece al panear: los handles SON puntos y regeneran desde `data`. La respuesta no es una capa ni la otra, es por sub-capa.

#### TRES SUB-CAPAS COORDINADAS bajo UN objeto-capa ante el motor, con 3 contextos WebGL FIJOS creados una vez y compartidos por TODAS las geometrías editables

**Por qué.** El presupuesto de contextos WebGL (~16 por documento) y el leak conocido de `removeLayer` (glify.remove no libera el contexto; por eso existe `loseGlContext`, PointLayer.js:169 y LineLayer.js:81) prohíben crear/destruir capas GL por geometría o por sesión de edición. El geotáctico ya monta flota + overlay de badges + labels + conectores + recorrido + heat + highlight. Un contexto por polígono editable agota el presupuesto en una tarde. Además el relleno necesita `stencil:true`, que SÓLO se puede pedir al crear el contexto, y necesita ir DEBAJO del trazo en z ⇒ pane propio ⇒ canvas propio.

**Forma.**

`EditableGeometryLayer` es UNA capa ante el motor (cumple el checklist de la decisión 1) y posee:

| sub-capa        | backend                          | contexto        | pane / z                  | picking                          |
|-----------------|----------------------------------|-----------------|---------------------------|----------------------------------|
| `#fill`         | canvas propio + stencil-then-cover| 1 (nuestro)     | banda bajo el trazo       | ninguno                          |
| `#stroke`       | `glify.lines()`                  | 1 (glify)       | banda de trazo de edición | CPU nearest-segment (`prepareIndex`/`nearest`) |
| `#handles`      | `glify.points()` interactive     | 1 (glify)       | sobre el trazo            | GPU FBO jerárquico (rg/b/a)      |

Total 3 contextos, CONSTANTE respecto del nº de geometrías editadas.
Ciclo de vida: creación PEREZOSA en el primer `beginEdit`; al salir de edición NO se destruyen, se VACÍAN (`setData` con 0 features / `count=0` / `uniform1f(uHideLo,-1)`). Se destruyen sólo en `EditableGeometryLayer.destroy()`, con el orden normativo aplicado a las tres.
Fan-out de la superficie: `redraw()`, `resetCanvasReference()`, `syncPickingSize()`, `renderAtView()` y `refresh()` delegan a las tres en ese orden (fill → stroke → handles), que es el orden de z y el que el motor ya usa entre capas.
Contextos nuevos = 0 si se confirma que `glify.lines()` acepta atributos de contexto (`stencil:true`) y expone un hook de pre-draw sin monkey-patch — está en dependencias.
Precedente que autoriza el patrón «programa extra sobre el gl de una capa glify existente»: `Picking.attach(gl, this.#layer.program, this.#binding.texture)` (PointLayer.js:312) ya linkea un segundo programa sobre el contexto de glify sin forkearlo.

**Alternativa descartada.** (a) Una capa por geometría editable — agota los contextos y multiplica el leak. (b) Una sola sub-capa con varios draws sobre un único contexto — imposible sin interponerse entre el `gl.clear` y el `drawArrays` de `glify.drawOnCanvas`, que es monkey-patch, y además fuerza a relleno/trazo/handles al mismo pane (mismo z), rompiendo el apilado.

#### CORTE DEL TRAZO ALREDEDOR DEL VÉRTICE ACTIVO = ALPHA 0 en 4 vértices CONTIGUOS del buffer de líneas. Ni rango degenerado, ni atributo nuevo, ni draws extra

**Por qué.** El layout de glify.Lines es `[x,y,r,g,b,a]` con `bytes=6` y draw `gl.LINES`, y LineLayer YA escribe los 4 canales de color POR VÉRTICE (`#applyGradient`, líneas 282-292, y `#writeFeature` líneas 180-181). Que el alpha per-vértice se respeta está probado por el código: `toRGBA(st?.color ?? DEFAULT_COLOR, st?.opacity ?? 1)` mete el opacity en el canal `a` y el trazo se ve semitransparente. Y como el draw es `gl.LINES` (pares independientes, no LINE_STRIP), apagar dos segmentos NO afecta a los vecinos ni al pairing. El mapeo está dado: el vértice v de una parte corresponde al punto `(v+1)>>1` (`pathIndexOf`, LineLayer.js:30) ⇒ el segmento s ocupa los vértices 2s y 2s+1.

**Forma.**

Vértice activo = punto i (índice DENTRO de la parte/chunk). Segmentos a ocultar: s=i−1 y s=i ⇒ vértices 2i−2, 2i−1, 2i, 2i+1 → CONTIGUOS.
  `const e0 = (run.vertOffset + 2*i - 2) * 6`   // elementos
  `gl.bindBuffer(gl.ARRAY_BUFFER, this.#buf)`
  `gl.bufferSubData(gl.ARRAY_BUFFER, e0 * 4, v, e0, 24)`   // 24 elementos = 4 vértices × 6 floats = 96 bytes
Se escriben los 24 (no sólo los 4 alphas): el rango contiguo hace que una sola subida sea más barata que cuatro de un elemento. Poner `v[e+5] = 0` en cada uno de los 4 vértices; restaurar = re-escribir el color real desde el modelo con el MISMO bufferSubData.
CASOS BORDE, todos O(1):
 · i=0 (extremo abierto) → sólo s=0: `e0 = run.vertOffset*6`, len 12.
 · i=K−1 → sólo s=K−2, len 12.
 · Polígono CERRADO con i=0 → s_cierre está al final de la parte y NO es contiguo con s_0 ⇒ DOS bufferSubData de 12. Aceptado y explícito.
 · i en frontera de chunk → los dos segmentos viven en partes distintas, pero glify emite las partes CONTIGUAS Y EN ORDEN en el buffer global (LineLayer.js:219-220), así que el rango sigue siendo contiguo salvo por el vértice solapado; en el peor caso son 2 bufferSubData.
🔴 RE-APLICACIÓN OBLIGATORIA: el corte vive sólo en `#verts`, así que sobrevive pan/zoom (Lines no re-ejecuta resetVertices) pero NO sobrevive un `setData`. `#applyCut()` se invoca DENTRO de `#bind()`, inmediatamente al lado de `#applyGradient()` (LineLayer.js:275) — punto único, mismo lugar, misma razón.

**Alternativa descartada.** (a) RANGO DEGENERADO (colapsar los 2 vértices del par): glify.Lines no dibuja `gl.LINES` puro, dibuja una BROCHA que barre ±w en pasos de 0.5 (LineLayer.js:32-36) ⇒ un par colapsado pinta un DISCO de radio w en el punto, justo debajo del handle activo. Rechazado. (b) ATRIBUTO DE VISIBILIDAD POR VÉRTICE: exige `bytes` 6→7, o sea forkear la tabulación Y el shader de glify.Lines; la esclusa `if (this.#layer.bytes !== BYTES) throw` (LineLayer.js:264-265) existe precisamente para prohibirlo, y todo el valor de LineLayer es que envuelve glify sin forkearlo. (c) DOS DRAWS CON OFFSETS DISTINTOS: el draw call lo emite `glify.drawOnCanvas`, no nosotros; cambiarlo es monkey-patch, y con chunks el corte puede caer en medio de una parte, lo que obligaría a partir la parte ⇒ re-tabulación ⇒ exactamente lo que el chunking vino a evitar.

#### CAPACIDAD FIJA POR CHUNK (C=512 puntos) con relleno de vértices CENTINELA — sin esto el chunking NO hace la inserción O(1) sobre glify.Lines

**Por qué.** 🔴 Hallazgo central de mi área y contradicción real con la propuesta si no se corrige. El chunking abarata el bufferSubData, pero NO evita el `setData`: LineLayer.js:129-132 lo dice literal — «si cambió el nº de partes o el nº de vértices de alguna, los vertOffset de los features SIGUIENTES ya no calzan con el buffer → rebuild (glify re-tabula el buffer entero)». Insertar un vértice cambia `vertCount` de esa parte ⇒ rebuild O(N) igual. El «premio mayor» del chunking (recrear en tiempo constante) sólo se obtiene si `vertCount` NUNCA cambia.

**Forma.**

Cada chunk se emite a glify con capacidad FIJA C=512 puntos → `vertCount = 2*(C−1) = 1022` vértices → 6.132 floats → 24.528 bytes, invariante. Un chunk con n ≤ C puntos reales llena los C−n sobrantes con CENTINELAS:
 · en el GeoJSON de `setData` el centinela repite el último punto real (lat/lng válido, no rompe `projX0/projY0`);
 · en el espejo `#verts` se pisa con `x = y = 1e9` (Float32 lo aguanta) y `a = 0`.
 · El relleno arranca SIEMPRE en el vértice `2(n−1)`, que es PAR ⇒ todos los pares sobrantes tienen sus DOS vértices en el centinela ⇒ el par entero cae fuera del frustum y se clipea antes de rasterizar. Esto es lo que evita pagar las `(4w+1)²` pasadas de brocha por segmento fantasma (con w=3 son 169 pasadas × 112 fantasmas ≈ 19 K pasadas desperdiciadas si sólo se usara alpha=0). El alpha=0 queda igual, como red de seguridad si el clipping no fuera exacto.
COSTES REALES:
 · Insertar/borrar un vértice en el chunk c = reescribir desde el punto insertado hasta el fin del chunk: peor caso 6.132 floats = 24.528 bytes, UN bufferSubData contiguo, INDEPENDIENTE de N. Tiempo constante. ✅
 · Chunk lleno (n==C) → split en dos ⇒ cambia el nº de partes ⇒ 1 rebuild. Amortizado: 1 rebuild cada C/2 = 256 inserciones.
 · Handles: C×7 floats = 14.336 bytes por chunk; centinela = `size 0` (escrito en `#meta` Y en `#verts`, caso Points).
 · Relleno: (C+1)×2 floats por chunk; centinela = índices ausentes del IBO.
TECHO RESULTANTE con reparto simple rg/b/a = 16/8/8: 256 chunks × 512 = 131.072 vértices por objeto (no los 16,7 M del planteo original — la capacidad fija recorta el techo). Si se necesita más, es ARITMÉTICA DEL DECODE, no un cambio de pase: robar bits altos de `rg` (que con C=512 sólo usa 10) al campo chunk ⇒ chunk de 14 bits ⇒ 8,4 M por objeto.

**Alternativa descartada.** Chunks de tamaño variable «que crecen con el dato». Es lo natural, y es exactamente lo que devuelve la inserción a O(N) porque re-tabula el buffer entero de glify. La capacidad fija cambia desperdicio de memoria (acotado y barato) por tiempo constante garantizado.

#### PICKING JERÁRQUICO EN 32 BITS: los HANDLES abandonan el atlas de sprites para liberar los canales r,g del vértice — el `#decode` viejo queda INTACTO y el cambio es puramente ADITIVO

**Por qué.** Hay un choque real entre la propuesta y el layout: PointLayer.js:11 declara el layout `[x,y,r,g,b,a,size]` con **r = tile del atlas y g = ángulo**; `#colorAt` (líneas 319-328) sólo deja `b` y `a` para el id (16 bits). Los canales b y a LIBRES del enunciado son los de SALIDA del FBO, no los del vértice: el fragment de picking recibe el id en los varyings b,a y lo emite en r,g (por eso `#decode` lee `(r<<8)|g`). Es decir: en el FBO sobran canales, en el VÉRTICE no. Para 32 bits de id jerárquico hacen falta los 4 canales del vértice, y sólo se liberan si el handle deja de necesitar `r=tileChannel` y `g=angleNorm` — cosa trivial, porque un handle es un DISCO, no un sprite del atlas.

**Forma.**

HANDLES con shaders propios `HANDLE_VERTEX` / `HANDLE_FRAGMENT` (mismo backend `glify.points()`, mismo `bytes===7`, misma esclusa con throw), que sintetizan el disco desde `gl_PointCoord` con `discard` fuera del radio. El gemelo de picking comparte TODO el cuerpo y difiere sólo en la línea de salida — el patrón exacto que ya usa `Picking.attach` sobre `POINT_VERTEX/POINT_FRAGMENT` ⇒ hereda el `discard` ⇒ picking pixel-perfect gratis, y un solo bufferSubData actualiza visual y picking a la vez.
ENCODE en el vértice (reemplaza `#colorAt`):
  `c.r = ((vert >> 8) & 0xff)/255`   // vert = índiceEnChunk + 1  (0 reservado = miss, igual que hoy)
  `c.g = (vert & 0xff)/255`
  `c.b = chunk / 255`
  `c.a = objeto / 255`
FRAGMENT de picking: salida IDENTIDAD (`gl_FragColor = vColor`).
DECODE aditivo en Picking: `#decodeJer(px) => ({ vertice: (px[0]<<8)|px[1], chunk: px[2], objeto: px[3] })`. 🔴 `#decode` actual (`(r<<8)|g`) sigue devolviendo exactamente lo mismo para las capas de puntos existentes, que emiten b=a=0 de salida ⇒ leen chunk 0 / objeto 0. UN píxel, UN readPixels, UN pase, CERO regresión en las capas vivas.
ESTILO DE LOS HANDLES SIN GASTAR BITS: los 4 canales están tomados por el id, así que el color NO viaja en el vértice: el fragment visual lo deriva comparando el id decodificado contra uniforms — `uniform float uHoverId, uActiveId, uHideLo, uHideHi;` + una paleta uniforme. Consecuencia excelente: cambiar hover/activo/oculto cuesta un `uniform1f` + `redraw()`, **cero bufferSubData**, estrictamente mejor que hoy en PointLayer (donde cambiar la variante cuesta `#writeSlot`).
LÍMITE HONESTO: los uniforms sólo expresan estados «es este id» o «está en este rango contiguo». Hover(1), activo(1), los 2 adyacentes(rango) entran; una SELECCIÓN ARBITRARIA de vértices (lazo) no. Salida documentada: robar 4 bits al campo objeto (`a` = 4 bits objeto + 4 bits de flags ⇒ 16 objetos editables simultáneos, de sobra) — el reparto es negociable y el decode es aritmética pura.

**Alternativa descartada.** (a) Compartir bits con `angleNorm`/`tileChannel`: `g` es el ángulo en [0,1] que el fragment usa para rotar el sprite; no se puede compartir sin destruir la precisión angular. (b) Buffer propio para handles fuera de glify: da libertad total de layout pero suma un cuarto contexto y abandona el patrón canónico, que es justo lo que hay que preservar. (c) Segundo FBO/pase para la jerarquía: innecesario — la jerarquía entra en un píxel.

#### RELLENO: stencil-then-cover con VBO de POSICIONES + IBO de aristas (`drawElements(TRIANGLES)`), ancla = v0 del anillo. Mover un vértice = 2 floats

**Por qué.** La formulación «un triángulo (ancla,vᵢ,vᵢ₊₁) por arista» con vértices explícitos triplica la memoria y obliga a reescribir 6 vértices al mover uno. Con índices, el ancla y cada vértice existen UNA sola vez en el VBO, el IBO codifica el abanico, y mover el vértice k es escribir su ÚNICA entrada del VBO. Y si el ancla es v0 (no un vértice extra), no hay ancla que mantener: mover v0 mueve el ancla por construcción. Precisión: glify trabaja en world0 relativo (`project(latLng,0) − mapCenterPixels`), coordenadas chicas ⇒ float32 sobra para los triángulos del abanico.

**Forma.**

VBO: `[x0,y0, x1,y1, …, xN,yN]` (N+1 vértices × 2 floats; v0 es a la vez ancla).
IBO (UNSIGNED_INT, WebGL2): `(0, i, i+1)` para i=1..N−1, más el cierre `(0, N, 1)`. Agujeros = más tripletas del MISMO IBO apuntando al MISMO ancla 0 — literalmente «más aristas del mismo abanico», sin caso especial.
PASE 1 (stencil):
  `gl.enable(gl.STENCIL_TEST); gl.colorMask(false,false,false,false); gl.disable(gl.CULL_FACE)`
  `gl.stencilFunc(gl.ALWAYS, 0, 0xff); gl.stencilOp(gl.KEEP, gl.KEEP, gl.INVERT); gl.stencilMask(0xff)`
  `gl.drawElements(gl.TRIANGLES, idxCount, gl.UNSIGNED_INT, 0)`
PASE 2 (cover):
  `gl.colorMask(true,true,true,true); gl.stencilFunc(gl.NOTEQUAL, 0, 0xff)`
  `gl.stencilOp(gl.KEEP, gl.KEEP, gl.ZERO)`  ← limpia el stencil AL ESCRIBIR: evita un `clear(STENCIL_BUFFER_BIT)` extra y deja el buffer listo para el polígono siguiente.
  `gl.enable(gl.BLEND); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)` (quad del bbox).
MOVER EL VÉRTICE k: `gl.bufferSubData(ARRAY_BUFFER, k*2*4, v, k*2, 2)` — 8 bytes, cero triangulación, el relleno se recalcula solo por frame. Con chunks el IBO se segmenta por offsets ⇒ se pueden saltar chunks fuera del viewport.
🔴 ESCLUSA OBLIGATORIA al crear el contexto (el punto frágil de todo el esquema — un contexto sin stencil falla SILENCIOSAMENTE): `getContext('webgl2', { stencil: true, antialias: true, depth: false, preserveDrawingBuffer: false })` y acto seguido `if (!gl.getContextAttributes().stencil) throw new Error('[cristae] contexto sin stencil; abortar relleno')`. Mismo patrón que `bytes !== 7 → throw`. `stencil` NO se puede activar después de crear el contexto.
MULTI-POLÍGONO: el INVERT de un polígono anularía al otro donde se solapan ⇒ UN par de pases POR polígono editable (el `stencilOp ... ZERO` del pase 2 lo deja limpio). Regla de alcance: el relleno GPU es sólo para las geometrías EN EDICIÓN (unas pocas); las demás siguen por su capa normal. Con 500 polígonos serían 1.000 draws.
REGLA DE LLENADO configurable con coste cero: `fillRule: 'evenodd' | 'nonzero'`. Even-odd (default, lo pedido) = `stencilOp(KEEP,KEEP,INVERT)`. Non-zero = `stencilOpSeparate(FRONT, KEEP,KEEP,INCR_WRAP)` + `(BACK, KEEP,KEEP,DECR_WRAP)` con el mismo `NOTEQUAL 0` — misma estructura, dos llamadas de estado distintas, también sin triangulación. Importa porque en un polígono AUTO-INTERSECANTE even-odd deja los lóbulos solapados HUECOS y el usuario que dibujó un moño puede esperar lo contrario.

**Alternativa descartada.** (a) Triangulación (earcut) — reintroduce preproceso CPU O(n log n) por cada movimiento de vértice, es justamente lo que la propuesta elimina, y se rompe con auto-intersecciones. (b) `TRIANGLE_FAN` por chunk — INCORRECTO: el fan de un chunk cierra implícitamente (v_último→v_primero del chunk), que NO es una arista real del anillo, y eso rompe la paridad. Con `drawElements` el problema desaparece. (c) 3 vértices explícitos por arista — 3× memoria y 6 vértices a reescribir por movimiento en vez de 1.

#### MÁQUINA DE ESTADOS DEL TRASPASO A DOM: el drag lo maneja el editor con pointer capture; los ≤3 nodos DOM son PURAMENTE PRESENTACIONALES

**Por qué.** La propuesta dice literalmente «pero SÓLO como renderer». Además hay una razón dura: si el nodo DOM se crea recién en el `pointerdown` (tras el pick), ese mismo evento ya pasó y el `L.Marker.dragging` nunca arranca ⇒ el usuario tendría que pinchar dos veces. Y si en cambio se espera al hover asíncrono para tener el nodo listo, se depende de un pick que HOY SE DESCARTA: `Picking.request` devuelve false con un pick en vuelo y no encola ni coalesce, así que con el cursor en movimiento se pierden muestras. En hover cosmético eso se tolera; en edición significa «no puedo agarrar el vértice».

**Forma.**

ESTADOS: `IDLE → HOVER(v) → DOM(v) → DRAG(v) → DOM(v) → IDLE`.
 · `IDLE→HOVER(v)`: `collectHoverHit()` entrega `{objeto, chunk, vertice}` → `uniform1f(uHoverId, id)` + `redraw()`. **0 bufferSubData.**
 · `HOVER(v)→DOM(v)`: promover v−1, v, v+1 a nodos DOM presentacionales; ocultar en GPU con `uniform1f(uHideLo, v−1)` + `uniform1f(uHideHi, v+1)` (rango contiguo por construcción) → **0 bufferSubData en handles**; ocultar los 2 segmentos con **1 bufferSubData de 24 elementos** (decisión 4).
 · `DOM(v)→DRAG(v)`: `setPointerCapture` sobre el canvas del mapa. **La GPU no se toca durante el drag**: los 3 nodos + la polyline DOM de 3 puntos son todo el régimen. Cero writes por `pointermove`, cero rAF.
 · `DRAG(v)→DOM(v)` (pointerup): mutar el modelo → `source.patch(id)` → emit COALESCIDO POR EL EMITTER (el reloj que ya existe) → `#onChange` → 3 writes: handles 7 floats CON espejo `#positions`/`#meta`, trazo 24 elementos, relleno 2 floats. Ninguno > 168 bytes.
 · `DOM(v)→IDLE`: `uniform1f(uHideLo, -1)` + restaurar los 4 alphas (1 bufferSubData) + quitar los nodos.
 · `DOM(v)→DOM(w)`: salida + entrada (2 bufferSubData de 24). Simple gana a astuto; el caso |v−w|=1 no merece código propio.
🔴 AGARRE POR `pickSync`, NO POR EL HOVER ASÍNCRONO: el `pointerdown` hace `this.#handles.picking.pickSync(cp.x, cp.y, count, mapMatrix.array, ev)` — un tiro, siempre acierta, inmune al descarte de `request`. El hover asíncrono queda SÓLO para el resaltado cosmético. Así el defecto conocido del picking degrada el brillo, nunca la funcionalidad.
RELOJES USADOS (ninguno nuevo): Emitter de la Source (rAF, ya existe) para el dato; `Picking` (PBO+fenceSync, ya existe) para el hover; el motor (`move`/`moveend`/`zoomend`) para la vista; el `pointermove` del navegador para el drag. Y `layer.redraw()` de glify ya coalesce internamente — lo evidencia la existencia de `cancelPendingRedraw`. Poner coalescencia propia encima de eso ES el rAF doble prohibido.

**Alternativa descartada.** Delegar el drag a `L.Marker.dragging` (el camino «gratis» de Leaflet): ata el arranque del drag al timing del pick asíncrono, que hoy pierde muestras, y convierte los nodos DOM en interacción además de render — contradice «SÓLO como renderer» y hace que la calidad del agarre dependa de la velocidad del cursor.

#### PICKING DEL TRAZO (para insertar vértice en un segmento) = CPU nearest-segment reusando `prepareIndex`/`nearest`, con los CHUNKS como «partes»

**Por qué.** El pick GPU de handles resuelve «qué vértice», pero para insertar en el medio de un segmento largo el cursor puede estar lejos de todo handle y el pick devuelve miss. Meter el trazo en el FBO exigiría un segundo FBO (handles y trazo viven en contextos glify distintos) y duplicar el readPixels. LineLayer ya resuelve exactamente esto por CPU (`#hitsAt`, líneas 90-99) con tolerancia `HIT_TOL_PX + maxWeight/2` escalada por `2 ** map.getZoom()`, y devuelve `partIndex`/`vertexIndex` — que con chunks como partes ES la coordenada jerárquica {chunk, vértice} que necesitamos, ya calculada.

**Forma.**

El índice se construye con las mismas piezas: `prepareIndex(chunks.map(c => ({ id, parts: toParts(c.path) })))`. El hit devuelve `{ id, distancePx, partIndex, vertexIndex }` → `{objeto: id, chunk: partIndex, vertice: vertexIndex}`. La tolerancia sale de `HIT_TOL_PX + #maxWeight/2` como en LineLayer.
RE-INDEX: LineLayer re-indexa TODO cuando `geomDirty` (líneas 139-142) — O(n) de CPU. Con chunks eso debería reducirse a re-indexar el chunk tocado; si `prepareIndex` no admite reemplazo parcial de una parte, el fallback es re-indexar completo SÓLO en el `pointerup` (no durante el drag, donde el índice no se consulta) — el costo O(n) una vez por gesto es invisible. Está en dependencias.
El registro del hit lo envuelve el motor con layerId/kind/z/order, igual que hoy.

**Alternativa descartada.** Segundo FBO para el trazo: duplica el readPixels y el presupuesto de memoria del picking, que ya es el defecto conocido (~50 MB para leer 144 bytes), y no aporta nada que el nearest-segment ya probado no dé — el trazo, a diferencia del sprite, no necesita precisión por silueta.

## Plan de implementación

### picking-jerarquico

1. **P0 — Confirmar los 3 supuestos de frontera antes de tocar código: (a) `cx,cy` en píxeles de dispositivo; (b) dónde y con qué frecuencia se llama `collect()`; (c) qué hace el motor con el `false` de `request()`. Son las tres cosas que cambian el diseño si están al revés.**
   - Archivos: (sólo lectura / consulta al área del motor — src/engine/MapEngine.js es de otro agente)
   - Verificación: Respuestas escritas de las tres. Si (b) no tiene punto de poll garantizado en reposo, P2 no se cierra hasta que exista, y NO se compensa con timers.
2. **P1 — Micro-target: renderbuffer RGBA8 de 6×6 sin depth, offset por viewport, sin scissor, sin clamping de parche, `syncSize()` no-op, `detach()` sin `deleteRenderbuffer(depth)`. Sin tocar encoding ni API pública. Incluye el self-test de `attach()` que elige `offsetMode` viewport|matrix.**
   - Archivos: C:/serv_desa/Sitios_Web/Cristae/src/render/Picking.js
   - Verificación: (1) Igualdad de resultados: para un mismo escenario, `pickSync` micro vs. la implementación full-res anterior devuelve los mismos hits en 200 posiciones aleatorias + las 4 esquinas + (0,0) y (w−1,h−1). (2) Sprite grande con centro 18 px fuera del parche: sigue devolviendo su id (es el caso que distingue viewport de matriz escalada). (3) Espía sobre `gl.createRenderbuffer`/`createTexture`: 200 `syncSize()` consecutivos crean CERO objetos. (4) Ahorro por fórmula, reportado: 49.766.256 B a 1920×1080 DPR2.
3. **P2 — Coalescing: mailbox de un slot, `request` que nunca rechaza por ocupado, `#flush()` en el punto de liberación de `#inFlight` (incluida la rama WAIT_FAILED), `abort()` que vacía el mailbox, getter `busy`. Orden obligatorio getBufferSubData → decode → flush.**
   - Archivos: C:/serv_desa/Sitios_Web/Cristae/src/render/Picking.js
   - Verificación: Test de máquina de estados con un doble de `gl` (sin GPU): fence sintético controlable. (a) 100 `request` con `collect` cada 10 → el último request SIEMPRE se entrega y las coordenadas entregadas son las del último request previo a cada emisión; cero pedidos perdidos del más reciente. (b) `WAIT_FAILED` no traba el mailbox (el siguiente `collect` emite el encolado). (c) `abort()` en FLIGHT+QUEUED deja IDLE. (d) `#issue` degenerado no re-encola. (e) Asertar que `getBufferSubData` se llama antes de cualquier `readPixels` del pedido siguiente (orden de llamadas en el doble).
4. **P3 — Encoding jerárquico: `uPickTag` en el fragment de picking, factory con parámetro `decls`, `#decode` a `PickHits` reusado con recorrido centro-hacia-afuera, semántica slot −1, skip de `obj === 0`. La capa de puntos existente pasa a emitirse con un obj asignado (≥1) y chunk 0.**
   - Archivos: C:/serv_desa/Sitios_Web/Cristae/src/render/shaders.js · C:/serv_desa/Sitios_Web/Cristae/src/render/Picking.js
   - Verificación: (1) Codec puro en JS (sin GPU): round-trip de (obj,chunk,slot) en los extremos — (1,0,0), (255,255,65534), (1,0,−1), (0,·,·)→nada — y barrido exhaustivo de los 256 valores de cada byte. (2) GPU: tres objetos con sprites superpuestos en el mismo píxel → gana el último emitido, y los tres aparecen en `hits` si caen en texeles distintos del parche. (3) Precisión del uniform: emitir los 255 valores de obj y verificar que el byte leído es idéntico (cierra la duda de mediump/highp con datos, no con teoría). (4) No regresión: los hits de la capa de puntos coinciden 1:1 con los `slots` que devolvía el decode viejo, para 200 posiciones.
5. **P4 — Batch multi-draw + registro de programas: `registerProgram`, `PickDraw`/`PickBatch`, bucle de draws con cambio perezoso de programa/textura/matriz, orden de emisión = z ascendente. `attach()` se conserva y registra la clave 'point'.**
   - Archivos: C:/serv_desa/Sitios_Web/Cristae/src/render/Picking.js
   - Verificación: (1) Un batch con 1 draw reproduce exactamente P3 (no regresión). (2) Batch de 64 chunks × 4.096 vértices: `pickSync` con culling de bbox toca 1–2 chunks y su tiempo es independiente del total — medir con 4.096, 262.144 y 1.048.576 vértices y comprobar que la mediana no crece con N. (3) [0-alloc]: 1.000 picks consecutivos sin crear objetos (perfil de asignaciones plano; los `PickDraw` los recicla el llamador).
6. **P5 — Handles: sprite del atlas con alpha de silueta dura, apagado de los 3 vértices DOM-activos por tile transparente (bufferSubData de 3 vértices contiguos), handles emitidos últimos en el batch.**
   - Archivos: C:/serv_desa/Sitios_Web/Cristae/src/render/Picking.js (orden/validación) — el tile y el buffer son del área de la capa editable
   - Verificación: (1) E2E manual: dos handles a 4 px de distancia — el `hits[0]` corresponde SIEMPRE al que está bajo el cursor (esto es lo que valida el orden centro-afuera). (2) Con el vértice v activado en DOM, el pick GPU no devuelve v (ni visual ni pick) y sí devuelve el segmento de abajo. (3) Handle sobre un vehículo de la flota: gana el handle. (4) Con `I18N`-nada que ver: nada que traducir acá — verificación puramente de interacción.
7. **P6 (opcional, requiere OK del líder) — Parche dimensionado en píxeles CSS (`clamp(round(7*DPR), 6, 16)`), buffers al máximo y ORDER recalculado sólo al cambiar el DPR.**
   - Archivos: C:/serv_desa/Sitios_Web/Cristae/src/render/Picking.js
   - Verificación: Medir la tolerancia efectiva de hover en CSS px a DPR 1 y DPR 2: debe ser la misma (hoy se reduce a la mitad en HiDPI). Confirmar que `#buf` y el PBO siguen siendo ≤1 KB y que el recálculo de ORDER ocurre 0 veces por frame.

### chunking

1. **`ChunkedPath` puro: sin GL, sin Leaflet, sin Source. Arena (xy/role/slot), SoA de chunks (first/used/next/prev + free-list), las cuatro operaciones, pop/setClosed/reset, walk de serialización y el registro de rangos sucios.**
   - Archivos: nuevo `src/data/ChunkedPath.js`; nuevo `test/chunked-path.test.js`
   - Verificación: `node --test test/chunked-path.test.js`. Oráculo diferencial: 100.000 operaciones aleatorias (move/insertAfter/remove/append/pop/setClosed) contra un Array de pares de referencia; tras CADA operación, el walk debe ser idéntico al oráculo. Invariantes aserteadas por operación: `first` par, `used` par, `used ≤ C`, `first+used ≤ C`, ocupación ≥ C/2 salvo chunk único, lista `next/prev` consistente y de largo igual a la cantidad de chunks vivos, ningún slot vivo alcanzable por dos chunks, `count` igual al del oráculo, free-list disjunta de la lista viva.
2. **Demostrar el tiempo constante por conteo de trabajo, no por reloj: instrumentar cada operación con `entradasEscritas` y `chunksSucios`.**
   - Archivos: `src/data/ChunkedPath.js` (contador bajo flag); nuevo `test/chunked-path-costo.test.js`
   - Verificación: El mismo guión de operaciones con N = 10, 1.000 y 100.000 vértices; asertar `max(entradasEscritas) ≤ 2·C` y `max(chunksSucios) ≤ 3` en los tres, y que ambos máximos NO crecen con N. El cronómetro se evita a propósito: el conteo de trabajo es determinista y el reloj en esta máquina es ruido.
3. **Capa GL del arena: los dos VBOs (data entrelazado [x,y,role] y slot estático), los dos pases con offset 0/1 y stride 2 entradas, el flush por rangos sucios con staging reusado, y el grow con `bufferData` + re-bind.**
   - Archivos: nuevo `src/render/EditableArenaLayer.js`
   - Verificación: Test con un `gl` mock que registra llamadas: por operación, ≤3 `bufferSubData`; cada uno con `byteOffset` alineado al chunk y `length ≤ C·stride`; `bufferData` y re-bind SÓLO en grow; el VBO de slots no se reescribe fuera de grow; exactamente 2 `drawArrays` por objeto y por frame, sea N=3 o N=400.000; y — el aserto que cierra el hallazgo de glify — tras un render simulado el contenido del buffer conserva los writes incrementales.
4. **Empaquetado/desempaquetado de picking contra `PICK_BITS`, con la aritmética del shader replicada en JS.**
   - Archivos: nuevo `src/render/pick-codec.js` (tabla `PICK_BITS` + encode/decode); nuevo `test/pick-codec.test.js`
   - Verificación: Round-trip exhaustivo de bordes: objectId 1 y 255; slot 0, 1, 1023, 1024, 65535, 65536, 2^24−1. El píxel (0,0,0,0) decodifica a MISS. Para 10.000 slots aleatorios, la fórmula de floor/división que va al fragment produce byte a byte lo mismo que el encode de referencia. `chunk = slot>>10` y `offset = slot&1023` coinciden con la ubicación real que reporta `ChunkedPath`.
5. **Source de trazos: un ítem por anillo/path sobre `createSource`, con `hashOf = r => r.rev`, Set de sucios reusado y el cursor perezoso de `pathOf`.**
   - Archivos: nuevo `src/data/editable-source.js`
   - Verificación: Test de identidad del Set de sucios entre emits (misma referencia, sólo clear/add) — el repo ya tiene un test análogo para el Store. Asertar que `patch` nunca cambia largo ni orden del array de ítems (snapshot antes/después). Una edición de vértice produce exactamente UN notify por frame con UN id sucio (Emitter con defer rAF, sin timers nuestros).
6. **Cablear `EditableGeometry` para polygon/polyline al arena, dejando point y rectangle exactamente como están. `#settle` conserva su contrato con cuerpo O(1); `setValue` gana el guard de identidad; `#ingest` alimenta `reset(pairs)` conservando el saneo con `toFinitePair`.**
   - Archivos: `src/render/EditableGeometry.js`; nuevo `test/editable-geometry-contrato.test.js`
   - Verificación: Test de EQUIVALENCIA contra la implementación actual: un guión de gestos (ingest multi-anillo y anillo simple, drag de 30 frames, insert en 3 segmentos distintos incluyendo el de cierre, delete por debajo y por encima del mínimo, dblclick de cierre con clicks duplicados, `setValue` con coordenadas basura mezcladas) corrido contra ambas implementaciones: las secuencias de `onChange` y `onCommit` deben coincidir valor por valor y en cantidad. Además: `setValue` no emite jamás; round-trip bit-exacto con coordenadas de 17 dígitos; la salida conserva la forma de la entrada (`#simpleRing`).
7. **Activación DOM bajo demanda: `#resolveActive`, la máquina IDLE/HOVER/DRAG, el candado estructural y la supresión GPU (`role = 3`) del vecindario activo.**
   - Archivos: `src/render/EditableGeometry.js`
   - Verificación: En todo el guión de gestos, `#group.getLayers().length ≤ 3` en cualquier instante. Ninguna operación estructural corre con drag activo (el candado tira y el test lo captura). Un pick sellado con un `structRev` viejo se descarta. Los tres slots activos reportan `role === 3` y vuelven a 1 al soltar.
8. **Casos límite de escala y de forma, corriendo el modelo puro (no hace falta GPU).**
   - Archivos: nuevo `test/chunked-path-escala.test.js`
   - Verificación: Ingest de 400.000 vértices → cantidad de chunks igual a ceil(400.000/256) y `byteLength` del arena igual al esperado. Barrido "borrar uno de cada dos vértices en todo el trazo" → asertar entradas asignadas ≤ 4·N + C (ocupación ≥ 50%) y que el walk sigue coincidiendo con el oráculo. Anillo colapsado a un punto: el pick devuelve slot PAR (el vértice gana el desempate). Anillo de 3 vértices: delete rechazado por MIN_VERTICES; path de 2: idem. Trazo de 1 vértice en modo draw: `used = 2` con el midpoint en role 0.

### relleno-stencil

1. **Cerrar las dos preguntas que condicionan TODO el resto antes de escribir una línea: (a) confirmar que `L.Path` de Leaflet trae `fillRule:'evenodd'` por defecto — si fuera `nonzero`, el diseño cambia de regla; (b) confirmar con el área del motor si el trazo del contorno vivirá en NUESTRO contexto o en glify.Lines.**
   - Archivos: Leaflet/src/layer/vector/Path.js (sólo lectura, un grep de `fillRule`); acuerdo con el área de motor/geometría
   - Verificación: Respuesta escrita a ambas. (a) determina la regla de stencil; (b) determina si se ahorra un contexto y si el desfase de zoom desaparece por construcción.
2. **Arreglar `pointInPoly` de OR a XOR (par-impar multi-anillo) y agregar `flattenRings` en `geometry/polygon.js`.**
   - Archivos: C:/serv_desa/Sitios_Web/Cristae/src/geometry/polygon.js
   - Verificación: `node --test` con casos: cuadrado con agujero centrado (punto en el agujero ⇒ false, antes true), isla dentro de laguna (⇒ true), agujero con winding invertido (⇒ mismo resultado), anillos disjuntos (⇒ true en cada uno), anillo vacío y anillo de 2 puntos (⇒ false, sin excepción). `bunx eslint` sobre el archivo. Regresión: `PolygonLayer.#hitsAt` no cambia de firma.
3. **Agregar `bboxToRect`, `padRect` e `isFiniteRect` en `geometry/bbox.js` (adaptador entre los dos vocabularios de rectángulo que ya conviven ahí).**
   - Archivos: C:/serv_desa/Sitios_Web/Cristae/src/geometry/bbox.js
   - Verificación: `node --test`: `area(intersect(padRect(bboxToRect(bboxOfPoints(pts)),1), rectViewport))` da 0 cuando el polígono está fuera de pantalla y el área esperada cuando lo cruza; `isFiniteRect(bboxToRect(bboxOfRings([])))` es `false`. `bunx eslint`.
4. **Banco de geometrías patológicas reutilizable por todas las áreas: convexo simple, cóncavo tipo peine, espiral, figura-ocho auto-intersectada, exterior+1 agujero, exterior+agujero+isla, agujeros con winding invertido, anillos disjuntos, 400 / 5.000 / 50.000 vértices, coords no finitas, anillo cerrado con duplicado.**
   - Archivos: nuevo: Cristae/test/fixtures/polygons.js
   - Verificación: Cada fixture trae su ORÁCULO: la función `pointInPoly` (ya XOR) es la verdad de referencia. `node --test` valida que los fixtures son estables (bbox y conteo de vértices esperados).
5. **Prototipo mínimo de contexto: crear canvas + `getContext('webgl2',{stencil:true,depth:false,antialias})`, medir. NO integrar todavía.**
   - Archivos: nuevo: Cristae/dev/stencil-probe.html
   - Verificación: Aserta `gl.getContextAttributes().stencil === true`; reporta `gl.getParameter(gl.SAMPLES)` y `gl.getParameter(gl.STENCIL_BITS)`; mide la memoria del proceso con y sin `antialias` (tabla real, no estimada, contra los ~41 MB / ~200 MB del diseño); confirma que `canvas.width=1` baja la memoria SIN perder el contexto (`gl.isContextLost() === false`).
6. **`stencil-shaders.js`: VS/FS attributeless del abanico (gl_VertexID + texelFetch, `u_matrix`/`u_ringStart`/`u_ringCount`/`u_bridge`) y VS/FS del quad de cobertura (`u_rect`/`u_color`). Espejo estructural de `render/shaders.js`.**
   - Archivos: nuevo: C:/serv_desa/Sitios_Web/Cristae/src/render/stencil-shaders.js
   - Verificación: Compilan y linkean sin warnings; test de shader aislado que dibuja UN triángulo conocido y lee 3 píxeles esperados por `readPixels`.
7. **`StencilFill.js`: ciclo de vida (attach/moveVertex/setRings/setStyle/detach/destroy), textura RG32F, `#bbox` monótono, máquina de estado de los dos pases, scissor, `#schedule()` de un solo rAF.**
   - Archivos: nuevo: C:/serv_desa/Sitios_Web/Cristae/src/render/StencilFill.js
   - Verificación: TEST DORADO (el que decide si el diseño es correcto): para cada fixture del banco, muestrear K=2.000 píxeles aleatorios, comparar `alpha≠0` del `readPixels` contra `pointInPoly(lat,lng,rings)` del centro del píxel desproyectado; exigir 100 % de coincidencia en píxeles a más de 1,5 px de cualquier arista. Cubre de una sola vez cóncavos, auto-intersecciones, agujeros y winding inconsistente. TEST DE FUGA DE STENCIL: tras dibujar cada objeto, quad a pantalla completa con `stencilFunc(NOTEQUAL,0,0x01)` en color chillón ⇒ cero píxeles. TEST O(1): `moveVertex` en el fixture de 50.000 vértices no dispara ninguna escritura mayor a 8 bytes (espiar `texSubImage2D`) y el tiempo por movimiento es plano respecto de n.
8. **Medición de fill-rate en el banco, con y sin scissor, con y sin MSAA.**
   - Archivos: Cristae/dev/stencil-probe.html + fixtures
   - Verificación: `EXT_disjoint_timer_query_webgl2` sobre el pase 1: tabla ms vs. n (400/5.000/50.000) × cobertura de pantalla (10 %/100 %) × samples (1/4). Criterio de aceptación: <4 ms en el caso de edición realista (zoom puesto, bbox visible ≤25 % de pantalla). Si el peor caso a pantalla completa supera 16 ms, se activa el umbral de conmutación a triangulación cacheada para el estado NO-arrastrando.
9. **Integración con el store de vértices del área (1)/(3): consumir su `Float32Array` en world0 relativo al ancla y su layout de chunks, sin duplicar posiciones.**
   - Archivos: C:/serv_desa/Sitios_Web/Cristae/src/render/StencilFill.js + interfaz acordada con el store
   - Verificación: Un solo dueño de las posiciones (aserto: `fill.positions === store.positions`). Prueba de composición: partir un anillo de 10.000 vértices en chunks de 4.096 y verificar que el test dorado da EXACTAMENTE el mismo resultado que sin chunkear (la paridad compone porque el ancla es implícita y compartida). Prueba de inserción: insertar un vértice reescribe UN chunk (≤C texels), no la textura.
10. **Integración con el motor: pane/z, enganche a los eventos de movimiento y al mecanismo de animación de zoom que ya usan las capas GL, `destroy()` con `loseContext()`.**
   - Archivos: C:/serv_desa/Sitios_Web/Cristae/src/render/StencilFill.js + puntos de enganche del motor (área hermana)
   - Verificación: Grabación de un pan+zoom+arrastre: relleno y trazo nunca se separan (comparación cuadro a cuadro del borde). Ciclo entrar/salir de edición ×50 ⇒ el contador de contextos WebGL no crece. Mapa quieto + repintes ajenos ⇒ el relleno no se vacía.
11. **Comparación visual contra el renderer actual y decisión final de `antialias`.**
   - Archivos: Cristae/dev/stencil-probe.html vs. PolygonLayer (L.polygon)
   - Verificación: Mismo polígono, mismo color, lado a lado, borde diagonal, a DPR1 y DPR2, con contorno de 1 px / 2 px / oculto. Criterio: con contorno visible, indistinguible. Sin contorno y a DPR1 es donde se ve la escalera — ése es el dato que decide si se paga MSAA.

### traspaso-dom

1. **LayerRegistry: extraer `#collect(baseEvent, partsOf)` del cuerpo de `resolveHits` y agregar `resolveHitsForChannels(channelMask, baseEvent)` sobre él. `resolveHits` y `hasHitForChannels` conservan su firma y su semántica exactas.**
   - Archivos: src/interaction/LayerRegistry.js
   - Verificación: Test unitario: (a) con todas las capas declarando EVENT_HOVER, `resolveHitsForChannels(PICK_CHANNELS, e)` devuelve lo MISMO que `resolveHits('hover', e)` (orden incluido); (b) una capa sólo-CLICK aparece en `resolveHitsForChannels` y NO en `resolveHits('hover')`; (c) `capture` recorta y `presentAs` antepone igual en ambos caminos.
2. **Interaction: `#setCursor` de booleano a string con un único sitio de asignación (`this.#handover?.cursor || (hit ? 'pointer' : '')`), conservando el guard de identidad.**
   - Archivos: src/engine/Interaction.js
   - Verificación: Test: sin handover inyectado, la secuencia de valores escritos en `container.style.cursor` es idéntica a la actual (`''`/`'pointer'`) para entrar, salir, zoom y demanda-a-cero. Contador de escrituras al DOM sin cambios (el guard de identidad sigue absorbiendo repetidos).
3. **`HandleBank`: 3 nodos de rol fijo + host focusable, creados una vez en un pane propio bajo `mapPane`, sin ningún listener.**
   - Archivos: src/interaction/HandleBank.js (nuevo)
   - Verificación: Aserto `pane.childElementCount === 4` (3 handles + host) inmediatamente tras construir y tras 1.000 ciclos `show/hide` aleatorios; `visibleCount() === 0` tras `hide()`; un wrapper espía de `EventTarget.addEventListener` confirma 0 registros sobre los nodos del banco.
4. **`DomHandover`: máquina IDLE↔ARMED (todavía sin drag) + enganche en `#emitHover` (armar/re-armar/desarmar desde la lista canónica) y en `#endHover` (desarmar).**
   - Archivos: src/interaction/DomHandover.js (nuevo), src/engine/Interaction.js
   - Verificación: Test de transiciones sobre picks simulados: mover sobre un vértice arma con roles prev/active/next correctos; mover a otro vértice re-arma reusando los mismos 3 nodos (identidad de nodo estable, `===`); salir del vértice desarma; `movestart`, `zoomstart`, `pointerleave` y `syncHoverDemand()` con demanda 0 desarman. En todas las transiciones `pane.childElementCount` sigue en 4.
5. **Listeners `pointerdown`/`pointerup`/`pointercancel` (`{passive:false}` en el down) + `#beginDrag`/`#endDrag` + `#lockCamera`/`#unlockCamera` + captura de puntero en el contenedor. `#onPointerMove` deriva a `#trackDrag` antes del gate de hover.**
   - Archivos: src/engine/Interaction.js
   - Verificación: 🔴 EL TEST DE LA COSTURA: emitir `pointermove(x,y)` y `pointerdown(x,y)` en la MISMA tarea (0 frames transcurridos, ningún `collectHoverHit` resuelto) ⇒ `#drag.active === true` y el índice de vértice es el esperado (camino de caché por píxel). Variante touch: `pointerdown` SIN move previo ⇒ mismo aserto (camino `pickHitSync`). Property test: con los 5 handlers de cámara en estados aleatorios previos, tras `pointerup`/`pointercancel`/`lostpointercapture` cada uno queda exactamente como estaba.
6. **Escritura coalescida por frame (un solo `rafId ??= raf(...)`), snapshot `#drag.origin`, slop de 3 px y supresión del click de cierre.**
   - Archivos: src/engine/Interaction.js
   - Verificación: Espía de `requestAnimationFrame`: en 200 `pointermove` sintéticos repartidos en 20 frames se registran ≤20 llamadas (nunca 200, nunca 2 por frame). Un drag de >3 px NO emite `cristae:click` ni dispara `onEmptyClick`; un pointerdown/up de ≤3 px SÍ emite click y el hit es el vértice.
7. **Registro de las dos entradas (`edit:handles` con `capture`, `edit:fill` sin) con zIndex explícito y `declOrder` capturado una vez; forzado de `activeMask` + `syncHoverDemand()` en `enable()`.**
   - Archivos: src/interaction/DomHandover.js, + punto de alta en la capa de edición (fuera de mi área)
   - Verificación: Hover sobre un vértice que está encima de un marcador ⇒ `resolveHits` devuelve exactamente 1 hit y es el vértice. Hover sobre el relleno del polígono ⇒ el hit del marcador de abajo SIGUE llegando. Togglear editing 10 veces ⇒ `declOrder` de ambas entradas invariante y el orden relativo contra una capa del mismo zIndex es estable.
8. **Teclado: `keydown` no-passive en el contenedor, foco programático al confirmar el pointerdown, flechas / Shift+flechas / Escape / Delete por el mismo camino de escritura que el drag.**
   - Archivos: src/engine/Interaction.js, src/interaction/HandleBank.js
   - Verificación: `Escape` a mitad de drag restaura la posición ORIGINAL exacta (comparación de floats contra `#drag.origin`) y desbloquea la cámara. Flechas mueven 1 px y Shift+flechas 10 px medidos en containerPoint, sin scrollear la página (`defaultPrevented === true`). Recorrido con lector de pantalla: el host anuncia el vértice activo y su índice.
9. **Banco de medición contra la implementación DOM actual, con N ∈ {100, 400, 2.000, 10.000} vértices.**
   - Archivos: bench/ (fuera de mis 3 archivos)
   - Verificación: Nodos DOM = 4 constante contra 2N−1 (799 en N=400); listeners = 8 en el contenedor (4 existentes + pointerdown/up/cancel/keydown) y 0 en los nodos, contra 2·(2N−1) (1.599 en N=400); tiempo de inserción de un vértice con pendiente PLANA en N (es el aserto que valida el chunking end-to-end); un drag de 3 s no baja de 60 fps en ninguno de los cuatro N. Honestidad: la pendiente plana sólo se puede afirmar midiendo — hasta correrlo es una expectativa derivada del bufferSubData de rango acotado, no un hecho.
10. **(Opcional, cierra el hueco del puntero quieto) Re-lectura de la muestra en `#endInteraction`.**
   - Archivos: src/engine/Interaction.js
   - Verificación: `zoomend` con el puntero quieto sobre un vértice re-arma el banco y actualiza el cursor; espías de `setTimeout`/`setInterval`/`requestAnimationFrame` confirman 0 timers y ≤1 rAF (el del poll de picking). Regresión: sin capa de edición, el cursor tras un wheel-zoom sobre un marcador ahora queda correcto donde antes quedaba viejo.

### integracion-gpu

1. **0. Esqueleto `EditableGeometryLayer` con la superficie completa del contrato canónico (los 11 puntos del checklist) y las esclusas con throw. Sin datos: sólo lifecycle, delegación a 3 sub-capas y teardown en el orden normativo.**
   - Archivos: src/render/EditableGeometryLayer.js (nuevo) — contrato extraído de src/render/PointLayer.js + src/render/LineLayer.js
   - Verificación: El motor la registra como una capa más; `count === 0`; `destroy()` deja los 3 contextos perdidos (afirmar que `gl.isContextLost()` es true en los tres, o que `getExtension('WEBGL_lose_context')` fue invocado por `loseGlContext`); ningún método del contrato queda sin implementar (test de superficie contra la lista de nombres que invoca MapEngine).
2. **1. Sub-capa de HANDLES sola: `glify.points()` con `HANDLE_VERTEX`/`HANDLE_FRAGMENT` (disco procedural desde `gl_PointCoord` + `discard`), id de 32 bits en r,g,b,a, estilo derivado de uniforms. Sin chunking, sin picking todavía.**
   - Archivos: src/render/EditHandleLayer.js (nuevo), src/render/shaders.js (agregar HANDLE_VERTEX/HANDLE_FRAGMENT + su gemelo de picking)
   - Verificación: 400 handles visibles y redondos; `layer.bytes === 7` (la esclusa no dispara); 🔴 TEST T-ESPEJO: mover un slot por la ruta incremental, luego `layer.layer._reset(); layer.layer.redraw()` y afirmar que la posición NO revierte — si revierte, falta `#positions`/`#meta`. Y `uniform1f(uHoverId, k)` cambia el color del handle k sin un solo bufferSubData (contador de bufferSubData en 0).
3. **2. Picking jerárquico: `#decodeJer` aditivo en Picking y cableado del `requestHoverHit`/`collectHoverHit`/`pickSync` de la sub-capa de handles.**
   - Archivos: src/render/Picking.js (agregar decode jerárquico, sin tocar `#decode`), src/render/EditHandleLayer.js
   - Verificación: (a) `readPixels` sobre un handle conocido devuelve `{objeto, chunk, vertice}` exactos, incluido `objeto=200` (esto es lo que atrapa el BLEND del pase de picking: si `px[3] !== 200`, hay blending activo); (b) REGRESIÓN OBLIGATORIA: todos los tests existentes de picking de PointLayer pasan SIN tocar PointLayer — `(r<<8)|g` sigue devolviendo el mismo id; (c) `vertice === 0` ⇒ miss (el `+1` de la reserva se conserva).
4. **3. Chunking con CAPACIDAD FIJA C=512 y centinelas, primero sólo en handles (más simple: no hay pairing de segmentos).**
   - Archivos: src/render/EditHandleLayer.js, src/geometry/chunking.js (nuevo: partición, split de chunk lleno, mapeo global↔{chunk,índice})
   - Verificación: 🔴 La medición que decide si la propuesta cumple: contador de llamadas a `#rebuild`; sobre una geometría de 5.000 vértices, 255 inserciones ⇒ EXACTAMENTE 1 rebuild (el split), y cada inserción sube ≤ 14.336 bytes (C×7 floats) en UN bufferSubData. Afirmar además que el tiempo por inserción es independiente de N (medir con N=500 / 5.000 / 50.000: la curva debe ser plana).
5. **4. Sub-capa de TRAZO: `glify.lines()` con los chunks como partes de un MultiLineString, solapamiento de 1 punto en cada frontera, `#weightByPart` al día en el path incremental.**
   - Archivos: src/render/EditStrokeLayer.js (nuevo, forma de src/render/LineLayer.js)
   - Verificación: `layer.bytes === 6`; sin HUECO visual en las fronteras de chunk: renderizar 5.000 vértices con C=512 (10 fronteras) y comparar píxel a píxel contra el mismo trazo emitido como una sola parte — diff = 0. Y afirmar que `vertCount` de cada parte es constante 1022 tras 100 ediciones.
6. **5. CORTE por alpha 0 en 4 vértices contiguos, con `#applyCut()` invocado DENTRO de `#bind()` junto a `#applyGradient()`.**
   - Archivos: src/render/EditStrokeLayer.js
   - Verificación: Activar el vértice i y afirmar por `readPixels` que los píxeles del eje de los segmentos (i−1,i) y (i,i+1) tienen el color de fondo. 🔴 LUEGO forzar un `setData` (insertar un vértice en otro chunk) y RE-AFIRMAR que sigue cortado — esta segunda aserción es la que expone el olvido de re-aplicar tras `#bind`. Casos borde obligatorios: i=0 abierto (1 subida de 12), i=K−1 (1 de 12), i=0 en polígono CERRADO (2 subidas), i en frontera de chunk (2 subidas).
7. **6. Máquina de estados del traspaso a DOM: pointer capture propio, ≤3 nodos presentacionales, uniforms de rango para ocultar handles, `pickSync` en el `pointerdown`.**
   - Archivos: src/edit/VertexHandoff.js (nuevo), src/render/EditableGeometryLayer.js
   - Verificación: (a) Durante un drag de 3 s: contador de bufferSubData en 0 y nodos en el pane de edición ≤ 3 markers + 1 polyline; (b) contador de rAF propios del editor = 0 (el único reloj es el Emitter de la Source); (c) 100 `pointerdown` con el cursor a alta velocidad ⇒ 100 aciertos (el hover asíncrono fallaría; `pickSync` no); (d) al soltar, exactamente 3 bufferSubData (handles/trazo/relleno) y ninguno > 168 bytes.
8. **7. Sub-capa de RELLENO: contexto propio con `stencil:true` + esclusa, VBO de posiciones + IBO de aristas con ancla v0, dos pases con `stencilOp ... ZERO` en el cover, `fillRule` configurable.**
   - Archivos: src/render/EditFillLayer.js (nuevo), src/render/shaders.js (FILL_STENCIL_* y COVER_*)
   - Verificación: Diff de píxeles contra un `L.Polygon` de Leaflet (que rellena con even-odd del navegador) para: cóncavo en L, moño auto-intersecante, y anillo con agujero. Tolerancia sólo en el borde antialiaseado (≤2 px de ancho). Luego mover un vértice y afirmar que el relleno lo sigue con UN bufferSubData de 8 bytes y CERO llamadas a triangulación. Y afirmar que dos polígonos solapados en edición se rellenan correctamente ambos (prueba de que el `ZERO` del cover limpia el stencil).
9. **8. `renderAtView` en las tres sub-capas + `#suppressGlifyZoom` donde corresponda.**
   - Archivos: src/render/EditFillLayer.js, src/render/EditHandleLayer.js, src/render/EditableGeometryLayer.js
   - Verificación: Zoom animado (el ViewAnimator interpolando zoom y center) con la geometría en pantalla: capturar frames y afirmar que el desfase entre el borde del relleno, el trazo y los handles no supera 1 px en ningún frame. Sin `renderAtView` en el relleno el desfase es de decenas de px — la prueba distingue claramente.
10. **9. Presupuesto de contextos y ciclo de sesiones de edición.**
   - Archivos: src/render/EditableGeometryLayer.js
   - Verificación: 30 ciclos `beginEdit`/`endEdit`: el nº de contextos WebGL vivos se mantiene en 3 (no crece), no se dispara `webglcontextlost` en el mapa base, y la memoria de GPU reportada por `WEBGL_debug_renderer_info`/heap no crece monótonamente. Al final, `destroy()` y afirmar 0.
11. **10. Casos límite de escala y robustez, con la geometría más grande que se pueda construir.**
   - Archivos: tests/edit-geometry-stress
   - Verificación: (a) 50.000 vértices: primer paint, tiempo de inserción y tiempo de drag medidos y comparados contra el DOM actual (799 marcadores para 400 vértices) — reportar el factor real, no una estimación; (b) polígono con 12 agujeros + auto-intersección: relleno correcto y picking del vértice correcto en cada anillo; (c) geometría con TODOS los chunks llenos (split en cascada); (d) drag de un vértice mientras se panea y se zoomea simultáneamente: sin desincronización entre los nodos DOM y la GPU.

## Riesgos y casos límite

### picking-jerarquico

- **El id de picking viaja en un `varying` (vColor). En PUNTOS la primitiva tiene un solo vértice, así que el varying es constante sobre el sprite; en LÍNEAS/TRIÁNGULOS (el pase de segmentos) el varying SE INTERPOLA entre extremos con ids distintos y el píxel del medio devuelve un id inventado, que además puede decodificar a un vértice REAL y equivocado.**
  - Mitigación: El id debe ser CONSTANTE por primitiva: los vértices expandidos de cada segmento llevan todos el id del extremo inicial (es gratis si el backend de líneas ya expande segmento por segmento; ver dependencia). Alternativa si comparte vértices: programa de picking de segmentos en `#version 300 es` con `flat out uint`. Verificación barata antes de escribir código: pickear el centro de un segmento largo y comprobar que devuelve exactamente el índice del extremo inicial.
  - Caso límite: Segmento entre los vértices 100 y 101: en el centro del trazo el interpolado da b,a ≈ el promedio, que se lee como el vértice ~100,5 → redondeos que caen en 100 o 101 según el píxel, y con extremos lejanos en el índice (cierre de anillo: vértice 399 → vértice 0) devuelve cualquier id intermedio. ESSL1 no tiene el calificador `flat`.
- **El viewport de origen negativo o los point sprites cuyo centro cae fuera del framebuffer podrían comportarse distinto en algún driver/ANGLE: el sprite no se rasterizaría y el picking pixel-perfect de vecinos se perdería sin error visible.**
  - Mitigación: Self-test en `attach()` (≈0,2 ms, una vez): dibujar un punto sintético grande con centro fuera del parche y verificar que el texel central trae su id; si falla, conmutar a la ruta de matriz con traslación PURA (nunca escala) y dejarlo expuesto en `offsetMode`. Segundo test de borde: cursor en (0,0) y en (w−1,h−1) — el texel del cursor debe seguir siendo (3,3) y el resultado coincidir con la ruta full-res.
  - Caso límite: Cursor sobre la cola de un sprite de vehículo de 40 px cuyo centro está 18 px fuera del parche 6×6: hoy el scissor deja pasar ese fragmento; con el micro-target depende de que el rasterizador clipee por límites de framebuffer y no por viewport.
- **Con el mailbox, resolver el ÚLTIMO hover requiere al menos un `collect()` extra. Si el consumidor sólo pollea desde `mousemove`, al FRENAR el cursor deja de haber eventos y el último pick nunca se cosecha: el hover queda una posición atrás. Está prohibido agregar un rAF o timer para drenarlo.**
  - Mitigación: Exponer `get busy()` y documentar el contrato: el consumidor llama `collect()` en su bucle de render existente (que ya corre en pan/zoom) además de en `mousemove`, y llama `collect()` ANTES de `request()` en cada evento. Si el motor no tiene un punto de poll garantizado en reposo, es un requisito para el área del motor —no se resuelve con un reloj propio de Picking—. Verificación: doble de `gl` con fence sintético + secuencia de 100 `request` y 10 `collect`; asertar que el ÚLTIMO request siempre termina entregándose.
  - Caso límite: El usuario acerca el cursor a un handle y se detiene exactamente encima: se emitió el pick, el mailbox tiene el bueno, no llegan más `mousemove` y el handle nunca se ilumina.
- **Presupuesto de 255 objetos simultáneos.**
  - Mitigación: Los ids son de PASE, no globales: sólo consumen id los objetos que entran al batch (los que intersectan el parche o están activos para edición). Con free-list y asignación perezosa, 255 sobra por órdenes de magnitud. Si aun así se superara, el reparto es JS puro: pasar a obj(12)|chunk(4) sin tocar GLSL, o paginar el pase (dos pases con distinto mapa de ids).
  - Caso límite: Un motor que registre un objeto de pick por capa y por geometría editable en una pantalla con muchas capas GPU podría superar 255.
- **El culling por bbox de chunk puede degenerar cuando un chunk es espacialmente disperso, y el pase de pick vuelve a costar como hoy.**
  - Mitigación: Degrada con gracia: el peor caso IGUALA al `drawArrays(POINTS, 0, count)` de hoy, nunca es peor. Si hiciera falta, subdividir el bbox por sub-rangos del chunk (bbox jerárquico de 8 sub-rangos) es un refinamiento local del lado del chunking, no del picking.
  - Caso límite: Un recorrido de larga distancia donde 400 vértices consecutivos cruzan toda la pantalla: el bbox del chunk contiene el parche siempre y ningún chunk se descarta.
- **Si el picking del INTERIOR del polígono se resuelve con el mismo stencil-then-cover del relleno, el micro-target necesita attachment de stencil y el contexto necesita `stencil: true` en `getContext` — que crea Leaflet/glify, fuera de nuestro alcance.**
  - Mitigación: Por defecto NO se mete el relleno en el pase GPU: el interior lo sigue resolviendo el resolver sincrónico de polígono que ya existe en el motor (analítico, exacto, sin dependencias nuevas). La puerta queda abierta: `#createTarget({ stencil })` agrega un `DEPTH24_STENCIL8` de 6×6 = 144 B si el área de relleno lo pide, y el clear de stencil por objeto sobre 36 texeles es gratis. Decisión del área de relleno (ver dependencias).
  - Caso límite: Click dentro de un polígono cóncavo con agujeros, donde el punto está dentro del bbox pero fuera del anillo exterior o dentro de un agujero.
- **Un pick de hover en vuelo puede cosecharse DESPUÉS de un click y sobrescribir la selección con el resultado del hover viejo.**
  - Mitigación: El consumidor llama `abort()` antes de `pickSync()` — semántica ya unificada: cancela vuelo y vacía mailbox. Adicionalmente, `metadata` viaja de ida y vuelta sin interpretarse: sirve para sellar el pedido y descartar resultados de una generación anterior.
  - Caso límite: El usuario mueve, se emite el pick asíncrono, hace click inmediatamente (`pickSync` resuelve y selecciona), y el siguiente `collect()` entrega el hover anterior con otras coordenadas.
- **Cambio de contrato en el retorno de `request()` y en la forma del resultado (`slots: Set` → `hits: PickHits`). Si el motor trata `false` como "ocupado, reintento después" o hace `slots.has(i)`, deja de compilar o cambia de comportamiento en silencio.**
  - Mitigación: Es cambio coordinado con el área del motor (ver dependencias 1 y 2). `PickHits` puede exponer `firstOf(obj)` y, si hiciera falta transición gradual, un getter `slots` que construya el `Set` legacy sólo para la ruta plana — a costa de reintroducir la asignación por pick, así que se plantea como puente temporal, no como API definitiva.
  - Caso límite: Un consumidor que reintenta ante `false` ahora recibe `true` (encolado) y deja de reintentar — que es lo correcto — pero uno que use `false` para NO actualizar estado local se comportaría distinto.
- **`#begin` deja `clearColor` en (0,0,0,0) y no lo restaura (defecto preexistente que se arrastra al rediseño).**
  - Mitigación: Guardar `gl.getParameter(gl.COLOR_CLEAR_VALUE)` y restaurarlo en `#restore()`, o —más barato y suficiente— documentar el efecto y no restaurarlo, ahora que `#restore` ya se simplifica al quitar el scissor. Recomendado: restaurarlo; es una lectura de parámetro por pick, despreciable frente al `readPixels`.
  - Caso límite: Cualquier código que después haga `gl.clear(COLOR_BUFFER_BIT)` confiando en el clearColor que había seteado antes del pick.
- **Supuesto no verificable desde estos dos archivos: que `cx, cy` llegan en píxeles de DISPOSITIVO.**
  - Mitigación: Confirmarlo con el área del motor antes del paso 1 (afecta directamente el cálculo de `ox, oy` y la propuesta opcional de parche en px CSS). Verificación directa: en DPR 2, pickear un punto conocido en la esquina inferior derecha del canvas.
  - Caso límite: Si llegaran en píxeles CSS, con DPR 2 el flip `h - cy` (h = `drawingBufferHeight`) ubicaría el parche al doble de altura de la real y el picking estaría roto hoy — como aparentemente funciona, el supuesto se sostiene, pero no lo puedo probar sin ver el llamador.

### chunking

- **Si la capa de handles se monta SOBRE glify.Points, todo write incremental se revierte: glify regenera `typedVertices` desde `data` en cada render (hallazgo verificado para el backend de PUNTOS, no para LÍNEAS). Eso invalida el arena entero.**
  - Mitigación: La capa de handles es una capa GL propia con su propio VBO, no glify.Points — es lo que habilita slots estables, `bufferSubData` de rango arbitrario y ausencia de espejo de objetos. Verificación explícita: mover un vértice, disparar un `moveend` sintético y asertar que el buffer conserva el valor. Requiere confirmar con el área de render que se puede montar una capa GL propia COMPARTIENDO el contexto existente (el presupuesto de contextos WebGL es ~16 y `removeLayer` no lo libera).
  - Caso límite: Mover un vértice y después hacer pan o zoom: el vértice vuelve a su posición vieja, porque el re-render regeneró el buffer desde el `data` de glify, que el arena no mantiene.
- **Precisión float32 de las posiciones: 2^-24 · 180° ≈ 1,2 m en lat/lng. A zoom alto el handle no cae sobre el vértice que el usuario ve.**
  - Mitigación: Guardar en el VBO deltas respecto de un origen por objeto (el centro del bbox al ingerir) y sumarlo en el shader como uniforme highp; el error pasa a ser relativo a la extensión del objeto, no al planeta (centímetros). Re-base cuando el bbox se aleja del origen más que un umbral: es un upload completo, amortizado y fuera del gesto. Antes de implementarlo hay que confirmar con el área de shaders qué espacio usa hoy el point layer y si ya existe una técnica de origen relativo — si ya la hay, se hereda.
  - Caso límite: Geocerca de 20 m de lado editada a zoom 20: el error es del orden del tamaño de la geometría y el vértice "salta" respecto del trazo.
- **El pick es asíncrono (PBO + fenceSync) y devuelve un slot que un split/merge posterior pudo haber migrado a otra entrada: se activaría el vértice equivocado.**
  - Mitigación: Sellar cada request con `structRev` y descartar la lectura si cambió. `structRev` sólo sube en insert/remove/split/merge/grow — gestos discretos — así que el descarte nunca cae en medio de un movimiento continuo. Complementario: candado estructural durante el drag (ninguna op estructural puede correr con un gesto activo).
  - Caso límite: Insertar un vértice que desborda su chunk (split) en el mismo frame en que hay un pick en vuelo sobre un vértice de la mitad que se mudó.
- **El defecto ya anotado de `Picking.request` (devuelve false si hay un pick en vuelo, sin encolar ni coalescer) hace que con el cursor en movimiento se descarten picks. Sobre un modelo cuyo hover activa nodos DOM, eso se ve como handles que no aparecen.**
  - Mitigación: Depende del área de picking: el fix debe quedarse con el ÚLTIMO pedido, no con el primero (coalescencia "último gana", no cola). El modelo de chunks no necesita nada más: `neighbors(slot)` es O(1), así que activar un vecindario por frame no cuesta.
  - Caso límite: Barrer el cursor rápido a lo largo del trazo: se pierden los picks intermedios y ningún vértice llega a activarse.
- **Un multipolígono con más anillos que objectIds disponibles (255) deja anillos sin identidad de picking.**
  - Mitigación: El reparto vive en UNA tabla (`PICK_BITS`), no disperso por el código: subir el objeto a 10 bits (1023 anillos) deja el slot en 22 bits = 2 M de entradas = 1 M de vértices por anillo, que sigue siendo enorme. La decisión se toma con el caso de uso real, cambiando dos constantes y la fórmula de empaquetado — no la arquitectura.
  - Caso límite: Editar un multipolígono de 300 anillos (catastro, islas): los anillos 256+ no se pueden hoverear ni editar.
- **Geometría degenerada: todos los vértices en el mismo punto (o midpoints exactamente sobre vértices). Sin DEPTH_TEST el FBO se resuelve por última escritura y el desempate podría quedar arbitrario.**
  - Mitigación: El orden de los dos pases lo resuelve por construcción: midpoints primero, vértices después ⇒ el vértice siempre gana el píxel. Se asegura con un test que dibuja N vértices coincidentes y asevera que el pick devuelve un slot PAR.
  - Caso límite: Trazo dibujado con muchos clicks en el mismo píxel, o un anillo colapsado a un punto por un `setValue` externo.
- **Uso incorrecto de la Source de trazos: cambiar el array de ítems (largo u orden) sin pasar por `set()` corrompe silenciosamente `ix.base` y las ediciones se pierden sin error.**
  - Mitigación: Regla y aserto: el array de trazos es propiedad del editor, sólo se reordena o redimensiona en `set()`, y hay un test que asevera largo y orden invariantes alrededor de cada `patch`.
  - Caso límite: Agregar un anillo con `patch` en vez de `set`: el id nuevo no está en `ix.base`, el `for` lo saltea con `continue` y el anillo nunca se dibuja ni se emite. Falla muda.
- **En WebGL1 no existe `bufferSubData(target, dstByteOffset, srcData, srcOffset, length)`: hay que pasar por `subarray`, que aloca una vista por rango — contra la regla de 0-alloc en ruta caliente.**
  - Mitigación: Camino WebGL2 cuando el contexto lo permite (0-alloc real, y además `gl_VertexID` elimina el VBO de slots). En WebGL1 el staging es único y sólo se aloca la VISTA, no el dato; se mide y se acepta explícitamente.
  - Caso límite: Drag sostenido a 60 fps con el vecindario cruzando dos chunks: 2-3 objetos de vista por frame (~180/s). No es dramático, pero es basura que se puede evitar.

### relleno-stencil

- **Explosión de fill-rate del pase 1 en polígonos cóncavos grandes. Es el riesgo REAL de la propuesta, no un detalle.**
  - Mitigación: (1) Scissor a bbox∩viewport en AMBOS pases — durante la edición se está con zoom y el bbox visible es chico, que es el caso dominante. (2) Medir con `EXT_disjoint_timer_query_webgl2` en el banco de geometrías patológicas ANTES de integrar, y publicar la curva ms vs. n vs. cobertura de pantalla. (3) Umbral de conmutación documentado: si el objeto está enteramente visible y no se está arrastrando ningún vértice, dibujar el relleno con la triangulación cacheada en vez del abanico (misma capa, otro programa). (4) Si aun así no cierra, el escape es earcut para el display y stencil sólo mientras dura el arrastre.
  - Caso límite: Geocerca tipo costa/cuenca de 5.000–50.000 vértices, muy cóncava, que ocupa toda la pantalla a zoom bajo. El abanico rasteriza la suma de |áreas| de n triángulos ≈ perímetro × radio medio, fácil 10–100× el área de pantalla: ~830 Mpx a 1080p@DPR2 con factor 100 ⇒ ~8–80 ms por frame, ×4 si se activa MSAA.
- **+1 contexto WebGL contra el presupuesto de ~16, en un proyecto donde ya está documentado que `removeLayer` NO libera el contexto.**
  - Mitigación: Un contexto POR MAPA (no por polígono ni por sesión), creado en el primer `attach()` y conservado hasta `destroy()`. `destroy()` llama explícitamente `WEBGL_lose_context.loseContext()`. Entre sesiones, en vez de destruir, se aparca el canvas en 1×1 (libera el drawing buffer, conserva el contexto). Contador de contextos en build de desarrollo + aserto de que no crece con ciclos entrar/salir de edición.
  - Caso límite: Una pantalla Wing con varios mapas montados/desmontados, o un usuario que entra y sale de edición muchas veces; si el contexto se creara por sesión de edición, se agota el presupuesto y el mapa entero deja de renderizar.
- **El pase de cobertura no limpia todo el stencil que el abanico ensució ⇒ fantasmas del polígono anterior.**
  - Mitigación: Invariante explícita: el rect se deriva del MISMO `#bbox` en el mismo frame, con pad de 1 px, y el bbox sólo CRECE. Guard `isFiniteRect` + `area(rect) === 0 → skip`. Test automatizable: tras dibujar un objeto, dibujar un quad a pantalla completa con `stencilFunc(NOTEQUAL,0,0x01)` en un color chillón y asertar CERO píxeles de ese color.
  - Caso límite: El bbox usado para el quad se calculó con posiciones DISTINTAS de las que se dibujaron (una escritura entre el cálculo y el draw), o el bbox llegó no finito desde una geometría vacía, o falta el pad de 1 px y la regla de rasterización deja un píxel de borde fuera del quad.
- **Divergencia entre lo que se VE relleno (GPU par-impar) y lo que se puede CLICKEAR (CPU).**
  - Mitigación: Arreglar `pointInPoly` a XOR (es la misma regla que la GPU, por construcción no pueden divergir) y blindarlo con el test dorado píxel-vs-`pointInPoly` descrito en los pasos.
  - Caso límite: Polígono con agujero: hoy `pointInPoly` hace OR de anillos y devuelve `true` dentro del agujero; la GPU lo pinta vacío. El usuario ve un hueco y el hueco responde al click.
- **MSAA ignorado o con conteo de muestras distinto según navegador/GPU ⇒ el borde se ve distinto en cada máquina.**
  - Mitigación: No depender del MSAA: el contorno es el AA de contrato (invariante de producto: mientras hay relleno hay trazo). Registrar `gl.getParameter(gl.SAMPLES)` en diagnóstico. Comparación visual lado a lado contra el `L.polygon` SVG actual en un borde diagonal, a DPR1 y DPR2.
  - Caso límite: ANGLE/GPU integrada que entrega 2 muestras o ninguna pese a `antialias:true`; o un usuario a DPR1 con contorno de 1 px, donde la escalera del relleno queda a la vista.
- **`preserveDrawingBuffer:false` + dibujo por eventos ⇒ el canvas se vacía en un frame en que no dibujamos.**
  - Mitigación: Adoptar EXACTAMENTE los mismos `contextAttributes` y el mismo enganche de eventos que usan las capas glify ya en producción salvo `stencil:true` — su comportamiento de presentación está probado en esta app. Verificación manual: mapa quieto, forzar repintes ajenos, confirmar que el relleno persiste.
  - Caso límite: Mapa quieto, sin eventos, y la página repinta por otra causa (aparece un tooltip, cambia el tema).
- **Desfase visual entre relleno y contorno durante la animación de zoom de Leaflet.**
  - Mitigación: Replicar el mecanismo del motor, no inventar uno. Es una dependencia explícita con el área del motor. Si el trazo termina viviendo en NUESTRO contexto (ver dependencias), el problema desaparece por construcción: mismo canvas, misma matriz.
  - Caso límite: `zoomanim`: glify aplica un transform CSS a su canvas y redibuja en `zoomend`. Si el canvas del relleno usa otro mecanismo, durante ~250 ms el relleno queda a otra escala que el trazo — y como el trazo es el que aporta el AA, el artefacto es doble.
- **Pérdida de precisión float32 al arrastrar lejos del ancla congelada.**
  - Mitigación: El error queda acotado por la distancia al ancla, no por la magnitud absoluta (que es el problema real). Re-baseline del ancla en `setRings()`; si el `#bbox` monótono supera un umbral respecto del original, marcar el objeto para re-baseline en el próximo `setRings`. No re-basear en `moveVertex` (reescribiría toda la textura).
  - Caso límite: Sesión de edición larga en la que un vértice se arrastra a muchos kilómetros del centro del bbox original, a z18+.
- **Geometría degenerada del backend.**
  - Mitigación: `attach()`/`setRings()` normalizan: descartan el duplicado de cierre, rechazan anillos con <3 vértices (no dibujan; el abanico daría sólo triángulos degenerados de todos modos y la auto-limpieza se sostiene porque no se ensució nada) y rechazan coordenadas no finitas con un diagnóstico. El caso 'anillo duplicado ⇒ desaparece' es el comportamiento de `fill-rule: evenodd` de SVG: se documenta, no se parchea.
  - Caso límite: Anillo de 0/1/2 vértices; anillo con el primer vértice repetido al final (convención GeoJSON) cuando la casa usa anillos abiertos; coordenadas NaN/Infinity; anillos duplicados exactos (paridad 0 ⇒ el polígono desaparece por completo).

### traspaso-dom

- **`pickHitSync` (readPixels síncrono) estanca el pipeline GPU y se siente al apretar.**
  - Mitigación: El atajo por píxel evita el sync en el caso común (mouse). Medir en el banco sobre las máquinas objetivo; si supera ~2 ms, pedir a picking un pick «tibio» (request asíncrono ya en `pointerover`, no en el primer move) para que el atajo por píxel esté caliente antes del primer pointerdown, y dejar el sync sólo para touch.
  - Caso límite: pointerdown que inicia un PAN, con una sesión de edición abierta y la GPU cargada (muchos puntos + etiquetas). El costo cae sobre un gesto que no tiene nada que ver con la edición.
- **Tolerancia del pick insuficiente para dedo: `PATCH = 6` son ~3 px de radio contra ~40 px de un dedo.**
  - Mitigación: Dependencia con picking: parche por request + decode que devuelva el id NO vacío más CERCANO al centro en vez del píxel central. Alternativa peor (documentarla como último recurso): agrandar la silueta del sprite de vértice, que agranda también el visual porque el fragment de picking hereda el discard del visual.
  - Caso límite: Primer tap sobre un vértice en móvil: `pickHitSync` devuelve null, el drag no arranca y el mapa panea. El editor sería inusable en touch aunque el resto del diseño sea correcto.
- **El gesto se corta por fuera de la ventana o del control del navegador.**
  - Mitigación: `setPointerCapture` sobre el contenedor (los `pointermove`/`pointerup` se siguen entregando ahí); `pointercancel` y `lostpointercapture` terminan por el MISMO `#endDrag`; `disarm()` es no-op mientras `#drag.active`, y `#onPointerLeave` no puede matar el drag (con captura activa el contenedor no recibe `pointerleave`, pero el guard queda igual).
  - Caso límite: Arrastrar un vértice fuera del viewport, Alt+Tab a mitad de arrastre, gesto de sistema (three-finger swipe), pérdida de foco de la pestaña.
- **`moveend` de origen PROGRAMÁTICO cierra `#interacting` a mitad del drag y des-suprime el hover.**
  - Mitigación: Guard `if (!this.#interacting || this.#drag.active) return` en `#endInteraction`. El `movestart` correspondiente ya es no-op por el guard existente de `#beginInteraction`.
  - Caso límite: La aplicación llama `map.setView()`/`flyTo()` mientras el usuario arrastra un vértice (p. ej. un WS que centra el mapa en un móvil).
- **Re-`upsertResolver` con `nextDeclOrder()` manda la capa de edición al fondo del desempate.**
  - Mitigación: Capturar `declOrder` UNA sola vez al alta de cada entrada de edición y reusar ese valor en todos los re-upserts. Cubrirlo con aserto en el test de registro.
  - Caso límite: Prender y apagar la edición varias veces (togglear `capture`): en cada re-upsert `declOrder` crece (líneas 91 y 212-214) y el orden relativo contra otra capa del mismo zIndex cambia entre sesiones — un bug no determinista y dificilísimo de reproducir.
- **La demanda se apaga y el picking deja de correr: sin `pickDemand` no hay sesión de hover y el traspaso queda mudo.**
  - Mitigación: La edición es una demanda POR SÍ MISMA: `enable()` aplica `registry.setLayerDemandMask(id, PICK_CHANNELS)` a las dos entradas y llama `interaction.syncHoverDemand()`. Hace falta acordar con el dueño de MapEngine un `forcedMask` en la entrada para que el recálculo por suscripciones no lo pise (ver dependencias).
  - Caso límite: El consumidor abre el editor pero nunca se suscribió a `cristae:hover` ni a `cristae:click`; o el motor recalcula `activeMask` desde las suscripciones del bus y pisa la máscara forzada de las entradas de edición.
- **Zoom o pan con el puntero QUIETO deja el banco desarmado indefinidamente.**
  - Mitigación: Una línea en `#endInteraction`: `this.#hover.pickDemand && this.#hover.dirty && this.#startHover(this.#sampleOf(this.#pointer))` — `#sampleOf` recomputa latlng desde el containerPoint, así que la muestra es correcta tras el zoom. Es re-lectura DIRIGIDA POR EVENTO, no timer ni rAF. Y aunque no se re-arme, la función no se pierde: el pointerdown sigue funcionando por `pickHitSync`. Bonus: cierra el mismo hueco para el cursor de todas las capas, que hoy también queda viejo tras un wheel-zoom.
  - Caso límite: Rueda del mouse sobre un vértice: `zoomstart` desarma, `zoomend` no re-arma y el puntero no se mueve más ⇒ el handle no vuelve hasta que el usuario mueva el mouse.
- **rAF de más: el del drag y el del poll de picking conviviendo.**
  - Mitigación: Los dos usan el mismo idioma `rafId ??= raf(...)` (tope de uno pendiente por subsistema) y el de hover está suprimido mientras `#interacting`. `#endDrag` cancela su rAF antes de `#endInteraction`. Verificación con espía de `requestAnimationFrame` en el banco: ≤1 llamada por frame por subsistema, y 0 en reposo.
  - Caso límite: Soltar el vértice y mover el puntero dentro del mismo frame — `#endDrag` reabre el hover mientras el rAF del drag podría seguir pendiente.
- **Registrar la capa de edición por `registerLeafletLayer` (footgun de API).**
  - Mitigación: Registrar SIEMPRE por `upsertResolver` con `zIndex` explícito, y dejarlo escrito en el comentario de cabecera de la capa de edición. Aserto en el test: la entrada `edit:handles` tiene `getLeafletLayer() === null`.
  - Caso límite: Alguien pasa el pane de handles o un `L.LayerGroup` de conveniencia: `zIndexOf` leería el z del pane VISUAL (que no es el z del hit) y `createResolver` fabricaría un resolver geométrico Leaflet que contradice el pick GPU — dos verdades sobre el mismo píxel.
- **Dos capas editables abiertas a la vez.**
  - Mitigación: Dueño único, último-gana: `enable(layer)` desarma y `disable()` a la saliente antes de tomar el banco. `#drag.active` bloquea el cambio de dueño hasta soltar.
  - Caso límite: Editar un polígono y, sin cerrar, abrir la edición de una polilínea: dos dueños del mismo banco de 3 nodos y de la misma captura de puntero.

### integracion-gpu

- **🔴 Contexto del relleno creado SIN stencil ⇒ el pase falla en SILENCIO (todo pasa el NOTEQUAL, o nada), y se ve como «el relleno a veces cubre la pantalla entera»**
  - Mitigación: Esclusa con throw inmediatamente después del getContext: `if (!gl.getContextAttributes().stencil) throw new Error('[cristae] contexto sin stencil; abortar relleno')`. Mismo patrón que `if (this.#layer.bytes !== 7) throw` (PointLayer.js:306). Falla ruidosa en el arranque, no muda en el pase.
  - Caso límite: Reusar un canvas/contexto ya existente (p. ej. compartir el de glify) o un driver/navegador que no otorgue el stencil pedido. `stencil` sólo se puede pedir AL CREAR el contexto; no hay forma de activarlo después.
- **🔴 BLEND activo en el pase de picking ⇒ el canal `a` (campo OBJETO de la jerarquía) sale mezclado con el fondo y el objeto se decodifica mal**
  - Mitigación: Verificar que `Picking.#begin` haga `gl.disable(gl.BLEND)` (o `blendFunc(ONE, ZERO)`) antes del pase. Test directo: pintar un handle con objeto=200 sobre FBO transparente y afirmar `px[3] === 200`. Es la primera aserción del paso de picking jerárquico.
  - Caso límite: Cualquier handle con `objeto != 0` sobre el FBO limpiado a `clearColor(0,0,0,0)`: con `SRC_ALPHA, ONE_MINUS_SRC_ALPHA` el alpha escrito se compone en vez de reemplazarse. Hoy no se nota porque el id vive en r,g y el alpha de salida no se lee.
- **🔴 El handle promovido a DOM «resucita» al panear — el bug que sólo aparece al mover el mapa**
  - Mitigación: Doble: (1) de diseño — ocultar por UNIFORMS DE RANGO en el vertex shader (`gl_PointSize = (id>=uHideLo && id<=uHideHi) ? 0.0 : aSize`), cero writes y por tanto cero exposición al espejo; (2) de contrato — regla escrita «todo write incremental de HANDLES toca `#positions` y `#meta`», con el test T-ESPEJO (patch → `_reset()` + `redraw()` → re-leer) en CI contra un doble de glify que reimplemente `resetVertices`.
  - Caso límite: Ocultar el handle activo escribiendo `size=0` únicamente en `#verts[base+6]`. glify.Points regenera `typedVertices` desde `data` + los callbacks `size: i => #meta[i].size` en cada render, así que el primer `_reset()` del `move` lo devuelve a su tamaño y aparecen 3 handles GPU superpuestos a los 3 nodos DOM.
- **Insertar un vértice degenera a O(N) porque glify.Lines re-tabula el buffer entero**
  - Mitigación: Capacidad FIJA C=512 por chunk + relleno con centinela: `vertCount` invariante ⇒ nunca hay re-tabulación. Verificación cuantitativa: contador de llamadas a `#rebuild`; 255 inserciones sobre una geometría de 5.000 vértices deben producir EXACTAMENTE 1 rebuild (el split del chunk lleno).
  - Caso límite: Cualquier cambio de `vertCount` de una parte. Con chunks de tamaño variable esto ocurre en CADA inserción o borrado: LineLayer detecta `parts.some((p,i) => runs[i].vertCount !== 2*(p.path.length-1))` y cae a `#rebuild`. El chunking abarata el bufferSubData pero no evita el setData.
- **`#bind()` omitido tras un `setData` ⇒ todos los bufferSubData siguientes escriben un typed array HUÉRFANO y nada cambia en pantalla**
  - Mitigación: Todo `setData` pasa por `#rebuild`, que llama `#bind()` en la línea siguiente (regla estructural, no disciplina). Más un chequeo de identidad en build de desarrollo al entrar a cada write: `this.#verts === this.#layer.typedVertices`. Test T-BIND.
  - Caso límite: Split de chunk, alta/baja de geometría, o cualquier camino nuevo que llame `setData` sin pasar por `#rebuild`. glify reasigna `typedVertices`/`allVerticesTyped` en cada render (PointLayer.js:330-331, LineLayer.js:268).
- **No se puede agarrar el vértice con el cursor en movimiento — los picks se descartan**
  - Mitigación: El agarre NO depende del hover: el `pointerdown` hace `pickSync` (un tiro, síncrono, siempre acierta) y promueve a DOM en el mismo evento; el hover asíncrono queda sólo para el resaltado. Así el defecto degrada el brillo, no la función. Test: 100 pointerdown con cursor a alta velocidad ⇒ 100 aciertos.
  - Caso límite: `Picking.request` devuelve false si hay un pick en vuelo y no encola ni coalesce. Moviendo el cursor rápido hacia un vértice y pinchando de inmediato, el hover nunca llega y no hay vértice promovido.
- **El relleno queda CONGELADO durante el zoom animado (salta al terminar), porque su canvas propio no tiene el `_animateZoom` de glify**
  - Mitigación: `EditFillLayer.renderAtView(zoom, center)` implementa la receta literal de PointLayer.js:123-139. `EditableGeometryLayer.renderAtView` delega a las tres sub-capas. Verificación: capturar frames del zoom animado y afirmar que relleno/trazo/handles no se separan más de 1 px.
  - Caso límite: Zoom animado con un polígono editable en pantalla: los handles reproyectan por `renderAtView`, el trazo se escala por el `setTransform` de glify, y el relleno se queda quieto. Los tres se separan visiblemente.
- **Bordes ALIASED del relleno: el stencil-then-cover pinta el cover con corte duro y el polígono editable se ve peor que el actual**
  - Mitigación: Pedir `antialias: true` al crear el contexto (en WebGL2 el MSAA se aplica a nivel de muestra e incluye el stencil). NO VERIFICABLE SIN CORRERLO — depende del driver. Plan B si el MSAA no alcanza: el trazo GPU ya dibuja el contorno encima y tapa el escalonado del relleno; y como último recurso, cover en un FBO 2× con downsample (cuesta un FBO, no un pase por polígono).
  - Caso límite: Cualquier arista no vertical/horizontal, más visible en aristas casi horizontales y en el borde de agujeros.
- **Auto-intersecciones rellenadas «al revés» respecto de lo que el usuario espera**
  - Mitigación: `fillRule: 'evenodd' | 'nonzero'` configurable, default `evenodd` (lo pedido). Non-zero = `stencilOpSeparate(FRONT, KEEP,KEEP,INCR_WRAP)` + `(BACK, KEEP,KEEP,DECR_WRAP)` con el mismo `NOTEQUAL 0`: misma estructura, dos llamadas de estado distintas, cero triangulación. Cuesta nada tenerlo y evita rehacer el pase si el criterio de producto cambia.
  - Caso límite: Polígono en moño: even-odd deja HUECO el lóbulo solapado. Un usuario que arrastró un vértice cruzando una arista opuesta ve un agujero aparecer donde esperaba relleno continuo.
- **Fill-rate desperdiciado por los vértices centinela de la capacidad fija**
  - Mitigación: Los centinelas se escriben en el espejo como `x=y=1e9` (Float32 lo soporta) y el relleno arranca en el vértice `2(n−1)`, que es PAR por construcción ⇒ ambos vértices de cada par fantasma están fuera del frustum y se clipean ANTES del rasterizado. El `a=0` queda como red de seguridad. En el GeoJSON del `setData` el centinela repite el último punto real (lat/lng válido: `projY0` diverge en ±90 y no se le puede dar basura) y se pisa en el espejo tras `#bind()`.
  - Caso límite: Chunk con 400 puntos reales y C=512: 112 segmentos fantasma. La brocha de glify hace `(4w+1)²` pasadas por segmento — con w=3 son 169 pasadas × 112 ≈ 19 K pasadas por chunk por frame si sólo se usara alpha=0.
- **Tearing entre los 3 canvases durante un pan (relleno, trazo y handles redibujan en momentos distintos)**
  - Mitigación: Riesgo bajo con precedente: hoy PointLayer y LineLayer ya conviven en canvases distintos sin tearing visible porque el motor invoca `resetCanvasReference()` + `redraw()` de todas las capas en el MISMO handler de `move`. La editable delega a sus tres sub-capas dentro de esa misma llamada y en orden de z. Se elimina del todo si glify admite `stencil:true` y el relleno comparte el contexto del trazo (ver dependencias).
  - Caso límite: Pan rápido y sostenido: el relleno se ve corrido respecto del trazo por uno o dos frames.
- **Agotamiento del presupuesto de contextos WebGL al entrar y salir de edición**
  - Mitigación: Las 3 sub-capas se crean UNA vez (perezosamente, en el primer `beginEdit`) y se VACÍAN al salir (`setData` con 0 features, `count=0`, `uniform1f(uHideLo,-1)`), nunca se destruyen hasta `EditableGeometryLayer.destroy()`, que aplica el orden normativo `cancelPendingRedraw → remove → loseGlContext` a las tres. Verificación: 30 ciclos abrir/cerrar y afirmar que el nº de contextos vivos es constante en 3.
  - Caso límite: Abrir/cerrar la edición 20 veces en una sesión: `removeLayer` NO libera el contexto, así que crear las sub-capas por sesión de edición acumula contextos muertos hasta que el navegador empieza a matar los vivos (mapa en negro).

## Preguntas abiertas entre áreas

- [picking-jerarquico] MOTOR (MapEngine.js): ¿desde dónde se llama `collect()` y está garantizado que se siga llamando cuando el cursor SE DETIENE? Con mailbox, entregar el último hover puede requerir un `collect()` adicional sin `mousemove` de por medio. Si no hay punto de poll en reposo, hace falta uno del lado del motor — no puedo agregar rAF ni timers.
- [picking-jerarquico] MOTOR: ¿qué hace hoy con el `false` que devuelve `request()`? Pasa a devolver `true` cuando el pedido queda encolado (sólo `false` si no está listo o el pedido es degenerado).
- [picking-jerarquico] MOTOR: ¿quién asigna y libera los ids de objeto 1..255 del pase? Propongo un free-list en el registro de capas de pick, con id asignado sólo a lo que entra al batch. Necesito confirmar que el motor puede mapear `obj → capa/geometría` al recibir los hits.
- [picking-jerarquico] MOTOR: ¿`cx, cy` llegan en píxeles de DISPOSITIVO? (El flip `h - cy` con `drawingBufferHeight` lo sugiere, pero no lo puedo verificar desde mis archivos y define el cálculo de `ox, oy`.)
- [picking-jerarquico] MOTOR: ¿el resultado `{ slots: Set }` se consume con `.has(...)`? El nuevo es `{ hits: PickHits }` con orden por cercanía; si hace falta un puente temporal puedo exponer un getter `slots`, pero reintroduce asignación por pick.
- [picking-jerarquico] CHUNKING: ¿el chunk k arranca siempre en `k * CHUNK` o cada chunk lleva `first/count` propios (slack para inserciones)? El decode devuelve índice LOCAL; para el índice global necesito la tabla `chunkFirst[]` y saber si es implícita.
- [picking-jerarquico] CHUNKING: ¿tamaño de chunk propuesto? Recomiendo ~4.096 vértices (bufferSubData de ~112 KB por reconstrucción, 256 chunks ⇒ 1.048.576 vértices por objeto con 8 bits de chunk). ¿Y hay bbox por chunk disponible para cullear el batch de pick? Sin bbox el pase sigue costando como hoy.
- [picking-jerarquico] LÍNEAS/SEGMENTOS: ¿el backend de líneas expande cada segmento en vértices PROPIOS? Si dos extremos de un mismo triángulo llevan ids distintos, el varying interpola y el id sale corrupto — ESSL1 no tiene `flat`. Si comparte vértices, el pick de segmentos necesita un programa `#version 300 es`.
- [picking-jerarquico] LÍNEAS: ¿el layout de vértice de la capa de líneas tiene 2 canales libres equivalentes a b,a para el índice de segmento, o hay que agregar un atributo? De eso depende si el pick de segmentos hereda la propiedad de 'un bufferSubData actualiza visual y pick a la vez'.
- [picking-jerarquico] RELLENO: ¿el pick del interior del polígono va por stencil en el micro-target (necesita `STENCIL_INDEX8`/`DEPTH24_STENCIL8` de 6×6 = 144 B y `stencil: true` en el `getContext` que crea Leaflet/glify) o queda en el resolver sincrónico de polígono que ya existe en el motor? Mi default es el resolver existente; puedo agregar el attachment si el área de relleno lo pide.
- [picking-jerarquico] TRASPASO A DOM: ¿el nodo DOM del handle activo se posiciona con la MISMA proyección que glify, en la misma vuelta? Apago el handle GPU con un tile transparente; si el DOM aparece un frame después o con desfase sub-píxel durante el zoom, se ve un parpadeo.
- [picking-jerarquico] ATLAS/BINDING: hoy `attach()` devuelve el programa de picking para que el binding del atlas le setee sus uniforms de dimensiones. Con varios programas registrados hace falta el mismo gancho por programa (`registerProgram` devuelve el `WebGLProgram`); ¿quién es el dueño de ese binding y puede iterar el registro?
- [picking-jerarquico] ARTE/HANDLE: el tile del handle debe tener el alpha como silueta DURA (sombra/glow horneados en RGB, o ≤2 px de expansión en alpha). Con umbral 0,01 cualquier halo agranda el área de agarre. Si el arte exige halo ancho, activo el `uPickCutoff` por draw.
- [chunking — modelo de chunks y edición en tiempo constante de la geometría editable] PICKING — ¿`#decode` puede pasar de devolver un id plano de 16 bits `(r<<8)|g` a devolver la estructura `{ objectId: a, slot: (b<<16)|(g<<8)|r }`, manteniendo que el píxel todo-cero siga siendo MISS (el objectId 0 no se asigna)? Es el único cambio que el chunking le pide al decodificador.
- [chunking — modelo de chunks y edición en tiempo constante de la geometría editable] PICKING — ¿el programa de picking puede aceptar una capa que declare SU PROPIO `vertexAttribPointer`, o está acoplado al pointer que arma glify? Mi formato es dos VBOs (data [x,y,role] de 12 B y slot de 4 B) leídos con stride de 2 entradas y offset 0/1 en dos pases. Si el picking exige el pointer de glify, hay que exponer un enganche para capas GL propias.
- [chunking — modelo de chunks y edición en tiempo constante de la geometría editable] PICKING — el `objectId` viaja como UNIFORME (constante por draw). ¿El programa de picking tiene ya un canal de uniformes por capa, o hay que agregarlo?
- [chunking — modelo de chunks y edición en tiempo constante de la geometría editable] PICKING — al arreglar el defecto de `request` (devuelve false con un pick en vuelo, sin encolar), ¿la coalescencia va a quedar "último gana"? Con hover que activa nodos DOM, quedarse con el primero se ve como handles que no aparecen. Y necesito poder sellar el request con un `structRev` y descartar la lectura si cambió.
- [chunking — modelo de chunks y edición en tiempo constante de la geometría editable] RENDER/MOTOR — ¿puede montarse una capa GL propia (VBO propio, dos drawArrays) COMPARTIENDO el contexto/canvas existente, sin abrir uno nuevo? El presupuesto de contextos es ~16 y `removeLayer` no los libera.
- [chunking — modelo de chunks y edición en tiempo constante de la geometría editable] SHADERS — ¿en qué espacio están las posiciones en el buffer del point layer: lat/lng crudos con matriz de proyección, o píxel del CRS? El arena guardará exactamente eso para no reproyectar en el flush.
- [chunking — modelo de chunks y edición en tiempo constante de la geometría editable] SHADERS — ¿existe ya una técnica de origen relativo (posiciones como delta respecto de un centro) para la precisión float32, o la introduzco yo para los handles? Sin ella el error es ~1,2 m y se nota editando geometrías chicas a zoom alto.
- [chunking — modelo de chunks y edición en tiempo constante de la geometría editable] LÍNEA/RELLENO — ¿la capa de exhibición puede consumir el arena por RANGO (un `bufferSubData` de los ≤2 segmentos que toca el vértice movido) en vez de releer `pathOf` completo? Si tiene que releer el path entero, el trazo se re-sube O(N) por frame de drag y el O(1) del arena queda enmascarado. Señal a favor: el hallazgo dice que glify.Lines NO regenera en pan/zoom, así que los writes incrementales ahí son seguros.
- [chunking — modelo de chunks y edición en tiempo constante de la geometría editable] LÍNEA/RELLENO — ¿acepta un `pathOf` que devuelve un CURSOR perezoso (objeto con `length` + `get(i)` que camina chunks) en vez de un array materializado? Materializarlo es O(N) por emit.
- [chunking — modelo de chunks y edición en tiempo constante de la geometría editable] LÍNEA/RELLENO — para el trazo partido en dos tramos alrededor del vértice activo, ¿qué preferís: dos rangos de draw (`head..prev` y `next..tail`) o una marca por vértice? El arena puede dar ambos en O(1).
- [chunking — modelo de chunks y edición en tiempo constante de la geometría editable] INTERACCIÓN/DOM — ¿quién define la política de activación (histéresis del hover, radio, qué pasa al salir del mapa)? Yo expongo `prevVertex/nextVertex` en O(1), el candado estructural durante el drag y el sello `structRev`; la política es tuya.
- [chunking — modelo de chunks y edición en tiempo constante de la geometría editable] PLATAFORMA — ¿el contexto es WebGL1 o WebGL2? Decide dos cosas: `bufferSubData` con srcOffset/length (0-alloc real vs. una vista por rango) y `gl_VertexID` (que elimina el VBO de slots: 6,4 MB menos a 400.000 vértices).
- [relleno-stencil] Store de vértices (áreas 1 y 3): ¿el relleno lee un `Float32Array` COMPARTIDO o mantiene su copia? Necesito una sola fuente de verdad, porque el `moveVertex` del arrastre tiene que escribir una vez y que lo vean picking, trazo y relleno.
- [relleno-stencil] Espacio de coordenadas del store: ¿world0 px (proyectado UNA vez, escala por 2^zoom en la matriz — que es lo que sugiere el comentario 'world0 px' de `bboxOfPoints`) o lat/lng crudo? El relleno necesita proyectado; si el store guarda lat/lng, alguien paga un O(n) por cambio de zoom.
- [relleno-stencil] Layout de chunk: ¿capacidad FIJA con holgura y contador vivo, o compacto? El relleno depende de eso para que insertar/borrar sea O(C) y no O(n) de texels. Si es compacto, el relleno pierde el premio del chunking (el `moveVertex` sigue siendo O(1) igual).
- [relleno-stencil] Ancla por objeto: propongo que sea el centro del bbox CONGELADO al abrir la sesión y que las posiciones se guarden RELATIVAS a él (sirve de origen de precisión float32 y de ancla del abanico a la vez). ¿El store puede adoptar esa convención, o el relleno tiene que rebasear por su cuenta?
- [relleno-stencil] Trazo del contorno: ¿lo dibuja glify.Lines (otro contexto) o el renderer GL nuevo? Si lo dibuja el nuestro, ahorramos un contexto, el AA-por-contorno queda garantizado a nivel de píxel y el desfase durante la animación de zoom desaparece por construcción. Es la decisión que más cambia mi presupuesto de contextos.
- [relleno-stencil] Motor (`MapEngine.js`): ¿cómo se le pide a una capa GL que redibuje en pan/zoom, y cómo maneja la animación de zoom de Leaflet (transform CSS + redraw en `zoomend`, al estilo glify)? El relleno debe usar EXACTAMENTE ese mecanismo, no inventar el suyo.
- [relleno-stencil] Motor / picking: confirmo que el relleno NO entra al FBO jerárquico (a=objeto, b=chunk, rg=vértice) y que el 'click adentro del polígono' se sigue resolviendo por CPU con `idsFor`. Como el resolver congela zIndex y declOrder al registrarse, necesito saber en qué orden queda el resolver del relleno respecto del de los vértices (el vértice debe ganar siempre sobre el relleno).
- [relleno-stencil] Política de contextos: ¿existe un registro central de contextos WebGL o una convención de `loseContext()` en `destroy()`? Dado el defecto conocido de que `removeLayer` no libera el contexto, quiero enganchar el mío a esa política y no crear una paralela.
- [relleno-stencil] Línea base de plataforma: ¿se acepta exigir WebGL2 para esta capa (`gl_VertexID`/`texelFetch` ⇒ cero vertex buffers, 8 B por vértice)? Si hay que soportar WebGL1, el fallback es buffer expandido de 3n vértices: mismo O(1) por movimiento pero 24 B/vértice y dependencia de VTF/float-textures.
- [relleno-stencil] Pane y banda de z dentro de la librería: el relleno tiene que quedar DEBAJO del trazo y de los manejadores DOM. Como es un canvas propio, la granularidad de orden es el pane — necesito el nombre y el zIndex asignados por el motor (la tabla `CRISTAE_Z` es de la capa Wing, no de la librería).
- [traspaso-dom (activación bajo demanda de ≤3 handles DOM sobre geometría editable en GPU)] picking: ¿existe o se puede agregar `layer.pickHitSync(sample) → part|null` (render del parche + `readPixels` inmediato, sin PBO ni fenceSync)? ¿Es seguro llamarlo con un pick asíncrono EN VUELO — lo aborta internamente, o hace falta un scissor/FBO aparte para no pisar el pending? Y sobre todo: ¿cuánto cuesta MEDIDO? De ese número depende si el atajo del pointerdown alcanza o hay que pre-calentar con un pick en `pointerover`.
- [traspaso-dom (activación bajo demanda de ≤3 handles DOM sobre geometría editable en GPU)] picking: ¿el tamaño del parche (`PATCH = 6`) puede pasarse POR REQUEST, y `#decode` puede devolver el id no vacío más CERCANO al centro en vez del píxel central? Es lo único que decide si el editor sirve en touch (dedo ≈ 40 px contra ~3 px de tolerancia actual).
- [traspaso-dom (activación bajo demanda de ≤3 handles DOM sobre geometría editable en GPU)] picking/chunking: ¿se acepta el reparto `a` = objeto(6 bits) + kind(2 bits: vértice/segmento/relleno/reservado), `b` = chunk(8), `rg` = índice en chunk(16)? Necesito que el KIND viaje en el mismo píxel (un solo readPixels) porque el cursor de affordance y la decisión de armar dependen de distinguir vértice de segmento de relleno. Si el kind va a otro lado, decime dónde.
- [traspaso-dom (activación bajo demanda de ≤3 handles DOM sobre geometría editable en GPU)] capa GL de edición: firma exacta de la parte que devuelven sus `resolveHover`/`resolveClick`. Propongo `{ ref, distancePx: 0, kind, objectId, chunkId, index, prevIndex, nextIndex }` con `prevIndex`/`nextIndex` YA resueltos por la capa: el traspaso no debe conocer la topología (cierre del anillo, anillos interiores, extremos abiertos de la polilínea) — sólo pinta los ≤3 nodos que le dicen.
- [traspaso-dom (activación bajo demanda de ≤3 handles DOM sobre geometría editable en GPU)] capa GL de edición: ¿expone la variante de sprite «grabbing» para el vértice arrastrado? El banco se apaga durante todo el drag, así que la continuidad visual la tiene que llevar GL. Y el corte del trazo en dos tramos alrededor del vértice activo, ¿se prende con la MISMA señal que el armado (`arm`/`disarm`) o tiene su propio canal?
- [traspaso-dom (activación bajo demanda de ≤3 handles DOM sobre geometría editable en GPU)] capa GL / chunking: ¿la capa expone `moveVertex(objectId, chunkId, index, x, y)` que agrupa las ≤3 escrituras del frame (vértice + 2 segmentos adyacentes + 2 triángulos del abanico del relleno), o el traspaso las hace una por una? Prefiero la primera: el traspaso no debería saber cuántos buffers toca mover un vértice.
- [traspaso-dom (activación bajo demanda de ≤3 handles DOM sobre geometría editable en GPU)] MapEngine: ¿cómo se fuerza `activeMask` de las entradas de edición para que `pickDemand` sea true SIN que el consumidor se suscriba al bus, y sin que el recálculo de demanda por suscripciones lo pise? ¿Se agrega un `forcedMask` a la entrada del registro, o `enable()` re-aplica la máscara y llama `syncHoverDemand()` en cada recálculo?
- [traspaso-dom (activación bajo demanda de ≤3 handles DOM sobre geometría editable en GPU)] MapEngine: ¿quién inyecta el `DomHandover` en `Interaction` — parámetro del constructor o setter (`set handover`)? ¿Y quién es dueño del pane `cristae-edit` (crearlo/destruirlo): el motor o la capa de edición? Necesito un dueño único para que `destroy()` no deje el pane colgado.
- [traspaso-dom (activación bajo demanda de ≤3 handles DOM sobre geometría editable en GPU)] MapEngine/eventos: ¿`#hover.generation` lo LEE alguien fuera de `Interaction.js`? Ahí se escribe en dos sitios (línea 207 y 252) y no se lee nunca: la invalidación real la lleva `session = null` + `cancelHoverHit()`. No voy a construir el traspaso sobre un sello que nadie valida — si tampoco lo lee nadie afuera, sobra y conviene borrarlo.
- [traspaso-dom (activación bajo demanda de ≤3 handles DOM sobre geometría editable en GPU)] eventos/bus: ¿el traspaso publica `cristae:vertex-drag-start/move/end` en el bus, o alcanza con un callback inyectado (`onCommit`, al estilo del `onEmptyClick` que ya recibe `Interaction`)? Mi preferencia es el callback: ampliar el bus con un canal que sólo consume el editor agrega superficie pública y un bit de demanda más que mantener.
- [integracion-gpu (PointLayer.js + LineLayer.js) — patrón canónico de capa GPU aplicado a la geometría editable] PICKING — ¿`Picking.#begin` deshabilita `gl.BLEND` antes del pase? Si no lo hace, escribir el campo OBJETO en el canal `a` del FBO se corrompe por composición con el clear transparente y la jerarquía se decodifica mal. Si no está, ¿se puede agregar `gl.disable(gl.BLEND)` sin alterar el resultado de las capas de puntos actuales (que no leen `a` de salida)?
- [integracion-gpu (PointLayer.js + LineLayer.js) — patrón canónico de capa GPU aplicado a la geometría editable] PICKING — ¿se va a implementar la coalescencia de `request` (guardar la última muestra y disparar en el `collect`, en vez de devolver false y descartar)? Diseñé el agarre por `pickSync` en el `pointerdown` justamente para NO depender de esto, pero si se arregla, el resaltado de hover deja de parpadear con el cursor rápido.
- [integracion-gpu (PointLayer.js + LineLayer.js) — patrón canónico de capa GPU aplicado a la geometría editable] PICKING — ¿el `#createFbo` va a dejar de asignar el renderbuffer de profundidad (nunca se habilita DEPTH_TEST y se dibujan gl.POINTS)? La edición hace muchos más picks por segundo que el hover de flota, y hoy son ~50 MB reasignados en cada `syncSize()`.
- [integracion-gpu (PointLayer.js + LineLayer.js) — patrón canónico de capa GPU aplicado a la geometría editable] PICKING — ¿el decode jerárquico (`{vertice:(r<<8)|g, chunk:b, objeto:a}`) se agrega dentro de Picking como `#decodeJer` o lo hace el llamador desde los bytes crudos? Necesito la firma exacta de lo que devuelve `collect()`/`pickSync()` para la jerarquía (¿`slots` de 16 bits como hoy, o un objeto por hit?).
- [integracion-gpu (PointLayer.js + LineLayer.js) — patrón canónico de capa GPU aplicado a la geometría editable] GEOMETRÍA (`src/geometry/polyline.js`) — ¿`prepareIndex` admite reemplazar UNA parte del índice, o hay que rehacer el `sorted` completo? Con chunks como partes, mover un vértice debería re-indexar sólo su chunk. Si no se puede, mi fallback es re-indexar entero SÓLO en el `pointerup` (nunca durante el drag), pero conviene saberlo antes de fijar el tamaño de chunk.
- [integracion-gpu (PointLayer.js + LineLayer.js) — patrón canónico de capa GPU aplicado a la geometría editable] MOTOR — ¿`renderAtView(zoom, center)` es duck-typed (el ViewAnimator la llama sólo si existe, que es lo que parece dado que LineLayer no la tiene) o va a ser parte obligatoria del contrato? El relleno la NECESITA (canvas propio sin `_animateZoom`); saber si es opcional cambia si `EditableGeometryLayer` debe exponerla siempre o condicionalmente.
- [integracion-gpu (PointLayer.js + LineLayer.js) — patrón canónico de capa GPU aplicado a la geometría editable] MOTOR — ¿en qué orden invoca `resetCanvasReference()` y `redraw()` sobre las capas en el handler de `move`? Lo necesito para descartar tearing entre los 3 canvases de la editable; el precedente PointLayer+LineLayer sugiere que ya están sincronizados, pero quiero el orden confirmado.
- [integracion-gpu (PointLayer.js + LineLayer.js) — patrón canónico de capa GPU aplicado a la geometría editable] MOTOR — ¿cómo se registra una capa con picking MIXTO (GPU/FBO para los handles + resolver síncrono CPU nearest-segment para el trazo)? Hoy `#pickLayers` es sólo puntos y el resolver síncrono congela zIndex y declOrder al registrarse. ¿Se registra dos veces (dos entradas con el mismo layerId) o hay una forma de declarar ambas rutas en una?
- [integracion-gpu (PointLayer.js + LineLayer.js) — patrón canónico de capa GPU aplicado a la geometría editable] GLIFY — ¿`glify.lines()` / `glify.points()` permiten pasar atributos de contexto WebGL al crear su canvas (concretamente `stencil: true`) y ofrecen algún hook de pre-draw ENTRE el `gl.clear` y el `drawArrays` que NO sea monkey-patch? Si la respuesta es sí, el relleno comparte el contexto del trazo: 3 contextos bajan a 2, desaparece el riesgo de tearing entre relleno y trazo, y el relleno hereda el `_animateZoom` de glify.
- [integracion-gpu (PointLayer.js + LineLayer.js) — patrón canónico de capa GPU aplicado a la geometría editable] GLIFY — ¿`layer.redraw()` coalesce internamente varias llamadas en el mismo frame? La existencia de `cancelPendingRedraw(this.#layer)` lo sugiere fuertemente. Es la confirmación de que NO debo agregar coalescencia propia encima (eso sería el rAF doble prohibido).
- [integracion-gpu (PointLayer.js + LineLayer.js) — patrón canónico de capa GPU aplicado a la geometría editable] Z / APILADO — ¿qué bandas de `CRISTAE_Z` se asignan a relleno de edición, trazo de edición y handles? Necesito tres bandas con orden garantizado relleno < trazo < handles, y que los handles queden por encima de las etiquetas (que hoy van +200).
- [integracion-gpu (PointLayer.js + LineLayer.js) — patrón canónico de capa GPU aplicado a la geometría editable] SOURCE / DATOS — ¿la geometría en edición es un item de una Source normal (mutar el item + `source.patch(id)` → emit coalescido por el Emitter) o va por un canal aparte? Todo mi diseño de coalescencia se apoya en que sea Source normal: es el único reloj que uso para el dato, y es lo que garantiza «sin rAF propios». Si fuera un canal aparte, necesito saber quién coalesce.
- [integracion-gpu (PointLayer.js + LineLayer.js) — patrón canónico de capa GPU aplicado a la geometría editable] REPARTO DE BITS — con C=512 y reparto simple rg/b/a = 16/8/8 el techo es 131.072 vértices por objeto y 256 objetos editables. Si el caso de uso exige el 16,7 M del planteo original, el ajuste es aritmética del decode (robar a `rg`, que con C=512 sólo usa 10 bits, los bits altos para ampliar `chunk` a 14 bits ⇒ 8,4 M). ¿Qué techo real hay que soportar? Afecta sólo al decode, no al pase ni al readPixels.
