// Relleno de polígonos por stencil (`RingStore` + `EditFillLayer`) contra el `L.polygon` de
// `PolygonLayer`, sobre la misma geometría.

import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { adoptLeafletHost } from '../src/host/LeafletHost.js'
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

const host = adoptLeafletHost(map)
host.surface.mount(PANE, 450, { pointer: false })   // sobre el overlayPane de los SVG

const superficie = new EditSurface({ host, pane: PANE })
const gl         = superficie.attach()

/* ── Estado ──────────────────────────────────────────────────────────────────────────────────────── */

const estado = { forma: 'agujero', n: 400, modo: 'ambos', figuras: 1, contorno: true }

let figuras = []                             // { rings, color } — una por copia de la forma
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

// N copias de la forma en una grilla, cada una con su color: el caso que decide si el conteo de draws
// escala con la cantidad de figuras.
const VERTICES_ESCALA = 24                   // el tamaño de una geocerca real; el eje de escala es la CANTIDAD

// `toRGBA` acepta hex o [r,g,b,a]: un `hsl()` cae al color por defecto, opaco.
const PALETA = ['#22d3ee', '#a3e635', '#f472b6', '#fbbf24', '#818cf8', '#34d399', '#fb7185', '#e879f9']
const HUE = i => PALETA[i % PALETA.length]
const replicar = (base, n) => {
  const lado = Math.ceil(Math.sqrt(n))
  const paso = GRADOS * 2.4
  return Array.from({ length: n }, (_, i) => {
    const dLat = (Math.floor(i / lado) - lado / 2) * paso
    const dLng = (i % lado - lado / 2) * paso
    return { rings: base.map(r => r.map(([lat, lng]) => [lat + dLat, lng + dLng])), color: HUE(i) }
  })
}

const conStencil = modo => modo === 'stencil' || modo === 'ambos'
const conSvg     = modo => modo === 'leaflet' || modo === 'ambos'

// Cada modo construye SÓLO su backend: construirlos todos hace que la carga y la memoria sean la suma
// de los tres, y el número deja de ser el del que se está mirando.
const instalar = () => {
  soltar()
  const modo   = estado.modo
  const n      = estado.figuras > 1 ? VERTICES_ESCALA : estado.n
  const crudos = (DEGENERADAS[estado.forma] ?? crear({ forma: estado.forma, n })).filter(finito)
  figuras = replicar(crudos.map(aLatLng), estado.figuras)
  const anillos = figuras.flatMap(f => f.rings)

  const t0 = performance.now()
  if (conStencil(modo)) {
    stores  = anillos.map(points => new RingStore({ gl, points, project }))
    capaGpu = new EditFillLayer({ gl, rings: stores.map(arena => ({ arena })), step: 1, color: GPU, opacity: ALPHA })
    trazos  = stores.map(arena => new EditStrokeLayer({ gl, arena, path: arena, project, step: 1, width: 2, color: GPU }))
  }
  conSvg(modo) && (svg = L.polygon(figuras.map(f => f.rings),
    { color: LEAFLET, weight: 1, fillColor: LEAFLET, fillOpacity: ALPHA, interactive: false }).addTo(map))

  $('msSubir').textContent   = ms(performance.now() - t0)
  $('nVertices').textContent = (cuentaVertices(crudos) * estado.figuras).toLocaleString('es')
  $('nFiguras').textContent  = estado.figuras.toLocaleString('es')
  $('nAnillos').textContent  = String(anillos.length)
  superficie.canvas.style.display = modo === 'leaflet' ? 'none' : ''
  pintar()
}

/* ── Frame ───────────────────────────────────────────────────────────────────────────────────────── */

let redibujos = 0

const pintar = () => {
  if (!capaGpu) return
  superficie.resetCanvasReference()
  gl.clearColor(0, 0, 0, 0)
  gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT)
  const vista   = encuadre()
  const t0     = performance.now()
  const dibujo = capaGpu.draw(vista)
  gl.finish()
  const t1 = performance.now()
  estado.contorno && trazos.forEach(t => t.draw(vista))
  gl.finish()                                // sin esto se mide el encolado, no el dibujo
  const t2 = performance.now()
  $('msRelleno').textContent  = ms(t1 - t0)
  $('msTrazo').textContent    = ms(t2 - t1)
  $('msDraw').textContent     = ms(t2 - t0)
  $('nDraws').textContent     = String(stores.length + 1 + (estado.contorno ? trazos.length * 2 : 0))
  $('enPantalla').textContent = dibujo ? 'sí' : 'no (fuera del viewport)'
  $('nRedibujos').textContent = String(++redibujos)
}

map.on('moveend zoomend resize viewreset', pintar)

/* ── Panel ───────────────────────────────────────────────────────────────────────────────────────── */

const opciones = [...Object.keys(FORMAS), ...Object.keys(DEGENERADAS)]
$('forma').append(...opciones.map(f => new Option(f, f)))
$('forma').value = estado.forma

$('forma').onchange   = e => { estado.forma = e.target.value; instalar() }
$('n').onchange       = e => { estado.n = +e.target.value; instalar() }
$('figuras').onchange = e => { estado.figuras = +e.target.value; instalar() }

$('modo').onchange     = e => { estado.modo = e.target.value; instalar() }
$('contorno').onchange = e => { estado.contorno = e.target.checked; pintar() }

$('gpuName').textContent = (() => {
  const info = gl.getExtension('WEBGL_debug_renderer_info')
  return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)
})()
$('stencil').textContent = String(gl.getContextAttributes().stencil)

instalar()
