// Setup de jsdom para los tests de RENDER (react-dom sobre un árbol DOM real). Se importa PRIMERO en
// cada test de render: al ser una dependencia de módulo ESM, sus side effects (poblar los globals DOM)
// corren antes de que se evalúe el cuerpo de react-dom, así `document`/`window` ya existen cuando
// react-dom inicializa. No registramos los custom elements de la lib: lo que se prueba es el BINDING,
// así que un `<cristae-map>` sin definir es un elemento genérico — suficiente para observar atributos,
// propiedades y listeners que el binding le aplica.

import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
const { window } = dom

// Globals mínimos que react-dom/client y el binding tocan. Copiamos también los constructores que el
// código de test usa (CustomEvent para despachar eventos cristae:*, HTMLElement/Node por si acaso).
// `navigator` es un global de sólo-lectura en Node 24 (y su userAgent alcanza para react-dom) → no se
// reasigna: pisarlo lanza. El resto de los globals DOM sí se pueblan desde jsdom.
globalThis.window = window
globalThis.document = window.document
globalThis.HTMLElement = window.HTMLElement
globalThis.Element = window.Element
globalThis.Node = window.Node
globalThis.Event = window.Event
globalThis.CustomEvent = window.CustomEvent
globalThis.DocumentFragment = window.DocumentFragment
globalThis.getComputedStyle = window.getComputedStyle

// React 19 exige marcar el entorno de act() para flushear efectos síncronos en los tests.
globalThis.IS_REACT_ACT_ENVIRONMENT = true

export { window }
