// applyElementProps — aplica props React a un custom element <cristae-*> SIN reconciliar su contenido.
// Es el núcleo del binding: la estructura (el elemento) la monta React una vez; las props se aplican
// clasificándolas por su valor y su key, diffeando contra el render anterior para tocar SÓLO lo que
// cambió:
//   • evento    (key ~ /^on[A-Z]/ y función) → addEventListener / removeEventListener (diff por ref).
//   • propiedad (booleano, objeto o función NO-evento) → element[key] = value.  🔴 El DATO (source/data/
//     accessors/iconSet) entra por ACÁ, por PROPIEDAD: el core reactivo del elemento maneja los updates
//     (move/patch coalescido a rAF) FUERA de React → cero reconciliación por tick en el hot-path.
//   • atributo  (string/number, o null/undefined = ausencia) → setAttribute / removeAttribute (kebab-case).
//
// Los BOOLEANOS van por PROPIEDAD, no por atributo: un atributo booleano de Lit no puede expresar
// `false` sobre una propiedad que nace `true` (p. ej. `visible`/`enabled`/`expandable`, default true en
// el constructor de la capa) — quitar un atributo AUSENTE no dispara `attributeChangedCallback`, así que
// `visible={false}` no ocultaría la capa. La propiedad es el canal fiable de los custom elements: el
// setter reactivo aplica on/off siempre (y los conversores `boolDefaultOn`/`boolOff` del popup ya leen
// el booleano crudo). Devuelve el estado aplicado (para el próximo diff). `eventNameOf(key)` mapea la key
// del handler al nombre del evento del elemento (inyectable; default = quita 'on' y minúsculas: onFoo → 'foo').

const isEvent = (key) => /^on[A-Z]/.test(key)
// Atributo = escalar serializable a texto (string/número), o ausencia (null/undefined). El booleano NO:
// va por propiedad (ver cabecera). El objeto/función tampoco (el dato).
const isAttr           = (v) => v == null || typeof v === 'string' || typeof v === 'number'
const defaultEventName = (key) => key.slice(2).toLowerCase()

// camelCase → kebab-case para el nombre de atributo (initialZoom → initial-zoom).
const attrName = (key) => key.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()

export function applyElementProps(el, prev, next, eventNameOf = defaultEventName) {
  const before = prev ?? {}

  // Bajas: keys en `prev` que ya no están en `next`.
  Object.keys(before).filter(key => !(key in next)).forEach(key => {
    const old = before[key]
    if (isEvent(key)) { if (typeof old === 'function') el.removeEventListener(eventNameOf(key), old) }
    else if (isAttr(old)) el.removeAttribute(attrName(key))
    else el[key] = undefined                          // booleano/objeto/función → limpiar la propiedad
  })

  // Altas y cambios.
  Object.keys(next).forEach(key => {
    const value = next[key]
    const old   = before[key]
    if (value === old) return                        // referencia igual → nada que hacer
    if (isEvent(key)) {
      const ev = eventNameOf(key)
      if (typeof old === 'function') el.removeEventListener(ev, old)
      if (typeof value === 'function') el.addEventListener(ev, value)
    } else if (isAttr(value)) {
      if (value == null) el.removeAttribute(attrName(key))
      else el.setAttribute(attrName(key), String(value))
    } else {
      el[key] = value                                // booleano/objeto/función → propiedad (el dato, sin reconcile)
    }
  })

  return { ...next }
}

// detachElementListeners — teardown de DESMONTAJE: da de baja SÓLO los event listeners que quedaron
// aplicados. Entre renders el diff de applyElementProps ya desengancha lo que se fue; pero al desmontar
// no hay un `next` que diffear, y un `addEventListener` sobrevive al detach del nodo (queda enganchado
// hasta el GC del elemento). Recorre el estado aplicado y remueve cada handler por su nombre mapeado.
// Deliberadamente NO toca atributos ni propiedades: mueren con el nodo, y reasignarlos (p. ej.
// `el.data = undefined`) dispararía la reactividad del custom element sobre un elemento que ya se va.
export function detachElementListeners(el, applied, eventNameOf = defaultEventName) {
  Object.entries(applied)
    .filter(([key, value]) => isEvent(key) && typeof value === 'function')
    .forEach(([key, value]) => el.removeEventListener(eventNameOf(key), value))
}
