// Lectores de los atributos de <cristae-terrain-layer>: cadena del atributo → valor utilizable,
// puros y sin DOM. Como en attrs.js, cada uno acepta la forma CRUDA (converter de atributo) y la
// ya parseada (asignación por propiedad, donde el converter de Lit no corre); lo ilegible da null.
// El orden y el tope de los cortes los valida el motor, no estos lectores.

const NUMERO = /^[+-]?(?:\d+\.?\d*|\.\d+)$/
const GRADOS = /^([+-]?(?:\d+\.?\d*|\.\d+))(?:°|deg)$/i
const PORCENTAJE = /^([+-]?(?:\d+\.?\d*|\.\d+))%$/

// 90° es la vertical: su tangente no es un corte representable.
const GRADOS_VERTICAL = 90
const RAD_POR_GRADO = Math.PI / 180

// Parte por espacios o comas de nivel superior, sin cortar dentro de paréntesis (rgb(1, 2, 3)).
const tokensDeNivelSuperior = texto => {
  const tokens = []
  let profundidad = 0, inicio = -1
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i]
    if (c === '(') profundidad++
    else if (c === ')') profundidad = Math.max(0, profundidad - 1)
    const separador = profundidad === 0 && (c === ',' || /\s/.test(c))
    if (separador) {
      if (inicio >= 0) tokens.push(texto.slice(inicio, i))
      inicio = -1
    } else if (inicio < 0) inicio = i
  }
  if (inicio >= 0) tokens.push(texto.slice(inicio))
  return tokens
}

// Un corte de pendiente → razón m/m (la unidad de relief()), o null. "15%" = 0.15, "17°"/"17deg" =
// tan(17°), "0.3" = 0.3. No admite negativos ni la vertical.
const corteARazon = token => {
  let razon
  const g = GRADOS.exec(token), p = PORCENTAJE.exec(token)
  if (g) {
    const grados = Number(g[1])
    razon = grados >= 0 && grados < GRADOS_VERTICAL ? Math.tan(grados * RAD_POR_GRADO) : NaN
  } else if (p) razon = Number(p[1]) / 100
  else if (NUMERO.test(token)) razon = Number(token)
  else return null
  return Number.isFinite(razon) && razon >= 0 ? razon : null
}

// "15% 30%" / "17° 30%, 0.8" → [0.15, 0.3…] en razón m/m. Un arreglo de números pasa tal cual.
export const parseSlopeBreaks = v => {
  if (Array.isArray(v)) return v.length && v.every(n => Number.isFinite(n)) ? v : null
  if (typeof v !== 'string') return null
  const tokens = tokensDeNivelSuperior(v)
  if (!tokens.length) return null
  const razones = []
  for (const t of tokens) {
    const r = corteARazon(t)
    if (r === null) return null
    razones.push(r)
  }
  return razones
}

// "#a6d96a #fdae61 rgb(215, 25, 28)" → tokens CSS sin partir rgb(…). Un arreglo de cadenas pasa
// tal cual. La validez del color la decide quien lo lee (color.js), no este lector.
export const parseSlopeColors = v => {
  if (Array.isArray(v)) return v.length && v.every(c => typeof c === 'string' && c.trim()) ? v : null
  if (typeof v !== 'string') return null
  const tokens = tokensDeNivelSuperior(v)
  return tokens.length ? tokens : null
}

// "200 600" → [200, 600] en metros (admite coma y negativos); un par numérico pasa tal cual.
export const parseElevationRange = v => {
  let nums
  if (Array.isArray(v)) nums = v
  else if (typeof v === 'string') {
    const tokens = tokensDeNivelSuperior(v)
    if (!tokens.every(t => NUMERO.test(t))) return null
    nums = tokens.map(Number)
  } else return null
  return nums.length === 2 && nums.every(n => typeof n === 'number' && Number.isFinite(n)) ? [nums[0], nums[1]] : null
}

// Un nombre de preset ("aws") queda como nombre; un JSON ("{…}") se parsea a objeto; un objeto por
// propiedad pasa tal cual. JSON inválido o vacío → null, sin lanzar.
export const parseDem = v => {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v
  if (typeof v !== 'string') return null
  const texto = v.trim()
  if (!texto) return null
  if (!texto.includes('{')) return texto
  try {
    const obj = JSON.parse(texto)
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null
  } catch { return null }
}

// Hillshade de tres estados: ausente → undefined (automático), "false"/"0" → false, presente → true.
export const hillshadeAttr = v => {
  if (v === undefined || v === null) return undefined
  return !(v === false || v === 'false' || v === '0')
}
