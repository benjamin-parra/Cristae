// applyElementProps — aplica props React a un custom element <cristae-*> SIN reconciliar su contenido.
// Es el núcleo del binding: la estructura (el elemento) la monta React una vez; las props se aplican
// clasificándolas por su valor y su key, diffeando contra el render anterior para tocar SÓLO lo que
// cambió:
//   • evento   (key ~ /^on[A-Z]/ y función) → addEventListener / removeEventListener (diff por ref).
//   • propiedad (objeto o función NO-evento) → element[key] = value.  🔴 El DATO (source/data/accessors/
//     iconSet) entra por ACÁ, por PROPIEDAD: el core reactivo del elemento maneja los updates (move/patch
//     coalescido a rAF) FUERA de React → cero reconciliación por tick en el hot-path.
//   • atributo  (string/number/boolean/null) → setAttribute / removeAttribute.
//
// Devuelve el estado aplicado (para el próximo diff). `eventNameOf(key)` mapea la key del handler al
// nombre del evento del elemento (inyectable; default = quita 'on' y minúsculas: onFoo → 'foo').

const isEvent = (key) => /^on[A-Z]/.test(key)
const isSerializable = (v) => v == null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
const defaultEventName = (key) => key.slice(2).toLowerCase()

// camelCase → kebab-case para el nombre de atributo (initialZoom → initial-zoom).
const attrName = (key) => key.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()

export function applyElementProps(el, prev, next, eventNameOf = defaultEventName) {
  const before = prev ?? {}

  // Bajas: keys en `prev` que ya no están en `next`.
  for (const key in before) {
    if (key in next) continue
    const old = before[key]
    if (isEvent(key)) { if (typeof old === 'function') el.removeEventListener(eventNameOf(key), old) }
    else if (isSerializable(old)) el.removeAttribute(attrName(key))
    else el[key] = undefined
  }

  // Altas y cambios.
  for (const key in next) {
    const value = next[key]
    const old = before[key]
    if (value === old) continue                      // referencia igual → nada que hacer
    if (isEvent(key)) {
      const ev = eventNameOf(key)
      if (typeof old === 'function') el.removeEventListener(ev, old)
      if (typeof value === 'function') el.addEventListener(ev, value)
    } else if (isSerializable(value)) {
      if (value == null || value === false) el.removeAttribute(attrName(key))
      else el.setAttribute(attrName(key), value === true ? '' : String(value))
    } else {
      el[key] = value                                // objeto/función → propiedad (el dato, sin reconcile)
    }
  }

  return { ...next }
}
