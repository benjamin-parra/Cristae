// Soporte de montaje compuesto: la generalización de `_enclosingCluster` →
// `_enclosingModifier`. Un hijo de CUALQUIER wrapper de la gramática difiere su
// auto-montaje; el wrapper que lo envuelve lo monta (su reductor). Con sólo
// `cristae-cluster` registrado como wrapper, es idéntico a `_enclosingCluster`.

/**
 * Modificador de la gramática que envuelve a `el` (excluyéndose), parando en
 * <cristae-map>. Devuelve el más cercano hacia arriba que sea wrapper.
 * @param {Element} el
 * @param {(tag: string) => boolean} isWrapper
 * @returns {Element|null}
 */
export function enclosingModifier(el, isWrapper) {
  let p = el.parentElement
  while (p && p.tagName !== 'CRISTAE-MAP') {
    if (isWrapper(p.tagName)) return p
    p = p.parentElement
  }
  return null
}
