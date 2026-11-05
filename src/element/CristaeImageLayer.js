import { CristaeLayerElement } from './base.js'
import { makeAutoId } from './autoId.js'

// Lo que el handle recibe: el ciclo de Lit vuelve a entregar las props con que se montó, y comparar contra
// lo ya enviado evita que una URL repetida recargue la imagen.
const sourceOf = el => {
  const image = el.image || undefined
  return { image, url: image ? undefined : el.url, place: el.corners || el.bounds }
}

// <cristae-image-layer> — una imagen georreferenciada, por URL (`url`) o por nodo (`image`: un img, canvas,
// video o svg), sobre una caja (`bounds`) o sobre cuatro esquinas (`corners`, en el orden nw, ne, se, sw).
// Con los dos de un par, mandan `image` y `corners`. La fuente, la caja, la opacidad y la visibilidad
// cambian en vivo por el handle; `interactive`, `cross-origin` y `alt` se leen al montar. La carga sale
// como `cristae:load` y `cristae:error`.
export class CristaeImageLayer extends CristaeLayerElement {

  static cristaeSignature = { role: 'leaf', produces: ['image'] }

  static properties = {
    url         : {},
    image       : { attribute: false },
    bounds      : { type: Object },
    corners     : { attribute: false },
    opacity     : { type: Number },
    interactive : { type: Boolean },
    visible     : { type: Boolean },
    crossOrigin : { attribute: 'cross-origin' },
    alt         : {},
  }

  constructor() {
    super()
    this.opacity     = 1
    this.interactive = false
    this.visible     = true
  }

  layerId() { return this.id || (this._auto ??= makeAutoId('image')) }

  mountReady() { return !!((this.url || this.image) && (this.bounds || this.corners)) }

  mountLayer(engine) {
    const sent = this._sent = sourceOf(this)
    const emit = type => detail => this.dispatchEvent(new CustomEvent(`cristae:${type}`, { detail, bubbles: true, composed: true }))
    return engine.addImageLayer({
      id          : this.layerId(),
      ...this._placement,
      url         : sent.url,
      image       : sent.image,
      bounds      : this.corners ? undefined : this.bounds,
      corners     : this.corners || undefined,
      opacity     : this.opacity,
      interactive : this.interactive,
      visible     : this.visible,
      crossOrigin : this.crossOrigin,
      alt         : this.alt,
      onLoad      : emit('load'),
      onError     : emit('error'),
    })
  }

  syncLayer(changed) {
    const handle = this._handle
    const prev   = this._sent
    const next   = this._sent = sourceOf(this)
    if (next.image && next.image !== prev.image) handle.setImage(next.image)
    else if (next.url && (next.url !== prev.url || prev.image)) handle.setUrl(next.url)
    if (next.place && next.place !== prev.place) this.corners ? handle.setCorners(this.corners) : handle.setBounds(this.bounds)
    changed.has('opacity') && handle.setOpacity(this.opacity)
    changed.has('visible') && handle.setVisible(this.visible)
  }
}
