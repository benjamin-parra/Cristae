import { CristaeLayerElement } from './base.js'
import { makeAutoId } from './autoId.js'

// <cristae-polygon-layer> — polígonos para display + hit-testing por índice geométrico
// (geometry/polygon.js, O(log n + k)). `accessors` = { idOf, ringsOf, styleOf? }.
//
// `backend` elige el sustrato: `leaflet` (un `L.polygon` por figura) o `gpu` (relleno por stencil y
// contorno en una textura). Los dos consumen el MISMO Source y contestan el mismo picking; se lee al
// montar, así que cambiarlo en caliente no remonta la capa.
export class CristaePolygonLayer extends CristaeLayerElement {

  // Gramática de composición: entidad hoja que produce `polygon`.
  static cristaeSignature = { consumes: [], produces: ['polygon'], combine: null, arity: 'leaf' }

  static properties = {
    data: { type: Array },
    accessors: { type: Object },
    interactive: { type: Boolean },
    visible: { type: Boolean },
    backend: { type: String },
  }

  constructor() {
    super()
    this.interactive = true
    this.visible     = true
    this.backend     = 'leaflet'
  }

  layerId() { return this.id || (this._auto ??= makeAutoId('polygon')) }

  mountReady() { return !!this.accessors }       // { idOf, ringsOf, styleOf? } se asigna por JS

  mountLayer(engine) {
    return engine.addPolygonLayer({
      id: this.layerId(),
      ...this._placement,
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
