# @cristae/react

Binding React oficial de Cristae. Los mapas Cristae son **custom elements** (`<cristae-*>`); este paquete
los envuelve en componentes React tipados, con una regla no negociable: **el DATO entra por propiedad, no
por reconciliación de React**. Así el hot-path (feed de posiciones a alta frecuencia) fluye por el core
reactivo del elemento (`source.move/patch` coalescido a rAF) **sin re-render de React por tick**.

El core sigue siendo **agnóstico** (sin React): este binding es un paquete adaptador aparte, como
`@react-leaflet`.

## Cómo funciona

Cada componente monta su `<cristae-*>` una sola vez y aplica las props con `applyElementProps`
(`src/apply-props.js`), diffeando contra el render anterior y clasificando cada prop por su valor:

| Tipo de prop | Canal | Ejemplo |
| --- | --- | --- |
| `string` / `number` | **atributo** kebab-case (`setAttribute`) | `initialZoom` → `initial-zoom="5"` |
| `boolean` | **propiedad** (`el.prop = value`) | `visible={false}` apaga la capa |
| objeto / función | **propiedad** — acá entra el **dato** | `data` / `source` / `accessors` / `iconSet` |
| `on[A-Z]…` función | **evento** (`addEventListener`) | `onViewportChange` → `cristae:viewportchange` |
| `on[A-Z]…` de un canal del **bus** | **`engine.on(canal[, layerId], cb)`** | `onClusterExpand` → `cluster:expand`; `onClick` de una capa → `click` filtrado por su id |

### Los dos canales de evento

El `<cristae-map>` puentea al DOM sólo `click` / `hover` / `pointermove` (+ `ready`, `viewportchange`,
`mapclick`, `interaction*`): eso es lo que viaja como `CustomEvent` `cristae:*` y lo que cabla
`addEventListener`. El resto vive **sólo en el bus del motor** — no hay evento DOM que escuchar, y el
nombre del canal ni siquiera se deriva del de la prop (`hover:start`, `secondary-click`,
`cluster:expand`). Esos handlers los resuelve una **tabla por tag** (`src/index.js`), que los saca de
las props del elemento y los suscribe con `engine.on`, re-suscribiéndolos en cada `cristae:ready`
(tras un re-montaje el motor es **otra** instancia):

| Componente | Props que van por el bus | Filtro |
| --- | --- | --- |
| `CristaeMap` | `onSecondaryClick` · `onHoverStart` · `onHoverEnd` | todas las capas |
| Capas de dato (point / line / polygon / html) | `onClick` · `onSecondaryClick` · `onHover` · `onHoverStart` · `onHoverEnd` | **su** capa |
| `CristaeCluster` | `onClusterExpand` · `onClusterUpdate` · `onClusterDismiss` · `onClusterMarked` | sesión del fold |

Un handler de bus recibe los **hits directos** (`(hits, event)`), no un `CustomEvent` con `detail`. En
una capa el filtro sale del id del handle vivo, y antes de montar, del `id` declarado; una capa sin
`id` queda a la espera y se cabla sola en el `cristae:ready` (el mapa monta las capas pendientes antes
de emitirlo). Suscribir sólo los canales declarados es lo que mantiene el *demand-counting* del motor:
**sin handler, sin picking**.

### El `ref` — lo imperativo

Todo componente publica su elemento vivo por `ref`, que es la única puerta a lo que no es estado
declarativo: `map.camera` / `map.engine` / `map.ready` (getters **vivos**: tras un detach+reattach son
otra instancia, no se cachean), el handle `controls` de cada capa (ruta caliente `move`/`patch`/
`addFilter`, sin re-render), `session` / `bubbleLayerId` / `contentsOf` del cluster y `open` / `close` /
`refresh` del popup.

```jsx
const map = useRef<CristaeMapElement>(null)
const fleet = useRef<CristaePointLayerElement<Movil>>(null)
…
map.current?.camera?.followPoint('fleet', id, { reveal: true })
fleet.current?.controls?.move(id, lat, lng)      // hot-path: sin pasar por React
```

> **Por qué los booleanos van por propiedad y no por atributo.** Las capas nacen con `visible`/`enabled`/
> `expandable` en `true` (constructor del elemento). Un atributo booleano de Lit no puede expresar `false`
> sobre una propiedad que ya es `true`: quitar un atributo AUSENTE no dispara `attributeChangedCallback`,
> así que `visible={false}` no ocultaría la capa. La propiedad es el canal fiable de los custom elements
> (el setter reactivo aplica on/off siempre).

El hook `useCristaeElement` aplica las props en un layout effect por render y, **al desmontar**,
desengancha los listeners (`detachElementListeners`) — atributos y propiedades mueren con el nodo.

## Componentes

```jsx
import { CristaeMap, CristaePointLayer, CristaeCluster, CristaePopup } from '@cristae/react'

<CristaeMap initialZoom={5} initialCenter={[-33.4, -70.6]} onViewportChange={cargarBbox}>
  <CristaePointLayer<Movil> id="fleet" data={moviles} accessors={acc} iconSet={iconSet}
                            visible where={m => m.estado === 'mov'} />
  <CristaeCluster radius={88} minPoints={2} expandable markedIds={marcados} />
  <CristaePopup for="fleet" contentOf={m => `<b>${m.patente}</b>`} />
</CristaeMap>
```

- **`CristaeMap`** — piel del `<cristae-map>`: `tile`, `initialCenter`/`initialZoom`, `zoomAnimation`,
  `viewportInsets`, `emptyMessage`, y los eventos `onReady` / `onViewportChange` / `onMapClick` /
  `onClick` / `onHover` / `onPointerMove` / `onInteractionStart` / `onInteractionEnd` (cada handler
  recibe el `CustomEvent` con su `detail` tipado) + los del bus (`onSecondaryClick`, `onHoverStart`,
  `onHoverEnd`).
- **Capas de dato** (genéricas sobre el ítem `T`): `CristaePointLayer`, `CristaeLineLayer`,
  `CristaePolygonLayer`, `CristaeHtmlLayer`, `CristaeLabelLayer`. Entrada `data` (el motor posee la
  Source) o `source` (el consumidor la comparte entre vistas — basta con que cumpla `CristaeReadSource`,
  lo que devuelve `defineSource`); `accessors`/`iconSet` tipados por capa, `onClick`/`onHover` filtrados
  por la capa y el eje `focusIds`.
- **Modificadores de composición**: `CristaeCluster` (con la sesión de expansión por `onCluster*` y el
  eje `markedIds`), `CristaeOverlay` (envuelven capas de puntos; el orden de anidación es la semántica).
- **`CristaePopup`** — tarjeta anclada al dato (`for` + `contentOf`); ancla viva por default.
- **`CristaeToolbar`** — dock flotante de acciones (`items` + `orientation`), colocado por `slot`.
- **`CristaeTable`** — el otro entry de la lib (`import 'cristae/table'` registra el elemento; no lo
  arrastra `cristae/map`). No es una capa: es standalone y consume el **mismo** contrato Source, así que
  una fuente alimenta mapa y tabla a la vez (`template`/`binder`, `search`, `onRowClick`).

Los tipos de props reusan los shapes de `cristae/map` (`PointAccessors<T>`, `IconSet`, `Insets`, …),
así el genérico `T` se infiere del `data`/`accessors` y un accessor mal formado se marca en compilación.
Los hits son una **unión discriminada** por `kind` (`point` / `polygon` / `line` / `html` / `circle`):
`hits[0].kind === 'line'` narrowea a `partIndex`/`vertexIndex`. `slot` es el union de las 9 zonas del
overlay (+ `empty`, y `bubble`/`center` dentro de un cluster), así que un typo no compila.

> `className`/`style` **no** se exponen: el aplicador imperativo los mapearía mal
> (`className` → atributo `class-name`). Estilar el contenedor del `<CristaeMap>` desde el padre; usar
> `slot` para colocar overlays/toolbars en las zonas del mapa.

## Estado — cristae 0.23

- ✅ **Núcleo** (`src/apply-props.js`): `applyElementProps` + `detachElementListeners`. Tested puro DOM
  (elemento fake, sin jsdom).
- ✅ **Hook** (`src/use-cristae-element.js`): layout effect + teardown de listeners al desmontar.
- ✅ **Componentes** (`src/index.js`): los diez `<cristae-*>` del mapa + `<cristae-table>`, sobre
  `createElement` (sin JSX/build), con `ref` al elemento vivo.
- ✅ **Canales del bus** (`src/index.js`): tabla por tag → `engine.on(canal[, layerId], cb)`, re-cableada
  en cada `cristae:ready`. Cubre `cluster:*`, `secondary-click` y `hover:start`/`hover:end`, más el
  `click`/`hover` **por capa**.
- ✅ **Props tipadas por componente** (`types/index.d.ts`), reusando `cristae/map`: hits como unión
  discriminada, tipos de los elementos para el `ref` (`CristaeMapElement`, `…LayerElement`,
  `CristaeClusterElement`, `CristaePopupElement`), sesión del cluster, painter de labels y `slot`.
- ✅ **Tests de render** (`test/render.test.mjs`, react-dom + jsdom): (a) el dato por propiedad y los
  escalares por atributo; (b) cambiar `data` re-asigna la propiedad **sin** re-renderizar los hijos
  React; (c) `onX` se cablea con `addEventListener` y se limpia al desmontar; (d) los canales del bus
  van por `engine.on` (filtrados por capa) y se dan de baja al desmontar; (e) el `ref` publica el
  elemento sin romper la aplicación de props.

```bash
npm test          # node --test — núcleo (fake element) + render (react-dom + jsdom)
npm run typecheck # tsc --noEmit --strict sobre types/ + typecheck/usage.tsx
```

## Pendiente (fuera de este paquete)

1. **`CristaePopup` con árbol React portaleado** a la posición viva (hoy el contenido es `contentOf` →
   string/Node); y un hook de realce (`addHighlightOverlay`) derivado de la selección.
2. **Retiro de los ref-wirings en Wing** (el payoff de LOC: −tipos-sombra −`useCristaeSource`) — es
   trabajo del repo consumidor, no de este binding.
