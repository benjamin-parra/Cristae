// El DOM de jsdom sobre el que corren los tests con el Leaflet REAL. Leaflet lee window y document al
// evaluarse, y decide ahí si puede animar: sin transformaciones 3D no anima ningún zoom ni vuela, y
// `WebKitCSSMatrix` es lo que mira para saberlo. Por eso el DOM se prepara antes de importarlo, que va
// dinámico:
//
//   import { prepararDom, contenedor } from '../../test-helpers/leaflet-real.mjs'
//   const window         = prepararDom({ transformaciones3d: true })
//   const { default: L } = await import('leaflet')
import { JSDOM, VirtualConsole } from 'jsdom'

export const prepararDom = ({ transformaciones3d = false } = {}) => {
  const { window } = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true, virtualConsole: new VirtualConsole() })
  transformaciones3d && (window.WebKitCSSMatrix = class { m11 = 1 })
  globalThis.window                = window
  globalThis.document              = window.document
  globalThis.requestAnimationFrame = window.requestAnimationFrame
  globalThis.cancelAnimationFrame  = window.cancelAnimationFrame
  return window
}

// Un contenedor de 800×600 en el documento: jsdom no mide, así que el tamaño y la caja se declaran.
export const contenedor = () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  Object.entries({ clientWidth: 800, clientHeight: 600, offsetWidth: 800, offsetHeight: 600 })
    .forEach(([k, value]) => Object.defineProperty(container, k, { value }))
  container.getBoundingClientRect = () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0 })
  return container
}
