// cristae/grammar — segmento de gramática de composición (entidades + modificadores).
//
// Genérico sobre los KINDS y las firmas (un modificador nuevo = firma + apply, sin
// tocar el reductor) pero asume las convenciones de custom-element de Cristae. NO
// importa engine/render/element: queda desacoplado como `core`. El consumidor (el
// entry `map`) declara el universo de kinds, registra las firmas de sus elementos y
// cablea el montaje. Ver SPECS.md / MODELO.md.

export { defineGrammar } from './grammar.js'
export { GrammarError, validate, validateSignature } from './validate.js'
export { reduceModifier, leafUnits, buildUnit } from './reduce.js'
export { enclosingModifier } from './mounting.js'
export { grammarChildren, tagName } from './util.js'
