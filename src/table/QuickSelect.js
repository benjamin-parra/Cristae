// ── Floyd-Rivest quickselect — O(n) ───────────────────────────────────────────
//
// Particionado in-place: tras `qselect(arr, k, …)`, `arr[k]` contiene el elemento que
// estaría en la posición k de un array totalmente ordenado, y todo lo anterior a k es ≤ arr[k].
//
// Lo usa PagedTable para extraer el borde de una página en O(n) en vez de ordenar el
// dataset completo en O(n·log n). Domain-free: solo reordena por el comparador dado.

export const qselect = (arr, k, left, right, cmp) => {
  while (right > left) {
    if (right - left > 600) {
      const n = right - left + 1
      const m = k - left + 1
      const z = Math.log(n)
      const s = 0.5 * Math.exp(2 * z / 3)
      const sd = 0.5 * Math.sqrt(z * s * (n - s) / n)
               * (m - n / 2 < 0 ? -1 : 1)
      qselect(
        arr, k,
        Math.max(left, Math.floor(k - m * s / n + sd)),
        Math.min(right, Math.floor(k + (n - m) * s / n + sd)),
        cmp,
      )
    }
    const t = arr[k]
    let i = left, j = right
    swap(arr, left, k)
    if (cmp(arr[right], t) > 0) swap(arr, left, right)
    while (i < j) {
      swap(arr, i, j); i++; j--
      while (cmp(arr[i], t) < 0) i++
      while (cmp(arr[j], t) > 0) j--
    }
    if (cmp(arr[left], t) === 0) swap(arr, left, j)
    else { j++; swap(arr, j, right) }
    if (j <= k) left = j + 1
    if (k <= j) right = j - 1
  }
}

export const swap = (arr, i, j) => { const t = arr[i]; arr[i] = arr[j]; arr[j] = t }
