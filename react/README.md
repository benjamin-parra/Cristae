# @cristae/react

Binding React oficial de Cristae. Los mapas Cristae son **custom elements** (`<cristae-*>`); este paquete
los envuelve en componentes React, con una regla no negociable: **el DATO entra por propiedad, no por
reconciliación de React**. Así el hot-path (feed de posiciones a alta frecuencia) fluye por el core
reactivo del elemento (`source.move/patch` coalescido a rAF) **sin re-render de React por tick**.

El core sigue siendo **agnóstico** (sin React): este binding es un paquete adaptador aparte, como
`@react-leaflet`.

## Estado — fundación (0.16 en curso)

- ✅ **Núcleo tested**: `applyElementProps` (`src/apply-props.js`). Aplica props al custom element
  clasificándolas y **diffeando** contra el render anterior:
  - **atributo** (string/number/boolean/null) → `setAttribute`/`removeAttribute` (kebab-case);
  - **propiedad** (objeto/función no-evento) → `element[key] = value` — acá entra el **dato**
    (`source`/`data`/`accessors`/`iconSet`);
  - **evento** (`on[A-Z]…` función) → `add`/`removeEventListener` con el nombre mapeado.
  Cobertura: `test/apply-props.test.mjs` (`node --test react/test`).
- 🟡 **Scaffold**: `useCristaeElement` (hook, layout effect) + los componentes (`CristaeMap`,
  `CristaePointLayer`, `CristaeCluster`, `CristaePopup`, …) sobre `createElement` (sin JSX/build).
  Escritos, **aún sin tests de render** (requieren React + jsdom).

## Pendiente (próxima pasada dedicada)

1. **Infra de test de componentes** (React + jsdom / testing-library) y build del paquete.
2. **Props tipadas por componente** reusando los configs de `cristae/map`
   (`PointLayerConfig`, `HighlightOverlayConfig`, `Camera`, …) → retira los tipos-sombra en Wing.
3. `<CristaePopup>` con árbol React portaleado a la posición viva; hook de `highlightOf` derivado de
   `selectedIds`/`focus` (sobre `addHighlightOverlay`).
4. Retiro de los ref-wirings en Wing (el payoff de LOC: −tipos-sombra −`useCristaeSource`).

## Uso (previsto)

```jsx
import { CristaeMap, CristaePointLayer, CristaeCluster } from '@cristae/react'

<CristaeMap tileset="mapa" theme="auto" onViewportChange={cargarBbox}>
  <CristaePointLayer data={moviles} accessors={acc} iconSet={iconSet}
                     selectedIds={sel} onSelect={setSel} />
  <CristaeCluster enabled />
</CristaeMap>
```

`data`/`accessors`/`iconSet`/`source` van por **propiedad** (sin reconcile); `tileset`/`theme` por
**atributo**; `onViewportChange`/`onSelect` por **evento** (`cristae:viewportchange` / `cristae:select`).
