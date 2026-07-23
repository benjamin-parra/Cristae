// Soak del 1.0 — ejercita EN NAVEGADOR, sobre el motor real + mapa Leaflet + OSM, las capacidades
// nuevas de la escalera aditiva 0.14→0.22: point-layer con shape-preset, overlay de realce (retículo),
// focus (atenuar resto), map:click, polígono-Source reactivo (patch/styleOf), círculo-en-metros, heat,
// edición reactiva y fit=all. NO es lib code — es una herramienta de QC visual (examples/). Cada control
// escribe en el log lo que hay que ver, para validar a ojo. Servido por vite (imports ESM de la lib real).

/* global window, document, setInterval, requestAnimationFrame */
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { MapEngine, shapePresetIconSet, createSource } from '../src/index.js'

window.L = L
await import('leaflet.glify')            // side-effect: adjunta L.glify (mismo patrón que <cristae-map>)
const glify = L.glify

/* ── Mapa + motor reales ─────────────────────────────────────────────────────────────────────── */
const CENTER = [-33.441, -70.654]        // Santiago
const map    = L.map('map', { center: CENTER, zoom: 13, preferCanvas: true, zoomControl: true })
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map)
const engine = new MapEngine({ leaflet: L, glify, map })
await engine.ready

/* ── Helpers ─────────────────────────────────────────────────────────────────────────────────── */
const $      = (id) => document.getElementById(id)
const rnd    = (a, b) => a + Math.random() * (b - a)
const near   = (dLat = 0.05, dLng = 0.06) => ({ lat: CENTER[0] + rnd(-dLat, dLat), lng: CENTER[1] + rnd(-dLng, dLng) })
const ring   = ([lat, lng], d) => [[lat - d, lng - d], [lat - d, lng + d], [lat + d, lng + d], [lat + d, lng - d]]
const toggle = (el, on) => { el.setAttribute('aria-pressed', String(on)); el.textContent = on ? 'ON' : 'OFF' }
const log    = (msg) => { const el = $('log'); el.textContent = (msg + '\n' + el.textContent).split('\n').slice(0, 60).join('\n') }

/* ── 1 · Flota GPU (shape-preset dot) + overlay de realce + focus + map:click ────────────────────
   Verificar: los puntos se mueven fluido (source.move O(1), sin tirones); el retículo del realce
   SIGUE al punto en pan/zoom, vive en espacio de PANTALLA (no rota con el sprite) y su costo escala
   con K (resaltados), no con N (flota); focus atenúa el resto; click en vacío loguea latlng. */
const COLORS = ['#22d3ee', '#a3e635', '#f472b6', '#fbbf24']
const N      = 250
const fleet  = Array.from({ length: N }, (_, i) => { const p = near(); return { id: i, lat: p.lat, lng: p.lng, color: COLORS[i % COLORS.length] } })

const iconSet     = shapePresetIconSet({ shape: 'dot', size: 18 })
const fleetSource = createSource({
  idOf:       (p) => p.id,
  positionOf: (p) => ({ lat: p.lat, lng: p.lng }),
  variantOf:  (p) => p.color,             // la variante ES el color (shape-preset)
  sizeOf:     () => 18,                    // el overlay lee sizeOf para dimensionar el retículo
}, iconSet.variants)
engine.addPointLayer({ id: 'fleet', source: fleetSource, iconSet, interactive: true })
fleetSource.set(fleet)

let moving = true
setInterval(() => {
  if (!moving) return
  Array.from({ length: 60 }, () => fleet[(Math.random() * N) | 0]).forEach((p) => {
    p.lat += rnd(-0.0018, 0.0018)
    p.lng += rnd(-0.0018, 0.0018)
    fleetSource.move(p.id, p.lat, p.lng)
  })
}, 90)

const ACCENT = '#6366f1'
const drawHighlight = (ctx, size, key) => {
  const r = size * 0.9
  ctx.strokeStyle = ACCENT; ctx.lineWidth = 2
  ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.stroke()
  if (key !== 'follow') return
  ctx.lineWidth = 2.5                       // 4 rayos cardinales (screen-space → no rotan con el rumbo)
  Array.from({ length: 4 }, (_, i) => i * Math.PI / 2).forEach((a) => {
    ctx.beginPath()
    ctx.moveTo(Math.cos(a) * r * 1.05, Math.sin(a) * r * 1.05)
    ctx.lineTo(Math.cos(a) * r * 1.55, Math.sin(a) * r * 1.55)
    ctx.stroke()
  })
}
const overlay = engine.addHighlightOverlay({ id: 'hl', layerId: 'fleet', drawHighlight })
const setK = (k) => {
  overlay.setHighlighted(new Map(Array.from({ length: k }, (_, i) => [i, 'follow'])))
  $('kv').textContent = k
}
setK(8)
$('k').oninput = (e) => setK(+e.target.value)

let focused = false
$('focus').onclick = (e) => {
  focused = !focused
  // focus es por CAPA (no por punto): deja 'fleet' a opacidad plena y ATENÚA las otras capas
  // (polígonos/círculo/heat). unfocus con el set vacío restaura todo.
  if (focused) engine.focus(['fleet'], { opacity: 0.15 })
  else engine.unfocus(['fleet'])
  toggle(e.target, focused)
  log(focused ? 'focus: capa flota plena, resto de CAPAS atenuado' : 'unfocus → restaura todo')
}
$('move').onclick = (e) => { moving = !moving; toggle(e.target, moving); log(moving ? 'flota en movimiento' : 'flota pausada') }

engine.on('map:click', ({ latlng }) => log(`map:click → ${latlng.lat.toFixed(4)}, ${latlng.lng.toFixed(4)}`))
engine.on('viewportchange', ({ zoom }) => { $('zoom').textContent = zoom })

/* ── 2 · Polígono-Source reactivo (patch + styleOf) ──────────────────────────────────────────────
   Verificar: "Recolorear #2" cambia SÓLO el polígono del medio (restyle O(1) por patch de un id),
   sin re-crear los otros dos ni parpadeo. */
const polys = [
  { id: 'p1', rings: ring([-33.42, -70.63], 0.018), fill: '#3b82f6' },
  { id: 'p2', rings: ring([-33.462, -70.675], 0.018), fill: '#3b82f6' },
  { id: 'p3', rings: ring([-33.404, -70.705], 0.018), fill: '#3b82f6' },
]
const polySource = createSource({
  idOf:    (p) => p.id,
  ringsOf: (p) => p.rings,
  styleOf: (p) => ({ color: p.fill, weight: 2, fillColor: p.fill, fillOpacity: 0.25 }),
})
engine.addPolygonLayer({ id: 'polys', source: polySource, interactive: true })
polySource.set(polys)
$('restyle').onclick = () => {
  const p2 = polys.find((p) => p.id === 'p2')
  p2.fill = p2.fill === '#3b82f6' ? '#ef4444' : '#3b82f6'
  polySource.patch(polys, ['p2'])
  log(`polígono patch → #p2 = ${p2.fill} (sólo el del medio debe recolorear)`)
}

/* ── 3 · Círculo en METROS (Leaflet-native) ──────────────────────────────────────────────────────
   Verificar: al hacer ZOOM IN el círculo CRECE en pantalla (radio en metros, no sprite fijo). */
const circles    = [{ id: 'c1', lat: CENTER[0], lng: CENTER[1], r: 800 }]
const circSource = createSource({
  idOf:           (c) => c.id,
  positionOf:     (c) => ({ lat: c.lat, lng: c.lng }),
  radiusMetersOf: (c) => c.r,
  styleOf:        () => ({ color: '#10b981', weight: 2, fillColor: '#10b981', fillOpacity: 0.12 }),
})
engine.addCircleLayer({ id: 'circ', source: circSource })
circSource.set(circles)

/* ── 4 · Heatmap (GPU, densidad acumulada) ───────────────────────────────────────────────────────
   Verificar: 3 focos calientes (blend aditivo, no discos opacos apilados); radio/intensidad reactivos. */
const HOT   = [[-33.428, -70.638], [-33.462, -70.672], [-33.410, -70.622]]
const heatPts = Array.from({ length: 500 }, (_, i) => {
  const c = HOT[i % 3]
  return { id: i, lat: c[0] + rnd(-0.02, 0.02), lng: c[1] + rnd(-0.02, 0.02), w: Math.random() }
})
const heatSource = createSource({ idOf: (p) => p.id, positionOf: (p) => ({ lat: p.lat, lng: p.lng }), weightOf: (p) => p.w })
const heat       = engine.addHeatLayer({ id: 'heat', source: heatSource, radius: 30, intensity: 1, visible: false })
heatSource.set(heatPts)
$('heat').onclick = (e) => { const on = e.target.getAttribute('aria-pressed') !== 'true'; heat.setVisible(on); toggle(e.target, on) }
$('heatR').oninput = (e) => { heat.setRadius(+e.target.value); $('heatRv').textContent = e.target.value }

/* ── 5 · Edición reactiva (input controlado, Leaflet-native) ─────────────────────────────────────
   Verificar: arrastrar un vértice / clic en punto medio (inserta) / dblclick (borra) emiten onChange;
   el conteo de vértices se refleja en el log. */
// El editor POSEE los handles (vértices/puntos medios) pero NO dibuja la forma: el display se ata
// afuera enlazando el MISMO value a una capa de polígono (así se ve el relleno mientras se edita).
const editRing    = ring([-33.44, -70.598], 0.014)
const editDisplay = [{ id: 'ed', rings: editRing, fill: '#f59e0b' }]
const editSource  = createSource({
  idOf:    (p) => p.id,
  ringsOf: (p) => p.rings,
  styleOf: (p) => ({ color: p.fill, weight: 2, fillColor: p.fill, fillOpacity: 0.2 }),
})
engine.addPolygonLayer({ id: 'edit-display', source: editSource, interactive: false })
editSource.set(editDisplay)
engine.addEditableLayer({
  id: 'edit-0', kind: 'polygon', value: editRing, mode: 'edit',
  onChange: (v) => {                       // cada edición re-ata el value a la capa de display (patch O(1))
    editDisplay[0].rings = v
    editSource.patch(editDisplay, ['ed'])
    log(`edición onChange → ${v.length} vértices`)
  },
})
log('editable montado: arrastrá los vértices (blancos), clic en punto medio inserta, dblclick borra')

/* ── 6 · fit=all + leak test de contexto GL (0.13.7) ─────────────────────────────────────────────
   Leak test: monta/desmonta una capa GL de puntos 20 veces; si loseContext libera bien, el mapa y el
   heat siguen renderizando GL al final (sin "Too many active WebGL contexts"). */
$('fit').onclick = () => { engine.fitToLayers(); log('fit=all: encuadra TODAS las capas con datos') }
$('leak').onclick = () => {
  const cycle = (n) => {
    const s = createSource({ idOf: (p) => p.id, positionOf: (p) => ({ lat: p.lat, lng: p.lng }), variantOf: () => '#ffffff' }, iconSet.variants)
    engine.addPointLayer({ id: 'leak-probe', source: s, iconSet })
    s.set(Array.from({ length: 50 }, (_, i) => { const p = near(); return { id: i, lat: p.lat, lng: p.lng } }))
    engine.removeLayer('leak-probe')
    if (n > 0) requestAnimationFrame(() => cycle(n - 1))
    else log('leak test: 20 ciclos add/removeLayer GL — el mapa debe seguir vivo (contexto liberado)')
  }
  cycle(20)
}

log('motor listo — ' + N + ' puntos vivos. Recorré las 6 secciones del panel.')
