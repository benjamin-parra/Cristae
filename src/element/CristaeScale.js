import { LitElement, html, css, nothing } from 'lit'
import { byDefault, distance } from '../geometry/geodesic.js'

// <cristae-scale> — la escala gráfica, el equivalente de `L.control.scale`. Es UI pura, como la barra de
// herramientas: va en una zona de <cristae-map> por `slot` y lee la cámara pública del mapa vivo, nunca una
// copia, así que sobrevive a un re-montaje (SPECS §7.3).

const UNITS          = ['metric', 'imperial']
const FEET_PER_METER = 3.2808399
const FEET_PER_MILE  = 5280

// `digit`·10ⁿ. Con n negativo divide: 5 / 100 es el double más cercano a 0,05, y 5 · 0,01 no siempre.
const decimal = (digit, n) => n < 0 ? digit / 10 ** -n : digit * 10 ** n

// El mayor {1, 2, 3, 5}·10ⁿ que no pasa de `num`, como `_getRoundNum` de Leaflet salvo bajo 1, donde
// Leaflet sube a 1 y la barra pasa de `maxWidth`. El exponente se corrige porque `log10` puede errar por
// un ulp justo en una potencia de 10.
const roundNum = num => {
  const exp = Math.floor(Math.log10(num))
  const n   = exp + (decimal(1, exp + 1) <= num) - (decimal(1, exp) > num)
  const d   = num / decimal(1, n)
  return decimal(d >= 5 ? 5 : d >= 3 ? 3 : d >= 2 ? 2 : 1, n)
}

// La barra de una unidad para `meters` medidos a lo largo de `maxWidth` px: el rótulo redondo y su ancho,
// sin redondear a px para que la barra mida exactamente lo que dice. Desde 1000 m pasa a km, y desde una
// milla, a mi. Se exporta para el test: el entry no la re-exporta.
export const scaleBar = (meters, maxWidth, unit) => {
  const imperial = unit === 'imperial'
  const base     = imperial ? meters * FEET_PER_METER : meters
  const per      = imperial ? FEET_PER_MILE : 1000
  const large    = base >= per
  const amount   = large ? base / per : base
  const value    = roundNum(amount)
  return { label: `${value} ${imperial ? large ? 'mi' : 'ft' : large ? 'km' : 'm'}`, width: maxWidth * value / amount }
}

export class CristaeScale extends LitElement {

  static properties = {
    units    : { type: String },                         // tokens: metric (default), imperial
    maxWidth : { type: Number, attribute: 'max-width' },
    _bars    : { state: true },
  }

  #map     = null
  #engine  = null
  #offMove = null
  #raf     = 0

  #schedule = () => this.#raf ||= requestAnimationFrame(this.#measure)
  #onReady  = () => {
    this.#bindMove()
    this.#schedule()
  }

  // La fila central del contenedor: su alto sale de dónde cae el centro, sin leer el layout. Un contenedor
  // de alto 0 no da barra, y la recupera el `viewportchange` que trae su tamaño.
  #measure = () => {
    this.#raf = 0
    const camera   = this.#map?.camera
    const y        = camera?.latLngToContainerPoint(camera.getCenter()).y
    const maxWidth = Number.isFinite(this.maxWidth) && this.maxWidth > 0 ? this.maxWidth : 100
    const meters   = y > 0
      ? distance(this.#map.model ?? byDefault, camera.containerPointToLatLng({ x: 0, y }), camera.containerPointToLatLng({ x: maxWidth, y }))
      : NaN
    const tokens   = String(this.units ?? '').split(/\s+/)
    const units    = UNITS.filter(unit => tokens.includes(unit))
    this._bars = meters > 0 ? (units.length ? units : ['metric']).map(unit => ({ unit, ...scaleBar(meters, maxWidth, unit) })) : []
  }

  constructor() {
    super()
    this._bars = []
  }

  connectedCallback() {
    super.connectedCallback()
    this.#map = this.closest('cristae-map')
    if (!this.#map) return
    this.#map.addEventListener('cristae:viewportchange', this.#schedule)
    this.#map.addEventListener('cristae:ready', this.#onReady)
    this.#onReady()
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    this.#map?.removeEventListener('cristae:viewportchange', this.#schedule)
    this.#map?.removeEventListener('cristae:ready', this.#onReady)
    this.#offMove?.()
    cancelAnimationFrame(this.#raf)
    this.#map = this.#engine = this.#offMove = null
    this.#raf = 0
  }

  willUpdate(changed) {
    ;(changed.has('units') || changed.has('maxWidth')) && this.#map && this.#schedule()
  }

  // El `move` del motor sigue el paneo en continuo; `viewportchange` llega sólo al asentarse. Se re-engancha
  // en cada `cristae:ready`, porque un re-montaje trae otro motor.
  #bindMove() {
    const engine = this.#map.engine
    if (!engine || engine === this.#engine) return
    this.#offMove?.()
    this.#engine  = engine
    this.#offMove = engine.on('move', this.#schedule)
  }

  render() {
    return this._bars.length ? html`<div part="scale">${this._bars.map(({ unit, label, width }) => html`
      <div class="bar" part="scale-${unit}" role="img" aria-label=${label} style="width: ${width}px">${label}</div>`)}</div>` : nothing
  }

  // El aspecto de la escala de Leaflet: borde de 2 px sin el de arriba, y fondo blanco translúcido. La
  // segunda barra invierte el borde, como allá. No toma el puntero: el arrastre pasa al mapa.
  static styles = css`
    :host { display: block; pointer-events: none; }
    .bar {
      box-sizing: border-box;
      border: 2px solid #777;
      border-top: none;
      padding: 2px 5px 1px;
      background: rgba(255, 255, 255, 0.8);
      color: #333;
      font: 11px/1.1 ui-sans-serif, system-ui, sans-serif;
      white-space: nowrap;
      text-shadow: 1px 1px #fff;
    }
    .bar + .bar { border-top: 2px solid #777; border-bottom: none; margin-top: -2px; }
  `
}
