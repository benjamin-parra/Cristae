// Resolutor de hits sobre capas Leaflet. No conoce el dominio: dado un layer y un ref
// estable, produce un resolver `(baseEvent) => [{ ref, distancePx }]` eligiendo UNA
// estrategia según las capacidades geométricas del layer. El registro envuelve estas
// partes con layerId/kind/zIndex/order para formar el Hit completo.

const DEFAULT_HIT_RADIUS = 10

export class HitResolver {

  #map

  constructor(map) {
    this.#map = map
  }

  // z-index efectivo de la capa, leído del pane que la contiene. Sin pane → 0.
  zIndexOf(layer) {
    const pane = layer.options?.pane
      ? this.#map.getPane(layer.options.pane)
      : layer.getPane?.()

    const z = Number.parseInt(pane?.style?.zIndex ?? '0', 10)
    return Number.isNaN(z) ? 0 : z
  }

  // Construye el resolver de hits para una capa. Capa agrupada → itera hijos en tiempo de
  // resolución (adds/removes dinámicos funcionan); resolvers de hijo cacheados lazy por
  // WeakMap (se limpian solos al recolectar el hijo). Capa simple → una estrategia exclusiva.
  createResolver(layer, ref) {
    if (typeof layer.eachLayer === 'function') return this.#groupResolver(layer, ref)
    return this.#leafResolver(layer, ref)
  }

  #groupResolver(layer, ref) {
    const cache = new WeakMap()
    return (baseEvent) => {
      const hits = []
      layer.eachLayer(child => {
        let resolve = cache.get(child)
        if (!resolve) cache.set(child, resolve = this.createResolver(child, ref))
        resolve(baseEvent).forEach(hit => hits.push(hit))
      })
      return hits
    }
  }

  // Una sola estrategia por capa, exclusiva y sin fallthrough:
  //   1. _containsPoint → basada en trazo: Polygon, Polyline, Circle, CircleMarker, Rectangle
  //   2. getLatLng      → basada en punto: Marker (centro + tolerancia por icono/radio)
  //   3. getBounds      → basada en área:  ImageOverlay, VideoOverlay, SVGOverlay
  #leafResolver(layer, ref) {
    const hasContainsPoint = typeof layer._containsPoint === 'function'
    const hasLatLng        = typeof layer.getLatLng === 'function'
    const hasBounds        = typeof layer.getBounds === 'function'

    const hitRadius = (hasLatLng && !hasContainsPoint)
      ? this.#hitRadiusOf(layer)
      : DEFAULT_HIT_RADIUS

    return (baseEvent) => {
      if (!baseEvent?.latlng || !this.#map.hasLayer(layer)) return []

      const layerPoint = baseEvent.layerPoint ?? this.#map.latLngToLayerPoint(baseEvent.latlng)

      // 1. Basada en trazo (la más precisa — renderers SVG y Canvas).
      if (hasContainsPoint) {
        if (!layer._containsPoint(layerPoint)) return []
        const closest = layer.closestLayerPoint?.(layerPoint)
        return [{ ref, distancePx: closest ? layerPoint.distanceTo(closest) : 0 }]
      }

      // 2. Basada en punto (Marker con icono o radio).
      if (hasLatLng) {
        const center = this.#map.latLngToLayerPoint(layer.getLatLng())
        const distancePx = Math.hypot(center.x - layerPoint.x, center.y - layerPoint.y)
        return distancePx <= hitRadius ? [{ ref, distancePx }] : []
      }

      // 3. Basada en área (overlays).
      if (hasBounds && layer.getBounds().contains(baseEvent.latlng)) {
        return [{ ref, distancePx: 0 }]
      }

      return []
    }
  }

  // Tolerancia de impacto para una capa puntual: radio del círculo o media diagonal del icono.
  #hitRadiusOf(layer) {
    if (typeof layer.getRadius === 'function') {
      return typeof layer._radius === 'number' ? layer._radius : (layer.getRadius() ?? DEFAULT_HIT_RADIUS)
    }
    const iconSize = layer.options?.icon?.options?.iconSize
    if (iconSize) return Math.max(iconSize[0], iconSize[1]) / 2
    return DEFAULT_HIT_RADIUS
  }
}
