// Type-test (no se publica): la pantalla (b), un predio con pendientes en tres clases recortadas a sus
// límites y curvas cada 10 m, en planta. Verifica que la capa de terreno, su `ref` con `measure` y los
// hits de la capa de polígonos resuelven con tsc --strict. No se ejecuta.

import { useRef, useState } from 'react'
import {
  CristaeLabeled,
  CristaeMap,
  CristaePolygonLayer,
  CristaePopup,
  CristaeScale,
  CristaeTerrainLayer,
  type CristaeHit,
  type CristaePolygonHit,
  type CristaeTerrainLayerElement,
} from '@cristae/react'
import { MapEngine, terrainPresets, type Relief, type TerrainLayerHandle } from 'cristae/map'

type Predio = { rol: string; superficieHa: number; anillos: [number, number][][] }

const AREA = { south: -37.65, west: -73.0, north: -37.45, east: -72.7 }
const FIELDS = { id: 'rol', rings: 'anillos' } as const
const COLORES = ['#a6d96a', '#fdae61', '#d7191c']
const rol = (p: Predio) => p.rol
const ficha = (p: Predio) => `Rol <b>${p.rol}</b> · ${p.superficieHa.toFixed(1)} ha`

export function PredioRelieve({ predios }: { predios: Predio[] }) {
  const relieve = useRef<CristaeTerrainLayerElement>(null)
  const [cifra, setCifra] = useState('Pulsar un predio')

  const medir = async (hits: CristaeHit[]) => {
    const hit = hits.find((h): h is CristaePolygonHit => h.kind === 'polygon')
    const predio = predios.find(p => p.rol === hit?.id)
    const capa = relieve.current?.controls
    if (!predio || !capa) return
    const r: Relief = await capa.measure(predio.anillos)
    setCifra(`${predio.rol}: ${(r.slope.areas[2] / 10_000).toFixed(1)} ha sobre 30 %`)
  }

  return (
    <>
      <CristaeMap tile="osm" initialCenter={[-37.55, -72.85]} initialZoom={14} maxBounds={AREA}>
        <CristaeTerrainLayer ref={relieve} id="relieve" dem="aws" colorBy="slope" slopeBreaks="15% 30%"
                             slopeColors={COLORES} contours={10} clipTo="predios"
                             onLoad={e => e.detail.count.toFixed()} onError={e => e.detail.code.toUpperCase()} />
        <CristaeLabeled textOf={rol} placement="center">
          <CristaePolygonLayer<Predio> id="predios" data={predios} fields={FIELDS} interactive
                                       fill={false} color="#111827" weight={2} onClick={medir} />
        </CristaeLabeled>
        <CristaePopup for="predios" contentOf={ficha} />
        <CristaeScale slot="bottom-left" />
      </CristaeMap>
      <output>{cifra}</output>
    </>
  )
}

// Las demás maneras de dar los mismos valores, y lo que no compila.
export const variantes = [
  <CristaeTerrainLayer key="a" id="a" dem={terrainPresets.mapterhorn} slopeBreaks={[0.15, 0.3]} elevationRange="200 600" />,
  <CristaeTerrainLayer key="b" dem={{ ...terrainPresets.aws, zoom: 12 }} elevationRange={[200, 600]} hillshade={false} opacity={0.6} />,
  // @ts-expect-error `dem` es un nombre de `terrainPresets` o un `TerrainSource`
  <CristaeTerrainLayer key="c" dem="otro" />,
  // @ts-expect-error `colorBy` no admite otra cosa que none, elevation o slope
  <CristaeTerrainLayer key="d" dem="aws" colorBy="aspect" />,
]

export function desdeElMotor(engine: MapEngine) {
  const capa: TerrainLayerHandle = engine.addTerrainLayer({ id: 'relieve', dem: 'aws', slopeBreaks: [0.15, 0.3], clipTo: 'predios' })
  capa.update({ contours: 10, elevationRange: null })
  const h: number = capa.elevationAt([-37.55, -72.85])
  const predios = engine.addPolygonLayer({ id: 'predios', url: './datos/predios.geojson', fields: { id: 'rol' } })
  const zona = predios.geometryOf('101-1')
  if (zona) void capa.measure(zona, { signal: new AbortController().signal })
  // @ts-expect-error `id` no se cambia con update
  capa.update({ id: 'otro' })
  return h
}
