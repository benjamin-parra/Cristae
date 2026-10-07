import { CristaeLayerElement } from './base.js'
import { makeAutoId } from './autoId.js'
import { STYLE_PROPERTIES, styleConfig, syncStyle } from './layerStyle.js'

// <cristae-shape-layer> — círculos, elipses y sectores en METROS, dibujados en GPU (docs/shapes.md).
// `source` se lee al montar: reasignarla no remonta la capa. Por la ruta `source` los accessors viajan
// con la Source.
// El estilo de capa es el de los polígonos, y `styleOf` lo pisa por forma.
export class CristaeShapeLayer extends CristaeLayerElement {

  // Gramática de composición: entidad hoja que produce `shape`.
  static cristaeSignature = { consumes: [], produces: ['shape'], combine: null, arity: 'leaf' }

  static properties = {
    data       : { type: Array },
    source     : { attribute: false },           // Source compartida (createSource/defineSource)
    accessors  : { type: Object },
    interactive: { type: Boolean },
    visible    : { type: Boolean },
    ...STYLE_PROPERTIES,
  }

  constructor() {
    super()
    this.interactive = true
    this.visible     = true
  }

  layerId() { return this.id || (this._auto ??= makeAutoId('shape')) }

  mountReady() { return !!(this.source || this.accessors) }

  mountLayer(engine) {
    return engine.addShapeLayer({
      id         : this.layerId(),
      ...this._placement,
      source     : this.source,                  // si está, gana sobre `data`
      data       : this.data,
      accessors  : this.accessors,
      interactive: this.interactive,
      visible    : this.visible,
      ...styleConfig(this),
    })
  }

  syncLayer(changed) {
    if (changed.has('data') && this.data) this._handle.set(this.data)
    if (changed.has('visible')) this._handle.setVisible(this.visible)
    syncStyle(this, changed)
  }
}
