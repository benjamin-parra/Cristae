// Verificación a ojo de <cristae-heat-layer>: radio en vivo, rampa propia, ocultar y mostrar, y que el
// campo se reubica con el zoom. Sin tiles: el fondo es liso y el marco de líneas da la referencia.

import '../src/index.js'

// Tres focos con densidad distinta alrededor de Santiago, con una semilla fija para que la captura se repita.
const FOCOS = [[-33.42, -70.70, 300], [-33.47, -70.60, 120], [-33.50, -70.68, 40]]
let semilla = 7
const azar  = () => (semilla = (semilla * 16807) % 2147483647) / 2147483647

const puntos = FOCOS.flatMap(([lat, lng, n], f) => Array.from({ length: n }, (_, i) => ({
  id  : f * 1000 + i,
  lat : lat + (azar() - 0.5) * 0.04,
  lng : lng + (azar() - 0.5) * 0.05,
})))

const calor = document.getElementById('calor')
calor.accessors = { idOf: p => p.id, positionOf: p => ({ lat: p.lat, lng: p.lng }) }
calor.data      = puntos

const marco = document.getElementById('marco')
marco.accessors = { idOf: m => m.id, pathOf: m => m.path }
marco.data      = [{ id: 1, path: [[-33.37, -70.76], [-33.37, -70.55], [-33.55, -70.55], [-33.55, -70.76], [-33.37, -70.76]] }]

const violeta = t => [0.5 + t * 0.2, 0.5 - t * 0.4, 0.5 + t * 0.4, t]

document.querySelectorAll('input[name=radio]').forEach(input =>
  input.addEventListener('change', () => calor.radius = Number(input.value)))
document.getElementById('rampa').addEventListener('change', e => calor.colorRamp = e.target.checked ? violeta : undefined)
document.getElementById('visible').addEventListener('change', e => calor.visible = e.target.checked)
