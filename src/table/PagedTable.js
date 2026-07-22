import { qselect } from './QuickSelect.js'

// PagedTable — tabla paginada con scroll virtual. Engine headless (el análogo de MapEngine para
// datos tabulares): no es web component, no toca el motor de mapa, no importa Leaflet. Consume el
// subconjunto de LECTURA del contrato Source (SPECS §2): `getSnapshot()` + `subscribe(cb)`. El
// mismo `createSource`/`defineSource` que alimenta una capa de puntos alimenta esta tabla → un solo
// dataset filtrado, computado una vez, varias vistas.
//
// Proyección de la fila (su análogo domain-free de los `accessors` del mapa):
//   template : string HTML de UNA fila, con atributos `data-ref` para los nodos a poblar
//   binder   : (refs, item, rowNumber) => void — puebla esos nodos (sin reconstruir el árbol)
//
// Optimizaciones base preservadas (no se tocan los algoritmos): pool de DOM + spacers (scroll
// virtual), quickselect O(n) para el borde de página (no se ordena el dataset entero), reuse de
// `workingSet` ([0-alloc] en estado estable), batching a rAF, ResizeObserver para el alto del
// viewport, y guard de visibilidad nativo (IntersectionObserver) — fuera de pantalla no renderiza,
// solo recuerda que quedó sucio y corre una vez al volver a verse.
export class PagedTable {

  #options
  #rowHeight
  #pageSize
  #binder

  #unsubscribe = null

  // Dataset completo + buffers de trabajo. `workingSet` guarda los ÍNDICES del dataset que pasan
  // el filtro y se reordena in-place por quickselect; nunca se reordena el snapshot del Source,
  // que debe mantener su referencia estable.
  #dataset      = []
  #workingSet   = []
  #visibleSlice = []
  #totalItems   = 0

  #pageIndex     = 0
  #searchQuery   = ''
  #lastPageCount = -1
  #lastPageIndex = -1
  #lastTotal     = -1

  #refs = {
    scrollContainer: null,
    container: null,
    spacerTop: null,
    spacerBottom: null,
    rowTemplate: null,
    pool: [],
    viewportHeight: 0,
    renderStart: 0,
    renderEnd: -1,
  }

  #rafId                = 0
  #refreshPending       = false
  #visible              = true
  #hiddenDirty          = false
  #abort                = new AbortController()
  #resizeObserver       = null
  #intersectionObserver = null

  constructor({
    container,
    scrollElement,
    template,
    binder,
    rowHeight = 28,
    pageSize = 50,
    comparator = null,
    searchBy = null,
    searchFilter = null,
    where = null,
    onSlice = null,
    onPage = null,
  } = {}) {
    if (!container) throw new TypeError('[PagedTable] container es obligatorio')
    if (!scrollElement) throw new TypeError('[PagedTable] scrollElement es obligatorio')
    if (typeof template !== 'string') throw new TypeError('[PagedTable] template (string HTML) es obligatorio')
    if (typeof binder !== 'function') throw new TypeError('[PagedTable] binder es obligatorio')

    this.#options   = { container, scrollElement, template, comparator, searchBy, searchFilter, where, onSlice, onPage }
    this.#rowHeight = rowHeight
    this.#pageSize  = Math.max(1, pageSize | 0)
    this.#binder    = binder

    this.#setupLayout()
    this.#bindEvents()
  }

  // ── API pública ──────────────────────────────────────────────────────────

  // Adjunta un Source (createSource/defineSource). El motor SOLO lee: snapshot inicial + re-read
  // por cada notify (coalescido al rAF de la fuente). El notify es un refresh suave: conserva
  // página/scroll (un update de dato vivo no debe patear al usuario a la página 0).
  attach(source) {
    if (typeof source?.getSnapshot !== 'function' || typeof source?.subscribe !== 'function')
      throw new TypeError('[PagedTable] source debe exponer getSnapshot() y subscribe()')

    this.#detachSource()
    this.#unsubscribe = source.subscribe(() => this.setData(source.getSnapshot(), false))
    this.setData(source.getSnapshot(), true)
    return this
  }

  // Ruta A: array plano sin reactividad (simétrico con `.data` del mapa). `hard` resetea
  // página + scroll; suave conserva la posición.
  setData(items, hard = true) {
    this.#dataset = items ?? []
    if (hard) {
      this.#lastPageCount = -1
      this.#refs.scrollContainer.scrollTop = 0
    }
    this.#requestUpdate(hard)
    return this
  }

  // La página vive en [0, pages): acá se fija el piso (y el entero), el techo lo pone el pipeline
  // porque depende del total vigente. Un índice negativo llegaría al slice como offset negativo.
  setPage(pageIndex) {
    const next = Math.max(0, pageIndex | 0)
    if (next === this.#pageIndex) return this
    this.#pageIndex = next
    this.#refs.scrollContainer.scrollTop = 0
    this.#requestUpdate(false)
    return this
  }

  setPageSize(size) {
    this.#pageSize = Math.max(1, size | 0)
    this.#lastPageCount = -1
    this.#refs.scrollContainer.scrollTop = 0
    this.#requestUpdate(true)
    return this
  }

  setSearch(text) {
    this.#searchQuery = (text ?? '').trim()
    this.#lastPageCount = -1
    this.#refs.scrollContainer.scrollTop = 0
    this.#requestUpdate(true)
    return this
  }

  // Predicado de MEMBRESÍA por tabla (subconjunto de vista): N tablas comparten UNA
  // Source y cada una muestra su propio subconjunto sin que el filtro afecte al mapa
  // ni a las otras tablas (a diferencia de `source.addFilter`, que es compartido). Se
  // aplica en `#mergeAndFilter` ANTES del text-search. `null` ⇒ sin filtro (todo pasa).
  // Igual disciplina que `setSearch`: resetea el conteo de páginas y corre el pipeline
  // duro — sin re-render (el motor reescribe el pool en su rAF).
  setWhere(fn) {
    this.#options.where = fn ?? null
    this.#lastPageCount = -1
    this.#refs.scrollContainer.scrollTop = 0
    this.#requestUpdate(true)
    return this
  }

  getPageInfo() {
    return {
      page: this.#pageIndex,
      pageSize: this.#pageSize,
      total: this.#totalItems,
      pages: Math.ceil(this.#totalItems / this.#pageSize) || 1,
      offset: this.#pageIndex * this.#pageSize,
    }
  }

  // Ítem de la fila clickeada, resuelto contra el slice visible actual (índice 1-based del DOM).
  itemAtRow(rowIndex) {
    return this.#visibleSlice[rowIndex - this.#pageIndex * this.#pageSize - 1] ?? null
  }

  // Posición (0-based) de `item` en la vista filtrada + ordenada vigente, o -1 si no está en el
  // dataset o no pasa el filtro. Inverso de `itemAtRow`: NO toca el render ni el `workingSet` —
  // recorre el dataset una vez contando cuántas filas visibles ordenan antes de `item`. `item` debe
  // ser una referencia del dataset vigente (la que entregan `getSnapshot()`/`itemAtRow`). Con orden
  // (`comparator`) el rango es el nº de filas visibles que ordenan estrictamente antes; sin orden es
  // el nº de filas visibles previas en el dataset. Determinista mientras `comparator` sea un orden
  // total; con empates devuelve el rango del BLOQUE empatado (la posición dentro del bloque no la
  // define), mientras que el render sí desempata por índice del dataset: para un ítem empatado,
  // `pageOf` da la página del inicio del bloque, que puede no ser la que termina mostrándolo.
  indexOf(item) {
    const query = this.#searchQuery.toLowerCase()
    if (!this.#matches(item, query)) return -1

    const data = this.#dataset
    const cmp = this.#options.comparator
    let rank = 0

    if (cmp) {
      let found = false
      for (let i = 0; i < data.length; ++i) {
        const other = data[i]
        if (other === item) { found = true; continue }
        if (this.#matches(other, query) && cmp(other, item) < 0) rank++
      }
      return found ? rank : -1
    }

    // Sin comparador el orden es el del dataset: el rango es el nº de filas visibles previas.
    for (let i = 0; i < data.length; ++i) {
      const other = data[i]
      if (other === item) return rank
      if (this.#matches(other, query)) rank++
    }
    return -1
  }

  // Página (0-based) en la que cae `item` bajo el filtro + orden vigentes, o -1 si no está / no pasa
  // el filtro. Azúcar sobre `indexOf` para el caso común "¿en qué página aparece esta fila?".
  pageOf(item) {
    const index = this.indexOf(item)
    return index < 0 ? -1 : Math.floor(index / this.#pageSize)
  }

  refresh() { this.#requestUpdate(false); return this }

  destroy() {
    if (this.#rafId) cancelAnimationFrame(this.#rafId)
    this.#rafId = 0
    this.#abort.abort()
    this.#resizeObserver?.disconnect()
    this.#intersectionObserver?.disconnect()
    this.#detachSource()

    this.#options.container.textContent = ''
    this.#dataset = this.#workingSet = this.#visibleSlice = null
    this.#refs.pool = null
  }

  // ── Internos ─────────────────────────────────────────────────────────────

  #detachSource() {
    this.#unsubscribe?.()
    this.#unsubscribe = null
  }

  #requestUpdate(hard) {
    if (hard) this.#refreshPending = true
    if (!this.#visible) { this.#hiddenDirty = true; return }   // guard de visibilidad: se corre al volver
    if (this.#rafId) return

    this.#rafId = requestAnimationFrame(() => {
      this.#rafId = 0
      const wasHard = this.#refreshPending
      this.#refreshPending = false
      this.#executePipeline(wasHard)
    })
  }

  // Membresía de la vista de UN ítem: where primero, luego text-search. `query` llega ya en
  // minúsculas. Es el MISMO gate que `#mergeAndFilter` (que lo desdobla en bucles para el camino
  // caliente); acá vive la regla única para las consultas de posición (`indexOf`/`pageOf`), fuera
  // de ese camino.
  #matches(item, query) {
    const { searchBy: selector, searchFilter: predicate, where } = this.#options
    if (where && !where(item)) return false
    if (!query || !selector) return true
    const val = selector(item)
    return predicate
      ? predicate(query, item, val)
      : String(val ?? '').toLowerCase().includes(query)
  }

  // Filtra el dataset en `workingSet` (reusado), que guarda ÍNDICES del dataset en orden creciente:
  // el índice identifica la fila y, de paso, es su desempate estable al ordenar (#sortAndSlicePage).
  // Devuelve el conteo de coincidencias. Nunca reordena `dataset`: el reorder vive en `workingSet`.
  #mergeAndFilter() {
    const data = this.#dataset
    const { searchBy: selector, searchFilter: predicate, where } = this.#options
    const query = this.#searchQuery.toLowerCase()
    const ws = this.#workingSet
    const total = data.length

    if (ws.length < total) ws.length = total
    let cursor = 0

    // Gate de membresía por tabla (where) ANTES del text-search: un ítem que no pertenece
    // a la vista nunca se cuenta ni se ordena. `where` null ⇒ no se evalúa nada (cero costo
    // sobre el camino existente).
    if (query && selector) {
      for (let i = 0; i < total; ++i) {
        const item = data[i]
        if (where && !where(item)) continue
        const val = selector(item)
        const match = predicate
          ? predicate(query, item, val)
          : String(val ?? '').toLowerCase().includes(query)
        if (match) ws[cursor++] = i
      }
    } else if (where) {
      for (let i = 0; i < total; ++i) {
        if (where(data[i])) ws[cursor++] = i
      }
    } else {
      for (let i = 0; i < total; ++i) ws[cursor++] = i
    }
    return cursor
  }

  #executePipeline(hard) {
    if (hard) {
      this.#pageIndex = 0
      this.#refs.renderStart = 0
      this.#refs.renderEnd = -1
    }

    const count = this.#mergeAndFilter()
    this.#totalItems = count

    const pageSize = this.#pageSize
    const totalPages = Math.ceil(count / pageSize) || 1
    if (this.#pageIndex >= totalPages) this.#pageIndex = totalPages - 1

    const startIndex = this.#pageIndex * pageSize
    const endIndex = Math.min(startIndex + pageSize, count)

    if (count === 0 || startIndex >= count) {
      this.#visibleSlice.length = 0
      this.#clearViewport()
      this.#updatePaginationUI(totalPages)
      this.#options.onSlice?.([], { page: this.#pageIndex, pages: totalPages, total: 0, offset: 0 })
      return
    }

    this.#sortAndSlicePage(startIndex, endIndex, count)
    this.#adjustDomPool(endIndex - startIndex)
    this.#renderVisibleWindow()
    this.#updatePaginationUI(totalPages)

    this.#options.onSlice?.(this.#visibleSlice, {
      page: this.#pageIndex, pages: totalPages, total: count, offset: startIndex,
    })

    const ws = this.#workingSet
    if (ws.length > count * 2) ws.length = count   // evita retener un buffer desproporcionado
  }

  // Quickselect deja los bordes [start, end) particionados en O(n); solo se ordena el slice de la
  // página (no el dataset entero, que sería O(n·log n)).
  //
  // Se particiona por un orden TOTAL: el comparador del consumidor desempatado por el índice del
  // dataset. Es la invariante que hace que las páginas sean una partición del universo — sin ella
  // dos páginas contiguas eligen representantes distintos del bloque empatado y hay filas que
  // salen dos veces mientras otras no salen nunca.
  #sortAndSlicePage(start, end, total) {
    const buffer = this.#workingSet
    const data = this.#dataset
    const comparator = this.#options.comparator
    const byRank = comparator && ((a, b) => comparator(data[a], data[b]) || a - b)

    if (byRank) {
      if (start > 0) qselect(buffer, start, 0, total - 1, byRank)
      if (end - 1 > start && end < total) qselect(buffer, end - 1, start, total - 1, byRank)
    }

    const page = buffer.slice(start, end)
    if (byRank) page.sort(byRank)

    const slice = new Array(page.length)
    for (let i = 0; i < page.length; ++i) slice[i] = data[page[i]]
    this.#visibleSlice = slice
  }

  #adjustDomPool(needed) {
    const pool = this.#refs.pool
    const height = this.#rowHeight
    const tpl = this.#refs.rowTemplate

    while (pool.length < needed) {
      const element = tpl.content.firstElementChild.cloneNode(true)
      element.style.height = `${height}px`
      const bindings = {}
      const nodes = element.querySelectorAll('[data-ref]')
      for (let i = 0, n = nodes.length; i < n; ++i) bindings[nodes[i].dataset.ref] = nodes[i]
      pool.push({ element, bindings })
    }
  }

  // Renderiza solo la ventana visible (± margen): traduce scrollTop a un rango de filas, repuebla
  // las del pool y ajusta los spacers. Si el rango no cambió, solo repuebla (sin tocar el DOM).
  #renderVisibleWindow() {
    const rows = this.#visibleSlice
    const len = rows.length
    if (!len) return

    const refs = this.#refs
    const rowHeight = this.#rowHeight
    const scrollTop = refs.scrollContainer.scrollTop
    const viewH = refs.viewportHeight

    const first = Math.max(0, (scrollTop / rowHeight | 0) - 5)
    const last = Math.min(len - 1, ((scrollTop + viewH) / rowHeight | 0) + 5)

    const binder = this.#binder
    const offset = this.#pageIndex * this.#pageSize
    const pool = refs.pool

    for (let i = first; i <= last; ++i) {
      const row = pool[i]
      row.element.dataset.rowIdx = offset + i + 1
      binder(row.bindings, rows[i], offset + i + 1)
    }

    if (first === refs.renderStart && last === refs.renderEnd) return

    refs.spacerTop.style.height = (first * rowHeight) + 'px'
    refs.spacerBottom.style.height = ((len - last - 1) * rowHeight) + 'px'

    const anchor = refs.spacerBottom
    let cursor = refs.spacerTop.nextSibling
    while (cursor && cursor !== anchor) {
      const next = cursor.nextSibling
      cursor.remove()
      cursor = next
    }

    const frag = document.createDocumentFragment()
    for (let i = first; i <= last; ++i) frag.appendChild(pool[i].element)
    this.#options.container.insertBefore(frag, anchor)

    refs.renderStart = first
    refs.renderEnd = last
  }

  #clearViewport() {
    const refs = this.#refs
    refs.renderStart = 0
    refs.renderEnd = -1

    let cursor = refs.spacerTop.nextSibling
    while (cursor && cursor !== refs.spacerBottom) {
      const next = cursor.nextSibling
      cursor.remove()
      cursor = next
    }
    refs.spacerTop.style.height = refs.spacerBottom.style.height = '0px'
  }

  // Notifica el cambio de página/total a la vista (que dibuja la paginación declarativamente).
  // Dirty-skip por página + TOTAL DE ÍTEMS: comparar sólo totalPages silenciaría cualquier cambio
  // de conteo dentro de la misma cantidad de páginas (altas/bajas del dataset, cambio del `where`
  // por ref + refresh()) y la vista mostraría un "de N" congelado hasta cruzar un borde de página.
  #updatePaginationUI(totalPages) {
    if (totalPages === this.#lastPageCount && this.#pageIndex === this.#lastPageIndex
      && this.#totalItems === this.#lastTotal) return
    this.#lastPageCount = totalPages
    this.#lastPageIndex = this.#pageIndex
    this.#lastTotal = this.#totalItems
    this.#options.onPage?.(this.getPageInfo())
  }

  #setupLayout() {
    const refs = this.#refs
    const container = this.#options.container

    refs.rowTemplate = document.createElement('template')
    refs.rowTemplate.innerHTML = this.#options.template
    refs.scrollContainer = this.#options.scrollElement
    refs.container = container
    container.textContent = ''

    // Spacers <tr> dentro de <table>, <div> en cualquier otro contenedor.
    const isTable = container.closest('table') != null
    const spacerTag = isTable ? 'tr' : 'div'

    refs.spacerTop = document.createElement(spacerTag)
    refs.spacerBottom = document.createElement(spacerTag)
    refs.spacerTop.style.display = refs.spacerBottom.style.display = 'block'
    refs.spacerTop.style.height = refs.spacerBottom.style.height = '0px'
    refs.spacerTop.style.contentVisibility = refs.spacerBottom.style.contentVisibility = 'auto'

    container.appendChild(refs.spacerTop)
    container.appendChild(refs.spacerBottom)
    if (isTable) container.closest('table').style.tableLayout = 'fixed'

    refs.viewportHeight = refs.scrollContainer.clientHeight
  }

  #bindEvents() {
    const refs = this.#refs
    const signal = this.#abort.signal

    refs.scrollContainer.addEventListener('scroll', () => this.#renderVisibleWindow(), { passive: true, signal })

    this.#resizeObserver = new ResizeObserver(entries => {
      const entry = entries[0]
      if (!entry) return
      refs.viewportHeight = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height
      this.#renderVisibleWindow()
    })
    this.#resizeObserver.observe(refs.scrollContainer)

    // Guard de visibilidad: fuera de pantalla no renderiza; al reaparecer corre una vez si quedó sucio.
    this.#intersectionObserver = new IntersectionObserver(([entry]) => {
      this.#visible = entry.isIntersecting
      if (this.#visible && this.#hiddenDirty) {
        this.#hiddenDirty = false
        this.#requestUpdate(false)   // #refreshPending conserva si el pendiente era hard
      }
    })
    this.#intersectionObserver.observe(refs.container)
  }
}
