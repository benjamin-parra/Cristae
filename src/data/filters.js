// Factories diminutas: un filtro es { id, f }; un listener es { id, callback }.
// Sin clases — eran wrappers solo para validar. Validación mínima inline.

export const makeFilter = (id, predicate) => {
  if (id == null || typeof predicate !== 'function')
    throw new TypeError(`[makeFilter] requiere id y predicate(function): id=${String(id)}`)
  return { id, f: predicate }
}

export const makeListener = (id, callback) => {
  if (id == null || typeof callback !== 'function')
    throw new TypeError(`[makeListener] requiere id y callback(function): id=${String(id)}`)
  return { id, callback }
}
