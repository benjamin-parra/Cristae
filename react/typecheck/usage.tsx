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
  CristaeShapeLayer,
  CristaeLabelLayer,
  CristaeToolbar,
  CristaeTable,
  type CristaeClusterElement,
  type CristaeLabelPaint,
  type CristaeMapElement,
  type CristaePointLayerElement,
  type CristaePopupElement,
  type CristaeShapeLayerElement,
  type CristaeTableElement,
  type CristaeViewportChangeDetail,
} from '@cristae/react'
import { MapEngine, adoptLeafletHost, arc, createSource, defineSource, defineIconSet, distance, drawLabel, sphere, toParts, type Bounds, type CristaeSource, type LineAccessors, type PointerSample } from 'cristae/map'
import { boundsOf, boundsPad } from 'cristae/geometry'

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
    minZoom={3}
    maxBounds={{ south: -85, west: -180, north: 85, east: 180 }}
    maxBoundsViscosity={1}
    cursor="crosshair"
    tile={{ url: 'https://tiles/{z}/{x}/{y}.png', maxZoom: 19 }}
    onViewportChange={(e) => {
      const d: CristaeViewportChangeDetail = e.detail
      void d.center.lat
      void d.zoom
      void d.bounds.south
    }}
    onClick={(e) => { void e.detail.hits[0]?.layerId; void e.detail.originalEvent.button }}
    onMapClick={(e) => { void e.detail.latlng.lng }}
    onPointerMove={(e) => { void e.detail.lat; void e.detail.x }}
    // Canales del bus (no hay CustomEvent): hits directos, sin `detail`; el hover trae la muestra.
    onHoverStart={(hits, muestra) => { void hits[0]?.id; void muestra.y }}
    onHoverEnd={(hits, muestra) => { void muestra?.lat }}
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
        void ev.pointerType
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
      z={378}
      accessors={{ idOf: (m) => m.id, pathOf: (m) => [[m.lat, m.lng]] as [number, number][] }}
    />
    <CristaeLabelLayer bindTo="fleet" textOf={(m: Movil) => m.patente} paint={paint} style={estilo}
                       pane="cristae-etiquetas" z={620} />
  </CristaeMap>
)

// Capa de formas: el radio en METROS (un número es círculo, `[a, b]` elipse), el rumbo y la apertura
// del sector opcionales; el estilo de capa es el de los polígonos. El borde curvo de una forma es `arc`
// en una capa de líneas.
interface Antena { id: number; lat: number; lng: number; alcance: number; azimut: number; haz: number }
const antenas: Antena[] = []
export const Cobertura = () => {
  const capa = useRef<CristaeShapeLayerElement<Antena>>(null)

  return (
    <CristaeMap>
      <CristaeShapeLayer<Antena>
        ref={capa}
        data={antenas}
        accessors={{
          idOf       : (a) => a.id,
          positionOf : (a) => ({ lat: a.lat, lng: a.lng }),
          radiusOf   : (a) => [a.alcance, a.alcance / 2],
          headingOf  : (a) => a.azimut,
          sweepOf    : (a) => a.haz,
          styleOf    : () => ({ fillOpacity: 0.2 }),
        }}
        color="#0f766e"
        weight={2}
        fill={false}
        focusIds={[1]}
        onClick={(hits) => { const top = hits[0]; if (top?.kind === 'shape') void top.ref }}
      />
      <CristaeLineLayer<{ id: number; center: [number, number]; radius: number }>
        data={[]}
        accessors={{ idOf: (f) => f.id, pathOf: arc }}
      />
      <button onClick={() => capa.current?.controls?.set(antenas)}>recargar</button>
    </CristaeMap>
  )
}

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
export const ConTabla = () => {
  const tabla = useRef<CristaeTableElement<Movil>>(null)

  return (
    <>
      <CristaeMap>
        <CristaePointLayer<Movil> id="fleet" source={readOnly} accessors={acc} iconSet={iconSet} />
      </CristaeMap>
      <CristaeTable<Movil>
        ref={tabla}
        source={readOnly}
        template='<tr><td data-ref="pat"></td></tr>'
        binder={(refs, m) => { refs.pat.textContent = m.patente }}
        pageSize={100}
        searchBy={(m) => m.patente}
        where={m => m.estado === 'mov'}
        onRowClick={(e) => { void e.detail.item.patente; void e.detail.row }}
      />
      <button onClick={() => tabla.current?.controls?.setPage(0)}>primera</button>
    </>
  )
}

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

  // La cámara devuelve objetos planos y acepta cualquier forma de punto y de caja.
  const encuadrar = () => {
    const camera = map.current?.camera
    if (!camera) return
    const vista: Bounds = camera.getBounds()
    camera.fitBounds(boundsPad(vista, 0.1))
    camera.fitBounds([{ latitude: -33, longitude: -70 }, [-34, -71]])
    camera.fitBounds(vista, { insets: { top: 40 }, maxZoom: 15, animate: false })
    camera.setView({ lat: -33, lon: -70 }, 10)
    void camera.latLngToContainerPoint(camera.getCenter()).x
    void camera.containerPointToLatLng([10, 20]).lng
  }

  // Las señales del motor entregan su payload directo, el mismo que el detail del evento del DOM.
  const escuchar = () => map.current?.ready.then((engine) => {
    engine.on('viewportchange', (vista: CristaeViewportChangeDetail) => { void vista.bounds.south })
    engine.on('move', () => {})
    engine.on('map:click', ({ latlng }) => { void latlng.lng })
    engine.on('interactionstart', () => {})
  })

  return (
    <CristaeMap ref={map} onSecondaryClick={(hits, ev) => { void hits[0]?.layerId; void ev?.button }}>
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
      <button slot="top-left" onClick={encuadrar}>encuadrar</button>
      <button slot="bottom-left" onClick={escuchar}>escuchar</button>
    </CristaeMap>
  )
}

// ── Geometría: un path de arrays numéricos, como llega de un JSON, entra sin castear ─────────
const recorrido: number[][] = [[-33.45, -70.66], [-33.05, -71.62]]
export const caja: Bounds | null = boundsOf(recorrido)
export const medidas: number[] = [
  distance(recorrido),
  distance(sphere(6378137), recorrido),
  distance([recorrido, recorrido]),
  distance([-33.45, -70.66], [-33.05, -71.62]),
]
export const partes = toParts([recorrido])
export const porTramo: LineAccessors<{ id: number; puntos: number[][] }> = { idOf: t => t.id, pathOf: t => t.puntos }

// ── El motor headless: un mapa propio sobre un contenedor, o uno de Leaflet adoptado ─────────
export const propio   = (container: HTMLElement) => new MapEngine({ container, view: { center: [-33.45, -70.66], zoom: 12 } })
export const adoptado = (map: unknown) => new MapEngine({ host: adoptLeafletHost(map), zoomAnimation: 'on' })
export const limitado = (engine: MapEngine) => engine.setLimits({ minZoom: 3, maxZoom: null, maxBounds: [[-85, -180], [85, 180]] })

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

// una caja de límites que no es una caja.
// @ts-expect-error maxBounds es una caja o un par de esquinas
export const BadBounds = () => <CristaeMap maxBounds={[-85, -180, 85, 180]} />

// un número suelto no es un punto ni un path.
// @ts-expect-error distance no mide un número
export const BadDistance = distance(3)

// la muestra del puntero llega congelada: se lee, no se escribe.
// @ts-expect-error lat es de sólo lectura
export const BadSample = (muestra: PointerSample) => { muestra.lat = 0 }

// la caja de la cámara es plana: no trae los métodos de Leaflet.
// @ts-expect-error Bounds no tiene pad
export const BadBounds = (camera: NonNullable<CristaeMapElement['camera']>) => camera.getBounds().pad(0.1)

// la vista de `viewportchange` en el motor también trae la caja plana.
// @ts-expect-error Bounds no tiene pad
export const BadSignal = (engine: MapEngine) => engine.on('viewportchange', (vista) => vista.bounds.pad(0.1))

// un objeto cualquiera no es un mapa adoptado.
// @ts-expect-error MapHost sale de adoptLeafletHost
export const BadHost = () => new MapEngine({ host: {} })

// slot fuera de las zonas del overlay (un typo quedaría mudo en runtime).
// @ts-expect-error "arriba" no es una zona del overlay 3×3
export const BadSlot = () => <CristaeToolbar slot="arriba" />

// el hit de línea sólo expone partIndex/vertexIndex tras discriminar por `kind`.
export const BadHit = () => (
  // @ts-expect-error vertexIndex no existe en un hit sin discriminar
  <CristaePointLayer<Movil> id="fleet" data={moviles} accessors={acc} onClick={(hits) => void hits[0]?.vertexIndex} />
)
