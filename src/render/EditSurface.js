import { loseGlContext } from './gl-teardown.js'

// Superficie WebGL2 PROPIA de la geometría editable: un canvas en su pane con un contexto que no se
// comparte con glify. El stencil se decide en `getContext` y no se habilita después —volver a llamarlo
// sobre el mismo canvas devuelve el MISMO contexto e ignora los atributos nuevos, y el canvas es de
// glify—, así que el relleno par-impar obliga a un contexto aparte. Uno por instancia de mapa,
// PEREZOSO y jamás recreado: el techo de contextos vivos del navegador (~16) se agota de forma
// ACUMULATIVA y nadie devuelve uno salvo `loseContext`.

const ATTRS = {
  stencil               : true,     // el pase de paridad del abanico escribe acá; sin esto no hay relleno
  depth                 : false,
  alpha                 : true,
  premultipliedAlpha    : false,
  preserveDrawingBuffer : false,
}

const ORIGIN = [0, 0]                                   // esquina del contenedor; reusada porque `move` llega por frame

const dprOf = () => globalThis.devicePixelRatio || 1

export class EditSurface {

  #L; #map; #paneName; #attrs
  #canvas    = null
  #gl        = null
  #attached  = false
  #lost      = false
  #destroyed = false
  #animando  = false
  #ancla     = { x: 0, y: 0, zoom: 0, center: null }   // ancla y vista con las que se rasterizó el contenido

  // Zoom animado: el canvas NO se re-rasteriza por frame —eso vibra— ni espera a `zoomend` —eso
  // teletransporta—. Recibe el mismo transform que los tiles y la transición CSS del pane lo lleva.
  #onZoomAnim = e => this.#animar(e.center, e.zoom)
  #onZoomEnd  = () => {
    this.#animando = false
    this.resetCanvasReference()
  }

  // `antialias` queda fijado para toda la vida del contexto —alternarlo exigiría recrearlo, que es
  // justo lo que el presupuesto prohíbe—: con MSAA el abanico multiplica su fill-rate.
  constructor({ L, map, pane, antialias = false }) {
    this.#L        = L
    this.#map      = map
    this.#paneName = pane
    this.#attrs    = { ...ATTRS, antialias }
    map.on('zoomanim', this.#onZoomAnim)
    map.on('zoomend', this.#onZoomEnd)
  }

  get gl()          { return this.#gl }
  get canvas()      { return this.#canvas }
  get attached()    { return this.#attached }
  get contextLost() { return this.#lost }

  // Primer attach crea el contexto; los siguientes sólo re-dimensionan el canvas.
  attach() {
    if (this.#destroyed) throw new Error('[cristae] EditSurface destruida: el contexto no se recrea')
    this.#gl ??= this.#create()
    this.#attached = true
    this.#canvas.style.display = ''
    this.resetCanvasReference()
    return this.#gl
  }

  // Sin sesión de edición el canvas baja a 1×1: suelta el drawing buffer (a 1080p×DPR2 son cientos de
  // MB) y conserva el contexto, que es lo escaso.
  park() {
    if (!this.#attached) return
    this.#attached = false
    this.#canvas.width = this.#canvas.height = 1
    this.#canvas.style.display = 'none'
  }

  // ÚNICO punto de reposicionado y resize; lo invoca el motor en move/moveend/zoomend. Receta
  // Leaflet-canvas: el canvas se ancla al origen del contenedor en coordenadas de CAPA y mide
  // `getSize() × DPR`. Sin observers propios ni reproyección por frame — de ahí sale la vibración.
  resetCanvasReference() {
    if (!this.#attached) return
    const c = this.#canvas
    const { x, y } = this.#map.getSize()
    const dpr = dprOf()
    const w = Math.round(x * dpr), h = Math.round(y * dpr)
    // Asignar width/height REALOCA el drawing buffer aunque el valor no cambie, y `move` llega por frame.
    if (c.width !== w || c.height !== h) {
      c.width  = w
      c.height = h
      c.style.width  = `${x}px`
      c.style.height = `${y}px`
      this.#gl.viewport(0, 0, w, h)
    }
    this.#animando || this.#anclar()                    // mientras anima, el transform es de la animación
  }

  destroy() {
    this.#map.off('zoomanim', this.#onZoomAnim)
    this.#map.off('zoomend', this.#onZoomEnd)
    this.#canvas?.remove()
    loseGlContext(this)                                 // nadie devuelve un contexto solo: el techo de ~16 es acumulativo
    this.#destroyed = true
    this.#attached  = false
    this.#gl = this.#canvas = null
  }

  // Ancla el canvas al origen del contenedor y RECUERDA con qué vista quedó rasterizado: de esa vista
  // sale el transform del zoom animado.
  #anclar() {
    const map = this.#map
    const a   = this.#ancla
    const p   = map.containerPointToLayerPoint(ORIGIN)
    this.#L.DomUtil.setPosition(this.#canvas, p)
    a.x      = p.x
    a.y      = p.y
    a.zoom   = map.getZoom()
    a.center = map.getCenter()
  }

  // El transform de un frame de zoom: la esquina rasterizada —que en la vista del ancla era el origen del
  // contenedor— reproyectada a la vista destino, y la escala entre ambos zooms. Con `transform-origin: 0 0`
  // (lo pone `leaflet-zoom-animated`) eso lleva CADA píxel del canvas a donde le toca.
  #animar(center, zoom) {
    if (!this.#attached) return
    const map = this.#map
    const a   = this.#ancla
    const s   = map.getZoomScale(zoom, a.zoom)
    const c0  = map.project(a.center, zoom)
    const c1  = map.project(center ?? a.center, zoom)
    const { x: w, y: h } = map.getSize()
    this.#animando = true
    this.#L.DomUtil.setTransform(this.#canvas, this.#L.point(
      a.x + c0.x - c1.x + w * (1 - s) / 2,
      a.y + c0.y - c1.y + h * (1 - s) / 2), s)
  }

  #create() {
    const canvas = document.createElement('canvas')
    // `leaflet-zoom-animated` es lo que hace que la transición CSS del pane (0.25s, el easing del tile)
    // anime el transform del zoom, y lo que fija `transform-origin: 0 0`, del que depende la escala.
    canvas.className           = 'cristae-edit-canvas leaflet-zoom-animated'
    canvas.style.position      = 'absolute'
    canvas.style.pointerEvents = 'none'
    canvas.addEventListener('webglcontextlost', () => { this.#lost = true })

    const gl = canvas.getContext('webgl2', this.#attrs)
    if (!gl) throw new Error('[cristae] sin WebGL2: la geometría editable en GPU necesita gl_VertexID y texelFetch')
    // Esclusa ruidosa: un contexto sin stencil falla EN SILENCIO y se ve como «el relleno a veces cubre
    // la pantalla entera». Se suelta antes de tirar porque el consumidor puede degradar a edición DOM.
    if (!gl.getContextAttributes().stencil) {
      loseGlContext({ gl })
      throw new Error('[cristae] contexto WebGL2 sin stencil: el relleno par-impar no es representable')
    }

    const pane = this.#map.getPane(this.#paneName) ?? this.#map.createPane(this.#paneName)
    pane.appendChild(canvas)
    this.#canvas = canvas
    return gl
  }

}
