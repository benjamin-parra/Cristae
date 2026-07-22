import { CristaeLayerElement } from './base.js'

let seq = 0

// <cristae-polygon-layer> — polígonos Leaflet para display + hit-testing por índice geométrico
// (geometry/polygon.js, O(log n + k)). `accessors` = { idOf, ringsOf, styleOf? }.
export class CristaePolygonLayer extends CristaeLayerElement {

  // Gramática de composición: entidad hoja que produce `polygon`.
  static cristaeSignature = { consumes: [], produces: ['polygon'], combine: null, arity: 'leaf' }

  static properties = {
    data: { type: Array },
    accessors: { type: Object },
    interactive: { type: Boolean },
    visible: { type: Boolean },
  }

  constructor() {
    super()
    this.interactive = true
    this.visible     = true
  }

  layerId() { return this.id || (this._auto ??= `polygon-${++seq}`) }

  mountReady() { return !!this.accessors }       // { idOf, ringsOf, styleOf? } se asigna por JS

  mountLayer(engine) {
    return engine.addPolygonLayer({
      id: this.layerId(),
      data: this.data,
      accessors: this.accessors,
      interactive: this.interactive,
      visible: this.visible,
    })
  }

  syncLayer(changed) {
    if (changed.has('data') && this.data) this._handle.set(this.data)
    if (changed.has('visible')) this._handle.setVisible(this.visible)
  }
}
