import { CristaeLayerElement } from './base.js'
import { makeAutoId } from './autoId.js'
import { STYLE_PROPERTIES, styleConfig, syncStyle } from './layerStyle.js'

// <cristae-polygon-layer> — polígonos para display + hit-testing por índice geométrico
// (geometry/polygon.js, O(log n + k)). Tres entradas de dato: `data` (array plano → el elemento posee
// la Source interna), `source` (una Source que el consumidor posee y comparte entre vistas; ver
// createSource) y `geometry` (las tablas del lector — `areasOf(readGeoJson(bytes))` — sin materializar
// un array; la identidad viaja con ellas). Los accessors =
// { idOf, ringsOf, styleOf?, hashOf? }: con `source` viajan con ella, por `data` se asignan aparte, y con
// `geometry` sólo hacen falta para pisar el `idOf`/`styleOf` que el default resuelve solo.
//
// Relleno por stencil y contorno en una textura: un contexto WebGL por capa. `source` se lee al montar:
// cambiarla en caliente no remonta la capa. El estilo de capa lo pisa `styleOf` por polígono.
export class CristaePolygonLayer extends CristaeLayerElement {

  // Gramática de composición: entidad hoja que produce `polygon`.
  static cristaeSignature = { consumes: [], produces: ['polygon'], combine: null, arity: 'leaf' }

  static properties = {
    data       : { type: Array },
    source     : { attribute: false },           // Source compartida (createSource/defineSource)
    geometry   : { attribute: false },           // tablas tipadas del lector (areasOf)
    accessors  : { type: Object },
    interactive: { type: Boolean },
    visible    : { type: Boolean },
    ...STYLE_PROPERTIES,
  }

  constructor() {
    super()
    this.interactive = true
    this.visible     = true
  }

  layerId() { return this.id || (this._auto ??= makeAutoId('polygon')) }

  // Necesita geometría tipada, una Source (que ya trae accessors) o accessors propios (ruta `data`).
  mountReady() { return !!(this.geometry || this.source || this.accessors) }

  mountLayer(engine) {
    return engine.addPolygonLayer({
      id         : this.layerId(),
      ...this._placement,
      geometry   : this.geometry,                // tablas tipadas: sin Source que mutar
      source     : this.source,                  // si está, gana sobre `data` (el motor hace cfg.source ?? owned)
      data       : this.data,
      accessors  : this.accessors,
      interactive: this.interactive,
      visible    : this.visible,
      ...styleConfig(this),
    })
  }

  syncLayer(changed) {
    if (changed.has('data') && this.data) this._handle.set(this.data)
    if (changed.has('visible')) this._handle.setVisible(this.visible)
    syncStyle(this, changed)
  }
}
