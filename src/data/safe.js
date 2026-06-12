// Aislamiento de errores en caliente. Los dos únicos try/catch del hot-path:
// ningún call-site lleva try/catch inline ni wrappers que asignen por llamada.

// Aísla una llamada. Devuelve el valor en éxito; en error invoca onError y devuelve undefined.
// onError debe ser una referencia estable (de módulo), nunca una clausura del call-site → [0-alloc].
export const safe = (fn, arg, onError) => {
  try { return fn(arg) }
  catch (e) { onError(e, arg) }
}

// Fan-out aislado a N listeners — cero-alloc (sin array de tareas, sin clausuras).
// Un listener que lanza no detiene a los demás.
export const safeDispatch = (listeners, data, onError) => {
  for (let i = 0; i < listeners.length; i++) safe(listeners[i].callback, data, onError)
}
