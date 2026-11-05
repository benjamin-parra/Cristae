// Validación de la gramática de composición — un CFG TIPADO mínimo (no un parser).
//
// Dos chequeos:
//   · validateSignature(tag, sig, KINDS) — forma de la firma declarada + R4 (kinds del universo).
//   · validate(root, ctx)                — juicio de tipos sobre el subárbol (R1–R3, R5).
//
// El juicio lee la firma DERIVADA del rol (grammar.js). `produced(node)` se computa
// bottom-up: hoja → produces; wrapper → produces ∪ (passThrough ? kinds consumidos que
// pasan : ∅). Un subárbol es VÁLIDO si el juicio se cumple en cada nodo. Toda invalidez
// lanza un GrammarError ANTES de tocar el motor (un árbol inválido no crea estado), y
// el mensaje nombra el rol del elemento.

import { grammarChildren, firstUnknownChild, tagName } from './util.js'

export class GrammarError extends Error {
  /**
   * @param {'R1'|'R2'|'R3'|'R4'|'R5'} code
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

// Rol → cómo lo nombran los mensajes. Sus claves son los roles válidos.
const ROL   = { leaf: 'una hoja', transform: 'un transformador', aggregate: 'un agregador', decorate: 'un decorador' }
const FIRMA = new Set(['role', 'consumes', 'produces'])

/** R4 + coherencia de la firma declarada. Lanza GrammarError('R4') si algo no cuadra. */
export function validateSignature(tag, sig, KINDS) {
  const t  = String(tag).toLowerCase()
  const r4 = msg => new GrammarError('R4', null, `${PFX} ${msg}`)
  if (!sig || typeof sig !== 'object')
    throw r4(`firma inválida para <${t}>.`)
  if (!Object.hasOwn(ROL, sig.role))
    throw r4(`<${t}> rol inválido '${String(sig.role)}' (leaf|transform|aggregate|decorate).`)

  // combine, arity, reach y passThrough salen del rol; el ligado de una hoja no es parte de la firma.
  const ajeno = Object.keys(sig).find(k => !FIRMA.has(k))
  if (ajeno)
    throw r4(`<${t}> declara '${ajeno}', que no es parte de la firma { role, consumes, produces }.`)
  if (!Array.isArray(sig.produces) || sig.produces.length === 0)
    throw r4(`<${t}> debe declarar produces con ≥1 kind.`)

  const consumes    = sig.consumes ?? []
  const desconocido = [...consumes, ...sig.produces].find(k => !KINDS.has(k))
  if (desconocido !== undefined)
    throw r4(`<${t}> referencia kind desconocido '${desconocido}'; kinds declarados: [${[...KINDS].join(',')}].`)
  if (sig.role === 'leaf' && consumes.length)
    throw r4(`<${t}> es una hoja: no consume (consumes vacío u omitido).`)
  if (sig.role !== 'leaf' && !consumes.length)
    throw r4(`<${t}> es ${ROL[sig.role]}: debe declarar consumes con ≥1 kind.`)
}

// ── Alcance `reach: 'nearest'` ──
// Recorre los hijos de gramática de `el`: una hoja aporta sus kinds de `consumed`; un wrapper aporta los
// suyos propios (`produces − consumes`) que estén en `consumed`, y sin ninguno es transparente y se recorre
// por dentro. `fn(nodo, kinds)` corre una vez por nodo que aporta. Decide por la firma, no por las units del
// momento: un cluster apagado sigue aportando `bubble` y no deja ver sus puntos.
export const eachNearest = (el, ctx, consumed, fn) =>
  grammarChildren(el, ctx.isRegistered).forEach(child => {
    const sig   = ctx.signatureFor(child.tagName)
    const own   = sig.arity === 'leaf' ? sig.produces : sig.produces.filter(k => !sig.consumes.includes(k))
    const kinds = own.filter(k => consumed.has(k))
    kinds.length ? fn(child, kinds) : sig.arity === 'wrapper' && eachNearest(child, ctx, consumed, fn)
  })

// ── Juicio por arity (dispatch por tabla en vez de if/else) ──
// `produced(node)` bifurca según la arity de la firma: una HOJA no envuelve hijos y
// aporta sus `produces`; un WRAPPER valida R3/R5/R2 recursando sobre sus hijos y suma
// los kinds que pasa. Ambos comparten firma (el, ctx, sig, kids) para el lookup en JUZGAR.

/** Juzga una HOJA: no puede envolver hijos (R1); aporta sus `produces`. */
const juzgarHoja = (el, _ctx, sig, kids) => {
  if (kids.length)
    throw new GrammarError('R1', el,
      `${PFX} <${tagName(el)}> es una hoja (kind '${sig.produces[0]}') y no puede envolver hijos; encontró <${tagName(kids[0])}>.`)
  return new Set(sig.produces)
}

// Un wrapper que no alcanza nada de lo que consume (R3 sin hijos, R2 con hijos), dicho por su rol. `producen`
// son los kinds de los hijos, o null si no tiene.
const sinCapas = (el, sig, producen) => {
  const kinds = sig.consumes.map(k => `'${k}'`).join(' o ')
  const falta = sig.role === 'decorate'
    ? ` y no envuelve ninguna capa que produzca (${sig.consumes.join(', ')})`
    : `: consume ${kinds} y no hay capas de ${kinds} adentro`
  return `${PFX} <${tagName(el)}> es ${ROL[sig.role]}${falta}${producen ? ` (los hijos producen: [${producen.join(',')}])` : ''}.`
}

/** Juzga un WRAPPER: R3 (≥1 hijo) → R5 (hijo desconocido) → R2 (nadie produce lo consumido). */
const juzgarWrapper = (el, ctx, sig, kids) => {
  if (kids.length === 0)
    throw new GrammarError('R3', el, sinCapas(el, sig, null))

  // R5 — un hijo no reconocido (typo de tag, elemento fuera de lugar) se descartaría en silencio y
  // el error real quedaría enmascarado. Se avisa DESPUÉS de R3: sin ningún hijo válido manda R3.
  const desconocido = firstUnknownChild(el, ctx.isRegistered)
  if (desconocido)
    throw new GrammarError('R5', el,
      `${PFX} <${tagName(el)}> tiene un hijo no reconocido <${tagName(desconocido)}>: no es un elemento de la gramática ni configuración (¿typo de tag?).`)

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
  // Con `reach: 'nearest'` R2 mira lo que alcanza la regla; lo que sube hacia el padre no cambia.
  if ((sig.reach === 'nearest' ? reachedKinds(el, ctx) : passKinds).size === 0)
    throw new GrammarError('R2', el, sinCapas(el, sig, [...allChildKinds]))

  const out = new Set(sig.produces)
  if (sig.passThrough) for (const k of passKinds) out.add(k)
  return out
}

/** Tabla constante de módulo: arity → juez. Exhaustiva sobre las arities válidas. */
const JUZGAR = { leaf: juzgarHoja, wrapper: juzgarWrapper }

/**
 * `produced(node)` + chequeo R1–R3. Devuelve el Set de kinds que el subárbol aporta.
 * @returns {Set<string>}
 */
function producedOf(el, ctx) {
  const sig = ctx.signatureFor(el.tagName)
  const kids = grammarChildren(el, ctx.isRegistered)
  return JUZGAR[sig.arity](el, ctx, sig, kids)
}

/**
 * Kinds de `consumes` que alcanza un wrapper según su `reach`: con `'nearest'`, los de la regla de
 * `eachNearest`; si no, los que produce el subárbol de cada hijo (y lo valida). Interno del segmento: no
 * sale por cristae/grammar.
 * @returns {Set<string>}
 */
export function reachedKinds(el, ctx) {
  const sig      = ctx.signatureFor(el.tagName)
  const consumed = new Set(sig.consumes)
  const out      = new Set()
  if (sig.reach === 'nearest') eachNearest(el, ctx, consumed, (_node, kinds) => kinds.forEach(k => out.add(k)))
  else grammarChildren(el, ctx.isRegistered).forEach(child => producedOf(child, ctx).forEach(k => consumed.has(k) && out.add(k)))
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
