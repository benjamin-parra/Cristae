import { CristaeLayerElement } from './base.js'

let seq = 0

// <cristae-label-layer> — etiquetas canvas. Standalone (con `source`) o attachment
// (`bind-to="<id>"`: deriva posiciones + textOf del host, resuelto por nombre, orden-indep).
// `paint`/`style`/`textOf`/`accessors`/`source` son props. Como hija slot="bubble" de un
// cluster NO se auto-monta: el cluster la lee como configuración de burbuja.
export class CristaeLabelLayer extends CristaeLayerElement {

  static properties = {
    bindTo: { attribute: 'bind-to' },
    source: { type: Object },
    accessors: { type: Object },
    textOf: { attribute: false },
    paint: { attribute: false },
    style: { type: Object },
    visible: { type: Boolean },
  }

  constructor() {
    super()
    this.visible = true
  }

  layerId() { return this.id || (this._auto ??= `label-${++seq}`) }

  // Atada a un host (`bind-to`, atributo) o con Source propia. Sin ninguna, diferir el montaje.
  mountReady() { return !!(this.bindTo || this.source) }

  mountLayer(engine) {
    return engine.addLabelLayer({
      id: this.layerId(),
      bindTo: this.bindTo,
      source: this.source,
      accessors: this.accessors,
      textOf: this.textOf,
      paint: this.paint,
      style: this.style,
    })
  }

  syncLayer(changed) {
    if (changed.has('visible')) this._handle.setVisible(this.visible)
  }
}
