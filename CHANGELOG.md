# Changelog

Todas las versiones notables de Cristae se documentan en este archivo. El formato sigue
[Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y el versionado [SemVer](https://semver.org/lang/es/).

## [Sin publicar]

### Añadido
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
