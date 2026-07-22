// Almacén de snapshots de tiles para retener imagen durante el zoom.
// Cada snapshot es un canvas ya rasterizado con la región de tiles de un zoom de origen.
// select() puntúa todos los candidatos contra el viewport destino y devuelve el mejor
// par (primario que cubre el centro + secundario que rellena el área residual).
// Los pesos del scoring son deliberados: coverage^4 prioriza fuertemente la cobertura,
// el factor de centro favorece lo que se ve en medio y zoomQuality penaliza saltos de zoom.

import { rect, area, intersect } from '../geometry/bbox.js'

const MIN_SECONDARY_SCORE = 0.01

const viewportRect = (size) => rect(0, 0, size.x, size.y)

const centerRect = (size) => {
  const insetX = size.x * 0.25
  const insetY = size.y * 0.25
  return rect(insetX, insetY, size.x - insetX, size.y - insetY)
}

// Proyecta el canvas de un snapshot al espacio de píxeles del zoom destino.
const projectedFrame = (snapshot, targetZoom, pixelOrigin, zoomScale) => {
  const scale = zoomScale(targetZoom, snapshot.sourceZoom)
  const topLeft = snapshot.sourcePixelTopLeft
    .multiplyBy(scale)
    .subtract(pixelOrigin)
    .round()

  return {
    ...rect(
      topLeft.x,
      topLeft.y,
      topLeft.x + snapshot.width * scale,
      topLeft.y + snapshot.height * scale,
    ),
    scale,
  }
}

const scoreCandidate = (snapshot, context) => {
  const { targetZoom, pixelOrigin, viewport, center, viewportArea, centerArea, zoomScale } = context
  const frame = projectedFrame(snapshot, targetZoom, pixelOrigin, zoomScale)
  const visible = intersect(frame, viewport)
  const coverage = area(visible) / viewportArea
  const centerCoverage = area(intersect(frame, center)) / centerArea
  const zoomQuality = 1 / (1 + Math.abs(snapshot.sourceZoom - targetZoom) * 0.45)

  return {
    snapshot,
    frame,
    visible,
    score: (coverage ** 4) * (0.65 + 0.35 * (centerCoverage ** 2)) * zoomQuality,
  }
}

// El secundario vale por lo que aporta FUERA del primario: residualArea^3 lo hace
// despreciable salvo que rellene una porción significativa del hueco.
const secondaryScore = (candidate, primary, viewportArea) => {
  const residualArea = area(candidate.visible) - area(intersect(candidate.visible, primary.visible))
  return (residualArea / viewportArea) ** 3 * candidate.score
}

const bySequence = (a, b) => a.sequence - b.sequence

export class ZoomSnapshotStore {

  #entries = []
  #maxSnapshots
  #maxSeedSnapshots
  #sequence = 0

  constructor({ maxSnapshots = 8, maxSeedSnapshots = 3 } = {}) {
    this.#maxSnapshots = maxSnapshots
    this.#maxSeedSnapshots = maxSeedSnapshots
  }

  add(snapshot, { kind = 'normal' } = {}) {
    const entry = {
      element: snapshot.element,
      height: snapshot.element.height,
      kind,
      sequence: ++this.#sequence,
      sourcePixelTopLeft: snapshot.meta.sourcePixelTopLeft,
      sourceZoom: snapshot.meta.sourceZoom,
      width: snapshot.element.width,
    }

    this.#entries.push(entry)
    this.#trim()
    return entry
  }

  clear() {
    this.#entries.forEach(ZoomSnapshotStore.discard)
    this.#entries = []
  }

  select({ targetZoom, pixelOrigin, viewportSize, zoomScale }) {
    const viewport = viewportRect(viewportSize)
    const center = centerRect(viewportSize)
    const context = {
      targetZoom,
      pixelOrigin,
      viewport,
      center,
      viewportArea: area(viewport),
      centerArea: area(center),
      zoomScale,
    }

    let primary = null
    for (const entry of this.#entries) {
      const candidate = scoreCandidate(entry, context)
      if (candidate.score <= 0 || (primary && primary.score >= candidate.score)) continue
      primary = candidate
    }

    if (!primary) return []

    let secondary = null
    for (const entry of this.#entries) {
      if (entry === primary.snapshot) continue
      const candidate = scoreCandidate(entry, context)
      candidate.score = secondaryScore(candidate, primary, context.viewportArea)
      if (candidate.score < MIN_SECONDARY_SCORE || (secondary && secondary.score >= candidate.score)) continue
      secondary = candidate
    }

    return secondary ? [secondary, primary] : [primary]
  }

  // Libera el canvas: lo saca del DOM y colapsa sus dimensiones para soltar la memoria.
  static discard(entry) {
    entry.element.remove()
    entry.element.width = 0
    entry.element.height = 0
  }

  // Recorta por antigüedad: primero el exceso de seeds, luego el exceso global.
  #trim() {
    const seeds = this.#entries.filter((entry) => entry.kind === 'seed').sort(bySequence)
    seeds.slice(0, Math.max(0, seeds.length - this.#maxSeedSnapshots)).forEach((entry) => this.#remove(entry))

    this.#entries
      .slice()
      .sort(bySequence)
      .slice(0, Math.max(0, this.#entries.length - this.#maxSnapshots))
      .forEach((entry) => this.#remove(entry))
  }

  #remove(entry) {
    const index = this.#entries.indexOf(entry)
    if (index < 0) return
    this.#entries.splice(index, 1)
    ZoomSnapshotStore.discard(entry)
  }
}

export default ZoomSnapshotStore
