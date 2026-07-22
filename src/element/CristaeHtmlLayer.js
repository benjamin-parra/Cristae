import { CristaeLayerElement } from './base.js'

let seq = 0

// <cristae-html-layer> — marcadores HTML (L.divIcon) declarativos, GL-safe. accessors = { idOf,
// positionOf, htmlOf, classNameOf?, sizeOf?, anchorOf? }. Nicho: badges de dominio con contenido HTML
// arbitrario (heroicon / glifo de fuente / letra) + popup/tooltip, que el iconset canvas del
// point-layer no rinde. COMPLEMENTA el point-layer GPU (alta cardinalidad / tiempo real), no lo reemplaza.
export class CristaeHtmlLayer extends CristaeLayerElement {

  static cristaeSignature = { consumes: [], produces: ['html'], combine: null, arity: 'leaf' }

  static properties = {
    data: { type: Array },
    source: { attribute: false },
    accessors: { type: Object },
    interactive: { type: Boolean },
    visible: { type: Boolean },
  }

  constructor() {
    super()
    this.interactive = false
    this.visible     = true
  }

  layerId() { return this.id || (this._auto ??= `html-${++seq}`) }

  mountReady() { return !!(this.source || this.accessors) }

  mountLayer(engine) {
    return engine.addHtmlLayer({
      id: this.layerId(),
      source: this.source,
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
