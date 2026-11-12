import { CristaeLayerElement } from './base.js'
import { makeAutoId } from './autoId.js'
import { createPendingSource } from '../data/Source.js'
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
    source     : { attribute: false, noAccessor: true },   // Source compartida (createSource/defineSource); accessor propio, abajo
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

  // Campos con guion bajo y no privados: las pruebas prestan el prototipo sobre un `this` sin constructor.
  _own         = createPendingSource()   // la Source del elemento: existe desde la construcción y la adopta la capa al montar
  _mountedData = null                    // el `data` con que montó la capa, hasta el primer cambio de `data`: ese primer `updated()` no lo reaplica (borraría lo movido antes de ready)
  _external    = null                    // la Source que el consumidor asigna; si está, gana sobre _own
  #autoFitUnsub = null   // la espera de `auto-fit="once"` mientras no encuadró; null = no espera

  constructor() {
    super()
    this.interactive = false
    this.visible     = true
    this.enabled     = true
  }

  // Sin Source del consumidor, `source` es la propia del elemento (la misma que `controls.source` tras montar):
  // antes de ready encola move/set/append y el motor los reproduce al alta. Asignar una propia la reemplaza; vaciarla
  // después de un attach no vuelve a la del elemento.
  get source() { return this._external ?? this._own }
  set source(value) {
    const old = this._external
    this._external = value ?? null
    this.requestUpdate('source', old)
  }

  // Lo que el consumidor aportó: lo que `-of` y los `fields` por atributo respetan o ignoran.
  get _consumerSource() { return this._external }

  layerId() { return this.id || (this._auto ??= makeAutoId('point')) }

  // Necesita una Source (que ya trae accessors), accessors propios (ruta `data`), una `url` o `fields`. Sin eso, diferir.
  mountReady() { return !!(this._external || this.accessors || this.url || this.fields) }

  // Con `source` los accessors viajan con ella: los cierres de `variant-of` y `heading-of` no aplican.
  mountLayer(engine) {
    const of = resolveOf(this, this._external ? [] : ['id', 'variant', 'heading'])
    this._mountedData = this.data
    const handle = engine.addPointLayer({
      id         : this.layerId(),
      ...this._placement,
      source     : this._external ?? this._own,  // la del consumidor gana sobre `data`; si no, la pendiente propia, que adopta la capa
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
    if (changed.has('source') && this._external) {
      this._engine.attachSource(this._handle.id, this._external)
      this.#autoFitUnsub && this.#autoFitOnce(this._engine, this._handle)   // la espera sigue a la fuente nueva
    } else if (changed.has('data') && this.data) {
      // La marca vale sólo para el primer cambio tras montar: después, todo `data` se aplica (también uno ya visto).
      const montada = this._mountedData
      this._mountedData = null
      if (this.data !== montada) this._handle.set(this.data)
    }
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
