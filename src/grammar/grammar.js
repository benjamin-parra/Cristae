// cristae/grammar — registro tipado de la gramática de composición.
//
// Modela la composición de elementos <cristae-*> como un álgebra de ENTIDADES
// (hojas que renderizan: point/label/polygon) y MODIFICADORES (envoltorios que
// transforman lo que producen sus hijos: cluster/overlay). El árbol DOM ES el AST;
// un recorrido post-orden en el montaje (ver ./reduce.js) es el intérprete. La
// validez de un compuesto y su reducción salen de los TIPOS (firmas), sin
// special-casing por modificador.
//
// Este segmento es genérico sobre los KINDS y las firmas (un modificador nuevo
// sólo agrega firma + apply, sin tocar el reductor) pero asume las convenciones de
// custom-element de Cristae. NO importa engine/render/element (queda desacoplado
// como `core`). Sólo conoce tag → { firma, apply }.

import { validateSignature } from './validate.js'

/**
 * @typedef {'fold'|'map'|null} Combine
 * @typedef {'leaf'|'wrapper'} Arity
 * @typedef {Object} Signature
 * @property {string[]} consumes     kinds que transforma de sus hijos; [] ⇒ hoja
 * @property {string[]} produces     kinds que aporta hacia arriba (≥1)
 * @property {Combine}  combine       'fold' = un apply() sobre TODOS los targets; 'map' = uno por target; null = hoja
 * @property {Arity}    arity         'leaf' | 'wrapper'
 * @property {string=}  bindsTo       productores ligados (label/overlay): kind del host cuyo `suppressed` leen
 * @property {boolean=} passThrough   el wrapper re-emite hacia arriba los hijos consumidos (default true)
 */

/**
 * Crea una instancia de gramática (universo de kinds + registro de firmas).
 * @param {{ kinds: string[], mode?: 'throw'|'warn' }} cfg
 */
export function defineGrammar({ kinds, mode = 'throw' }) {
  const KINDS = new Set(kinds)
  /** @type {Map<string, { signature: Signature, apply: Function|null }>} */
  const reg = new Map() // tag MAYÚSCULA → { signature, apply }

  const key = (tag) => (tag == null ? '' : String(tag).toUpperCase())

  /**
   * Registra un elemento de la gramática.
   * @param {string} tag        nombre del custom element (case-insensitive)
   * @param {Signature} signature
   * @param {{ apply?: Function }=} opts  apply(engine, targetUnits, config) → Unit[] (sólo wrappers)
   */
  function register(tag, signature, opts = {}) {
    validateSignature(tag, signature, KINDS) // R4 + forma de la firma
    reg.set(key(tag), { signature, apply: opts.apply ?? null })
  }

  const signatureFor = (tag) => reg.get(key(tag))?.signature ?? null
  const applyFor = (tag) => reg.get(key(tag))?.apply ?? null
  const isRegistered = (tag) => reg.has(key(tag))
  const isWrapper = (tag) => signatureFor(tag)?.arity === 'wrapper'
  const isLeaf = (tag) => signatureFor(tag)?.arity === 'leaf'

  return {
    kinds: KINDS,
    mode,
    register,
    signatureFor,
    applyFor,
    isRegistered,
    isWrapper,
    isLeaf,
  }
}
