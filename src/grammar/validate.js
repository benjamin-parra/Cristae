// Validación de la gramática de composición — un CFG TIPADO mínimo (no un parser).
//
// Dos chequeos:
//   · validateSignature(tag, sig, KINDS) — forma de la firma + R4 (kinds del universo).
//   · validate(root, ctx)                — juicio de tipos sobre el subárbol (R1–R3).
//
// `produced(node)` se computa bottom-up: hoja → produces; wrapper → produces ∪
// (passThrough ? kinds consumidos que pasan : ∅). Un subárbol es VÁLIDO si el juicio
// se cumple en cada nodo. Toda invalidez lanza un GrammarError ANTES de tocar el
// motor (un árbol inválido no crea estado).

import { grammarChildren, tagName } from './util.js'

export class GrammarError extends Error {
  /**
   * @param {'R1'|'R2'|'R3'|'R4'} code
   * @param {Element|null} node
   * @param {string} message
   */
  constructor(code, node, message) {
    super(message)
    this.name = 'GrammarError'
    this.code = code
    this.node = node ?? null
  }
}

const PFX = '[cristae-grammar]'

/** R4 + coherencia de la firma. Lanza GrammarError('R4') si algo no cuadra. */
export function validateSignature(tag, sig, KINDS) {
  const t = String(tag).toLowerCase()
  if (!sig || typeof sig !== 'object')
    throw new GrammarError('R4', null, `${PFX} firma inválida para <${t}>.`)
  if (sig.arity !== 'leaf' && sig.arity !== 'wrapper')
    throw new GrammarError('R4', null, `${PFX} <${t}> arity inválida '${sig.arity}' (leaf|wrapper).`)
  if (!Array.isArray(sig.produces) || sig.produces.length === 0)
    throw new GrammarError('R4', null, `${PFX} <${t}> debe declarar produces con ≥1 kind.`)
  const consumes = sig.consumes ?? []
  for (const k of [...consumes, ...sig.produces]) {
    if (!KINDS.has(k))
      throw new GrammarError('R4', null,
        `${PFX} <${t}> referencia kind desconocido '${k}'; kinds declarados: [${[...KINDS].join(',')}].`)
  }
  if (sig.arity === 'leaf' && (consumes.length || sig.combine))
    throw new GrammarError('R4', null, `${PFX} <${t}> es hoja: consumes debe ser [] y combine null.`)
  if (sig.arity === 'wrapper' && !(sig.combine === 'fold' || sig.combine === 'map'))
    throw new GrammarError('R4', null, `${PFX} <${t}> es wrapper: combine debe ser 'fold' o 'map'.`)
}

/**
 * `produced(node)` + chequeo R1–R3. Devuelve el Set de kinds que el subárbol aporta.
 * @returns {Set<string>}
 */
function producedOf(el, ctx) {
  const sig = ctx.signatureFor(el.tagName)
  const kids = grammarChildren(el, ctx.isRegistered)

  // ── Hoja ──
  if (sig.arity === 'leaf') {
    if (kids.length)
      throw new GrammarError('R1', el,
        `${PFX} <${tagName(el)}> es una hoja (kind '${sig.produces[0]}') y no puede envolver hijos; encontró <${tagName(kids[0])}>.`)
    return new Set(sig.produces)
  }

  // ── Wrapper ──
  if (kids.length === 0)
    throw new GrammarError('R3', el,
      `${PFX} <${tagName(el)}> es un wrapper y requiere ≥1 hijo que produzca uno de [${sig.consumes.join(',')}].`)

  const consumed = new Set(sig.consumes)
  const passKinds = new Set()
  const allChildKinds = new Set()
  for (const child of kids) {
    const produced = producedOf(child, ctx) // recursa (valida el subárbol)
    for (const k of produced) {
      allChildKinds.add(k)
      if (consumed.has(k)) passKinds.add(k)
    }
  }
  if (passKinds.size === 0)
    throw new GrammarError('R2', el,
      `${PFX} <${tagName(el)}> consume [${sig.consumes.join(',')}] pero ningún hijo lo produce (los hijos producen: [${[...allChildKinds].join(',')}]).`)

  const out = new Set(sig.produces)
  if (sig.passThrough !== false) for (const k of passKinds) out.add(k)
  return out
}

/**
 * Valida un subárbol compuesto en una pasada post-orden, antes de cualquier llamada
 * al motor. `mode: 'throw'` lanza; `'warn'` reporta y devuelve false.
 * @param {Element} root
 * @param {{ signatureFor:Function, isRegistered:Function, mode:'throw'|'warn' }} ctx
 * @returns {boolean}
 */
export function validate(root, ctx) {
  try {
    producedOf(root, ctx)
    return true
  } catch (e) {
    if (e instanceof GrammarError && ctx.mode === 'warn') {
      console.error(e.message)
      return false
    }
    throw e
  }
}
