import { frameTransform } from './frame.js'
import { loseGlContext } from './gl-teardown.js'

// Superficie WebGL2 PROPIA de una capa GPU: un canvas en su pane con un contexto que no se comparte.
// Stencil y profundidad se deciden en `getContext` y no se habilitan después —volver a llamarlo sobre
// el mismo canvas devuelve el MISMO contexto e ignora los atributos nuevos—, así que se piden al
// crearla. PEREZOSA y jamás recreada: el techo de contextos vivos del navegador (~16) se agota de forma
// ACUMULATIVA y nadie devuelve uno salvo `loseContext`.

export const SURFACE_ATTRS = {
  stencil               : true,     // el pase de paridad del abanico escribe acá; sin esto no hay relleno
  alpha                 : true,
  premultipliedAlpha    : true,
  preserveDrawingBuffer : false,
}

// Mezcla `over` de la superficie: sobre un canvas PREMULTIPLICADO el canal alfa compone con ONE, no
// con SRC_ALPHA. Los pases la comparten porque comparten el canvas.
export const blendOver = gl => {
  gl.enable(gl.BLEND)
  gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
}

const dprOf = () => globalThis.devicePixelRatio || 1

export class EditSurface {

  #camera; #surface; #paneName; #attrs; #cssZoom
  #offZoom   = []
  #canvas    = null
  #gl        = null
  #attached  = false
  #lost      = false
  #destroyed = false
  #animando  = false
  #ancla     = { x: 0, y: 0, zoom: 0, center: null }   // ancla y vista con las que se rasterizó el contenido

  // `antialias` y `depth` quedan fijados para toda la vida del contexto —alternarlos exigiría
  // recrearlo, que es justo lo que el presupuesto prohíbe—: con MSAA el abanico multiplica su
  // fill-rate. `cssZoom: false` es para la capa que el motor reproyecta por cuadro durante el zoom: el
  // canvas se queda en su ancla y no sigue la transición, que lo escalaría por encima de ese dibujo.
  constructor({ host, pane, antialias = false, depth = false, cssZoom = true }) {
    this.#camera   = host.camera
    this.#surface  = host.surface
    this.#paneName = pane
    this.#attrs    = { ...SURFACE_ATTRS, antialias, depth }
    this.#cssZoom  = cssZoom
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
  // Leaflet-canvas: el canvas se ancla al origen del contenedor en coordenadas de CAPA y mide el
  // contenedor × DPR. Sin observers propios ni reproyección por frame — de ahí sale la vibración.
  resetCanvasReference() {
    if (!this.#attached) return
    const c = this.#canvas
    const { x, y } = this.#camera.size()
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
    this.#offZoom.forEach(off => off())
    if (this.#canvas) {
      this.#canvas.remove()
      this.#surface.unmount(this.#paneName)
    }
    loseGlContext(this)                                 // nadie devuelve un contexto solo: el techo de ~16 es acumulativo
    this.#destroyed = true
    this.#attached  = false
    this.#gl = this.#canvas = null
  }

  // Ancla el canvas al origen del contenedor y RECUERDA con qué vista quedó rasterizado: de esa vista
  // sale el transform del zoom animado.
  #anclar() {
    const camera = this.#camera
    const a      = this.#ancla
    const p      = camera.frameOrigin()
    this.#canvas.style.transform = frameTransform(p.x, p.y)
    a.x      = p.x
    a.y      = p.y
    a.zoom   = camera.zoom()
    a.center = camera.center()
  }

  // El transform de un frame de zoom: la esquina rasterizada —que en la vista del ancla era el origen del
  // contenedor— reproyectada a la vista destino, y la escala entre ambos zooms, que en Web Mercator es la
  // potencia de 2 de su diferencia. Con el origen del transform en esa esquina (lo pone `followZoom`) eso
  // lleva CADA píxel del canvas a donde le toca.
  #animar(center, zoom) {
    if (!this.#attached) return
    const camera = this.#camera
    const a      = this.#ancla
    const s      = 2 ** (zoom - a.zoom)
    const c0     = camera.project(a.center, zoom)
    const c1     = camera.project(center, zoom)
    const { x: w, y: h } = camera.size()
    this.#animando = true
    this.#canvas.style.transform = frameTransform(
      a.x + c0.x - c1.x + w * (1 - s) / 2,
      a.y + c0.y - c1.y + h * (1 - s) / 2, s)
  }

  #create() {
    const canvas = document.createElement('canvas')
    canvas.className           = 'cristae-edit-canvas'
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

    this.#surface.mount(this.#paneName).appendChild(canvas)
    this.#canvas = canvas
    if (!this.#cssZoom) return gl

    this.#surface.followZoom(canvas)
    // Zoom animado: el canvas NO se re-rasteriza por frame —eso vibra— ni espera a `zoomend` —eso
    // teletransporta—. Recibe el mismo transform que los tiles y la transición del zoom lo lleva. Se oye
    // recién con el contexto creado: una superficie que no lo consiguió no queda colgada de la vista.
    this.#offZoom = [
      this.#camera.on('zoomanim', ({ center, zoom }) => this.#animar(center, zoom)),
      this.#camera.on('zoomend', () => {
        this.#animando = false
        this.resetCanvasReference()
      }),
    ]
    return gl
  }

}
