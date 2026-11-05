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
// se deriva del rol al registrarlo y no se escribe en la firma. Este segmento es
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

/**
 * Firma completa a partir de la declarada. Un agregador re-emite lo consumido sólo si vuelve a producirlo
 * (el cluster deja pasar los puntos sueltos); el resto lo re-emite siempre.
 * @param {Signature} sig  ya validada
 * @returns {DerivedSignature}
 */
const deriveSignature = ({ role, consumes = [], produces }) => ({
  role,
  consumes,
  produces,
  ...ROLES[role],
  passThrough: role !== 'aggregate' || produces.some(k => consumes.includes(k)),
})

/**
 * Crea una instancia de gramática (universo de kinds + registro de firmas).
 * @param {{ kinds: string[], mode?: 'throw'|'warn' }} cfg
 */
export function defineGrammar({ kinds, mode = 'throw' }) {
  const KINDS = new Set(kinds)
  /** @type {Map<string, { signature: DerivedSignature, apply: Function|null }>} */
  const reg = new Map() // tag MAYÚSCULA → { signature, apply }

  const key = tag => (tag == null ? '' : String(tag).toUpperCase())

  /**
   * Registra un elemento de la gramática. La firma declarada no se muta: se guarda la derivada.
   * @param {string} tag        nombre del custom element (case-insensitive)
   * @param {Signature} signature
   * @param {{ apply?: Function }=} opts  apply(engine, targetUnits, config) → Unit[] (sólo wrappers)
   */
  function register(tag, signature, opts = {}) {
    validateSignature(tag, signature, KINDS) // R4 + forma de la firma
    reg.set(key(tag), { signature: deriveSignature(signature), apply: opts.apply ?? null })
  }

  const signatureFor = tag => reg.get(key(tag))?.signature ?? null
  const applyFor     = tag => reg.get(key(tag))?.apply ?? null
  const isRegistered = tag => reg.has(key(tag))
  const isWrapper    = tag => signatureFor(tag)?.arity === 'wrapper'
  const isLeaf       = tag => signatureFor(tag)?.arity === 'leaf'

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
