import { CristaeLayerElement } from './base.js'
import { makeAutoId } from './autoId.js'

// Las claves del estilo que también llegan por atributo. Un atributo quitado vale null, y null devuelve
// la clave a su valor por defecto.
const STYLE_KEYS = ['placement', 'repeat', 'offset', 'orientation', 'maxAngle']

const styleOf = el => {
  const style = { ...el.style }
  STYLE_KEYS.forEach(key => el[key] !== undefined && (style[key] = el[key]))
  return style
}

// <cristae-line-label-layer> — texto que sigue el trazo de una línea (docs/line-labels.md). Ligada a una
// capa de líneas (`bind-to`) o con Source propia. `textOf`, `source` y `accessors` se leen al montar; el
// estilo cambia en vivo por `handle.style`, con los atributos mezclados sobre la prop `style`.
export class CristaeLineLabelLayer extends CristaeLayerElement {

  // Gramática de composición: entidad hoja que produce `label`, ligada a una `line`.
  static cristaeSignature = { consumes: [], produces: ['label'], combine: null, arity: 'leaf', bindsTo: 'line' }

  static properties = {
    bindTo      : { attribute: 'bind-to' },
    source      : { attribute: false },
    accessors   : { type: Object },
    textOf      : { attribute: false },
    style       : { attribute: false },
    placement   : {},
    repeat      : { type: Number },
    offset      : { type: Number },
    orientation : {},
    maxAngle    : { attribute: 'max-angle', type: Number },
    visible     : { type: Boolean },
  }

  constructor() {
    super()
    this.visible = true
  }

  layerId() { return this.id || (this._auto ??= makeAutoId('line-label')) }

  mountReady() { return !!(this.bindTo || this.source) }

  mountLayer(engine) {
    return engine.addLineLabelLayer({
      id        : this.layerId(),
      ...this._placement,
      bindTo    : this.bindTo,
      source    : this.source,
      accessors : this.accessors,
      textOf    : this.textOf,
      style     : styleOf(this),
      visible   : this.visible,
    })
  }

  syncLayer(changed) {
    changed.has('visible') && this._handle.setVisible(this.visible)
    ;(changed.has('style') || STYLE_KEYS.some(key => changed.has(key))) && this._handle.style(styleOf(this))
  }
}
