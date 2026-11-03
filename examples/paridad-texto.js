// Verificación a ojo de <cristae-line-label-layer>: repeat, offset y orientación en vivo, la rosa de
// rumbos de D13, tramos hacia el oeste, una horquilla y el halo sobre fondo oscuro. Sin tiles.

import '../src/index.js'

const accessors = { idOf: r => r.id, pathOf: r => r.path }
const COS_LAT   = Math.cos(-33.45 * Math.PI / 180)

// Un rayo de `largo` grados desde el centro, con el rumbo medido en pantalla (0 = este, antihorario).
const rayo = ([lat, lng], grados, largo) => {
  const r = grados * Math.PI / 180
  return [[lat, lng], [lat + largo * Math.sin(r), lng + largo * Math.cos(r) / COS_LAT]]
}
const rumbos = [...Array.from({ length: 16 }, (_, i) => i * 22.5), 89, 91]
const rosa   = centro => rumbos.map(g => ({ id: `${g}°`, path: rayo(centro, g, 0.06) }))

const sinuosa = Array.from({ length: 80 }, (_, i) => [-33.36 + 0.012 * Math.sin(i / 6), -70.80 + i * 0.004])

const rutas = document.getElementById('rutas')
rutas.accessors = accessors
rutas.data      = [
  { id: 'Ruta sinuosa', path: sinuosa },
  { id: 'Hacia el oeste', path: [[-33.40, -70.44], [-33.405, -70.56]] },
  { id: 'Horquilla', path: [[-33.33, -70.50], [-33.31, -70.49], [-33.33, -70.48]] },
]

const izquierda = document.getElementById('rosa')
izquierda.accessors = accessors
izquierda.data      = rosa([-33.50, -70.72])

const derecha = document.getElementById('rosa-offset')
derecha.accessors = accessors
derecha.data      = rosa([-33.50, -70.52])

const textos = [...document.querySelectorAll('cristae-line-label-layer')]
const rotulo = document.getElementById('texto-rutas')

const enlazar = (id, aplicar) => document.getElementById(id).addEventListener('input', e => {
  document.getElementById(`${id}-v`).textContent = e.target.value
  aplicar(Number(e.target.value))
})
enlazar('repeat', v => rotulo.repeat = v || null)
enlazar('offset', v => rotulo.offset = v)
document.querySelectorAll('input[name=orientacion]').forEach(input =>
  input.addEventListener('change', () => textos.forEach(t => t.orientation = input.value)))
document.getElementById('visible').addEventListener('change', e => textos.forEach(t => t.visible = e.target.checked))
// El contenedor de Leaflet vive en el shadow root del mapa y trae su propio fondo.
document.getElementById('oscuro').addEventListener('change', e =>
  document.querySelector('cristae-map').shadowRoot.querySelector('.leaflet-container').style.background = e.target.checked ? '#0f172a' : '')
