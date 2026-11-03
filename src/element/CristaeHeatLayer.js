import { CristaeLayerElement } from './base.js'
import { makeAutoId } from './autoId.js'

// Prop del elemento → setter del handle de `addHeatLayer`. Todas se aplican en vivo, sin remontar.
const LIVE = {
  visible   : 'setVisible',
  radius    : 'setRadius',
  blur      : 'setBlur',
  intensity : 'setIntensity',
  colorRamp : 'setColorRamp',
}

// <cristae-heat-layer> — campo de calor en canvas 2D (docs/heat.md). `source` y `accessors` se leen al
// montar. `colorRamp` se compara por referencia: una función nueva por render re-muestrea la paleta.
export class CristaeHeatLayer extends CristaeLayerElement {

  // Gramática de composición: entidad hoja que produce `heat`, que ningún modificador consume.
  static cristaeSignature = { consumes: [], produces: ['heat'], combine: null, arity: 'leaf' }

  static properties = {
    data      : { type: Array },
    source    : { attribute: false },
    accessors : { type: Object },
    colorRamp : { attribute: false },
    radius    : { type: Number },
    blur      : { type: Number },
    intensity : { type: Number },
    visible   : { type: Boolean },
  }

  constructor() {
    super()
    this.visible = true
  }

  layerId() { return this.id || (this._auto ??= makeAutoId('heat')) }

  mountReady() { return !!(this.source || this.accessors) }

  mountLayer(engine) {
    return engine.addHeatLayer({
      id        : this.layerId(),
      ...this._placement,
      source    : this.source,
      data      : this.data,
      accessors : this.accessors,
      visible   : this.visible,
      radius    : this.radius,
      blur      : this.blur,
      intensity : this.intensity,
      colorRamp : this.colorRamp,
    })
  }

  syncLayer(changed) {
    changed.has('data') && this.data && this._handle.set(this.data)
    Object.entries(LIVE).forEach(([prop, setter]) => changed.has(prop) && this._handle[setter](this[prop]))
  }
}
