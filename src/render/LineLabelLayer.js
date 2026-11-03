import { frameTransform } from './frame.js'
import { projX0, projY0, readView } from './project.js'
import { placeGlyphs } from './textPath.js'
import { coordOf } from '../data/path.js'
import { safe } from '../data/safe.js'
import { foldRuns } from '../geometry/polyline.js'

// LineLabelLayer — texto que sigue el trazo de una línea, en un canvas 2D anclado al origen del
// contenedor (como LabelLayer). La colocación es de `placeGlyphs`; acá se proyecta, se mide por punto de
// código y se pinta glifo por glifo con halo. Se oculta en el zoom animado y redibuja al asentar la vista,
// con cada aviso de su Source y, coalescido a un frame, con cada cambio de estilo.

const PLACEMENTS   = new Set(['center', 'start'])
const ORIENTATIONS = new Set(['auto', 'path'])
const MAX_LAYOUTS  = 4096                // textos distintos cacheados por fuente antes de vaciar

// Fuente y colores de LabelLayer: una línea y un punto rotulados se ven iguales.
const DEFAULT_STYLE = Object.freeze({
  placement   : 'center',
  repeat      : null,
  offset      : 0,
  orientation : 'auto',
  maxAngle    : 45,
  font        : '700 10.5px Inter, ui-sans-serif, system-ui, -apple-system, sans-serif',
  color       : '#0f172a',
  halo        : '#ffffff',
  haloWidth   : 3,
})

const onTextError = e => console.error('[cristae] textOf de la capa de texto sobre líneas', e)

// Un `undefined` no cambia nada y un `null` vuelve al valor por defecto. Lanza antes de devolver: quien la
// llama todavía no tocó su estado.
const mergeStyle = (current, patch = {}) => {
  const next = { ...current }
  Object.keys(patch).forEach(key => patch[key] !== undefined && (next[key] = patch[key] ?? DEFAULT_STYLE[key]))
  const { placement, repeat, offset, orientation, maxAngle, haloWidth } = next
  if (!PLACEMENTS.has(placement)) throw new TypeError(`[cristae] placement '${placement}': se espera 'center' o 'start'`)
  if (!ORIENTATIONS.has(orientation)) throw new TypeError(`[cristae] orientation '${orientation}': se espera 'auto' o 'path'`)
  if (repeat !== null && !(Number.isFinite(repeat) && repeat > 0)) throw new TypeError(`[cristae] repeat ${repeat}: se espera un número finito > 0, o null`)
  if (!Number.isFinite(offset)) throw new TypeError(`[cristae] offset ${offset}: se espera un número finito`)
  if (!(maxAngle > 0 && maxAngle < 180)) throw new TypeError(`[cristae] maxAngle ${maxAngle}: se espera un número en (0, 180)`)
  if (!(haloWidth >= 0)) throw new TypeError(`[cristae] haloWidth ${haloWidth}: se espera un número ≥ 0`)
  return next
}

const grow = (arr, need) => {
  if (arr.length >= need) return arr
  const next = new arr.constructor(Math.max(arr.length * 2, need))
  next.set(arr)
  return next
}

// Un tramo de `foldRuns`, proyectado a px de contenedor y sumado a `run`: vértices en `xy`, largo
// acumulado en `cum` y, por parte, (primer vértice, cantidad, caja). Un vértice que cae en el mismo px
// que el anterior no suma: el segmento de largo 0 no tiene tangente. Vive en el módulo, estable entre
// llamadas, por lo que dice `foldRuns`.
const projectRun = (run, vertices, first, count) => {
  run.xy  = grow(run.xy, (run.n + count) * 2)
  run.cum = grow(run.cum, run.n + count)
  const { xy, cum, cx, cy, scale, hw, hh, n: from } = run
  let n    = from
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity

  for (let i = first; i < first + count; i++) {
    const x = (projX0(coordOf(vertices[i], 1)) - cx) * scale + hw
    const y = (projY0(coordOf(vertices[i], 0)) - cy) * scale + hh
    if (n > from && x === xy[2 * n - 2] && y === xy[2 * n - 1]) continue
    cum[n]        = n > from ? cum[n - 1] + Math.hypot(x - xy[2 * n - 2], y - xy[2 * n - 1]) : 0
    xy[2 * n]     = x
    xy[2 * n + 1] = y
    n++
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  if (n - from < 2) return run

  const parts = run.parts = grow(run.parts, (run.count + 1) * 6)
  const at    = run.count++ * 6
  parts[at]     = from
  parts[at + 1] = n - from
  parts[at + 2] = minX
  parts[at + 3] = minY
  parts[at + 4] = maxX
  parts[at + 5] = maxY
  run.n = n
  return run
}

export class LineLabelLayer {

  #camera
  #surface
  #pane
  #canvas
  #ctx
  #offView
  #style
  #enabled
  #unsub   = null
  #source  = null
  #pathOf  = null
  #textOf  = null
  #frame   = 0                         // rAF del redibujo agendado por `style`
  #width   = 0
  #height  = 0
  #ratio   = 1
  #view    = { zoom: 0, center: { x: 0, y: 0 }, size: { x: 0, y: 0 } }
  #run     = { xy: new Float64Array(256), cum: new Float64Array(128), parts: new Float64Array(48), n: 0, count: 0, cx: 0, cy: 0, scale: 1, hw: 0, hh: 0 }
  #out     = { buf: new Float64Array(192) }
  #opts    = { ...DEFAULT_STYLE, viewW: 0, viewH: 0 }
  #glyphs  = new Map()                 // punto de código → ancho, en la fuente vigente
  #layouts = new Map()                 // texto → { chars, widths, total }, en la fuente vigente

  // El estilo se valida antes de montar: una capa que no nace no deja su canvas en el pane.
  constructor({ host, pane, style, visible = true }) {
    this.#style = mergeStyle(DEFAULT_STYLE, style)
    const { camera, surface } = host
    const canvas              = document.createElement('canvas')
    canvas.className           = 'cristae-line-label-canvas'
    canvas.style.pointerEvents = 'none'

    this.#camera  = camera
    this.#surface = surface
    this.#pane    = pane
    this.#enabled = visible
    this.#canvas  = canvas
    this.#ctx     = canvas.getContext('2d', { alpha: true })
    surface.mount(pane).appendChild(canvas)
    this.#offView = [
      camera.on('zoomstart', () => this.#canvas.style.visibility = 'hidden'),
      camera.on('moveend zoomend resize', () => this.#draw()),
      camera.on('zoomend', () => this.#canvas.style.visibility = ''),
    ]
    // Una fuente web que termina de cargar cambia los anchos medidos con la de reemplazo.
    document.fonts?.ready.then(() => {
      this.#forgetWidths()
      this.#draw()
    })
  }

  // La Source y sus accessors llegan al ligar, que puede ser después del alta si el host aún no existía.
  bind(source, { idOf, pathOf }, textOf) {
    if (!this.#canvas) return
    this.#source = source
    this.#pathOf = pathOf
    this.#textOf = textOf ?? (item => String(idOf(item)))
    this.#unsub  = source.subscribe(() => this.#draw())
    this.#draw()
  }

  // Oculta no pinta: ni con la Source ni al mover la vista. Al volver pinta lo actual.
  setVisible(visible) {
    this.#enabled = visible
    this.#draw()
    return visible
  }

  style(patch) {
    const next = mergeStyle(this.#style, patch)
    next.font !== this.#style.font && this.#forgetWidths()
    this.#style = next
    if (this.#canvas && !this.#frame) this.#frame = requestAnimationFrame(() => {
      this.#frame = 0
      this.#draw()
    })
    return next
  }

  destroy() {
    if (!this.#canvas) return
    this.#unsub?.()
    this.#offView.forEach(off => off())
    this.#frame && cancelAnimationFrame(this.#frame)
    this.#canvas.remove()
    this.#surface.unmount(this.#pane)
    this.#forgetWidths()
    this.#canvas = this.#ctx = this.#source = null
  }

  #forgetWidths() {
    this.#glyphs.clear()
    this.#layouts.clear()
  }

  // Los glifos son puntos de código y no unidades UTF-16: un par sustituto es un glifo.
  #layout(text) {
    const known = this.#layouts.get(text)
    if (known) return known
    this.#layouts.size >= MAX_LAYOUTS && this.#layouts.clear()

    const chars  = [...text]
    const widths = new Float64Array(chars.length)
    chars.forEach((ch, i) => {
      let w = this.#glyphs.get(ch)
      if (w === undefined) this.#glyphs.set(ch, w = this.#ctx.measureText(ch).width)
      widths[i] = w
    })
    const layout = { chars, widths, total: widths.reduce((sum, w) => sum + w, 0) }
    this.#layouts.set(text, layout)
    return layout
  }

  // Sin vista no hay píxel que leer: un mapa adoptado que todavía no la tomó pinta en el `moveend` que la
  // trae. Asignar el ancho del canvas lo limpia; si no cambia, se limpia a mano.
  #draw() {
    if (!this.#canvas || !this.#enabled || !this.#camera.hasView()) return
    const canvas = this.#canvas
    const ctx    = this.#ctx
    const camera = this.#camera
    const size   = camera.size()
    const origin = camera.frameOrigin()
    const ratio  = window.devicePixelRatio || 1

    canvas.style.transform = frameTransform(origin.x, origin.y)
    if (this.#width !== size.x || this.#height !== size.y || this.#ratio !== ratio) {
      this.#width         = size.x
      this.#height        = size.y
      this.#ratio         = ratio
      canvas.style.width  = `${size.x}px`
      canvas.style.height = `${size.y}px`
      canvas.width        = Math.round(size.x * ratio)
      canvas.height       = Math.round(size.y * ratio)
    }
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    ctx.clearRect(0, 0, size.x, size.y)
    if (!this.#source) return

    const style = this.#style
    const view  = readView(camera, this.#view)
    const run   = this.#run
    const opts  = Object.assign(this.#opts, style)
    run.cx     = view.center.x
    run.cy     = view.center.y
    run.scale  = 2 ** view.zoom
    run.hw     = view.size.x / 2
    run.hh     = view.size.y / 2
    opts.viewW = view.size.x
    opts.viewH = view.size.y

    ctx.font         = style.font
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.lineJoin     = 'round'
    ctx.fillStyle    = style.color
    ctx.strokeStyle  = style.halo
    ctx.lineWidth    = style.haloWidth
    this.#source.getSnapshot().forEach(item => this.#drawItem(item, ratio))
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
  }

  #drawItem(item, ratio) {
    const raw = safe(this.#textOf, item, onTextError)
    if (raw == null || raw === '') return

    const { chars, widths, total } = this.#layout(String(raw))

    const ctx   = this.#ctx
    const run   = this.#run
    const out   = this.#out
    const halo  = this.#style.haloWidth > 0
    const g     = chars.length
    const viewW = this.#width
    const viewH = this.#height
    run.n     = 0
    run.count = 0
    foldRuns(this.#pathOf(item), projectRun, run)

    for (let p = 0; p < run.count; p++) {
      const at    = p * 6
      const parts = run.parts
      if (parts[at + 4] < -total || parts[at + 2] > viewW + total || parts[at + 5] < -total || parts[at + 3] > viewH + total) continue
      const placed = placeGlyphs(run.xy, run.cum, parts[at], parts[at + 1], widths, this.#opts, out)
      const buf    = out.buf
      for (let i = 0; i < placed; i++) {
        const cos = Math.cos(buf[3 * i + 2])
        const sin = Math.sin(buf[3 * i + 2])
        const ch  = chars[i % g]
        ctx.setTransform(ratio * cos, ratio * sin, -ratio * sin, ratio * cos, ratio * buf[3 * i], ratio * buf[3 * i + 1])
        halo && ctx.strokeText(ch, 0, 0)
        ctx.fillText(ch, 0, 0)
      }
    }
  }
}
