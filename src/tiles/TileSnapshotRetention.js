// Retención de imagen de tiles en el zoom que Leaflet no anima.
// Cuando Leaflet resetea la vista —un zoom que no anima, o un salto que no puede animar— suelta todos los
// tiles de golpe, y hasta que llega el nivel nuevo el mapa queda gris. La retención fotografía en un
// canvas los tiles cargados antes de que se suelten y deja la foto, reproyectada a la vista nueva, en un
// pane debajo del de tiles mientras el nivel nuevo carga encima.
//
// Un zoom animado no resetea: la transición de Leaflet escala los tiles viejos hasta que llegan los
// nuevos. Ahí la retención se hace a un lado, y esconde la foto que hubiera, que no acompaña a la
// transición. Se decide por zoom, así que sigue a la política de animación aunque cambie en vivo.
//
// Ciclo de eventos:
//   viewprereset → captura los tiles cargados. Leaflet avisa el reset antes de que la capa los suelte, y
//                  a sus oyentes en el orden en que llegaron: la retención se crea antes que la capa.
//   zoomstart    → esconde la foto visible
//   viewreset    → muestra la mejor para la vista nueva

import L from 'leaflet'
import { ZoomSnapshotStore } from './ZoomSnapshotStore.js'

const SEED_ZOOM_OFFSETS       = [1, 2, 4, 8]
const MAX_SEED_TILES_PER_ZOOM = 24

const ensureSnapshotPane = (map, paneName, paneZIndex) => {
  const pane = map.getPane(paneName) ?? map.createPane(paneName)
  pane.style.zIndex        = String(paneZIndex)
  pane.style.pointerEvents = 'none'
  return pane
}

// Une los tiles de un grupo (mismo zoom) en un único canvas posicionado en su esquina común.
const buildSnapshotCanvas = (group, layer, filterString) => {
  const { tiles, unionLeft, unionTop, unionRight, unionBottom, zoom } = group
  const tileSize = layer.getTileSize()
  const width = unionRight - unionLeft
  const height = unionBottom - unionTop
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
  canvas.style.filter          = filterString

  const ctx = canvas.getContext('2d', { alpha: true })
  if (!ctx) return null
  ctx.imageSmoothingEnabled  = true
  ctx.imageSmoothingQuality = 'low'

  tiles.forEach(({ tile, left, top }) =>
    ctx.drawImage(tile, left - unionLeft, top - unionTop, tileSize.x, tileSize.y))

  return {
    element: canvas,
    meta   : {
      sourceZoom        : zoom,
      sourcePixelTopLeft: L.point(unionLeft, unionTop),
    },
  }
}

const layerFilterString = layer =>
  (layer._container && getComputedStyle(layer._container).filter) || ''

// Construye snapshots a partir de los tiles ya cargados del zoom actual de la capa.
const buildTileSnapshots = layer => {
  const tileZoom = layer._tileZoom
  const tiles = layer._tiles
  if (tileZoom == null || !tiles) return []

  const tileSize = layer.getTileSize()
  const groups = new Map()

  for (const key in tiles) {
    const entry = tiles[key]
    const tile = entry.el
    const zoom = entry.coords.z
    if (!entry.loaded || !tile.complete || !tile.naturalWidth) continue
    if (zoom !== tileZoom) continue

    const left = entry.coords.x * tileSize.x
    const top = entry.coords.y * tileSize.y
    const group = groups.get(zoom) ?? {
      tiles      : [],
      unionLeft  : Infinity,
      unionTop   : Infinity,
      unionRight : -Infinity,
      unionBottom: -Infinity,
      zoom,
    }

    group.tiles.push({ tile, left, top })
    group.unionLeft   = Math.min(group.unionLeft, left)
    group.unionTop    = Math.min(group.unionTop, top)
    group.unionRight  = Math.max(group.unionRight, left + tileSize.x)
    group.unionBottom = Math.max(group.unionBottom, top + tileSize.y)
    groups.set(zoom, group)
  }

  const filterString = layerFilterString(layer)
  return Array.from(groups.values(), group => buildSnapshotCanvas(group, layer, filterString)).filter(Boolean)
}

const seedZoomsFrom = (zoom, maxZoom) => {
  const baseZoom = Math.round(zoom)
  return SEED_ZOOM_OFFSETS
    .map(offset => baseZoom + offset)
    .filter(targetZoom => targetZoom <= maxZoom)
}

// Coords de tiles que cubren el viewport en un zoom dado, ordenadas por cercanía al centro.
const seedTileCoords = (map, layer, zoom) => {
  const tileSize = layer.getTileSize()
  const center = map.project(map.getCenter(), zoom)
  const halfSize = map.getSize().divideBy(2)
  const minX = Math.floor((center.x - halfSize.x) / tileSize.x)
  const maxX = Math.floor((center.x + halfSize.x) / tileSize.x)
  const minY = Math.floor((center.y - halfSize.y) / tileSize.y)
  const maxY = Math.floor((center.y + halfSize.y) / tileSize.y)
  const centerX = Math.floor(center.x / tileSize.x)
  const centerY = Math.floor(center.y / tileSize.y)
  const coords = []

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      coords.push({ x, y, z: zoom, distance: Math.abs(x - centerX) + Math.abs(y - centerY) })
    }
  }

  return coords
    .sort((a, b) => a.distance - b.distance)
    .slice(0, MAX_SEED_TILES_PER_ZOOM)
}

// La URL de un tile de otro zoom. Leaflet la arma con la grilla del zoom de sus tiles —el zoom que va en
// la URL, la vuelta al mundo de la x y el rango con que invierte la y—: se le pone un momento la del zoom
// pedido y después se le devuelve la suya.
const tileUrlAtZoom = (layer, coords) => {
  const tileZoom  = layer._tileZoom
  const tilePoint = L.point(coords.x, coords.y)
  tilePoint.z     = coords.z
  layer._tileZoom = coords.z
  layer._resetGrid()
  try {
    return layer.getTileUrl(layer._wrapCoords(tilePoint))
  } finally {
    layer._tileZoom = tileZoom
    layer._resetGrid()
  }
}

const loadImage = (url, layer) =>
  new Promise(resolve => {
    const image = new Image()
    if (layer.options.crossOrigin) image.crossOrigin = layer.options.crossOrigin === true ? '' : layer.options.crossOrigin
    if (layer.options.referrerPolicy) image.referrerPolicy = layer.options.referrerPolicy
    image.onload  = () => resolve(image)
    image.onerror = () => resolve(null)
    image.src     = url
  })

// Precarga y rasteriza un snapshot para un zoom futuro. `generation` permite abortar:
// si cambia mientras descargamos, la prefetch fue cancelada y se descarta el trabajo.
const buildSeedSnapshot = async (map, layer, zoom, generation, currentGeneration) => {
  const tileSize = layer.getTileSize()
  const seedTiles = []

  for (const coords of seedTileCoords(map, layer, zoom)) {
    if (generation !== currentGeneration()) return null
    const image = await loadImage(tileUrlAtZoom(layer, coords), layer)
    if (!image || generation !== currentGeneration()) return null
    seedTiles.push({
      tile: image,
      left: coords.x * tileSize.x,
      top : coords.y * tileSize.y,
    })
  }

  if (!seedTiles.length) return null

  let unionLeft   = Infinity
  let unionTop    = Infinity
  let unionRight  = -Infinity
  let unionBottom = -Infinity
  seedTiles.forEach(tile => {
    unionLeft   = Math.min(unionLeft, tile.left)
    unionTop    = Math.min(unionTop, tile.top)
    unionRight  = Math.max(unionRight, tile.left + tileSize.x)
    unionBottom = Math.max(unionBottom, tile.top + tileSize.y)
  })

  return buildSnapshotCanvas(
    { tiles: seedTiles, unionLeft, unionTop, unionRight, unionBottom, zoom },
    layer,
    layerFilterString(layer),
  )
}

export const createTileSnapshotRetention = (map, {
  paneName   = 'tileZoomSnapshotPane',
  paneZIndex = 150,
} = {}) => {
  let activeLayer      = null
  let visibleSnapshots = []
  let seedGeneration   = 0
  let seedIdleId       = null
  const snapshotStore  = new ZoomSnapshotStore()

  const clearSnapshots = () => {
    snapshotStore.clear()
    visibleSnapshots = []
  }

  // Avanzar la generación invalida cualquier prefetch en vuelo (su check fallará).
  const cancelSeedPrefetch = () => {
    seedGeneration++
    if (seedIdleId == null) return
    cancelIdleCallback(seedIdleId)
    seedIdleId = null
  }

  const scheduleSeedPrefetch = () => {
    if (!activeLayer || typeof requestIdleCallback !== 'function' || seedIdleId != null) return
    const generation = seedGeneration
    seedIdleId = requestIdleCallback(async () => {
      seedIdleId = null
      const maxZoom = activeLayer.options.maxZoom ?? map.getMaxZoom()
      for (const zoom of seedZoomsFrom(map.getZoom(), maxZoom)) {
        const snapshot = await buildSeedSnapshot(map, activeLayer, zoom, generation, () => seedGeneration)
        if (!snapshot || generation !== seedGeneration) return
        snapshotStore.add(snapshot, { kind: 'seed' })
      }
    }, { timeout: 700 })
  }

  // La foto sale del documento pero queda en el almacén: otro reset puede volver a elegirla.
  const hideSnapshots = () => {
    visibleSnapshots.forEach(snapshot => snapshot.element.remove())
    visibleSnapshots = []
  }

  // La vista de partida de las semillas ya no es la del mapa: la descarga en vuelo se cancela.
  const captureSnapshot = () => {
    if (!activeLayer) return
    cancelSeedPrefetch()
    buildTileSnapshots(activeLayer).forEach(snapshot => snapshotStore.add(snapshot))
  }

  const showSnapshots = () => {
    if (!activeLayer) return
    const pane       = ensureSnapshotPane(map, paneName, paneZIndex)
    const placements = snapshotStore.select({
      targetZoom  : map.getZoom(),
      pixelOrigin : map.getPixelOrigin(),
      viewportSize: map.getSize(),
      zoomScale   : (targetZoom, sourceZoom) => map.getZoomScale(targetZoom, sourceZoom),
    })

    hideSnapshots()
    placements.forEach(({ snapshot, frame }) => {
      snapshot.element.style.transform = `translate3d(${frame.left}px, ${frame.top}px, 0) scale(${frame.scale})`
      pane.appendChild(snapshot.element)
    })
    visibleSnapshots = placements.map(placement => placement.snapshot)
  }

  map.on('viewprereset', captureSnapshot)
  map.on('zoomstart', hideSnapshots)
  map.on('viewreset', showSnapshots)

  return {
    // Invalidación explícita ante cambio de proveedor de tiles: descarta los canvas
    // obsoletos y cancela la prefetch en vuelo para que el próximo zoom solo muestre
    // tiles del nuevo proveedor. activateLayer() ya lo hace internamente; se expone
    // como contrato inequívoco para quien reemplaza la capa de tiles.
    invalidateSnapshots() {
      cancelSeedPrefetch()
      clearSnapshots()
    },
    activateLayer(layer) {
      if (activeLayer === layer) return
      cancelSeedPrefetch()
      clearSnapshots()
      activeLayer = layer
      scheduleSeedPrefetch()
    },
    destroy() {
      cancelSeedPrefetch()
      clearSnapshots()
      activeLayer = null
      map.off('viewprereset', captureSnapshot)
      map.off('zoomstart', hideSnapshots)
      map.off('viewreset', showSnapshots)
    },
  }
}
