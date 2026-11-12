import { CristaeLayerElement } from './base.js'
import { makeAutoId } from './autoId.js'
import { DATA_PROPERTIES, POINT_OF, bridgeLoad, dropLoad, remoteConfig, resolveOf, syncData } from './dataAttrs.js'

// <cristae-point-layer> — capa de puntos GL declarativa. Dos entradas de dato simétricas:
// `data` (array plano → el elemento posee la Source interna) y `source` (una Source que el
// consumidor posee y comparte entre vistas; ver createSource). `accessors`/`iconSet`/`filters`/
// `source` son props (objetos/funciones, no atributos); `interactive`/`visible`/`enabled`/
// `icon-set` (nombre) pueden ir como atributos. Reenvía cambios de `source`/`data`/`visible`/
// `enabled` al motor.
export class CristaePointLayer extends CristaeLayerElement {

  // Gramática de composición: entidad hoja que produce `point`.
  static cristaeSignature = { role: 'leaf', produces: ['point'] }

  static properties = {
    data       : { type: Array },
    source     : { attribute: false },           // Source compartida (createSource/defineSource)
    accessors  : { type: Object },
    iconSet    : { attribute: 'icon-set' },      // string (nombre registrado) u objeto IconSet
    filters    : { type: Array },
    where      : { attribute: false },           // (item) => boolean: membresía por-capa (filtra qué entra a ESTA capa sin tocar la Source compartida)
    interactive: { type: Boolean },
    visible    : { type: Boolean },
    enabled    : { type: Boolean },              // membresía de la ENTIDAD en la composición (default true): off → aporta ∅ a los modificadores (cluster), pane + ligados ocultos
    autoFit    : { attribute: 'auto-fit' },      // "once": encuadra la capa al llegar los primeros puntos
    ...DATA_PROPERTIES,                          // url, format, fields, refresh, fetch, click-action, id-of
    ...POINT_OF,                                 // variant-of, heading-of
  }

  #autoFitUnsub = null   // la espera de `auto-fit="once"` mientras no encuadró; null = no espera

  constructor() {
    super()
    this.interactive = false
    this.visible     = true
    this.enabled     = true
  }

  layerId() { return this.id || (this._auto ??= makeAutoId('point')) }

  // Necesita una Source (que ya trae accessors), accessors propios (ruta `data`), una `url` o `fields`. Sin eso, diferir.
  mountReady() { return !!(this.source || this.accessors || this.url || this.fields) }

  // Con `source` los accessors viajan con ella: los cierres de `variant-of` y `heading-of` no aplican.
  mountLayer(engine) {
    const of = resolveOf(this, this.source ? [] : ['id', 'variant', 'heading'])
    const handle = engine.addPointLayer({
      id         : this.layerId(),
      ...this._placement,
      source     : this.source,                  // si está, gana sobre `data` (el motor hace cfg.source ?? owned)
      data       : this.data,
      accessors  : of.accessors,
      ...remoteConfig(this),
      ...(of.fields && { fields: of.fields }),
      iconSet    : this.iconSet,
      filters    : this.filters,
      where      : this.where,                   // membresía por-capa (filtra la Source compartida sin mutarla)
      interactive: this.interactive,
      visible    : this.visible,
      enabled    : this.enabled,
    })
    bridgeLoad(this, engine)
    if (this.autoFit) this.#autoFitOnce(engine, handle)
    return handle
  }

  syncLayer(changed) {
    if (changed.has('source') && this.source) {
      this._engine.attachSource(this._handle.id, this.source)
      this.#autoFitUnsub && this.#autoFitOnce(this._engine, this._handle)   // la espera sigue a la fuente nueva
    } else if (changed.has('data') && this.data) this._handle.set(this.data)
    if (changed.has('where')) this._handle.setWhere(this.where)
    if (changed.has('visible')) this._handle.setVisible(this.visible)
    if (changed.has('enabled')) this._handle.setEnabled(this.enabled)
    syncData(this, changed)
  }

  cristaeUnmount() {
    dropLoad(this)
    super.cristaeUnmount()
  }

  disconnectedCallback() {
    this.#autoFitUnsub?.()
    this.#autoFitUnsub = null
    super.disconnectedCallback()
  }

  // `auto-fit="once"`: encuadra la capa cuando hay puntos, una sola vez. Se respalda en el handle
  // imperativo `camera.fitToLayer` (no recalcula bounds). Si los datos ya están, encuadra al toque;
  // si no, espera el primer snapshot no vacío del Source y se desuscribe. Si la capa cambia de fuente
  // antes de encuadrar, la espera se pasa a la nueva (la vieja, que puede ser compartida, ya no cuenta).
  #autoFitOnce(engine, handle) {
    this.#autoFitUnsub?.()
    this.#autoFitUnsub = null
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
