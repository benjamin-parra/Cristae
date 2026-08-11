// Relleno de polígonos por stencil (`RingStore` + `EditFillLayer`) contra el `L.polygon` de
// `PolygonLayer`, sobre la misma geometría.

import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { EditSurface } from '../src/render/EditSurface.js'
import { EditFillLayer } from '../src/render/EditFillLayer.js'
import { EditStrokeLayer } from '../src/render/EditStrokeLayer.js'
import { RingStore } from '../src/render/RingStore.js'
import { projX0, projY0 } from '../src/render/project.js'
import { FORMAS, DEGENERADAS, crear, cuentaVertices } from '../test/fixtures/polygons.mjs'

const PANE   = 'cristae-poly-gpu'
const CENTRO = [-33.441, -70.654]
const GRADOS = 0.05                          // media arista del cuadrado de las fixturas, en grados

const GPU     = '#22d3ee'
const LEAFLET = '#f59e0b'
const ALPHA   = 0.45

const $  = id => document.getElementById(id)
const ms = v => (Number.isFinite(v) ? v.toFixed(2) : '—')

// Las fixturas son pares [x,y] planos en el cuadrado [-1,1], con cierre implícito.
const aLatLng = anillo => Array.from({ length: anillo.length / 2 }, (_, i) =>
  [CENTRO[0] + anillo[i * 2 + 1] * GRADOS, CENTRO[1] + anillo[i * 2] * GRADOS])

const finito = anillo => anillo.every(Number.isFinite)

const project = (lat, lng, out) => {
  out[0] = projX0(lng)
  out[1] = projY0(lat)
}

/* ── Mapa ────────────────────────────────────────────────────────────────────────────────────────── */

const map = L.map('map', { center: CENTRO, zoom: 12, preferCanvas: false, zoomControl: true })
L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
  maxZoom: 20, attribution: '© OpenStreetMap © CARTO',
}).addTo(map)

const pane = map.createPane(PANE)
pane.style.zIndex        = '450'             // sobre el overlayPane de los SVG
pane.style.pointerEvents = 'none'

const superficie = new EditSurface({ L, map, pane: PANE })
const gl         = superficie.attach()

/* ── Estado ──────────────────────────────────────────────────────────────────────────────────────── */

const estado = { forma: 'agujero', n: 400, modo: 'ambos' }

let anillos = []
let capaGpu = null
let trazos  = []
let stores  = []
let svg     = null

const vista = { zoom: 0, center: { x: 0, y: 0 }, size: { x: 0, y: 0 }, drag: null }

const encuadre = () => {
  const c = map.getCenter()
  const s = map.getSize()
  vista.zoom     = map.getZoom()
  vista.center.x = projX0(c.lng)
  vista.center.y = projY0(c.lat)
  vista.size.x   = s.x
  vista.size.y   = s.y
  return vista
}

/* ── Instalación de un caso ──────────────────────────────────────────────────────────────────────── */

const soltar = () => {
  capaGpu?.destroy()
  trazos.forEach(t => t.destroy())
  stores.forEach(s => s.destroy())
  svg && map.removeLayer(svg)
  capaGpu = svg = null
  trazos  = stores = []
}

const instalar = () => {
  soltar()
  const crudos = (DEGENERADAS[estado.forma] ?? crear({ forma: estado.forma, n: estado.n })).filter(finito)
  anillos = crudos.map(aLatLng)

  stores  = anillos.map(points => new RingStore({ gl, points, project }))
  capaGpu = new EditFillLayer({ gl, rings: stores.map(arena => ({ arena })), paso: 1, color: GPU, opacity: ALPHA })
  trazos  = stores.map(arena => new EditStrokeLayer({ gl, arena, path: arena, project, paso: 1, width: 2, color: GPU }))

  svg = L.polygon(anillos, { color: LEAFLET, weight: 1, fillColor: LEAFLET, fillOpacity: ALPHA, interactive: false })

  $('nVertices').textContent = cuentaVertices(crudos).toLocaleString('es')
  $('nAnillos').textContent  = String(anillos.length)
  $('nStores').textContent   = String(stores.length)
  aplicarModo()
}

const aplicarModo = () => {
  const { modo } = estado
  superficie.canvas.style.display = modo === 'leaflet' ? 'none' : ''
  const quiereSvg = modo !== 'gpu'
  quiereSvg ? svg.addTo(map) : map.removeLayer(svg)
  pintar()
}

/* ── Frame ───────────────────────────────────────────────────────────────────────────────────────── */

let redibujos = 0

const pintar = () => {
  if (!capaGpu || estado.modo === 'leaflet') return
  superficie.resetCanvasReference()
  gl.clearColor(0, 0, 0, 0)
  gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT)
  const t0 = performance.now()
  const vista  = encuadre()
  const dibujo = capaGpu.draw(vista)
  trazos.forEach(t => t.draw(vista))
  gl.finish()                                // sin esto se mide el encolado, no el dibujo
  $('msDraw').textContent     = ms(performance.now() - t0)
  $('enPantalla').textContent = dibujo ? 'sí' : 'no (fuera del viewport)'
  $('nRedibujos').textContent = String(++redibujos)
}

map.on('moveend zoomend resize viewreset', pintar)

/* ── Panel ───────────────────────────────────────────────────────────────────────────────────────── */

const opciones = [...Object.keys(FORMAS), ...Object.keys(DEGENERADAS)]
$('forma').append(...opciones.map(f => new Option(f, f)))
$('forma').value = estado.forma

$('forma').onchange = e => { estado.forma = e.target.value; instalar() }
$('n').onchange     = e => { estado.n = +e.target.value; instalar() }

$('modo').onchange = e => {
  estado.modo = e.target.value
  aplicarModo()
}

$('gpuName').textContent = (() => {
  const info = gl.getExtension('WEBGL_debug_renderer_info')
  return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)
})()
$('stencil').textContent = String(gl.getContextAttributes().stencil)

instalar()
