import { CristaeLayerElement } from './base.js'
import { boolDefaultOn, boolOff } from './attrs.js'
import { makeAutoId } from './autoId.js'

// Las opciones de los rótulos que la capa pasa al motor: las de `<cristae-labeled>` que valen sin trazo.
// `visible` e `interactive` son de la capa.
const KEYS = ['textOf', 'htmlOf', 'renderer', 'placement', 'offset', 'font', 'color', 'halo', 'paint']

// <cristae-text-layer> — capa base de texto suelto con datos propios (docs/text-layer.md). Pinta con los
// renderers de <cristae-labeled>, `canvas` o `html`, sin contexto WebGL. accessors = { idOf, positionOf,
// hashOf? }; el texto lo da `textOf` o `htmlOf`, y sin ellos es el id.
//
//   <cristae-text-layer id="ciudades" placement="above" interactive></cristae-text-layer>
//
// Las opciones de los rótulos se aplican en vivo; `interactive` se lee al montar.
export class CristaeTextLayer extends CristaeLayerElement {

  static cristaeSignature = { role: 'leaf', produces: ['text'] }

  // `renderer` y no `render`: este último taparía el `render()` que el elemento hereda de Lit.
  static properties = {
    data        : { type: Array },
    source      : { attribute: false },
    accessors   : { type: Object },
    textOf      : { attribute: false },
    htmlOf      : { attribute: false },
    renderer    : {},
    placement   : {},
    offset      : { type: Number },
    font        : {},
    color       : {},
    halo        : {},
    paint       : { attribute: false },
    interactive : { type: Boolean },
    visible     : { converter: boolDefaultOn },    // default true; "false" o "0" oculta sin desmontar
  }

  constructor() {
    super()
    this.interactive = false
    this.visible     = true
  }

  layerId() { return this.id || (this._auto ??= makeAutoId('text')) }

  mountReady() { return !!(this.source || this.accessors) }

  // Un TypeError de las opciones sale del motor antes de registrar la capa. Asignado como propiedad,
  // `visible` llega crudo, como en `<cristae-labeled>`.
  mountLayer(engine) {
    const cfg = {
      id          : this.layerId(),
      source      : this.source,
      data        : this.data,
      accessors   : this.accessors,
      interactive : this.interactive,
      visible     : !boolOff(this.visible),
    }
    KEYS.forEach(key => cfg[key] = this[key])
    return engine.addTextLayer(cfg)
  }

  // Una opción quitada vuelve a su valor por defecto (null). El motor valida el cambio entero antes de tocar
  // los rótulos.
  syncLayer(changed) {
    if (changed.has('source') && this.source) this._engine.attachSource(this._handle.id, this.source)
    else if (changed.has('data') && this.data) this._handle.set(this.data)
    changed.has('visible') && this._handle.setVisible(!boolOff(this.visible))

    const patch = {}
    KEYS.forEach(key => changed.has(key) && (patch[key] = this[key] ?? null))
    Object.keys(patch).length && this._handle.update(patch)
  }
}
