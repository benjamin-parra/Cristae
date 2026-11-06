// Lector de números exacto (SPECS §17.5, DISENO-INTEROP §2.2): paridad bit a bit con `Number(texto)`
// sin decodificar el token salvo en el respaldo.

export const JSON_GRAMMAR = 0, DECIMAL_GRAMMAR = 1

export const POW10 = Array.from({ length: 23 }, (_, k) => Number('1e' + k))
const SPLIT        = 134217729          // 2^27 + 1
export const LIMB  = 900719925474099    // el mayor valor al que todavía se le puede anexar un dígito bajo 2^53

// Los dígitos que no entran en la mantisa de 2^53 van a un segundo limbo exacto: el valor es
// `a·10^nb + b`, una suma no evaluada de dos doubles que se divide corrigiendo por el residuo con las
// transformaciones de Dekker. El alcance son ~31 dígitos significativos; pasados, el llamador delega
// en `Number`, al que el estándar obliga a redondear correctamente.
export const joinLimbs = (a, b, nb, dec, neg) => {
  const p    = a * POW10[nb]
  const ca   = SPLIT * a, ah = ca - (ca - a), al = a - ah
  const t    = POW10[nb], ct = SPLIT * t, th = ct - (ct - t), tl = t - th
  const perr = ((ah * th - p) + ah * tl + al * th) + al * tl
  const s    = p + b, db = s - p
  const lo   = (p - (s - db)) + (b - db) + perr
  const P    = POW10[dec]
  const q    = s / P
  const cq   = SPLIT * q, qh = cq - (cq - q)
  const cp   = SPLIT * P, ph = cp - (cp - P)
  const qp   = q * P
  const err  = ((qh * ph - qp) + qh * (P - ph) + (q - qh) * ph) + (q - qh) * (P - ph)
  const v    = q + (((s - qp) - err) + lo) / P
  return neg ? -v : v
}

const isDigit = d => d >= 48 && d <= 57
const isAlnum = d => isDigit(d) || ((d | 0x20) >= 97 && (d | 0x20) <= 122)

// `NaN`, `INF` e `Infinity` de la gramática decimal (`xsd:double`), sin distinguir mayúsculas: se
// reconocen para rechazarlos con −2 como cualquier no finito, y no como un «no es número».
const SPECIAL = ['nan', 'infinity', 'inf']
const special = (bytes, j, end) => SPECIAL.some(word => {
  if (j + word.length > end) return false
  for (let k = 0; k < word.length; k++)
    if ((bytes[j + k] | 0x20) !== word.charCodeAt(k)) return false
  return !(j + word.length < end && isAlnum(bytes[j + word.length]))
})

// JSON (RFC 8259 §6): `-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?`.
// Decimal (`xsd:double`, WKT): `[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?`.
// Devuelve el índice siguiente al número, −1 si en `i` no empieza uno de la gramática o −2 si el valor
// no es finito. `out[0]` es el valor y `out[1]` vale 1 si salió del camino de Clinger. [0-alloc] salvo
// el respaldo en `Number`.
export const scanNumber = (bytes, i, end, grammar, out) => {
  let j = i
  let d = j < end ? bytes[j] : 0
  const neg = d === 45
  if (neg || (d === 43 && grammar === DECIMAL_GRAMMAR)) { j++; d = j < end ? bytes[j] : 0 }

  if (grammar === DECIMAL_GRAMMAR && !isDigit(d) && d !== 46 && special(bytes, j, end)) {
    out[0] = NaN
    out[1] = 1
    return -2
  }

  const intFrom = j
  let a = 0, b = 0, nb = 0, extra = 0, dec = 0
  while (isDigit(d) && a < LIMB) { a = a * 10 + (d - 48); j++; d = j < end ? bytes[j] : 0 }
  while (isDigit(d)) {
    nb < 15 ? (b = b * 10 + (d - 48), nb++) : extra++
    j++; d = j < end ? bytes[j] : 0
  }
  const intDigits = j - intFrom
  if (grammar === JSON_GRAMMAR && (intDigits === 0 || (intDigits > 1 && bytes[intFrom] === 48))) return -1

  let fracDigits = 0
  if (d === 46) {
    j++; d = j < end ? bytes[j] : 0
    while (isDigit(d) && a < LIMB && nb === 0) { a = a * 10 + (d - 48); dec++; fracDigits++; j++; d = j < end ? bytes[j] : 0 }
    while (isDigit(d)) {
      nb < 15 ? (b = b * 10 + (d - 48), nb++) : extra++
      dec++; fracDigits++; j++; d = j < end ? bytes[j] : 0
    }
    if (grammar === JSON_GRAMMAR && fracDigits === 0) return -1
  }
  if (intDigits + fracDigits === 0) return -1

  const exponent = d === 101 || d === 69
  if (exponent) {
    let k = j + 1
    k < end && (bytes[k] === 43 || bytes[k] === 45) && k++
    if (!(k < end && isDigit(bytes[k]))) return -1
    while (k < end && isDigit(bytes[k])) k++
    j = k
  }

  let v = 0
  if (!nb && !exponent && dec <= 22) {
    v = neg ? -(a / POW10[dec]) : a / POW10[dec]
    out[1] = 0
  } else {
    out[1] = 1
    if (!extra && !exponent && dec <= 22) v = joinLimbs(a, b, nb, dec, neg)
    else {
      let text = ''
      for (let k = i; k < j; k++) text += String.fromCharCode(bytes[k])
      v = Number(text)
    }
  }
  out[0] = v
  return Number.isFinite(v) ? j : -2
}
