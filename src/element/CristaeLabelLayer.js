import { CristaeLayerElement } from './base.js'
import { makeAutoId } from './autoId.js'

// Se retira en 1.0: se avisa una vez por página, al montarse como capa.
let retirementWarned = false

// <cristae-label-layer> — etiquetas canvas. Standalone (con `source`) o attachment
// (`bind-to="<id>"`: deriva posiciones + textOf del host, resuelto por nombre, orden-indep).
// `paint`/`style`/`textOf`/`accessors`/`source` son props. Como hija slot="bubble" de un
// cluster NO se auto-monta: el cluster la lee como configuración de burbuja.
// Se retira en 1.0: la reemplaza <cristae-labeled> sobre la capa de puntos (docs/labeled.md).
export class CristaeLabelLayer extends CristaeLayerElement {

  // Gramática de composición: entidad hoja que produce `label`, ligada a un `point`.
  static cristaeSignature = { consumes: [], produces: ['label'], combine: null, arity: 'leaf', bindsTo: 'point' }

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

  layerId() { return this.id || (this._auto ??= makeAutoId('label')) }

  // Atada a un host (`bind-to`, atributo) o con Source propia. Sin ninguna, diferir el montaje.
  mountReady() { return !!(this.bindTo || this.source) }

  mountLayer(engine) {
    retirementWarned || console.warn('[cristae-label-layer] se retira en 1.0: la reemplaza <cristae-labeled> sobre la ' +
      'capa de puntos (docs/labeled.md).')
    retirementWarned = true
    const handle = engine.addLabelLayer({
      id:        this.layerId(),
      ...this._placement,
      bindTo:    this.bindTo,
      source:    this.source,
      accessors: this.accessors,
      textOf:    this.textOf,
      paint:     this.paint,
      style:     this.style,
      visible:   this.visible,
    })
    // El alta del motor SIEMPRE nace visible (ignora `visible` de cfg). Si la capa se declaró oculta,
    // lo honramos por el handle en el propio montaje —no sólo ante un CAMBIO posterior de la prop— así
    // una label montada con visible=false no parpadea encendida ni queda desincronizada del toggle.
    if (!this.visible) handle.setVisible(false)
    return handle
  }

  syncLayer(changed) {
    if (changed.has('visible')) this._handle.setVisible(this.visible)
  }
}
