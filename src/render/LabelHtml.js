// Rótulos en nodos DOM: el renderer `html` de `<cristae-labeled>` (DISENO-ROTULOS §3.4). Del pane que
// recibe cuelga un nodo por miembro y, adentro, uno por colocación, reconciliado por id: el contenido de
// un ítem se arma una vez y otra sólo si cambia (su texto, o el hash con `htmlOf`), así un listener
// puesto en el nodo sobrevive a los ticks. La colocación es la de los otros renderers, sin medida: un
// ancla y un ángulo por ítem y parte, ya derecho para quien lee. Cada contenido se mide una vez, sin
// giro, y esa medida es la caja de la colocación: la orientada que se pica, sin volver a preguntarle al DOM.
//
// Sigue la vista solo, como `HtmlLayer`: un paneo no reescribe nada, un zoom animado lleva cada nodo a su
// destino con la transición de la superficie, y la vista que asienta recoloca en el cuadro siguiente.
// Lo demás —datos, opciones, foco, hover, visibilidad— lo avisa el motor con `invalidate`, y los avisos
// de un cuadro son un solo pintado.

import { createLayout, readLabelView } from './labelLayout.js'
import { frameTransform } from './frame.js'
import { projX0, projY0 } from './project.js'

// Lo que pide repintar a un miembro, acumulado hasta el cuadro siguiente. `view` no lo avisa el motor.
const REASON = { data: 1, style: 2, focus: 4, hover: 8, visibility: 16, view: 32 }
const STALE  = REASON.data | REASON.style
const DECOR  = REASON.focus | REASON.hover

// El nodo cuelga del ancla por su centro: primero el giro, alrededor del ancla, y después el centrado.
const CENTERED = ' translate(-50%, -50%)'

// El halo de 3 px de `canvas` es un trazo centrado en el borde del glifo: 1,5 px hacia afuera, que en
// CSS son ocho sombras sin desenfoque alrededor del texto.
const RING = [0, 1, 2, 3, 4, 5, 6, 7].map(k =>
  `${(1.5 * Math.cos(k * Math.PI / 4)).toFixed(2)}px ${(1.5 * Math.sin(k * Math.PI / 4)).toFixed(2)}px 0`)
const haloOf = halo => halo === 'none' ? '' : RING.map(at => `${at} ${halo}`).join(', ')

// Escribe sólo si cambia: un tick que no movió nada no toca el estilo de nadie.
const write = (target, key, value) => target[key] === value || (target[key] = value)

// El contenido de una entrada en un nodo: el texto por `textContent`, sin interpretar HTML; un string de
// `htmlOf` por `innerHTML`; un `Node`, tal cual en el primero y copiado en los demás.
const fill = (el, entry, first) => {
  const content = entry.content
  if (entry.text !== null) el.textContent = entry.text
  else if (typeof content === 'string') el.innerHTML = content
  else {
    el.textContent = ''
    content && el.appendChild(first ? content : content.cloneNode(true))
  }
}

// El contenido cambió: las copias de las otras partes se rehacen y la medida se repite.
const restart = entry => {
  for (let k = 1; k < entry.nodes.length; k++) entry.nodes[k].el.remove()
  entry.nodes.length = Math.min(entry.nodes.length, 1)
  entry.nodes.length && fill(entry.nodes[0].el, entry, true)
  entry.w = -1
}

// Por cada ítem rotulable del miembro (`member.forEach`): su entrada, con el contenido al día. Es estable,
// y el estado del miembro llega como argumento.
const visit = (state, item, id, text) => {
  const entry = state.byId.get(id) ?? state.byId.set(id, {
    id,
    nodes   : [],          // el primero lleva el contenido; los demás, copias para las otras partes
    text    : null,        // el de `textOf`, o null con `htmlOf`
    content : null,        // el de `htmlOf`
    hash    : undefined,
    empty   : false,       // `htmlOf` no dio nada: sin rótulo
    w       : -1,          // la medida del contenido, sin giro; -1 hasta medirlo
    h       : -1,
    seen    : 0,           // la última reconciliación que lo vio
    used    : 0,           // cuántas colocaciones lo usan
  }).get(id)
  entry.seen = state.pass
  if (!state.html) {
    if (entry.text === text) return
    entry.text  = text
    entry.empty = false
    restart(entry)
    return
  }

  const hash = state.member.hashOf(item)
  if (hash === entry.hash) return
  const content = state.member.htmlOf(item)
  entry.hash    = hash
  entry.content = content ?? null
  entry.empty   = content == null || content === ''
  restart(entry)
}

// Una entrada que el pintado anterior no usó entera: sus copias sobrantes salen, y el primer nodo sale del
// documento pero queda, para que la parte que vuelva sea el mismo nodo.
const trim = entry => {
  for (let k = Math.max(entry.used, 1); k < entry.nodes.length; k++) entry.nodes[k].el.remove()
  entry.nodes.length = Math.min(entry.nodes.length, Math.max(entry.used, 1))
  entry.used || entry.nodes[0]?.el.remove()
}

export const createLabelHtml = ({ host, pane, zIndex }) => {
  const { camera, surface } = host
  const paneNode = surface.mount(pane, zIndex, { pointer: false })
  const members  = new Map()   // miembro → su estado, en el orden de attach, que es el de pintado
  const view     = {}          // la vista con que se coloca, reusada
  let frame      = 0           // el rAF del pintado pendiente
  let toward     = null        // la vista destino de un zoom animado
  let zooming    = false       // hay un zoom en curso: no se pica
  let moved      = false       // el marco se corrió desde la última colocación asentada
  let settling   = false       // el pintado pendiente es el de una vista que asentó

  // La vista de la cámara o, con un zoom animado, la de destino: el centro destino en el medio del
  // contenedor, con el marco de ahora, como `HtmlLayer`.
  const readView = () => {
    readLabelView(camera, view)
    if (!toward) return view
    view.cx    = projX0(toward.center.lng)
    view.cy    = projY0(toward.center.lat)
    view.scale = 2 ** toward.zoom
    return view
  }

  const nodeOf = entry => {
    const el    = document.createElement('div')
    const style = el.style
    el.className          = 'cristae-label'
    style.position        = 'absolute'
    style.left            = '0'
    style.top             = '0'
    style.width           = 'max-content'
    style.transformOrigin = '0 0'
    surface.followZoom(el)
    fill(el, entry, !entry.nodes.length)
    const node = { el, entry, transform: null, alpha: 1, hovered: false }
    entry.nodes.push(node)
    return node
  }

  // Lo que sale de las opciones y vale para todo el miembro: el modo del contenido, el aspecto, que va en
  // su nodo y heredan los rótulos, y el puntero. Cambiar de `textOf` a `htmlOf` rehace los nodos.
  const configure = state => {
    const { opts } = state.member
    const html     = opts.htmlOf != null
    const style    = state.root.style
    if (html !== state.html) {
      state.byId.forEach(entry => entry.nodes.forEach(node => node.el.remove()))
      state.byId.clear()
      state.html = html
    }
    write(style, 'font', html ? '' : opts.font)
    write(style, 'color', html ? '' : opts.color)
    write(style, 'textShadow', html ? '' : haloOf(opts.halo))
    write(style, 'whiteSpace', html ? '' : 'pre')

    const interactive = !!opts.interactive
    if (interactive === state.interactive) return
    state.interactive   = interactive
    style.pointerEvents = interactive ? 'auto' : 'none'
    style.userSelect    = interactive ? '' : 'none'
    state.unshield?.()
    state.unshield = interactive ? surface.shield(state.root) : null
  }

  // Los datos o las opciones cambiaron: el contenido de cada ítem al día, y fuera los que ya no están.
  const reconcile = state => {
    configure(state)
    state.pass++
    state.member.forEach(visit, state)
    state.byId.forEach((entry, id) => {
      if (entry.seen === state.pass) return
      entry.nodes.forEach(node => node.el.remove())
      state.byId.delete(id)
    })
    state.version = state.member.version
  }

  // Foco y hover, por nodo: la opacidad y quién queda encima. Sólo escribe lo que cambió.
  const decorate = state => {
    const { member, slots } = state
    for (let p = 0; p < state.count; p++) {
      const node = slots[p]
      if (!node) continue
      const alpha   = member.alphaOf(node.entry.id)
      const hovered = member.isHovered(node.entry.id)
      if (alpha !== node.alpha) node.el.style.opacity = alpha >= 1 ? '' : String(alpha)
      if (hovered !== node.hovered) node.el.style.zIndex = hovered ? '1' : ''
      node.alpha   = alpha
      node.hovered = hovered
    }
  }

  // Coloca con la vista `v`: un nodo por colocación, los nuevos medidos en una sola lectura, la caja de
  // cada uno en la colocación y el transform que la sigue. Primero se escribe el contenido, después se
  // mide todo junto y al final se escriben los transforms: un solo layout por pintado.
  const place = (state, v) => {
    const { layout, slots, root } = state
    layout.place(state.member, v, null)
    state.origin.x = v.ox
    state.origin.y = v.oy
    state.byId.forEach(entry => (entry.used = 0))

    const count = layout.placementCount
    for (let p = 0; p < count; p++) {
      const entry = state.byId.get(layout.ids[layout.spans[3 * p + 2]])
      const node  = entry && !entry.empty ? entry.nodes[entry.used] ?? nodeOf(entry) : null
      slots[p]    = node
      if (!node) continue
      entry.used++
      node.el.parentNode === root || root.appendChild(node.el)
    }
    slots.length = state.count = count
    state.byId.forEach(trim)

    for (let p = 0; p < count; p++) {
      const entry = slots[p]?.entry
      if (!entry || entry.w >= 0) continue
      entry.w = entry.nodes[0].el.offsetWidth
      entry.h = entry.nodes[0].el.offsetHeight
    }
    for (let p = 0; p < count; p++) slots[p] && layout.size(p, slots[p].entry.w, slots[p].entry.h)

    const boxes = layout.boxes
    for (let p = 0; p < count; p++) {
      const node = slots[p]
      if (!node) continue
      const at        = 5 * p
      const angle     = boxes[at + 2]
      const transform = frameTransform(Math.round(boxes[at] + v.ox), Math.round(boxes[at + 1] + v.oy))
        + (angle ? ` rotate(${angle}rad)` : '') + CENTERED
      if (transform === node.transform) continue
      node.transform          = transform
      node.el.style.transform = transform
    }
    decorate(state)
  }

  // El pintado de un miembro en el cuadro. Oculto no hace nada y guarda lo pendiente para cuando vuelva.
  const paint = state => {
    const { member, root } = state
    if (!member.visible) {
      state.shown && (root.style.display = 'none')
      state.shown = false
      return
    }

    const dirty = state.dirty
    const shown = state.shown
    const stale = state.version !== member.version || dirty & STALE
    state.dirty = 0
    state.shown = true
    shown || (root.style.display = '')
    stale && reconcile(state)
    if (stale || !shown || dirty & REASON.view) place(state, readView())
    else dirty & DECOR && decorate(state)
  }

  const flush = () => {
    frame = 0
    if (!camera.hasView()) return
    members.forEach(paint)
    settling && (moved = settling = false)
  }
  const schedule = () => frame || (frame = requestAnimationFrame(flush))

  // Durante un zoom, cada nodo va a donde estará: con destino, al recibirlo; sin él —pinch, `flyTo`—, en
  // cada `move`. Fuera de un zoom, un `move` es un paneo, que el marco ya se lleva.
  const follow = () => {
    const v = readView()
    members.forEach(state => state.shown && state.count && place(state, v))
  }
  const offs = [
    camera.on('movestart', () => {
      moved    = true
      settling = false
    }),
    camera.on('zoomstart', () => (zooming = true)),
    camera.on('zoomanim', destination => {
      toward = destination
      follow()
    }),
    camera.on('move', () => zooming && follow()),
    camera.on('moveend zoomend resize', () => {
      zooming  = false
      toward   = null
      settling = true
      members.forEach(state => (state.dirty |= REASON.view))
      schedule()
    }),
  ]

  return {
    get zIndex() { return zIndex },

    // El host del pane cambió de rango: el pane pasa a `z`. Dice si se movió.
    setZ(z) {
      if (z === zIndex) return false
      zIndex = z
      surface.setZ(pane, z)
      return true
    },

    attach(member) {
      if (members.has(member)) return
      const root = document.createElement('div')
      root.className           = 'cristae-labels'
      root.style.position      = 'absolute'
      root.style.left          = '0'
      root.style.top           = '0'
      root.style.pointerEvents = 'none'
      root.style.userSelect    = 'none'
      paneNode.appendChild(root)
      members.set(member, {
        member, root,
        layout      : createLayout(),
        byId        : new Map(),   // id → entrada: contenido, nodos y medida
        slots       : [],          // por colocación, su nodo (null si el ítem no se pinta)
        count       : 0,
        origin      : { x: 0, y: 0 },   // el del marco con que se colocó
        version     : NaN,
        dirty       : 0,
        pass        : 0,           // la reconciliación en curso
        shown       : true,
        html        : false,
        interactive : false,
        unshield    : null,
      })
      schedule()
    },

    invalidate(member, reason) {
      const state = members.get(member)
      if (!state) return
      state.dirty |= REASON[reason] ?? REASON.data
      schedule()
    },

    detach(member) {
      const state = members.get(member)
      if (!state) return
      state.unshield?.()
      state.root.remove()
      members.delete(member)
    },

    // La caja orientada de cada colocación, que es la de su contenido medido, por la de la colocación
    // (`layout.hitsAt`). Mientras el marco se corre lee su origen, que es un punto nuevo; en reposo pasa el
    // de la colocación y no asigna. Agrega a `out` y no lo vacía. Nada durante un zoom ni con
    // `interactive`, que le da el puntero al nodo. [0-alloc] en reposo.
    hitsAt(member, sample, out) {
      const state = members.get(member)
      if (zooming || !state || !member.visible || state.interactive || !state.count) return out
      const from = out.length
      state.layout.hitsAt(sample, moved ? camera.frameOrigin() : state.origin, out)
      for (let i = from; i < out.length; i++) out[i].zIndex = zIndex
      return out
    },

    destroy() {
      frame && cancelAnimationFrame(frame)
      frame = 0
      offs.forEach(off => off())
      members.forEach(state => {
        state.unshield?.()
        state.root.remove()
      })
      members.clear()
      surface.unmount(pane)
    },
  }
}
