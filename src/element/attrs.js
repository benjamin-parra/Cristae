// Coerción de atributos de custom-element: string del atributo → valor utilizable, agnóstico del
// elemento. Cada helper acepta la forma CRUDA (converter vía atributo) Y la ya parseada (asignación
// por propiedad, donde el converter de Lit NO corre) — reusable por cualquier elemento de la lib.

// Lee un par numérico desde un atributo string ("[8,12]", "8,12") → [x, y], o null si no parsea.
export const parsePair = (v) => {
  if (Array.isArray(v)) return v
  const nums = String(v).match(/-?\d+(?:\.\d+)?/g)?.map(Number)
  return nums && nums.length >= 2 ? [nums[0], nums[1]] : null
}

// Lee una LISTA de tokens desde un atributo string ("flip shift clip" → ['flip','shift','clip']).
// Lista-valuada al estilo de las props CSS `position-try-fallbacks` / `touch-action`. La usan
// `fit` y `for`. Nil-safe: ausente → [].
export const parseTokens = (v) => (Array.isArray(v) ? v : String(v ?? '').trim().split(/\s+/).filter(Boolean))

// Converter de `fit`: atributo removido (null) o vacío ⇒ null — el elemento VUELVE al camino
// legacy (auto-pan + clip) en vez de quedar en un modo fit sin etapas. Ver `updated`.
export const fitFromAttribute = (v) => {
  if (v == null) return null
  const tokens = parseTokens(v)
  return tokens.length ? tokens : null
}

// Convierte un atributo booleano "presente = ON, default ON": ausente → undefined (tratado como ON);
// `"false"`/`"0"` → OFF. Reactivo al valor, no al timing.
export const boolDefaultOn = { fromAttribute: (v) => v !== 'false' && v !== '0' }

// Lectura del booleano "default ON" en el punto de uso: asignado como PROPIEDAD el valor llega
// crudo (el converter solo corre para atributos) — apaga cualquier falsy explícito y los strings
// del converter; ausente (null/undefined) queda ON.
export const boolOff = (v) => v != null && (!v || v === 'false' || v === '0')

// Posición geográfica utilizable → { lat, lng } numéricos, o null. Único guard de posición del
// elemento: coerciona strings (el resto del motor los tolera; un backend que serializa números
// como string no debe dejar la tarjeta sin abrir) y descarta lo no finito.
export const finitePos = (p) => {
  const lat = Number(p?.lat), lng = Number(p?.lng)
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null
}
