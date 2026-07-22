// Búsqueda binaria del PUNTO DE PARTICIÓN sobre un array ordenado ascendente. Pura y sin dominio:
// la comparten las dos capas de hit-test (polígonos, líneas) para saltar en O(log n) los items cuyo
// bbox queda del todo a un lado del punto de consulta. Un solo bucle; el BORDE del rango (estricto vs
// inclusivo) lo fija el comparador que pasa cada caller, así que las dos semánticas viven en un lugar.

// Índice del primer elemento que ya NO queda "antes" del punto, según `before(item, value)`. `arr` debe
// estar ordenado de modo que `before` sea monótono sobre él (true…true false…false). Devuelve `lo` en
// [0, arr.length]: todos los previos cumplen `before` (se descartan); desde ahí en adelante, no.
export const lowerBoundBy = (arr, value, before) => {
  let lo = 0, hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (before(arr[mid], value)) lo = mid + 1
    else hi = mid
  }
  return lo
}
