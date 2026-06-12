import { LitElement, html, css } from 'lit'
import { unsafeHTML } from 'lit/directives/unsafe-html.js'
import { styleMap } from 'lit/directives/style-map.js'

// <cristae-toolbar> — barra/dock flotante semitransparente para acciones sobre el mapa. Es UI pura
// (no toca el motor): se coloca en una zona del overlay de <cristae-map> vía `slot` (top-left,
// center, bottom-center, …) y la zona decide su POSICIÓN; la ORIENTACIÓN (horizontal/vertical) es
// propia del componente (atributo `orientation`). Los items son config:
//
//   { id, title, icon, onClick, active?, badge?, color?, bgColor?, selectedColor? }
//
// `icon` es markup SVG/HTML; `title` es el nombre accesible (sin tooltip nativo). color/bgColor/
// selectedColor permiten tematizar cada item; sin ellos cae a las vars --tb-* del dock.
// addItem/removeItem/setActive pueblan y mutan la barra en runtime.
export class CristaeToolbar extends LitElement {

  static properties = {
    items: { type: Array },
    orientation: { type: String, reflect: true },   // vertical (default) | horizontal
  }

  constructor() {
    super()
    this.items = []
    this.orientation = 'vertical'
  }

  addItem(item) { this.items = [...this.items, item]; return this }
  removeItem(id) { this.items = this.items.filter(i => i.id !== id); return this }
  setActive(id) { this.items = this.items.map(i => ({ ...i, active: i.id === id })); return this }

  render() {
    return html`
      <nav class="dock" role="toolbar">
        ${this.items.map(item => html`
          <button
            type="button"
            class="btn ${item.active ? 'is-active' : ''}"
            aria-label=${item.title ?? ''}
            style=${styleMap(this.#itemVars(item))}
            @click=${(e) => item.onClick?.(item, e)}
          >
            <span class="icon">${unsafeHTML(item.icon ?? '')}</span>
            ${item.badge != null ? html`<span class="badge">${item.badge}</span>` : ''}
          </button>
        `)}
      </nav>
    `
  }

  // Colores por item → custom properties locales que la hoja consume con fallback a las vars del dock.
  #itemVars(item) {
    const vars = {}
    if (item.color) vars['--btn-color'] = item.color
    if (item.bgColor) vars['--btn-bg'] = item.bgColor
    if (item.selectedColor) vars['--btn-selected'] = item.selectedColor
    return vars
  }

  static styles = css`
    /* Flujo normal dentro de su zona del overlay; la zona la posiciona. Vars --tb-* tematizan el dock. */
    :host {
      display: inline-block;
      pointer-events: auto;
      --tb-bg: rgba(255, 255, 255, 0.82);
      --tb-border: rgba(15, 23, 42, 0.08);
      --tb-muted: #475569;
      --tb-accent: #ea580c;
      --tb-hover-bg: rgba(15, 23, 42, 0.06);
    }

    .dock {
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding: 8px;
      border-radius: 16px;
      background: var(--tb-bg);
      border: 1px solid var(--tb-border);
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
    }
    :host([orientation="horizontal"]) .dock { flex-direction: row; }

    .btn {
      position: relative;
      width: 40px;
      height: 40px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: 0;
      border-radius: 12px;
      cursor: pointer;
      background: var(--btn-bg, transparent);
      color: var(--btn-color, var(--tb-muted));
      transition: background-color .15s, color .15s, transform .15s;
    }
    .btn:hover {
      background: var(--btn-bg, var(--tb-hover-bg));
      color: var(--btn-color, var(--tb-accent));
    }
    .btn.is-active {
      background: var(--btn-selected, var(--tb-accent));
      color: #fff;
      transform: scale(1.1);
      box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.15);
    }

    .icon { display: inline-flex; width: 22px; height: 22px; }
    .icon svg { width: 100%; height: 100%; display: block; }

    .badge {
      position: absolute;
      top: -4px;
      right: -4px;
      min-width: 18px;
      height: 18px;
      padding: 0 4px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 999px;
      background: #fb923c;
      color: #fff;
      font: 900 10px/1 ui-sans-serif, system-ui, sans-serif;
      pointer-events: none;
    }
  `
}
