// Probe DESECHABLE de la tanda 1 del renderer de geometría editable en GPU. Mide, en navegador y sobre
// el mapa real, las tres cosas que invalidarían el relleno por stencil-then-cover ANTES de que exista
// arquitectura que tirar: que el navegador OTORGUE el stencil, que un contexto propio conviva con el de
// glify sin agotar el techo de ~16, y que el fill-rate del abanico entre en presupuesto.
//
// La superficie (`src/render/EditSurface.js`) y las geometrías (`test/fixtures/polygons.mjs`) se
// IMPORTAN: acá sólo vive el pase 1 del abanico, que es lo que todavía no existe y lo que se mide.
// El pase 2 se dibuja igual porque su `stencilOp ZERO` es lo que auto-limpia el stencil entre muestras.

import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { MapEngine, adoptLeafletHost, shapePresetIconSet, createSource } from '../src/index.js'
import { EditSurface } from '../src/render/EditSurface.js'
import { CASOS, crear, cuentaVertices, DEGENERADAS } from '../test/fixtures/polygons.mjs'

const PANE      = 'cristae-edit-probe'
const TEX_ANCHO = 2048
const MUESTRAS  = 12                          // por caso, más las descartadas
const DESCARTE  = 2                           // subida de textura + primer uso del programa
const TOTAL     = MUESTRAS + DESCARTE
const FLOTA     = 2500

const UMBRAL_EDICION = 4                      // ms — criterio de aceptación con bbox ≤ 25 % de pantalla
const UMBRAL_ALARMA  = 16                     // ms — peor caso a pantalla completa: sube a decisión

const $   = id => document.getElementById(id)
const ms  = v => (Number.isFinite(v) ? v.toFixed(3) : '—')
const pct = v => `${Math.round(v * 100)} %`

const mediana = xs => (xs.length ? [...xs].sort((a, b) => a - b)[xs.length >> 1] : NaN)

// Guard de saneo: un NaN o un ±Infinity envenena el bbox y con él el scissor → el anillo se descarta.
const finito = anillo => anillo.every(Number.isFinite)

/* ── Mapa real + capa glify VIVA: la convivencia de contextos es parte de lo que se mide ─────────── */

const CENTRO = [-33.441, -70.654]
window.L = L
await import('leaflet.glify')

const map    = L.map('map', { center: CENTRO, zoom: 13, zoomControl: true })
const engine = new MapEngine({ host: adoptLeafletHost(map, { leaflet: L }), glify: L.glify })
await engine.ready
engine.setTileProvider({ url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', maxZoom: 19, attribution: '© OpenStreetMap' })

const iconSet = shapePresetIconSet({ shape: 'dot', size: 14 })
const flota   = Array.from({ length: FLOTA }, (_, i) => ({
  id  : i,
  lat : CENTRO[0] + (Math.random() - 0.5) * 0.12,
  lng : CENTRO[1] + (Math.random() - 0.5) * 0.16,
}))
const fuente = createSource({
  idOf       : p => p.id,
  positionOf : p => ({ lat: p.lat, lng: p.lng }),
  variantOf  : () => '#22d3ee',
}, iconSet.variants)
engine.addPointLayer({ id: 'flota', source: fuente, iconSet })
fuente.set(flota)

/* ── Programas: abanico attributeless + quad de cobertura ────────────────────────────────────────── */

// Esquina 0 = el ancla (rel = 0), que es a la vez el origen de precisión: por eso la paridad compone
// entre anillos sin cuidado especial. Las otras dos leen la textura de posiciones por `texelFetch`.
const VS_ABANICO = `#version 300 es
precision highp float;
uniform sampler2D uPos;
uniform vec2  uOrigin;     // ancla, en px de contenedor
uniform vec2  uViewport;   // tamaño CSS del mapa
uniform float uScale;      // world0 px → px de pantalla (2^zoom)
uniform int   uBase;       // primer vértice del anillo dentro de la textura
uniform int   uCount;      // vértices del anillo
uniform int   uWidth;      // ancho de la textura de posiciones
void main() {
  int arista  = gl_VertexID / 3;
  int esquina = gl_VertexID % 3;
  vec2 rel = vec2(0.0);
  if (esquina > 0) {
    int i   = arista + esquina - 1;
    int idx = uBase + (i < uCount ? i : i - uCount);        // cierre implícito del anillo
    rel = texelFetch(uPos, ivec2(idx % uWidth, idx / uWidth), 0).xy;
  }
  vec2 ndc = (rel * uScale + uOrigin) / uViewport * 2.0 - 1.0;
  gl_Position = vec4(ndc.x, -ndc.y, 0.0, 1.0);
}`

const FS_PARIDAD = `#version 300 es
precision highp float;
out vec4 color;
void main() { color = vec4(1.0); }`      // la máscara de color está apagada: sólo importa el stencilOp

const VS_CUBRIR = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`

const FS_COLOR = `#version 300 es
precision highp float;
uniform vec4 uColor;
out vec4 color;
void main() { color = uColor; }`

const programa = (gl, fuenteVS, fuenteFS) => {
  const compilar = (tipo, texto) => {
    const s = gl.createShader(tipo)
    gl.shaderSource(s, texto)
    gl.compileShader(s)
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s))
    return s
  }
  const p = gl.createProgram()
  gl.attachShader(p, compilar(gl.VERTEX_SHADER, fuenteVS))
  gl.attachShader(p, compilar(gl.FRAGMENT_SHADER, fuenteFS))
  gl.linkProgram(p)
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p))
  return { p, u: new Proxy({}, { get: (cache, nombre) => (cache[nombre] ??= gl.getUniformLocation(p, nombre)) }) }
}

/* ── Contexto propio (EditSurface de src/) ───────────────────────────────────────────────────────── */

const pane = map.createPane(PANE)
pane.style.zIndex       = '640'               // sobre los canvas de glify, bajo popups y controles
pane.style.pointerEvents = 'none'

let superficie = null
let gpu        = null
let instalado  = null
let corrida    = null
const enVuelo  = []
const cache    = new Map()

const montarGl = antialias => {
  superficie = new EditSurface({ L, map, pane: PANE, antialias })
  const gl = superficie.attach()
  const tex = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gpu = {
    gl, tex,
    abanico : programa(gl, VS_ABANICO, FS_PARIDAD),
    cubrir  : programa(gl, VS_CUBRIR, FS_COLOR),
    timer   : gl.getExtension('EXT_disjoint_timer_query_webgl2'),
  }
  instalado = null
  informar()
}

map.on('move zoom resize viewreset', () => superficie?.resetCanvasReference())

const informar = () => {
  const { gl, timer } = gpu
  const info = gl.getExtension('WEBGL_debug_renderer_info')
  $('stencil').textContent  = String(gl.getContextAttributes().stencil)
  $('bits').textContent     = String(gl.getParameter(gl.STENCIL_BITS))
  $('samples').textContent  = String(gl.getParameter(gl.SAMPLES))
  $('timer').textContent    = timer ? 'EXT_disjoint_timer_query_webgl2' : 'ausente → CPU + gl.finish() (al alza)'
  $('gpuName').textContent  = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)
  $('perdido').textContent  = 'no'
}

/* ── Instalación de un caso: una sola subida de textura, en world0 relativo al ancla ──────────────── */

const anillosDe = ({ id, forma, n }) => {
  if (!cache.has(id)) cache.set(id, crear({ forma, n }).filter(finito))
  return cache.get(id)
}

const instalar = caso => {
  const { gl, tex } = gpu
  const anillos  = caso.anillos ?? anillosDe(caso)
  const vertices = cuentaVertices(anillos)
  const { x: W, y: H } = map.getSize()
  // La forma abarca [-1,1]: media anchura del bbox = √(pct·área)/2. Se guarda en world0 (÷2^zoom), así
  // el pan y el zoom no reescriben un solo byte — los absorbe la matriz.
  const escala = Math.sqrt(caso.pct * W * H) / 2 / 2 ** map.getZoom()

  const alto  = Math.max(1, Math.ceil(vertices / TEX_ANCHO))
  const datos = new Float32Array(TEX_ANCHO * alto * 2)
  const rangos = []
  let base = 0
  anillos.forEach(anillo => {
    const count = anillo.length / 2
    for (let i = 0; i < count; i++) {
      datos[(base + i) * 2]     = anillo[i * 2] * escala
      datos[(base + i) * 2 + 1] = anillo[i * 2 + 1] * escala
    }
    rangos.push({ base, count })
    base += count
  })
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, TEX_ANCHO, alto, 0, gl.RG, gl.FLOAT, datos)

  caso.vertices = vertices
  instalado = { rangos, escala, ancla: map.getCenter() }
}

/* ── Frame: relleno de dos pases; el pase 1 es lo único cronometrado ──────────────────────────────── */

const dibujar = caso => {
  if (!superficie?.attached || !instalado) return
  const { gl, tex, abanico, cubrir, timer } = gpu
  const { x: W, y: H } = map.getSize()
  const cw = superficie.canvas.width, ch = superficie.canvas.height
  const dpr    = cw / W
  const origen = map.latLngToContainerPoint(instalado.ancla)
  const zoom   = 2 ** map.getZoom()
  const ext    = instalado.escala * zoom + 1                  // media anchura del bbox en px CSS, con pad

  gl.disable(gl.SCISSOR_TEST)
  gl.clearColor(0, 0, 0, 0)
  gl.clearStencil(0)
  gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT)

  const sx = Math.max(0, Math.floor((origen.x - ext) * dpr))
  const sy = Math.max(0, Math.floor((H - origen.y - ext) * dpr))
  const sw = Math.min(cw - sx, Math.ceil(2 * ext * dpr))
  const sh = Math.min(ch - sy, Math.ceil(2 * ext * dpr))
  if (sw <= 0 || sh <= 0) return                              // bbox fuera de pantalla: nada que medir
  gl.enable(gl.SCISSOR_TEST)
  gl.scissor(sx, sy, sw, sh)

  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.useProgram(abanico.p)
  gl.uniform1i(abanico.u.uPos, 0)
  gl.uniform2f(abanico.u.uOrigin, origen.x, origen.y)
  gl.uniform2f(abanico.u.uViewport, W, H)
  gl.uniform1f(abanico.u.uScale, zoom)
  gl.uniform1i(abanico.u.uWidth, TEX_ANCHO)

  gl.enable(gl.STENCIL_TEST)
  gl.colorMask(false, false, false, false)
  gl.stencilMask(0x01)
  gl.stencilFunc(gl.ALWAYS, 0, 0x01)
  gl.stencilOp(gl.KEEP, gl.KEEP, gl.INVERT)                   // par-impar: impar = adentro

  const paridad = () => instalado.rangos.forEach(({ base, count }) => {
    gl.uniform1i(abanico.u.uBase, base)
    gl.uniform1i(abanico.u.uCount, count)
    gl.drawArrays(gl.TRIANGLES, 0, count * 3)
  })

  if (!caso) paridad()
  else if (timer) {
    const q = gl.createQuery()
    gl.beginQuery(timer.TIME_ELAPSED_EXT, q)
    paridad()
    gl.endQuery(timer.TIME_ELAPSED_EXT)
    enVuelo.push({ q, caso })
  } else {
    const t0 = performance.now()
    paridad()
    gl.finish()                                               // sin timer query no hay otra cota; distorsiona al alza
    caso.muestras.push(performance.now() - t0)
  }

  gl.colorMask(true, true, true, true)
  gl.stencilFunc(gl.NOTEQUAL, 0, 0x01)
  gl.stencilOp(gl.KEEP, gl.KEEP, gl.ZERO)                     // auto-limpia el stencil al escribir
  gl.useProgram(cubrir.p)
  gl.uniform4f(cubrir.u.uColor, 0.39, 0.40, 0.95, 0.42)
  gl.drawArrays(gl.TRIANGLES, 0, 3)

  // Invariante del contexto compartido: se sale con el estado neutro, o el pase de picking queda
  // recortado en silencio por el scissor del último relleno.
  gl.disable(gl.STENCIL_TEST)
  gl.disable(gl.SCISSOR_TEST)
}

/* ── Corrida: una muestra por frame; el timer query se cosecha cuando el pipeline la devuelve ────── */

const cosechar = () => {
  const { gl, timer } = gpu
  for (let i = enVuelo.length - 1; i >= 0; i--) {
    const { q, caso } = enVuelo[i]
    if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) continue
    if (!gl.getParameter(timer.GPU_DISJOINT_EXT)) caso.muestras.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6)
    gl.deleteQuery(q)
    enVuelo.splice(i, 1)
  }
}

const paso = () => {
  if (!corrida) return null
  const actual = corrida.casos[corrida.i]
  if (actual && actual.emitidas < TOTAL) { actual.emitidas++; return actual }

  const siguiente = corrida.casos[corrida.i + 1]
  if (!siguiente) {
    if (!enVuelo.length) terminar()
    return null
  }
  corrida.i++
  instalar(siguiente)
  siguiente.emitidas++
  $('progreso').textContent = `${corrida.i + 1}/${corrida.casos.length} · ${siguiente.id} @ ${pct(siguiente.pct)}`
  return siguiente
}

const p50 = caso => mediana(caso.muestras.slice(DESCARTE))

const terminar = () => {
  const casos = corrida.casos
  corrida = null
  $('progreso').textContent = 'corrida terminada'
  $('tabla').innerHTML = `<table>
    <thead><tr><th>forma</th><th>N</th><th>pantalla</th><th>aristas reales</th><th>p50 ms</th><th>min ms</th></tr></thead>
    <tbody>${casos.map(c => `<tr class="${p50(c) > UMBRAL_ALARMA ? 'mal' : p50(c) > UMBRAL_EDICION ? 'ojo' : 'ok'}">
      <td>${c.forma}</td><td>${c.n.toLocaleString('es')}</td><td>${pct(c.pct)}</td>
      <td>${(c.vertices ?? 0).toLocaleString('es')}</td><td>${ms(p50(c))}</td><td>${ms(Math.min(...c.muestras))}</td>
    </tr>`).join('')}</tbody></table>`
  $('veredicto').innerHTML = veredicto(casos)
}

const veredicto = casos => {
  const peor = filtro => {
    const valores = casos.filter(filtro).map(p50).filter(Number.isFinite)
    return valores.length ? Math.max(...valores) : NaN
  }
  const edicion  = peor(c => c.pct <= 0.25)
  const completo = peor(c => c.pct === 1)
  const lineas = [
    Number.isFinite(edicion) && (edicion < UMBRAL_EDICION
      ? `<b class="ok">ENTRA</b> · caso de edición (bbox ≤ 25 % de pantalla): peor p50 = ${ms(edicion)} ms < ${UMBRAL_EDICION} ms`
      : `<b class="mal">NO ENTRA</b> · caso de edición: peor p50 = ${ms(edicion)} ms ≥ ${UMBRAL_EDICION} ms — el relleno por stencil hay que repensarlo`),
    Number.isFinite(completo) && (completo > UMBRAL_ALARMA
      ? `<b class="ojo">SUBE A DECISIÓN</b> · pantalla completa: peor p50 = ${ms(completo)} ms > ${UMBRAL_ALARMA} ms — conmutador triangulación/abanico o acotar el caso`
      : `<b class="ok">OK</b> · pantalla completa: peor p50 = ${ms(completo)} ms ≤ ${UMBRAL_ALARMA} ms`),
  ]
  return lineas.filter(Boolean).join('<br>')
}

const marcados = nombre => [...document.querySelectorAll(`input[name=${nombre}]:checked`)].map(i => +i.value)

const arrancar = () => {
  const tamanos     = marcados('tam')
  const porcentajes = marcados('pct')
  corrida = {
    i: -1,
    casos: CASOS.filter(c => tamanos.includes(c.n)).flatMap(c => porcentajes.map(p => ({
      ...c, pct: p, emitidas: 0, muestras: [],
    }))),
  }
  $('tabla').innerHTML = ''
  $('veredicto').textContent = ''
  if (!corrida.casos.length) { corrida = null; $('progreso').textContent = 'no hay casos seleccionados' }
}

/* ── Un solo bucle de frames: mueve la flota, cosecha, emite la muestra del caso y dibuja ─────────── */

const marco = () => {
  for (let k = 0; k < 60; k++) {
    const p = flota[(Math.random() * FLOTA) | 0]
    p.lat += (Math.random() - 0.5) * 0.0025
    p.lng += (Math.random() - 0.5) * 0.0025
    fuente.move(p.id, p.lat, p.lng)
  }
  if (gpu) {
    cosechar()
    dibujar(paso())
    if (superficie.contextLost) $('perdido').textContent = 'SÍ — el navegador soltó el contexto'
  }
  requestAnimationFrame(marco)
}

/* ── Controles ───────────────────────────────────────────────────────────────────────────────────── */

$('correr').onclick = arrancar

const reiniciar = antialias => {
  montarGl(antialias)
  instalar({ id: 'espiral-5000', forma: 'espiral', n: 5_000, pct: 0.25 })   // algo dibujado desde el primer frame
}

// Alternar MSAA exige un contexto NUEVO: es lo único que justifica destruir la superficie, y de paso
// prueba que `destroy()` de verdad lo devuelve (si no, el siguiente `attach` no obtiene ninguno).
$('msaa').onchange = e => {
  superficie.destroy()
  enVuelo.length = 0                          // las queries del contexto muerto no se cosechan
  corrida = null
  $('progreso').textContent = 'contexto recreado — volvé a correr'
  reiniciar(e.target.checked)
}

$('aparcar').onclick = e => {
  const aparcada = superficie.attached
  aparcada ? superficie.park() : superficie.attach()
  e.target.textContent = aparcada ? 'reanudar' : 'aparcar'
}

// Las degeneradas no se miden: se comprueba que el guard las resuelva sin propagar.
$('degeneradas').onclick = () => {
  const rechazadas = Object.entries(DEGENERADAS).filter(([, anillos]) => !anillos.every(finito)).map(([k]) => k)
  instalar({ id: 'cierreDuplicado', pct: 0.25, anillos: DEGENERADAS.cierreDuplicado.filter(finito) })
  $('progreso').textContent = `guard → rechazadas: ${rechazadas.join(', ') || 'ninguna'} · dibujando cierreDuplicado (cuadrado limpio = arista de longitud 0 inocua)`
}

reiniciar(false)
requestAnimationFrame(marco)
