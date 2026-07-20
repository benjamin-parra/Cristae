import { CristaeLayerElement } from './base.js'

let seq = 0

// <cristae-line-layer> — capa de líneas GL declarativa. Como point-layer, dos entradas de dato:
// `data` (array → el elemento posee la Source interna) y `source` (Source compartida del consumidor,
// createSource/defineSource). `accessors` = { idOf, pathOf, styleOf?, scalarOf?, colorRamp? } se
// asigna por JS (funciones, no atributos). El grosor por brocha de glify y la ausencia de dash en el
// backend GL son deuda documentada (ver docs/lines.md).
export class CristaeLineLayer extends CristaeLayerElement {

  // Gramática de composición: entidad hoja que produce `line`.
  static cristaeSignature = { consumes: [], produces: ['line'], combine: null, arity: 'leaf' }

  static properties = {
    data: { type: Array },
    source: { attribute: false },
    accessors: { type: Object },
    interactive: { type: Boolean },
    visible: { type: Boolean },
    vector: { type: Boolean },          // backend Leaflet (DASH, reproyecta solo) en vez de GL
  }

  constructor() {
    super()
    this.interactive = false
    this.visible = true
    this.vector = false
  }

  layerId() { return this.id || (this._auto ??= `line-${++seq}`) }

  mountReady() { return !!(this.source || this.accessors) }

  mountLayer(engine) {
    return engine.addLineLayer({
      id: this.layerId(),
      source: this.source,
      data: this.data,
      accessors: this.accessors,
      interactive: this.interactive,
      visible: this.visible,
      vector: this.vector,
    })
  }

  syncLayer(changed) {
    if (changed.has('data') && this.data) this._handle.set(this.data)
    if (changed.has('visible')) this._handle.setVisible(this.visible)
  }
}
