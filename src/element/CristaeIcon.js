import { LitElement, nothing } from 'lit'

// <cristae-icon name="camion" src="camion.svg"> — una entrada del catálogo de un <cristae-icon-set>. No dibuja
// nada: avisa a su set cuando cambia `name` o `src`, o cuando entra o sale del DOM, para que éste actualice
// su catálogo sin cambiar la identidad del set. Al salir ya no tiene padre, así que recuerda el set al conectarse.

export class CristaeIcon extends LitElement {

  static properties = {
    name : { type: String },
    src  : { type: String },
  }

  #set = null

  render() { return nothing }

  connectedCallback() {
    super.connectedCallback()
    this.#set = this.closest('cristae-icon-set')
    this.#set?.cristaeIconsChanged?.()
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    this.#set?.cristaeIconsChanged?.()
    this.#set = null
  }

  updated(changed) {
    if (this.#set && (changed.has('name') || changed.has('src'))) this.#set.cristaeIconsChanged?.()
  }
}
