// La colocación de los rótulos de un miembro, cacheada: dónde cae cada grafema, con qué giro, y la caja
// que se pica. La comparten los renderers: `canvas` y `gl` leen los mismos glifos, y `html` las mismas
// cajas. Se recoloca cuando cambian la vista o el miembro (rebuild, puede asignar); leerla y picarla no
// asigna. Pura: sin DOM; la medida y la vista llegan de afuera.
//
// Todo queda en px del contenedor del marco de `place`. Mientras el pane viaja con un paneo, `hitsAt`
// descuenta el corrimiento del origen del marco.
import { anchorAt, midAlong, poleOf } from './labelAnchor.js'
import { PART, createRun, projectPath, projectRings } from './labelPath.js'
import { projX0, projY0 } from './project.js'
import { placeGlyphs } from './textPath.js'

const MAX_ANGLE = 45                      // grados entre glifos vecinos antes de omitir una colocación
const CULL      = 256                     // px fuera de la vista donde todavía se ancla un rótulo
const WORLD0    = Object.freeze({ cx: 0, cy: 0, scale: 1, hw: 0, hh: 0 })

/** La vista de `camera` en `out`: centro en world0 (`cx`, `cy`), `scale` = 2^zoom, tamaño (`w`, `h`) y
 *  medio tamaño (`hw`, `hh`) del contenedor, y el origen del marco (`ox`, `oy`). Devuelve `out`. */
export const readLabelView = (camera, out) => {
  const c = camera.center()
  const s = camera.size()
  const o = camera.frameOrigin()
  out.cx    = projX0(c.lng)
  out.cy    = projY0(c.lat)
  out.scale = 2 ** camera.zoom()
  out.w     = s.x
  out.h     = s.y
  out.hw    = s.x / 2
  out.hh    = s.y / 2
  out.ox    = o.x
  out.oy    = o.y
  return out
}

const grow = (arr, need) => {
  if (arr.length >= need) return arr
  const next = new arr.constructor(Math.max(arr.length * 2, need))
  next.set(arr)
  return next
}

/** Una colocación vacía. `place(member, view, measure)` la rehace; con `measure` null (html) deja una
 *  colocación por ítem y parte, sin glifos. Se lee por sus campos:
 *  - `placementCount`, `glyphCount`;
 *  - `glyphs` (x, y, ángulo, unidad) por glifo, contiguo por colocación;
 *  - `spans` (primer glifo, cantidad, índice de ítem) por colocación;
 *  - `boxes` (cx, cy, ángulo, medio ancho, medio alto) por colocación: la caja orientada del texto, o la
 *    caja alineada de sus glifos sobre el trazo;
 *  - `anchors` (x, y) por colocación: el punto del ítem corrido por `offset`, el que recibe `paint`;
 *  - `ids`, `items` y `texts` por índice de ítem: `texts` guarda el `Glyphs`, o el string sin medida. */
export const createLayout = () => {
  const run    = createRun()
  const world  = createRun()
  const placed = { buf: new Float64Array(192) }
  const opts   = { repeat: null, offset: 0, orientation: 'auto', maxAngle: MAX_ANGLE, viewW: 0, viewH: 0 }
  const icon   = { lat: 0, lng: 0, w: 0, h: 0, ax: NaN, ay: NaN }
  const anchor = { x: 0, y: 0, sx: 0, sy: 0 }
  const mid    = { x: 0, y: 0, ux: 1, uy: 0 }
  const poles  = new Map()                // id → polo en world0, o null; vale para una versión del miembro
  const pool   = []                       // partes de hit reusadas
  let aligns      = new Int8Array(32)      // hacia dónde crece cada caja desde su ancla (sx, sy)
  let member      = null
  let view        = null
  let measure     = null
  let font        = ''
  let glyphHit    = false
  let itemCount   = 0
  let poleOwner   = null
  let poleVersion = -1
  let ox          = 0
  let oy          = 0

  const layout = {
    placementCount : 0,
    glyphCount     : 0,
    glyphs         : new Float32Array(128),
    spans          : new Int32Array(96),
    boxes          : new Float32Array(160),
    anchors        : new Float32Array(64),
    ids            : [],
    items          : [],
    texts          : [],
  }

  // Abre la colocación siguiente del ítem `k`, con su ancla y hacia dónde crece su caja.
  const open = (k, x, y, sx, sy) => {
    const i = layout.placementCount++
    layout.spans   = grow(layout.spans, (i + 1) * 3)
    layout.boxes   = grow(layout.boxes, (i + 1) * 5)
    layout.anchors = grow(layout.anchors, (i + 1) * 2)
    aligns         = grow(aligns, (i + 1) * 2)
    layout.spans[3 * i]     = layout.glyphCount
    layout.spans[3 * i + 1] = 0
    layout.spans[3 * i + 2] = k
    layout.anchors[2 * i]     = x
    layout.anchors[2 * i + 1] = y
    aligns[2 * i]     = sx
    aligns[2 * i + 1] = sy
    return i
  }

  const box = (i, cx, cy, angle, hw, hh) => {
    const b = 5 * i
    layout.boxes[b]     = cx
    layout.boxes[b + 1] = cy
    layout.boxes[b + 2] = angle
    layout.boxes[b + 3] = hw
    layout.boxes[b + 4] = hh
  }

  const glyph = (x, y, angle, unit) => {
    const g = layout.glyphCount++
    layout.glyphs = grow(layout.glyphs, (g + 1) * 4)
    layout.glyphs[4 * g]     = x
    layout.glyphs[4 * g + 1] = y
    layout.glyphs[4 * g + 2] = angle
    layout.glyphs[4 * g + 3] = unit
  }

  // Un rótulo derecho apoyado en (x, y): la caja crece hacia (sx, sy) y los grafemas van en fila.
  const around = (k, text, x, y, sx, sy) => {
    if (measure && (x < -CULL || y < -CULL || x > view.w + CULL || y > view.h + CULL)) return
    const i = open(k, x, y, sx, sy)
    if (!measure) return box(i, x, y, 0, 0, 0)
    const hw = text.total / 2
    const hh = (text.ascent + text.descent) / 2
    const cx = x + sx * hw
    const cy = y + sy * hh
    box(i, cx, cy, 0, hw, hh)
    let acc = cx - hw
    for (let u = 0; u < text.widths.length; u++) {
      glyph(acc + text.widths[u] / 2, cy, 0, u)
      acc += text.widths[u]
    }
    layout.spans[3 * i + 1] = text.widths.length
  }

  // Los grafemas sobre la parte de `run` en `p`: una colocación por cada una que da `placeGlyphs`, con
  // la caja alineada de sus glifos como prefiltro del hit.
  const along = (k, text, p) => {
    const parts = run.parts
    const pad   = text.total
    if (parts[p + 4] < -pad || parts[p + 2] > view.w + pad || parts[p + 5] < -pad || parts[p + 3] > view.h + pad) return
    const g     = text.widths.length
    const count = placeGlyphs(run.xy, run.cum, parts[p], parts[p + 1], text.widths, opts, placed)
    const hh    = (text.ascent + text.descent) / 2
    const buf   = placed.buf
    for (let first = 0; first < count; first += g) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      const i = open(k, 0, 0, 0, 0)
      for (let u = 0; u < g; u++) {
        const o  = 3 * (first + u)
        const x  = buf[o], y = buf[o + 1], a = buf[o + 2]
        const c  = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a)), hw = text.widths[u] / 2
        const ex = c * hw + s * hh, ey = s * hw + c * hh
        minX = Math.min(minX, x - ex)
        minY = Math.min(minY, y - ey)
        maxX = Math.max(maxX, x + ex)
        maxY = Math.max(maxY, y + ey)
        glyph(x, y, a, u)
      }
      layout.spans[3 * i + 1] = g
      layout.anchors[2 * i]     = (minX + maxX) / 2
      layout.anchors[2 * i + 1] = (minY + maxY) / 2
      box(i, (minX + maxX) / 2, (minY + maxY) / 2, 0, (maxX - minX) / 2, (maxY - minY) / 2)
    }
  }

  // Sin medida (html): una colocación a mitad del largo, girada según la tangente y, con `auto`, derecha
  // para quien lee. `offset` la corre hacia la izquierda del sentido de lectura, como en `placeGlyphs`.
  const middle = (k, p) => {
    const { x, y } = midAlong(run.xy, run.cum, run.parts[p], run.parts[p + 1], mid)
    const back = opts.orientation === 'auto' && (mid.ux < 0 || mid.ux === 0 && mid.uy < 0)
    const ux   = back ? -mid.ux : mid.ux
    const uy   = back ? -mid.uy : mid.uy
    const ax   = x + opts.offset * uy
    const ay   = y - opts.offset * ux
    box(open(k, ax, ay, 0, 0), ax, ay, Math.atan2(uy, ux) + 0, 0, 0)
  }

  // El polo del ítem en world0, calculado una vez por versión del miembro.
  const poleFor = (item, id) => {
    if (poleOwner !== member || poleVersion !== member.version) {
      poles.clear()
      poleOwner   = member
      poleVersion = member.version
    }
    if (!poles.has(id)) poles.set(id, poleOf(projectRings(world, member.pathOf(item), WORLD0, member.curve)))
    return poles.get(id)
  }

  const visit = (_, item, id, text) => {
    const k     = itemCount++
    const kind  = member.kind
    const where = member.placement
    const shown = measure ? measure.glyphs(font, text) : text
    layout.ids[k]   = id
    layout.items[k] = item
    layout.texts[k] = shown

    if (where === 'along' || where === 'center' && kind === 'line') {
      kind === 'polygon' ? projectRings(run, member.pathOf(item), view, member.curve) : projectPath(run, member.pathOf(item), view, member.curve)
      for (let p = 0; p < run.count * PART; p += PART) {
        if (where === 'center') {
          midAlong(run.xy, run.cum, run.parts[p], run.parts[p + 1], mid)
          around(k, shown, mid.x, mid.y - opts.offset, 0, 0)
        } else measure ? along(k, shown, p) : middle(k, p)
      }
      return
    }
    if (kind === 'polygon') {
      const at = poleFor(item, id)
      at && around(k, shown, (at.x - view.cx) * view.scale + view.hw, (at.y - view.cy) * view.scale + view.hh - opts.offset, 0, 0)
      return
    }
    icon.w = icon.h = 0
    icon.ax = icon.ay = NaN
    if (!member.anchorOf(item, icon)) return
    const x = (projX0(icon.lng) - view.cx) * view.scale + view.hw
    const y = (projY0(icon.lat) - view.cy) * view.scale + view.hh
    anchorAt(where, x, y, icon, opts.offset, anchor)
    around(k, shown, anchor.x, anchor.y, anchor.sx, anchor.sy)
  }

  /** Rehace la colocación de `member` con la vista `view` (readLabelView) y la medida `measure`, o null. */
  layout.place = (target, frame, using) => {
    member    = target
    view      = frame
    measure   = using
    font      = target.opts.font
    glyphHit  = target.placement === 'along' && !!using
    itemCount = 0
    ox        = frame.ox
    oy        = frame.oy
    opts.repeat      = target.opts.repeat ?? null
    opts.offset      = target.opts.offset ?? 0
    opts.orientation = target.opts.orientation ?? 'auto'
    opts.viewW       = frame.w
    opts.viewH       = frame.h
    layout.placementCount = layout.glyphCount = 0
    target.forEach(visit, layout)
    layout.ids.length = layout.items.length = layout.texts.length = itemCount
    return layout
  }

  /** La caja de la colocación `i`, de `w` × `h` px: html la mide y el pintor la devuelve. Sin `x`, la
   *  caja crece desde el ancla hacia donde apunta la colocación; con `x`, `y`, es la caja alineada con
   *  esa esquina superior izquierda, la que devuelve un `paint`. Una caja vacía no se pica. */
  layout.size = (i, w, h, x, y) => {
    const hw = w / 2
    const hh = h / 2
    if (x !== undefined) return box(i, x + hw, y + hh, 0, hw, hh)
    box(i, layout.anchors[2 * i] + aligns[2 * i] * hw, layout.anchors[2 * i + 1] + aligns[2 * i + 1] * hh, layout.boxes[5 * i + 2], hw, hh)
  }

  // Si (x, y) cae en algún glifo de la colocación `i`: la caja de cada uno, girada con él.
  const onGlyph = (i, x, y) => {
    const first  = layout.spans[3 * i]
    const text   = layout.texts[layout.spans[3 * i + 2]]
    const hh     = (text.ascent + text.descent) / 2
    const glyphs = layout.glyphs
    for (let g = first; g < first + layout.spans[3 * i + 1]; g++) {
      const dx = x - glyphs[4 * g], dy = y - glyphs[4 * g + 1], a = glyphs[4 * g + 2]
      const c  = Math.cos(a), s = Math.sin(a)
      if (Math.abs(dx * c + dy * s) <= text.widths[glyphs[4 * g + 3]] / 2 && Math.abs(dy * c - dx * s) <= hh) return true
    }
    return false
  }

  /** Suma a `out` una parte `{ ref, id, distancePx: 0, zIndex: 0 }` por cada ítem con un rótulo bajo
   *  `sample` ({ x, y } en px del contenedor), con `origin` el `frameOrigin()` de ahora. Las partes son
   *  de la colocación y valen hasta el `hitsAt` siguiente. Devuelve `out`. [0-alloc] */
  layout.hitsAt = (sample, origin, out) => {
    const x     = sample.x + origin.x - ox
    const y     = sample.y + origin.y - oy
    const boxes = layout.boxes
    let used = 0
    let last = -1
    for (let i = 0; i < layout.placementCount; i++) {
      const b    = 5 * i
      const hw   = boxes[b + 3], hh = boxes[b + 4]
      const item = layout.spans[3 * i + 2]
      if (!(hw > 0 && hh > 0) || item === last) continue
      const dx = x - boxes[b], dy = y - boxes[b + 1]
      if (glyphHit) {
        if (Math.abs(dx) > hw || Math.abs(dy) > hh || !onGlyph(i, x, y)) continue
      } else {
        const c = Math.cos(boxes[b + 2]), s = Math.sin(boxes[b + 2])
        if (Math.abs(dx * c + dy * s) > hw || Math.abs(dy * c - dx * s) > hh) continue
      }
      const part = pool[used] ?? (pool[used] = { ref: null, id: null, distancePx: 0, zIndex: 0 })
      used++
      part.ref = part.id = layout.ids[item]
      out.push(part)
      last = item
    }
    return out
  }

  return layout
}
