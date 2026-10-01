// Capa de MARCADORES HTML en un nodo DOM propio, colgado de un pane de la superficie — NO es GL, NO abre
// otro contexto WebGL. Su nicho: pocos/medianos marcadores con contenido HTML ARBITRARIO (un heroicon, un
// glifo de fuente, una letra) + popup/tooltip, que el iconset canvas del point-layer no rinde. Es el
// COMPLEMENTO del point-layer GPU (alta cardinalidad / tiempo real), no su competidor.
//
// Cada marcador es un nodo posicionado por proyección en el marco que sigue al paneo: su transform es la
// posición del contenedor más el origen del marco, así que un paneo no lo toca y sólo se reescribe cuando
// la vista asienta (`moveend zoomend resize`). Un zoom animado lo lleva al destino con la transición que
// la superficie les da a los nodos que lo siguen; uno sin vista destino —pinch, `flyTo`, un salto— lo
// reubica en cada `move` hasta asentar.
//
// accessors: { idOf, positionOf, htmlOf(item)->string, classNameOf?(item)->string, sizeOf?(item)->[w,h],
//              anchorOf?(item)->[x,y] }. Estado (position/html) → mutar item + set/patch la Source.

import { focusFactor } from './focus.js'
import { frameTransform } from './frame.js'

const HIT_TOL_PX = 16
// Sin `sizeOf` ni `anchorOf` el nodo no conoce su caja: el CSS la decide y el centrado se pide al transform.
const CENTERED   = ' translate(-50%, -50%)'

// Escribe sólo si cambia: un tick de datos que no movió nada no toca el estilo de nadie.
const write = (target, key, value) => target[key] === value || (target[key] = value)

export class HtmlLayer {

  #camera; #surface; #pane; #source; #interactive
  #accessors
  #root
  #byId    = new Map()   // id → { el, icon, lat, lng, html, centered, transform } (el hit y el reposicionado)
  #hitTol  = HIT_TOL_PX  // tolerancia de hit vigente (deriva del sizeOf mayor)
  #toward  = null        // la vista destino mientras un zoom anima, o null
  #zooming = false       // hay un zoom en curso: cada `move` deja la vista que hay que seguir
  #offs    = null
  #unsub   = null
  #focus   = { ids: null, dim: 0.3 }   // eje focus: ids enfocados (null = sin foco) + opacidad del resto

  constructor({ host, pane, source, interactive = false }) {
    const root = document.createElement('div')
    root.className      = 'cristae-html-layer'
    root.style.position = 'absolute'
    root.style.left     = '0'
    root.style.top      = '0'

    this.#camera      = host.camera
    this.#surface     = host.surface
    this.#pane        = pane
    this.#source      = source
    this.#accessors   = source.accessors
    this.#interactive = interactive
    this.#root        = root
    this.#surface.mount(pane).appendChild(root)
    // Un zoom animado avisa su destino con `zoomanim` y la transición hace el resto. Uno sin destino
    // —pinch, `flyTo`, un salto— mueve la vista cuadro a cuadro, y cada `move` la deja donde hay que
    // leerla. Fuera de un zoom, un `move` es un paneo, que el marco ya se lleva: escucharlo ahí sería
    // proyectar todo para no escribir nada.
    this.#offs = [
      this.#camera.on('zoomstart', () => (this.#zooming = true)),
      this.#camera.on('zoomanim', toward => {
        this.#toward = toward
        this.#layout()
      }),
      this.#camera.on('move', () => this.#zooming && this.#layout()),
      this.#camera.on('moveend zoomend resize', () => {
        this.#zooming = false
        this.#toward  = null
        this.#layout()
      }),
    ]
    this.#unsub = source.subscribe(() => this.#reconcile())
    this.#reconcile()
  }

  destroy() {
    if (!this.#root) return
    this.#unsub()
    this.#offs.forEach(off => off())
    this.#root.remove()
    this.#surface.unmount(this.#pane)
    this.#byId.clear()
    this.#root = null
  }

  // Eje focus: atenúa por MARCADOR (opacidad de su nodo). La reconciliación aplica el mismo factor, así que el
  // foco sobrevive a cualquier tick de datos sin re-aplicarlo a mano.
  applyFocus(ids, dim = this.#focus.dim) {
    this.#focus = { ids, dim }
    this.#byId.forEach((entry, id) => write(entry.el.style, 'opacity', String(focusFactor(this.#focus, id))))
    return true
  }

  /* ── Picking: marcadores dentro de tolerancia (kind 'html'); el registro los ordena por distancePx ── */
  resolveClick(sample) { return this.#hitsAt(sample) }
  resolveHover(sample) { return this.#hitsAt(sample) }

  #hitsAt(sample) {
    if (!this.#interactive || !this.#byId.size || !this.#camera.hasView()) return []
    const tol = this.#hitTol                      // deriva del sizeOf mayor: un badge grande pica en toda su caja
    const out = []
    this.#byId.forEach((entry, id) => {
      const mp = this.#camera.toContainer(entry)
      const d  = Math.hypot(mp.x - sample.x, mp.y - sample.y)
      if (d <= tol) out.push({ ref: id, id, distancePx: d })
    })
    return out
  }

  /* ── Posición: por proyección, sólo donde la vista cambió ── */

  // La posición en el marco de cada marcador, redondeada al píxel para que el contenido no se vea borroso.
  // Con un zoom animado es la de la vista destino: el centro destino queda en el medio del contenedor. El
  // transform no cambia con un paneo, y se reescribe sólo el que cambió. Las de más abajo en pantalla
  // tapan a las de más arriba.
  #layout() {
    const camera = this.#camera
    if (!camera.hasView()) return
    const origin = camera.frameOrigin()
    const toward = this.#toward
    const size   = camera.size()
    const mid    = toward && camera.project(toward.center, toward.zoom)
    this.#byId.forEach(entry => {
      const at        = toward ? camera.project(entry, toward.zoom) : camera.toContainer(entry)
      const x         = Math.round(toward ? at.x - mid.x + size.x / 2 + origin.x : at.x + origin.x)
      const y         = Math.round(toward ? at.y - mid.y + size.y / 2 + origin.y : at.y + origin.y)
      const transform = frameTransform(x, y) + (entry.centered ? CENTERED : '')
      if (transform === entry.transform) return
      entry.transform          = transform
      entry.el.style.transform = transform
      entry.el.style.zIndex    = String(y)
    })
  }

  /* ── Reconciliación ante cambio del Source ── */

  // Reconcilia por id: el nodo de un marcador que sigue se reusa y sólo se escribe lo que cambió, así un
  // tick de posiciones no recrea el HTML de nadie. Los que ya no están salen del documento.
  #reconcile() {
    const a    = this.#accessors
    const snap = this.#source.getSnapshot()
    const next = new Map()
    let tol    = HIT_TOL_PX
    for (let i = 0; i < snap.length; i++) {
      const item = snap[i]
      const pos  = a.positionOf(item)
      if (!pos || !Number.isFinite(pos.lat) || !Number.isFinite(pos.lng)) continue
      const id     = a.idOf(item)
      const size   = a.sizeOf?.(item)                                    // [w,h] px, o tamaño por CSS
      const anchor = a.anchorOf?.(item) ?? (size && [size[0] / 2, size[1] / 2])
      const html   = a.htmlOf(item)
      let entry    = next.get(id) ?? this.#byId.get(id)
      if (!entry) {
        const el   = document.createElement('div')
        const icon = document.createElement('div')
        el.style.position   = 'absolute'
        el.style.left       = '0'
        el.style.top        = '0'
        el.style.width      = 'max-content'
        el.style.userSelect = 'none'
        this.#surface.followZoom(el)
        el.appendChild(icon)
        this.#root.appendChild(el)
        entry = { el, icon, lat: 0, lng: 0, html: null, centered: false, transform: null }
      }
      next.set(id, entry)
      if (size) tol = Math.max(tol, size[0] / 2, size[1] / 2)
      // `positionOf` puede devolver un objeto scratch reusado: se copia ya.
      entry.lat      = pos.lat
      entry.lng      = pos.lng
      entry.centered = !anchor
      write(entry.el.style, 'marginLeft', anchor ? `${-anchor[0]}px` : '')
      write(entry.el.style, 'marginTop', anchor ? `${-anchor[1]}px` : '')
      write(entry.el.style, 'opacity', String(focusFactor(this.#focus, id)))
      write(entry.icon, 'className', a.classNameOf ? a.classNameOf(item) : 'cristae-html-marker')
      write(entry.icon.style, 'width', size ? `${size[0]}px` : '')
      write(entry.icon.style, 'height', size ? `${size[1]}px` : '')
      if (entry.html !== html) entry.icon.innerHTML = entry.html = html
    }
    this.#byId.forEach((entry, id) => next.has(id) || entry.el.remove())
    this.#byId   = next
    this.#hitTol = tol
    this.#layout()
  }
}
