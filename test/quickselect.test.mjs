// Contrato de qselect — quickselect Floyd-Rivest in-place que usa PagedTable para sacar el borde
// de una página sin ordenar el dataset entero. Se congela v0.13.0 contra un oráculo (`Array#sort`).
// Corre con: node --test test/quickselect.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import * as quickselect from '../src/table/QuickSelect.js'
import { qselect, swap } from '../src/table/QuickSelect.js'

// ── Aleatoriedad determinista ─────────────────────────────────────────────────
// LCG con semilla: mismos 500 casos en cada corrida (nada de Math.random).
const lcg = seed => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296)
const entero = (rnd, max) => Math.floor(rnd() * max)

const num = (a, b) => a - b

// Token estable por elemento. Serializar con `String` es una trampa: TODO objeto colapsa a
// "[object Object]" y el multiconjunto pasa a cumplirse solo. Los objetos van por JSON.
const tokenDe = x => (x !== null && typeof x === 'object' ? JSON.stringify(x) : String(x))
const multiset = (a, cmp = num, clave = tokenDe) => [...a].sort(cmp).map(clave).join('|')

// Huella determinista de una permutación concreta (posición incluida): sirve de golden para
// congelar QUÉ orden deja el algoritmo, no solo que el resultado sea correcto.
const huella = a => a.reduce((h, v, i) => (h * 31 + v * (i + 1)) % 2147483647, 7)

// Verifica el contrato completo sobre una selección ya ejecutada.
// `arr` se muta in-place, así que el oráculo se calcula ANTES.
// `seleccionar` es inyectable SOLO para poder probar que este verificador tiene dientes.
const verificar = (arr, k, cmp = num, ctx = '', { clave = tokenDe, seleccionar = qselect } = {}) => {
  const original = [...arr]
  const ordenado = [...arr].sort(cmp)
  seleccionar(arr, k, 0, arr.length - 1, cmp)

  assert.equal(cmp(arr[k], ordenado[k]), 0, `arr[k] no es el k-ésimo del orden total ${ctx}`)
  assert.equal(arr.length, original.length, `cambió la longitud ${ctx}`)
  assert.equal(multiset(arr, cmp, clave), multiset(original, cmp, clave),
    `no es una permutación de la entrada ${ctx}`)
  for (let i = 0; i < k; i++)
    assert.ok(cmp(arr[i], arr[k]) <= 0, `arr[${i}] > arr[k] ${ctx}`)
  for (let i = k + 1; i < arr.length; i++)
    assert.ok(cmp(arr[i], arr[k]) >= 0, `arr[${i}] < arr[k] ${ctx}`)
  return arr
}

// ── Superficie del módulo ─────────────────────────────────────────────────────
// Congela QUÉ exporta el archivo: mover el módulo o partirlo no puede sumar exports en silencio.

test('el módulo exporta exactamente { qselect, swap }', () => {
  assert.deepEqual(Object.keys(quickselect).sort(), ['qselect', 'swap'])
})

// ── El verificador tiene dientes ──────────────────────────────────────────────
// `verificar` concentra los asertos de casi todos los tests de este archivo: si se rompiera
// (un return temprano, un k mal pasado, un multiconjunto vacuo) todos quedarían verdes en silencio.
// Cada sabotaje ataca UNO de sus asertos y tiene que hacerlo fallar.

test('verificar detecta un selector saboteado (guarda del punto único de fallo)', () => {
  const rompe = (arr, k, seleccionar, cmp = num) =>
    assert.throws(() => verificar(arr, k, cmp, 'sabotaje', { seleccionar }), assert.AssertionError)

  rompe([3, 1, 2], 1, () => {})                        // no selecciona: arr[k] no es el k-ésimo
  rompe([1, 2, 3], 0, a => { a.pop() })                // pierde un elemento: cambia la longitud
  rompe([1, 2, 3], 0, a => { a[2] = 1 })               // pisa un valor: no es una permutación
  rompe([1, 2, 3], 1, a => { a.reverse() })            // arr[k] correcto pero el prefijo queda por arriba
  rompe([{ v: 1 }, { v: 2 }], 0, a => { a[1] = { v: 2, x: 9 } }, (a, b) => a.v - b.v) // objetos: el
  // multiconjunto tiene que distinguirlos (con String todos serían "[object Object]" y pasaría)
})

// ── swap ──────────────────────────────────────────────────────────────────────

test('swap intercambia dos posiciones y deja el resto intacto', () => {
  const a = [10, 20, 30, 40]
  swap(a, 0, 3)
  assert.deepEqual(a, [40, 20, 30, 10])
  swap(a, 1, 1)
  assert.deepEqual(a, [40, 20, 30, 10], 'intercambiar una posición consigo misma no cambia nada')
})

// La superficie de retorno es parte del contrato: ambas mutan in-place y NO devuelven nada.
// Quien las llame no puede empezar a encadenar sobre un valor que hoy no existe.
test('swap y qselect mutan in-place y devuelven undefined', () => {
  const a = [5, 3, 1, 4]
  assert.equal(swap(a, 0, 1), undefined, 'swap no devuelve valor')
  assert.equal(qselect(a, 2, 0, a.length - 1, num), undefined, 'qselect no devuelve valor')
  const grande = Array.from({ length: 700 }, (_, i) => (i * 7) % 700)
  assert.equal(qselect(grande, 350, 0, grande.length - 1, num), undefined,
    'tampoco devuelve valor por la rama Floyd-Rivest')
})

// ── Barrido aleatorio ─────────────────────────────────────────────────────────
// 500 casos con semilla fija; uno de cada ocho es GRANDE (n ≥ 602) para entrar a la rama
// Floyd-Rivest (recursión sobre una muestra), que solo se activa con rango > 600.

test('500 casos aleatorios: arr[k] es el k-ésimo del orden y el prefijo queda por debajo', () => {
  const rnd = lcg(20240613)
  let grandes = 0, conEmpates = 0
  for (let c = 0; c < 500; c++) {
    const grande = c % 8 === 0
    const n = grande ? 602 + entero(rnd, 900) : 1 + entero(rnd, 80)
    // Rango de valores chico a propósito: fuerza empates (el caso que rompe a los comparadores sin desempate).
    const rango = 1 + entero(rnd, grande ? 2000 : 30)
    const arr = Array.from({ length: n }, () => entero(rnd, rango))
    if (new Set(arr).size < n) conEmpates++
    if (grande) grandes++
    verificar(arr, entero(rnd, n), num, `#${c} n=${n}`)
  }
  // Conteos EXACTOS (la semilla es fija): si alguien toca el generador o el reparto de casos, se
  // rompe acá en vez de seguir corriendo con menos cobertura de la que el test dice tener.
  assert.equal(grandes, 63, 'casos que entran a la rama Floyd-Rivest')
  assert.equal(conEmpates, 474, 'casos con valores repetidos')
})

// ── Rama Floyd-Rivest ─────────────────────────────────────────────────────────
// El umbral es `right - left > 600`: con 601 elementos NO entra, con 602 sí. Ambos lados del
// borde deben cumplir el mismo contrato.

test('el umbral de 600 no cambia el contrato: 601 y 602 elementos se comportan igual', () => {
  const rnd = lcg(99)
  for (const n of [600, 601, 602, 603]) {
    const base = Array.from({ length: n }, () => entero(rnd, 5000))
    for (const k of [0, 1, n >> 1, n - 2, n - 1])
      verificar([...base], k, num, `n=${n} k=${k}`)
  }
})

// El contrato es indistinguible a ambos lados del umbral, así que la ÚNICA forma de congelar dónde
// está el umbral (y que la rama siga existiendo, y con qué muestreo) es la permutación resultante.
// Golden de v0.13.0: n=80 y n=601 quedan del lado corto, n=602 y n=1500 entran a Floyd-Rivest.
// Si el refactor cambia deliberadamente el muestreo, recalcular estas huellas es parte del cambio.
test('la permutación está congelada a ambos lados del umbral (golden v0.13.0)', () => {
  const goldens = [[80, 1581656477], [601, 182977460], [602, 1169603661], [1500, 357362792]]
  for (const [n, esperada] of goldens) {
    const rnd = lcg(20250701 + n)
    const arr = Array.from({ length: n }, () => entero(rnd, 5000))
    qselect(arr, n >> 1, 0, n - 1, num)
    assert.equal(huella(arr), esperada,
      `n=${n}: cambió la permutación (¿se movió el umbral, se borró la rama Floyd-Rivest o cambió el muestreo?)`)
  }
})

test('la rama Floyd-Rivest sobrevive a un array grande con muchísimos empates', () => {
  const rnd = lcg(4242)
  const arr = Array.from({ length: 1500 }, () => entero(rnd, 3))
  verificar(arr, 750, num, 'n=1500 con 3 valores distintos')
})

// ── Casos borde ───────────────────────────────────────────────────────────────

test('con todos los elementos iguales cualquier k cumple el contrato', () => {
  for (const n of [1, 50, 700])
    verificar(Array(n).fill(7), n >> 1, num, `n=${n}`)
})

// Con valores idénticos cualquier permutación pasa desapercibida, así que "queda intacto" no se
// puede afirmar. Lo que SÍ es contrato con un comparador que empata siempre: no se pierde ni se
// duplica ninguna fila (por eso las filas llevan id y el comparador ignora todo).
test('con un comparador que empata siempre no se pierde ni se duplica ninguna fila', () => {
  const empata = () => 0
  for (const n of [1, 50, 700]) {
    const arr = Array.from({ length: n }, (_, i) => ({ id: i }))
    qselect(arr, n >> 1, 0, n - 1, empata)
    assert.equal(arr.length, n, `n=${n}: cambió la longitud`)
    assert.equal(new Set(arr.map(o => o.id)).size, n, `n=${n}: se perdió o duplicó una fila`)
  }
})

test('un array ya ordenado queda ordenado tras seleccionar', () => {
  for (const n of [50, 700]) {
    const arr = Array.from({ length: n }, (_, i) => i)
    verificar(arr, n >> 2, num, `n=${n}`)
    assert.deepEqual(arr, Array.from({ length: n }, (_, i) => i), 'no debería reordenar lo ya ordenado')
  }
})

test('un array en orden inverso se selecciona igual', () => {
  for (const n of [50, 700]) {
    const arr = Array.from({ length: n }, (_, i) => n - 1 - i)
    verificar(arr, n - 10, num, `n=${n}`)
  }
})

test('con un solo elemento la selección es la identidad', () => {
  const arr = [42]
  verificar(arr, 0, num, 'n=1')
  assert.deepEqual(arr, [42])
})

test('k = 0 deja el mínimo y k = n-1 deja el máximo', () => {
  const rnd = lcg(31337)
  for (const n of [2, 37, 700]) {
    const base = Array.from({ length: n }, () => entero(rnd, 1000))
    const min = Math.min(...base), max = Math.max(...base)
    const a = verificar([...base], 0, num, `min n=${n}`)
    const b = verificar([...base], n - 1, num, `max n=${n}`)
    assert.equal(a[0], min)
    assert.equal(b[n - 1], max)
  }
})

// ── El comparador manda ───────────────────────────────────────────────────────

test('el orden lo define el comparador: descendente selecciona el k-ésimo mayor', () => {
  const desc = (a, b) => b - a
  const arr = Array.from({ length: 700 }, (_, i) => i)
  verificar(arr, 9, desc, 'descendente')
  assert.equal(arr[9], 690, 'el décimo mayor de 0..699')
})

test('funciona con objetos y comparador por campo (el caso real de la tabla)', () => {
  const cmp = (a, b) => a.v - b.v
  const arr = Array.from({ length: 800 }, (_, i) => ({ id: i, v: (i * 37) % 800 }))
  const ordenado = [...arr].sort(cmp)
  qselect(arr, 123, 0, arr.length - 1, cmp)
  assert.equal(arr[123].v, ordenado[123].v)
  assert.equal(new Set(arr.map(o => o.id)).size, 800, 'no se pierde ni se duplica ningún objeto')
})

// ── Empates: valores sí, identidad no ─────────────────────────────────────────
// qselect promete el k-ésimo VALOR, no una fila concreta: con un comparador que empata, cuál de
// las filas equivalentes queda en k es indistinto. Quien pagine sobre esto necesita desempatar por id.

test('con empates el prefijo tiene el mismo multiconjunto de valores que el orden total', () => {
  const rnd = lcg(777)
  const cmp = (a, b) => a.v - b.v
  for (let c = 0; c < 40; c++) {
    const n = 20 + entero(rnd, 200)
    const arr = Array.from({ length: n }, (_, i) => ({ id: i, v: entero(rnd, 4) }))
    const ordenado = [...arr].sort(cmp)
    const k = entero(rnd, n)
    qselect(arr, k, 0, n - 1, cmp)
    assert.deepEqual(
      arr.slice(0, k + 1).map(o => o.v).sort(num),
      ordenado.slice(0, k + 1).map(o => o.v).sort(num),
      `#${c} n=${n} k=${k}`,
    )
  }
})

// ── Subrango ──────────────────────────────────────────────────────────────────
// PagedTable llama `qselect(buffer, end - 1, start, total - 1, cmp)`: la selección tiene que
// quedarse dentro de [left, right] y no tocar lo que ya se seleccionó antes.

test('seleccionar en un subrango no toca los elementos de afuera', () => {
  const rnd = lcg(1024)
  for (let c = 0; c < 60; c++) {
    const n = 20 + entero(rnd, 80)
    const arr = Array.from({ length: n }, () => entero(rnd, 100))
    const original = [...arr]
    const left = entero(rnd, n - 5)
    const right = left + 1 + entero(rnd, n - left - 1)
    const k = left + entero(rnd, right - left + 1)
    qselect(arr, k, left, right, num)

    for (let i = 0; i < n; i++)
      if (i < left || i > right)
        assert.equal(arr[i], original[i], `#${c} posición ${i} fuera de [${left},${right}] fue movida`)

    const trozo = original.slice(left, right + 1).sort(num)
    assert.equal(arr[k], trozo[k - left], `#${c} arr[k] no es el k-ésimo del subrango`)
    for (let i = left; i < k; i++)
      assert.ok(arr[i] <= arr[k], `#${c} prefijo del subrango desordenado`)
  }
})

test('dos selecciones encadenadas dejan la página [start, end) completa y en su lugar', () => {
  const rnd = lcg(555)
  const total = 700, start = 200, end = 250
  const buffer = Array.from({ length: total }, () => entero(rnd, 10000))
  const ordenado = [...buffer].sort(num)

  qselect(buffer, start, 0, total - 1, num)
  qselect(buffer, end - 1, start, total - 1, num)

  assert.deepEqual(buffer.slice(start, end).sort(num), ordenado.slice(start, end),
    'la ventana seleccionada debe contener exactamente los mismos valores que el orden total')
})

// ── Determinismo ──────────────────────────────────────────────────────────────

test('la misma entrada produce siempre la misma permutación', () => {
  const rnd = lcg(8080)
  const base = Array.from({ length: 900 }, () => entero(rnd, 500))
  const a = [...base], b = [...base]
  qselect(a, 400, 0, base.length - 1, num)
  qselect(b, 400, 0, base.length - 1, num)
  assert.deepEqual(a, b)
})
