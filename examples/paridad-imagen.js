// Verificación a ojo de <cristae-image-layer>: una grilla numerada dibujada en un canvas sobre una caja,
// sobre un cuadrilátero rotado y sobre una caja que cruza el antimeridiano, cada una con su marco de
// líneas de las mismas esquinas. Sin tiles.

import '../src/index.js'

// Una grilla de 8 × 8 celdas numeradas, con el borde marcado: un corrimiento de un píxel se ve.
const grilla = color => {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 512
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = color
  ctx.fillRect(0, 0, 512, 512)
  ctx.strokeStyle = '#0f172a'
  ctx.fillStyle   = '#0f172a'
  ctx.font        = 'bold 20px sans-serif'
  ctx.textAlign   = 'center'
  ctx.textBaseline = 'middle'
  for (let i = 0; i < 8; i++)
    for (let j = 0; j < 8; j++) {
      ctx.strokeRect(j * 64, i * 64, 64, 64)
      ctx.fillText(String(i * 8 + j + 1), j * 64 + 32, i * 64 + 32)
    }
  ctx.lineWidth = 6
  ctx.strokeRect(3, 3, 506, 506)
  return canvas.toDataURL()
}

const CAJA = { south: -33.6, west: -70.9, north: -33.3, east: -70.6 }

// El cuadrilátero rotado 30° alrededor de su centro, en grados planos: no es un rectángulo en el suelo,
// pero las cuatro esquinas son las que importan.
const rotado = (lat, lng, r, grados) => {
  const a = grados * Math.PI / 180
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) => {
    const dx = x * r, dy = -y * r
    return [lat + dx * Math.sin(a) + dy * Math.cos(a), lng + dx * Math.cos(a) - dy * Math.sin(a)]
  })
}
const ESQUINAS = rotado(-33.45, -70.35, 0.12, 30)

const caja = document.getElementById('caja')
caja.url    = grilla('#fde68a')
caja.bounds = CAJA

const rotada = document.getElementById('rotada')
rotada.url     = grilla('#a7f3d0')
rotada.corners = ESQUINAS

const am = document.getElementById('antimeridiano')
am.url = grilla('#bfdbfe')

const cerrado = puntos => [...puntos, puntos[0]]
const marcos  = document.getElementById('marcos')
marcos.accessors = { idOf: m => m.id, pathOf: m => m.path, styleOf: () => ({ color: '#dc2626', weight: 2 }) }
marcos.data      = [
  { id: 1, path: cerrado([[CAJA.north, CAJA.west], [CAJA.north, CAJA.east], [CAJA.south, CAJA.east], [CAJA.south, CAJA.west]]) },
  { id: 2, path: cerrado(ESQUINAS) },
  { id: 3, path: cerrado([[1, 179], [1, 181], [-1, 181], [-1, 179]]) },
]

const map  = document.querySelector('cristae-map')
const clic = document.getElementById('clic')
map.addEventListener('cristae:click', e => (clic.textContent = e.detail.hits.map(h => `${h.kind}:${h.id}`).join(' ') || '—'))
map.addEventListener('cristae:mapclick', () => (clic.textContent = 'el mapa'))
caja.addEventListener('cristae:load', () => console.info('[paridad-imagen] cristae:load caja'))

document.querySelectorAll('[data-zoom]').forEach(b => b.addEventListener('click', () => map.camera.setZoom(Number(b.dataset.zoom))))
document.getElementById('santiago').addEventListener('click', () => map.camera.setView([-33.45, -70.6], 10))
document.getElementById('esquina').addEventListener('click', () => map.camera.setView([CAJA.north, CAJA.west], 18))
document.getElementById('am').addEventListener('click', () => map.camera.setView([0, 180], 7))
document.getElementById('opacidad').addEventListener('input', e => (caja.opacity = Number(e.target.value)))
document.getElementById('visible').addEventListener('change', e => (caja.visible = e.target.checked))
