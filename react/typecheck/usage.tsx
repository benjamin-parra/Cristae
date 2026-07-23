// Type-test (no se publica): ejercita la superficie tipada de @cristae/react con tsc --strict. Verifica
// que las props por componente resuelven, que el genérico T se infiere del dato/accessors, que los
// eventos entregan el detail correcto y que un mal uso NO compila (@ts-expect-error). No se ejecuta.

import {
  CristaeMap,
  CristaePointLayer,
  CristaeCluster,
  CristaeOverlay,
  CristaePopup,
  CristaeLineLayer,
  CristaeLabelLayer,
  CristaeToolbar,
  type CristaeViewportChangeDetail,
} from '@cristae/react'
import { createSource, defineIconSet, type CristaeSource } from 'cristae/map'

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
  >
    <CristaePointLayer<Movil>
      id="fleet"
      data={moviles}
      accessors={acc}
      iconSet={iconSet}
      visible={false}          // booleano: apaga la capa (por propiedad)
      where={(m) => m.estado === 'mov'}
    />
    <CristaeCluster radius={88} minPoints={2} expandable markedIds={[1, 2]} circleThreshold="auto" />
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
    <CristaeCluster>
      <CristaeOverlay<Movil> iconSet={iconSet} variantOf={(m) => m.estado}>
        <CristaePointLayer<Movil> id="fleet" source={source} accessors={acc} iconSet={iconSet} />
      </CristaeOverlay>
    </CristaeCluster>
    <CristaeLineLayer<Movil>
      source={source}
      vector
      accessors={{ idOf: (m) => m.id, pathOf: (m) => [[m.lat, m.lng]] as [number, number][] }}
    />
    <CristaeLabelLayer bindTo="fleet" textOf={(m: Movil) => m.patente} />
  </CristaeMap>
)

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
