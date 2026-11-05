// cristae/grammar — registro tipado de la gramática de composición.
//
// Modela la composición de elementos <cristae-*> como un álgebra de ENTIDADES
// (hojas que renderizan: point/label/polygon) y MODIFICADORES (envoltorios que
// transforman lo que producen sus hijos: cluster/overlay). El árbol DOM ES el AST;
// un recorrido post-orden en el montaje (ver ./reduce.js) es el intérprete. La
// validez de un compuesto y su reducción salen de los TIPOS (firmas), sin
// special-casing por modificador.
//
// Cada elemento declara su ROL; cómo se reduce (combine, arity, reach, passThrough)
// lo deriva `deriveSignature` y no se escribe en la firma: `signatureFor` devuelve sólo
// lo declarado, y validate.js y reduce.js derivan el resto. Este segmento es
// genérico sobre los KINDS y las firmas (un modificador nuevo sólo agrega firma +
// apply, sin tocar el reductor) pero asume las convenciones de custom-element de
// Cristae. NO importa engine/render/element (queda desacoplado como `core`). Sólo
// conoce tag → { firma, apply }.

import { validateSignature } from './validate.js'

/**
 * @typedef {'leaf'|'transform'|'aggregate'|'decorate'} Role
 * @typedef {Object} Signature   firma que declara el elemento
 * @property {Role}      role
 * @property {string[]=} consumes  kinds que toma de sus hijos; una hoja no consume
 * @property {string[]}  produces  kinds que aporta hacia arriba (≥1)
 *
 * @typedef {Object} DerivedSignature  lo que leen reduce.js y validate.js; sale del rol
 * @property {Role}     role
 * @property {string[]} consumes
 * @property {string[]} produces
 * @property {'fold'|'map'|null} combine  'fold' = un apply() sobre TODOS los targets; 'map' = uno por target
 * @property {'leaf'|'wrapper'}  arity
 * @property {'all'|'nearest'}   reach    'all' = lo consumido que sube del subárbol; 'nearest' = lo que
 *                                        produce como propio cada hijo directo (ver validate.js)
 * @property {boolean}  passThrough       re-emite hacia arriba los hijos consumidos
 */

// Rol → reducción. Un decorador toma el productor más cercano y ése es su host; transform y aggregate
// toman todo el subárbol. Tabla constante de módulo, exhaustiva sobre los roles de validateSignature.
const ROLES = {
  leaf     : { combine: null,   arity: 'leaf',    reach: 'all' },
  transform: { combine: 'map',  arity: 'wrapper', reach: 'all' },
  aggregate: { combine: 'fold', arity: 'wrapper', reach: 'all' },
  decorate : { combine: 'map',  arity: 'wrapper', reach: 'nearest' },
}

// Derivada por firma declarada: la del registro se deriva una vez y el reductor la relee sin asignar.
const derived = new WeakMap()

/**
 * Firma completa a partir de la declarada. Un agregador re-emite lo consumido sólo si vuelve a producirlo
 * (el cluster deja pasar los puntos sueltos); el resto lo re-emite siempre. Interna del segmento: la usan
 * validate.js y reduce.js y no sale por cristae/grammar.
 * @param {Signature} sig  ya validada
 * @returns {DerivedSignature}
 */
export const deriveSignature = sig => {
  if (derived.has(sig)) return derived.get(sig)

  const { role, consumes = [], produces } = sig
  const passThrough = role !== 'aggregate' || produces.some(k => consumes.includes(k))
  const d           = { role, consumes, produces, ...ROLES[role], passThrough }
  derived.set(sig, d)
  return d
}

/**
 * Crea una instancia de gramática (universo de kinds + registro de firmas).
 * @param {{ kinds: string[], mode?: 'throw'|'warn' }} cfg
 */
export function defineGrammar({ kinds, mode = 'throw' }) {
  const KINDS = new Set(kinds)
  /** @type {Map<string, { signature: Signature, apply: Function|null }>} */
  const reg = new Map() // tag MAYÚSCULA → { signature, apply }

  const key = tag => (tag == null ? '' : String(tag).toUpperCase())

  /**
   * Registra un elemento de la gramática. La firma declarada no se muta: se guarda una copia con sus tres campos.
   * @param {string} tag        nombre del custom element (case-insensitive)
   * @param {Signature} signature
   * @param {{ apply?: Function }=} opts  apply(engine, targetUnits, config) → Unit[] (sólo wrappers)
   */
  function register(tag, signature, opts = {}) {
    validateSignature(tag, signature, KINDS) // R4 + forma de la firma
    const { role, consumes = [], produces } = signature
    reg.set(key(tag), { signature: { role, consumes, produces }, apply: opts.apply ?? null })
  }

  const signatureFor = tag => reg.get(key(tag))?.signature ?? null
  const applyFor     = tag => reg.get(key(tag))?.apply ?? null
  const isRegistered = tag => reg.has(key(tag))
  const isLeaf       = tag => signatureFor(tag)?.role === 'leaf'
  const isWrapper    = tag => isRegistered(tag) && !isLeaf(tag)

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
