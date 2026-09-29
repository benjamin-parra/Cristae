// Lo que Lit y los elementos <cristae-*> tocan al evaluar y al montar en node, sobre el window/document
// de engine-stub. Se importa ANTES que cualquier elemento: un `import` estático posterior ya evalúa con
// estos shims puestos.
import './engine-stub.mjs'

globalThis.HTMLElement ??= class {}
globalThis.customElements ??= { define() {}, get() {}, whenDefined: () => Promise.resolve() }
globalThis.document.createTreeWalker ??= () => ({ currentNode: null, nextNode: () => null })
globalThis.document.createDocumentFragment ??= () => ({ appendChild() {} })
globalThis.document.createTextNode ??= t => ({ data: String(t) })
globalThis.ResizeObserver ??= class { observe() {} disconnect() {} }
