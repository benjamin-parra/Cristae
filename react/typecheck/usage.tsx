// Type-test (no se publica): ejercita la superficie tipada de @cristae/react con tsc --strict. Verifica
// que las props por componente resuelven, que el genérico T se infiere del dato/accessors, que los
// eventos entregan el detail correcto, que el `ref` abre el escape imperativo (engine/camera/controls/
// popup) y que un mal uso NO compila (@ts-expect-error). No se ejecuta.

import { useRef } from 'react'
import {
  CristaeMap,
  CristaePointLayer,
  CristaeCluster,
  CristaeOverlay,
  CristaePopup,
  CristaeLineLayer,
  CristaeLabelLayer,
  CristaeToolbar,
  CristaeTable,
  type CristaeClusterElement,
  type CristaeLabelPaint,
  type CristaeMapElement,
  type CristaePointLayerElement,
  type CristaePopupElement,
  type CristaeViewportChangeDetail,
} from '@cristae/react'
import { createSource, defineSource, defineIconSet, drawLabel, type CristaeSource } from 'cristae/map'

interface Movil {
  id: number
  patente: string
  lat: number
  lng: number
  rumbo: number
  estado: 'mov' | 'stop'
}

const iconSet = defineIconSet({
  describe: () => ({ shape: 'dot' }),
  renderers: { dot: (ctx, size) => { ctx.fillRect(0, 0, size, size) } },
})

const acc = {
  idOf: (m: Movil) => m.id,
  positionOf: (m: Movil) => ({ lat: m.lat, lng: m.lng }),
  variantOf: (m: Movil) => m.estado,
  headingOf: (m: Movil) => m.rumbo,
}

const source: CristaeSource<Movil> = createSource<Movil>(acc)
const moviles: Movil[] = []

// Ruta `data`: T se infiere de data + accessors; el handler recibe el CustomEvent tipado.
export const ViaData = () => (
  <CristaeMap
    initialZoom={5}
    initialCenter={[-33.4, -70.6]}
    zoomAnimation="none"
    tile={{ url: 'https://tiles/{z}/{x}/{y}.png', maxZoom: 19 }}
    onViewportChange={(e) => {
      const d: CristaeViewportChangeDetail = e.detail
      void d.center.lat
      void d.zoom
    }}
    onClick={(e) => { void e.detail.hits[0]?.layerId }}
    // Canales del bus (no hay CustomEvent): hits directos, sin `detail`.
    onHoverStart={(hits) => { void hits[0]?.id }}
  >
    <CristaePointLayer<Movil>
      id="fleet"
      data={moviles}
      accessors={acc}
      iconSet={iconSet}
      visible={false}          // booleano: apaga la capa (por propiedad)
      where={(m) => m.estado === 'mov'}
      focusIds={[1, 2]}        // eje focus por ítem (cross-layer): el resto se atenúa
      // Bus filtrado por ESTA capa; el `kind` discrimina la forma del hit.
      onClick={(hits, ev) => {
        const top = hits[0]
        if (top?.kind === 'line') void top.vertexIndex
        void top?.presentedFrom
        void ev?.type
      }}
      onSecondaryClick={(hits) => { void hits.length }}
    />
    <CristaeCluster radius={88} minPoints={2} expandable markedIds={new Set([1, 2])} circleThreshold="auto" />
    <CristaePopup for="fleet" maxOpen={2} fit="flip shift" contentOf={(m: Movil) => `<b>${m.patente}</b>`} />
    <CristaeToolbar
      orientation="horizontal"
      items={[{ id: 'a', title: 'Capas', icon: '<svg/>', onClick: (it) => void it.id }]}
    />
  </CristaeMap>
)

// Ruta `source` (Source compartida) + composición cluster › overlay › punto + línea.
export const ViaSource = () => (
  <CristaeMap>
    <CristaeCluster focusIds={[1]}>
      <CristaeOverlay<Movil> iconSet={iconSet} variantOf={(m) => m.estado} focusIds={[]}>
        <CristaePointLayer<Movil> id="fleet" source={source} accessors={acc} iconSet={iconSet} />
      </CristaeOverlay>
    </CristaeCluster>
    {/* Apilado declarado: el recorrido va DEBAJO de los marcadores (que caen al z automático 400). */}
    <CristaeLineLayer<Movil>
      source={source}
      vector
      z={378}
      accessors={{ idOf: (m) => m.id, pathOf: (m) => [[m.lat, m.lng]] as [number, number][] }}
    />
    <CristaeLabelLayer bindTo="fleet" textOf={(m: Movil) => m.patente} paint={paint} style={estilo}
                       pane="cristae-etiquetas" z={620} />
  </CristaeMap>
)

// Una Source de `defineSource` es de sólo LECTURA (CristaeReadSource) y también entra por `source`.
const readOnly = defineSource<Movil>({ accessors: acc, getSnapshot: () => moviles, subscribe: () => () => {} })
const estilo = { surface: '#fff', text: '#0f172a', accent: '#2563eb' }
const paint: CristaeLabelPaint = (ctx, point, label, hovered, style) => {
  ctx.fillStyle = hovered ? style.accent : style.text
  ctx.fillText(label.text, point.x, point.y)
}
// El painter default de la lib entra en la prop: `paint={drawLabel}` es la composición canónica.
const paintDefault: CristaeLabelPaint = drawLabel

// La MISMA Source alimenta el mapa y la tabla (el otro entry de la lib).
export const ConTabla = () => (
  <>
    <CristaeMap>
      <CristaePointLayer<Movil> id="fleet" source={readOnly} accessors={acc} iconSet={iconSet} />
    </CristaeMap>
    <CristaeTable<Movil>
      source={readOnly}
      template='<tr><td data-ref="pat"></td></tr>'
      binder={(refs, m) => { refs.pat.textContent = m.patente }}
      pageSize={100}
      searchBy={(m) => m.patente}
      onRowClick={(e) => { void e.detail.item.patente; void e.detail.row }}
    />
  </>
)

// El `ref` es el escape imperativo: cámara/motor del mapa, handle de la capa, sesión del cluster y
// los métodos del popup.
export const ViaRef = () => {
  const map = useRef<CristaeMapElement>(null)
  const fleet = useRef<CristaePointLayerElement<Movil>>(null)
  const cluster = useRef<CristaeClusterElement<Movil>>(null)
  const popup = useRef<CristaePopupElement<Movil>>(null)

  const seguir = (m: Movil) => {
    map.current?.camera?.followPoint('fleet', m.id, { reveal: true })
    map.current?.ready.then((engine) => engine.fitToLayers(['fleet']))
    fleet.current?.controls?.move(m.id, m.lat, m.lng)          // ruta caliente: sin re-render
    cluster.current?.contentsOf(1)
    popup.current?.open(m)
  }

  return (
    <CristaeMap ref={map} onSecondaryClick={(hits) => { void hits[0]?.layerId }}>
      <CristaeCluster<Movil>
        ref={cluster}
        dimMarked
        markedIds={new Set([1])}
        onClusterExpand={(s) => { void s.count; void s.entities[0]?.item?.patente }}
        onClusterUpdate={(s) => { void s.groups[0]?.expanded }}
        onClusterDismiss={(d) => { void d.reason }}
        onClusterMarked={(m) => { void m.hidden[0]?.center.lat }}
      >
        <CristaePointLayer<Movil> ref={fleet} id="fleet" source={source} accessors={acc} iconSet={iconSet} />
      </CristaeCluster>
      <CristaePopup<Movil> ref={popup} for="fleet" contentOf={(m) => (m.estado === 'mov' ? `<b>${m.patente}</b>` : null)} />
      <button slot="top-right" onClick={() => seguir(moviles[0]!)}>seguir</button>
    </CristaeMap>
  )
}

// ── El mal uso NO compila ────────────────────────────────────────────────────

// accessors con la forma equivocada (idOf ausente) → error.
// @ts-expect-error idOf es obligatorio en PointAccessors
export const BadAccessors = () => <CristaePointLayer<Movil> data={moviles} accessors={{ positionOf: (m: Movil) => ({ lat: m.lat, lng: m.lng }) }} />

// prop escalar con tipo equivocado.
// @ts-expect-error initialZoom es number, no string
export const BadScalar = () => <CristaeMap initialZoom="cinco" />

// zoomAnimation fuera del union.
// @ts-expect-error "fast" no es un valor válido de zoomAnimation
export const BadUnion = () => <CristaeMap zoomAnimation="fast" />

// slot fuera de las zonas del overlay (un typo quedaría mudo en runtime).
// @ts-expect-error "arriba" no es una zona del overlay 3×3
export const BadSlot = () => <CristaeToolbar slot="arriba" />

// el hit de línea sólo expone partIndex/vertexIndex tras discriminar por `kind`.
export const BadHit = () => (
  // @ts-expect-error vertexIndex no existe en un hit sin discriminar
  <CristaePointLayer<Movil> id="fleet" data={moviles} accessors={acc} onClick={(hits) => void hits[0]?.vertexIndex} />
)
