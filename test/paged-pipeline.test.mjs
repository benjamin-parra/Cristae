// Suite de CONTRATO de PagedTable (src/table/PagedTable.js) — congela el pipeline observable:
//   dataset → where → text-search → comparator → slice de página → pool DOM + callbacks.
// El oráculo es la versión naif del pipeline (filter/filter/sort/slice): cualquier reescritura del
// camino caliente (quickselect, workingSet reusado, ventana virtual) tiene que seguir dando lo mismo.
// Corre con: node --test test/paged-pipeline.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { flushRaf, intersectionObservers, resizeObservers, datasetCrudo } from '../test-helpers/dom-stub.mjs'
import { PagedTable } from '../src/table/PagedTable.js'

// ── Contador de asertos (para reportar cobertura real de la suite) ──
let ASERTOS = 0
const is = (a, b, msg) => { ASERTOS++; assert.strictEqual(a, b, msg) }
const eq = (a, b, msg) => { ASERTOS++; assert.deepStrictEqual(a, b, msg) }
const ok = (cond, msg) => { ASERTOS++; assert.ok(cond, msg) }
process.on('exit', () => console.log(`# asertos ejecutados: ${ASERTOS}`))

// ── Datos deterministas: LCG con semilla, nada de Math.random/Date.now ──
const lcg = semilla => () => (semilla = (semilla * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
const LETRAS = 'abc'

const mkDataset = (n, semilla = 7) => {
  const rnd = lcg(semilla)
  return Array.from({ length: n }, (_, i) => {
    const letra = LETRAS[(rnd() * LETRAS.length) | 0]
    return { id: i, nombre: `fila-${String(i).padStart(3, '0')}-${letra}`, valor: (rnd() * 1000) | 0 }
  })
}

// Orden TOTAL (desempate por id): sin empates el slice de cada página es único.
const POR_VALOR = (a, b) => a.valor - b.valor || a.id - b.id
const NOMBRE_DE = it => it.nombre

// ── Montaje: la fila expone id y rowNumber en el DOM para poder auditar el render ──
const TEMPLATE = '<div class="fila"><span data-ref="id"></span><span data-ref="num"></span></div>'

const mount = (opts = {}) => {
  const scrollElement = document.createElement('div')
  const container = document.createElement('div')
  scrollElement.appendChild(container)
  // Viewport gigante por default: la ventana virtual cubre la página entera y el DOM es auditable.
  scrollElement.clientHeight = opts.clientHeight ?? 100000
  const slices = []
  const pages = []
  const binds = []
  const table = new PagedTable({
    container,
    scrollElement,
    template: TEMPLATE,
    binder: (refs, item, rowNumber) => {
      refs.id.textContent = String(item.id)
      refs.num.textContent = String(rowNumber)
      binds.push({ id: item.id, rowNumber })
    },
    // Se guarda el array TAL CUAL lo recibe el consumidor (sin copia defensiva): copiarlo acá
    // borraría el contrato de propiedad del slice — un motor que reusara un único buffer pasaría
    // desapercibido. Ver 'cada slice es un array nuevo…'.
    onSlice: (rows, meta) => slices.push({ rows, meta }),
    onPage: info => pages.push(info),
    ...opts,
  })
  return { table, container, scrollElement, slices, pages, binds }
}

// El contenedor es [spacerTop, ...filas, spacerBottom].
const filasDom = container => container.children.slice(1, -1)
const idsDom = container => filasDom(container).map(fila => Number(fila.children[0].textContent))
const rowIdxDom = container => filasDom(container).map(fila => fila.dataset.rowIdx)
const ids = filas => filas.map(f => f.id)

// ── Oráculo naif: la definición de la vista, sin ninguna optimización ──
const oraculo = (data, { where = null, search = '', searchBy = null, comparator = null } = {}) => {
  const q = (search ?? '').trim().toLowerCase()
  let vista = data
  if (where) vista = vista.filter(where)
  if (q && searchBy) vista = vista.filter(it => String(searchBy(it) ?? '').toLowerCase().includes(q))
  vista = vista.slice()
  if (comparator) vista.sort(comparator)
  return vista
}

// ────────────────────────────────────────────────────────────────────────────
test('el slice de cada página es filter → search → sort → slice del oráculo', async () => {
  const WHERES = [null, it => it.id % 3 !== 0]
  const BUSQUEDAS = ['', 'a']
  const CMPS = [null, POR_VALOR]

  for (const n of [0, 1, 7, 40]) {
    const data = mkDataset(n)
    for (const where of WHERES)
      for (const search of BUSQUEDAS)
        for (const comparator of CMPS)
          for (const pageSize of [3, 7, 25]) {
            const caso = `n=${n} where=${where ? 'sí' : 'no'} q="${search}" cmp=${comparator ? 'sí' : 'no'} ps=${pageSize}`
            const { table, container, slices } = mount({ comparator, pageSize, where, searchBy: NOMBRE_DE })
            table.setData(data)
            if (search) table.setSearch(search)
            await flushRaf()

            const esperado = oraculo(data, { where, search, searchBy: NOMBRE_DE, comparator })
            const paginas = Math.ceil(esperado.length / pageSize) || 1

            for (let p = 0; p < paginas; ++p) {
              table.setPage(p)
              await flushRaf()
              const tramo = esperado.slice(p * pageSize, (p + 1) * pageSize)
              eq(ids(slices.at(-1).rows), ids(tramo), `slice ${caso} p=${p}`)
              eq(idsDom(container), ids(tramo), `DOM ${caso} p=${p}`)
              eq(rowIdxDom(container), tramo.map((_, i) => String(p * pageSize + i + 1)), `rowIdx ${caso} p=${p}`)
              eq(table.getPageInfo(), {
                page: esperado.length ? p : 0,
                pageSize,
                total: esperado.length,
                pages: paginas,
                offset: (esperado.length ? p : 0) * pageSize,
              }, `pageInfo ${caso} p=${p}`)
            }
            table.destroy()
          }
  }
})

test('el barrido de páginas de un dataset grande reconstruye la vista ordenada completa', async () => {
  const data = mkDataset(137, 91)
  const pageSize = 10
  const { table, slices } = mount({ comparator: POR_VALOR, pageSize })
  table.setData(data)
  await flushRaf()

  const esperado = oraculo(data, { comparator: POR_VALOR })
  const visto = []
  for (let p = 0; p < 14; ++p) { table.setPage(p); await flushRaf(); visto.push(...slices.at(-1).rows) }

  eq(ids(visto), ids(esperado), 'la unión ordenada de las 14 páginas == dataset ordenado')
  is(table.getPageInfo().pages, 14, 'pages = ceil(137/10)')
})

// El comparator con empates NO es un orden total: quickselect particiona por rango y el borde de
// página queda ambiguo, así que hay filas que salen en dos páginas y otras que no salen en ninguna.
// Repro medido hoy (75 filas, grupo = id % 5, pageSize 10): 75 visibles → 59 distintas,
// 16 duplicadas, 16 nunca mostradas. Con desempate por id: 75 / 0 / 0 (test más abajo).
// El CONTEO sí es correcto aun con empates, así que va como test normal: si quedara dentro del
// `{ todo }` de T1 no protegería nada (un `{ todo }` desactiva el test entero).
const EMPATADO = Array.from({ length: 75 }, (_, i) => ({ id: i, grupo: i % 5 }))

const barrerPaginas = async (table, slices, paginas) => {
  const visto = []
  for (let p = 0; p < paginas; ++p) { table.setPage(p); await flushRaf(); visto.push(...slices.at(-1).rows) }
  return visto
}

test('con empates el barrido de páginas igual sirve 75 filas (el conteo no depende del desempate)', async () => {
  const { table, slices } = mount({ pageSize: 10, comparator: (a, b) => a.grupo - b.grupo })
  table.setData(EMPATADO)
  await flushRaf()

  const visto = await barrerPaginas(table, slices, 8)
  is(visto.length, 75, 'las 8 páginas suman 75 filas (7×10 + 5)')
  ok(visto.every(fila => EMPATADO.includes(fila)), 'y todas son referencias del dataset')
})

test('T1 — recorrer todas las páginas muestra el universo completo, sin duplicados ni perdidos', async () => {
  const { table, slices } = mount({ pageSize: 10, comparator: (a, b) => a.grupo - b.grupo })
  table.setData(EMPATADO)
  await flushRaf()

  const distintos = new Set(ids(await barrerPaginas(table, slices, 8)))
  is(distintos.size, 75, 'todas distintas (sin duplicados entre páginas)')
  eq(EMPATADO.filter(d => !distintos.has(d.id)).map(d => d.id), [], 'ninguna fila queda sin mostrarse')
})

// El desempate del render es el ÍNDICE DEL DATASET, no cualquiera: la vista con empates es la misma
// que daría un sort estable del dataset filtrado. Sin fijarlo, un desempate arbitrario (por posición
// dentro del workingSet ya reordenado, o por identidad) también pasaría el test de universo completo
// pero devolvería un orden distinto en cada barrido.
test('T1 — con empates la vista es el sort ESTABLE del dataset (desempate por índice)', async () => {
  const pageSize = 10
  const { table, slices } = mount({ pageSize, comparator: (a, b) => a.grupo - b.grupo })
  table.setData(EMPATADO)
  await flushRaf()

  // Referencia: sort estable del dataset por grupo (Array#sort es estable desde ES2019).
  const esperado = EMPATADO.slice().sort((a, b) => a.grupo - b.grupo)
  eq(ids(await barrerPaginas(table, slices, 8)), ids(esperado), 'el barrido reconstruye el orden estable')

  // Y una segunda pasada da lo mismo: el particionado no arrastra estado entre barridos.
  eq(ids(await barrerPaginas(table, slices, 8)), ids(esperado), 'segundo barrido idéntico al primero')
})

test('con desempate el mismo dataset empatado sí cubre el universo exacto', async () => {
  const data = Array.from({ length: 75 }, (_, i) => ({ id: i, grupo: i % 5 }))
  const pageSize = 10
  const { table, slices } = mount({ pageSize, comparator: (a, b) => a.grupo - b.grupo || a.id - b.id })
  table.setData(data)
  await flushRaf()

  const visto = []
  for (let p = 0; p < 8; ++p) { table.setPage(p); await flushRaf(); visto.push(...slices.at(-1).rows) }

  is(visto.length, 75, 'se renderizan 75 filas')
  is(new Set(ids(visto)).size, 75, 'sin duplicados')
  eq(ids(visto), ids(oraculo(data, { comparator: (a, b) => a.grupo - b.grupo || a.id - b.id })), 'orden global exacto')
})

// indexOf/pageOf resuelven la posición con `#matches`, una implementación PARALELA a la membresía
// de `#mergeAndFilter`. Este test las mantiene sincronizadas: si una deriva, la página que reporta
// `pageOf` deja de ser la página donde `itemAtRow` devuelve la fila.
test('pageOf/indexOf coinciden con la página y la fila donde itemAtRow devuelve el ítem', async () => {
  for (const comparator of [null, POR_VALOR])
    for (const where of [null, it => it.id % 4 !== 0])
      for (const search of ['', 'b']) {
        const data = mkDataset(53, 31)
        const pageSize = 6
        const { table, slices } = mount({ comparator, pageSize, where, searchBy: NOMBRE_DE })
        table.setData(data)
        if (search) table.setSearch(search)
        await flushRaf()

        const esperado = oraculo(data, { where, search, searchBy: NOMBRE_DE, comparator })
        const paginas = Math.ceil(esperado.length / pageSize) || 1
        for (let p = 0; p < paginas; ++p) {
          table.setPage(p)
          await flushRaf()
          slices.at(-1).rows.forEach((fila, i) => {
            const rowNumber = p * pageSize + i + 1
            is(table.indexOf(fila), rowNumber - 1, `indexOf == rango global (p=${p} i=${i})`)
            is(table.pageOf(fila), p, `pageOf == página que la muestra (p=${p} i=${i})`)
            is(table.itemAtRow(rowNumber), fila, `itemAtRow(indexOf+1) == la fila (p=${p} i=${i})`)
          })
        }

        // Lo que el filtro excluye no tiene posición.
        const fuera = data.filter(it => !esperado.includes(it))
        if (fuera.length) {
          is(table.indexOf(fuera[0]), -1, 'ítem filtrado → indexOf -1')
          is(table.pageOf(fuera[0]), -1, 'ítem filtrado → pageOf -1')
        }
        is(table.indexOf({ ...data[0] }), -1, 'copia ajena al dataset → -1 (la identidad es por referencia)')
        table.destroy()
      }
})

// El rango de indexOf es "cuántas filas visibles ordenan ESTRICTAMENTE antes": con empates todo el
// bloque comparte rango (dentro del bloque la posición no está definida). Acá se fija SÓLO indexOf —
// con empates, qué página termina mostrando la fila es otra historia (ver T1).
test('con empates indexOf devuelve el rango del bloque empatado', async () => {
  const data = Array.from({ length: 20 }, (_, i) => ({ id: i, grupo: i % 4 }))
  const { table } = mount({ pageSize: 5, comparator: (a, b) => a.grupo - b.grupo })
  table.setData(data)
  await flushRaf()

  data.forEach(it => is(table.indexOf(it), it.grupo * 5, `id ${it.id}: rango = filas de los grupos previos`))
})

// Dos payloads públicos y DISTINTOS: getPageInfo() lleva pageSize, la meta de onSlice no.
test('PageInfo y SliceMeta congelan formas distintas', async () => {
  const { table, slices, pages } = mount({ pageSize: 5 })
  table.setData(mkDataset(12))
  await flushRaf()

  eq(Object.keys(table.getPageInfo()), ['page', 'pageSize', 'total', 'pages', 'offset'], 'forma de PageInfo')
  eq(Object.keys(slices.at(-1).meta), ['page', 'pages', 'total', 'offset'], 'forma de SliceMeta (sin pageSize)')
  eq(pages.at(-1), { page: 0, pageSize: 5, total: 12, pages: 3, offset: 0 }, 'onPage emite un PageInfo')

  table.setPage(2)
  await flushRaf()
  eq(slices.at(-1).meta, { page: 2, pages: 3, total: 12, offset: 10 }, 'offset = página × pageSize')
  is(slices.at(-1).rows.length, 2, 'la última página trae el resto')
})

test('sin filas: pages 1, total 0, offset 0 y viewport vacío', async () => {
  const { table, container, slices } = mount({ pageSize: 5 })
  table.setData([])
  await flushRaf()

  eq(slices.at(-1).rows, [], 'slice vacío')
  eq(slices.at(-1).meta, { page: 0, pages: 1, total: 0, offset: 0 }, 'meta del caso vacío')
  eq(table.getPageInfo(), { page: 0, pageSize: 5, total: 0, pages: 1, offset: 0 }, 'pages nunca es 0')
  is(filasDom(container).length, 0, 'sin filas en el DOM')
  is(container.children[0].style.height, '0px', 'spacer superior colapsado')
  is(container.children.at(-1).style.height, '0px', 'spacer inferior colapsado')
  is(table.itemAtRow(1), null, 'itemAtRow fuera de rango → null')
})

// El número de fila es GLOBAL (1-based con el offset de la página), no el índice dentro del slice:
// el DOM lo publica en data-row-idx y el binder lo recibe como tercer argumento.
test('el DOM numera las filas 1-based con el offset de página', async () => {
  const { table, container, binds } = mount({ pageSize: 10 })
  table.setData(mkDataset(25))
  await flushRaf()
  eq(rowIdxDom(container), Array.from({ length: 10 }, (_, i) => String(i + 1)), 'página 0 → 1..10')

  binds.length = 0
  table.setPage(2)
  await flushRaf()
  eq(rowIdxDom(container), ['21', '22', '23', '24', '25'], 'página 2 → 21..25')
  eq(binds.map(b => b.rowNumber), [21, 22, 23, 24, 25], 'binder recibe el mismo rowNumber')
  eq(filasDom(container).map(f => f.children[1].textContent), ['21', '22', '23', '24', '25'], 'y lo pinta la celda')
  // Lo ASIGNADO, antes de la coerción del DOM: aserta sobre el motor, no sobre el stub (que
  // stringifica cualquier cosa, incluso un objeto con toString).
  is(datasetCrudo(filasDom(container)[0]).rowIdx, 21, 'el motor asigna el número; la cadena la pone el DOM')
})

// Ventana virtual: sólo se monta el rango visible ±5 filas de margen; el resto lo reservan los
// spacers. El rango esperado lo calcula el TEST a partir de (scrollTop, alto, rowHeight) — nunca se
// lee del DOM del módulo: derivar `last` del propio data-row-idx sólo comprobaría la coherencia
// interna del render y dejaría pasar cualquier cambio del margen (+5 → +4).
const MARGEN = 5
const ventanaEsperada = (scrollTop, alto, rowHeight, filas) => [
  Math.max(0, (scrollTop / rowHeight | 0) - MARGEN),
  Math.min(filas - 1, ((scrollTop + alto) / rowHeight | 0) + MARGEN),
]
// data-row-idx (1-based) de las filas [primera..ultima].
const ventanaRowIdx = (primera, ultima) =>
  Array.from({ length: ultima - primera + 1 }, (_, i) => String(primera + i + 1))

test('la ventana virtual monta exactamente el rango visible ±5 y los spacers reservan el resto', async () => {
  const [rowHeight, alto, filas] = [10, 100, 50]
  const { table, container, scrollElement } = mount({ pageSize: 50, rowHeight, clientHeight: alto })
  table.setData(mkDataset(filas))
  await flushRaf()

  const verificar = (scrollTop, caso) => {
    const [primera, ultima] = ventanaEsperada(scrollTop, alto, rowHeight, filas)
    eq(rowIdxDom(container), ventanaRowIdx(primera, ultima),
      `${caso}: se montan las filas ${primera}..${ultima} y ninguna más`)
    is(container.children[0].style.height, `${primera * rowHeight}px`, `${caso}: el spacer superior reserva la cabeza`)
    is(container.children.at(-1).style.height, `${(filas - ultima - 1) * rowHeight}px`,
      `${caso}: el spacer inferior reserva la cola`)
  }

  verificar(0, 'sin scroll')          // [0, 15]: 16 filas montadas de 50

  scrollElement.scrollTop = 200
  scrollElement.dispatch('scroll')
  verificar(200, 'tras scrollTop=200')  // [15, 35]: 21 filas montadas
})

test('los updates duros vuelven a la página 0; el suave conserva la página', async () => {
  const data = mkDataset(30)
  const { table } = mount({ pageSize: 5, searchBy: NOMBRE_DE })
  table.setData(data)
  await flushRaf()
  table.setPage(3)
  await flushRaf()
  is(table.getPageInfo().page, 3, 'estamos en la página 3')

  table.setData(data, false)
  await flushRaf()
  is(table.getPageInfo().page, 3, 'setData suave conserva la página (dato vivo no patea al usuario)')

  table.setData(data, true)
  await flushRaf()
  is(table.getPageInfo().page, 0, 'setData duro vuelve a la página 0')

  table.setPage(3); await flushRaf()
  table.setSearch('a'); await flushRaf()
  is(table.getPageInfo().page, 0, 'setSearch vuelve a la página 0')

  table.setSearch(''); await flushRaf()
  table.setPage(3); await flushRaf()
  table.setPageSize(4); await flushRaf()
  eq([table.getPageInfo().page, table.getPageInfo().pageSize], [0, 4], 'setPageSize vuelve a la página 0')

  table.setPage(3); await flushRaf()
  table.setWhere(it => it.id % 2 === 0); await flushRaf()
  is(table.getPageInfo().page, 0, 'setWhere vuelve a la página 0')
})

test('la página se clampea a la última cuando el total encoge', async () => {
  const { table, slices } = mount({ pageSize: 5 })
  table.setData(mkDataset(12))
  await flushRaf()

  table.setPage(99)
  await flushRaf()
  eq(table.getPageInfo(), { page: 2, pageSize: 5, total: 12, pages: 3, offset: 10 }, 'clampea a la última página')
  is(slices.at(-1).rows.length, 2, 'y sirve el resto real')

  table.setData(mkDataset(3), false)
  await flushRaf()
  is(table.getPageInfo().page, 0, 'si el dataset encoge, la página vigente se reajusta')
  is(slices.at(-1).rows.length, 3, 'con todas las filas restantes')
})

// El BORDE exacto: con 3 páginas (0,1,2) el primer índice inválido es 3, no 4. Un clamp `>` en vez
// de `>=` deja pasar justo ese caso y la tabla sirve una página vacía con offset fuera del total.
test('setPage(pages) — el borde exacto — clampea a la última página', async () => {
  const { table, slices } = mount({ pageSize: 5 })
  table.setData(mkDataset(12))
  await flushRaf()

  table.setPage(3)
  await flushRaf()
  eq(table.getPageInfo(), { page: 2, pageSize: 5, total: 12, pages: 3, offset: 10 },
    'page === pages es inválido: se clampea a pages-1')
  eq(ids(slices.at(-1).rows), [10, 11], 'y sirve las filas reales de la última página')
  eq(slices.at(-1).meta, { page: 2, pages: 3, total: 12, offset: 10 }, 'la meta acompaña el clamp')
})

// Ciclo completo poblada → vacía → poblada. Los casos vacíos que arrancan vacíos no ven ni el
// acumulador sucio (#visibleSlice del render anterior) ni la integridad de los dos spacers como
// anclas del pool: al limpiar el viewport hay que cortar EN el spacer inferior, no barrer hasta el
// final del contenedor.
test('vaciar la vista limpia el slice anterior y deja los DOS spacers como anclas', async () => {
  const { table, container, slices } = mount({ pageSize: 5 })
  table.setData(mkDataset(12))
  await flushRaf()
  const spacerTop = container.children[0]
  const spacerBottom = container.children.at(-1)
  is(table.itemAtRow(1).id, 0, 'partimos con filas servidas')

  table.setWhere(() => false)
  await flushRaf()
  eq(slices.at(-1).rows, [], 'la vista vacía emite un slice vacío')
  is(table.itemAtRow(1), null, 'y el slice anterior no deja filas fantasma')
  is(container.children.length, 2, 'el contenedor queda con exactamente dos nodos')
  is(container.children[0], spacerTop, 'el spacer superior sigue siendo el MISMO nodo')
  is(container.children[1], spacerBottom, 'y el inferior también (no se lo llevó el barrido)')

  table.setWhere(it => it.id < 3)
  await flushRaf()
  eq(idsDom(container), [0, 1, 2], 'al repoblar las filas se leen íntegras entre los spacers')
  is(container.children.at(-1), spacerBottom, 'las filas se insertan ANTES del ancla, que sigue al final')
})

// El clamp de página sólo cubre el borde superior (`pageIndex >= totalPages`). Con un índice
// negativo el offset queda negativo y `#sortAndSlicePage` llama a qselect con k/left negativos:
// el comparator recibe `undefined` y REVIENTA dentro del rAF (con comparator null no explota, pero
// getPageInfo() reporta page:-1 / offset negativo).
test('T2 — la página se clampea también por abajo', async () => {
  const { table, slices } = mount({ pageSize: 5, comparator: POR_VALOR })
  const data = mkDataset(12)
  table.setData(data)
  await flushRaf()

  table.setPage(-1)
  await flushRaf()
  is(table.getPageInfo().page, 0, 'un índice negativo se corrige a la página 0')
  is(table.getPageInfo().offset, 0, 'y el offset nunca es negativo')
  eq(ids(slices.at(-1).rows), ids(oraculo(data, { comparator: POR_VALOR }).slice(0, 5)),
    'y sirve la página 0 real, no un slice corrido')

  // Estando en una página > 0 el clamp también aplica (no es sólo "ya estaba en la 0").
  table.setPage(2); await flushRaf()
  table.setPage(-7); await flushRaf()
  is(table.getPageInfo().page, 0, 'desde la página 2 un índice negativo vuelve a la 0')
})

// La página es un ÍNDICE: un valor fraccionario dejaría el offset (page × pageSize) fuera de la
// grilla de páginas y el slice arrancaría a mitad de una.
test('setPage trunca a entero', async () => {
  const { table } = mount({ pageSize: 5 })
  table.setData(mkDataset(12))
  await flushRaf()

  table.setPage(1.9)
  await flushRaf()
  eq([table.getPageInfo().page, table.getPageInfo().offset], [1, 5], 'setPage(1.9) → página 1, offset 5')
})

// El dirty-skip compara (páginas, página, TOTAL): comparar sólo totalPages congelaría el "de N"
// cuando el dataset cambia de tamaño sin cruzar un borde de página.
test('onPage sólo re-emite cuando cambia página, cantidad de páginas o total', async () => {
  const { table, pages } = mount({ pageSize: 5 })
  table.setData(mkDataset(12))
  await flushRaf()
  is(pages.length, 1, 'primer render emite una vez')

  table.refresh()
  await flushRaf()
  is(pages.length, 1, 'refresh sin cambios no re-emite')

  table.setData(mkDataset(11), false)
  await flushRaf()
  is(pages.length, 2, 'cambia el total dentro de las mismas 3 páginas → re-emite')
  is(pages.at(-1).total, 11, 'con el total nuevo')

  table.setPage(1)
  await flushRaf()
  is(pages.length, 3, 'cambiar de página re-emite')
})

test('where es un subconjunto por tabla: se reemplaza y null lo desactiva', async () => {
  const data = mkDataset(30)
  const { table } = mount({ pageSize: 100 })
  table.setData(data)
  await flushRaf()
  is(table.getPageInfo().total, 30, 'sin where pasa todo')

  table.setWhere(it => it.id % 2 === 0)
  await flushRaf()
  is(table.getPageInfo().total, 15, 'where recorta la vista')

  table.setWhere(it => it.id % 5 === 0)
  await flushRaf()
  is(table.getPageInfo().total, 6, 'el where nuevo REEMPLAZA al anterior (no se acumulan)')

  table.setWhere(null)
  await flushRaf()
  is(table.getPageInfo().total, 30, 'null desactiva el subconjunto')
})

// where se evalúa ANTES del text-search: lo que no pertenece a la vista nunca se busca ni se cuenta.
test('el text-search se aplica sobre lo que ya pasó el where', async () => {
  const data = mkDataset(40, 5)
  const where = it => it.id % 3 === 0
  const { table } = mount({ pageSize: 100, where, searchBy: NOMBRE_DE })
  table.setData(data)
  table.setSearch('  A  ')
  await flushRaf()

  is(table.getPageInfo().total, oraculo(data, { where, search: 'a', searchBy: NOMBRE_DE }).length,
    'la búsqueda se normaliza (trim + minúsculas) y se compone con el where')
})

test('searchFilter reemplaza el matcher por defecto y recibe (query, item, valor)', async () => {
  const data = mkDataset(20, 3)
  const vistos = []
  const searchFilter = (query, item, valor) => { vistos.push({ query, id: item.id, valor }); return item.id % 4 === 0 }
  const { table } = mount({ pageSize: 100, searchBy: NOMBRE_DE, searchFilter })
  table.setData(data)
  table.setSearch('Xyz')
  await flushRaf()

  is(table.getPageInfo().total, 5, 'manda el predicado, no el includes por defecto')
  is(vistos[0].query, 'xyz', 'la query llega en minúsculas')
  is(vistos[0].valor, data[0].nombre, 'y el valor ya resuelto por searchBy')
})

test('attach lee el snapshot y re-lee en cada notify sin patear al usuario a la página 0', async () => {
  let notificar = null
  let desuscripciones = 0
  let snapshot = mkDataset(20)
  const source = {
    getSnapshot: () => snapshot,
    subscribe: cb => { notificar = cb; return () => { desuscripciones++ } },
  }
  const { table } = mount({ pageSize: 5 })
  table.attach(source)
  await flushRaf()
  is(table.getPageInfo().total, 20, 'toma el snapshot inicial')

  table.setPage(2)
  await flushRaf()
  snapshot = mkDataset(24)
  notificar()
  await flushRaf()
  eq([table.getPageInfo().page, table.getPageInfo().total], [2, 24], 'el notify es un refresh suave')

  table.destroy()
  is(desuscripciones, 1, 'destroy se desuscribe del source')
})

// El teardown de subscribe se normaliza con toUnsub: una Source cuyo subscribe devuelve un objeto
// { unsubscribe() } (RxJS) o { dispose() } (Solid) debe darse de baja sin "x is not a function". Sin la
// normalización, #detachSource invocaría el objeto como función y reventaría en destroy/re-attach.
test('attach normaliza el teardown del subscribe (objeto unsubscribe/dispose, no sólo función)', async () => {
  for (const [tipo, hacer] of [
    ['unsubscribe', bajas => ({ unsubscribe() { bajas.n++ } })],
    ['dispose',     bajas => ({ dispose()     { bajas.n++ } })],
  ]) {
    const bajas = { n: 0 }
    const source = { getSnapshot: () => mkDataset(8), subscribe: () => hacer(bajas) }
    const { table } = mount({ pageSize: 5 })
    table.attach(source)
    await flushRaf()
    ASERTOS++; assert.doesNotThrow(() => table.destroy(), `destroy con teardown ${tipo} no lanza`)
    is(bajas.n, 1, `destroy invocó ${tipo}() del teardown normalizado`)
  }
})

test('attach exige el subconjunto de lectura del contrato Source', () => {
  const { table } = mount()
  ASERTOS++; assert.throws(() => table.attach({}), TypeError, 'source sin getSnapshot/subscribe')
  ASERTOS++; assert.throws(() => table.attach({ getSnapshot: () => [] }), TypeError, 'source sin subscribe')
})

test('destroy vacía el contenedor', async () => {
  const { table, container } = mount({ pageSize: 5 })
  table.setData(mkDataset(12))
  await flushRaf()
  is(container.children.length, 7, 'había 2 spacers + las 5 filas de la página montadas')

  table.destroy()
  is(container.children.length, 0, 'el contenedor queda vacío')
})

// destroy() tiene que dar de baja TODO lo que instaló: el listener de scroll (vía AbortController) y
// los dos observers. Si algo sobrevive queda apuntando a una instancia con los buffers ya en null.
test('destroy da de baja el listener de scroll y los dos observers', async () => {
  const { table, scrollElement } = mount({ pageSize: 5 })
  const io = intersectionObservers.at(-1)
  const ro = resizeObservers.at(-1)
  table.setData(mkDataset(12))
  await flushRaf()
  is(scrollElement.listeners.scroll.length, 1, 'mientras vive escucha el scroll')

  table.destroy()
  is(scrollElement.listeners.scroll.length, 0, 'destroy quita el listener de scroll')
  is(io.activo, false, 'y desconecta el IntersectionObserver')
  is(ro.activo, false, 'y el ResizeObserver')
  // Con el listener vivo, este scroll entraría a renderizar con los buffers ya en null (TypeError).
  ASERTOS++
  assert.doesNotThrow(() => scrollElement.dispatch('scroll'), 'un scroll posterior a destroy no hace nada')
})

// El alto del viewport NO es fijo: el ResizeObserver lo recalcula y tiene que re-renderizar la
// ventana con el rango nuevo (si sólo actualiza el número, la tabla queda con el alto viejo).
test('el ResizeObserver recalcula el alto del viewport y re-renderiza la ventana', async () => {
  const [rowHeight, filas] = [10, 50]
  const { table, container } = mount({ pageSize: 50, rowHeight, clientHeight: 20 })
  const ro = resizeObservers.at(-1)
  is(ro.targets[0], container.parentNode, 'el observer mira el contenedor de scroll')
  table.setData(mkDataset(filas))
  await flushRaf()
  eq(rowIdxDom(container), ventanaRowIdx(...ventanaEsperada(0, 20, rowHeight, filas)), 'viewport 20px → 8 filas')

  ro.trigger(400)
  eq(rowIdxDom(container), ventanaRowIdx(...ventanaEsperada(0, 400, rowHeight, filas)), 'viewport 400px → 46 filas')
})

// Coalescencia a rAF: N mutaciones en el mismo tick = UN pipeline con el estado final.
test('varias mutaciones en el mismo tick se coalescen en un único pipeline', async () => {
  const { table, slices } = mount({ pageSize: 5, searchBy: NOMBRE_DE })
  table.setData(mkDataset(30))
  await flushRaf()
  is(slices.length, 1, 'el primer render emite una vez')

  table.setPage(2)
  table.setSearch('a')
  table.setPageSize(4)
  table.setWhere(it => it.id % 2 === 0)
  await flushRaf()
  is(slices.length, 2, 'las 4 mutaciones seguidas emiten UN solo slice, no cuatro')
  is(table.getPageInfo().pageSize, 4, 'y el pipeline corre con el estado final')
})

// setPage a la página vigente es un no-op: si volviera a correr el pipeline resetearía el scrollTop
// y el usuario perdería la posición dentro de la página.
test('setPage a la página vigente no resetea el scroll ni re-emite', async () => {
  const { table, slices, scrollElement } = mount({ pageSize: 5, rowHeight: 10, clientHeight: 20 })
  table.setData(mkDataset(30))
  await flushRaf()
  table.setPage(2)
  await flushRaf()

  scrollElement.scrollTop = 30
  const emitidos = slices.length
  is(table.setPage(2), table, 'devuelve la instancia igual')
  await flushRaf()
  is(scrollElement.scrollTop, 30, 'conserva la posición de scroll')
  is(slices.length, emitidos, 'y no vuelve a correr el pipeline')
})

// Propiedad del array entregado a onSlice: el consumidor lo RETIENE (lo guarda en su estado). Si el
// motor reusara un buffer único escribiéndolo in-place, lo retenido cambiaría solo al pasar de
// página. La invariante es de IDENTIDAD, no de contenido.
test('cada slice es un array NUEVO: el que retuvo el consumidor no muta al cambiar de página', async () => {
  const { table, slices } = mount({ pageSize: 5 })
  table.setData(mkDataset(12))
  await flushRaf()
  const pagina0 = slices.at(-1).rows

  table.setPage(1)
  await flushRaf()
  const pagina1 = slices.at(-1).rows
  ok(pagina0 !== pagina1, 'el motor no entrega dos veces el mismo array')
  eq(ids(pagina0), [0, 1, 2, 3, 4], 'el array de la página 0 sigue conteniendo la página 0')
  eq(ids(pagina1), [5, 6, 7, 8, 9], 'y el de la página 1, la página 1')
})

// Camino <table>: los spacers tienen que ser <tr> (un <div> entre filas es HTML inválido y el
// navegador lo reubica) y la tabla pasa a layout fijo para que el ancho no salte al reciclar el pool.
test('dentro de una <table> los spacers son <tr> y la tabla queda con layout fijo', () => {
  const tabla = document.createElement('table')
  const tbody = document.createElement('tbody')
  const scrollElement = document.createElement('div')
  tabla.appendChild(tbody)
  scrollElement.appendChild(tabla)

  const table = new PagedTable({ container: tbody, scrollElement, template: TEMPLATE, binder: () => {} })
  is(tbody.children[0].tagName, 'TR', 'spacer superior <tr>')
  is(tbody.children.at(-1).tagName, 'TR', 'spacer inferior <tr>')
  is(tabla.style.tableLayout, 'fixed', 'la tabla ancestra queda en table-layout: fixed')
  table.destroy()
})

// El contenedor recibido puede traer contenido previo (placeholder de "cargando", filas del render
// anterior de la vista): el montaje lo vacía, o toda la lectura por posición se desalinea.
test('el montaje vacía el contenedor recibido antes de instalar los spacers', async () => {
  const scrollElement = document.createElement('div')
  const container = document.createElement('div')
  scrollElement.appendChild(container)
  scrollElement.clientHeight = 100000
  container.appendChild(document.createElement('span'))

  const table = new PagedTable({ container, scrollElement, template: TEMPLATE, pageSize: 5, binder: () => {} })
  is(container.children.length, 2, 'la basura previa no sobrevive al montaje: sólo los dos spacers')

  table.setData(mkDataset(12))
  await flushRaf()
  is(container.children.length, 7, 'y el pool queda entre los spacers (2 + 5 filas)')
  table.destroy()
})

test('el constructor exige container, scrollElement, template y binder', () => {
  const container = document.createElement('div')
  const scrollElement = document.createElement('div')
  const base = { container, scrollElement, template: TEMPLATE, binder: () => {} }
  const sin = clave => { const o = { ...base }; delete o[clave]; return o }

  for (const clave of ['container', 'scrollElement', 'template', 'binder']) {
    ASERTOS++
    assert.throws(() => new PagedTable(sin(clave)), TypeError, `falta ${clave}`)
  }
  ASERTOS++; assert.throws(() => new PagedTable(), TypeError, 'sin argumentos')
})

test('pageSize se normaliza a un entero ≥ 1', async () => {
  const { table } = mount({ pageSize: 0 })
  table.setData(mkDataset(3))
  await flushRaf()
  is(table.getPageInfo().pageSize, 1, 'pageSize 0 → 1')

  table.setPageSize(-4); await flushRaf()
  is(table.getPageInfo().pageSize, 1, 'negativo → 1')

  table.setPageSize(2.9); await flushRaf()
  is(table.getPageInfo().pageSize, 2, 'se trunca a entero')
})

// Guard de visibilidad: fuera de pantalla el pipeline no corre; al reaparecer corre UNA vez.
test('fuera de pantalla no renderiza y al reaparecer corre el pipeline pendiente', async () => {
  const { table, container, slices } = mount({ pageSize: 5 })
  const io = intersectionObservers.at(-1)

  io.trigger(false)
  table.setData(mkDataset(12))
  await flushRaf()
  is(slices.length, 0, 'oculto: ni un slice')
  is(filasDom(container).length, 0, 'oculto: DOM intacto')

  io.trigger(true)
  await flushRaf()
  is(slices.length, 1, 'al reaparecer corre exactamente una vez')
  is(filasDom(container).length, 5, 'y el DOM queda al día')
})

test('itemAtRow resuelve contra el slice de la página vigente', async () => {
  const data = mkDataset(12)
  const { table } = mount({ pageSize: 5 })
  table.setData(data)
  await flushRaf()

  is(table.itemAtRow(1), data[0], 'primera fila de la página 0')
  is(table.itemAtRow(5), data[4], 'última fila de la página 0')
  is(table.itemAtRow(6), null, 'fila de otra página → null')
  is(table.itemAtRow(0), null, 'índice 0 (no 1-based) → null')

  table.setPage(1)
  await flushRaf()
  is(table.itemAtRow(6), data[5], 'en la página 1 el índice global 6 sí resuelve')
  is(table.itemAtRow(1), null, 'y el 1 ya no pertenece al slice')
})
