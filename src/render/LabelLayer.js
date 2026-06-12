import L from 'leaflet'

// LabelLayer — etiquetas de texto sobre un canvas overlay (port unificado de ConstantLabelLayer).
// Genérico: una sola capa, sin las tres variantes de dominio (vehicle/place/search) del original.
// El glifo lo pinta un `paint(ctx, point, label, hovered)` inyectable; se incluye `drawLabel` por
// defecto. El label es opaco salvo {id, lat, lng, text}; el resto de campos los interpreta el painter.
//
// El overlay redibuja en moveend/zoomend/resize y se OCULTA durante el zoom-anim (si no, las
// etiquetas se deslizan desfasadas del mapa). Culling por bounds + los hovered se dibujan encima.

const LABEL_PADDING_X = 10
const LABEL_HEIGHT = 22
const LABEL_OFFSET_Y = 22
const MAX_LABEL_WIDTH = 196
const ACCENT_WIDTH = 5
const FONT = '700 10.5px Inter, ui-sans-serif, system-ui, -apple-system, sans-serif'

const DEFAULT_STYLE = Object.freeze({
  surface: '#ffffff',
  text: '#0f172a',
  accent: '#2563eb',
})

// El lienzo: una L.Layer mínima que delega el pintado y mantiene el canvas alineado y nítido (DPR).
class CanvasOverlay extends L.Layer {

  #canvas = null
  #ctx = null
  #paint
  #width = 0
  #height = 0
  #ratio = 1

  constructor(paint) {
    super()
    this.#paint = paint
  }

  onAdd(map) {
    this._map = map
    this.#canvas = L.DomUtil.create('canvas', 'cristae-label-canvas')
    this.#ctx = this.#canvas.getContext('2d', { alpha: true })
    this.getPane().appendChild(this.#canvas)
    map.on('zoomstart', this.#hide, this)
    map.on('moveend zoomend resize', this.requestRedraw, this)
    map.on('zoomend', this.#show, this)
    this.requestRedraw()
    return this
  }

  onRemove(map) {
    map.off('zoomstart', this.#hide, this)
    map.off('moveend zoomend resize', this.requestRedraw, this)
    map.off('zoomend', this.#show, this)
    L.DomUtil.remove(this.#canvas)
    this.#canvas = null
    this.#ctx = null
    this._map = null
  }

  requestRedraw() {
    if (!this._map) return
    this.#resize()
    this.#paint(this.#ctx, this._map)
  }

  #hide() { this.#canvas.style.visibility = 'hidden' }
  #show() { this.#canvas.style.visibility = '' }

  #resize() {
    const size = this._map.getSize()
    const ratio = window.devicePixelRatio || 1
    L.DomUtil.setPosition(this.#canvas, this._map.containerPointToLayerPoint([0, 0]))

    if (this.#width !== size.x || this.#height !== size.y || this.#ratio !== ratio) {
      this.#width = size.x
      this.#height = size.y
      this.#ratio = ratio
      this.#canvas.style.width = `${size.x}px`
      this.#canvas.style.height = `${size.y}px`
      this.#canvas.width = Math.round(size.x * ratio)
      this.#canvas.height = Math.round(size.y * ratio)
    }
    this.#ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
  }
}

export class LabelLayer {

  #map
  #overlay
  #pane
  #labels = []
  #hovered = new Set()
  #hoveredSource = null
  #paint
  #boundsPad
  #style

  constructor({ map, pane, paint = drawLabel, boundsPad = 0.08, style = DEFAULT_STYLE } = {}) {
    this.#map = map
    this.#pane = pane.name
    this.#paint = paint
    this.#boundsPad = boundsPad
    this.#style = style
    this.#ensurePane(pane)
    this.#overlay = new CanvasOverlay((ctx, leaflet) => this.#render(ctx, leaflet))
    this.#overlay.options.pane = pane.name
    this.#overlay.addTo(map)
  }

  setLabels(labels) {
    this.#labels = labels
    this.#overlay.requestRedraw()
  }

  // El set de hover comparte identidad con su fuente: misma ref → no-op (idempotencia barata).
  setHovered(ids) {
    if (this.#hoveredSource === ids) return
    this.#hoveredSource = ids
    this.#hovered.clear()
    ids.forEach(id => this.#hovered.add(id))
    this.#overlay.requestRedraw()
  }

  set style(style) {
    this.#style = style
    this.#overlay.requestRedraw()
  }

  setVisibility(visible) {
    const pane = this.#map.getPane(this.#pane)
    pane.style.setProperty('visibility', visible ? '' : 'hidden')
    pane.style.setProperty('pointer-events', 'none')
  }

  clear() {
    if (this.#labels.length === 0 && this.#hovered.size === 0) return
    this.#labels = []
    this.#hovered.clear()
    this.#hoveredSource = null
    this.#overlay.requestRedraw()
  }

  destroy() {
    this.#labels = []
    this.#hovered.clear()
    this.#overlay.remove()
  }

  #ensurePane({ name, zIndex }) {
    const pane = this.#map.getPane(name) ?? this.#map.createPane(name)
    pane.style.zIndex = String(zIndex)
    pane.style.pointerEvents = 'none'
  }

  #render(ctx, leaflet) {
    prepareContext(ctx)
    const bounds = leaflet.getBounds().pad(this.#boundsPad)
    const elevated = []

    this.#labels.forEach(label => {
      if (!bounds.contains([label.lat, label.lng])) return
      const point = leaflet.latLngToContainerPoint([label.lat, label.lng])
      if (this.#hovered.has(label.id)) elevated.push({ point, label })
      else this.#paint(ctx, point, label, false, this.#style)
    })
    // Los hovered van al final → quedan por encima del resto.
    elevated.forEach(({ point, label }) => this.#paint(ctx, point, label, true, this.#style))
  }
}

/* ── Painter por defecto ── */

const widthCache = new Map()                 // 'font|text' → ancho medido (memo de measureText)

const prepareContext = (ctx) => {
  const ratio = window.devicePixelRatio || 1
  ctx.clearRect(0, 0, ctx.canvas.width / ratio, ctx.canvas.height / ratio)
  ctx.font = FONT
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

const withAlpha = (color, alpha) => {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return color
  const n = parseInt(color.slice(1), 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
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
  ctx.fillStyle = style.surface
  ctx.strokeStyle = withAlpha(accent, hovered ? 0.9 : 0.35)
  ctx.lineWidth = 1.15
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
