// Contrato de paginationModel — modelo de botones con elipsis (función pura, API pública de /table).
// Congela v0.13.0 con barrido exhaustivo current × totalPages × capacity contra invariantes de forma.
// Corre con: node --test test/pagination.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import * as paginacion from '../src/table/pagination.js'
import { paginationModel } from '../src/table/pagination.js'

// ── Utilidades de barrido ─────────────────────────────────────────────────────
// Recorre TODO el dominio (capacity × totalPages × current válido) y junta los casos que rompen
// la invariante. La invariante devuelve `null` para los casos FUERA DE ALCANCE: esos no cuentan
// como cobertura (antes se auto-cumplían devolviendo `true` e inflaban el total reportado).
const barrido = (invariante, { capMin, capMax, tpMax = 60 }) => {
  const rotos = []
  let casos = 0
  let ejercidos = 0
  for (let capacity = capMin; capacity <= capMax; capacity++)
    for (let totalPages = 1; totalPages <= tpMax; totalPages++)
      for (let current = 0; current < totalPages; current++) {
        casos++
        const model = paginationModel(current, totalPages, capacity)
        const veredicto = invariante(model, { current, totalPages, capacity })
        if (veredicto === null) continue // fuera de alcance: no es cobertura
        ejercidos++
        if (!veredicto) rotos.push({ current, totalPages, capacity, model })
      }
  return { rotos, casos, ejercidos }
}

// El dominio es determinista, así que la cantidad de casos que EJERCEN la invariante es un número
// exacto y conocido. Se exige por igualdad (no por cota `>=`, que nunca podía fallar): si alguien
// cambia el rango del barrido, el filtro de alcance o la cantidad de elipsis que emite el módulo,
// esto se rompe en vez de aprobar con menos cobertura de la que declara.
const exigir = ({ rotos, ejercidos }, ejercidosEsperados) => {
  assert.equal(ejercidos, ejercidosEsperados,
    `el barrido ejerció ${ejercidos} casos, se esperaban exactamente ${ejercidosEsperados}`)
  assert.equal(rotos.length, 0,
    `${rotos.length}/${ejercidos} casos rotos; primeros: ${JSON.stringify(rotos.slice(0, 3))}`)
}

const esElipsis = d => d.label === '...'
const paginas = m => m.filter(d => !esElipsis(d))
const entranTodas = ({ totalPages, capacity }) => totalPages <= capacity

// ── Superficie del módulo ─────────────────────────────────────────────────────
// Congela QUÉ exporta el archivo: mover el módulo o partirlo no puede sumar exports en silencio.

test('el módulo exporta exactamente { paginationModel }', () => {
  assert.deepEqual(Object.keys(paginacion).sort(), ['paginationModel'])
})

// ── Forma básica del modelo ───────────────────────────────────────────────────

test('sin páginas el modelo queda vacío', () => {
  assert.deepEqual(paginationModel(0, 0, 5), [])
})

test('cuando todas las páginas entran se listan todas y no aparece ninguna elipsis', () => {
  exigir(barrido((m, ctx) => {
    if (!entranTodas(ctx)) return null
    return m.length === ctx.totalPages
      && m.every((d, i) => d.label === i + 1 && d.pageIndex === i && d.isCurrent === (i === ctx.current))
  }, { capMin: 1, capMax: 20 }), 1540)
})

test('todo descriptor tiene exactamente las claves { label, pageIndex, isCurrent }', () => {
  exigir(barrido(m => m.every(d => {
    const claves = Object.keys(d).sort()
    return claves.length === 3
      && claves[0] === 'isCurrent' && claves[1] === 'label' && claves[2] === 'pageIndex'
  }), { capMin: 1, capMax: 20 }), 36600)
})

// Los extremos se anclan mientras haya presupuesto para el andamiaje `1 … ventana … N`; con menos
// de 5 botones el modelo degrada a una ventana corrida (ver la sección de presupuestos chicos).
test('el primer botón apunta a la primera página y el último a la última (capacity ≥ 5)', () => {
  exigir(barrido((m, { totalPages }) =>
    m[0].pageIndex === 0 && m[0].label === 1
    && m[m.length - 1].pageIndex === totalPages - 1 && m[m.length - 1].label === totalPages,
  { capMin: 5, capMax: 20 }), 29280)
})

test('el primer botón apunta a la primera y el último a la última cuando todas las páginas entran (capacity ≤ 4)', () => {
  exigir(barrido((m, ctx) => entranTodas(ctx)
    ? m[0].pageIndex === 0 && m[0].label === 1
      && m[m.length - 1].pageIndex === ctx.totalPages - 1 && m[m.length - 1].label === ctx.totalPages
    : null,
  { capMin: 1, capMax: 4 }), 20)
})

test('cada botón de página lleva la etiqueta 1-based de su pageIndex', () => {
  exigir(barrido(m => paginas(m).every(d => d.label === d.pageIndex + 1),
    { capMin: 1, capMax: 20 }), 36600)
})

test('ninguna página se repite entre los botones', () => {
  exigir(barrido(m => {
    const idx = paginas(m).map(d => d.pageIndex)
    return new Set(idx).size === idx.length
  }, { capMin: 1, capMax: 20 }), 36600)
})

test('las elipsis son a lo sumo dos y nunca se marcan como actuales', () => {
  exigir(barrido(m => {
    const e = m.filter(esElipsis)
    return e.length <= 2 && e.every(d => d.isCurrent === false)
  }, { capMin: 1, capMax: 20 }), 36600)
})

test('la marca de actual cae en el botón de la página actual y en ningún otro', () => {
  exigir(barrido((m, { current }) =>
    m.every(d => d.isCurrent === (!esElipsis(d) && d.pageIndex === current)),
  { capMin: 1, capMax: 20 }), 36600)
})

// ── Presupuesto de botones ────────────────────────────────────────────────────
// `capacity` es la cantidad de botones disponibles: el modelo no puede pedir más de los que hay.

test('el modelo nunca excede la capacidad pedida (capacity ≥ 4)', () => {
  exigir(barrido((m, { capacity }) => m.length <= capacity, { capMin: 4, capMax: 20 }), 31110)
})

test('el modelo nunca excede la capacidad pedida cuando todas las páginas entran (capacity ≤ 3)', () => {
  exigir(barrido((m, ctx) => entranTodas(ctx) ? m.length <= ctx.capacity : null,
    { capMin: 1, capMax: 3 }), 10)
})

// [T1] Antes emitía igual los 2 extremos + hasta 2 elipsis: 4 botones para un presupuesto de 1.
test('[T1] el modelo nunca excede la capacidad pedida cuando no entran todas (capacity ≤ 3)', () => {
  exigir(barrido((m, ctx) => entranTodas(ctx) ? null : m.length <= ctx.capacity,
    { capMin: 1, capMax: 3 }), 5480)
})

// ── Página actual señalizada ──────────────────────────────────────────────────
// Sin exactamente una marca la vista no sabe qué botón resaltar (y el usuario pierde el "dónde estoy").

test('exactamente un botón queda marcado como actual (capacity ≥ 5)', () => {
  exigir(barrido(m => m.filter(d => d.isCurrent).length === 1, { capMin: 5, capMax: 20 }), 29280)
})

test('exactamente un botón queda marcado como actual cuando todas las páginas entran (capacity ≤ 4)', () => {
  exigir(barrido((m, ctx) => entranTodas(ctx) ? m.filter(d => d.isCurrent).length === 1 : null,
    { capMin: 1, capMax: 4 }), 20)
})

// [T2] Antes la ventana interna se vaciaba y la actual no entraba: NINGÚN descriptor con isCurrent.
test('[T2] exactamente un botón queda marcado como actual cuando no entran todas (capacity ≤ 4)', () => {
  exigir(barrido((m, ctx) => entranTodas(ctx) ? null : m.filter(d => d.isCurrent).length === 1,
    { capMin: 1, capMax: 4 }), 7300)
})

// ── Orden y rango de los destinos ─────────────────────────────────────────────
// El pageIndex de una elipsis es un salto a un punto intermedio: debe seguir siendo una página real
// y no puede ir para atrás respecto del botón anterior.

test('todos los pageIndex caen dentro del rango de páginas (capacity ≥ 2)', () => {
  exigir(barrido((m, { totalPages }) =>
    m.every(d => Number.isInteger(d.pageIndex) && d.pageIndex >= 0 && d.pageIndex <= totalPages - 1),
  { capMin: 2, capMax: 20 }), 34770)
})

// [T3] Antes capacity 1 con totalPages 2 emitía una elipsis con pageIndex -1.
test('[T3] todos los pageIndex caen dentro del rango de páginas (capacity 1)', () => {
  exigir(barrido((m, { totalPages }) =>
    m.every(d => d.pageIndex >= 0 && d.pageIndex <= totalPages - 1),
  { capMin: 1, capMax: 1 }), 1830)
})

test('los pageIndex no decrecen a lo largo del modelo (capacity ≥ 2)', () => {
  exigir(barrido(m => m.every((d, i) => i === 0 || d.pageIndex >= m[i - 1].pageIndex),
    { capMin: 2, capMax: 20 }), 34770)
})

// [T4] Antes capacity 1 retrocedía, p.ej. totalPages 2 → [0,-1,1] y current 1 → [0,1,0,1].
test('[T4] los pageIndex no decrecen a lo largo del modelo (capacity 1)', () => {
  exigir(barrido(m => m.every((d, i) => i === 0 || d.pageIndex >= m[i - 1].pageIndex),
    { capMin: 1, capMax: 1 }), 1830)
})

test('los botones de página van estrictamente en orden creciente (capacity ≥ 3)', () => {
  exigir(barrido(m => {
    const idx = paginas(m).map(d => d.pageIndex)
    return idx.every((v, i) => i === 0 || v > idx[i - 1])
  }, { capMin: 3, capMax: 20 }), 32940)
})

// ── Destino de las elipsis ────────────────────────────────────────────────────
// La elipsis salta a la mitad del tramo que se saltea: relación entre dos valores OBSERVABLES del
// propio modelo (no una constante interna), así que un ±1 en el cálculo del destino la rompe.

test('la elipsis izquierda salta al punto medio entre la primera página y el inicio de la ventana (capacity ≥ 5)', () => {
  exigir(barrido(m => {
    if (m.length < 3 || !esElipsis(m[1])) return null // sin elipsis izquierda: fuera de alcance
    return m[1].pageIndex === m[2].pageIndex >> 1
  }, { capMin: 5, capMax: 20 }), 22612)
})

// ── Forma concreta de la ventana (congela el cálculo de tramos) ───────────────

test('cuando todas las páginas entran el modelo es la lista completa, sin claves de más', () => {
  assert.deepEqual(paginationModel(1, 4, 6), [
    { label: 1, pageIndex: 0, isCurrent: false },
    { label: 2, pageIndex: 1, isCurrent: true },
    { label: 3, pageIndex: 2, isCurrent: false },
    { label: 4, pageIndex: 3, isCurrent: false },
  ])
})

test('en el arranque la ventana abre pegada al inicio y cierra con elipsis + última', () => {
  assert.deepEqual(paginationModel(0, 20, 7), [
    { label: 1, pageIndex: 0, isCurrent: true },
    { label: 2, pageIndex: 1, isCurrent: false },
    { label: 3, pageIndex: 2, isCurrent: false },
    { label: 4, pageIndex: 3, isCurrent: false },
    { label: 5, pageIndex: 4, isCurrent: false },
    { label: '...', pageIndex: 11, isCurrent: false },
    { label: 20, pageIndex: 19, isCurrent: false },
  ])
})

test('en el medio la ventana se centra en la actual y las elipsis saltan a un punto intermedio', () => {
  assert.deepEqual(paginationModel(10, 20, 7), [
    { label: 1, pageIndex: 0, isCurrent: false },
    { label: '...', pageIndex: 4, isCurrent: false },
    { label: 10, pageIndex: 9, isCurrent: false },
    { label: 11, pageIndex: 10, isCurrent: true },
    { label: 12, pageIndex: 11, isCurrent: false },
    { label: '...', pageIndex: 15, isCurrent: false },
    { label: 20, pageIndex: 19, isCurrent: false },
  ])
})

// Con la ventana arrancando en índice PAR el destino de la elipsis izquierda distingue el ±1
// (con start impar, `start >> 1` y `(start - 1) >> 1` colapsan al mismo valor y el golden es ciego).
test('con la ventana arrancando en un índice par el destino de la elipsis izquierda queda fijo', () => {
  assert.deepEqual(paginationModel(9, 20, 7), [
    { label: 1, pageIndex: 0, isCurrent: false },
    { label: '...', pageIndex: 4, isCurrent: false },
    { label: 9, pageIndex: 8, isCurrent: false },
    { label: 10, pageIndex: 9, isCurrent: true },
    { label: 11, pageIndex: 10, isCurrent: false },
    { label: '...', pageIndex: 14, isCurrent: false },
    { label: 20, pageIndex: 19, isCurrent: false },
  ])
})

test('en la última página la ventana queda pegada al final', () => {
  assert.deepEqual(paginationModel(19, 20, 7), [
    { label: 1, pageIndex: 0, isCurrent: false },
    { label: '...', pageIndex: 7, isCurrent: false },
    { label: 16, pageIndex: 15, isCurrent: false },
    { label: 17, pageIndex: 16, isCurrent: false },
    { label: 18, pageIndex: 17, isCurrent: false },
    { label: 19, pageIndex: 18, isCurrent: false },
    { label: 20, pageIndex: 19, isCurrent: true },
  ])
})

test('la ventana avanza junto con la página actual, sin saltos de tamaño', () => {
  const largos = new Set()
  for (let current = 0; current < 40; current++) {
    const m = paginationModel(current, 40, 9)
    largos.add(m.length)
    assert.equal(m.filter(d => d.isCurrent)[0].pageIndex, current, `current ${current}`)
  }
  assert.deepEqual([...largos], [9], 'con totalPages ≫ capacity el modelo usa siempre todos los botones')
})

// ── Pureza ────────────────────────────────────────────────────────────────────
// La invariante es de IDENTIDAD, no de contenido: cada llamada arma su propio array y sus propios
// descriptores. Un memo, un acumulador global reusado o un descriptor compartido son idénticos en
// contenido (deepEqual pasa) y rompen a la vista, que mutaría el modelo de la llamada anterior.

const noComparteNada = (a, b) => {
  assert.notEqual(a, b, 'el array devuelto no puede ser el mismo objeto entre llamadas')
  a.forEach((d, i) => assert.notEqual(d, b[i], `el descriptor ${i} no puede ser el mismo objeto`))
}

test('cada llamada devuelve un modelo propio, sin objetos compartidos (rama con elipsis)', () => {
  const a = paginationModel(13, 47, 8)
  const b = paginationModel(13, 47, 8)
  noComparteNada(a, b)
  a[0].label = 'tocado'
  assert.equal(paginationModel(13, 47, 8)[0].label, 1, 'mutar el resultado contaminó la siguiente llamada')
})

test('cada llamada devuelve un modelo propio, sin objetos compartidos (rama de listado completo)', () => {
  const a = paginationModel(1, 4, 6)
  const b = paginationModel(1, 4, 6)
  noComparteNada(a, b)
  a[0].label = 'tocado'
  a[2].isCurrent = true
  assert.deepEqual(paginationModel(1, 4, 6)[0], { label: 1, pageIndex: 0, isCurrent: false },
    'mutar el resultado contaminó la siguiente llamada')
  assert.equal(paginationModel(1, 4, 6)[2].isCurrent, false)
})

test('la misma entrada produce siempre el mismo contenido (sin estado interno entre llamadas)', () => {
  // Sólo puede fallar por no-determinismo: la identidad la cubren los dos tests de arriba.
  paginationModel(3, 9, 5)
  paginationModel(0, 100, 7)
  assert.deepEqual(paginationModel(13, 47, 8), paginationModel(13, 47, 8))
})
