// Lo que Lit y los elementos <cristae-*> tocan al evaluar y al montar en node, sobre el window/document
// de engine-stub. Se importa ANTES que cualquier elemento: un `import` estático posterior ya evalúa con
// estos shims puestos.
import { makeMap } from './engine-stub.mjs'

globalThis.HTMLElement ??= class {}
globalThis.customElements ??= { define() {}, get() {}, whenDefined: () => Promise.resolve() }
globalThis.document.createTreeWalker ??= () => ({ currentNode: null, nextNode: () => null })
globalThis.document.createDocumentFragment ??= () => ({ appendChild() {} })
globalThis.document.createTextNode ??= t => ({ data: String(t) })
globalThis.ResizeObserver ??= class { observe() {} disconnect() {} }

// Monta un <cristae-map> como lo haría su primer render, sin conectarlo: el render root sólo devuelve el
// contenedor que se le pasa al motor, y el `L.Map` real construye el mapa doble mientras dura el montaje
// (un constructor que devuelve un objeto entrega ése). `props` va encima, así que también puede traer el
// `dispatchEvent` que recoge lo emitido. El elemento y Leaflet se importan acá adentro: un import
// estático los evaluaría antes que los shims de arriba.
export const montarMapa = async (props = {}, map = makeMap()) => {
  const { default: L } = await import('leaflet')
  const { CristaeMap } = await import('../src/element/CristaeMap.js')
  const constructor    = L.Map
  const el             = Object.assign(new CristaeMap(), {
    renderRoot    : { querySelector: () => ({}) },
    dispatchEvent : () => true,
  }, props)
  L.Map = function () { return map }
  el.firstUpdated()
  await el.ready
  L.Map = constructor
  return { el, map }
}
