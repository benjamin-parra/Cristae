import { frameTransform } from './frame.js'
import { glBudget } from './gl-budget.js'
import { loseGlContext } from './gl-teardown.js'

// Superficie WebGL2 PROPIA de una capa GPU: un canvas en su pane con un contexto que no se comparte.
// Stencil y profundidad se deciden en `getContext` y no se habilitan después —volver a llamarlo sobre
// el mismo canvas devuelve el MISMO contexto e ignora los atributos nuevos—, así que se piden al
// crearla.
//
// RE-ADQUIRIBLE. Los contextos vivos tienen techo (16 por proceso de render en Chromium): el navegador puede
// quitarle el suyo, y la superficie puede soltarlo para devolver el cupo. Volver a tomarlo es un CANVAS NUEVO
// en el lugar del viejo, no el viejo restaurado: sin `preventDefault` en `webglcontextlost` el perdido no
// vuelve, y uno nuevo no arrastra estado GL de antes. Lo que dibuja lo rehace su dueño, la capa, desde sus
// espejos de CPU: `buildGl(gl)` cada vez que hay contexto y `dropGl()` cuando deja de haberlo, sin tocarlo. El
// canvas sin contexto queda de marcador: guarda el lugar en el pane, que da el orden entre las capas que lo
// comparten. Cuándo se re-adquiere una perdida lo decide `gl-budget.js`; una sin dueño no se re-adquiere.

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

// Cuánto dura en pie un zoom animado sin su `zoomend`: la transición de Leaflet son 250 ms y un pellizco emite `zoomanim` por
// cuadro, así que pasado esto sin otro aviso el zoom terminó aunque el `zoomend` no haya llegado.
const ZOOM_MS = 400

export class EditSurface {

  #camera; #surface; #paneName; #attrs; #cssZoom; #owner
  #offZoom   = []
  #canvas    = null
  #gl        = null
  #state     = 'none'     // 'none' | 'live' | 'lost' | 'released'; `state` agrega la pérdida que todavía no se avisó
  #attached  = false
  #destroyed = false
  #animando  = false
  #zoomAt    = -Infinity  // cuándo llegó el último `zoomanim`; el `zoomend` lo borra
  #ancla     = { x: 0, y: 0, zoom: 0, center: null }   // ancla y vista con las que se rasterizó el contenido

  // Quien oye los cambios de estado de la superficie —tomar el contexto, perderlo, soltarlo—, con la superficie
  // como argumento. Es el motor, que los avisa por la señal `surfacechange`. Una superficie destruida no avisa.
  onState = null

  // `antialias` y `depth` quedan fijados para toda la vida del contexto —alternarlos exigiría
  // recrearlo—: con MSAA el abanico multiplica su fill-rate. `cssZoom: false` es para la capa que el
  // motor reproyecta por cuadro durante el zoom: el canvas se queda en su ancla y no sigue la transición,
  // que lo escalaría por encima de ese dibujo. `owner` es la capa que construye sobre el contexto
  // (`buildGl`/`dropGl`); sin él la superficie no se recupera de una pérdida.
  constructor({ host, pane, antialias = false, depth = false, cssZoom = true, owner = null }) {
    this.#camera   = host.camera
    this.#surface  = host.surface
    this.#paneName = pane
    this.#attrs    = { ...SURFACE_ATTRS, antialias, depth }
    this.#cssZoom  = cssZoom
    this.#owner    = owner
  }

  get gl()          { return this.#gl }
  get canvas()      { return this.#canvas }
  get attached()    { return this.#attached }   // tomó un contexto alguna vez y no se destruyó
  get contextLost() { return this.#state === 'lost' }
  get cssZoom()     { return this.#cssZoom }
  // Hay un zoom animado en curso, visto desde que la superficie oye la vista (con su primer contexto; una `cssZoom: false`
  // no la oye y da siempre falso). Un canvas que nace en pleno zoom no recibe el `zoomanim` que ya pasó y queda en la vista
  // destino mientras los tiles aún viajan, así que quien re-adquiere espera a que asiente.
  get zooming()     { return performance.now() - this.#zoomAt < ZOOM_MS }
  // `live`: tiene su contexto. `lost`: el navegador se lo quitó. `released`: se soltó. `none`: no tiene ni tuvo
  // uno, o se destruyó. La pérdida se lee del contexto, que la sabe en el acto; `webglcontextlost` llega en otra
  // tarea.
  get state()       { return this.#state === 'live' && this.#gl.isContextLost() ? 'lost' : this.#state }

  // Toma un contexto si no tiene uno vivo, en un canvas nuevo que ocupa el lugar del anterior, y su dueño
  // construye sobre él. Con uno vivo sólo lo devuelve.
  acquire() {
    if (this.#destroyed) throw new Error('[cristae] EditSurface destruida: no se re-adquiere')
    if (this.#state === 'live' && !this.#gl.isContextLost()) return this.#gl
    this.#state === 'live' && this.#owner?.dropGl()   // perdido sin aviso todavía: la capa conserva los handles

    const canvas = document.createElement('canvas')
    canvas.className           = 'cristae-edit-canvas'
    canvas.style.position      = 'absolute'
    canvas.style.pointerEvents = 'none'
    // Sin `preventDefault`: un contexto cancelado queda a la espera de un `restoreContext` que nadie hace. El aviso
    // de un canvas ya reemplazado, o el que deja `loseContext` al soltarlo o destruirla, no es una pérdida.
    canvas.addEventListener('webglcontextlost', () => canvas === this.#canvas && this.#state === 'live' && this.#lose())

    const gl = canvas.getContext('webgl2', this.#attrs)
    if (!gl) throw new Error('[cristae] sin WebGL2: la geometría editable en GPU necesita gl_VertexID y texelFetch')
    // Esclusa ruidosa: un contexto sin stencil falla EN SILENCIO y se ve como «el relleno a veces cubre
    // la pantalla entera». Se suelta antes de tirar porque el consumidor puede degradar a edición DOM.
    if (!gl.getContextAttributes().stencil) {
      loseGlContext({ gl })
      throw new Error('[cristae] contexto WebGL2 sin stencil: el relleno par-impar no es representable')
    }

    // El nuevo hereda del marcador lo que la capa le puso, que es si se ve.
    const marcador = this.#canvas
    marcador ? marcador.replaceWith(canvas) : this.#surface.mount(this.#paneName).appendChild(canvas)
    canvas.style.display = marcador?.style.display ?? ''
    this.#canvas   = canvas
    this.#gl       = gl
    this.#state    = 'live'
    this.#attached = true
    this.#cssZoom && this.#seguirZoom(canvas)
    this.resetCanvasReference()
    this.#owner?.buildGl(gl)
    this.onState?.(this)
    return gl
  }

  // Suelta el contexto en el acto —el cupo vuelve al techo— y el canvas queda de marcador. El dueño olvida su parte
  // GL antes: después no hay contexto que tocar. Devuelve si soltó.
  release() {
    if (this.#state !== 'live') return false
    this.#owner?.dropGl()
    loseGlContext(this)
    this.#state = 'released'
    this.#gl    = null
    glBudget.dropped(this)
    this.onState?.(this)
    return true
  }

  // ÚNICO punto de reposicionado y resize; lo invoca el motor en move/moveend/zoomend. Receta
  // Leaflet-canvas: el canvas se ancla al origen del contenedor en coordenadas de CAPA y mide el
  // contenedor × DPR. Sin observers propios ni reproyección por frame — de ahí sale la vibración. Sin
  // contexto no hay nada que medir: el marcador sólo guarda el lugar.
  resetCanvasReference() {
    if (this.#state !== 'live') return
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
    this.onState = null                                 // el `loseContext` de abajo hace salir `webglcontextlost`, y no es una pérdida
    glBudget.dropped(this)
    this.#offZoom.forEach(off => off())
    if (this.#canvas) {
      this.#canvas.remove()
      this.#surface.unmount(this.#paneName)
    }
    loseGlContext(this)                                 // nadie devuelve un contexto solo: el techo es acumulativo
    this.#destroyed = true
    this.#attached  = false
    this.#state     = 'none'
    this.#gl = this.#canvas = null
  }

  // El navegador le quitó el contexto: el dueño olvida su parte GL y la política decide si se re-adquiere.
  #lose() {
    this.#owner?.dropGl()
    this.#state = 'lost'
    this.#gl    = null
    this.onState?.(this)
    this.#owner && glBudget.lost(this)
  }

  // Zoom animado: el canvas NO se re-rasteriza por frame —eso vibra— ni espera a `zoomend` —eso
  // teletransporta—. Recibe el mismo transform que los tiles y la transición del zoom lo lleva. La vista se
  // oye una vez, con el primer contexto: una superficie que no lo consiguió no queda colgada de ella.
  #seguirZoom(canvas) {
    this.#surface.followZoom(canvas)
    this.#offZoom.length || (this.#offZoom = [
      this.#camera.on('zoomanim', ({ center, zoom }) => {
        this.#zoomAt = performance.now()
        this.#animar(center, zoom)
      }),
      this.#camera.on('zoomend', () => {
        this.#zoomAt   = -Infinity
        this.#animando = false
        this.resetCanvasReference()
      }),
    ])
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
    if (this.#state !== 'live') return
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

}
