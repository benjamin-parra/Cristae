import { mergeLabelOptions, resolvePlacement } from '../render/labelOptions.js'
import { createLabelCanvas } from '../render/LabelCanvas.js'
import { createLabelHtml } from '../render/LabelHtml.js'
import { safe } from '../data/safe.js'

// Los rótulos de `<cristae-labeled>` y de `addLabels` (DISENO-ROTULOS §1.3, §2.6 y §4.3). Son estado del
// host: cada par (rótulos, capa) es un MIEMBRO que lee en vivo la Source, la supresión, la membresía, la
// curva, la visibilidad y el foco del registro de la capa, y que pinta un renderer compartido. Los
// miembros de un host forman su grupo, `record.labels`, por donde el motor avisa y pica.

/** Un renderer por nombre. `gl` se suma cuando exista, con la misma interfaz. */
export const LABEL_RENDERERS = { canvas: createLabelCanvas, html: createLabelHtml }

// Lo que cambia la colocación. `color`, `halo` y `paint` sólo repintan, y `visible` sólo muestra u oculta.
const LAYOUT_KEYS = ['placement', 'repeat', 'offset', 'orientation', 'font', 'htmlOf', 'renderer', 'interactive']

const onTextError = e => console.error('[cristae] textOf de <cristae-labeled>', e)
const onHtmlError = e => console.error('[cristae] htmlOf de <cristae-labeled>', e)

// Lo que reciben `textOf` y `htmlOf` por cada burbuja: cuántos ítems junta y, al leerse, cuáles.
const bubbleOf = (control, b) => {
  let leaves = null
  return Object.freeze({
    count: b.count,
    get leaves() { return leaves ??= Object.freeze(control.leavesOf(b.id)) },
  })
}

/** Los rótulos de un motor. `bridge` da lo que necesitan de él:
 *  - `host`: la cámara y la superficie;
 *  - `layerOf(id)`: el registro de una capa;
 *  - `model()`: el modelo de la Tierra con que se curva una geodésica;
 *  - `slotOf(record, hostId, renderer)`: `{ key, pane, zIndex }` del renderer donde van sus rótulos;
 *  - `busOn(type, layerId, handler)`: suscripción al bus, que devuelve su baja. */
export const createLabels = bridge => {
  const slots      = new Map()            // key → { renderer, count, key }
  let bubbleWarned = false

  // Qué se rotula de un registro, o null. Un editor, el calor y la imagen no tienen ítems; un polígono con
  // `geometry` tipada no tiene Source; la burbuja de un cluster con `slot="bubble"` de rótulo tampoco.
  const kindOf = record => {
    if (record?.fold) {
      if (record.source) return 'bubble'
      bubbleWarned || console.warn('[cristae] las burbujas con <cristae-label-layer slot="bubble"> no se rotulan: ' +
        'se retira en 1.0, y el rótulo lo da un <cristae-labeled> por fuera del cluster.')
      bubbleWarned = true
      return null
    }
    switch (record?.kind) {
      case 'point'   : return 'point'
      case 'html'    : return 'html'
      case 'line'    : return 'line'
      case 'polygon' : return record.source ? 'polygon' : null
      case 'shape'   :
      case 'circle'  : return 'shape'
      default        : return null
    }
  }

  // El renderer donde van los rótulos de un host: uno por `key`, que se suelta con el último miembro.
  const acquire = (record, hostId, name) => {
    const create = LABEL_RENDERERS[name]
    if (!create) throw new TypeError(`[cristae] renderer '${name}': no está disponible`)
    const { key, pane, zIndex } = bridge.slotOf(record, hostId, name)
    const slot = slots.get(key) ?? { renderer: create({ host: bridge.host, pane, zIndex }), count: 0, key }
    slot.count++
    slots.set(key, slot)
    return slot
  }

  const release = slot => {
    if (--slot.count) return
    slots.delete(slot.key)
    slot.renderer.destroy()
  }

  // El grupo de un host: sus miembros, el hover y el foco que comparten, y el resolver fusionado.
  const createGroup = (record, hostId) => {
    const links   = []                    // { member, slot }, en orden de alta
    // Los renderers suman partes a `scratch`. Su casilla 0 es un centinela: vaciado del todo, V8 suelta el
    // almacenamiento del arreglo y el `push` siguiente lo vuelve a pedir.
    const scratch = [null]
    const merged  = []
    const group   = {
      links,
      hovered : new Set(),
      focus   : { on: false, bright: null, dim: 1 },
      off     : [],

      // `data` dice que lo colocado quedó viejo sin que la Source avisara: supresión, curva o membresía.
      invalidate(reason) {
        links.forEach(({ member, slot }) => {
          reason === 'data' && member.version++
          slot.renderer.invalidate(member, reason)
        })
      },

      // Con el foco puesto, lo que no brilla toma `dim`.
      setFocus(on, bright, dim) {
        Object.assign(group.focus, { on, bright, dim })
        group.invalidate('focus')
      },

      // Las partes de los rótulos van primero; las de la capa, salvo las del mismo ítem, que ya están.
      // Sin rótulos bajo la muestra, las de la capa tal cual. [0-alloc]
      merge(parts, sample) {
        let n = 0
        for (let m = 0; m < links.length; m++) {
          scratch.length = 1
          links[m].slot.renderer.hitsAt(links[m].member, sample, scratch)
          for (let k = 1; k < scratch.length; k++) merged[n++] = scratch[k]
        }
        if (!n) return parts
        const own = n
        for (let k = 0; k < (parts?.length ?? 0); k++) {
          let same = false
          for (let j = 0; j < own && !same; j++) same = merged[j].id === parts[k].id
          same || (merged[n++] = parts[k])
        }
        merged.length = n
        return merged
      },

      dispose: () => [...links].forEach(({ member }) => member.remove()),
    }

    // El ítem bajo el puntero lleva su rótulo encima. Sólo una capa interactiva tiene hover.
    const hover = add => hits => {
      hits.forEach(hit => add ? group.hovered.add(hit.id) : group.hovered.delete(hit.id))
      group.invalidate('hover')
    }
    record.interactive && group.off.push(bridge.busOn('hover:start', hostId, hover(true)), bridge.busOn('hover:end', hostId, hover(false)))
    return group
  }

  // Un miembro: lo que el renderer lee de un par (rótulos, capa). Leerlo no asigna.
  const add = (hostId, props) => {
    const record = bridge.layerOf(hostId)
    const kind   = kindOf(record)
    if (!kind) return null

    const first = mergeLabelOptions(null, props)
    const where = resolvePlacement(kind, first)
    let slot    = acquire(record, hostId, first.renderer)

    const group   = record.labels ??= createGroup(record, hostId)
    const source  = record.source
    const a       = source.accessors
    const idOf    = a.idOf
    const control = record.fold
    const texts   = new Map()             // id → texto, o '' sin rótulo; se rehace con los datos (P2)
    const viewOf  = control ? item => bubbleOf(control, item) : item => item
    const byId    = control ? b => String(b.count) : item => String(idOf(item))
    let stale     = true
    let removed   = false

    const textFor = item => {
      const raw = safe(member.opts.textOf ?? byId, viewOf(item), onTextError)
      return raw == null ? '' : String(raw)
    }

    // Recalcula los textos ya pedidos con el `textOf` vigente. Dice si cambió alguno.
    const retext = () => {
      let changed = stale
      stale || source.getSnapshot().forEach(item => {
        const id  = idOf(item)
        const old = texts.get(id)
        if (old === undefined) return
        const text = textFor(item)
        text === old || (texts.set(id, text), changed = true)
      })
      return changed
    }

    const sized = item => a.sizeOf ? a.sizeOf(item) : record.iconSet?.defaultSize ?? 0

    const member = {
      id        : hostId,
      kind,
      placement : where,
      opts      : first,
      version   : 0,
      get visible() { return member.opts.visible && record.visible && record.enabled },
      get curve() { return record.geodesic ? bridge.model() : null },

      // En el orden de la Source, sin lo suprimido por el cluster, lo de fuera de `where` ni lo que no
      // tiene texto. El texto se pide una vez por ítem y por versión de los datos.
      forEach(fn, arg) {
        stale && texts.clear()
        stale = false
        const items      = source.getSnapshot()
        const suppressed = record.suppressed
        const keep       = record.where
        for (let i = 0; i < items.length; i++) {
          const item = items[i]
          const id   = idOf(item)
          if (suppressed?.has(id) || keep && !keep(item)) continue
          let text = texts.get(id)
          text === undefined && texts.set(id, text = textFor(item))
          text && fn(arg, item, id, text)
        }
      },

      pathOf : kind === 'line' ? item => a.pathOf(item) : kind === 'polygon' ? item => a.ringsOf(item) : null,

      // La caja del ícono: el tamaño del punto o de la burbuja, o la del nodo HTML con el lugar del punto
      // en ella (su `anchorOf`). Una forma se rotula en su centro.
      anchorOf(item, out) {
        const p = a.positionOf(item)
        if (!(Number.isFinite(p?.lat) && Number.isFinite(p?.lng))) return null
        const size = kind === 'shape' ? 0 : kind === 'html' ? a.sizeOf?.(item) : sized(item)
        out.lat = p.lat
        out.lng = p.lng
        out.w   = Array.isArray(size) ? size[0] : size ?? 0
        out.h   = Array.isArray(size) ? size[1] : size ?? 0
        if (kind !== 'html' || !a.anchorOf) return out
        const at = a.anchorOf(item)
        out.ax = at?.[0] ?? NaN
        out.ay = at?.[1] ?? NaN
        return out
      },

      htmlOf : item => member.opts.htmlOf ? safe(member.opts.htmlOf, viewOf(item), onHtmlError) ?? null : null,
      hashOf : control ? b => `${b.id}:${b.count}` : item => String(a.hashOf ? a.hashOf(item) : idOf(item)),

      alphaOf(id) {
        const f = group.focus
        return f.on && !f.bright?.has(id) ? f.dim : 1
      },

      isHovered : id => group.hovered.has(id),

      remove() {
        if (removed) return
        removed = true
        unsub()
        slot.renderer.detach(member)
        release(slot)
        group.links.splice(group.links.findIndex(link => link.member === member), 1)
        if (group.links.length) return
        group.off.forEach(off => off())
        record.labels === group && (record.labels = null)
      },
    }

    const unsub = source.subscribe(() => {
      stale = true
      member.version++
      slot.renderer.invalidate(member, 'data')
    })
    group.links.push({ member, slot })
    slot.renderer.attach(member)

    return {
      // Valida entero antes de tocar nada: un TypeError deja los rótulos como estaban.
      update(options) {
        if (removed) return
        const prev  = member.opts
        const next  = mergeLabelOptions(prev, options)
        const at    = resolvePlacement(kind, next)
        const fresh = next.renderer === prev.renderer ? null : acquire(record, hostId, next.renderer)

        member.opts      = next
        member.placement = at
        if (fresh) {
          slot.renderer.detach(member)
          release(slot)
          group.links.find(link => link.member === member).slot = slot = fresh
          stale = true
          member.version++
          return slot.renderer.attach(member)
        }

        const relayout = LAYOUT_KEYS.some(key => next[key] !== prev[key])
        const retexted = next.textOf !== prev.textOf && retext()
        const restyled = relayout || next.color !== prev.color || next.halo !== prev.halo || next.paint !== prev.paint
        ;(relayout || retexted) && member.version++
        restyled ? slot.renderer.invalidate(member, 'style') : retexted && slot.renderer.invalidate(member, 'data')
        next.visible === prev.visible || slot.renderer.invalidate(member, 'visibility')
      },
      remove: () => member.remove(),
    }
  }

  return { add }
}
