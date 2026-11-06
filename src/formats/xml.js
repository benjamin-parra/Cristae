// Tokenizador XML pull sobre bytes, sin construir nodos: entrega eventos con RANGOS de nombre, de
// atributos y de texto. Lo usan KML y GPX. Contrato en DISENO-INTEROP §2.6: sin DTD, sólo las cinco
// entidades predefinidas y las referencias numéricas, y un documento mal formado es error.

import { FormatError } from './core/error.js'
import { bomSkip } from './core/input.js'

export const EOF = 0, START = 1, END = 2, TEXT = 3

const encoder = new TextEncoder()

export const names = pairs => pairs.map(([name, code]) => [encoder.encode(name), code])

export const WS = new Uint8Array(256)
;[9, 10, 13, 32].forEach(c => { WS[c] = 1 })

// NameStartChar (2) y NameChar (1) de XML 1.0 §2.3, por byte: todo byte ≥ 0x80 se admite, porque
// validar los rangos de Unicode exige decodificar y un nombre raro no cambia ninguna lectura.
const NAME = new Uint8Array(256)
for (let c = 0; c < 256; c++)
  NAME[c] = c >= 0x80 || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 58 ? 2
    : (c >= 48 && c <= 57) || c === 45 || c === 46 ? 1
    : 0

// Lo único que una referencia puede valer dentro de un número: espacio en blanco o un carácter de la
// gramática decimal, más la coma que separa ordenadas en KML (§2.6).
const NUMERIC = new Uint8Array(128)
'0123456789+-.eE,\t\n\r '.split('').forEach(c => { NUMERIC[c.charCodeAt(0)] = 1 })

const PREDEFINED = names([['lt', 60], ['gt', 62], ['amp', 38], ['apos', 39], ['quot', 34]])
const DOCTYPE    = encoder.encode('DOCTYPE')
const CDATA      = encoder.encode('[CDATA[')

const ENCODINGS = new Map([
  ['utf-8', 'utf-8'], ['utf8', 'utf-8'], ['us-ascii', 'utf-8'], ['ascii', 'utf-8'],
  ['iso-8859-1', 'windows-1252'], ['latin1', 'windows-1252'], ['windows-1252', 'windows-1252'],
])

const isChar = cp =>
  cp === 9 || cp === 10 || cp === 13 || (cp >= 0x20 && cp <= 0xD7FF) ||
  (cp >= 0xE000 && cp <= 0xFFFD) || (cp >= 0x10000 && cp <= 0x10FFFF)

const lookup = (bytes, from, to, table) => {
  const len = to - from
  for (let n = 0; n < table.length; n++) {
    const want = table[n][0]
    if (want.length !== len) continue
    let k = len
    while (k-- && bytes[from + k] === want[k]);
    if (k < 0) return table[n][1]
  }
  return 0
}

const startsWith = (bytes, k, to, seq) => {
  if (k + seq.length > to) return false
  let m = seq.length
  while (m-- && bytes[k + m] === seq[m]);
  return m < 0
}

// Resuelve la referencia que empieza en `k` (el `&`). Devuelve el punto de código y deja en `end[0]`
// el índice siguiente al `;`. Una entidad que no es predefinida, o un carácter que no es `Char`, es
// 'sintaxis' (XML 1.0 §4.1, WFC: Entity Declared; §2.2).
const reference = (bytes, k, to, format, end) => {
  let j  = k + 1
  let cp = 0
  if (bytes[j] === 35) {
    const hex = bytes[++j] === 120
    hex && j++
    const first = j
    for (; j < to; j++) {
      const c = bytes[j]
      const d = c >= 48 && c <= 57 ? c - 48
        : hex && c >= 97 && c <= 102 ? c - 87
        : hex && c >= 65 && c <= 70 ? c - 55
        : -1
      if (d < 0) break
      cp = Math.min(cp * (hex ? 16 : 10) + d, 0x110000)
    }
    if (j === first || bytes[j] !== 59 || !isChar(cp)) throw new FormatError(format, 'sintaxis', k)
  } else {
    while (j < to && j - k < 6 && bytes[j] !== 59) j++
    cp = bytes[j] === 59 ? lookup(bytes, k + 1, j, PREDEFINED) : 0
    if (!cp) throw new FormatError(format, 'sintaxis', k)
  }
  end[0] = j + 1
  return cp
}

const TEXT_MODE = 0, CDATA_MODE = 2
export const ATTRIBUTE_MODE = 1

// Texto materializado. En un atributo, cada espacio en blanco literal pasa a ser un espacio (XML 1.0
// §3.3.3); en un CDATA no hay referencias que resolver. Una secuencia inválida en la codificación es
// 'codificacion', nunca un U+FFFD silencioso.
export const xmlText = (bytes, from, to, encoding, format, mode = TEXT_MODE) => {
  const decoder = new TextDecoder(encoding, { fatal: true })
  const end     = [0]
  const decode  = (a, b) => {
    try { return decoder.decode(bytes.subarray(a, b)) }
    catch { throw new FormatError(format, 'codificacion', a) }
  }
  if (mode === CDATA_MODE) return decode(from, to)

  let text = ''
  let run  = from
  for (let k = from; k < to; k++) {
    if (bytes[k] !== 38) continue
    text += decode(run, k) + String.fromCodePoint(reference(bytes, k, to, format, end))
    run   = end[0]
    k     = run - 1
  }
  text += decode(run, to)
  return mode === ATTRIBUTE_MODE ? text.replace(/[\t\n\r]/g, ' ') : text
}

// Opciones comunes de los lectores XML (DISENO §1.5). La pista se acota a lo que el documento PUEDE
// contener, como en readGeoJson.
export const xmlOptions = (options, bytes, format) => {
  const maxDepth = options.maxDepth ?? 512
  const hint     = options.capacityHint
  if (!Number.isInteger(maxDepth) || maxDepth < 1) throw new FormatError(format, 'entrada')
  if (hint !== undefined && hint !== null && (!Number.isInteger(hint) || hint < 1))
    throw new FormatError(format, 'entrada')
  return {
    maxDepth,
    capacityHint : hint ? Math.min(hint, bytes.length) : (bytes.length / 32) | 0,
    bounds       : !!options.bounds,
  }
}

// Con `encoding` dado es modo fragmento: se tokeniza UN elemento que el lector ya validó (el rango de
// un `Placemark` para `propertiesOf`), sin prólogo, y el cierre que vuelve al nivel 0 termina.
export const createXml = (bytes, format, maxDepth, from = 0, to = bytes.length, encoding = null) => {
  const fragment = encoding !== null
  const fail     = (code, at) => { throw new FormatError(format, code, at) }
  const end      = [0]

  let stack   = new Int32Array(Math.min(maxDepth, 64) * 2)
  let attrs   = new Int32Array(32)
  let scratch = new Uint8Array(64)
  let i       = from
  let level   = 0
  let pending = false
  let rooted  = false
  let done    = false

  // El estado del evento vive en el objeto y se sobrescribe en cada `next`: no hay un objeto por
  // evento. `name0..name1` es el nombre LOCAL, después del último `:`.
  const x = {
    kind      : EOF,
    depth     : 0,
    name0     : 0,
    name1     : 0,
    tag0      : 0,
    tag1      : 0,
    text0     : 0,
    text1     : 0,
    refs      : false,
    cdata     : false,
    attrCount : 0,
    encoding  : encoding ?? 'utf-8',
    gBytes    : bytes,
    gFrom     : 0,
    gTo       : 0,
    gAt       : 0,
  }

  const find = (seq, k) => {
    for (const last = to - seq.length; k <= last; k++)
      if (startsWith(bytes, k, to, seq)) return k
    return fail('truncado', to)
  }

  // Devuelve el fin del nombre y deja en `end[0]` la posición de su último `:` (o `k - 1`).
  const name = k => {
    k < to || fail('truncado', to)
    NAME[bytes[k]] === 2 || fail('sintaxis', k)
    let colon = k - 1
    for (; k < to && NAME[bytes[k]]; k++) bytes[k] === 58 && (colon = k)
    end[0] = colon
    return k
  }

  const space = k => {
    while (k < to && WS[bytes[k]]) k++
    k < to || fail('truncado', to)
    return k
  }

  // BOM de UTF-8 saltado sin desplazar offsets, UTF-16 rechazado, y la declaración XML con su
  // `encoding` (DISENO §2.6). El marcado es ASCII en las cuatro codificaciones aceptadas.
  const prolog = () => {
    const a = bytes[from], b = bytes[from + 1]
    if ((a === 0xFE && b === 0xFF) || (a === 0xFF && b === 0xFE) || (a === 60 && b === 0) || (a === 0 && b === 60))
      fail('codificacion', from)
    i = from + bomSkip(bytes.subarray(from, to))
    if (!startsWith(bytes, i, to, encoder.encode('<?xml')) || !WS[bytes[i + 5]]) return

    const stop  = find([63, 62], i)
    const decl  = new TextDecoder('latin1').decode(bytes.subarray(i, stop))
    const label = /\sencoding\s*=\s*(["'])([^"']*)\1/.exec(decl)?.[2].toLowerCase()
    if (label) x.encoding = ENCODINGS.get(label) ?? fail('codificacion', i)
    i = stop + 2
  }

  // Valida cada referencia al pasar: después las coordenadas se resuelven sin volver a validar.
  const text = () => {
    let j    = i
    let refs = false
    for (; j < to && bytes[j] !== 60; j++) {
      if (bytes[j] !== 38) continue
      refs = true
      reference(bytes, j, to, format, end)
      j = end[0] - 1
    }
    if (!level)
      for (let k = i; k < j; k++) WS[bytes[k]] || fail('sintaxis', k)
    x.kind  = TEXT
    x.depth = level
    x.text0 = i
    x.text1 = j
    x.refs  = refs
    x.cdata = false
    i = j
    return level > 0
  }

  const open = () => {
    if (!level && rooted && !fragment) fail('sintaxis', i)
    const q1    = name(i + 1)
    const local = end[0] + 1
    let n     = 0
    let k     = q1
    let empty = false
    for (;;) {
      const s = space(k)
      const c = bytes[s]
      if (c === 62) { k = s + 1; break }
      if (c === 47) {
        s + 1 < to || fail('truncado', to)
        bytes[s + 1] === 62 || fail('sintaxis', s)
        k     = s + 2
        empty = true
        break
      }
      s > k || fail('sintaxis', s)

      const a1    = name(s)
      const eq    = space(a1)
      bytes[eq] === 61 || fail('sintaxis', eq)
      const v0    = space(eq + 1) + 1
      const quote = bytes[v0 - 1]
      quote === 34 || quote === 39 || fail('sintaxis', v0 - 1)
      let v1 = v0
      for (; v1 < to && bytes[v1] !== quote; v1++) {
        bytes[v1] === 60 && fail('sintaxis', v1)
        if (bytes[v1] !== 38) continue
        reference(bytes, v1, to, format, end)
        v1 = end[0] - 1
      }
      v1 < to || fail('truncado', to)
      // Un atributo repetido rompe la buena formación (XML 1.0 §3.1, WFC: Unique Att Spec).
      for (let m = 0; m < n; m++)
        attrs[m * 4 + 1] - attrs[m * 4] === a1 - s && startsWith(bytes, s, a1, bytes.subarray(attrs[m * 4], attrs[m * 4 + 1])) &&
          fail('sintaxis', s)
      if (attrs.length < (n + 1) * 4) {
        const next = new Int32Array(attrs.length * 2)
        next.set(attrs)
        attrs = next
      }
      attrs[n * 4]     = s
      attrs[n * 4 + 1] = a1
      attrs[n * 4 + 2] = v0
      attrs[n * 4 + 3] = v1
      n++
      k = v1 + 1
    }
    level + 1 > maxDepth && fail('profundidad', i)
    if (stack.length < (level + 1) * 2) {
      const next = new Int32Array(stack.length * 2)
      next.set(stack)
      stack = next
    }
    stack[level * 2]     = i + 1
    stack[level * 2 + 1] = q1
    level++
    rooted      = true
    pending     = empty
    x.kind      = START
    x.depth     = level
    x.name0     = local
    x.name1     = q1
    x.tag0      = i
    x.tag1      = k
    x.attrCount = n
    i = k
  }

  const close = () => {
    const q1    = name(i + 2)
    const local = end[0] + 1
    const k     = space(q1)
    bytes[k] === 62 || fail('sintaxis', k)
    level || fail('sintaxis', i)
    const s0 = stack[(level - 1) * 2], s1 = stack[(level - 1) * 2 + 1]
    s1 - s0 === q1 - i - 2 && startsWith(bytes, i + 2, q1, bytes.subarray(s0, s1)) || fail('sintaxis', i)
    x.kind  = END
    x.depth = level
    x.name0 = local
    x.name1 = q1
    x.tag0  = i
    x.tag1  = k + 1
    i = k + 1
    --level || (done = fragment)
  }

  x.next = () => {
    if (pending) {
      pending = false
      x.kind  = END
      x.depth = level
      --level || (done = fragment)
      return END
    }
    for (;;) {
      if (done) return x.kind = EOF
      if (i >= to) {
        level && fail('truncado', to)
        rooted || fragment || fail('sintaxis', to)
        return x.kind = EOF
      }
      if (bytes[i] !== 60) {
        if (text()) return TEXT
        continue
      }
      i + 1 < to || fail('truncado', to)
      const c = bytes[i + 1]
      if (c === 47) {
        close()
        return END
      }
      if (c === 63) {
        // `<?xml` fuera del comienzo es una PI con nombre reservado (XML 1.0 §2.6).
        const t = name(i + 2)
        t - i === 5 && (bytes[i + 2] | 32) === 120 && (bytes[i + 3] | 32) === 109 && (bytes[i + 4] | 32) === 108 &&
          fail('sintaxis', i)
        i = find([63, 62], t) + 2
        continue
      }
      if (c !== 33) {
        open()
        return START
      }
      if (bytes[i + 2] === 45 && bytes[i + 3] === 45) {
        i = find([45, 45, 62], i + 4) + 3
        continue
      }
      startsWith(bytes, i + 2, to, CDATA) ||
        fail(startsWith(bytes, i + 2, to, DOCTYPE) ? 'dtd' : i + 9 > to ? 'truncado' : 'sintaxis', i)
      level || fail('sintaxis', i)
      const stop = find([93, 93, 62], i + 9)
      x.kind  = TEXT
      x.depth = level
      x.text0 = i + 9
      x.text1 = stop
      x.refs  = false
      x.cdata = true
      i = stop + 3
      return TEXT
    }
  }

  x.code = table => lookup(bytes, x.name0, x.name1, table)

  // Índice del atributo del elemento abierto con ese nombre LOCAL, o −1.
  x.attr = want => {
    for (let m = 0; m < x.attrCount; m++) {
      const a1 = attrs[m * 4 + 1]
      let a = attrs[m * 4]
      for (let k = a; k < a1; k++) bytes[k] === 58 && (a = k + 1)
      if (a1 - a === want.length && startsWith(bytes, a, a1, want)) return m
    }
    return -1
  }

  x.attrFrom = m => attrs[m * 4 + 2]
  x.attrTo   = m => attrs[m * 4 + 3]
  x.attrText = m => xmlText(bytes, attrs[m * 4 + 2], attrs[m * 4 + 3], x.encoding, format, ATTRIBUTE_MODE)

  x.skip = () => {
    const d = x.depth
    while (x.next() !== END || x.depth !== d);
  }

  // Contenido de texto del elemento abierto: los tramos de texto y de CDATA de todos sus
  // descendientes, en orden y con las referencias resueltas.
  x.text = () => {
    const d = x.depth
    let out = ''
    while (x.next() !== END || x.depth !== d)
      if (x.kind === TEXT) out += xmlText(bytes, x.text0, x.text1, x.encoding, format, x.cdata ? CDATA_MODE : TEXT_MODE)
    return out
  }

  const put = (a, b, fill, resolve) => {
    if (scratch.length < fill + b - a) {
      const next = new Uint8Array(Math.max(scratch.length * 2, fill + b - a))
      next.set(scratch.subarray(0, fill))
      scratch = next
    }
    for (let k = a; k < b; k++) {
      let c = bytes[k]
      if (resolve && c === 38) {
        c = reference(bytes, k, b, format, end)
        c < 128 && NUMERIC[c] || fail('numero', k)
        k = end[0] - 1
      }
      scratch[fill++] = c
    }
    return fill
  }

  const settle = (b0, b1, fill) => {
    x.gBytes = fill < 0 ? bytes : scratch
    x.gFrom  = fill < 0 ? b0 : 0
    x.gTo    = fill < 0 ? b1 : fill
  }

  // Contenido numérico del elemento abierto (coordenadas, `ele`) SIN materializar texto. Un solo tramo
  // sin referencias se lee en sitio. Si viene partido por comentarios, CDATA o referencias, los tramos
  // se copian a un buffer de trabajo que se reusa entre elementos. El resultado queda en
  // `gBytes[gFrom..gTo)`, y `gAt` es el offset que se reporta cuando el error cae en el buffer.
  x.gather = () => {
    const d = x.depth
    let b0 = 0, b1 = 0, fill = -1, segments = 0
    x.gAt = x.tag1
    while (x.next() !== END || x.depth !== d) {
      x.kind === START && fail('estructura', x.tag0)
      if (!segments++ && !x.refs) {
        b0 = x.text0
        b1 = x.text1
        continue
      }
      fill < 0 && (fill = put(b0, b1, 0, false))
      fill = put(x.text0, x.text1, fill, x.refs)
    }
    settle(b0, b1, fill)
  }

  // Lo mismo para un valor de atributo (el `lat` de GPX).
  x.attrNumber = m => {
    const v0 = attrs[m * 4 + 2], v1 = attrs[m * 4 + 3]
    let refs = false
    for (let k = v0; k < v1 && !refs; k++) refs = bytes[k] === 38
    x.gAt = v0
    settle(v0, v1, refs ? put(v0, v1, 0, true) : -1)
  }

  fragment || prolog()
  return x
}
