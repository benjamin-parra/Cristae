import { CristaeLayerElement } from './base.js'
import { makeAutoId } from './autoId.js'

// <cristae-polygon-layer> — polígonos para display + hit-testing por índice geométrico
// (geometry/polygon.js, O(log n + k)). Dos entradas de dato simétricas con la capa de puntos: `data`
// (array plano → el elemento posee la Source interna) y `source` (una Source que el consumidor posee
// y comparte entre vistas; ver createSource). Los accessors = { idOf, ringsOf, styleOf? }: con
// `source` viajan con ella, por `data` se asignan aparte.
//
// `backend` elige el sustrato: `leaflet` (un `L.polygon` por figura) o `gpu` (relleno por stencil y
// contorno en una textura). Los dos consumen el MISMO Source y contestan el mismo picking. `backend`
// y `source` se leen al montar: cambiarlos en caliente no remonta la capa.
export class CristaePolygonLayer extends CristaeLayerElement {

  // Gramática de composición: entidad hoja que produce `polygon`.
  static cristaeSignature = { consumes: [], produces: ['polygon'], combine: null, arity: 'leaf' }

  static properties = {
    data       : { type: Array },
    source     : { attribute: false },           // Source compartida (createSource/defineSource)
    accessors  : { type: Object },
    interactive: { type: Boolean },
    visible    : { type: Boolean },
    backend    : { type: String },
  }

  constructor() {
    super()
    this.interactive = true
    this.visible     = true
    this.backend     = 'leaflet'
  }

  layerId() { return this.id || (this._auto ??= makeAutoId('polygon')) }

  // Necesita una Source (que ya trae accessors) o accessors propios (ruta `data`). Sin eso, diferir.
  mountReady() { return !!(this.source || this.accessors) }

  mountLayer(engine) {
    return engine.addPolygonLayer({
      id         : this.layerId(),
      ...this._placement,
      source     : this.source,                  // si está, gana sobre `data` (el motor hace cfg.source ?? owned)
      data       : this.data,
      accessors  : this.accessors,
      interactive: this.interactive,
      visible    : this.visible,
      backend    : this.backend,
    })
  }

  syncLayer(changed) {
    if (changed.has('data') && this.data) this._handle.set(this.data)
    if (changed.has('visible')) this._handle.setVisible(this.visible)
  }
}
