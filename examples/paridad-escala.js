// Verificación a ojo de <cristae-scale>, sin tiles: las reglas de 1 km y 1 mi sobre el paralelo del centro
// tienen que medir en pantalla lo mismo que la barra del mismo rótulo.
import 'leaflet/dist/leaflet.css'
import '../src/index.js'
import { MEAN_RADIUS } from '../src/geometry/geodesic.js'

const map   = document.querySelector('cristae-map')
const scale = document.querySelector('cristae-scale')
const $     = id => document.getElementById(id)

// La regla de `meters` hacia el este sobre el paralelo `lat`, con la distancia de la esfera por defecto:
// haversine con las dos latitudes iguales, despejada para Δλ.
const rule = (id, lat, lng, meters, color) => {
  const dLng = 2 * Math.asin(Math.sin(meters / (2 * MEAN_RADIUS)) / Math.cos(lat * Math.PI / 180)) * 180 / Math.PI
  return { id, path: [[lat, lng], [lat, lng + dLng]], color }
}

const rules = ({ lat, lng }) => [
  rule('km', lat - 0.001, lng, 1000, '#2563eb'),
  rule('mi', lat - 0.003, lng, 1609.344, '#ea580c'),
]

const layer = $('reglas')
layer.accessors = { idOf: r => r.id, pathOf: r => r.path, styleOf: r => ({ color: r.color, weight: 4 }) }
layer.data      = rules({ lat: -33.44, lng: -70.65 })

$('sur').onclick = () => {
  const { lat, lng } = map.camera.getCenter()
  layer.data = rules({ lat: lat - 30, lng })
  map.camera.setView([lat - 30, lng], map.camera.getZoom())
}
$('z14').onclick   = () => map.camera.setZoom(14)
$('z15').onclick   = () => map.camera.setZoom(15)
$('ancho').onclick = () => scale.maxWidth = scale.maxWidth === 100 ? 300 : 100
document.querySelectorAll('[data-units]').forEach(b => b.onclick = () => scale.units = b.dataset.units)
