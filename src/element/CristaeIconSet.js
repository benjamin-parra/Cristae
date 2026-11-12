import { LitElement, nothing } from 'lit'
import { defineIconSet } from '../atlas/IconSet.js'
import { FACTORY_SHAPES } from '../atlas/shape-presets.js'
import { DROP_ICONS, SET_ICONS } from '../atlas/image-icons.js'

// <cristae-icon-set name="flota" size="40" rotates> con hijos <cristae-icon name src> — un set de íconos por
// imagen declarado en HTML, sin JS. Las capas lo piden por `icon-set="flota"`. No es una capa ni un modificador:
// no tiene firma de composición. El MAPA lo registra en el motor antes de montar sus capas, sin importar el
// orden en el HTML; un set que se conecta después de montado el mapa se registra solo.
//
// Los nombres de fábrica (dot, pin, circle, arrow) están reservados. Cambiar los hijos, su `src`, `size` o
// `rotates` actualiza el set vivo sin cambiar su identidad; cambiar `name` registra el set con el nombre
// nuevo y las capas ya montadas siguen con el set que tenían.

const DEFAULT_SIZE = 32   // px del tile: el mismo `defaultSize` del IconSet por defecto

export class CristaeIconSet extends LitElement {

  static properties = {
    name    : { type: String },
    size    : { type: Number },
    rotates : { type: Boolean },
  }

  #engine  = null
  #set     = null
  #pending = false

  render() { return nothing }

  // Hijos directos con name y src. El último repetido gana y avisa.
  #icons() {
    const icons = {}
    for (const child of this.children) {
      if (child.localName !== 'cristae-icon') continue
      const name = child.name ?? child.getAttribute?.('name')
      const src  = child.src ?? child.getAttribute?.('src')
      if (!name || !src) continue
      if (name in icons) console.warn(`[cristae-icon-set] ícono repetido '${name}': gana el último`)
      icons[name] = src
    }
    return icons
  }

  // Lo llama el mapa al montar y el propio set al conectarse con el motor ya vivo.
  cristaeRegister(engine) {
    if (engine) this.#engine = engine
    if (!this.#engine) return
    if (!this.name) return console.error('[cristae-icon-set] falta `name`: el set no se registra')
    if (FACTORY_SHAPES.includes(this.name)) {
      return console.error(`[cristae-icon-set] '${this.name}' es un set de fábrica y no se puede redefinir`)
    }
    if (!this.#set) {
      const icons = this.#icons()
      if (!Object.keys(icons).length) return console.warn(`[cristae-icon-set] '${this.name}' no tiene <cristae-icon>: espera a que lleguen`)
      const emit = (type, detail) =>
        this.dispatchEvent(new CustomEvent(`cristae:${type}`, { detail: { ...detail, set: this.name }, bubbles: true, composed: true }))
      this.#set = defineIconSet({
        icons,
        rotates : this.rotates,
        sizes   : { default: this.size ?? DEFAULT_SIZE },
        onLoad  : detail => emit('load', detail),
        onError : detail => emit('error', detail),
      })
    }
    this.#engine.registerIconSet(this.name, this.#set)
  }

  // Un <cristae-icon> cambió. Se junta en una microtarea: agregar varios hijos es un solo cambio de catálogo.
  cristaeIconsChanged() {
    if (this.#pending) return
    this.#pending = true
    queueMicrotask(() => { this.#pending = false; this.#sync() })
  }

  #sync() {
    if (!this.#set) return this.#engine && this.cristaeRegister()
    try {
      this.#set[SET_ICONS](this.#icons(), { rotates: this.rotates, size: this.size ?? DEFAULT_SIZE })
    } catch (e) {
      console.warn(`[cristae-icon-set] '${this.name}': se conserva el catálogo anterior (${e.message})`)
    }
  }

  connectedCallback() {
    super.connectedCallback()
    const engine = this.closest('cristae-map')?.engine
    if (engine && Object.keys(this.#icons()).length) this.cristaeRegister(engine)
    else if (engine) this.#engine = engine
  }

  disconnectedCallback() {
    this.#set?.[DROP_ICONS]?.()
    super.disconnectedCallback()
  }

  updated(changed) {
    if (changed.has('name') && changed.get('name') !== undefined && this.#engine) {
      console.warn(`[cristae-icon-set] '${changed.get('name')}' sigue registrado en el motor: las capas montadas conservan el set`)
      this.cristaeRegister()
    }
    if (this.#set && (changed.has('size') || changed.has('rotates'))) this.cristaeIconsChanged()
  }
}
