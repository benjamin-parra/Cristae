import { CristaeModifierElement } from './base.js'
import { boolDefaultOn, boolOff } from './attrs.js'
import { makeAutoId } from './autoId.js'
import { grammar } from './composite.js'
import { buildUnit, grammarChildren } from '../grammar/index.js'
import { reachedKinds } from '../grammar/validate.js'
import { LABEL_DEFAULTS, mergeLabelOptions, resolvePlacement } from '../render/labelOptions.js'

// Las props que llegan al motor, en el orden de `LabelProps` (types/map.d.ts).
const KEYS = ['textOf', 'htmlOf', 'renderer', 'placement', 'repeat', 'offset', 'orientation', 'font', 'color', 'halo', 'paint', 'interactive', 'visible']

// Semilla del id por host de cada unit de rótulos: un host puede llevar varios `labeled` anidados.
let seq = 0

// Editores ya avisados: el aviso sale una vez por editor, no por montaje.
const warned = new Set()

// <cristae-labeled> — DECORADOR de la gramática de composición (docs/labeled.md).
// Rotula lo que produce su hijo directo: las capas base que envuelve, o las burbujas de un
// <cristae-cluster>. La geodésica, el overlay y otro `labeled` son transparentes.
//
//   <cristae-labeled placement="along" repeat="240">
//     <cristae-geodesic><cristae-line-layer id="vuelos" interactive></cristae-line-layer></cristae-geodesic>
//   </cristae-labeled>
//
// Los rótulos son estado del host: siguen su visibilidad, su foco y su cluster, y mueren con él.
export class CristaeLabeled extends CristaeModifierElement {

  // Decorador: un `addLabels` por productor más cercano, lo que produce como propio cada hijo directo; por
  // fuera de un cluster rotula las burbujas y no las hojas sueltas.
  static cristaeSignature = { role: 'decorate', consumes: ['point', 'line', 'polygon', 'shape', 'html', 'bubble'], produces: ['label'] }

  // apply del reductor: los rótulos de cada host, con su alta y su baja en el handle de la unit. Un editor no
  // tiene ítems: `addLabels` devuelve null y se avisa una vez.
  static cristaeApply(engine, targets, cfg) {
    return targets.map(({ id }) => {
      const labels = engine.addLabels({ hostId: id, ...cfg })
      if (labels) return buildUnit('label', {
        id     : `${id}:label:${++seq}`,
        update : options => labels.update(options),
        remove : () => labels.remove(),
      }, engine)

      if (engine.getLayer?.(id)?.kind === 'editable' && !warned.has(id)) {
        warned.add(id)
        console.warn(`[cristae-labeled] el editor "${id}" no se rotula porque no tiene ítems: el texto va en un elemento junto al editor.`)
      }
      return null
    }).filter(Boolean)
  }

  // `renderer` y no `render`: este último taparía el `render()` que el elemento hereda de Lit.
  static properties = {
    textOf      : { attribute: false },
    htmlOf      : { attribute: false },
    renderer    : {},
    placement   : {},
    repeat      : { type: Number },
    offset      : { type: Number },
    orientation : {},
    font        : {},
    color       : {},
    halo        : {},
    paint       : { attribute: false },
    interactive : { type: Boolean },
    visible     : { converter: boolDefaultOn },    // default true; "false" o "0" oculta sin desmontar
  }

  #own  = []
  #opts = null

  constructor() {
    super()
    this.visible = true
  }

  // Las props como se declararon. Valida lo que depende sólo de ellas: un TypeError sale acá, antes de
  // tocar el motor. Asignado como propiedad, `visible` llega crudo, como `enabled` de la geodésica.
  cristaeConfig() {
    const props = {}
    KEYS.forEach(key => props[key] = this[key])
    props.visible = !boolOff(this.visible)
    mergeLabelOptions(LABEL_DEFAULTS, props)
    return props
  }

  // Lo que depende del hijo se valida antes de reducir: un `placement` que la capa alcanzada no admite lanza
  // sin montar nada. El `_handle` es un marcador: los rótulos los da de baja `cristaeUnmount` o el host al irse.
  // Sólo son propios los rótulos de este `labeled`: los de uno anidado suben con los hijos y son suyos.
  mountLayer(engine) {
    this.#opts = mergeLabelOptions(LABEL_DEFAULTS, this.cristaeConfig())
    reachedKinds(this, grammar).forEach(kind => resolvePlacement(kind, this.#opts))

    const units  = this._reduce(engine)
    const nested = new Set(grammarChildren(this, grammar.isRegistered).flatMap(el => el.cristaeUnits()))
    this.#own    = units.filter(u => u.kind === 'label' && !nested.has(u))
    return { id: makeAutoId('labeled-marker'), units }
  }

  // Un cambio en caliente se valida entero antes de tocar un host. Una prop quitada vuelve a su valor por
  // defecto (null). Un `textOf` nuevo no remonta: el motor compara los textos y repinta si cambió alguno.
  syncLayer(changed) {
    const patch = {}
    KEYS.forEach(key => changed.has(key) && (patch[key] = this[key] ?? null))
    if (!Object.keys(patch).length) return

    'visible' in patch && (patch.visible = !boolOff(this.visible))
    const next = mergeLabelOptions(this.#opts, patch)
    'placement' in patch && reachedKinds(this, grammar).forEach(kind => resolvePlacement(kind, next))
    this.#opts = next
    this.#own.forEach(u => u.handle.update(patch))
  }

  cristaeUnmount() {
    this.#own.forEach(u => u.handle.remove())
    this.#own = []
    super.cristaeUnmount()
  }
}
