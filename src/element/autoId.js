// Id automático incremental por KIND de capa. Un elemento declarativo sin `id` explícito recibe uno
// estable y único dentro de su kind (`point-1`, `line-2`, …). Reemplaza el `let seq = 0` a nivel de
// módulo que cada elemento repetía: un contador por kind, compartido por todas las instancias de ese
// kind. Los kinds son independientes entre sí (la secuencia de `point` no afecta a la de `line`), igual
// que cuando cada archivo tenía su propio contador.
const seqs = new Map()

export function makeAutoId(kind) {
  const n = (seqs.get(kind) ?? 0) + 1
  seqs.set(kind, n)
  return `${kind}-${n}`
}
