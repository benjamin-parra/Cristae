import { CristaeLayerElement } from './base.js'
import { makeAutoId } from './autoId.js'

// Base de los editores de geometría; la forma la fija la subclase (`static kind`). Ver docs/editing.md.
export class CristaeEditable extends CristaeLayerElement {

  static properties = {
    mode          : {},
    value         : { attribute: false },
    geometryStyle : { attribute: false },
  }

  _eco = null                       // último valor que cruzó el límite; reingerirlo soltaría el gesto

  constructor() {
    super()
    this.mode = 'edit'
  }

  layerId() { return this.id || (this._auto ??= makeAutoId(this.constructor.kind)) }

  mountLayer(engine) {
    this._eco = this.value
    return engine.addEditableLayer({
      id: this.layerId(),
      ...this._placement,
      kind     : this.constructor.kind,
      mode     : this.mode,
      value    : this.value,
      style    : this.geometryStyle,
      onChange : leer => this._emit('change', leer),
      onCommit : leer => this._emit('commit', leer),
    })
  }

  syncLayer(changed) {
    if (changed.has('value') && this.value !== this._eco) {
      this._eco = this.value
      this._handle.setValue(this.value)
    }
    changed.has('mode') && this._handle.setMode(this.mode)
    changed.has('geometryStyle') && this.geometryStyle && this._handle.setStyle(this.geometryStyle)
  }

  // Leerlo fija el eco: quien no lo leyó no puede devolverlo.
  _emit(type, leer) {
    const el = this
    let leido = false
    let valor
    const detail = {
      get value() {
        leido || ((leido = true), (valor = el._eco = leer()))
        return valor
      },
    }
    this.dispatchEvent(new CustomEvent(`cristae:${type}`, { detail, bubbles: true, composed: true }))
  }
}
