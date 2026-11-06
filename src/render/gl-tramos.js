// Gestor de tramos de un mapa. Reparte las capas GL de Cristae —sus `TramoSlot`— en corridas contiguas del apilado
// y le da a cada corrida un `GlTramo`, que es un contexto. El orden es K = (z del pane, orden del pane en el DOM, orden
// del marcador dentro del pane), el mismo con que hoy se apilan los canvases. Separa todo lo que se pinta entre dos
// miembros: un pane declarado por el motor (etiquetas, rótulos, imagen, HTML, calor, realce, editores), uno ajeno o
// nativo con hijos, y lo que no es marcador dentro del pane de un miembro, que deja a ese miembro en un tramo solo.
//
// El plan es barato (n ≤ 30) y se rehace entero en cada alta, baja, separador o `replan`, y cuando el DOM de la raíz
// cambia por fuera: un pane ajeno que aparece, uno vacío que recibe hijos, una z inline que cambia. Eso lo avisa un
// `MutationObserver` por evento, sin tocar el cuadro. La identidad de los tramos la conserva `planTramos`: los tramos
// sólo se parten, nunca se funden. El hot path es `renderAtView`.

import { GlTramo, TramoSlot } from './GlTramo.js'
import { SEPARATOR, orderByZ, planTramos } from './tramo-plan.js'

const PANE_PREFIX = 'cristae-tramo-'
const CHILDREN    = { childList: true }
const STYLE       = { attributes: true, attributeFilter: ['style'] }
const BOTH        = { ...CHILDREN, ...STYLE }

// La z de un pane: la inline que le pone `host.surface`, o la de la hoja de estilo en los nativos de Leaflet, que no
// tienen una inline. Sólo al planificar: leer el estilo computado fuerza un recálculo de estilos.
const zOfPane = node => +(node.style.zIndex || node.ownerDocument?.defaultView?.getComputedStyle(node).zIndex) || 0

// `Tramo` y `Slot` se inyectan sólo en los tests del gestor.
export const createTramos = ({ host, Tramo = GlTramo, Slot = TramoSlot }) => {
  const markers  = new Map()       // marcador → slot que lo dejó en su pane
  const homes    = new Map()       // slot → registro de su tramo
  const byId     = new Map()       // id del plan → registro
  const declared = new Map()       // pane separador declarado → cuántos lo declaran
  const sticky   = new WeakSet()   // panes que recibieron hijos ajenos: separan para siempre
  const gone     = new WeakSet()   // marcadores de slots que se fueron: no cuentan aunque sigan en el DOM
  const ownPanes = new WeakSet()   // los panes de tramo: no entran al plan
  const inlineZ  = new WeakMap()   // pane → su z inline al planificar: otra z replanifica
  const surface  = host.surface

  let vacant     = []              // registros sin miembros: se destruyen al final de la microtarea, salvo reuso
  let nextId     = 0
  let seq        = 0
  let planning   = false
  let again      = false
  let sweepSet   = false
  let replanSet  = false
  let destroyed  = false
  let viewZoom   = 0
  let viewCenter = null

  // El canvas de un tramo solo vive en el pane de su miembro, junto al marcador: es propio, no lo hace mixto.
  const isOwnCanvas = node => {
    for (const rec of byId.values())
      if (rec.solo && rec.tramo.surface?.canvas === node) return true
    return vacant.some(rec => rec.solo && rec.tramo.surface?.canvas === node)
  }

  // El pane raíz del mapa: el padre del pane de algún marcador colgado.
  const rootOf = () => {
    for (const marker of markers.keys()) {
      const root = marker.parentNode?.parentNode
      if (root) return root
    }
    return null
  }

  const retire = rec => {
    rec.tramo.destroy()
    if (!rec.node) return
    ownPanes.delete(rec.node)
    surface.unmount(rec.name)
  }

  // Un tramo vacío se va al final de la microtarea de la tarea que lo vació: una alta de esa misma tarea lo reusa
  // (recambio sin getContext).
  const sweep = () => {
    sweepSet = false
    const list = vacant
    vacant = []
    list.forEach(retire)
  }

  // Un registro vacío que sirve a la corrida: mismo tipo y, si es solo, el mismo pane. Primero el que ya estaba
  // anclado al pane de su miembro de menor K.
  const adopt = (solo, pane, anchor) => {
    const fits = rec => rec.solo === solo && (!solo || rec.name === pane)
    let at = vacant.findIndex(rec => fits(rec) && rec.anchor === anchor)
    at < 0 && (at = vacant.findIndex(fits))
    return at < 0 ? null : vacant.splice(at, 1)[0]
  }

  const create = (solo, pane, z) => {
    const name = solo ? pane : PANE_PREFIX + seq++
    const node = solo ? null : surface.mount(name, z, { pointer: false })
    node && ownPanes.add(node)
    return { id: -1, tramo: new Tramo({ host, pane: name, solo, onForeign }), solo, name, node, anchor: null, z,
      list: [], count: 0, watch: [] }
  }

  const plan = () => {
    // 1. Los panes de la raíz en orden (z, DOM), sin los de tramo.
    const root  = rootOf()
    const panes = []
    const zs    = []
    root && Array.prototype.forEach.call(root.children, node => {
      if (ownPanes.has(node)) return
      panes.push(node)
      zs.push(zOfPane(node))
    })
    const order = orderByZ(zs, zs.length, new Array(zs.length))

    // 2. Tokens: un miembro por marcador; separadores; los panes vacíos quedan anotados para vigilarlos.
    const tokens  = []
    const members = []
    const soloOf  = []
    const paneOf  = []
    const zOf     = []
    const cands   = []
    const candAt  = []
    const push    = (slot, solo, pane, z) => {
      solo && tokens.push(SEPARATOR)
      tokens.push(members.length)
      members.push(slot)
      soloOf.push(solo)
      paneOf.push(pane)
      zOf.push(z)
      solo && tokens.push(SEPARATOR)
    }
    for (let k = 0; k < order.length; k++) {
      const pane = panes[order[k]]
      let marks  = 0
      let others = 0
      let dead   = false
      for (const child of pane.children) {
        if (gone.has(child)) dead = true
        else if (markers.has(child)) marks++
        else isOwnCanvas(child) || others++
      }
      const apart = declared.has(pane) || sticky.has(pane) || others > 0
      if (!marks) {
        if (apart) tokens.push(SEPARATOR)
        else if (!dead) {                // con el marcador de un slot ido, vigilarlo daría un ajeno falso
          cands.push(pane)
          candAt.push(tokens.length)
        }
        continue
      }
      for (const child of pane.children) {
        const slot = !gone.has(child) && markers.get(child)
        slot && push(slot, apart, pane, zs[order[k]])
      }
    }
    // Un marcador que no cuelga de un pane de la raíz (un DOM sin árbol) no tiene K: su miembro va solo, con un contexto
    // propio como antes de los tramos.
    markers.forEach(slot => members.includes(slot) || push(slot, true, slot.marker.parentNode, slot.z))

    const prev = members.map(slot => homes.get(slot)?.id ?? -1)
    const out  = new Array(tokens.length)
    nextId = planTramos(tokens, tokens.length, prev, nextId, out)

    // 3. Corridas: miembros consecutivos con el mismo id. Un id reusado que no coincide en solo/normal es fresco.
    const runs  = []
    const taken = new Set()
    let run = null
    tokens.forEach((m, i) => {
      if (m === SEPARATOR) {
        run = null
        return
      }
      if (run?.id !== out[i]) {
        const rec = byId.get(out[i])
        const ok  = !!rec && rec.solo === soloOf[m] && !taken.has(rec)
        ok && taken.add(rec)
        runs.push(run = { id: out[i], rec: ok ? rec : null, solo: soloOf[m], list: [], first: m, from: i, to: i })
      }
      run.list.push(members[m])
      run.to = i
    })
    const nextHome = new Map()
    runs.forEach(r => r.list.forEach(slot => nextHome.set(slot, r)))

    // 4. Primero se encoge: el que se muda de tramo suelta el contexto viejo (`dropGl`) antes de armarse en el nuevo.
    byId.forEach(rec => {
      const keep = rec.list.filter(slot => nextHome.get(slot)?.rec === rec)
      if (keep.length !== rec.count) {
        rec.list  = keep
        rec.count = keep.length
        rec.tramo.setMembers(keep, keep.length)
      }
      taken.has(rec) || vacant.push(rec)
    })
    byId.clear()
    homes.clear()

    // 5. Después se arma cada corrida, en orden K.
    let lastAnchor = null
    let lastNode   = null
    runs.forEach(r => {
      const anchor = paneOf[r.first]
      const z      = zOf[r.first]
      const rec    = r.rec ?? adopt(r.solo, r.list[0].pane, anchor) ?? create(r.solo, r.list[0].pane, z)
      const same   = rec.count === r.list.length && r.list.every((slot, i) => rec.list[i] === slot)
      rec.id    = r.id
      rec.list  = r.list
      rec.count = r.list.length
      byId.set(r.id, rec)
      r.list.forEach(slot => homes.set(slot, rec))

      // El pane del tramo va justo después del de su miembro de menor K, con su z. Dos tramos anclados al mismo pane
      // quedan en orden K.
      // Un tramo solo cuyo canvas ya no sigue al marcador (un recambio movió el marcador) lo vuelve a poner detrás.
      const canvas = rec.tramo.surface?.canvas
      const marker = r.list[0].marker
      let moved = rec.solo && !!canvas && !!marker?.parentNode && marker.nextSibling !== canvas
      if (!rec.solo) {
        const after = anchor === lastAnchor ? lastNode : anchor
        moved = rec.anchor !== null && (rec.anchor !== anchor || rec.z !== z || after.nextSibling !== rec.node)
        after.nextSibling === rec.node || after.after(rec.node)
        rec.z === z || surface.setZ(rec.name, z)
        rec.anchor = anchor
        rec.z      = z
        lastAnchor = anchor
        lastNode   = rec.node
      }
      same || rec.tramo.setMembers(rec.list, rec.count)
      moved && rec.tramo.touch()                // mover el pane compone en esta tarea

      rec.watch.length = 0
      cands.forEach((node, c) => candAt[c] > r.from && candAt[c] <= r.to && rec.watch.push(node))
      rec.tramo.watch(rec.watch, rec.watch.length)
    })

    // 6. Se vigila lo que el plan acaba de leer. Re-observar descarta los registros pendientes, que son los del plan
    // mismo (mover y montar panes de tramo) o anteriores a lo que leyó.
    if (observer) {
      observer.disconnect()
      if (root) {
        observer.observe(root, CHILDREN)
        panes.forEach(observeZ)
        cands.forEach(node => observer.observe(node, BOTH))   // reemplaza las opciones de `observeZ`
      }
    }

    if (vacant.length && !sweepSet) {
      sweepSet = true
      queueMicrotask(sweep)
    }
  }

  // Un alta durante un plan (un `buildGl` que abre otra capa) se planifica al terminar el que corre.
  const replan = () => {
    if (destroyed) return
    if (planning) {
      again = true
      return
    }
    planning = true
    try {
      do {
        again = false
        plan()
      } while (again)
    } finally {
      planning = false
    }
  }

  const replanLater = () => {
    replanSet = false
    replan()
  }

  // Un pane vigilado recibió hijos al componer: separa para siempre (el renderer de Leaflet no se va nunca).
  const later = () => {
    if (replanSet) return
    replanSet = true
    queueMicrotask(replanLater)
  }

  const onForeign = node => {
    sticky.add(node)
    later()
  }

  // Un pane vacío vigilado que recibió hijos separa para siempre; un pane nuevo o que se fue de la raíz, o una z inline
  // distinta de la planificada, replanifican. Un estilo que no toca la z (opacidad, visibilidad) no hace nada.
  const onMutation = list => list.forEach(r =>
    r.type === 'attributes' ? r.target.style.zIndex !== inlineZ.get(r.target) && later()
      : r.target.firstChild && r.target !== rootOf() ? onForeign(r.target)
      : later())

  const observer = typeof MutationObserver === 'function' ? new MutationObserver(onMutation) : null
  const observeZ = node => {
    inlineZ.set(node, node.style.zIndex)
    observer.observe(node, STYLE)
  }

  const hooks = {
    place: slot => {
      if (destroyed) return
      gone.delete(slot.marker)
      markers.set(slot.marker, slot)
      replan()
    },
    remove: slot => {
      gone.add(slot.marker)
      markers.delete(slot.marker)
      replan()
    },
  }

  const renderEach = rec => rec.tramo.renderAtView(viewZoom, viewCenter)

  return {
    surface: opts => new Slot(opts, hooks),

    separator(pane) {
      declared.set(pane, (declared.get(pane) ?? 0) + 1)
      replan()
      let held = true
      return () => {
        if (!held) return
        held = false
        const n = declared.get(pane) - 1
        n ? declared.set(pane, n) : declared.delete(pane)
        replan()
      }
    },

    replan,

    // [0-alloc] callback estable y la vista en campos.
    renderAtView(zoom, center) {
      viewZoom   = zoom
      viewCenter = center
      byId.forEach(renderEach)
    },

    get size() { return byId.size + vacant.length },

    destroy() {
      destroyed = true
      observer?.disconnect()
      byId.forEach(retire)
      vacant.forEach(retire)
      byId.clear()
      homes.clear()
      markers.clear()
      declared.clear()
      vacant = []
    },
  }
}
