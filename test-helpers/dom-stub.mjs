// Stub DOM mínimo para montar engines headless (PagedTable) bajo node:test.
// NO es un jsdom casero: solo existe lo que el motor toca — createElement/createDocumentFragment,
// un nodo con children/appendChild/insertBefore/remove/querySelectorAll/dataset/style/closest,
// requestAnimationFrame, ResizeObserver e IntersectionObserver.
// `dataset` copia la semántica real del DOM (todo valor se guarda como STRING): el motor asigna
// `dataset.rowIdx = <number>` y el contrato observable es la cadena.

// ── Selectores soportados: `[attr]`, `[attr="v"]`, `.clase`, `tag` ──
const matchesSelector = (el, sel) => {
  const attrs = el.attrs ?? {}
  const attr = /^\[([^\]=]+)(?:="([^"]*)")?\]$/.exec(sel)
  if (attr) return attr[2] === undefined ? attrs[attr[1]] !== undefined : attrs[attr[1]] === attr[2]
  if (sel[0] === '.') return String(attrs.class ?? '').split(/\s+/).includes(sel.slice(1))
  return el.tagName === sel.toUpperCase()
}

const camel = name => name.replace(/^data-/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase())

// dataset con coerción a string, igual que DOMStringMap. Guarda aparte el valor CRUDO (tal como lo
// asignó el motor) para poder asertar sobre el módulo y no sobre esta coerción: sin esto, cualquier
// cosa que se asigne sale string y el aserto `typeof === 'string'` lo garantiza el stub, no el motor.
export const CRUDOS = Symbol('valores del dataset antes de la coerción DOM')

const makeDataset = (seed = {}) => {
  const crudos = { ...seed }
  return new Proxy({ ...seed }, {
    get: (target, key) => (key === CRUDOS ? crudos : target[key]),
    set: (target, key, value) => { crudos[key] = value; target[key] = String(value); return true },
  })
}

// Lo que el motor ASIGNÓ a `dataset`, sin coerción: `datasetCrudo(el).rowIdx`.
export const datasetCrudo = el => el.dataset[CRUDOS]

class StubText {
  constructor(text) { this.data = String(text); this.parentNode = null }
  get textContent() { return this.data }
  set textContent(v) { this.data = String(v) }
  get nextSibling() { return siblingAfter(this) }
  remove() { this.parentNode?.removeChild(this) }
  cloneNode() { return new StubText(this.data) }
}

const siblingAfter = node => {
  const hermanos = node.parentNode?.children
  if (!hermanos) return null
  return hermanos[hermanos.indexOf(node) + 1] ?? null
}

class StubElement {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase()
    this.children = []            // nodos hijos (elementos y texto), en orden
    this.parentNode = null
    this.attrs = {}
    this.dataset = makeDataset()
    this.style = {}
    this.scrollTop = 0
    this.clientHeight = 0
    this.listeners = {}
  }

  get firstElementChild() { return this.children.find(n => n instanceof StubElement) ?? null }
  get nextSibling() { return siblingAfter(this) }

  appendChild(node) {
    if (node instanceof StubFragment) { node.drain().forEach(hijo => this.appendChild(hijo)); return node }
    node.parentNode?.removeChild(node)
    node.parentNode = this
    this.children.push(node)
    return node
  }

  insertBefore(node, ref) {
    if (node instanceof StubFragment) { node.drain().forEach(hijo => this.insertBefore(hijo, ref)); return node }
    node.parentNode?.removeChild(node)
    node.parentNode = this
    const at = ref ? this.children.indexOf(ref) : -1
    if (at < 0) this.children.push(node)
    else this.children.splice(at, 0, node)
    return node
  }

  removeChild(node) {
    const at = this.children.indexOf(node)
    if (at >= 0) this.children.splice(at, 1)
    node.parentNode = null
    return node
  }

  remove() { this.parentNode?.removeChild(this) }

  get textContent() { return this.children.map(n => n.textContent).join('') }
  set textContent(v) {
    this.children.splice(0).forEach(n => { n.parentNode = null })
    if (v !== '' && v != null) this.appendChild(new StubText(v))
  }

  setAttribute(name, value) {
    this.attrs[name] = String(value)
    if (name.startsWith('data-')) this.dataset[camel(name)] = value
  }
  getAttribute(name) { return this.attrs[name] ?? null }

  closest(sel) {
    for (let nodo = this; nodo; nodo = nodo.parentNode) if (matchesSelector(nodo, sel)) return nodo
    return null
  }

  querySelectorAll(sel) {
    const out = []
    const visita = nodo => nodo.children.forEach(hijo => {
      if (!(hijo instanceof StubElement)) return
      if (matchesSelector(hijo, sel)) out.push(hijo)
      visita(hijo)
    })
    visita(this)
    return out
  }

  cloneNode(deep = false) {
    const copia = new StubElement(this.tagName)
    copia.attrs = { ...this.attrs }
    copia.dataset = makeDataset({ ...this.dataset })
    copia.style = { ...this.style }
    if (deep) this.children.forEach(hijo => copia.appendChild(hijo.cloneNode(true)))
    return copia
  }

  // El motor pasa `{ signal }`: honrarlo importa para que destroy() apague de verdad el scroll.
  addEventListener(type, fn, options = {}) {
    (this.listeners[type] ??= []).push(fn)
    options.signal?.addEventListener?.('abort', () => this.removeEventListener(type, fn))
  }
  removeEventListener(type, fn) {
    const lista = this.listeners[type]
    if (lista) this.listeners[type] = lista.filter(f => f !== fn)
  }
  dispatch(type, evento = { type }) { (this.listeners[type] ?? []).slice().forEach(fn => fn(evento)) }
}

class StubFragment {
  constructor() { this.children = [] }
  get firstElementChild() { return this.children.find(n => n instanceof StubElement) ?? null }
  appendChild(node) { node.parentNode?.removeChild(node); node.parentNode = this; this.children.push(node); return node }
  removeChild(node) {
    const at = this.children.indexOf(node)
    if (at >= 0) this.children.splice(at, 1)
    node.parentNode = null
    return node
  }
  drain() { return this.children.splice(0) }
}

// <template>: `innerHTML` parsea a `content` (fragmento) — de ahí clona el pool de filas.
class StubTemplate extends StubElement {
  constructor() { super('template'); this.content = new StubFragment() }
  set innerHTML(html) { this.content = parseHTML(html) }
  get innerHTML() { return this.content.children.map(n => n.textContent).join('') }
}

// Parser de una plantilla de fila: tags con atributos, anidamiento y texto. Nada de comentarios,
// entidades ni auto-cierre implícito — la plantilla de fila del motor es HTML trivial.
const TOKEN = /<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s/>=]+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/g
const ATTR = /([^\s=]+)(?:="([^"]*)")?/g

export const parseHTML = html => {
  const root = new StubFragment()
  const pila = [root]
  TOKEN.lastIndex = 0
  for (let m; (m = TOKEN.exec(html));) {
    const [, cierre, apertura, attrs, selfClose, texto] = m
    if (cierre) { if (pila.length > 1) pila.pop(); continue }
    if (texto) { if (texto.trim()) pila.at(-1).appendChild(new StubText(texto)); continue }
    const el = new StubElement(apertura)
    ATTR.lastIndex = 0
    for (let a; (a = ATTR.exec(attrs ?? ''));) el.setAttribute(a[1], a[2] ?? '')
    pila.at(-1).appendChild(el)
    if (!selfClose) pila.push(el)
  }
  return root
}

// ── Observers: guardan su callback para que el test pueda dispararlos a mano ──
export const resizeObservers = []
export const intersectionObservers = []

class StubResizeObserver {
  constructor(cb) { this.cb = cb; this.targets = []; this.activo = true; resizeObservers.push(this) }
  observe(el) { this.targets.push(el) }
  disconnect() { this.activo = false; this.targets.length = 0 }
  // Desconectado ya no notifica (igual que el observer real).
  trigger(alto) { if (this.activo) this.cb([{ contentRect: { height: alto }, target: this.targets[0] }], this) }
}

class StubIntersectionObserver {
  constructor(cb) { this.cb = cb; this.targets = []; this.activo = true; intersectionObservers.push(this) }
  observe(el) { this.targets.push(el) }
  disconnect() { this.activo = false; this.targets.length = 0 }
  trigger(visible) { if (this.activo) this.cb([{ isIntersecting: visible, target: this.targets[0] }], this) }
}

export const installDomStub = () => {
  if (globalThis.document?.__esStub) return globalThis.document
  globalThis.document = {
    __esStub: true,
    createElement: tag => (String(tag).toLowerCase() === 'template' ? new StubTemplate() : new StubElement(tag)),
    createDocumentFragment: () => new StubFragment(),
    createTextNode: texto => new StubText(texto),
  }
  globalThis.requestAnimationFrame = cb => setTimeout(() => cb(0), 0)
  globalThis.cancelAnimationFrame = id => clearTimeout(id)
  globalThis.ResizeObserver = StubResizeObserver
  globalThis.IntersectionObserver = StubIntersectionObserver
  return globalThis.document
}

installDomStub()

// El rAF del stub es setTimeout(0): un tick de macrotarea alcanza para ver el pipeline aplicado.
export const flushRaf = () => new Promise(r => setTimeout(r, 0))

export { StubElement, StubFragment, StubText, StubTemplate }
