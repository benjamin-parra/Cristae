// Utilidades compartidas del segmento de gramática (sin dependencias de engine/DOM
// más allá de la interfaz mínima de Element: tagName / children / getAttribute).

/**
 * Hijos del elemento que participan de la gramática: custom-elements registrados,
 * excluyendo los de configuración (`slot="bubble"` del cluster) y el DOM plano.
 * @param {Element} el
 * @param {(tag: string) => boolean} isRegistered
 * @returns {Element[]}
 */
export function grammarChildren(el, isRegistered) {
  const out = []
  const kids = el.children
  for (let i = 0; i < kids.length; i++) {
    const c = kids[i]
    if (c.getAttribute && c.getAttribute('slot') === 'bubble') continue
    if (isRegistered(c.tagName)) out.push(c)
  }
  return out
}

/**
 * Primer hijo que NO participa de la gramática ni es configuración (`slot="bubble"`): un typo de tag
 * o un elemento fuera de lugar, que `grammarChildren` descartaría en silencio. `null` si todos los
 * hijos son válidos. Es el complemento de `grammarChildren` para poder AVISAR en vez de ignorar.
 * @param {Element} el
 * @param {(tag: string) => boolean} isRegistered
 * @returns {Element|null}
 */
export function firstUnknownChild(el, isRegistered) {
  const kids = el.children
  for (let i = 0; i < kids.length; i++) {
    const c = kids[i]
    if (c.getAttribute && c.getAttribute('slot') === 'bubble') continue
    if (!isRegistered(c.tagName)) return c
  }
  return null
}

/** Nombre legible de un elemento para mensajes de error. */
export const tagName = (el) => (el?.tagName ? el.tagName.toLowerCase() : String(el))
