import { EditSurface } from './EditSurface.js'
import { LineStore } from './LineStore.js'
import { StrokePass, ownDash } from './StrokePass.js'
import { projX0, projY0, readView } from './project.js'
import { toRGBA } from './color.js'
import { focusFactor } from './focus.js'
import { coordOf } from '../data/path.js'
import { foldPart, foldRuns, nearest } from '../geometry/polyline.js'
import { at, count as stepsOf } from '../geometry/curve.js'
import { growBoxOfRange } from '../geometry/bbox.js'

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
// `append`; si es de un solo vértice no dibuja nada, y su vértice (`last`, el último del path) espera al
// siguiente para unirse.
//
// Con curva, cada tramo se parte sobre la geodésica de su modelo en `#pack`, y de esa única densificación
// salen el dibujo, el índice de picking y la caja: lo que se pica es lo que se ve.

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
  #curve     = null                   // el modelo sobre cuya geodésica se curvan los tramos; null, rectas
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
  #src       = new Uint32Array(32)    // por punto de `#xy`, la posición en la entrada del vértice que abre su tramo
  #rgba      = null                   // 4 bytes por punto con gradiente; sin él, vacío y el store no lo lee
  #at        = [0, 0]
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
    this.#rgba     = new Uint8Array(this.#scalarOf ? 128 : 0)
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

  // Curva los tramos sobre la geodésica de `model`, o los vuelve rectos con `null`: la capa se rearma.
  setCurve(model) {
    this.#curve = model
    return this.refresh()
  }

  // Caja en grados de lo que la capa dibuja cuando curva. Sin curva es `null`: lo dibujado es el path de la
  // Source, y quien encuadra lo lee de ahí. Los extremos se llevan de world0 a grados, así que una curva que
  // pasa de la latitud de Mercator queda topada en ella, como se dibuja.
  get bounds() {
    if (!this.#curve) return null
    const box = [Infinity, Infinity, -Infinity, -Infinity]
    this.#repack((_rec, _k, n) => growBoxOfRange(this.#xy, 0, n, box))
    const latOf = y => Math.atan(Math.sinh(Math.PI * (1 - y / 128))) * 180 / Math.PI
    const lngOf = x => x / 256 * 360 - 180
    return box[0] <= box[2] ? { south: latOf(box[3]), west: lngOf(box[0]), north: latOf(box[1]), east: lngOf(box[2]) } : null
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
    if (!this.#index) {
      this.#index = { stale: false, sorted: [] }
      this.#repack((rec, k, n) => this.#track(rec, k, n, true))
    }
    const scale = 2 ** this.#camera.zoom()          // world0 px · 2^zoom = screen px
    const tolPx = HIT_TOL_PX + this.#maxWeight / 2   // el trazo grueso capta desde su borde, no su eje
    return nearest(sample.lat, sample.lng, this.#index, tolPx / scale).map(h => ({
      ref: h.id, id: h.id, distancePx: h.dist * scale,
      partIndex: h.partIndex, vertexIndex: h.vertexIndex,
    }))
  }

  // Vuelve a empacar, sin color, cada tramo que la capa dibuja y le pasa a `fn(rec, k, n)` el slot `k` y
  // los `n` puntos que dejó en `#xy`. Lee el path hasta `rec.length`: lo que la ventana abierta le sumó
  // todavía no está dibujado, y entra con el `append` que la cierra. Los tramos de un vértice no ocupan
  // slot y sólo puede serlo el último, así que el orden de los tramos es el de los slots.
  #repack(fn) {
    for (const rec of this.#recs.values()) {
      this.#fold(this.#pathOf(rec.item))
      const { runs } = this.#ctx
      for (let r = 0, k = 0; r < runs.length; r += 4) {
        const from  = runs[r + 3]
        const count = Math.min(runs[r + 2], rec.length - from)
        count > 1 && fn(rec, k++, this.#pack(null, null, false, runs[r], runs[r + 1], count, from))
      }
    }
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
      rec.length = this.#fold(this.#pathOf(item))
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
        id, item: null, opacity: 1, style: null, slots: [], parts: [], entries: [], length: 0, tail: -1, last: null,
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
      rec.length = this.#fold(this.#pathOf(rec.item))
      this.#layout(rec)
    }
  }

  // Los tramos de `path` quedan en `#ctx.runs`. Sin `base` es el path entero de la entrada; con ella, lo
  // que se suma a partir de esa posición. Devuelve el largo del path en la entrada: los puntos que
  // dibujan más los vértices que cortan, que igual ocupan índice.
  #fold(path, base) {
    const ctx = this.#ctx
    ctx.runs.length = ctx.points = ctx.cuts = 0
    base === undefined ? foldRuns(path, collect, ctx, countCut, 1) : foldPart(path, base, collect, ctx, countCut, 1)
    return (base ?? 0) + ctx.points + ctx.cuts
  }

  // Escribe la rec entera: sus tramos ocupan los slots que ya tenía, en orden, y los que sobran se
  // sueltan. Un tramo de un vértice sólo cuenta si llega al final del path.
  #layout(rec) {
    const store    = this.#store
    const { runs } = this.#ctx
    rec.tail = -1
    rec.last = null
    let k = 0
    for (let r = 0; r < runs.length; r += 4) {
      const count = runs[r + 2]
      const from  = runs[r + 3]
      const end   = from + count === rec.length
      if (end) rec.last = this.#lastOf(runs, r)
      if (count < 2) continue
      const n = this.#pack(rec, null, false, runs[r], runs[r + 1], count, from)
      if (k < rec.slots.length) store.rewrite(rec.slots[k], this.#xy, n, this.#rgba)
      else this.#attach(rec, store.add(this.#xy, n, this.#rgba))
      this.#track(rec, k, n, true)
      if (end) rec.tail = k
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
  // continuar el abierto, y sólo si no hay un corte entre los dos: entonces el último vértice del path es
  // su `lead`, que con curva abre la geodésica hasta el primero agregado.
  #extend(rec, points) {
    const store = this.#store
    const { tail, last, length: base } = rec
    rec.length = this.#fold(points, base)
    const { runs } = this.#ctx
    rec.tail = -1
    rec.last = null
    for (let r = 0; r < runs.length; r += 4) {
      const count   = runs[r + 2]
      const from    = runs[r + 3]
      const end     = from + count === rec.length
      const joins   = r === 0 && from === base && (tail >= 0 || !!last)
      const appends = joins && tail >= 0
      if (end) rec.last = this.#lastOf(runs, r)
      if (count < 2 && !joins) continue
      const k = appends ? tail : rec.slots.length
      const n = this.#pack(rec, joins ? last : null, appends, runs[r], runs[r + 1], count, from)
      if (appends) store.append(rec.slots[k], this.#xy, n, this.#rgba)
      else this.#attach(rec, store.add(this.#xy, n, this.#rgba))
      this.#track(rec, k, n, !appends)
      if (end) rec.tail = k
    }
  }

  // El último vértice de un tramo, `[lat, lng]`: lo que hace falta para unirlo al que llegue. Sin curva sólo
  // lo pide el tramo suelto, porque el abierto se estira sin mirarlo, y el `append` recto no paga el par.
  #lastOf(runs, r) {
    if (!this.#curve && runs[r + 2] > 1) return null
    const v = runs[r][runs[r + 1] + runs[r + 2] - 1]
    return [coordOf(v, 0), coordOf(v, 1)]
  }

  #attach(rec, slot) {
    rec.slots.push(slot)
    rec.parts.push({ arena: this.#store.viewOf(slot) })
  }

  // Proyecta a `#xy` los `count` vértices desde `first`, con `from` la posición del primero en la entrada,
  // y con curva, entre cada par, los puntos de su geodésica; `#src` anota de cada punto el vértice que abre
  // su tramo. `lead` es el vértice `[lat, lng]` que precede al primero, en `from − 1`: se escribe salvo
  // `joined`, cuando ya está en el slot al que se suma, y aun así la curva sale de él. Con gradiente y
  // `rec`, el color va a `#rgba`, y los puntos insertados interpolan el escalar, no el color. Devuelve
  // cuántos puntos escribió.
  #pack(rec, lead, joined, vertices, first, count, from) {
    const curve = this.#curve
    const paint = !!rec && !!this.#scalarOf
    let n = 0, lat0 = 0, lng0 = 0, s0 = 0
    if (lead && (curve || !joined)) {
      lat0 = lead[0]
      lng0 = lead[1]
      s0   = paint ? this.#scalarOf(rec.item, from - 1) : 0
      if (!joined) n = this.#put(paint, n, lat0, lng0, s0, from - 1)
    }
    for (let i = 0; i < count; i++) {
      const v   = vertices[first + i]
      const lat = coordOf(v, 0), lng = coordOf(v, 1)
      const s   = paint ? this.#scalarOf(rec.item, from + i) : 0
      const m   = curve && (i || lead) ? stepsOf(curve, lat0, lng0, lat, lng) : 1
      for (let k = 1; k < m; k++) {
        at(curve, lat0, lng0, lat, lng, k / m, this.#at)
        n = this.#put(paint, n, this.#at[0], this.#at[1], s0 + (s - s0) * k / m, from + i - 1)
      }
      n = this.#put(paint, n, lat, lng, s, from + i)
      lat0 = lat
      lng0 = lng
      s0   = s
    }
    return n
  }

  // Escribe el punto `n` y devuelve `n + 1`. Los buffers crecen al doble y conservan lo escrito: con curva
  // no se sabe de antemano cuántos puntos salen. `#rgba` sólo tiene largo con gradiente.
  #put(paint, n, lat, lng, scalar, src) {
    if (n === this.#src.length) {
      const xy = new Float64Array(n * 4), opens = new Uint32Array(n * 2), rgba = new Uint8Array(this.#rgba.length * 2)
      xy.set(this.#xy)
      opens.set(this.#src)
      rgba.set(this.#rgba)
      this.#xy   = xy
      this.#src  = opens
      this.#rgba = rgba
    }
    this.#xy[n * 2]     = projX0(lng)
    this.#xy[n * 2 + 1] = projY0(lat)
    this.#src[n]        = src
    if (!paint) return n + 1
    const c = toRGBA(this.#ramp(scalar))
    this.#rgba[n * 4]     = Math.round(c[0] * 255)
    this.#rgba[n * 4 + 1] = Math.round(c[1] * 255)
    this.#rgba[n * 4 + 2] = Math.round(c[2] * 255)
    this.#rgba[n * 4 + 3] = Math.round(c[3] * 255)
    return n + 1
  }

  // Mantiene al día el índice de picking, si ya existe, con lo que `#pack` dejó en `#xy` y `#src`: `whole`
  // escribe la entrada entera y, si no, estira la que hay con los `n` puntos nuevos.
  #track(rec, k, n, whole) {
    const index = this.#index
    if (!index) return
    let e = rec.entries[k]
    if (!e) {
      e = rec.entries[k] = { id: rec.id, partIndex: k, src: null, pts: null, bbox: null }
      index.sorted.push(e)
    }
    if (whole) {
      e.src  = []
      e.pts  = []
      e.bbox = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity }
    }
    for (let i = 0; i < n; i++) {
      const x = this.#xy[i * 2]
      const y = this.#xy[i * 2 + 1]
      e.src.push(this.#src[i])
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
