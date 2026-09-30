import { withAlpha } from './color.js'
import { focusFactor } from './focus.js'
import { frameTransform } from './frame.js'
import { boundsContain, boundsPad } from '../geometry/bounds.js'

// LabelLayer — etiquetas de texto sobre un canvas montado en la superficie del mapa.
// Genérico: una sola capa, sin variantes de dominio.
// El glifo lo pinta un `paint(ctx, point, label, hovered)` inyectable; se incluye `drawLabel` por
// defecto. El label es opaco salvo {id, lat, lng, text}; el resto de campos los interpreta el painter.
// El painter es API: la caja del culling y el píxel `point` salen de la cámara, planos.
//
// El canvas redibuja en moveend/zoomend/resize y se OCULTA durante el zoom-anim (si no, las etiquetas
// se deslizan desfasadas del mapa). Culling por bounds + los hovered se dibujan encima.

const LABEL_PADDING_X = 10
const LABEL_HEIGHT = 22
const LABEL_OFFSET_Y = 22
const MAX_LABEL_WIDTH = 196
const ACCENT_WIDTH = 5
const FONT = '700 10.5px Inter, ui-sans-serif, system-ui, -apple-system, sans-serif'

const DEFAULT_STYLE = Object.freeze({
  surface: '#ffffff',
  text:    '#0f172a',
  accent:  '#2563eb',
})

export class LabelLayer {

  #camera
  #surface
  #pane
  #canvas
  #ctx
  #offView                                   // bajas del ciclo de vista
  #labels        = []
  #hovered       = new Set()
  #hoveredSource = null
  #focus         = { ids: null, dim: 0.3 }   // ids null = sin foco
  #paint
  #boundsPad
  #style
  #width         = 0
  #height        = 0
  #ratio         = 1
  // Oculta (setVisibility false): no pintar aunque la Source emita (WS a ~60fps). El guard evita el
  // O(n) fillText por frame en capas que el usuario no ve; setVisibility(true) repinta con lo actual.
  #enabled       = true

  // `pane` es el nombre del pane donde cuelga el canvas; su `z` lo pone quien lo configura.
  constructor({ host, pane, paint = drawLabel, boundsPad = 0.08, style = DEFAULT_STYLE } = {}) {
    const { camera, surface } = host
    const canvas              = document.createElement('canvas')
    canvas.className           = 'cristae-label-canvas'
    canvas.style.pointerEvents = 'none'

    this.#camera    = camera
    this.#surface   = surface
    this.#pane      = pane
    this.#paint     = paint
    this.#boundsPad = boundsPad
    this.#style     = style
    this.#canvas    = canvas
    this.#ctx       = canvas.getContext('2d', { alpha: true })
    surface.mount(pane).appendChild(canvas)
    this.#offView = [
      camera.on('zoomstart', () => this.#canvas.style.visibility = 'hidden'),
      camera.on('moveend zoomend resize', () => this.#redraw()),
      camera.on('zoomend', () => this.#canvas.style.visibility = ''),
    ]
    this.#redraw()
  }

  setLabels(labels) {
    this.#labels = labels
    this.#redraw()
  }

  // El set de hover comparte identidad con su fuente: misma ref → no-op (idempotencia barata).
  setHovered(ids) {
    if (this.#hoveredSource === ids) return
    this.#hoveredSource = ids
    this.#hovered.clear()
    ids.forEach(id => this.#hovered.add(id))
    this.#redraw()
  }

  set style(style) {
    this.#style = style
    this.#redraw()
  }

  // Cortar el pintado ADEMÁS de ocultar el pane: oculta, la capa seguiría corriendo fillText en cada
  // moveend/zoomend/emit. Al volver visible repinta con los labels actuales antes de que el pane
  // aparezca (sin flash viejo).
  setVisibility(visible) {
    this.#enabled = visible
    this.#redraw()
    this.#surface.setVisible(this.#pane, visible)
  }

  clear() {
    if (this.#labels.length === 0 && this.#hovered.size === 0) return
    this.#labels = []
    this.#hovered.clear()
    this.#hoveredSource = null
    this.#redraw()
  }

  destroy() {
    if (!this.#canvas) return
    this.#offView.forEach(off => off())
    this.#canvas.remove()
    this.#surface.unmount(this.#pane)
    this.#labels = []
    this.#hovered.clear()
    this.#canvas = this.#ctx = null
  }

  // Atenúa por ETIQUETA (globalAlpha del pintado), no con la opacidad del pane.
  applyFocus(ids, dim = this.#focus.dim) {
    this.#focus = { ids, dim }
    this.#redraw()
    return true
  }

  // Ancla el canvas al origen del contenedor —el pane lo traslada durante el paneo—, lo redimensiona sólo
  // si cambió el tamaño o el devicePixelRatio —asignar el ancho lo limpia— y pinta. Sin vista no hay caja
  // ni píxel que leer: un mapa adoptado que todavía no la tomó repinta en el `moveend` que la trae.
  #redraw() {
    if (!this.#canvas || !this.#enabled || !this.#camera.hasView()) return
    const camera   = this.#camera
    const canvas   = this.#canvas
    const ctx      = this.#ctx
    const size     = camera.size()
    const origin   = camera.frameOrigin()
    const ratio    = window.devicePixelRatio || 1
    const box      = boundsPad(camera.bounds(), this.#boundsPad)
    const elevated = []
    const paint    = (point, label, hovered) => {
      ctx.globalAlpha = focusFactor(this.#focus, label.id)
      this.#paint(ctx, point, label, hovered, this.#style)
    }

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
    prepareContext(ctx)
    this.#labels.forEach(label => {
      if (!boundsContain(box, label)) return
      const point = camera.toContainer(label)
      if (this.#hovered.has(label.id)) elevated.push({ point, label })
      else paint(point, label, false)
    })
    // Los hovered van al final → quedan por encima del resto.
    elevated.forEach(({ point, label }) => paint(point, label, true))
    ctx.globalAlpha = 1
  }
}

/* ── Painter por defecto ── */

const widthCache = new Map()                 // 'font|text' → ancho medido (memo de measureText)

const prepareContext = ctx => {
  const ratio = window.devicePixelRatio || 1
  ctx.clearRect(0, 0, ctx.canvas.width / ratio, ctx.canvas.height / ratio)
  ctx.font         = FONT
  ctx.textBaseline = 'middle'
}

const measure = (ctx, text) => {
  const key = `${ctx.font}|${text}`
  let w = widthCache.get(key)
  if (w === undefined) { w = ctx.measureText(text).width; widthCache.set(key, w) }
  return w
}

const roundedRect = (ctx, x, y, w, h, r) => {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

// Píldora redondeada: fondo de superficie, borde con tinte de acento y, si el label trae `accent`,
// una franja de acento a la izquierda. Texto recortado al ancho máximo. Genérico — sin dominio.
export const drawLabel = (ctx, point, label, hovered, style = DEFAULT_STYLE) => {
  const text = String(label.text)
  const accent = label.accent ?? style.accent
  const hasStripe = label.accent != null
  const lead = hasStripe ? ACCENT_WIDTH : 0
  const width = Math.min(MAX_LABEL_WIDTH, Math.ceil(measure(ctx, text) + LABEL_PADDING_X * 2 + lead))
  const x = Math.round(point.x - width / 2)
  const y = Math.round(point.y + LABEL_OFFSET_Y)
  const radius = LABEL_HEIGHT / 2

  ctx.save()
  roundedRect(ctx, x, y, width, LABEL_HEIGHT, radius)
  ctx.fillStyle   = style.surface
  ctx.strokeStyle = withAlpha(accent, hovered ? 0.9 : 0.35)
  ctx.lineWidth   = 1.15
  ctx.fill()
  ctx.stroke()

  if (hasStripe) {
    ctx.save()
    roundedRect(ctx, x + 1, y + 1, width - 2, LABEL_HEIGHT - 2, radius - 1)
    ctx.clip()
    ctx.fillStyle = accent
    ctx.fillRect(x + 1, y + 1, ACCENT_WIDTH, LABEL_HEIGHT - 2)
    ctx.restore()
  }

  const textX = x + LABEL_PADDING_X + lead
  ctx.beginPath()
  ctx.rect(textX, y, width - (textX - x) - LABEL_PADDING_X, LABEL_HEIGHT)
  ctx.clip()
  ctx.fillStyle = style.text
  ctx.fillText(text, textX, y + LABEL_HEIGHT / 2)
  ctx.restore()
}
