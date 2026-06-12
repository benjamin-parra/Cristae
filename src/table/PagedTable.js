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

  // Dataset completo + buffers de trabajo. `workingSet` se reordena in-place por quickselect,
  // por eso es una COPIA de refs del dataset (nunca se reordena el snapshot del Source, que debe
  // mantener su referencia estable).
  #dataset = []
  #workingSet = []
  #visibleSlice = []
  #totalItems = 0

  #pageIndex = 0
  #searchQuery = ''
  #lastPageCount = -1
  #lastPageIndex = -1

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

  #rafId = 0
  #refreshPending = false
  #visible = true
  #hiddenDirty = false
  #abort = new AbortController()
  #resizeObserver = null
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
    onSlice = null,
    onPage = null,
  } = {}) {
    if (!container) throw new TypeError('[PagedTable] container es obligatorio')
    if (!scrollElement) throw new TypeError('[PagedTable] scrollElement es obligatorio')
    if (typeof template !== 'string') throw new TypeError('[PagedTable] template (string HTML) es obligatorio')
    if (typeof binder !== 'function') throw new TypeError('[PagedTable] binder es obligatorio')

    this.#options = { container, scrollElement, template, comparator, searchBy, searchFilter, onSlice, onPage }
    this.#rowHeight = rowHeight
    this.#pageSize = Math.max(1, pageSize | 0)
    this.#binder = binder

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

  setPage(pageIndex) {
    if (pageIndex === this.#pageIndex) return this
    this.#pageIndex = pageIndex
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

  // Filtra el dataset en `workingSet` (reusado). Sin búsqueda → copia de refs directa. Devuelve el
  // conteo de coincidencias. Nunca reordena `dataset`: el reorder vive en `workingSet`.
  #mergeAndFilter() {
    const data = this.#dataset
    const { searchBy: selector, searchFilter: predicate } = this.#options
    const query = this.#searchQuery.toLowerCase()
    const ws = this.#workingSet
    const total = data.length

    if (ws.length < total) ws.length = total
    let cursor = 0

    if (query && selector) {
      for (let i = 0; i < total; ++i) {
        const item = data[i]
        const val = selector(item)
        const match = predicate
          ? predicate(query, item, val)
          : String(val ?? '').toLowerCase().includes(query)
        if (match) ws[cursor++] = item
      }
    } else {
      for (let i = 0; i < total; ++i) ws[cursor++] = data[i]
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
  #sortAndSlicePage(start, end, total) {
    const buffer = this.#workingSet
    const comparator = this.#options.comparator

    if (comparator) {
      if (start > 0) qselect(buffer, start, 0, total - 1, comparator)
      if (end - 1 > start && end < total) qselect(buffer, end - 1, start, total - 1, comparator)
    }

    const slice = buffer.slice(start, end)
    if (comparator) slice.sort(comparator)
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
  // Dirty-skip: si no cambió ni la página ni el total, no emite.
  #updatePaginationUI(totalPages) {
    if (totalPages === this.#lastPageCount && this.#pageIndex === this.#lastPageIndex) return
    this.#lastPageCount = totalPages
    this.#lastPageIndex = this.#pageIndex
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
