// jsdom con los globals que Lit y los elementos <cristae-*> tocan al evaluar y al montar: lo que un test de
// elementos REALES (custom elements, shadow root, Leaflet) necesita y el shim de element-stub no da. Se importa
// PRIMERO, antes que navegador-falso y que cualquier módulo de `src/`: sus efectos corren al evaluarse, y un
// `import` estático posterior ya encuentra `window` y `customElements` puestos.
//
// jsdom no tiene layout (todo mide 0×0) ni WebGL: `getContext` devuelve null. De lo segundo se ocupa
// navegador-falso.mjs.

import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })

export const { window } = dom

Object.assign(globalThis, {
  window,
  document             : window.document,
  HTMLElement          : window.HTMLElement,
  Element              : window.Element,
  Node                 : window.Node,
  Event                : window.Event,
  CustomEvent          : window.CustomEvent,
  DocumentFragment     : window.DocumentFragment,
  customElements       : window.customElements,
  getComputedStyle     : window.getComputedStyle,
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame : window.cancelAnimationFrame.bind(window),
  MutationObserver     : window.MutationObserver,
  ShadowRoot           : window.ShadowRoot,
  CSSStyleSheet        : window.CSSStyleSheet,
  Document             : window.Document,
  HTMLCanvasElement    : window.HTMLCanvasElement,
  HTMLStyleElement     : window.HTMLStyleElement,
  HTMLSlotElement      : window.HTMLSlotElement,
  Text                 : window.Text,
  Comment              : window.Comment,
})

// jsdom no trae ResizeObserver: el mapa lo usa para el tamaño del contenedor, que acá nunca cambia.
globalThis.ResizeObserver = window.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} }
