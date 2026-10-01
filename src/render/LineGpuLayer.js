import { EditSurface } from './EditSurface.js'
import { LineStore } from './LineStore.js'
import { StrokePass, ownDash } from './StrokePass.js'
import { projX0, projY0, readView } from './project.js'
import { toRGBA } from './color.js'
import { focusFactor } from './focus.js'
import { coordOf } from '../data/path.js'
import { foldPart, foldRuns, nearest, prepareIndex, toParts } from '../geometry/polyline.js'

// Líneas con grosor REAL: el trazo sale del mismo `StrokePass` que el contorno de polígonos —un quad
// por segmento, expandido en el vertex shader desde una textura de posiciones—, y `LineStore` guarda los
// vértices de modo que una entidad se reescriba o crezca sin rehacer las demás.
//
// `styleOf` puede traer `dash` —un patrón en píxeles de pantalla que corre continuo a lo largo de cada
// parte— y `cap` para las tapas de cada trazo del patrón o, sin dash, de las dos puntas de la parte.
//
// Con `scalarOf` y `colorRamp` el color sale por vértice, de `colorRamp(scalarOf(item, i))`, con `i` la
// posición del vértice en el path de la entrada, y `styleOf.color` no se lee; `opacity` sí. El foco
// atenúa la entidad entera, no sus vértices.
//
// Cada entidad es una `rec` con un slot del store por tramo: los tramos separados por baches comparten
// estilo y no se unen. El que llega al final del path —el abierto, `tail`— puede seguir creciendo con
// `append`; si es de un solo vértice no dibuja nada pero se guarda (`lone`) para unirse al siguiente.

const HIT_TOL_PX    = 8
const OPAQUE        = '#ffffff'
const DEFAULT_STYLE = { color: '#3388ff', weight: 3, opacity: 1 }

// `runs` guarda cuatro valores por tramo: [vértices, first, count, from]. Viven en el módulo, estables
// entre llamadas, por lo que dice `foldRuns`.
const collect = (ctx, vertices, first, count, from) => {
  ctx.runs.push(vertices, first, count, from)
  ctx.points += count
  return ctx
}

const countCut = ctx => {
  ctx.cuts++
  return ctx
}

export class LineGpuLayer {

  #camera; #surface; #gl; #stroke; #source; #styleOf; #pathOf; #idOf; #scalarOf; #ramp; #base
  #store     = null
  #recs      = new Map()              // id → rec
  #snapLen   = -1                     // tamaño del snapshot del último rebuild (detecta alta/baja)
  #index     = null                   // nearest-segment; null hasta el primer hit
  #unsub     = null
  #offView   = null
  #visible   = true
  #maxWeight = 0                      // sólo crece entre rebuilds: una tolerancia generosa no pierde un click
  #focus     = { ids: null, dim: 0.3 }
  #ctx       = { runs: [], points: 0, cuts: 0 }
  #xy        = new Float64Array(64)
  #rgba      = new Uint8Array(0)      // con gradiente; sin él, el store no lo lee
  #view      = { zoom: 0, center: { x: 0, y: 0 }, size: { x: 0, y: 0 } }

  constructor({ host, pane, source, color, weight, opacity }) {
    const a = source.accessors
    this.#camera   = host.camera
    this.#source   = source
    this.#styleOf  = a.styleOf ?? null
    this.#pathOf   = a.pathOf
    this.#idOf     = a.idOf
    this.#scalarOf = a.scalarOf && a.colorRamp ? a.scalarOf : null
    this.#ramp     = a.colorRamp
    this.#base     = { ...DEFAULT_STYLE, ...(color && { color }), ...(weight != null && { weight }), ...(opacity != null && { opacity }) }
    this.#surface  = new EditSurface({ host, pane })
    this.#gl       = this.#surface.attach()
    // La superficie ya tomó uno de los ~16 contextos: lo que siga puede tirar y nadie devuelve uno solo.
    try {
      this.#stroke = new StrokePass({ gl: this.#gl, closed: false, gradient: !!this.#scalarOf })
      this.#rebuild(source.getSnapshot())
      this.#offView = host.camera.on('moveend zoomend resize', () => this.redraw())
      this.#unsub   = source.subscribe(() => { this.#sync(); this.redraw() })
    } catch (e) {
      this.destroy()
      throw e
    }
  }

  get count() { return this.#recs.size }

  redraw() {
    if (!this.#visible || this.#surface.contextLost) return false
    const gl = this.#gl
    this.#surface.resetCanvasReference()
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT)
    const view = readView(this.#camera, this.#view)
    let painted = false
    for (const rec of this.#recs.values()) {
      if (!rec.parts.length) continue
      this.#stroke.style(rec.style)
      painted = this.#stroke.draw(rec.parts, view) || painted
    }
    return painted
  }

  resetCanvasReference() { return this.redraw() }

  refresh() {
    this.#rebuild(this.#source.getSnapshot())
    return this.redraw()
  }

  setVisible(visible) {
    this.#visible = visible
    this.#surface.canvas.style.display = visible ? '' : 'none'
    return visible ? this.redraw() : false
  }

  // El foco es estado de la capa y se pliega en la opacidad de cada entidad: el restyle lo repone solo.
  // Es exacto —no hace falta atenuar el pane—, y por eso devuelve true.
  applyFocus(ids, dim = this.#focus.dim) {
    this.#focus = { ids, dim }
    for (const rec of this.#recs.values()) rec.style.opacity = rec.opacity * focusFactor(this.#focus, rec.id)
    this.redraw()
    return true
  }

  resolveClick(sample) { return this.#hitsAt(sample) }
  resolveHover(sample) { return this.#hitsAt(sample) }

  #hitsAt(sample) {
    if (!this.#recs.size) return []
    const index = this.#index ??= this.#indexAll()
    const scale = 2 ** this.#camera.zoom()          // world0 px · 2^zoom = screen px
    const tolPx = HIT_TOL_PX + this.#maxWeight / 2   // el trazo grueso capta desde su borde, no su eje
    return nearest(sample.lat, sample.lng, index, tolPx / scale).map(h => ({
      ref: h.id, id: h.id, distancePx: h.dist * scale,
      partIndex: h.partIndex, vertexIndex: h.vertexIndex,
    }))
  }

  // La entrada `k` de una rec es la de su slot `k`: los tramos de un vértice no entran al índice y sólo
  // puede serlo el último, así que el orden de `toParts` es el de los slots.
  #indexAll() {
    const items = []
    for (const rec of this.#recs.values()) items.push({ id: rec.id, parts: toParts(this.#pathOf(rec.item)) })
    const index = prepareIndex(items.filter(({ parts }) => parts.length))
    for (const entry of index.sorted) this.#recs.get(entry.id).entries[entry.partIndex] = entry
    return index
  }

  // Reacción al Source, ya coalescida a un frame por el emitter. Sin lookup O(1), sin traza de sucios o
  // con otra membresía, rebuild íntegro; con sucios, se reescriben sus slots; los puntos sumados a un id
  // que no está sucio se agregan al final de su tramo abierto, salvo los que un rebuild con la ventana
  // abierta ya leyó del path. Ese recorte es raro y es la única copia.
  #sync() {
    const snap  = this.#source.getSnapshot()
    const byId  = this.#source.itemById
    const dirty = this.#source.dirtyIds?.()
    if (snap.length !== this.#snapLen || !byId || !dirty) return this.#rebuild(snap)

    for (const id of dirty) {
      const rec  = this.#recs.get(id)
      const item = byId(id)
      if (!rec || item == null) return this.#rebuild(snap)
      this.#restyle(rec, item)
      this.#maxWeight = Math.max(this.#maxWeight, rec.style.width)
      this.#fold(rec, this.#pathOf(item))
      this.#layout(rec)
    }
    this.#source.appendedPoints?.().forEach((points, id) => {
      const rec  = this.#recs.get(id)
      if (!rec || dirty.has(id)) return
      const from = rec.absorbed === points ? rec.absorbedLength : 0
      from < points.length && this.#extend(rec, from ? points.slice(from) : points)
    })
  }

  // El estilo se resuelve antes de tocar el store, así un patrón inválido deja la capa como estaba.
  // `dash` y `cap` siempre explícitos: el trazo conserva lo que no se le dice, y la entidad siguiente
  // heredaría el patrón de la anterior.
  #restyle(rec, item) {
    const s     = { ...this.#base, ...(this.#styleOf?.(item) ?? null) }
    const style = {
      color   : this.#scalarOf ? OPAQUE : s.color,
      width   : s.weight,
      opacity : s.opacity * focusFactor(this.#focus, rec.id),
      dash    : ownDash(s.dash ?? null),
      cap     : s.cap ?? 'butt',
    }
    rec.item    = item
    rec.opacity = s.opacity
    rec.style   = style
  }

  // El path efectivo ya trae lo que `append` sumó en la ventana abierta: la rec anota cuánto de esa
  // ventana leyó (`absorbed` por identidad, porque cada ventana arma sus arrays) para que el flush no
  // lo sume otra vez.
  #rebuild(snap) {
    const recs     = new Map()
    const appended = this.#source.appendedPoints?.()
    let maxWeight = 0
    for (const item of snap) {
      const id       = this.#idOf(item)
      if (recs.has(id)) continue   // §15.2 duplicado → gana el primero
      const absorbed = appended?.get(id) ?? null
      const rec      = {
        id, item: null, opacity: 1, style: null, slots: [], parts: [], entries: [], length: 0, tail: -1, lone: null,
        absorbed, absorbedLength: absorbed?.length ?? 0,
      }
      this.#restyle(rec, item)
      maxWeight = Math.max(maxWeight, rec.style.width)
      recs.set(id, rec)
    }
    this.#store?.destroy()
    this.#store     = new LineStore({ gl: this.#gl, gradient: !!this.#scalarOf })
    this.#recs      = recs
    this.#snapLen   = snap.length
    this.#index     = null
    this.#maxWeight = maxWeight
    for (const rec of recs.values()) {
      this.#fold(rec, this.#pathOf(rec.item))
      this.#layout(rec)
    }
  }

  // Los tramos de `path` quedan en `#ctx.runs`. Sin `base` es el path entero de la entrada; con ella, lo
  // que se suma a partir de esa posición. `length` es el largo del path en la entrada: los puntos que
  // dibujan más los vértices que cortan, que igual ocupan índice.
  #fold(rec, path, base) {
    const ctx = this.#ctx
    ctx.runs.length = ctx.points = ctx.cuts = 0
    base === undefined ? foldRuns(path, collect, ctx, countCut, 1) : foldPart(path, base, collect, ctx, countCut, 1)
    rec.length = (base ?? 0) + ctx.points + ctx.cuts
  }

  // Escribe la rec entera: sus tramos ocupan los slots que ya tenía, en orden, y los que sobran se
  // sueltan. Un tramo de un vértice sólo cuenta si llega al final del path.
  #layout(rec) {
    const store    = this.#store
    const { runs } = this.#ctx
    rec.tail = -1
    rec.lone = null
    let k = 0
    for (let r = 0; r < runs.length; r += 4) {
      const count = runs[r + 2]
      const from  = runs[r + 3]
      const last  = from + count === rec.length
      if (count < 2) {
        if (last) rec.lone = this.#vertexOf(runs, r, from)
        continue
      }
      const n = this.#pack(rec, null, runs[r], runs[r + 1], count, from)
      if (k < rec.slots.length) store.rewrite(rec.slots[k], this.#xy, n, this.#rgba)
      else this.#attach(rec, store.add(this.#xy, n, this.#rgba))
      this.#track(rec, k, n, from, true)
      if (last) rec.tail = k
      k++
    }
    while (rec.slots.length > k) {
      store.remove(rec.slots.pop())
      rec.parts.pop()
    }
    if (this.#index && rec.entries.length > k) {
      const dead = rec.entries.splice(k)
      this.#index.sorted = this.#index.sorted.filter(e => !dead.includes(e))
    }
  }

  // Suma `points` al final del path de la rec, escribiendo sólo lo agregado. Sólo el primer tramo puede
  // continuar el abierto, y sólo si no hay un corte entre los dos.
  #extend(rec, points) {
    const store = this.#store
    const { tail, lone, length: base } = rec
    this.#fold(rec, points, base)
    const { runs } = this.#ctx
    rec.tail = -1
    rec.lone = null
    for (let r = 0; r < runs.length; r += 4) {
      const count = runs[r + 2]
      const from  = runs[r + 3]
      const last  = from + count === rec.length
      const joins = r === 0 && from === base && (tail >= 0 || lone)
      if (count < 2 && !joins) {
        if (last) rec.lone = this.#vertexOf(runs, r, from)
        continue
      }
      let k = tail
      if (joins && tail >= 0) {
        const n = this.#pack(rec, null, runs[r], runs[r + 1], count, from)
        store.append(rec.slots[k], this.#xy, n, this.#rgba)
        this.#track(rec, k, n, from, false)
      } else {
        const lead = joins ? lone : null
        const at   = lead ? lead[2] : from
        const n    = this.#pack(rec, lead, runs[r], runs[r + 1], count, at)
        k = rec.slots.length
        this.#attach(rec, store.add(this.#xy, n, this.#rgba))
        this.#track(rec, k, n, at, true)
      }
      if (last) rec.tail = k
    }
  }

  // El vértice suelto de un tramo, `[lat, lng, from]`: lo que hace falta para unirlo al que llegue.
  #vertexOf(runs, r, from) {
    const v = runs[r][runs[r + 1]]
    return [coordOf(v, 0), coordOf(v, 1), from]
  }

  #attach(rec, slot) {
    rec.slots.push(slot)
    rec.parts.push({ arena: this.#store.viewOf(slot) })
  }

  // Proyecta `count` vértices a `#xy` —y, con gradiente, su color a `#rgba`—, tras el `lead` si lo hay.
  // `base` es el índice en la entrada del primer vértice escrito, el que recibe `scalarOf`.
  #pack(rec, lead, vertices, first, count, base) {
    const o = lead ? 1 : 0
    const n = count + o
    if (this.#xy.length < n * 2) this.#xy = new Float64Array(n * 4)
    if (this.#scalarOf && this.#rgba.length < n * 4) this.#rgba = new Uint8Array(n * 8)
    const xy   = this.#xy
    const rgba = this.#rgba
    for (let i = 0; i < n; i++) {
      const v = i < o ? lead : vertices[first + i - o]
      xy[i * 2]     = projX0(coordOf(v, 1))
      xy[i * 2 + 1] = projY0(coordOf(v, 0))
      if (!this.#scalarOf) continue
      const c = toRGBA(this.#ramp(this.#scalarOf(rec.item, base + i)))
      rgba[i * 4]     = Math.round(c[0] * 255)
      rgba[i * 4 + 1] = Math.round(c[1] * 255)
      rgba[i * 4 + 2] = Math.round(c[2] * 255)
      rgba[i * 4 + 3] = Math.round(c[3] * 255)
    }
    return n
  }

  // Mantiene al día el índice de picking, si ya existe, con lo que `#pack` dejó en `#xy`: `whole`
  // escribe la entrada entera y, si no, estira la que hay con los `n` vértices nuevos. Un índice armado
  // con la ventana abierta ya leyó parte de ellos del path: se estira desde donde termina la entrada.
  #track(rec, k, n, from, whole) {
    const index = this.#index
    if (!index) return
    let e = rec.entries[k]
    if (!e) {
      e = rec.entries[k] = { id: rec.id, partIndex: k, from, pts: [], bbox: null }
      index.sorted.push(e)
    }
    if (whole) {
      e.from = from
      e.pts  = []
      e.bbox = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity }
    }
    for (let i = Math.max(0, e.from + e.pts.length - from); i < n; i++) {
      const x = this.#xy[i * 2]
      const y = this.#xy[i * 2 + 1]
      e.pts.push({ x, y })
      if (x < e.bbox.minX) e.bbox.minX = x
      if (x > e.bbox.maxX) e.bbox.maxX = x
      if (y < e.bbox.minY) e.bbox.minY = y
      if (y > e.bbox.maxY) e.bbox.maxY = y
    }
    index.stale = true
  }

  destroy() {
    this.#unsub?.()
    this.#offView?.()
    this.#stroke?.destroy()
    this.#store?.destroy()
    this.#surface.destroy()
    this.#recs.clear()
  }
}
