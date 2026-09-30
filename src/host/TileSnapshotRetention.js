// Retención de imagen de tiles en el zoom que Leaflet no anima.
// Cuando Leaflet resetea la vista —un zoom que no anima, o un salto que no puede animar— suelta todos los
// tiles de golpe, y hasta que llega el nivel nuevo el mapa queda gris. La retención fotografía en un
// canvas los tiles cargados antes de que se suelten y deja la foto, reproyectada a la vista nueva, en un
// pane debajo del de tiles mientras el nivel nuevo carga encima. Qué hace en cada evento del reset y por
// qué se suscribe antes de que la capa entre al mapa, en docs/tiles.md#la-retención.
//
// Vive en el anfitrión porque lee lo que Leaflet no publica: `_tiles` y `_tileZoom` de la capa, la
// grilla de `_resetGrid` y `_wrapCoords`, y el evento `viewprereset`.

import { ZoomSnapshotStore } from '../tiles/ZoomSnapshotStore.js'
import { frameTransform } from '../render/frame.js'
import { TILE_FILTER } from './styles.js'

// El pane lleva el filtro de los tiles (styles.js): la foto no lleva uno propio. El pane de tiles de
// Leaflet está en 200: la foto queda debajo.
const PANE                    = 'tileZoomSnapshotPane'
const PANE_Z                  = 150
const SEED_ZOOM_OFFSETS       = [1, 2, 4, 8]
const MAX_SEED_TILES_PER_ZOOM = 24

// Une en un canvas unos tiles de un mismo zoom, puesto en la esquina que tienen en común. Es lo que
// guarda el almacén: el canvas, su zoom y su esquina en píxeles de ese zoom.
const snapshotOf = (tiles, zoom, tileSize) => {
  if (!tiles.length) return null

  let left   = Infinity
  let top    = Infinity
  let right  = -Infinity
  let bottom = -Infinity
  tiles.forEach(tile => {
    left   = Math.min(left, tile.left)
    top    = Math.min(top, tile.top)
    right  = Math.max(right, tile.left + tileSize.x)
    bottom = Math.max(bottom, tile.top + tileSize.y)
  })
  const width  = right - left
  const height = bottom - top
  const canvas = document.createElement('canvas')
  canvas.width                 = width
  canvas.height                = height
  canvas.style.position        = 'absolute'
  canvas.style.left            = '0px'
  canvas.style.top             = '0px'
  canvas.style.width           = `${width}px`
  canvas.style.height          = `${height}px`
  canvas.style.pointerEvents   = 'none'
  canvas.style.transformOrigin = '0 0'

  const ctx = canvas.getContext('2d', { alpha: true })
  if (!ctx) return null
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'low'
  tiles.forEach(tile => ctx.drawImage(tile.image, tile.left - left, tile.top - top, tileSize.x, tileSize.y))
  return { element: canvas, meta: { sourceZoom: zoom, sourcePixelTopLeft: { x: left, y: top } } }
}

// La URL de un tile de otro zoom. Leaflet la arma con la grilla del zoom de sus tiles —el zoom que va en
// la URL, la vuelta al mundo de la x y el rango con que invierte la y—: se le pone un momento la del zoom
// pedido y después se le devuelve la suya.
const tileUrlAtZoom = (layer, coords) => {
  const tileZoom  = layer._tileZoom
  layer._tileZoom = coords.z
  layer._resetGrid()
  try {
    return layer.getTileUrl(layer._wrapCoords(coords))
  } finally {
    layer._tileZoom = tileZoom
    layer._resetGrid()
  }
}

// Retiene la imagen de `layer` desde antes de que entre al mapa, y devuelve con qué soltarla. Precarga
// además, en tiempo ocioso, fotos de los zooms a los que se suele saltar desde la vista de partida: las
// semillas. Un reset, o soltar la retención, cancela la precarga en vuelo.
export const retainTileSnapshots = (map, surface, layer) => {
  const snapshotStore  = new ZoomSnapshotStore()
  let pane             = null
  let visibleSnapshots = []
  let seedGeneration   = 0
  let seedIdleId       = null

  // Avanzar la generación invalida la precarga en vuelo: entre tile y tile se fija si quedó vieja.
  const cancelSeedPrefetch = () => {
    seedGeneration++
    seedIdleId != null && cancelIdleCallback(seedIdleId)
    seedIdleId = null
  }

  // Una semilla: los tiles que cubrirían la vista a `zoom`, del centro hacia afuera. Se descarta entera si
  // uno no carga o si la precarga quedó vieja.
  const seedSnapshot = async (zoom, stale) => {
    const tileSize = layer.getTileSize()
    const center   = map.project(map.getCenter(), zoom)
    const halfSize = map.getSize().divideBy(2)
    const minX     = Math.floor((center.x - halfSize.x) / tileSize.x)
    const maxX     = Math.floor((center.x + halfSize.x) / tileSize.x)
    const minY     = Math.floor((center.y - halfSize.y) / tileSize.y)
    const maxY     = Math.floor((center.y + halfSize.y) / tileSize.y)
    const centerX  = Math.floor(center.x / tileSize.x)
    const centerY  = Math.floor(center.y / tileSize.y)
    const coords   = []
    for (let y = minY; y <= maxY; y++)
      for (let x = minX; x <= maxX; x++)
        coords.push({ x, y, z: zoom, distance: Math.abs(x - centerX) + Math.abs(y - centerY) })

    const load = url => new Promise(resolve => {
      const image = new Image()
      const { crossOrigin, referrerPolicy } = layer.options
      crossOrigin && (image.crossOrigin = crossOrigin === true ? '' : crossOrigin)
      referrerPolicy && (image.referrerPolicy = referrerPolicy)
      image.onload  = () => resolve(image)
      image.onerror = () => resolve(null)
      image.src     = url
    })
    const tiles = []
    for (const tile of coords.sort((a, b) => a.distance - b.distance).slice(0, MAX_SEED_TILES_PER_ZOOM)) {
      if (stale()) return null
      const image = await load(tileUrlAtZoom(layer, tile))
      if (!image || stale()) return null
      tiles.push({ image, left: tile.x * tileSize.x, top: tile.y * tileSize.y })
    }
    return snapshotOf(tiles, zoom, tileSize)
  }

  // La foto sale del documento pero queda en el almacén: otro reset puede volver a elegirla.
  const hideSnapshots = () => {
    visibleSnapshots.forEach(snapshot => snapshot.element.remove())
    visibleSnapshots = []
  }

  // La vista de partida de las semillas ya no es la del mapa: la precarga en vuelo se cancela. Una capa
  // sin zoom de tiles no tiene tiles en el mapa: la de un mapa adoptado sin vista entra recién con ella,
  // después de este primer reset.
  const captureSnapshot = () => {
    cancelSeedPrefetch()
    if (layer._tileZoom == null) return

    const tileSize = layer.getTileSize()
    const tiles    = Object.values(layer._tiles)
      .filter(({ el, coords, loaded }) => loaded && coords.z === layer._tileZoom && el.complete && el.naturalWidth)
      .map(({ el, coords }) => ({ image: el, left: coords.x * tileSize.x, top: coords.y * tileSize.y }))
    const snapshot = snapshotOf(tiles, layer._tileZoom, tileSize)
    snapshot && snapshotStore.add(snapshot)
  }

  const showSnapshots = () => {
    if (!pane) {
      pane              = surface.mount(PANE, PANE_Z, { pointer: false })
      pane.style.filter = TILE_FILTER
    }
    const placements = snapshotStore.select({
      targetZoom   : map.getZoom(),
      pixelOrigin  : map.getPixelOrigin(),
      viewportSize : map.getSize(),
      zoomScale    : (targetZoom, sourceZoom) => map.getZoomScale(targetZoom, sourceZoom),
    })

    hideSnapshots()
    placements.forEach(({ snapshot, frame }) => {
      snapshot.element.style.transform = frameTransform(frame.left, frame.top, frame.scale)
      pane.appendChild(snapshot.element)
    })
    visibleSnapshots = placements.map(placement => placement.snapshot)
  }

  map.on('viewprereset', captureSnapshot)
  map.on('zoomstart', hideSnapshots)
  map.on('viewreset', showSnapshots)

  if (typeof requestIdleCallback === 'function') {
    const generation = seedGeneration
    const stale      = () => generation !== seedGeneration
    seedIdleId = requestIdleCallback(async () => {
      seedIdleId = null
      const baseZoom = Math.round(map.getZoom())
      if (!Number.isFinite(baseZoom)) return            // un mapa adoptado sin vista no tiene de dónde partir
      const maxZoom = layer.options.maxZoom ?? map.getMaxZoom()
      for (const offset of SEED_ZOOM_OFFSETS) {
        if (baseZoom + offset > maxZoom) return
        const snapshot = await seedSnapshot(baseZoom + offset, stale)
        if (!snapshot || stale()) return
        snapshotStore.add(snapshot, { kind: 'seed' })
      }
    }, { timeout: 700 })
  }

  return () => {
    cancelSeedPrefetch()
    snapshotStore.clear()
    map.off('viewprereset', captureSnapshot)
    map.off('zoomstart', hideSnapshots)
    map.off('viewreset', showSnapshots)
    pane && surface.unmount(PANE)
  }
}
