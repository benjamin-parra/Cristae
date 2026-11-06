// Verificación a ojo de <cristae-text-layer> y de <cristae-label-layer> traducida a su reemplazo: la píldora
// ligada a un host con un id marcado, la de Source propia, la burbuja de rótulo del cluster, y texto suelto en
// canvas y en html. Sin tiles. La parte de label-layer no usa nada nuevo: sirve igual contra una versión vieja.

import { createSource, shapePresetIconSet } from '../src/index.js'

const $        = id => document.getElementById(id)
const iconSet  = shapePresetIconSet({ shape: 'dot', size: 14 })
const puntos   = color => ({ idOf: p => p.id, positionOf: p => p, variantOf: () => color, sizeOf: () => 14 })
const enLinea  = (lat, lng, n, paso) => Array.from({ length: n }, (_, i) => ({ lat, lng: lng + i * paso }))

const flota = enLinea(-33.39, -70.74, 4, 0.03).map((p, i) => ({ ...p, id: `m${i}`, patente: `CD-100${i}` }))
Object.assign($('flota'), { iconSet, accessors: puntos('#0ea5e9'), data: flota })
$('patentes').textOf = m => m.patente

const sueltas = createSource({ idOf: s => s.id, positionOf: s => s })
sueltas.set(enLinea(-33.51, -70.74, 3, 0.04).map((p, i) => ({ ...p, id: `s${i}`, texto: `Bodega ${i + 1}` })))
Object.assign($('sueltas'), { source: sueltas, accessors: { idOf: s => s.id, positionOf: s => s }, textOf: s => s.texto })

// Doce puntos juntos: a este zoom, una sola burbuja con su conteo.
const grupo = Array.from({ length: 12 }, (_, i) => ({ id: `g${i}`, lat: -33.43 + (i % 4) * 0.002, lng: -70.50 + (i >> 2) * 0.002 }))
Object.assign($('grupo'), { iconSet, accessors: puntos('#16a34a'), data: grupo })

const comunas = [
  { id: 'stgo', nombre: 'Santiago', lat: -33.445, lng: -70.655 },
  { id: 'nunoa', nombre: 'Ñuñoa', lat: -33.457, lng: -70.598 },
  { id: 'maipu', nombre: 'Maipú', lat: -33.483, lng: -70.660 },
]
const comunasLayer = $('comunas')
comunasLayer.accessors = { idOf: c => c.id, positionOf: c => c }
comunasLayer.textOf    = c => c.nombre
comunasLayer.data      = comunas

const cerros = [
  { id: 'sc', nombre: 'San Cristóbal', cota: 880, lat: -33.425, lng: -70.633 },
  { id: 'sl', nombre: 'Santa Lucía', cota: 629, lat: -33.440, lng: -70.643 },
]
Object.assign($('cerros'), { iconSet, accessors: puntos('#d97706'), data: cerros })
const cotas = $('cotas')
cotas.accessors = { idOf: c => c.id, positionOf: c => c }
// El mapa vive en un shadow root: el CSS del documento no llega al nodo del rótulo, así que el estilo va en línea.
const COTA = 'font:600 11px ui-sans-serif,system-ui,sans-serif;padding:1px 5px;border-radius:5px;' +
  'background:#fef3c7;border:1px solid #d97706;color:#78350f'
cotas.htmlOf    = c => `<span style="${COTA}">${c.nombre} · ${c.cota} m</span>`
cotas.data      = cerros

// El hover que marca el handle de la label-layer, y el click de las cotas.
document.querySelector('cristae-map').addEventListener('cristae:ready', e => {
  requestAnimationFrame(() => $('patentes').controls?.setHovered(['m2']))
  e.target.engine.on('click', 'cotas', hits => $('registro').textContent = `click: ${hits[0]?.id ?? '—'}`)
})
