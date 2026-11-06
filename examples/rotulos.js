// Verificación a ojo de <cristae-labeled>: el texto sobre una geodésica que se alterna, la rosa de rumbos con
// `orientation`, `repeat` en una ruta sinuosa, el cluster por dentro y por fuera, `placement` sobre puntos y
// burbujas, el centro de un polígono, `html` con un botón, la píldora con `paint={drawLabel}`, el cambio de
// renderer en vivo y el click que abre la tarjeta del ítem. Sin tiles.

import { drawLabel, shapePresetIconSet } from '../src/index.js'

const $        = id => document.getElementById(id)
const COS_LAT  = Math.cos(-33.45 * Math.PI / 180)
const lineas   = { idOf: r => r.id, pathOf: r => r.path }
const iconSet  = shapePresetIconSet({ shape: 'dot', size: 16 })
const puntos   = color => ({ idOf: p => p.id, positionOf: p => p, variantOf: () => color, sizeOf: () => 16 })
const registro = texto => $('registro').textContent = texto

// Un rayo de `largo` grados desde el centro, con el rumbo medido en pantalla (0 = este, antihorario).
const rayo   = ([lat, lng], grados, largo) => {
  const r = grados * Math.PI / 180
  return [[lat, lng], [lat + largo * Math.sin(r), lng + largo * Math.cos(r) / COS_LAT]]
}
const rumbos = [...Array.from({ length: 16 }, (_, i) => i * 22.5), 89, 91]

// Posiciones repetibles alrededor de un centro, sin azar.
const cerca = ([lat, lng], i, radio) => ({ lat: lat + radio * Math.sin(i * 2.399), lng: lng + radio * Math.cos(i * 1.711) })

Object.assign($('vuelos'), {
  accessors : lineas,
  // Sídney a −208,82 y no a 151,18: un tramo de más de media vuelta es el lado largo, y la geodésica no lo toca.
  data      : [{ id: 'SCL–SYD', nombre: 'LA 801 Santiago–Sídney', path: [[-33.39, -70.79], [-33.94, 151.18 - 360]] }],
})
$('texto-vuelos').textOf = v => v.nombre

Object.assign($('rosa'), { accessors: lineas, data: rumbos.map(g => ({ id: `${g}°`, path: rayo([-33.50, -70.72], g, 0.06) })) })

Object.assign($('rutas'), {
  accessors : lineas,
  data      : [
    { id: 'sinuosa', nombre: 'Ruta sinuosa', path: Array.from({ length: 80 }, (_, i) => [-33.36 + 0.012 * Math.sin(i / 6), -70.80 + i * 0.004]) },
    { id: 'oeste', nombre: 'Hacia el oeste', path: [[-33.40, -70.44], [-33.405, -70.56]] },
    { id: 'horquilla', nombre: 'Horquilla', path: [[-33.33, -70.50], [-33.31, -70.49], [-33.33, -70.48]] },
  ],
})
$('texto-rutas').textOf = r => r.nombre

Object.assign($('flota'), {
  iconSet,
  accessors : puntos('#0ea5e9'),
  data      : Array.from({ length: 40 }, (_, i) => ({ id: i, patente: `TRK-${100 + i}`, ...cerca([-33.47, -70.58], i, 0.03) })),
})
$('texto-flota').textOf    = m => m.patente
$('texto-burbujas').textOf = b => `${b.count} camiones · ${b.leaves[0]?.patente ?? ''}`

Object.assign($('bases'), {
  iconSet,
  accessors : puntos('#6366f1'),
  data      : [{ id: 'norte', nombre: 'Base norte', lat: -33.38, lng: -70.66 }, { id: 'sur', nombre: 'Base sur', lat: -33.53, lng: -70.60 }],
})
// El nodo es estable por ítem: el listener sobrevive a los ticks.
$('texto-bases').htmlOf = b => {
  const boton = Object.assign(document.createElement('button'), { className: 'base', textContent: b.nombre })
  boton.addEventListener('click', () => registro(`click en ${b.nombre}`))
  return boton
}

Object.assign($('predios'), {
  accessors : { idOf: p => p.id, ringsOf: p => p.rings },
  data      : [{ id: 'Predio en C', rings: [[[-33.42, -70.52], [-33.42, -70.47], [-33.43, -70.47], [-33.43, -70.51], [-33.45, -70.51], [-33.45, -70.47], [-33.46, -70.47], [-33.46, -70.52]]] }],
})
Object.assign($('pildoras'), {
  iconSet,
  accessors : puntos('#16a34a'),
  data      : [{ id: 'planta', nombre: 'Planta', lat: -33.50, lng: -70.48 }],
})
Object.assign($('texto-pildoras'), { paint: drawLabel, textOf: p => p.nombre })

document.querySelector('cristae-popup').contentOf = x => `<b>${x.nombre ?? x.patente ?? x.id}</b>`

// ── Panel ──
const mapa   = document.querySelector('cristae-map')
const textos = [...document.querySelectorAll('cristae-labeled')]

$('ver-santiago').addEventListener('click', () => mapa.camera.setView({ lat: -33.45, lng: -70.62 }, 11))
$('ver-pacifico').addEventListener('click', () => mapa.camera.setView({ lat: -30, lng: -130 }, 2))

const enlazar = (id, aplicar) => $(id).addEventListener('input', e => {
  $(`${id}-v`).textContent = e.target.value
  aplicar(Number(e.target.value))
})
enlazar('repeat', v => $('texto-rutas').repeat = v || null)
enlazar('offset', v => $('texto-rosa').offset = v)
document.querySelectorAll('input[name=orientacion]').forEach(input =>
  input.addEventListener('change', () => $('texto-rosa').orientation = input.value))
$('geodesica').addEventListener('change', e => $('curva').enabled = e.target.checked)
$('placement').addEventListener('change', e => ['texto-flota', 'texto-burbujas'].forEach(id => $(id).placement = e.target.value))
$('renderer').addEventListener('change', e => ['texto-rutas', 'texto-flota', 'texto-predios'].forEach(id => $(id).renderer = e.target.value))
$('visible').addEventListener('change', e => textos.forEach(t => t.visible = e.target.checked))
// El contenedor de Leaflet vive en el shadow root del mapa y trae su propio fondo.
$('oscuro').addEventListener('change', e =>
  mapa.shadowRoot.querySelector('.leaflet-container').style.background = e.target.checked ? '#0f172a' : '')
