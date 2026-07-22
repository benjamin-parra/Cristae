# Changelog

Todas las versiones notables de Cristae se documentan en este archivo. El formato sigue
[Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y el versionado descrito en
[`docs/versionado.md`](docs/versionado.md) — en `0.x`, el **minor cuenta los cambios medios**
(capacidad o eje de API nuevo) y el **patch los menores desde el último medio** (fix / perf / revert).

## [Sin publicar]

## [0.13.6] - 2026-07-22

Extracción de **ClusterFold** de `MapEngine` a su propio módulo. **Sin cambios de API ni de
comportamiento** — la superficie pública (`addClusterFold`/`addCluster`, el objeto `control`, los eventos
`cluster:*`, el descriptor de retorno) es idéntica; verificado con un harness de caracterización
(9 escenarios, move-equivalencia) + auditoría adversarial. `MapEngine` pasa de ~1400 a **882 líneas**.

### Agregado
- **Cobertura del fold de cluster (antes cero).** `test/engine/cluster-fold.test.mjs` +
  `test-helpers/engine-stub.mjs` montan un `MapEngine` REAL contra stubs (Leaflet/glify/canvas) y fijan
  el comportamiento OBSERVABLE del fold —burbujas + supresión, `cluster:expand/update/dismiss/marked` con
  payload, espiral, dismiss por zoom, reindex por `enabled`, split en sub-grupos— como oráculo de la
  extracción. Mutation-verified (rompen ante un payload alterado). Suite 510 → **519**.

### Cambiado
- **`ClusterFold` es ahora un módulo propio** (`src/cluster/ClusterFold.js`). El fold (~500 líneas:
  burbujas, spiderfy, eventos `cluster:*`, marcado, dim-rest) vivía como el método `addClusterFold` de
  `MapEngine`, atado a ~15 de sus privados. Ahora es `createClusterFold(bridge, targets, opts)`: pide los
  servicios del motor (panes, capas, `focus`, bus, `emit`, proyección) por un `bridge` acotado
  (`#foldBridge`) en vez de acceder a los privados. Las constantes fold-only (`SPIDER_*`,
  `MARKED_CENTER_QUANT`, `CLUSTER_REINDEX_THROTTLE_MS`, `spiderfyOffsets`) se mudaron con él; los defaults
  de burbuja (`#makeBubbleSink`/`#subClusterIconSet` + draws + `SUB_ACCENT`) quedan en `MapEngine`,
  expuestos por el bridge. Es un cambio de estructura interna: `ClusterFold` NO se exporta desde ningún
  entry (la golden surface no cambia).

## [0.13.5] - 2026-07-22

Corrección de tres bugs latentes anotados y consolidación del **eje 3 (acotado)** en el cluster. **Sin
cambios de API** — comportamiento corregido en los bordes, la superficie pública no cambia. Suite 505 →
**510 tests, 0 fail**; cada fix con su test de regresión verificado por revert-check (falla sin el fix).

### Corregido
- **`toRGBA` ya no devuelve `DEFAULT_COLOR` por referencia.** La rama de fallback (color inválido)
  devolvía la constante compartida; un caller que mutara el resultado corrompía el default global de
  todos los fallbacks siguientes. Ahora devuelve una copia fresca — contrato uniforme: **toda rama
  entrega un `[r,g,b,a]` nuevo**. La alocación extra ocurre sólo con un color inválido (frío), nunca en
  el gradiente por-vértice de `LineLayer`.
- **`withAlpha` acepta los mismos formatos hex que `toRGBA`.** Antes sólo entendía `#RRGGBB` y devolvía
  cualquier otro formato **sin aplicar el alpha** (divergencia latente con `toRGBA`): un `#RGB` corto o
  un `#RRGGBBAA` pasaba de largo sin teñir. Ahora comparte el mismo regex `HEX`
  (`#RGB`/`#RGBA`/`#RRGGBB`/`#RRGGBBAA`, con o sin `#`); lo que no es hex (nombres CSS, `rgb()`, `null`)
  sigue pasando sin tocar.
- **`PagedTable.attach` normaliza el teardown del `subscribe`.** Asignaba el retorno de `subscribe`
  directo a `#unsubscribe`; una Source cuyo `subscribe` devuelve `{ unsubscribe() }` (RxJS) o
  `{ dispose() }` (Solid) reventaba en `destroy`/re-`attach` con "x is not a function". Ahora pasa por
  `toUnsub` — el mismo normalizador que ya usa `defineSource`.

### Cambiado
- **Eje 3 acotado — los `try/catch` fríos del cluster a un solo punto.** Los cinco `try/catch` que
  envolvían `getLeaves` (en `expandCluster`/`collapseCluster`/`isClusterExpanded`/`contents`/
  `#markedEn`) se consolidan en `#leavesOf`, que **materializa la staleness** de un `clusterId` retenido
  a `null` (ausencia); los sitios ramifican sobre ese `null`. Se **mueven, no se agregan**: la misma
  cantidad de `try/catch` se ejecuta (`recluster`/`#partition` siguen usando `getLeaves` directo con
  ids frescos), y cada fallback previo se preserva exacto (`null`/`null`/`false`/`null`/`[]`).

## [0.13.4] - 2026-07-22

Reestructuración interna de estilo, aplicada a toda la librería. **Sin cambios de API ni de
comportamiento** — un punto estable antes de las tareas estructurales mayores. Suite 398 → **505 tests,
0 fail** (la pasada sumó cobertura de paso). Cada cambio preserva el comportamiento (suite verde,
mutation-verified) y no introduce alocación en los caminos calientes (auditoría adversarial en los
módulos hot, donde la suite no atrapa la presión de GC).

### Cambiado
- **Comentarios y espaciado (ejes 9 y 8).** Barrido no-semántico —verificado archivo por archivo con
  `scripts/verify-nonsemantic.mjs` (el `esbuild --minify` de antes y después es byte-idéntico)— que
  borra war-stories, menciones a frameworks ajenos y bitácora, conservando invariantes y marcadores
  `[0-alloc]`, y alinea los bloques tabulares.
- **Indirección por tabla (eje 11).** Los if-chains sobre strings pasan a tablas constantes de módulo
  o clase: `maskOfEventType`/`dispatch` del bus, `fold`/`map` y `leaf`/`wrapper` de la gramática,
  `#resolveParts` del registro de capas, y el puente de eventos `cristae:*` de `<cristae-map>`.
- **Estado agrupado (eje 6) y closures state-action (eje 7).** Campos sueltos que son un mismo estado
  → objetos agrupados (con la ref cacheada en los métodos calientes): la sesión de expansión del
  cluster (limpieza atómica que elimina la clase de bug "sesión zombi"), el hover de `Interaction`, el
  FBO de picking, la config del cluster-fold, el estado de `PagedTable`. Estado + limpieza dispersa →
  closures con un solo `dispose`: la ventana de flush de `Source`, el agendador y los observadores de
  `PagedTable`, el debounce de resize de `<cristae-map>`.
- **Named lambdas y localización (eje 1).** Privados de un solo uso inlineados en su call-site; pipelines
  largos partidos en pasos con nombre (el `flip`/`shift`/`clip` de `popupPlacement` como `reduce`).

### Añadido
- **Desfragmentación por centralización (eje 5).** Duplicaciones reales unificadas en módulos internos
  agnósticos, cada uno con su test: `render/color.js` (parsers de color), `geometry/bbox.js` (álgebra de
  bounding-box, antes triplicada), `geometry/binary-search.js`, `element/attrs.js` (coerción de
  atributos), `data/teardown.js` (`toUnsub`), `element/autoId.js` (los siete `let seq = 0` repetidos).
- **Cobertura de módulos antes al 0%:** `Atlas`, `IconSet`, `ZoomSnapshotStore.select`, el
  `resolveHits` del registro, y las utilidades extraídas. `scripts/verify-nonsemantic.mjs` como
  herramienta de verificación mecánica.

## [0.13.3] - 2026-07-22

Cierra los dos defectos que la suite de contrato dejaba documentados como `todo`. Suite: 398 tests, 0
fail, **0 todo**.

### Corregido
- **El `Emitter` seguía disparando `onFlush` después de `destroy()`.** `destroy()` limpiaba
  suscriptores y lo agendado, pero un `notify()` posterior volvía a leer la fuente y llamaba a
  `onFlush` — golpeando a un consumidor ya desmontado. Ahora `destroy()` suelta la fuente y `#check`
  se guarda contra ese estado: un emitter destruido queda **inerte** (no lee, no emite, no flushea) y
  además libera la referencia a la fuente.

### Añadido
- **R5 — un hijo no reconocido dentro de un wrapper de gramática es un error, no un descarte
  silencioso.** Un `<cristae-cluster>` con un `<div>` o un `<cristae-point-layerr>` (typo de tag) los
  ignoraba sin avisar, y el error afloraba desfasado (el wrapper "sin hijos" → R3, señalando al lugar
  equivocado). `validate` ahora lanza `GrammarError('R5')` nombrando al hijo malo. Se chequea **después**
  de R3 (un wrapper sin ningún hijo válido sigue siendo R3), y `slot="bubble"` (configuración) queda
  excluido como antes. `grammarChildren` no cambia —sigue filtrando lo que el reductor no debe ver—:
  la novedad es que la validación avisa en lugar de tragarse el typo. `firstUnknownChild` (interno) es
  el complemento de `grammarChildren`.

## [0.13.2] - 2026-07-22

Tanda de correcciones previa a la reestructuración interna. Todos los defectos venían con repro
ejecutado y cada arreglo entra con su test de regresión (verificado que falla sin el fix).

### Corregido
- **`Store.patch` bumpeaba la versión sólo hasta el primer cambio de membresía.** El `break` del
  recorrido cortaba en cuanto un id sucio entraba/salía de un filtro, así que los ids sucios
  posteriores quedaban sin su version-bump: un observador que dependiera de `elementVersions` no se
  enteraba de esos cambios. El recorrido pasa a ser TOTAL (`continue`); el cambio de membresía sólo
  decide si la vista se regenera al final, nunca acorta el recorrido. Sin costo extra: en el camino ya
  condenado al regenerado se saltan la evaluación de filtros y la escritura de slots (trabajo muerto),
  pero el `scanOne` —hash + version-bump— corre para todo id.
- **El reparto del `Emitter` no aislaba al suscriptor que lanzaba.** Un `subscribe` cuyo callback
  tiraba cortaba a los suscriptores siguientes, se comía el `onFlush` y propagaba la excepción dentro
  del rAF; además esa emisión se perdía (la versión ya estaba consumida). Ahora cada suscriptor corre
  con `safe` + un reporter de módulo — mismo canal que `Store.notifyChanges`: un consumidor roto no se
  lleva a los demás y **el error se reporta por `console.error`, no se traga**. Cambio observable: una
  excepción en un callback de `subscribe` ya no escapa por `notify()`.
- **`PagedTable` con un comparador CON EMPATES duplicaba y perdía filas entre páginas.** El
  particionado por quickselect se recalculaba por página sobre un working-set de referencias; con
  empates, las fronteras de dos páginas contiguas elegían representantes distintos del bloque empatado,
  así que había filas que salían dos veces y otras que no salían nunca. El working-set pasa a guardar
  ÍNDICES del dataset, que sirven de desempate estable (`comparator(a, b) || a - b`): con orden TOTAL,
  las páginas vuelven a ser una partición del universo. Sin regresión de rendimiento (una resta por
  comparación, un remapeo índice→ítem del tamaño de la página).
- **`PagedTable.setPage(-1)` no se clampeaba por abajo** y llegaba a `qselect` como offset negativo.
  Se fija el piso (`Math.max(0, pageIndex | 0)`, que además descarta no-enteros); el techo lo sigue
  poniendo el pipeline, que depende del total vigente.
- **`paginationModel` con `capacity` chico rompía tres invariantes**: con `capacity ≤ 4` ningún botón
  quedaba marcado como página actual; con `capacity ≤ 3` el modelo excedía la capacidad pedida (los dos
  extremos + dos elipsis); con `capacity 1` emitía una elipsis con `pageIndex` fuera de rango y
  secuencias que retrocedían. El andamiaje `1 … ventana … N` cuesta cinco slots; con menos presupuesto,
  el modelo degrada a una **ventana corrida** de páginas contiguas centrada en la actual y encajada en
  el rango (sin extremos ni elipsis). Nunca excede la capacidad, nunca sale de rango, nunca retrocede y
  siempre marca la actual.
- **El camino incremental de `PointLayer` moría en modo cluster.** `#onChange` trataba "punto
  suprimido por el cluster" como "id desconocido" y caía al rebuild O(n): con la flota clusterizada y
  moviéndose, cada frame disparaba un `setData` completo. Ahora la membresía del buffer vive en un
  ÚNICO punto de política (`#renderablePos`) que comparten el rebuild y el incremental: un id ausente
  POR DISEÑO —fuera del `where`, suprimido por el cluster o con posición no finita— no rebuildea; sólo
  un id desconocido (el buffer no está al día) lo hace. Incluye el caso de un móvil sin fix GPS
  (posición no finita), que un arreglo parcial habría dejado rebuildeando igual.
- **`positionOf` del consumidor podía verse pisado dentro de un rebuild.** `PointLayer.#rebuild`,
  `#writeSlot` y `HtmlLayer.#rebuild` retenían el objeto devuelto por `positionOf` mientras corrían
  otros accessors del consumidor (`variantOf`, `headingOf`, `sizeOf`, `htmlOf`); si `positionOf` reusa
  un objeto scratch, las coordenadas de dos ítems podían intercambiarse. Se copia `lat`/`lng` a locales
  apenas pasado el guard de finitud (0 alocaciones), cerrando la ventana.
- **Un `<cristae-popup for="…">` apuntando a una capa sin `Source.itemById` (p. ej. polígonos) no
  abría nunca, en silencio.** Ahora la resolución del hit distingue "capa que no resuelve ítems por id"
  de "id ausente" (`src/element/popupResolution.js`, pura) y **avisa por consola una vez por capa** en
  lugar de cerrar sin explicación; `docs/elements.md` documenta que `for` requiere una capa de
  puntos / líneas / html.

### Cambiado
- **Tipos publicados: el contrato de `Source` se parte en lectura + dueño.** `types/core.d.ts` declaraba
  que `defineSource` y `createSource` devolvían ambos `CristaeSource<T>`; en realidad `defineSource`
  (ruta B) devuelve sólo lectura y `createSource` expone además `version`/`variants`/`dirtyIds`/
  `moveDirtyIds`. Con `tsc --strict`, `defineSource(...).set([])` compilaba y reventaba en runtime. Se
  introduce `CristaeReadSource<T>` (lo que el motor consume) y `CristaeSource<T> extends
  CristaeReadSource<T>` (añade la mutación); `defineSource` devuelve el de lectura, `createSource` el de
  dueño. Los tres puntos que exigían el tipo de escritura sin necesitarlo —`LineHandle.source`,
  `HtmlHandle.source` y `PagedTable.attach`— pasan a lectura, así el `createSource` de los consumidores
  sigue asignando sin cambios (el dueño extiende la lectura). Cambio de tipos, no de runtime.
- **`./grammar` deja de ser la única ruta pública sin `.d.ts`.** Se publica `types/grammar.d.ts` y la
  entrada de `exports` pasa a `{ types, default }`.

Suite de contrato previa a la reestructuración interna. No cambia una línea de `src/`: sólo agrega la
red que el refactor necesita para no romper la API pública en silencio.

### Añadido
- **Suite de contrato: 380 tests (367 pass, 0 fail, 13 todo), 17 archivos + un stub DOM.** Congela la
  superficie publicada por entry (`core` / `table` / `map` / `grammar`), el contrato y la ventana de
  flush de `Source`, la equivalencia `patch ≡ update` de `Store`, el coalescing de `Emitter`, el
  pipeline y el DOM observable de `PagedTable`, `paginationModel`, `qselect`, el diffing de hover y el
  libro de demanda de `EventBus`, y el protocolo duck-typed de la gramática.
- Los defectos conocidos quedan **ejecutables** como tests `{ todo }` con el comportamiento correcto,
  en vez de congelar el comportamiento defectuoso como si fuera el contrato.

### Cambiado
- **Runner: `npm test` ahora es `node --test`** en vez de cinco invocaciones encadenadas con `&&`.
  El encadenamiento cortaba en el primer archivo que fallara, que es justo cuando más falta hace el
  diagnóstico completo. Los cinco archivos previos siguen corriendo sin modificación.
- El stub DOM vive en `test-helpers/`, fuera de `test/`: todo lo que cuelga de `test/` matchea el patrón
  de descubrimiento de `node --test` y el helper se ejecutaba como si fuera una suite vacía.

## [0.13.0] - 2026-07-21

Última versión antes de la reestructuración interna del código. Congela el estado de la API pública
que el refactor debe preservar.

### Corregido
- **`styleOf.weight` ahora significa PX DE PANTALLA en los dos backends.** glify no recibe un grosor
  sino el **radio de una brocha** que barre ±w en pasos de 0.5 sobre una línea de 1px: rendía `2w+1` px
  de ancho, así que el backend GL dibujaba **al doble de grosor** que el Leaflet con el mismo `styleOf`
  —contradiciendo el contrato publicado ("`weight` en px de pantalla")— y pagaba 4× las pasadas de
  dibujo. `LineLayer` convierte px → radio (`(px−1)/2`) al registrar el callback. Efecto colateral: las
  pasadas por feature y por frame bajan de 169→25 (3 px), 441→81 (5 px) y 1089→225 (8 px).

### Cambiado
- **`LayerRegistry.resolveHits` deja pasar el detalle propio de cada resolver.** Armaba el hit con una
  lista fija de claves (`ref/id/distancePx` + identidad de capa), contradiciendo su propio contrato de
  ser *genérico sobre funciones resolver*: el detalle específico de una capa —`partIndex`/`segmentIndex`
  de una línea— moría ahí. Ahora hace spread del `part` y **luego** escribe las claves del registro
  (`layerId`, `kind`, `zIndex`, `order`), que siguen siendo suyas y no las puede pisar un resolver.
  Aditivo: los consumidores que leen `id`/`kind`/`ref`/`layerId` no cambian.

### Añadido
- **Primitiva de LÍNEAS: `<cristae-line-layer>` / `engine.addLineLayer` (GPU + gradiente + picking).**
  Cuarta forma geométrica junto a `point`/`polygon`/`label`, sin dominio (una polilínea de N
  vértices con estilo — no "recorrido"/"ruta"). Render GL sobre `glify.Lines` **sin forkearlo**
  (`render/LineLayer.js`, hermano de `PointLayer`): reusa su rebuild `setData` y su draw `gl.LINES`
  intactos y le **añade el color per-vértice** para el gradiente escribiendo los canales `r,g,b,a`
  del buffer interleaved (`bytes=6`, buffer `'vertex'`) por `bufferSubData` — el shader de glify ya
  interpola `_color` entre vértices, así que el degradado es físicamente posible sin tocar GLSL. El
  gradiente **sobrevive pan/zoom** (glify sólo re-compone la matriz en `_reset`, no re-ejecuta
  `resetVertices`) y se re-aplica sólo tras un rebuild. Accessors: `{ idOf, pathOf, styleOf?,
  scalarOf?, colorRamp? }` — `pathOf(item) → Iterable<[lat,lng]>`; `styleOf` da color/weight/opacity
  PLANO por línea; `scalarOf(item, i)` + `colorRamp(value) → [r,g,b,a]` dan el gradiente per-vértice
  (el core NO interpreta el escalar). **El estilo es ESTADO (`styleOf`), no un método**: recolorear
  una línea = mutar su item + `set`/`patch` la Source (como un punto no tiene `setColor`); el motor
  decide cómo aplicarlo y hoy siempre reconstruye (el fast-path incremental por `bufferSubData` es una
  optimización INTERNA pendiente, no parte del contrato) — sin `setStyle` imperativo. **Picking** CPU nearest-segment (`geometry/polyline.js`,
  índice espacial O(log n + k), módulo puro), `kind:'line'` con `distancePx` real; el hit-test nativo
  de glify se apaga (`sensitivity:0`). Las tres ergonomías (elemento `.data` / `.source` compartida /
  handle) como point-layer; el guard de `Source` acepta `positionOf` **o** `pathOf`. **Deuda
  documentada (NO en este incremento):** el grosor real por triángulos (glify simula `weight` con
  brocha O(weight²) draw-calls), el `dash` (no hay en `gl.LINES`), y el append incremental de un
  track vivo por la punta (`extend`, hoy rebuild coalescido). **Dos backends**: `vector: true` (o
  `<cristae-line-layer vector>`) usa un backend **Leaflet** (`L.polyline`) que **sí dibuja `styleOf.dash`**
  y no abre otro contexto WebGL (para pocas líneas / punteadas), vs el backend GL default (volumen /
  gradiente, sin dash). **Patrones de trazo por UN solo eje** (`dash` = `stroke-dasharray` px) + `cap`:
  guiones `[8,6]`, punteado `[1,6]`+`cap:'round'`, raya-punto `[12,5,1,5]`+`cap:'round'` — sin flags
  `dotted`/`dashDot` (generalidad por composición, no por enumeración). **Flechas de dirección: se
  COMPONEN**, no son propiedad del trazo — helper puro `sampleAlong(path, count)` → `[{lat,lng,heading}]`
  equiespaciado por longitud, que alimenta un point-layer con `headingOf` (el sprite rota solo y hereda
  atlas/picking/popup). **Líneas MULTI-PARTE**: `pathOf` admite dos encodings que colapsan a la misma
  representación (`toParts`, exportado) — plano, donde un vértice **no finito CORTA** la línea, o
  anidado `[[[lat,lng],…],…]` con las partes explícitas. Un track GPS con baches sale **partido** en
  vez de puenteado por una recta que no existe (antes los vértices inválidos se descartaban y sus
  vecinos quedaban unidos). Multi-parte **no** es multi-entidad: un id, un estilo y **un solo hit** (el
  índice guarda una entrada por parte, con bboxes ajustadas para el broad-phase, y gana la más cercana,
  reportada como `partIndex`+`segmentIndex`). En GL sale como `MultiLineString` (glify emite una tirada
  de vértices por parte, contiguas y en orden → el mapeo buffer↔dato se guarda por parte); en Leaflet,
  como `L.polyline` multi-path. `scalarOf(item, i)` indexa la **entrada** de `pathOf` — con el encoding
  plano el corte ocupa índice, con el anidado corren concatenados — así un array paralelo de escalares
  no se desincroniza, y el hit expone `vertexIndex` **en ese mismo espacio** (más `partIndex`) para que
  se pueda cruzar con el dato. `sampleAlong` también normaliza por `toParts`: nunca muestrea sobre un
  hueco ni devuelve `NaN` por un vértice sucio. Docs en `docs/lines.md`; tipos `LineAccessors` /
  `LineHandle` / `LineHit` en `types/map.d.ts`.
  ⚠️ **Nota sobre glify**: sus dos callbacks NO reciben el mismo índice — `resetVertices` pide el color
  con el índice de FEATURE y `drawOnCanvas` pide el weight recorriendo `vertices`, que tiene una entrada
  por PARTE. Con features de una sola parte coinciden por accidente; con `MultiLineString` el weight hay
  que registrarlo contra un array paralelo a PARTES.
- **Primitiva de MARCADORES HTML: `<cristae-html-layer>` / `engine.addHtmlLayer`.** `L.divIcon` sobre
  Leaflet — **GL-safe** (no abre otro contexto WebGL). Su nicho: badges de dominio con contenido HTML
  arbitrario (heroicon SVG, glifo de fuente `<i class="fv-*">`, letra) + popup/tooltip, que el iconset
  canvas del point-layer no rinde. Es el **complemento** del point-layer GPU (alta cardinalidad /
  tiempo real), no su competidor — "3 badges con un heroicon dentro". Accessors: `{ idOf, positionOf,
  htmlOf, classNameOf?, sizeOf?, anchorOf? }`; handle sólo acciones `{ id, source, set, setVisible }`;
  picking por marcador más cercano (`kind:'html'`). Retira el `getLeafletMap()`+`L.divIcon` a mano que
  los consumidores hacían sólo para colgar HTML. Tipos `HtmlAccessors`/`HtmlHandle` en `types/map.d.ts`.
- **`<cristae-popup>`: ancla VIVA, `for` multi-capa y tarjetas simultáneas.** La tarjeta abierta
  deja de ser una foto del click: se suscribe a la `Source` de su capa y en cada flush (ya
  coalescido a rAF, mismo patrón que `Camera.followPoint`) **sigue la posición del item**
  (`move`/`patch`) sin re-render, **re-ejecuta `contentOf`** cuando un `set`/`patch` reemplaza su
  objeto, y **se cierra** si el id sale del dataset. Superficie nueva: `follow` (default `true`;
  `"false"` congela el ancla al punto de apertura), `for` como **token-list** (capas hermanas que
  presentan los MISMOS datos — idealmente la misma instancia de `Source` — abren la misma tarjeta),
  `max-open` (default `1` = abrir reemplaza, como siempre; N>1 = una tarjeta por item con cupo FIFO),
  `open(item)` con `latlng` **opcional** (sin él, ancla viva; con él, congelada — colocaciones
  presentadas por overlay/spider), `close(id?)` (por id de dato, o todas) y `refresh()` (re-ejecuta
  `contentOf` de lo abierto, misma ancla, sin auto-pan — para refrescos transversales del consumidor,
  p. ej. idioma). El callback de flush va aislado con `safe`: un `contentOf` que lance no corta el
  fan-out del Emitter. Costo: comparaciones O(1) por tarjeta por flush, sin allocs en el camino
  caliente; un move **nunca** re-ejecuta `contentOf`. Docs en `docs/elements.md` + SPECS §8.5.
- **Eje `enabled` en `<cristae-point-layer>`: membresía de la ENTIDAD en la composición.**
  Ortogonal a `visible` (que queda como pintado puro — sprites ocultos, la capa sigue componiendo):
  una capa deshabilitada **aporta ∅ a los modificadores que la consumen** — el fold de cluster
  indexa `source ∧ where` de los hosts HABILITADOS (espejo del mecanismo `setWhere → reindex`),
  así que sus burbujas se recomputan sin los puntos del host apagado (todos apagados → sin
  burbujas; una sesión de expansión abierta se cierra con `cluster:dismiss` al podarse el ancla).
  Además oculta su pane, limpia su picking, y **arrastra a sus LIGADOS**: labels `bind-to` (por su
  canal nativo `setVisibility` — pane + gate de pintado juntos; el toggle del consumidor sólo
  registra su intención mientras el host está apagado, sin re-mostrar el canvas retenido) y
  overlays (pane + gate). El **pipeline de render deja de reaccionar a la Source** mientras está
  deshabilitada (`PointLayer.#enabled`, mismo patrón que `LabelLayer`): cero CPU/GPU por emit del
  WS; al re-habilitar, `refresh()` de catch-up (la Source siguió viva → la capa vuelve al día).
  Capas/overlays que NACEN con el host deshabilitado nacen gateados; `attachSource` conserva el
  gate. Superficie: atributo/prop `enabled` (default `true`), handle `setEnabled`,
  `engine.setLayerEnabled(id, enabled)`. `setLayerVisibility` ahora compone la visibilidad
  efectiva del pane (`visible ∧ enabled`, el del host para ligados). Retro-compatible: todo el
  comportamiento nuevo se gatea por `enabled === false`, que ningún consumidor existente setea.
- **Tipos TypeScript publicados en el paquete (`types/`).** Los entries `cristae/core`,
  `cristae/table` y `cristae/map` declaran su condición `types` en `exports`: contrato
  Source completo (`createSource`/`defineSource`/`makeFilter`, `patch(items, dirtyIds)`
  con `dirtyIds` requerido), IconSets (`defineIconSet`/`defineClusterIconSet` con la
  firma real `draw(ctx, size, count, plus, dim?, marked?)`, `prerenderFonts`),
  `PolygonAccessors`, `drawLabel`, `tilePresets`, y el motor de tabla (`PagedTable`,
  `paginationModel`, `PageInfo`). Los consumidores TypeScript dejan de mantener
  declaraciones espejo a mano (que ya habían divergido en firmas). Las clases de los
  custom elements se declaran mínimas; la superficie de instancia se documenta en docs/.
- **Eje "marked": señalizar las burbujas que contienen ids marcados (`markedIds` + `cluster:marked`).**
  El consumidor marca un SET de ids de dato (`<cristae-cluster>.markedIds`, por propiedad; o
  `control.setMarked(ids)`) y la librería hace dos cosas, ambas a cadencia de recluster: (1) pinta la
  burbuja que contiene alguno con la variante `marked` del icon-set — `defineClusterIconSet` suma el
  prefijo `'m'` (espejo del `'d'` de expandido) y pasa `marked` como 6º arg del `draw`, backward-compatible —
  y (2) emite la señal del motor **`cluster:marked`** (`map.on('cluster:marked', cb)`, mismo bus que
  `cluster:expand`) con el hecho mínimo no-derivable: `{ hidden: [{ layerId, id, center }] }` — qué
  marcados quedaron OCULTOS en una burbuja colapsada y el centro geográfico de esa burbuja (ancla para
  líneas/overlays del consumidor). Un marcado solo o desplegado en la espiral es visible → no viaja; la
  posición viva la da la Source del consumidor, nunca el evento. Emisor único en `apply()` gateado por
  firma (id + centro cuantizado `MARKED_CENTER_QUANT`): los moves de WS intra-bucket no re-emiten, y el
  drift del centroide por miembros no-marcados sí (el ancla no queda despegada del sprite). Lectura
  imperativa de paridad: `control.getMarked()` / getter `cluster.marked`. El cómputo vive en
  `Cluster.#refreshMarked` (gate O(|marcados|) sin tocar el índice + `getLeaves` con early-stop, sólo si
  quedó alguno oculto) y se lee por `Cluster.markedHidden` (snapshot O(1)). Config `dim-marked` (+
  `dimRestExcept` por propiedad): con ids marcados, atenúa el resto del mapa vía el mismo enfoque del
  fold (`syncFocus`), dejando brillantes las capas que el consumidor indique. **Ortogonal al
  seguimiento de cámara** (`camera.followPoint`/`revealPoint`): marcar no mueve la cámara y seguir
  no marca — son handles independientes que el consumidor compone, típicamente derivando AMBOS del
  mismo estado de dominio ("el móvil seguido") para que activar/cancelar restaure todo junto. Test:
  `test/marked-bubble.test.mjs`.

- **Burbuja de cluster consultable (interacción genérica): `bubbleLayerId` + hover + `contentsOf`.**
  La burbuja deja de ser interna-del-fold y pasa a entidad de primera clase del picking: el consumidor
  descubre su capa (`<cristae-cluster>.bubbleLayerId`) y se suscribe a sus hits por el bus normal
  (`map.on('click' | 'hover', bubbleLayerId, cb)` — el hover de burbuja antes estaba deshabilitado; ahora
  resuelve real y sigue demand-gated: cero costo sin suscriptores). `contentsOf(clusterId)` (elemento y
  control; `Cluster.contents` puro) devuelve los ids de dato de una burbuja del frame actual — hermana de
  `expand()` sin efectos, misma guarda de generación anti-stale, snapshot congelado para la burbuja dim de
  una sesión abierta. Con `expandable=false` + estos tres handles, el consumidor compone sus propias
  interacciones (tooltip de contenido al hover, click→fit/expand, resaltado por contenido) sin tocar la lib.

- **Enfoque desclusterizado: `camera.revealPoint(layerId, id, {zoom})` + `followPoint({reveal})`.**
  Enfocar un elemento seleccionado y que **no quede escondido en una burbuja** de cluster: `revealPoint`
  (one-shot, por id como `followPoint`, puntual como `setView`) sube el zoom al mínimo que lo desclusteriza
  si su capa clusteriza; `followPoint({reveal:true})` arranca el seguimiento a ese zoom. El cálculo vive en
  `Cluster.declusterZoomFor(id)` — cómputo **puro** (no muta `clusteredIds`/`bubbles`/firma): menor zoom entero
  ∈ `[0, maxZoom+1]` al que el punto es solo, por búsqueda binaria (monótono en zoom) con la MISMA query
  worldwide que `recluster` (coincide exacto con `clusteredIds`).
  El motor **inyecta** ese cómputo en la cámara (`declusterZoomOf(layerId,id)`, leído del fold de la capa) igual
  que `resolveSource` → `Camera` sigue sin conocer el cluster. Expuesto también en el `control` del fold. Test:
  `test/decluster-zoom.test.mjs` (punto único → 0; casi-coincidentes → `maxZoom+1`; borde cruzado contra
  `recluster`/`clusteredIds`; pureza).

- **Eventos de la sesión de expansión de cluster (`cluster:expand` / `cluster:update` / `cluster:dismiss`).**
  `<cristae-cluster>` publica su estado de spiderfy por el **bus del motor** (`map.on('cluster:expand', cb)
  → off`), con el mismo estilo delta que `hover:start`/`hover:end` (no un `CustomEvent` bespoke del
  elemento). `expand` = se abrió una burbuja base (nueva sesión); `update` = la sesión activa cambió (se
  drilleó/cerró una **subburbuja** — antes esto NO emitía nada — o la membresía creció/encogió por poda);
  `dismiss` = cerró (colapso/zoom/`enabled=false`) o el ancla desapareció. El payload es un POJO agrupado y
  heterogéneo-safe: `{ id, center, count, entities:[{layerId,id,item}], groups:[{id,count,expanded,entities}] }`
  — `entities` plano para "buscar todo", `groups` = subburbujas con la drilleada marcada (`expanded`), `[]`
  si el base es plano (≤ `splitThreshold`). La membresía es el **snapshot congelado** de la sesión (sólo
  re-emite en cambios estructurales, nunca por un `move`), pensado para alimentar un panel/tabla en vivo
  desde la misma Source. Lectura imperativa: getter `cluster.session`. Arquitectura: `Cluster.sessionStructure`
  + `#partitionGroups` (partición lógica separada del render); `MapEngine.apply()` es el emisor ÚNICO
  (compara sesión previa↔nueva por id + firma) → cubre toda causa de cierre y elimina la asimetría en que
  el click de subburbuja no emitía. Reemplaza los `cristae:cluster-expand`/`cristae:cluster-collapse`
  previos (sin consumidores).

- **Keep-in-view opt-in `fit` en `<cristae-popup>`** (`fit="flip shift clip"`, `fit-padding`,
  `data-side`): la tarjeta se mantiene a la vista **moviéndose ella** (no la cámara) — clave cuando
  la capa vive en un `<cristae-cluster>`, donde el auto-pan recolapsaría el spiderfy. Los tokens
  activan etapas de un pipeline fijo lado→corrimiento→recorte (su **orden es irrelevante**): `flip`
  elige encima/debajo según dónde entre la caja (más espacio como desempate), `shift` desliza lo
  mínimo, y `clip` recorta contra el borde **real** del mapa (`fit-padding` sólo anticipa
  flip/shift, nunca corre el corte). La geometría es pura y sin DOM (`popupPlacement.js`, con test
  propio en `test/popup-placement.test.mjs`); la caja se computa entera por frame desde (ancla
  proyectada, tamaño, viewport − insets) y se escribe literal — sin transform ni estado entre
  frames. `fit`/`fit-padding` se normalizan en el punto de uso, así funcionan igual por atributo o
  por propiedad (frameworks que asignan propiedades no pasan por el converter, p. ej. React 19);
  atributo removido o vacío ⇒ vuelve al camino legacy. **Sin `fit`, nada cambia.**

- **Canal de evento `secondary-click` (click contextual: botón secundario / long-press / tecla Menú).**
  `map.on('secondary-click', layerId?, cb)` entrega los hits GPU-pickeados en el punto del gesto por el
  MISMO camino síncrono que el click primario (`resolveClick`) — el botón no cambia dónde cae el hit, sólo
  cuál se apretó. Es un canal DISCRETO con su propio bit de demanda (`EVENT_SECONDARY`): no abre sesión de
  picking de hover (`PICK_CHANNELS` lo excluye) y por ende no toca el cursor. El menú nativo del browser
  queda **intacto por default** — el listener va por el `contextmenu` del DOM (no por el evento de Leaflet)
  y es no-passive, así el consumidor lo suprime con `event.preventDefault()` sólo cuando resolvió un hit
  propio. Sin suscriptores: cero costo y comportamiento nativo sin cambios.

- **`subBubbleLayerId` en `<cristae-cluster>` (+ `control`): capa de sub-burbujas de la espiral consultable.**
  Hermano de `bubbleLayerId` para la jerarquía depth-2: el consumidor se suscribe a los hits de las
  sub-burbujas por el bus (`map.on('click' | 'secondary-click' | 'hover', subBubbleLayerId, cb)`); el
  `hit.id` es el ancla del grupo → se compone con la estructura de sesión (`cluster.session` / eventos
  `cluster:*`, que traen los miembros por grupo). `null` si no hay espiral.

- **`PagedTable.indexOf(item)` / `pageOf(item)`: posición y página de un ítem en la vista vigente.**
  Inverso de `itemAtRow`: `indexOf` devuelve la posición 0-based de `item` en la vista filtrada + ordenada
  (o -1 si no pasa el filtro), sin tocar el render — recorre el dataset una vez contando cuántas filas
  visibles ordenan antes; `pageOf` es azúcar (`⌊indexOf / pageSize⌋`) para "¿en qué página aparece esta
  fila?". Determinista mientras el `comparator` sea un orden total (con empates, la posición dentro del
  bloque empatado queda indefinida, igual que el particionado por quickselect del render). El gate de
  membresía se unificó en un helper (`#matches`): la MISMA regla `where` + búsqueda que el camino caliente.
  Publicado en `types/table.d.ts`.

### Cambiado
- **`<cristae-popup>` — notas de migración** (comportamiento observable respecto de la versión
  anterior; con datos estáticos no hay diferencia):
  - El nodo `.cristae-popup` se **crea por apertura y se remueve al cerrar** (antes era un único
    nodo persistente con `display:none`). No cachear referencias al nodo; en E2E asertar
    presencia/ausencia, no `display`; las animaciones CSS de entrada corren en cada apertura.
  - `contentOf` puede **re-ejecutarse** mientras la tarjeta está abierta (reemplazo del objeto por
    `set`/`patch`, o `refresh()`): cablear los listeners del contenido DENTRO de `contentOf` (cada
    re-render los repone) y no disparar side-effects "de apertura" ahí; el foco/selección dentro de
    la tarjeta no sobrevive un re-render.
  - La tarjeta **se cierra sola** si el id sale del dataset — incluye filtros del `Source`
    (`addFilter` que lo excluya: `itemById` lee la vista filtrada) y un `set([])` transitorio entre
    awaits (en el mismo tick el coalescing a rAF lo absorbe).
  - `close(x)` con argumento ahora cierra **por id de dato** (string/number); cualquier otro valor
    (p. ej. el `Event` de un `close` usado directo como handler) sigue cerrando todo.
  - `positionOf` puede devolver lat/lng numéricos **o strings numéricos** (se coercionan, paridad
    con la tolerancia de Leaflet); posiciones no finitas → la apertura es un no-op silencioso (antes
    lanzaba `Invalid LatLng` dentro del listener de click en cada reposición).
  - `offset`/`auto-pan-padding` asignados como **string por propiedad** ahora se parsean igual que
    por atributo (antes el camino legacy los destructuraba por caracteres).
  - Ids de capa con espacios dejan de ser direccionables por `for` (ahora es token-list).

### Corregido
- **El pick de una burbuja de cluster podía quedar una generación atrás del estado vivo.** El `feed` de la
  capa de burbujas hacía `Source.set()` (síncrono al store) pero difería a rAF el rebuild de buffers +
  picking; entre el recluster y ese rAF, un click resolvía contra el índice viejo y un cluster-id reciclado
  (los ids de Supercluster son densos) podía pasar la guarda y devolver OTRO cluster. Ahora el `feed`
  reconstruye buffers + `#idBySlot` + picking **en el mismo tick** (`layer.refresh()`), simétrico con los
  hosts y la espiral; el `#onChange` posterior del rAF re-camina los dirty ya escritos (idempotente,
  O(nº de burbujas)).

- **`Cluster.contents()` devolvía la membresía VIVA de la burbuja de una sesión abierta, no la que se vio.**
  Cuando el id consultado es el de la burbuja base de una sesión abierta (id vivo de Supercluster, no el
  sintético `'b:'`), ahora responde con el **snapshot congelado** (`#baseLeaves`) — el mismo conteo/hojas
  que la burbuja dim y la espiral renderizan — en vez del bucket vivo, que pudo ganar/perder miembros
  durante la sesión. Misma atomicidad con-lo-visto que las sub-burbujas. Sin sesión abierta, sin cambios.

- **La paginación mostraba un total "de N" congelado dentro de la misma cantidad de páginas.** El
  dirty-skip de `#updatePaginationUI` comparaba sólo página + nº de páginas, así que altas/bajas del dataset
  (o un cambio del `where` por ref + `refresh()`) que no cruzaban un borde de página no re-emitían `onPage`
  y la vista quedaba con el conteo viejo. Ahora también compara el total de ítems (`#lastTotal`).

- **Los updates incrementales de la capa de puntos sobrevivían sólo hasta el próximo render de
  glify.** `#writePosition`/`#writeSlot` escribían el buffer GPU (y su espejo `typedVertices`)
  pero NO los arrays CPU (`#positions`/`#meta`) desde los que glify REGENERA los vértices en cada
  render (move/zoom): un pan/zoom revertía todos los moves/patches al estado del último rebuild.
  Pasaba desapercibido en capas que algo reconstruye periódicamente (un host clusterizado se
  refresca en cada apply del fold), pero una capa alimentada sólo por la vía incremental —p. ej.
  una vista `where` de la misma Source— quedaba congelada. Ahora los writes incrementales
  mantienen también el espejo CPU.

- **El enfoque (`focus`/dim) ignoraba los overlays y trataba a las capas ligadas como
  independientes.** Un badge (`<cristae-overlay>`) quedaba a opacidad plena sobre su host
  atenuado. Ahora las capas LIGADAS (labels/overlays con `bindTo`) siguen la suerte de foco de su
  host, y el dim del fold cubre el kind `overlay`.

- **`attachSource` recreaba la capa sin su `where`.** Reemplazar la Source de una capa con
  membresía por-capa la dejaba mostrando la Source completa hasta el próximo `setWhere`. Ahora la
  capa nueva hereda el `where` del record.

- **`viewport-insets` reactivo en runtime.** El atributo de `<cristae-map>` sólo se aplicaba al
  crear el motor; cambiarlo después (abrir/cerrar un panel interno del consumidor) no actualizaba
  la región visible. Ahora re-aplica `camera.insets` y emite `viewportchange` — los overlays
  anclados (popup, botón central del cluster) se re-encuadran al instante. El botón central,
  además, ahora respeta los insets (se oculta bajo la franja ocluida), igual que el recorte del
  popup.

- **Medida de la tarjeta desactualizada si el contenido cambia tras `open`.** La medida única de
  `open` quedaba vieja cuando el contenido crecía después (datos async, imágenes) y el recorte
  operaba sobre una caja distinta a la pintada. Un ResizeObserver re-mide y re-encuadra al cambiar
  el tamaño — event-driven, el reposicionamiento por frame sigue sin forzar reflow.

- **Cursor `pointer` para capas clickeables sin handler de hover.** El "cursor automático" que
  promete SPECS §eventos ("si el set de hits incluye una capa `interactive`, el motor pone
  `cursor:pointer`") solo se aplicaba cuando había demanda del canal **hover**: una capa
  interactiva con únicamente un listener de `cristae:click` (caso típico: abrir un popup al
  clickear) nunca mostraba el puntero al pasar por encima de sus puntos GPU — quedaba el cursor de
  arrastre del mapa. Ahora el cursor es una affordance de la **interactividad**, desacoplado de la
  entrega de eventos de hover: la sesión de picking corre bajo demanda de **click u hover**
  (`PICK_CHANNELS`) y marca el puntero sobre cualquier feature interactiva, mientras que los
  eventos `cristae:hover` se siguen emitiendo solo bajo demanda de hover. Alinea la implementación
  con la spec y con la convención de Leaflet (`.leaflet-interactive { cursor: pointer }`).
  Arquitectura: `events.js` expone `PICK_CHANNELS`; `LayerRegistry.hasHitForChannels()` responde la
  consulta del cursor por máscara de canal; `Interaction` separa `#hoverDemand` (eventos) de
  `#pickDemand` (picking/cursor) y restaura el cursor al cerrar la sesión. Coste: un mapa solo-click
  ahora paga el picking de hover (throttled por `hover-throttle`) para el cursor.

## [0.1.0] - 2026-06-12

Primera versión pública (rebrand de Fastlet2).

### Añadido
- Tres entry points desacoplados: `core` (núcleo de datos reactivo, sin DOM), `table` (tabla
  virtual, sin Leaflet) y `map` (mapa WebGL sobre Leaflet/glify). `table` y `map` nunca se
  importan entre sí.
- Web components `<cristae-*>` (Lit), motor headless `MapEngine`, y los factories
  `createSource` / `defineSource` del núcleo.
- Build self-contained (`node build.mjs` → `dist/cristae`, ESM + UMD) para uso sin bundler.
- Animación de zoom **desactivada por defecto** (`zoom-animation="none"`); `zoom-animation="in-only"`
  la reactiva (zoom-in animado, zoom-out instantáneo).

### Portabilidad
- Eliminado el global `__DEBUG__` (las validaciones de contrato quedan siempre activas; corren
  una sola vez en setup, fuera del hot path).
- CSS base de Leaflet vendorizado como string JS (sin la query `?inline` de Vite), inyectado en
  el shadow DOM de `<cristae-map>` → portable entre bundlers (Vite, webpack, esbuild, rollup).
