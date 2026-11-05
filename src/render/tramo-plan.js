// Planificador puro de tramos: decide qué miembros GL comparten contexto. Lo usa el gestor
// (`gl-tramos.js`) al montar y al replanificar; no toca DOM ni GL. No asigna por token: la única
// memoria auxiliar es `stamp`, de módulo, que crece cuando un id no entra.

export const SEPARATOR = -1

let stamp = new Int32Array(64)     // stamp[id] === round ⇔ el id ya rotula un segmento de este plan
let round = 0

// Orden de los panes: out[k] = índice de entrada del k-ésimo por z ascendente. Inserción estable:
// los empates conservan el orden de entrada (el del DOM). Son pocos panes.
export const orderByZ = (z, count, out) => {
  for (let i = 0; i < count; i++) {
    const zi = z[i]
    let j    = i - 1
    while (j >= 0 && z[out[j]] > zi) {
      out[j + 1] = out[j]
      j--
    }
    out[j + 1] = i
  }
  return out
}

// tokens en orden K ascendente: índice de miembro (≥ 0) o SEPARATOR. prev[m]: id de tramo actual del
// miembro m, o -1 si es nuevo; precondición: prev[m] < nextId. Escribe en out[i] el id del token i
// (-1 en separadores) y devuelve el próximo id libre.
//
// Una corrida es una secuencia máxima sin separador; dentro de ella, un segmento es una secuencia de
// miembros viejos con el mismo prev, que los nuevos intercalados no cortan. Cada id rotula a lo sumo un
// segmento: lo conserva el primero en orden K y los siguientes con el mismo prev reciben uno fresco
// (partir un tramo deja el id abajo). Un nuevo toma el id de abajo en su corrida, si no el de arriba, y
// si la corrida no tiene viejos todos sus nuevos comparten uno fresco. Dos segmentos adyacentes con ids
// distintos no se funden.
export const planTramos = (tokens, count, prev, nextId, out) => {
  if (++round === 0x7fffffff) {
    stamp.fill(0)
    round = 1
  }
  let start = 0                    // primer token de la corrida en curso
  let seg   = -1                   // prev del segmento en curso; -1: la corrida aún no tiene viejos
  let id    = -1                   // id resuelto del segmento en curso
  for (let i = 0; i <= count; i++) {
    const m = i < count ? tokens[i] : SEPARATOR
    if (m === SEPARATOR) {
      // Cierre de corrida: si no tuvo viejos, sus nuevos comparten un id fresco.
      if (seg < 0 && start < i) {
        for (let k = start; k < i; k++) out[k] = nextId
        nextId++
      }
      if (i < count) out[i] = SEPARATOR
      start = i + 1
      seg   = id = -1
      continue
    }
    const p = prev[m]
    if (p >= 0 && p !== seg) {
      if (p >= stamp.length) {
        const grown = new Int32Array(Math.max(p + 1, stamp.length * 2))
        grown.set(stamp)
        stamp = grown
      }
      // Los nuevos de abajo del primer segmento de la corrida esperaban el id de arriba: éste.
      const head = seg < 0
      id         = stamp[p] === round ? nextId++ : p
      stamp[p]   = round
      seg        = p
      if (head)
        for (let k = start; k < i; k++) out[k] = id
    }
    out[i] = id                    // un nuevo antes del primer segmento queda en -1 hasta el relleno
  }
  return nextId
}
