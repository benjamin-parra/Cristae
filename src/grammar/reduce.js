// Reductor genérico de la gramática (intérprete dirigido por firmas, sin
// special-casing por modificador). Recorrido post-orden: cada nodo aporta un
// conjunto de RenderUnits hacia su padre. Un wrapper mezcla las units de sus hijos,
// transforma las que matchean `consumes` (fold = un apply sobre todas; map = uno por
// target) y pasa el resto. El intérprete hace el DISPATCH fold/map; cada modificador
// sólo aporta un `apply(engine, targetUnits, config) → Unit[]`.
//
// Asume las convenciones de custom-element de Cristae (duck-typing, sin imports de
// element/engine): un hijo se monta con `child.cristaeMount(engine)` y expone sus
// units con `child.cristaeUnits()`.

import { grammarChildren } from './util.js'

/**
 * @typedef {Object} Unit
 * @property {string} kind
 * @property {string|number} id
 * @property {*} handle              handle imperativo de la capa (set/move/patch)
 * @property {*} [source]            Source que lee la unit (point/bubble/label)
 * @property {Set<*>|null} suppressed  ref VIVA del set de supresión del host (getter)
 */

/**
 * Construye una RenderUnit a partir de la capa montada. `suppressed` es un getter →
 * siempre ve la ref viva que el cluster muta in place (nunca una copia rancia).
 * @returns {Unit}
 */
export function buildUnit(kind, handle, engine) {
  return {
    kind,
    id: handle.id,
    handle,
    source: handle.source,
    get suppressed() {
      return engine.getLayer?.(handle.id)?.suppressed ?? null
    },
  }
}

/**
 * Units que aporta una HOJA ya montada (entidad: point/polygon/label).
 * @returns {Unit[]}
 */
export function leafUnits(el, engine, ctx) {
  const sig = ctx.signatureFor(el.tagName)
  if (!el._handle) return []
  return [buildUnit(sig.produces[0], el._handle, engine)]
}

/**
 * Reduce un WRAPPER: monta sus hijos de gramática, junta sus units, separa
 * targets/pass-through por `consumes`, aplica `combine` y devuelve el conjunto
 * combinado. Lo llama el `mountLayer` del elemento modificador.
 * @param {Element} el
 * @param {*} engine
 * @param {{ signatureFor:Function, applyFor:Function, isRegistered:Function }} ctx
 * @returns {Unit[]}
 */
export function reduceModifier(el, engine, ctx) {
  const sig = ctx.signatureFor(el.tagName)
  const kids = grammarChildren(el, ctx.isRegistered)

  // Post-orden: montar hijos (hoja → handle del motor; wrapper → su propia reducción)
  // y juntar sus units.
  const childUnits = []
  for (const c of kids) {
    c.cristaeMount(engine)
    const us = c.cristaeUnits ? c.cristaeUnits() : []
    for (let i = 0; i < us.length; i++) childUnits.push(us[i])
  }

  const consumed = new Set(sig.consumes)
  const targets = childUnits.filter((u) => consumed.has(u.kind))

  const apply = ctx.applyFor(el.tagName)
  const cfg = el.cristaeConfig ? el.cristaeConfig() : {}
  const produced = []
  if (apply && targets.length) {
    if (sig.combine === 'fold') {
      const r = apply(engine, targets, cfg)
      if (r) for (let i = 0; i < r.length; i++) produced.push(r[i])
    } else if (sig.combine === 'map') {
      for (const t of targets) {
        const r = apply(engine, [t], cfg)
        if (r) for (let i = 0; i < r.length; i++) produced.push(r[i])
      }
    }
  }

  const passThrough = sig.passThrough !== false
  const carried = passThrough ? childUnits : childUnits.filter((u) => !consumed.has(u.kind))
  return [...carried, ...produced]
}
