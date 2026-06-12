import { LitElement, html } from 'lit'
import { PagedTable } from './PagedTable.js'
import { paginationModel } from './pagination.js'

// <cristae-table> — piel declarativa del engine headless PagedTable (tabla paginada con scroll
// virtual). Standalone: NO se monta dentro de <cristae-map> y NO importa nada del mapa; solo
// consume el contrato Source de `data/`. La MISMA `source` que alimenta un <cristae-point-layer>
// alimenta esta tabla → un dataset filtrado, computado una vez, dos vistas.
//
// Render en LIGHT DOM (no shadow): las filas son markup del consumidor (`template`/`binder`), así
// que sus clases (Phoenix/Tailwind) deben aplicar — la encapsulación las rompería. El elemento solo
// autora su chrome (scroll + pie de paginación + estilo); las filas las posee el engine y Lit no
// las reconcilia (no hay binding dentro de `.fl-rows`).
//
// Datos — dos entradas simétricas (igual que el mapa):
//   .source : Source (createSource/defineSource) — vivo, compartible entre vistas. Gana sobre .data.
//   .data   : Item[] — array plano sin reactividad.
// Proyección de fila:
//   .template : string HTML de una fila con atributos `data-ref`.
//   .binder   : (refs, item, rowNumber) => void.
//
// La paginación se dibuja declarativamente desde `paginationModel` (función pura); el engine solo
// reporta `pageInfo`. Click en una fila → evento `cristae:rowclick` con `detail: { item, row }`.
export class CristaeTable extends LitElement {

  static properties = {
    source:       { attribute: false },
    data:         { attribute: false },
    template:     { attribute: false },
    binder:       { attribute: false },
    comparator:   { attribute: false },
    searchBy:     { attribute: false },
    searchFilter: { attribute: false },
    rowHeight:    { type: Number, attribute: 'row-height' },
    pageSize:     { type: Number, attribute: 'page-size' },
    maxButtons:   { type: Number, attribute: 'max-buttons' },
    search:       { type: String },
    countLabel:   { attribute: 'count-label' },
    scrollHeight: { attribute: 'scroll-height' },
    _pageInfo:    { state: true },
  }

  // Light DOM: el render root ES el elemento. Las filas del engine quedan visibles e
  // inspeccionables, y el CSS del consumidor las alcanza.
  createRenderRoot() { return this }

  #engine = null
  #abort = new AbortController()

  constructor() {
    super()
    this.source = null
    this.data = null
    this.template = null
    this.binder = null
    this.comparator = null
    this.searchBy = null
    this.searchFilter = null
    this.rowHeight = 28
    this.pageSize = 50
    this.maxButtons = 7
    this.search = ''
    this.countLabel = 'elementos'
    this.scrollHeight = '40vh'
    this._pageInfo = { page: 0, pages: 1, total: 0, pageSize: 50, offset: 0 }
  }

  // Handle imperativo del engine (setPage/setSearch/refresh/…), simétrico con `controls` de las
  // capas del mapa. null hasta el primer render (cuando hay template + binder).
  get controls() { return this.#engine }

  render() {
    return html`
      <style>
        cristae-table { display: block; --fl-accent: #ea580c; --fl-muted: #475569; --fl-border: rgba(15,23,42,.12); }
        cristae-table .fl-scroll { overflow-y: auto; }
        cristae-table .fl-foot { display: flex; align-items: center; gap: 8px; padding: 8px 4px; flex-wrap: wrap; }
        cristae-table .fl-count { color: var(--fl-muted); font-size: 12px; }
        cristae-table .fl-pages { display: flex; gap: 4px; margin-left: auto; }
        cristae-table .fl-page {
          min-width: 28px; height: 28px; padding: 0 6px; border-radius: 8px; cursor: pointer;
          border: 1px solid var(--fl-border); background: transparent; color: var(--fl-muted);
          font: 600 12px/1 ui-sans-serif, system-ui, sans-serif;
        }
        cristae-table .fl-page:hover:not(:disabled) { color: var(--fl-accent); border-color: var(--fl-accent); }
        cristae-table .fl-page.is-current { background: var(--fl-accent); border-color: var(--fl-accent); color: #fff; }
        cristae-table .fl-page:disabled { cursor: default; opacity: .55; }
      </style>
      <div class="fl-scroll" style="max-height:${this.scrollHeight}">
        <div class="fl-rows"></div>
      </div>
      <div class="fl-foot">
        <span class="fl-count">${this._pageInfo.total.toLocaleString('es-CL')} ${this.countLabel}</span>
        <nav class="fl-pages" aria-label="Paginación">
          ${paginationModel(this._pageInfo.page, this._pageInfo.pages, this.maxButtons).map(d => html`
            <button
              type="button"
              class="fl-page ${d.isCurrent ? 'is-current' : ''}"
              ?disabled=${d.label === '...'}
              @click=${() => this.#engine?.setPage(d.pageIndex)}
            >${d.label}</button>
          `)}
        </nav>
      </div>
    `
  }

  updated(changed) {
    if (this.#ensureEngine()) return        // recién creado: ya consumió source/data/search
    const e = this.#engine
    if (!e) return

    if (changed.has('source') && this.source) e.attach(this.source)
    else if (changed.has('data') && this.data) e.setData(this.data)
    if (changed.has('search')) e.setSearch(this.search)
    if (changed.has('pageSize')) e.setPageSize(this.pageSize)
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    this.#abort.abort()
    this.#engine?.destroy()
    this.#engine = null
  }

  // Crea el engine en cuanto hay template + binder + DOM. Devuelve true si lo creó en esta pasada
  // (para que `updated` no re-adjunte la source que el constructor ya consumió).
  #ensureEngine() {
    if (this.#engine || !this.template || !this.binder) return false
    const scrollElement = this.querySelector('.fl-scroll')
    const container = this.querySelector('.fl-rows')
    if (!scrollElement || !container) return false

    this.#engine = new PagedTable({
      container,
      scrollElement,
      template: this.template,
      binder: this.binder,
      rowHeight: this.rowHeight,
      pageSize: this.pageSize,
      comparator: this.comparator,
      searchBy: this.searchBy,
      searchFilter: this.searchFilter,
      onPage: (info) => { this._pageInfo = info },
    })

    scrollElement.addEventListener('click', this.#onRowClick, { signal: this.#abort.signal })

    if (this.source) this.#engine.attach(this.source)
    else if (this.data) this.#engine.setData(this.data)
    if (this.search) this.#engine.setSearch(this.search)
    return true
  }

  // Delegación: resuelve la fila clickeada a su ítem vía el slice visible y emite `cristae:rowclick`.
  #onRowClick = (e) => {
    const rowEl = e.target.closest('[data-row-idx]')
    if (!rowEl) return
    const row = +rowEl.dataset.rowIdx
    const item = this.#engine?.itemAtRow(row)
    if (item) this.dispatchEvent(new CustomEvent('cristae:rowclick', { detail: { item, row }, bubbles: true, composed: true }))
  }
}
