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
  recibe el `CustomEvent` con su `detail` tipado).
- **Capas de dato** (genéricas sobre el ítem `T`): `CristaePointLayer`, `CristaeLineLayer`,
  `CristaePolygonLayer`, `CristaeHtmlLayer`, `CristaeLabelLayer`. Entrada `data` (el motor posee la
  Source) o `source` (el consumidor la comparte entre vistas); `accessors`/`iconSet` tipados por capa.
- **Modificadores de composición**: `CristaeCluster`, `CristaeOverlay` (envuelven capas de puntos;
  el orden de anidación es la semántica).
- **`CristaePopup`** — tarjeta anclada al dato (`for` + `contentOf`); ancla viva por default.
- **`CristaeToolbar`** — dock flotante de acciones (`items` + `orientation`), colocado por `slot`.

Los tipos de props reusan los shapes de `cristae/map` (`PointAccessors<T>`, `IconSet`, `Insets`, …),
así el genérico `T` se infiere del `data`/`accessors` y un accessor mal formado se marca en compilación.

> `className`/`style` **no** se exponen: el aplicador imperativo los mapearía mal
> (`className` → atributo `class-name`). Estilar el contenedor del `<CristaeMap>` desde el padre; usar
> `slot` para colocar overlays/toolbars en las zonas del mapa.

## Estado — 0.16

- ✅ **Núcleo** (`src/apply-props.js`): `applyElementProps` + `detachElementListeners`. Tested puro DOM
  (elemento fake, sin jsdom).
- ✅ **Hook** (`src/use-cristae-element.js`): layout effect + teardown de listeners al desmontar.
- ✅ **Componentes** (`src/index.js`): los diez `<cristae-*>` sobre `createElement` (sin JSX/build).
- ✅ **Props tipadas por componente** (`types/index.d.ts`), reusando `cristae/map`.
- ✅ **Tests de render** (`test/render.test.mjs`, react-dom + jsdom): (a) el dato por propiedad y los
  escalares por atributo; (b) cambiar `data` re-asigna la propiedad **sin** re-renderizar los hijos
  React; (c) `onX` se cablea con `addEventListener` y se limpia al desmontar.

```bash
npm test          # node --test — núcleo (fake element) + render (react-dom + jsdom)
npm run typecheck # tsc --noEmit --strict sobre types/ + typecheck/usage.tsx
```

## Pendiente (fuera de este paquete)

1. **`CristaePopup` con árbol React portaleado** a la posición viva (hoy el contenido es `contentOf` →
   string/Node); y un hook de realce (`addHighlightOverlay`) derivado de la selección.
2. **Retiro de los ref-wirings en Wing** (el payoff de LOC: −tipos-sombra −`useCristaeSource`) — es
   trabajo del repo consumidor, no de este binding.
