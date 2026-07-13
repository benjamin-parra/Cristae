import { CristaeLayerElement } from './base.js'

let seq = 0

// <cristae-point-layer> — capa de puntos GL declarativa. Dos entradas de dato simétricas:
// `data` (array plano → el elemento posee la Source interna) y `source` (una Source que el
// consumidor posee y comparte entre vistas; ver createSource). `accessors`/`iconSet`/`filters`/
// `source` son props (objetos/funciones, no atributos); `interactive`/`visible`/`enabled`/
// `icon-set` (nombre) pueden ir como atributos. Reenvía cambios de `source`/`data`/`visible`/
// `enabled` al motor.
export class CristaePointLayer extends CristaeLayerElement {

  // Gramática de composición: entidad hoja que produce `point`.
  static cristaeSignature = { consumes: [], produces: ['point'], combine: null, arity: 'leaf' }

  static properties = {
    data: { type: Array },
    source: { attribute: false },                // Source compartida (createSource/defineSource)
    accessors: { type: Object },
    iconSet: { attribute: 'icon-set' },          // string (nombre registrado) u objeto IconSet
    filters: { type: Array },
    where: { attribute: false },                 // (item) => boolean: membresía por-capa (filtra qué entra a ESTA capa sin tocar la Source compartida)
    interactive: { type: Boolean },
    visible: { type: Boolean },
    enabled: { type: Boolean },                  // membresía de la ENTIDAD en la composición (default true): off → aporta ∅ a los modificadores (cluster), pane + ligados ocultos
    autoFit: { attribute: 'auto-fit' },          // "once": encuadra la capa al llegar los primeros puntos
  }

  #autoFitUnsub = null

  constructor() {
    super()
    this.interactive = false
    this.visible = true
    this.enabled = true
  }

  layerId() { return this.id || (this._auto ??= `point-${++seq}`) }

  // Necesita una Source (que ya trae accessors) o accessors propios (ruta `data`). Sin eso, diferir.
  mountReady() { return !!(this.source || this.accessors) }

  mountLayer(engine) {
    const handle = engine.addPointLayer({
      id: this.layerId(),
      source: this.source,                       // si está, gana sobre `data` (el motor hace cfg.source ?? owned)
      data: this.data,
      accessors: this.accessors,
      iconSet: this.iconSet,
      filters: this.filters,
      where: this.where,                         // membresía por-capa (filtra la Source compartida sin mutarla)
      interactive: this.interactive,
      visible: this.visible,
      enabled: this.enabled,
    })
    if (this.autoFit) this.#autoFitOnce(engine, handle)
    return handle
  }

  syncLayer(changed) {
    if (changed.has('source') && this.source) this._engine.attachSource(this._handle.id, this.source)
    else if (changed.has('data') && this.data) this._handle.set(this.data)
    if (changed.has('where')) this._handle.setWhere(this.where)
    if (changed.has('visible')) this._handle.setVisible(this.visible)
    if (changed.has('enabled')) this._handle.setEnabled(this.enabled)
  }

  disconnectedCallback() {
    this.#autoFitUnsub?.()
    this.#autoFitUnsub = null
    super.disconnectedCallback()
  }

  // `auto-fit="once"`: encuadra la capa cuando hay puntos, una sola vez. Se respalda en el handle
  // imperativo `camera.fitToLayer` (no recalcula bounds). Si los datos ya están, encuadra al toque;
  // si no, espera el primer snapshot no vacío del Source y se desuscribe.
  #autoFitOnce(engine, handle) {
    const src = handle.source
    const fit = () => engine.camera.fitToLayer(handle.id)
    if (src?.getSnapshot()?.length) { fit(); return }
    this.#autoFitUnsub = src?.subscribe(() => {
      if (!src.getSnapshot().length) return
      this.#autoFitUnsub(); this.#autoFitUnsub = null
      fit()
    })
  }
}
