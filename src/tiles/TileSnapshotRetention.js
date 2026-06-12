// Retención de imagen de tiles durante el zoom de Leaflet.
// Al iniciar un zoom toma un snapshot (canvas) de los tiles cargados y lo mantiene visible,
// reproyectándolo al destino, hasta que el nuevo nivel termina de cargar. Así el mapa nunca
// muestra el hueco gris entre que arranca el zoom y llegan los tiles nuevos.
//
// Ciclo de eventos:
//   zoomstart / viewprereset → startRetention  (captura + muestra snapshot)
//   zoomanim                 → moveSnapshot     (reproyecta al destino animado)
//   zoom                     → syncSnapshot     (reproyecta al estado intermedio)
//   zoomend                  → settleSnapshot   (último ajuste y cierre)

import L from 'leaflet'
import { ZoomSnapshotStore } from './ZoomSnapshotStore.js'

const SEED_ZOOM_OFFSETS = [1, 2, 4, 8]
const MAX_SEED_TILES_PER_ZOOM = 24

const ensureSnapshotPane = (map, paneName, paneZIndex) => {
  const pane = map.getPane(paneName) ?? map.createPane(paneName)
  pane.style.zIndex = String(paneZIndex)
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
  canvas.width = width
  canvas.height = height
  canvas.style.position = 'absolute'
  canvas.style.left = '0px'
  canvas.style.top = '0px'
  canvas.style.width = `${width}px`
  canvas.style.height = `${height}px`
  canvas.style.pointerEvents = 'none'
  canvas.style.transformOrigin = '0 0'
  canvas.style.filter = filterString

  const ctx = canvas.getContext('2d', { alpha: true })
  if (!ctx) return null
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'low'

  tiles.forEach(({ tile, left, top }) => {
    ctx.drawImage(tile, left - unionLeft, top - unionTop, tileSize.x, tileSize.y)
  })

  return {
    element: canvas,
    meta: {
      sourceZoom: zoom,
      sourcePixelTopLeft: L.point(unionLeft, unionTop),
    },
  }
}

const layerFilterString = (layer) =>
  (layer._container && getComputedStyle(layer._container).filter) || ''

// Construye snapshots a partir de los tiles ya cargados del zoom actual de la capa.
const buildTileSnapshots = (layer) => {
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
      tiles: [],
      unionLeft: Infinity,
      unionTop: Infinity,
      unionRight: -Infinity,
      unionBottom: -Infinity,
      zoom,
    }

    group.tiles.push({ tile, left, top })
    group.unionLeft = Math.min(group.unionLeft, left)
    group.unionTop = Math.min(group.unionTop, top)
    group.unionRight = Math.max(group.unionRight, left + tileSize.x)
    group.unionBottom = Math.max(group.unionBottom, top + tileSize.y)
    groups.set(zoom, group)
  }

  const filterString = layerFilterString(layer)
  return Array.from(groups.values(), (group) => buildSnapshotCanvas(group, layer, filterString)).filter(Boolean)
}

const seedZoomsFrom = (zoom, maxZoom) => {
  const baseZoom = Math.round(zoom)
  return SEED_ZOOM_OFFSETS
    .map((offset) => baseZoom + offset)
    .filter((targetZoom) => targetZoom <= maxZoom)
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

// Resuelve la URL de un tile a un zoom distinto del actual restaurando _tileZoom luego.
const tileUrlAtZoom = (layer, coords) => {
  const originalZoom = layer._tileZoom
  const tilePoint = L.point(coords.x, coords.y)
  tilePoint.z = coords.z
  const wrappedCoords = layer._wrapCoords ? layer._wrapCoords(tilePoint) : tilePoint
  layer._tileZoom = coords.z
  try {
    return layer.getTileUrl(wrappedCoords)
  } finally {
    layer._tileZoom = originalZoom
  }
}

const loadImage = (url, layer) =>
  new Promise((resolve) => {
    const image = new Image()
    if (layer.options.crossOrigin) image.crossOrigin = layer.options.crossOrigin === true ? '' : layer.options.crossOrigin
    if (layer.options.referrerPolicy) image.referrerPolicy = layer.options.referrerPolicy
    image.onload = () => resolve(image)
    image.onerror = () => resolve(null)
    image.src = url
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
      top: coords.y * tileSize.y,
    })
  }

  if (!seedTiles.length) return null

  let unionLeft = Infinity
  let unionTop = Infinity
  let unionRight = -Infinity
  let unionBottom = -Infinity
  seedTiles.forEach((tile) => {
    unionLeft = Math.min(unionLeft, tile.left)
    unionTop = Math.min(unionTop, tile.top)
    unionRight = Math.max(unionRight, tile.left + tileSize.x)
    unionBottom = Math.max(unionBottom, tile.top + tileSize.y)
  })

  return buildSnapshotCanvas(
    { tiles: seedTiles, unionLeft, unionTop, unionRight, unionBottom, zoom },
    layer,
    layerFilterString(layer),
  )
}

export const createTileSnapshotRetention = (map, {
  paneName = 'tileZoomSnapshotPane',
  paneZIndex = 150,
} = {}) => {
  let activeLayer = null
  let activePrune = null
  let retaining = false
  let pruneDeferred = false
  let visibleSnapshots = []
  let seedGeneration = 0
  let seedIdleId = null
  const snapshotStore = new ZoomSnapshotStore()

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
    if (retaining || !activeLayer || typeof requestIdleCallback !== 'function' || seedIdleId != null) return
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

  const applyPlacement = (placement) => {
    const { element } = placement.snapshot
    const { frame } = placement
    element.style.transform = `translate3d(${frame.left}px, ${frame.top}px, 0) scale(${frame.scale})`
  }

  const showSnapshot = (zoom, pixelOrigin) => {
    const pane = ensureSnapshotPane(map, paneName, paneZIndex)
    const placements = snapshotStore.select({
      targetZoom: zoom,
      pixelOrigin,
      viewportSize: map.getSize(),
      zoomScale: (targetZoom, sourceZoom) => map.getZoomScale(targetZoom, sourceZoom),
    })
    const nextSnapshots = placements.map((placement) => placement.snapshot)

    visibleSnapshots
      .filter((snapshot) => !nextSnapshots.includes(snapshot))
      .forEach((snapshot) => snapshot.element.remove())

    placements.forEach((placement) => {
      pane.appendChild(placement.snapshot.element)
      applyPlacement(placement)
    })

    visibleSnapshots = nextSnapshots
    return placements.length > 0
  }

  const resetLayer = () => {
    if (activeLayer && activePrune) activeLayer._pruneTiles = activePrune
    activeLayer = null
    activePrune = null
    pruneDeferred = false
  }

  const endRetention = () => {
    if (retaining && pruneDeferred && activeLayer?._map) activePrune.call(activeLayer)
    retaining = false
    pruneDeferred = false
  }

  const startRetention = () => {
    if (!activeLayer) return
    cancelSeedPrefetch()

    if (!retaining) {
      buildTileSnapshots(activeLayer).forEach((snapshot) => snapshotStore.add(snapshot))
    }

    const wasRetaining = retaining
    if (showSnapshot(map.getZoom(), map.getPixelOrigin())) {
      retaining = true
      if (!wasRetaining) pruneDeferred = false
    }
  }

  // Reproyecta el snapshot al destino. Solo llega en zoom-IN: el motor mantiene el zoom-out
  // instantáneo (animar un zoom-out desfasa los tiles viejos que se encogen con el fondo nuevo),
  // así que ahí no hay `zoomanim` y la ruta instantánea zoom/zoomend asienta el snapshot.
  const moveSnapshot = (event) => {
    showSnapshot(event.zoom, map._getNewPixelOrigin(event.center, event.zoom))
  }

  const settleSnapshot = () => {
    showSnapshot(map.getZoom(), map.getPixelOrigin())
    endRetention()
  }

  const syncSnapshot = () => {
    showSnapshot(map.getZoom(), map.getPixelOrigin())
  }

  map.on('zoomstart', startRetention)
  map.on('viewprereset', startRetention)
  map.on('zoomanim', moveSnapshot)
  map.on('zoom', syncSnapshot)
  map.on('zoomend', settleSnapshot)

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
      if (typeof layer?._pruneTiles !== 'function') return
      cancelSeedPrefetch()
      endRetention()
      resetLayer()
      clearSnapshots()
      activeLayer = layer
      activePrune = layer._pruneTiles
      // Durante la retención diferimos el prune de Leaflet: si podara los tiles
      // viejos a media animación reaparecería el hueco gris que estamos tapando.
      layer._pruneTiles = function pruneTilesAfterZoomLoad() {
        if (retaining && activeLayer === this) {
          pruneDeferred = true
          return
        }
        return activePrune.call(this)
      }
      scheduleSeedPrefetch()
    },
    destroy() {
      cancelSeedPrefetch()
      endRetention()
      resetLayer()
      clearSnapshots()
      map.off('zoomstart', startRetention)
      map.off('viewprereset', startRetention)
      map.off('zoomanim', moveSnapshot)
      map.off('zoom', syncSnapshot)
      map.off('zoomend', settleSnapshot)
    },
  }
}
