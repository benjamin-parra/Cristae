import { toRGBA } from './color.js'
import { frameTransform } from './frame.js'

// Capa de CAMPO DE CALOR (heatmap) reactiva a un Source. Hermana de PointLayer/LineLayer en el ciclo
// de vida (constructor {..}, subscribe al Source + redibujo coalescido a rAF, redraw/refresh/destroy),
// pero su BACKEND es un CANVAS 2D acumulativo (estilo leaflet.heat), NO glify:
//   1. cada punto estampa una BROCHA radial (degradado gris, opaco al centro → transparente al borde)
//      con un globalAlpha CHICO ∝ su peso → con source-over el alpha se ACUMULA donde los puntos se
//      agolpan (densidad). El aporte por punto es chico A PROPÓSITO: source-over es a+b·(1−a), que sólo
//      crece mientras a<1; si un punto aportara 1 (peso uniforme o intensity=1 sobre un núcleo opaco)
//      saturaría al toque y se verían discos sólidos, no densidad;
//   2. una pasada de COLOR mapea ese alpha acumulado a una paleta pre-muestreada de `colorRamp`.
//
// Por qué canvas y no GL: el heat aditivo real (splat gaussiano a un framebuffer + colorización en un
// segundo pase) no sale de los shaders de la point-layer en UN paso sin parchar glify (no hay programa
// de acumulación ni FBO expuesto). El canvas es un PRIMER backend honesto; la interfaz es idéntica a la
// que tendría el backend GL (misma firma de constructor y mismos accessors), así el swap posterior no
// toca el call-site (addHeatLayer). Costo conocido del backend canvas: getImageData/putImageData
// reservan el framebuffer por redibujo (inherente a la técnica; se acota coalesciendo a un frame). Ver
// `risks` del manifiesto.
//
// accessors: { idOf, positionOf, weightOf? }. `weightOf` (o 1) es el peso del punto; se NORMALIZA por el
// peso máximo del snapshot y se escala por `intensity`. Agnóstico: sin dominio, sin React, sin Wing.

const DEFAULT_RADIUS    = 25     // px del núcleo sólido de la brocha
const DEFAULT_BLUR      = 15     // px de caída (núcleo → transparente)
const DEFAULT_INTENSITY = 1      // multiplicador del aporte por punto (1 = default; >1 satura antes)
const POINT_ALPHA       = 0.12   // techo del alpha que aporta UN punto de peso pleno: ~1/POINT_ALPHA
                                 // puntos superpuestos llevan el campo al tope de la rampa. <1 para
                                 // que source-over ACUMULE (densidad) en vez de saturar a disco sólido
const MIN_OPACITY       = 0.05   // piso de alpha por punto (un punto aislado igual se ve)
const GRAD_STEPS        = 256    // resolución de la paleta (alpha 0..255 indexa 1:1)

const nonNeg = (v, dflt) => (v == null ? dflt : Math.max(0, v))   // radius/blur < 0 romperían createRadialGradient

// Rampa por defecto: transparente → azul → cian → verde → amarillo → rojo. Stops [t, [r,g,b,a]] en 0..1
// (el formato que `toRGBA` lee tal cual). Un consumidor puede pasar su propia `colorRamp(t)->rgba`.
const DEFAULT_STOPS = [
  [0.00, [0.13, 0.20, 0.80, 0]],
  [0.35, [0.13, 0.20, 0.80, 1]],
  [0.55, [0.00, 0.80, 0.80, 1]],
  [0.70, [0.30, 0.85, 0.20, 1]],
  [0.85, [0.95, 0.85, 0.10, 1]],
  [1.00, [0.90, 0.10, 0.10, 1]],
]

const lerp = (a, b, u) => a + (b - a) * u

// Interpola la rampa de stops en `t`. Sólo corre al construir la paleta (GRAD_STEPS veces), nunca en el
// hot-path de redibujo → el array por llamada es inofensivo.
const interpStops = (stops, t) => {
  const x = t <= 0 ? 0 : t >= 1 ? 1 : t
  let i = 1
  while (i < stops.length && stops[i][0] < x) i++
  const [t0, c0] = stops[i - 1]
  const [t1, c1] = stops[Math.min(i, stops.length - 1)]
  const u = t1 > t0 ? (x - t0) / (t1 - t0) : 0
  return [lerp(c0[0], c1[0], u), lerp(c0[1], c1[1], u), lerp(c0[2], c1[2], u), lerp(c0[3], c1[3], u)]
}

const defaultRamp = t => interpStops(DEFAULT_STOPS, t)

export class HeatLayer {

  #camera; #surface; #paneName; #source; #accessors
  #canvas  = null
  #ctx     = null
  #brush   = null               // canvas offscreen con el degradado radial (la "brocha" reusada por punto)
  #palette = null               // Uint8ClampedArray(GRAD_STEPS*4): rampa pre-muestreada, alpha → color
  #radius; #blur; #intensity; #colorRamp
  #agendado = false             // ya hay un redibujo pedido para este frame (coalescing)
  #unsub    = null
  #offView  = []                // bajas del ciclo de vista

  constructor({ host, pane, source, accessors = null, radius, blur, intensity, colorRamp } = {}) {
    const canvas = document.createElement('canvas')
    canvas.className           = 'cristae-heat-canvas'
    canvas.style.position      = 'absolute'
    canvas.style.pointerEvents = 'none'

    this.#camera    = host.camera
    this.#surface   = host.surface
    this.#paneName  = pane
    this.#source    = source
    this.#accessors = accessors ?? source.accessors
    this.#radius    = nonNeg(radius, DEFAULT_RADIUS)
    this.#blur      = nonNeg(blur, DEFAULT_BLUR)
    this.#intensity = intensity ?? DEFAULT_INTENSITY
    this.#colorRamp = colorRamp ?? defaultRamp

    this.#buildBrush()
    // Consulta colorRamp GRAD_STEPS veces (una vez; se re-muestrea si cambia la rampa). Es código del
    // consumidor y puede lanzar: va antes de montar, para que una capa que no nace no deje su pane.
    this.#buildPalette()
    this.#canvas = canvas
    this.#ctx    = canvas.getContext('2d')
    this.#surface.mount(pane).appendChild(canvas)
    // Ruta del Source: dibuja SÍNCRONO (como LineLayer#onChange). El Emitter del Source ya coalesce sus
    // notificaciones a UN rAF, así que un rAF propio acá sería un SEGUNDO frame de latencia sin ganancia.
    // El rAF de #invalidate queda para los eventos de mapa (que Leaflet dispara sin coalescer).
    this.#unsub = source.subscribe(() => this.#draw())
    // El canvas vive en un pane que se traslada con el mapa (pan); en zoom hay que reproyectar y, durante
    // el zoom-anim, ocultarlo (si no, el campo se desliza desfasado). Igual patrón que LabelLayer. Al
    // asentar NO se revela: sólo se agenda el redibujo, y el canvas se muestra al FINAL de #draw, con el
    // contenido fresco y colorizado. Revelar antes mostraría la vista anterior desubicada o, si colorize
    // fallara, la acumulación negra cruda.
    this.#offView = [
      this.#camera.on('zoomstart', () => this.#canvas.style.visibility = 'hidden'),
      this.#camera.on('moveend zoomend resize', () => this.#invalidate()),
    ]
    this.#draw()                // primer paint síncrono
  }

  /* ── Ciclo de vida (interfaz de las capas hermanas; se auto-reproyecta, no va a #glLayers) ── */

  redraw() { this.#draw() }
  resetCanvasReference() { this.#draw() }             // reposiciona + redibuja (el draw hace ambas)
  refresh() { this.#buildPalette(); this.#draw() }    // re-encode (p. ej. cambio de tema en la rampa)
  syncPickingSize() {}                                // sin picking (un heat no se pica)

  destroy() {
    if (!this.#canvas) return
    this.#unsub?.()
    this.#offView.forEach(off => off())
    this.#canvas.remove()
    this.#surface.unmount(this.#paneName)
    this.#canvas = null
    this.#ctx = null
  }

  /* ── Props en vivo (el handle de addHeatLayer las cablea) ── */

  set radius(v) { this.#radius = nonNeg(v, DEFAULT_RADIUS); this.#buildBrush(); this.#invalidate() }
  set blur(v) { this.#blur = nonNeg(v, DEFAULT_BLUR); this.#buildBrush(); this.#invalidate() }
  set intensity(v) { this.#intensity = v ?? DEFAULT_INTENSITY; this.#invalidate() }
  set colorRamp(fn) { this.#colorRamp = fn ?? defaultRamp; this.#buildPalette(); this.#invalidate() }

  /* ── Coalescing a un frame para disparos NO coalescidos aguas arriba: eventos de mapa (Leaflet los
     emite sync, pueden venir en ráfaga) y props en vivo (radius+blur+intensity juntos → un solo
     redibujo, no tres framebuffers). La ruta del Source NO pasa por acá: ya viene coalescida. ── */

  #invalidate() {
    if (this.#agendado) return
    this.#agendado = true
    requestAnimationFrame(() => { this.#agendado = false; this.#draw() })
  }

  /* ── Redibujo: acumular densidad + colorizar ── */

  // Sin vista no hay píxel que leer: un mapa adoptado que todavía no la tomó pinta en el `moveend` que la
  // trae. El canvas se ancla al origen del contenedor —el pane lo traslada durante el paneo— y se
  // redimensiona sólo si cambió el tamaño, que va en px CSS: el calor es un campo difuso, sin escalado
  // por DPR (ver risks). Asignar el ancho lo limpia.
  #draw() {
    const ctx    = this.#ctx
    const canvas = this.#canvas
    if (!ctx || !canvas || !this.#camera.hasView()) return
    const rect = this.#surface.container.getBoundingClientRect()
    const w    = Math.round(rect.width)
    const h    = Math.round(rect.height)
    if (w === 0 || h === 0) return

    const origin = this.#camera.frameOrigin()
    canvas.style.transform = frameTransform(origin.x, origin.y)
    if (canvas.width !== w) canvas.width = w
    if (canvas.height !== h) canvas.height = h
    ctx.clearRect(0, 0, w, h)

    const a        = this.#accessors
    const items    = this.#source.getSnapshot()
    const weightOf = a.weightOf
    // Normaliza por el peso máximo del snapshot: la escala del campo no depende de las unidades del peso.
    const maxW  = weightOf ? (items.reduce((m, it) => Math.max(m, weightOf(it) || 0), 0) || 1) : 1
    const R     = this.#radius + this.#blur      // medio-lado de la brocha = alcance de un punto en px
    const brush = this.#brush

    items.forEach(item => {
      const pos = a.positionOf(item)
      if (!pos || !Number.isFinite(pos.lat) || !Number.isFinite(pos.lng)) return
      const p = this.#camera.toContainer(pos)
      if (p.x < -R || p.x > w + R || p.y < -R || p.y > h + R) return   // culling: fuera del viewport
      const wgt = (weightOf ? (weightOf(item) || 0) : 1) / maxW
      // Aporte CHICO por punto (·POINT_ALPHA): con source-over la densidad ACUMULA en vez de saturar a
      // disco sólido cuando los pesos son uniformes (weightOf ausente → wgt=1) o intensity es el default.
      ctx.globalAlpha = Math.min(Math.max(wgt * this.#intensity * POINT_ALPHA, MIN_OPACITY), 1)
      brush && ctx.drawImage(brush, p.x - R, p.y - R)
    })
    ctx.globalAlpha = 1

    this.#colorize(w, h)
    canvas.style.visibility = ''    // recién ahora hay un frame válido → revelar (ver el zoomstart del constructor)
  }

  // Alpha acumulado (densidad) → color de la paleta. El alpha del pixel indexa 1:1 la rampa; el color
  // del punto se toma de la paleta y el alpha final se atenúa por el alpha de la rampa (una rampa que
  // arranca transparente desvanece las densidades bajas).
  #colorize(w, h) {
    const ctx  = this.#ctx
    const img  = ctx.getImageData?.(0, 0, w, h)
    const data = img?.data
    if (!data) return
    const pal = this.#palette
    for (let i = 0; i < data.length; i += 4) {
      const alpha = data[i + 3]
      if (!alpha) continue
      const j = alpha << 2                   // alpha·4 → offset en la paleta (0..1020)
      data[i]     = pal[j]
      data[i + 1] = pal[j + 1]
      data[i + 2] = pal[j + 2]
      data[i + 3] = (alpha * pal[j + 3]) / 255
    }
    ctx.putImageData(img, 0, 0)
  }

  /* ── Brocha + paleta (se reconstruyen sólo al cambiar radius/blur o la rampa) ── */

  // Brocha: círculo gris con degradado radial opaco-al-centro → transparente-al-borde. Se estampa por
  // punto con globalAlpha variable; el alpha se acumula por composición → densidad.
  #buildBrush() {
    const R      = this.#radius + this.#blur
    const size   = Math.max(R * 2, 1)
    const canvas = document.createElement('canvas')
    canvas.width  = size
    canvas.height = size
    const ctx  = canvas.getContext('2d')
    const grad = ctx.createRadialGradient?.(R, R, 0, R, R, R)
    if (grad) {
      // R>0 evita el 0/0 (NaN → addColorStop throwea) cuando radius y blur son ambos 0.
      const core = R > 0 && this.#blur > 0 ? Math.min(this.#radius / R, 0.99) : 0
      grad.addColorStop(0, 'rgba(0,0,0,1)')
      grad.addColorStop(core, 'rgba(0,0,0,1)')
      grad.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = grad
      ctx.fillRect(0, 0, size, size)
    }
    this.#brush = canvas
  }

  // Paleta: muestrea `colorRamp` en GRAD_STEPS pasos → Uint8ClampedArray(GRAD_STEPS*4). `toRGBA`
  // normaliza el retorno de la rampa (hex string o [r,g,b,a] en 0..1) a 0..1; se escala a 0..255.
  #buildPalette() {
    const pal = this.#palette ?? new Uint8ClampedArray(GRAD_STEPS * 4)
    // Sólo corre al (re)construir la paleta, nunca por frame → el array de rango es inofensivo.
    Array.from({ length: GRAD_STEPS }, (_, i) => i).forEach(i => {
      const [r, g, b, alpha] = toRGBA(this.#colorRamp(i / (GRAD_STEPS - 1)))
      const o = i * 4
      pal[o]     = r * 255
      pal[o + 1] = g * 255
      pal[o + 2] = b * 255
      pal[o + 3] = alpha * 255
    })
    this.#palette = pal
  }
}
