// Instancia de gramática configurada para los elementos de mapa de Cristae.
// Declara el universo de KINDS; las FIRMAS de cada elemento se registran en
// `index.js` (el entry `map`) ANTES de `customElements.define`, para que
// `_enclosingModifier` ya sepa qué tags son wrappers cuando corre el primer
// connectedCallback. La instancia se comparte entre base.js (montaje) e index.js.
import { defineGrammar } from '../grammar/index.js'

export const grammar = defineGrammar({
  kinds: ['point', 'label', 'polygon', 'line', 'html', 'bubble', 'overlay'],
})
