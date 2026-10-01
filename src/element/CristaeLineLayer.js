import { CristaeLayerElement } from './base.js'
import { makeAutoId } from './autoId.js'

// <cristae-line-layer> — capa de líneas GL declarativa. Como point-layer, dos entradas de dato:
// `data` (array → el elemento posee la Source interna) y `source` (Source compartida del consumidor,
// createSource/defineSource). `accessors` = { idOf, pathOf, styleOf?, scalarOf?, colorRamp?, hashOf? } se
// asigna por JS (funciones, no atributos). `backend` elige el sustrato al montar (`glify` o `gpu`); el
// grosor por brocha de glify y la ausencia de dash en ese backend son deuda documentada (ver docs/lines.md).
export class CristaeLineLayer extends CristaeLayerElement {

  // Gramática de composición: entidad hoja que produce `line`.
  static cristaeSignature = { consumes: [], produces: ['line'], combine: null, arity: 'leaf' }

  static properties = {
    data: { type: Array },
    source: { attribute: false },
    accessors: { type: Object },
    interactive: { type: Boolean },
    visible: { type: Boolean },
    backend: { type: String },          // sin declarar, el default del motor
  }

  constructor() {
    super()
    this.interactive = false
    this.visible     = true
  }

  layerId() { return this.id || (this._auto ??= makeAutoId('line')) }

  mountReady() { return !!(this.source || this.accessors) }

  mountLayer(engine) {
    return engine.addLineLayer({
      id: this.layerId(),
      ...this._placement,
      source: this.source,
      data: this.data,
      accessors: this.accessors,
      interactive: this.interactive,
      visible: this.visible,
      backend: this.backend,
    })
  }

  syncLayer(changed) {
    if (changed.has('data') && this.data) this._handle.set(this.data)
    if (changed.has('visible')) this._handle.setVisible(this.visible)
  }
}
