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
// comparten. Cuándo se toma, se suelta o se re-adquiere lo decide `gl-budget.js`; una sin dueño no se re-adquiere.
//
// La capa la abre de una de dos formas. `acquire()` toma el contexto ya, y es la de quien no avisa cuando recibe
// contenido: cuenta siempre como necesaria mientras se vea. `open(content)` lo toma ya si la capa tiene contenido, y si
// no deja el marcador y la política lo toma en un momento ocioso; quien abre así avisa con `need()` cada vez que recibe
// contenido, y vacía es prescindible bajo presión.

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

// Un canvas de la superficie, con o sin contexto: el marcador tiene la misma clase y el mismo estilo que el que dibuja.
// También el marcador de un miembro de tramo (`GlTramo.js`).
export const nuevoCanvas = () => {
  const canvas = document.createElement('canvas')
  canvas.className           = 'cristae-edit-canvas'
  canvas.style.position      = 'absolute'
  canvas.style.pointerEvents = 'none'
  return canvas
}

export class EditSurface {

  #camera; #surface; #paneName; #attrs; #cssZoom; #owner
  #offZoom   = []
  #canvas    = null
  #marker    = null       // el marcador de `open` que todavía no pidió contexto: el primero se toma en él mismo
  #gl        = null
  #state     = 'none'     // 'none' | 'live' | 'lost' | 'released'; `state` agrega la pérdida que todavía no se avisó
  #attached  = false
  #destroyed = false
  #lazy      = false      // la abrió `open`: su dueña avisa cuando recibe contenido
  #animando  = false
  #destino   = null       // el zoom animado en curso ({ center, zoom }): un canvas que nace en él toma su transform
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
    owner && glBudget.register(this)
  }

  get gl()          { return this.#gl }
  get canvas()      { return this.#canvas }
  get attached()    { return this.#attached }   // tomó un contexto alguna vez y no se destruyó
  get contextLost() { return this.#state === 'lost' }
  get cssZoom()     { return this.#cssZoom }
  // La prioridad de la superficie: la que dé su dueño (un tramo, la de su miembro más alto) o la z vigente de su pane. La
  // de mayor z se recupera primero y la de menor z cae primero.
  get z()           { return this.#owner?.z ?? this.#surface.zOf(this.#paneName) ?? 0 }
  // Si la política le debe un contexto: se ve (su pane no está oculto) y tiene algo que dibujar, o es un editor con un trazo
  // o un gesto vivo. Una que no avisa cuando recibe contenido (`acquire` al construirse) cuenta siempre con contenido. La
  // de un documento sin ventana —un popup que se cerró sin desmontar su mapa— no: nadie la ve.
  // Lo que no cruza al DOM va primero: una vacía no lee la visibilidad de su pane ni la ventana de su documento.
  get needed() {
    const canvas = this.#canvas
    const owner  = this.#owner
    return (!!owner?.engaged || !!canvas && (!this.#lazy || !!owner?.hasContent) && canvas.parentNode?.style?.visibility !== 'hidden')
      && canvas?.ownerDocument?.defaultView !== null
  }
  // `live`: tiene su contexto. `lost`: el navegador se lo quitó y la política lo recupera. `released`: no lo tiene por
  // decisión propia o de la política (prescindible bajo presión, o sin cupo). `none`: todavía no lo tomó, o se destruyó.
  // La pérdida se lee del contexto, que la sabe en el acto; `webglcontextlost` llega en otra tarea.
  get state()       { return this.#state === 'live' && this.#gl.isContextLost() ? 'lost' : this.#state }

  // Alta perezosa: con contenido toma el contexto ya; vacía deja el marcador en su lugar del pane y la política lo toma
  // en un momento ocioso, o en la tarea en que la dueña avisa con `need()` que recibió contenido. Mientras ningún contexto
  // del realm se haya logrado lo toma ya, vacía o no: sin WebGL2 el alta lanza, como siempre, y quien la pidió degrada.
  // Devuelve el contexto, o null si lo difiere.
  open(content) {
    this.#lazy = true
    if (content || !glBudget.capable) return this.acquire()

    const marcador = nuevoCanvas()
    this.#surface.mount(this.#paneName).appendChild(marcador)
    this.#canvas = this.#marker = marcador
    this.#cssZoom && this.#seguirZoom(null)            // si el primer dato llega en pleno zoom animado, el canvas sigue la transición
    glBudget.reserved(this)
    return null
  }

  // La dueña tiene algo que mostrar —recibió contenido, o se volvió a ver—: sin contexto, la política decide si lo toma ya;
  // con él, si hay que rehacer el orden de desalojo. Devuelve si lo tomó.
  need() { return glBudget.need(this) }

  // Toma un contexto si no tiene uno vivo, en un canvas nuevo que ocupa el lugar del anterior, y su dueño
  // construye sobre él. Con uno vivo sólo lo devuelve.
  acquire() {
    if (this.#destroyed) throw new Error('[cristae] EditSurface destruida: no se re-adquiere')
    if (this.#state === 'live' && !this.#gl.isContextLost()) return this.#gl
    this.#state === 'live' && this.#owner?.dropGl()   // perdido sin aviso todavía: la capa conserva los handles

    // El marcador de un alta perezosa nunca tuvo contexto y se usa él mismo; uno que lo tuvo devolvería el perdido.
    const marcador = this.#canvas
    const canvas   = this.#marker ?? nuevoCanvas()
    this.#marker   = null
    // Sin `preventDefault`: un contexto cancelado queda a la espera de un `restoreContext` que nadie hace. El aviso
    // de un canvas ya reemplazado, o el que deja `loseContext` al soltarlo o destruirla, no es una pérdida.
    canvas.addEventListener('webglcontextlost', () => canvas === this.#canvas && this.#state === 'live' && this.#lose())

    const gl = canvas.getContext('webgl2', this.#attrs)
    if (!gl) {
      this.#owner && glBudget.failed()
      throw new Error('[cristae] sin WebGL2: la geometría editable en GPU necesita gl_VertexID y texelFetch')
    }
    // Esclusa ruidosa: un contexto sin stencil falla EN SILENCIO y se ve como «el relleno a veces cubre
    // la pantalla entera». Se suelta antes de tirar porque el consumidor puede degradar a edición DOM.
    if (!gl.getContextAttributes().stencil) {
      loseGlContext({ gl })
      this.#owner && glBudget.failed()
      throw new Error('[cristae] contexto WebGL2 sin stencil: el relleno par-impar no es representable')
    }

    // El nuevo hereda del marcador lo que la capa le puso, que es si se ve.
    canvas === marcador || (marcador ? marcador.replaceWith(canvas) : this.#surface.mount(this.#paneName).appendChild(canvas))
    canvas.style.display = marcador?.style.display ?? ''
    this.#canvas   = canvas
    this.#gl       = gl
    this.#state    = 'live'
    this.#attached = true
    this.#animando = false                              // un canvas nuevo no viene de ningún zoom: se ancla a la vista que hay
    this.#cssZoom && this.#seguirZoom(canvas)
    this.resetCanvasReference()
    // Nace en pleno zoom animado —la vista todavía no llegó a su destino—: toma el transform de la transición. Un
    // `zoomanim` cuyo `zoomend` no llegó ya está en su destino, y el canvas queda anclado sin escala.
    this.#destino && this.#destino.zoom !== this.#camera.zoom() && this.#animar(this.#destino)
    this.#owner?.buildGl(gl)
    this.#owner && glBudget.acquired(this, gl)
    this.onState?.(this)
    return gl
  }

  // Deja de tener contexto por decisión propia, y el canvas queda de marcador. Viva, lo suelta en el acto —el cupo vuelve
  // al techo— y el dueño olvida su parte GL antes, que después no hay contexto que tocar. Perdida, o sin tomar todavía,
  // sale de la espera de la política. Devuelve si cambió.
  release() {
    if (this.#destroyed || this.#state === 'released') return false

    const viva  = this.#state === 'live'
    const freed = viva && !this.#gl.isContextLost()
    if (viva) {
      this.#owner?.dropGl()
      loseGlContext(this)
    }
    this.#apagar()
    this.#state = 'released'
    this.#gl    = null
    this.#owner && glBudget.dropped(this, freed)
    this.onState?.(this)
    return true
  }

  // Si el navegador ya le quitó el contexto y el aviso todavía no llegó, hace ahora lo que haría el aviso: la política no
  // espera a otra tarea para saber a quién desalojó.
  reconcile() { return this.#state === 'live' && this.#gl.isContextLost() && this.#lose() }

  // El protocolo del tramo, que acá no hace nada: la capa dibuja en el framebuffer por defecto de su canvas y la opacidad
  // la pone el CSS del pane. En un tramo, `begin()` enlaza el FBO del miembro y `end(view)` agenda la composición.
  begin() {}
  end() {}
  setOpacity() {}

  // Muestra u oculta el canvas, marcador incluido: el contexto que lo reemplace hereda su `display`. Devuelve si se ve.
  setVisible(visible = true) {
    this.#canvas && (this.#canvas.style.display = visible ? '' : 'none')
    return visible
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
    const freed = this.#state === 'live' && !this.#gl.isContextLost()
    this.onState = null                                 // el `loseContext` de abajo hace salir `webglcontextlost`, y no es una pérdida
    this.#owner && glBudget.unregister(this, freed)
    this.#offZoom.forEach(off => off())
    if (this.#canvas) {
      this.#canvas.remove()
      this.#surface.unmount(this.#paneName)
    }
    loseGlContext(this)                                 // nadie devuelve un contexto solo: el techo es acumulativo
    this.#destroyed = true
    this.#attached  = false
    this.#state     = 'none'
    this.#gl = this.#canvas = this.#marker = null
  }

  // El navegador le quitó el contexto: el dueño olvida su parte GL y la política decide si se recupera, antes de que avise
  // quien oye: si al oírlo quita la capa, la política ya no la tiene en su espera. Devuelve el estado en que queda.
  #lose() {
    this.#owner?.dropGl()
    this.#apagar()
    this.#state = 'lost'
    this.#gl    = null
    if (this.#owner) this.#state = glBudget.lost(this)
    this.onState?.(this)
    return this.#state
  }

  // El canvas sin contexto queda de marcador de lugar, pero no se puede ver: Chromium pinta de blanco opaco el canvas de
  // un contexto perdido o soltado, y tapa todo lo que está debajo, tiles incluidos. El contexto nuevo va en otro canvas,
  // que nace visible. Se usa `opacity`: `display` es si la capa se ve, y el canvas nuevo lo hereda; `visibility` la usa la
  // imagen fija del tramo para tapar el canvas que vuelve, y al quitarla no debe destapar uno muerto.
  #apagar() { this.#canvas && (this.#canvas.style.opacity = '0') }

  // Zoom animado: el canvas NO se re-rasteriza por frame —eso vibra— ni espera a `zoomend` —eso
  // teletransporta—. Recibe el mismo transform que los tiles y la transición del zoom lo lleva. La vista se
  // oye una vez, con el primer contexto o al diferirlo: una superficie que no lo consiguió no queda colgada de ella.
  #seguirZoom(canvas) {
    canvas && this.#surface.followZoom(canvas)
    this.#offZoom.length || (this.#offZoom = [
      this.#camera.on('zoomanim', destino => this.#animar(this.#destino = destino)),
      this.#camera.on('zoomend', () => {
        this.#destino  = null
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
  #animar({ center, zoom }) {
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
