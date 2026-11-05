import { DEFAULT_STYLE as PILL_STYLE } from './LabelLayer.js'
import { createLayout, readLabelView } from './labelLayout.js'
import { createMeasure } from './labelText.js'
import { frameTransform } from './frame.js'
import { safe } from '../data/safe.js'

// LabelCanvas — los rótulos `canvas` de varios miembros en un solo canvas 2D, montado en su pane
// (DISENO-ROTULOS §3.2 y §3.5). La colocación es de `labelLayout` y se guarda por miembro: se rehace sólo
// si cambiaron sus datos o la vista. Un repintado, que junta todos los avisos de un cuadro, pinta lo
// guardado. Cada miembro va en dos pasadas, primero los halos y después los rellenos, y el rótulo del ítem
// bajo el puntero va al final, encima de todos. Se oculta en el zoom animado y repinta al asentar.

const HALO = 3                            // ancho del halo en px, fijo (§1.2)
const RAD  = 180 / Math.PI

const onPaintError = e => console.error('[cristae] paint de <cristae-labeled>', e)

// El pintor del consumidor con la firma de `LabelPaint`. Recibe un portador, así la llamada aislada con
// `safe` no arma una clausura por rótulo.
const runPaint = call => call.paint(call.ctx, call.point, call.label, call.hovered, PILL_STYLE)

// De px de marco a lat/lng con la vista con que se colocó: Mercator inversa, sin pedirle a la cámara un
// objeto por rótulo.
const lngAt = (st, x) => ((x - st.hw) / st.scale + st.cx) / 256 * 360 - 180
const latAt = (st, y) => Math.atan(Math.sinh((0.5 - ((y - st.hh) / st.scale + st.cy) / 256) * 2 * Math.PI)) * RAD

/** Un renderer `canvas` en el pane `pane`, a `zIndex`. `host` es el del motor: su cámara y su superficie. */
export const createLabelCanvas = ({ host, pane, zIndex }) => {
  const { camera, surface } = host
  const canvas              = document.createElement('canvas')
  canvas.className           = 'cristae-labels-canvas'
  canvas.style.pointerEvents = 'none'
  const ctx                  = canvas.getContext('2d', { alpha: true })
  surface.mount(pane, zIndex, { pointer: false }).appendChild(canvas)

  const measure = createMeasure(ctx)
  const view    = { cx: 0, cy: 0, scale: 1, hw: 0, hh: 0, w: 0, h: 0, ox: 0, oy: 0 }
  const members = []                      // en orden de attach, que es el de pintado
  const states  = new Map()               // miembro → su colocación y lo que hace falta para leerla
  const fonts   = new Set()               // las que ya se pidieron a `document.fonts`
  const point   = { x: 0, y: 0 }
  const label   = { id: null, lat: 0, lng: 0, text: '' }
  const call    = { paint: null, ctx, point, label, hovered: false }
  let frame     = 0
  let zooming   = false
  let alive     = true
  let width     = 0, height = 0, ratio = 0
  let originX   = NaN, originY = NaN

  // Una fuente que termina de cargar cambia los anchos medidos con la de reemplazo: se olvidan y se
  // recolocan los miembros que la usan.
  const watchFont = font => {
    if (fonts.has(font)) return
    fonts.add(font)
    document.fonts?.load(font).then(() => {
      if (!alive) return
      measure.forget(font)
      states.forEach((st, member) => member.opts.font === font && (st.version = -1))
      schedule()
    }, () => {})
  }

  // La vista con que se colocó queda en el estado: es la que lee la colocación y la que ubica su marco.
  const place = (member, st) => {
    if (st.version === member.version) return
    st.layout.place(member, view, measure)
    st.version = member.version
    st.ox      = view.ox
    st.oy      = view.oy
    st.cx      = view.cx
    st.cy      = view.cy
    st.scale   = view.scale
    st.hw      = view.hw
    st.hh      = view.hh
    st.w       = view.w
    st.h       = view.h
  }

  // Una pasada de texto sobre las colocaciones de un miembro: los halos (`fill` falso) o los rellenos.
  // Sobre el trazo, grafema a grafema; en el resto, el texto entero en el centro de su caja.
  const textPass = (member, st, hovered, fill, dx, dy) => {
    const { glyphs, spans, boxes, ids, texts, placementCount } = st.layout
    const along = member.placement === 'along'
    for (let i = 0; i < placementCount; i++) {
      const item = spans[3 * i + 2]
      const id   = ids[item]
      if (member.isHovered(id) !== hovered) continue
      ctx.globalAlpha = member.alphaOf(id)
      if (!along) {
        const a   = boxes[5 * i + 2]
        const cos = Math.cos(a), sin = Math.sin(a)
        ctx.setTransform(ratio * cos, ratio * sin, -ratio * sin, ratio * cos, ratio * (boxes[5 * i] + dx), ratio * (boxes[5 * i + 1] + dy))
        fill ? ctx.fillText(texts[item].text, 0, 0) : ctx.strokeText(texts[item].text, 0, 0)
        continue
      }
      const units = texts[item].units
      const end   = spans[3 * i] + spans[3 * i + 1]
      for (let g = spans[3 * i]; g < end; g++) {
        const cos = Math.cos(glyphs[4 * g + 2]), sin = Math.sin(glyphs[4 * g + 2])
        ctx.setTransform(ratio * cos, ratio * sin, -ratio * sin, ratio * cos, ratio * (glyphs[4 * g] + dx), ratio * (glyphs[4 * g + 1] + dy))
        fill ? ctx.fillText(units[glyphs[4 * g + 3]], 0, 0) : ctx.strokeText(units[glyphs[4 * g + 3]], 0, 0)
      }
    }
  }

  // Con `paint`, cada rótulo lo pinta el consumidor entre `save` y `restore`, así lo que deje en el
  // contexto no pasa al siguiente. Recibe el ancla del ítem y devuelve su caja en px del contenedor de
  // este pintado, que vuelve al marco de la colocación para picarse; sin caja, el rótulo no se pica.
  const paintPass = (member, st, hovered, dx, dy) => {
    const layout = st.layout
    const { spans, anchors, ids, texts, placementCount } = layout
    call.paint   = member.opts.paint
    call.hovered = hovered
    for (let i = 0; i < placementCount; i++) {
      const item = spans[3 * i + 2]
      const id   = ids[item]
      if (member.isHovered(id) !== hovered) continue
      point.x    = anchors[2 * i] + dx
      point.y    = anchors[2 * i + 1] + dy
      label.id   = id
      label.text = texts[item].text
      label.lat  = latAt(st, anchors[2 * i + 1])
      label.lng  = lngAt(st, anchors[2 * i])
      ctx.save()
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
      ctx.globalAlpha = member.alphaOf(id)
      const box = safe(runPaint, call, onPaintError)
      ctx.restore()
      box ? layout.size(i, box.w, box.h, box.x - dx, box.y - dy) : layout.size(i, 0, 0, 0, 0)
    }
  }

  // El estado del contexto se fija al entrar a cada miembro: no hereda nada del anterior.
  const drawMember = (member, hovered) => {
    if (!member.visible) return
    const st = states.get(member)
    hovered || place(member, st)
    if (!st.layout.placementCount) return

    const opts = member.opts
    const dx   = st.ox - view.ox
    const dy   = st.oy - view.oy
    if (opts.paint) return paintPass(member, st, hovered, dx, dy)

    ctx.font         = opts.font
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.lineJoin     = 'round'
    ctx.lineWidth    = HALO
    ctx.strokeStyle  = opts.halo
    ctx.fillStyle    = opts.color
    opts.halo === 'none' || textPass(member, st, hovered, false, dx, dy)
    textPass(member, st, hovered, true, dx, dy)
  }

  // Sin vista no hay píxel que leer: un mapa adoptado que todavía no la tomó pinta en el `moveend` que la
  // trae. Asignar el ancho del canvas lo limpia; si no cambia, se limpia a mano.
  const paint = () => {
    frame = 0
    if (!alive || !camera.hasView()) return
    readLabelView(camera, view)
    const r = window.devicePixelRatio || 1
    if (view.ox !== originX || view.oy !== originY) {
      originX                = view.ox
      originY                = view.oy
      canvas.style.transform = frameTransform(originX, originY)
    }
    if (view.w !== width || view.h !== height || r !== ratio) {
      width               = view.w
      height              = view.h
      ratio               = r
      canvas.style.width  = `${width}px`
      canvas.style.height = `${height}px`
      canvas.width        = Math.round(width * ratio)
      canvas.height       = Math.round(height * ratio)
    }
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    ctx.globalAlpha = 1
    ctx.clearRect(0, 0, width, height)
    for (let m = 0; m < members.length; m++) drawMember(members[m], false)
    for (let m = 0; m < members.length; m++) drawMember(members[m], true)
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    ctx.globalAlpha = 1
  }

  const schedule = () => alive && !frame && (frame = requestAnimationFrame(paint))

  // Al asentar, se recoloca lo que se colocó con otra vista: `zoomend` y `moveend` llegan juntos y
  // recolocan una vez. Entre asientos, un repintado no recoloca lo ajeno aunque la vista viaje: lo corre
  // con el marco. Pinta en el acto, así el canvas no reaparece con lo de antes del zoom.
  const outdate = st => {
    const same = st.cx === view.cx && st.cy === view.cy && st.scale === view.scale && st.w === view.w && st.h === view.h
    same || (st.version = -1)
  }
  const settle = () => {
    if (!alive || !camera.hasView()) return
    readLabelView(camera, view)
    states.forEach(outdate)
    frame && cancelAnimationFrame(frame)
    paint()
  }

  const offView = [
    camera.on('zoomstart', () => {
      zooming                  = true
      canvas.style.visibility  = 'hidden'
    }),
    camera.on('moveend zoomend resize', settle),
    camera.on('zoomend', () => {
      zooming                  = false
      canvas.style.visibility  = ''
    }),
  ]

  return {
    zIndex,

    attach(member) {
      if (!alive || states.has(member)) return
      members.push(member)
      states.set(member, { layout: createLayout(), version: -1, ox: 0, oy: 0, cx: 0, cy: 0, scale: 1, hw: 0, hh: 0, w: 0, h: 0 })
      watchFont(member.opts.font)
      schedule()
    },

    // Lo oculto no repinta por sus datos: al volver a verse se recoloca si hizo falta.
    invalidate(member, reason) {
      if (!states.has(member)) return
      reason === 'style' && watchFont(member.opts.font)
      ;(reason === 'visibility' || member.visible) && schedule()
    },

    detach(member) {
      if (!states.delete(member)) return
      members.splice(members.indexOf(member), 1)
      schedule()
    },

    // Suma a `out` las partes de los rótulos de `member` bajo `sample`. Las cajas están en px del marco de
    // la colocación: la colocación descuenta lo que se movió el marco desde entonces. [0-alloc]
    hitsAt(member, sample, out) {
      const st = alive && !zooming && member.visible ? states.get(member) : null
      if (!st) return out
      const from = out.length
      st.layout.hitsAt(sample, camera.frameOrigin(), out)
      for (let k = from; k < out.length; k++) out[k].zIndex = zIndex
      return out
    },

    destroy() {
      if (!alive) return
      alive = false
      frame && cancelAnimationFrame(frame)
      offView.forEach(off => off())
      canvas.remove()
      surface.unmount(pane)
      members.length = 0
      states.clear()
    },
  }
}
