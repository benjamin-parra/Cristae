// Escáner JSON de los lectores de TopoJSON y EsriJSON (DISENO-INTEROP §2, paquete d): valida la
// gramática de RFC 8259 sobre los bytes y entrega rangos y números, sin construir el grafo de
// `JSON.parse`. El lector decide qué recorre: lo que no interpreta lo salta con `skip`.

import { FormatError } from './core/error.js'
import { scanNumber, JSON_GRAMMAR } from './core/number.js'

const encoder = new TextEncoder()

// Tabla de nombres: los bytes para comparar sin decodificar y el mapa para la clave que trajo escapes.
export const names = pairs => ({
  list : pairs.map(([name, code]) => [encoder.encode(name), code]),
  map  : new Map(pairs),
})

const WS     = new Uint8Array(256)
const ESCAPE = new Uint8Array(256)
const HEX    = new Uint8Array(256)
;[9, 10, 13, 32].forEach(c => { WS[c] = 1 })
'"\\/bfnrtu'.split('').forEach(c => { ESCAPE[c.charCodeAt(0)] = 1 })
'0123456789abcdefABCDEF'.split('').forEach(c => { HEX[c.charCodeAt(0)] = 1 })

export const digit = c => c >= 48 && c <= 57

export const grown = (arr, need) => {
  if (need <= arr.length) return arr
  const next = new arr.constructor(Math.max(need, arr.length * 2))
  next.set(arr)
  return next
}

// §1.5: las dos cotas son opciones públicas, así que lo que no es un entero ≥ 1 es 'entrada'.
export const limits = (options, format) => {
  const maxDepth = options.maxDepth ?? 512
  const maxBytes = options.maxBytes ?? 268435456
  Number.isInteger(maxDepth) && maxDepth >= 1 && Number.isInteger(maxBytes) && maxBytes >= 1 ||
    fail(format, 'entrada')
  return { maxDepth, maxBytes }
}

const fail = (format, code, at = -1, hint = null) => { throw new FormatError(format, code, at, hint) }

export const createScanner = (bytes, format, maxDepth) => {
  const len = bytes.length
  const out = new Float64Array(2)
  let stack = new Uint8Array(Math.min(maxDepth, 64)), decoder = null

  const stop = (code, at) => fail(format, code, at)
  const ws   = i => {
    while (i < len && WS[bytes[i]]) i++
    return i
  }
  // Lo que falta al final es 'truncado'; lo que sobra o no corresponde, 'sintaxis'.
  const need = (i, ok) => ok || stop(i >= len ? 'truncado' : 'sintaxis', i)

  const string = i => {
    let j = i + 1, esc = 0
    while (j < len && bytes[j] !== 34) {
      const c = bytes[j]
      if (c === 92) {
        const e = j + 1 < len ? bytes[j + 1] : 0
        need(j + 1, ESCAPE[e])
        esc = 1
        if (e === 117) {
          for (let k = j + 2; k < j + 6; k++) need(k, k < len && HEX[bytes[k]])
          j += 6
        } else j += 2
        continue
      }
      c < 32 && stop('sintaxis', j)
      j++
    }
    j >= len && stop('truncado', i)
    sc.from = i + 1
    sc.to   = j
    sc.esc  = esc
    return j + 1
  }

  const literal = i => {
    const c    = bytes[i]
    const word = c === 116 ? 'true' : c === 102 ? 'false' : 'null'
    for (let k = 0; k < word.length; k++) need(i + k, i + k < len && bytes[i + k] === word.charCodeAt(k))
    return i + word.length
  }

  // Sólo la gramática: el valor de un número saltado no se calcula.
  const skipNumber = i => {
    let j = i
    bytes[j] === 45 && j++
    if (bytes[j] === 48) j++
    else if (digit(bytes[j])) while (digit(bytes[j])) j++
    else return need(j, false)
    if (bytes[j] === 46) {
      j++
      need(j, digit(bytes[j]))
      while (digit(bytes[j])) j++
    }
    if (bytes[j] === 101 || bytes[j] === 69) {
      j++
      ;(bytes[j] === 43 || bytes[j] === 45) && j++
      need(j, digit(bytes[j]))
      while (digit(bytes[j])) j++
    }
    return j
  }

  const colon = i => {
    i = ws(i)
    need(i, bytes[i] === 58)
    return ws(i + 1)
  }

  // Salta un valor entero validándolo, en un bucle y no en recursión: `maxDepth` es opción pública y
  // con una cota alta la recursión desbordaría la pila (§1.5). `d` es la profundidad que tendría el
  // valor si fuera contenedor.
  const skip = (i, d) => {
    let top = 0
    for (;;) {
      i = ws(i)
      need(i, i < len)
      const c = bytes[i]
      let closed = 1
      if (c === 123 || c === 91) {
        d + top > maxDepth && stop('profundidad', i)
        if (top === stack.length) {
          const next = new Uint8Array(Math.min(maxDepth + 1, stack.length * 2))
          next.set(stack)
          stack = next
        }
        stack[top++] = c
        i = ws(i + 1)
        need(i, i < len)
        if (bytes[i] === c + 2) {
          top--
          i++
        } else {
          c === 123 && (need(i, bytes[i] === 34), i = colon(string(i)))
          closed = 0
        }
      } else if (c === 34) i = string(i)
      else if (c === 116 || c === 102 || c === 110) i = literal(i)
      else i = skipNumber(i)

      if (!closed) continue
      for (;;) {
        if (top === 0) return i
        i = ws(i)
        need(i, i < len)
        if (bytes[i] === stack[top - 1] + 2) {
          top--
          i++
          continue
        }
        need(i, bytes[i] === 44)
        i = ws(i + 1)
        stack[top - 1] === 123 && (need(i, bytes[i] === 34), i = colon(string(i)))
        break
      }
    }
  }

  // Recorre un objeto: `cb(v)` recibe el comienzo del valor con la clave en `sc.from`/`sc.to` y
  // devuelve el índice siguiente al valor. Un valor que no es objeto es 'estructura'.
  const members = (i, d, cb) => {
    i = ws(i)
    need(i, i < len)
    bytes[i] === 123 || stop('estructura', i)
    d > maxDepth && stop('profundidad', i)
    i = ws(i + 1)
    if (bytes[i] === 125) return i + 1
    for (;;) {
      need(i, bytes[i] === 34)
      i = ws(cb(colon(string(i))))
      if (bytes[i] === 125) return i + 1
      need(i, bytes[i] === 44)
      i = ws(i + 1)
    }
  }

  // Igual para un array: `cb(v, n)` con `n` el índice del elemento.
  const elements = (i, d, cb) => {
    i = ws(i)
    need(i, i < len)
    bytes[i] === 91 || stop('estructura', i)
    d > maxDepth && stop('profundidad', i)
    i = ws(i + 1)
    if (bytes[i] === 93) return i + 1
    for (let n = 0; ; n++) {
      need(i, i < len)
      i = ws(cb(i, n))
      if (bytes[i] === 93) return i + 1
      need(i, bytes[i] === 44)
      i = ws(i + 1)
    }
  }

  // Un número convertido. `-1` de `scanNumber` es un token que no es número de JSON.
  const number = i => {
    const j = scanNumber(bytes, i, len, JSON_GRAMMAR, out)
    j === -2 && stop('numero', i)
    j === -1 && stop(i >= len ? 'truncado' : digit(bytes[i]) || bytes[i] === 45 ? 'sintaxis' : 'posicion', i)
    out[1] && sc.slow++
    sc.value = out[0]
    return j
  }

  // Una posición: hasta 4 ordenadas en `sc.pos` y su cantidad real en `sc.n`. Con `nulls`, una
  // ordenada desde la tercera puede ser `null`, que queda NaN (la M sin dato de EsriJSON). [0-alloc]
  const pos = new Float64Array(4)
  const position = (i, d, nulls) => {
    i = ws(i)
    need(i, i < len)
    bytes[i] === 91 || stop('posicion', i)
    d > maxDepth && stop('profundidad', i)
    let n = 0
    i = ws(i + 1)
    need(i, i < len)
    if (bytes[i] !== 93) for (;;) {
      need(i, i < len)
      let v = NaN
      if (nulls && n >= 2 && bytes[i] === 110) i = literal(i)
      else {
        i = number(i)
        v = sc.value
      }
      n < 4 && (pos[n] = v)
      n++
      i = ws(i)
      if (bytes[i] === 93) break
      need(i, bytes[i] === 44)
      i = ws(i + 1)
    }
    sc.n = n
    return i + 1
  }

  // El texto de la última cadena leída, con los escapes deshechos.
  const text = () => {
    const raw = (decoder ??= new TextDecoder()).decode(bytes.subarray(sc.from, sc.to))
    return sc.esc ? JSON.parse(`"${raw}"`) : raw
  }

  // El código de la última cadena leída en una tabla de `names`, o 0.
  const code = table => {
    if (sc.esc) return table.map.get(text()) ?? 0
    const n = sc.to - sc.from
    for (const [want, value] of table.list) {
      if (want.length !== n) continue
      let k = n
      while (k-- && bytes[sc.from + k] === want[k]);
      if (k < 0) return value
    }
    return 0
  }

  const sc = {
    from: 0, to: 0, esc: 0, value: 0, n: 0, slow: 0, pos,
    len, fail: stop, ws, need, string, literal, skip, members, elements, number, position, text, code,
  }
  return sc
}
