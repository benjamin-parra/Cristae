// La faceta `camera` de una vista inyectada: lo que `Camera` espera de un anfitrión, con el mismo contrato
// que la de LeafletHost (SPECS §9), para correr la cámara pública sin GL ni Leaflet. Es interno: ningún
// entry lo re-exporta: es interno y de pruebas. Lo usan las pruebas de los elementos y de la cámara.
import { coordOf, hasPointShape } from '../data/path.js'
import { screenOf, surfaceOf, metersPerPixelOf, boundsOf } from './views.js'

const checkPoint = latlng => {
  if (!hasPointShape(latlng)) throw new TypeError('[cristae] la cámara espera un punto')
}

// Lo mismo que Leaflet dice de una coordenada que no es un número.
const checkNumbers = (lat, lng) => {
  if (lat !== lat || lng !== lng) throw new Error(`Invalid LatLng object: (${lat}, ${lng})`)
}

const xOf = point => Array.isArray(point) ? point[0] : point.x
const yOf = point => Array.isArray(point) ? point[1] : point.y

export const viewFacet = view => {
  const scratch = { x: 0, y: 0, occluded: false, depth: 0 }
  const hit     = { lat: 0, lng: 0, onSurface: false, incidence: 0, altitude: 0 }

  return {
    hasView : () => true,
    center  : () => ({ lat: view.lat, lng: view.lng }),
    zoom    : () => view.zoom,
    size    : () => ({ x: view.w, y: view.h }),
    bounds  : () => boundsOf(view, { south: 0, west: 0, north: 0, east: 0 }),

    // Escribe en `out` el px del contenedor y si es visible: dentro del rectángulo, sin que la esfera lo tape
    // y delante del ojo. Sin asignar, salvo el error de un punto que no lo es.
    toScreen(latlng, out) {
      checkPoint(latlng)
      const lat = +coordOf(latlng, 0)
      const lng = +coordOf(latlng, 1)
      checkNumbers(lat, lng)
      screenOf(view, lat, lng, scratch)
      out.x        = scratch.x
      out.y        = scratch.y
      out.occluded = scratch.occluded
      out.visible  = !scratch.occluded && scratch.depth > 0
        && 0 <= scratch.x && scratch.x <= view.w && 0 <= scratch.y && scratch.y <= view.h
      return out
    },
    // `point` es `{ x, y }` o `[x, y]`.
    surfaceAt(point, out = { lat: 0, lng: 0, onSurface: false, incidence: 0, altitude: 0 }) {
      surfaceOf(view, xOf(point), yOf(point), out)
      return out
    },
    metersPerPixelAt: (lat, lng, model) => metersPerPixelOf(view, lat, lng, model),

    toContainer(latlng) {
      checkPoint(latlng)
      screenOf(view, +coordOf(latlng, 0), +coordOf(latlng, 1), scratch)
      return { x: scratch.x, y: scratch.y }
    },
    fromContainer(point) {
      surfaceOf(view, xOf(point), yOf(point), hit)
      return { lat: hit.lat, lng: hit.lng }
    },

    // Una vista inyectada no se pana: el marco del contenedor es el propio contenedor.
    frameOrigin : () => ({ x: 0, y: 0 }),
    on          : () => () => {},
  }
}
