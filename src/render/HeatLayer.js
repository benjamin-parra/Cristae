import { EditSurface, blendOver } from './EditSurface.js'
import { createFrameView } from './frame-view.js'
import { projX0, projY0, readView } from './project.js'
import { heatFormat, heatPrograms, heatCellProgram } from './heat-shaders.js'
import { HeatCells, CELL_FLOATS, aggregates, aggregationLevel, cellSize } from './heat-cells.js'
import {
  DEFAULT_RADIUS, DEFAULT_BLUR, DEFAULT_INTENSITY, GRAD_STEPS,
  nonNeg, brushCore, defaultRamp, samplePalette,
} from './heat-math.js'

// Capa de CAMPO DE CALOR (heatmap) en GPU, reactiva a un Source. Es un miembro de tramo como las demás capas GL: su
// superficie sale de `surface({ host, pane, owner: this })`, y cuando esa superficie es la ranura de un tramo,
// `begin()` enlaza el FBO del miembro y `end(view)` agenda la composición. Sin tramo, la superficie es propia y
// `begin()` no hace nada. La capa no tiene canvas 2D.
//
// LA LEY. El calor es la unión probabilística de los aportes: cada punto suma una brocha radial (1 hasta el núcleo,
// lineal a 0 en el borde) con un aporte CHICO ∝ su peso, y donde se agolpan el alfa acumulado a + b·(1−a) crece
// sin saturar. La pasada 1 estampa un quad instanciado por punto en un FBO propio de la capa, en px CSS de la vista;
// la pasada 2 lee ese índice, lo busca en la paleta de `colorRamp` y lo escribe, con la mezcla `over`, en la ranura del
// tramo. El formato del acumulador lo decide `heatFormat` una vez por contexto, desde las extensiones y una sonda de
// framebuffer, nunca desde el navegador: R16F con la suma logarítmica, o el respaldo RGBA8 con `over` cuantizado a
// 8 bits (heat-shaders.js explica ambas y el error medido del respaldo).
//
// LOS DATOS. El snapshot se baja a un espejo de CPU de 3 floats por punto —posición world0 relativa a un ancla, y peso
// normalizado por el máximo del snapshot— que se sube al búfer de instancias. El ancla es el centro de la vista, en
// float64: relativa a ella, la posición cabe en float32 sin perder píxeles, como en `PointLayer`. Una vista que se
// aleja de su ancla hasta que el redondeo se acerca a `ANCHOR_TOL_PX` la reasienta y vuelve a subir. Con la cámara
// sola —un paneo, un zoom— el dibujo no relee los accessors ni sube nada: sólo cambian la matriz y los uniformes.
// `dropGl` conserva el espejo, así que un contexto nuevo resube sin volver a los datos.
//
// LA AGREGACIÓN. Cuando el relleno de un splat por punto pasa el umbral (`aggregates`, que sigue a n·R²), el splat no es por
// punto sino por celda de pantalla (heat-cells.js): cada celda junta sus puntos en una muestra con su multiplicidad, y el campo
// a la vista es el mismo con muchas menos instancias. Las celdas salen del espejo, nunca de los accessors, y se rehacen sólo
// cuando cambia algo de lo que dependen: el espejo (un flush, un reasiento del ancla), el nivel de la grilla, el tamaño de celda
// (que sigue al radio), `intensity` (el aporte va horneado en la celda) y `refresh`. Un paneo no las toca. Un zoom animado
// avisa su destino con `zoomanim`, y las celdas de ese nivel se arman mientras el campo está oculto, dos cuadros después,
// cuando la transición ya corre. Una pasada que no agregó deja anotado su nivel: uno igual o más fino no la repite hasta que
// cambien los datos, la celda o `intensity`. Por debajo del umbral, o donde agregar no paga, la capa dibuja exactamente como
// sin agregación.
//
// EL ZOOM ANIMADO. El campo no se escala con la transición CSS del canvas (se vería desfasado): al empezar el zoom se
// pinta vacío, y el calor reaparece, ya reproyectado, al asentar la vista. Mientras dura, ni un flush de la Source ni un
// evento de mapa lo pintan: quedan anotados como atrasados y los pinta el `zoomend`.
//
// accessors: { idOf, positionOf, weightOf? }. `weightOf` (o 1) es el peso del punto; se NORMALIZA por el peso máximo
// del snapshot y se escala por `intensity`. Agnóstico: sin dominio ni React.

// El error de float32 en un punto visible es |centro − ancla|·2^zoom·2^-24 px: el ancla se reasienta cuando eso
// pasa de un dieciseisavo de px, que queda bajo el redondeo de la rejilla de píxeles.
const ANCHOR_TOL_PX = 1 / 16

// Bits de mantisa de un float32, con el bit implícito.
const FLOAT32_BITS = 24

// Un punto en el espejo y en el búfer de instancias: x e y relativas al ancla y el peso normalizado.
const INSTANCE_FLOATS = 3
const FLOAT_BYTES     = 4
const INSTANCE_STRIDE = INSTANCE_FLOATS * FLOAT_BYTES
const WEIGHT_OFFSET   = 2 * FLOAT_BYTES

// Una celda en su búfer de instancias: el centroide en x e y, el aporte medio, la multiplicidad y la covarianza.
const CELL_STRIDE        = CELL_FLOATS * FLOAT_BYTES
const CELL_WEIGHT_OFFSET = 2 * FLOAT_BYTES
const CELL_COUNT_OFFSET  = 3 * FLOAT_BYTES
const CELL_COV_OFFSET    = 4 * FLOAT_BYTES
const COV_FLOATS         = 3

// Capacidad inicial del espejo, en puntos: una nube chica no crece. Después se duplica.
const MIN_INSTANCES = 64

// El splat es un quad de 4 vértices por instancia, en TRIANGLE_STRIP.
const QUAD_VERTICES = 4

// La rampa es un triángulo de pantalla completa.
const FULLSCREEN_VERTICES = 3

const parameterTexture = (gl, filter) => {
  const tex = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  return tex
}

export class HeatLayer {

  #camera; #surface; #source; #accessors
  #radius; #blur; #intensity; #colorRamp
  #palette    = null                // Uint8ClampedArray(GRAD_STEPS*4): rampa pre-muestreada, índice → color
  #frame      = createFrameView()
  #placed     = { anchorX: 0, anchorY: 0 }   // el ancla del espejo, world0 px (float64), con la forma que lee FrameView.bind
  #mirror     = new Float32Array(MIN_INSTANCES * INSTANCE_FLOATS)
  #count      = 0                   // puntos válidos en el espejo
  #dirty      = true                // el snapshot cambió: el espejo se rehace desde los accessors
  #pending    = false               // el espejo cambió y el búfer de la GPU no lo tiene
  #uIntensity = new Float32Array(1)
  #uRadius    = new Float32Array(1)   // R = radius + blur, px del FBO
  #uCore      = new Float32Array(1)   // core·R
  #uSize      = new Float32Array(2)   // el FBO en px
  #uRatio     = new Float32Array(1)   // px del acumulador por px del dispositivo
  #uPxWorld0  = new Float32Array(1)   // px de pantalla por px de world0, para la covarianza de las celdas
  #gl         = null
  #format     = null
  #programs   = null
  #vao        = null
  #vbo        = null
  #accTex     = null
  #accFbo     = null
  #accW       = 0
  #accH       = 0
  #palTex     = null
  #cells      = null                // HeatCells, desde el primer dibujo que agrega
  #cellsStale = true                // las celdas no siguen al espejo, la intensidad o un refresh
  #cellLevel  = NaN                 // el nivel y el tamaño de celda con que se armaron
  #cellPx     = NaN
  #cellCount  = 0                   // celdas que se dibujan; 0 = un splat por punto
  #cellPending = false              // las celdas cambiaron y su búfer no las tiene
  #cellVao    = null
  #cellVbo    = null
  #cellProgram = null
  #failLevel  = Infinity            // el nivel más grueso donde una pasada no agregó, con los datos y la celda de ahora
  #toward     = null                // el destino del zoom animado en curso, de `zoomanim`
  #towardView = { center: { x: 0, y: 0 } }   // su centro en world0, con la forma que lee `#rebuild`
  #prepRaf    = 0                   // rAF que arma las celdas del destino; 0 = ninguno
  #raf        = 0                   // rAF del redibujo coalescido a un frame; 0 = ninguno
  #visible    = true                // oculta no dibuja: el pane oculto no detiene el trabajo por flush
  #stale      = true                // algo pidió un dibujo mientras estaba oculta o sin contexto
  #blank      = false               // el último cuadro fue el vacío del zoom animado
  #destroyed  = false
  #unsub      = null
  #offView    = []                  // bajas del ciclo de vista

  constructor({
    host, pane, source, accessors = null, radius, blur, intensity, colorRamp, visible = true,
    surface = opts => new EditSurface(opts),
  } = {}) {
    this.#camera    = host.camera
    this.#source    = source
    this.#accessors = accessors ?? source.accessors
    this.#radius    = nonNeg(radius, DEFAULT_RADIUS)
    this.#blur      = nonNeg(blur, DEFAULT_BLUR)
    this.#colorRamp = colorRamp ?? defaultRamp
    this.#visible   = visible
    this.#setIntensity(intensity)
    this.#setBrush()
    // Consulta colorRamp GRAD_STEPS veces. Es código del consumidor y puede lanzar: va antes de tomar la superficie,
    // para que una capa que no nace no deje su pane.
    this.#buildPalette()
    // `cssZoom: true`, como las líneas y los polígonos: el campo no se reproyecta por cuadro (en el zoom animado se pinta
    // vacío), así que dentro de un tramo la vista inyectada del zoom se conserva, y una superficie propia sigue la
    // transición CSS del canvas, que en ese lapso está vacío.
    this.#surface = surface({ host, pane, cssZoom: true, owner: this })
    // Lo que sigue puede tirar, y un contexto que nadie devuelve no vuelve en toda la vida de la página.
    try {
      const gl = this.#surface.open(this.hasContent)
      // Ruta del Source: dibuja SÍNCRONO. El Emitter del Source ya coalesce sus notificaciones a UN rAF, así que un
      // rAF propio acá sería un SEGUNDO frame de latencia sin ganancia. El rAF de #invalidate queda para los eventos de
      // mapa (que Leaflet dispara sin coalescer).
      this.#unsub = source.subscribe(this.#onSource)
      this.#offView = [
        this.#camera.on('zoomstart', this.#onZoomStart),
        this.#camera.on('zoomanim', this.#onZoomAnim),
        this.#camera.on('zoomend', this.#onZoomEnd),
        this.#camera.on('moveend resize', () => this.#invalidate()),
      ]
      gl || this.#draw()                   // si tomó el contexto, `buildGl` ya pintó
    } catch (e) {
      this.destroy()
      throw e
    }
  }

  get surface()    { return this.#surface }
  get canvas()     { return this.#surface.canvas }
  get hasContent() { return this.#source.getSnapshot().length > 0 }    // la política lo lee mientras la capa se construye

  /* ── Ciclo de vida ── */

  redraw() { return this.#draw() }
  resetCanvasReference() { return this.#draw() }                       // reposiciona + redibuja (el draw hace ambas)
  refresh() { this.#buildPalette(); this.#cellsStale = true; return this.#draw() }   // re-encode (p. ej. cambio de tema en la rampa)
  syncPickingSize() {}                                                 // sin picking (un heat no se pica)

  // Lo llama setLayerVisibility del motor. Oculta no dibuja y queda anotada como atrasada; al volver repinta si hacía
  // falta, con el snapshot actual: oculta no siguió los flushes ni la vista. Devuelve si pintó.
  setVisible(visible = true) {
    this.#visible = visible
    this.#surface.setVisible(visible)
    return visible && this.#stale && this.#draw()
  }

  // Seguro a medio construir, e idempotente. Suelta la Source, los eventos y el rAF pendiente, y devuelve lo GL que
  // tenga a un contexto vivo (en un tramo el contexto sigue siendo de las demás).
  destroy() {
    if (this.#destroyed) return

    this.#destroyed = true
    this.#unsub?.()
    this.#offView.forEach(off => off())
    this.#prepRaf && cancelAnimationFrame(this.#prepRaf)
    cancelAnimationFrame(this.#raf)
    this.#raf = this.#prepRaf = 0
    const gl = this.#gl
    if (gl && !gl.isContextLost()) {
      gl.deleteTexture(this.#accTex)
      gl.deleteTexture(this.#palTex)
      gl.deleteFramebuffer(this.#accFbo)
      gl.deleteBuffer(this.#vbo)
      gl.deleteVertexArray(this.#vao)
      this.#cellVbo && gl.deleteBuffer(this.#cellVbo)
      this.#cellVao && gl.deleteVertexArray(this.#cellVao)
    }
    this.dropGl()
    this.#surface?.destroy()
  }

  /* ── Props en vivo (el handle de addHeatLayer las cablea) ── */

  set radius(v) { this.#radius = nonNeg(v, DEFAULT_RADIUS); this.#setBrush(); this.#invalidate() }
  set blur(v) { this.#blur = nonNeg(v, DEFAULT_BLUR); this.#setBrush(); this.#invalidate() }
  set intensity(v) { this.#setIntensity(v); this.#invalidate() }
  set colorRamp(fn) { this.#colorRamp = fn ?? defaultRamp; this.#buildPalette(); this.#invalidate() }

  // El aporte va horneado en las celdas: sólo rehacerlas si la intensidad cambia (el handle, el elemento y React la asignan
  // también con el mismo valor).
  #setIntensity(v) {
    const next = v ?? DEFAULT_INTENSITY
    if (next !== this.#intensity) this.#cellsStale = true
    this.#intensity = next
    this.#uIntensity[0] = next
  }

  // R = alcance de un punto en px y core·R = hasta dónde la brocha es opaca; son uniformes, así que cambiarlos no
  // resube nada.
  #setBrush() {
    const R = this.#radius + this.#blur
    this.#uRadius[0] = R
    this.#uCore[0]   = brushCore(this.#radius, this.#blur) * R
  }

  /* ── Disparos ── */

  // Ruta del Source: marca los datos sucios y dibuja en el acto. Con contenido, avisa a la política: si eso tomó el
  // contexto, `buildGl` ya pintó.
  #onSource = () => {
    this.#dirty = true
    ;(this.hasContent && this.#surface.need()) || this.#draw()    // en el zoom animado `#draw` no pinta: lo hace el `zoomend`
  }

  // El zoom animado va con la transición CSS del canvas, que escalaría un campo difuso desfasado: se pinta vacío.
  #onZoomStart = () => this.#blank || (this.#blank = this.#drawEmpty())

  // El destino del zoom animado: sus celdas se arman con el campo oculto. No en el acto, que demoraría el arranque de la
  // transición, sino dos cuadros después, cuando el compositor ya la anima.
  #onZoomAnim = toward => {
    this.#toward = toward
    this.#prepRaf ||= requestAnimationFrame(this.#onPrepFrame)
  }

  #onPrepFrame = () => (this.#prepRaf = requestAnimationFrame(this.#prepare))

  // Lo que hará el dibujo del `zoomend` con la vista destino: reasentar el ancla si hace falta y armar las celdas de su nivel.
  // Oculta, sin contexto o sin agregar no hace nada; si el `zoomend` llegó antes, ya no hay destino.
  #prepare = () => {
    this.#prepRaf = 0
    const toward = this.#toward
    if (!toward || !this.#gl || !this.#visible || this.#destroyed) return

    const placed = this.#placed
    const x = projX0(toward.center.lng)
    const y = projY0(toward.center.lat)
    const drift = Math.max(Math.abs(x - placed.anchorX), Math.abs(y - placed.anchorY))
    if (this.#dirty || drift * 2 ** (toward.zoom - FLOAT32_BITS) > ANCHOR_TOL_PX) {
      this.#towardView.center.x = x
      this.#towardView.center.y = y
      this.#rebuild(this.#towardView)
    }
    this.#aggregate(toward.zoom)
  }

  // La vista asentó: el campo vuelve, reproyectado, en el próximo frame.
  #onZoomEnd = () => {
    this.#blank  = false
    this.#toward = null
    this.#prepRaf && cancelAnimationFrame(this.#prepRaf)
    this.#prepRaf = 0
    this.#invalidate()
  }

  // Coalescing a un frame para disparos NO coalescidos aguas arriba: eventos de mapa (Leaflet los emite sync, pueden
  // venir en ráfaga) y props en vivo (radius+blur+intensity juntos → un solo redibujo). La ruta del Source NO pasa
  // por acá: ya viene coalescida.
  #invalidate() {
    if (this.#destroyed) return

    this.#raf ||= requestAnimationFrame(this.#onFrame)
  }

  #onFrame = () => {
    this.#raf = 0
    this.#draw()
  }

  /* ── Espejo de CPU ── */

  // Rehace el espejo desde los accessors, relativo a un ancla nueva en el centro de la vista. Dos pasadas con bucle
  // explícito (sin reduce ni clausuras): el peso máximo y la escritura. Omite las posiciones no finitas.
  #rebuild(view) {
    const a        = this.#accessors
    const weightOf = a.weightOf
    const items    = this.#source.getSnapshot()
    const placed   = this.#placed
    // Normaliza por el peso máximo del snapshot: la escala del campo no depende de las unidades del peso.
    let maxW = 0
    if (weightOf)
      for (let i = 0; i < items.length; i++) {
        const w = weightOf(items[i]) || 0
        if (w > maxW) maxW = w
      }
    maxW ||= 1

    if (this.#mirror.length < items.length * INSTANCE_FLOATS)
      this.#mirror = new Float32Array(Math.max(items.length, this.#mirror.length / INSTANCE_FLOATS * 2) * INSTANCE_FLOATS)
    const mirror = this.#mirror
    placed.anchorX = view.center.x
    placed.anchorY = view.center.y
    let n = 0
    for (let i = 0; i < items.length; i++) {
      const pos = a.positionOf(items[i])
      if (!pos || !Number.isFinite(pos.lat) || !Number.isFinite(pos.lng)) continue

      const o = n * INSTANCE_FLOATS
      mirror[o]     = projX0(pos.lng) - placed.anchorX
      mirror[o + 1] = projY0(pos.lat) - placed.anchorY
      mirror[o + 2] = (weightOf ? (weightOf(items[i]) || 0) : 1) / maxW
      n++
    }
    this.#count   = n
    this.#dirty   = false
    this.#pending = true
    this.#cellsStale = true
  }

  #upload(gl) {
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#vbo)
    gl.bufferData(gl.ARRAY_BUFFER, this.#mirror.subarray(0, this.#count * INSTANCE_FLOATS), gl.DYNAMIC_DRAW)
    this.#pending = false
  }

  /* ── Celdas ── */

  // Las celdas que se dibujan a este zoom, rehechas sólo si cambió algo de lo que dependen. 0 = un splat por punto. Un nivel
  // igual o más fino que uno donde la pasada no agregó tampoco agrega: con un nivel entero de diferencia cada celda se parte en
  // cuatro, y las celdas sólo pueden crecer; dentro del primer entero la grilla no se anida y es una aproximación.
  #aggregate(zoom) {
    if (!aggregates(this.#count, this.#uRadius[0])) return (this.#cellCount = 0)

    const level = aggregationLevel(zoom)
    const px    = cellSize(this.#uRadius[0])
    if (this.#cellsStale || px !== this.#cellPx) this.#failLevel = Infinity
    if (this.#cellsStale || level !== this.#cellLevel || px !== this.#cellPx) {
      const placed = this.#placed
      this.#cells ??= new HeatCells()
      this.#cellCount   = level >= this.#failLevel ? 0
        : this.#cells.build(this.#mirror, this.#count, placed.anchorX, placed.anchorY, level, px, this.#intensity)
      if (!this.#cellCount) this.#failLevel = Math.min(this.#failLevel, level)
      this.#cellLevel   = level
      this.#cellPx      = px
      this.#cellsStale  = false
      this.#cellPending = this.#cellCount > 0
    }
    return this.#cellCount
  }

  // El programa y el VAO de celdas nacen con la primera subida: una capa que nunca agrega no los crea.
  #uploadCells(gl) {
    if (!this.#cellVbo) {
      this.#cellProgram = heatCellProgram(gl, this.#format)
      this.#cellVbo = gl.createBuffer()
      this.#cellVao = gl.createVertexArray()
      gl.bindVertexArray(this.#cellVao)
      gl.bindBuffer(gl.ARRAY_BUFFER, this.#cellVbo)
      gl.enableVertexAttribArray(0)
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, CELL_STRIDE, 0)
      gl.vertexAttribDivisor(0, 1)
      gl.enableVertexAttribArray(1)
      gl.vertexAttribPointer(1, 1, gl.FLOAT, false, CELL_STRIDE, CELL_WEIGHT_OFFSET)
      gl.vertexAttribDivisor(1, 1)
      gl.enableVertexAttribArray(2)
      gl.vertexAttribPointer(2, 1, gl.FLOAT, false, CELL_STRIDE, CELL_COUNT_OFFSET)
      gl.vertexAttribDivisor(2, 1)
      gl.enableVertexAttribArray(3)
      gl.vertexAttribPointer(3, COV_FLOATS, gl.FLOAT, false, CELL_STRIDE, CELL_COV_OFFSET)
      gl.vertexAttribDivisor(3, 1)
      gl.bindVertexArray(null)
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#cellVbo)
    gl.bufferData(gl.ARRAY_BUFFER, this.#cells.out.subarray(0, this.#cellCount * CELL_FLOATS), gl.DYNAMIC_DRAW)
    this.#cellPending = false
  }

  /* ── Dibujo ── */

  // El FBO del miembro, o el framebuffer por defecto si la superficie es propia, ya limpio.
  #begin(gl) {
    if (!this.#surface.begin()) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight)
    }
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
  }

  // Devuelve si pintó el cuadro vacío.
  #drawEmpty() {
    const gl = this.#gl
    if (!gl || !this.#visible || !this.#camera.hasView()) return false

    this.#begin(gl)
    this.#surface.end(readView(this.#camera, this.#frame))
    return true
  }

  // Acumular densidad y colorear. Sin vista no hay píxel que leer: un mapa adoptado que todavía no la tomó pinta en el
  // `moveend` que la trae. Oculta o sin contexto no dibuja y queda atrasada; al volver, `buildGl` o `setVisible` pintan.
  // Con la cámara sola no asigna. [0-alloc]
  #draw() {
    const gl = this.#gl
    if (!gl || !this.#visible) {
      this.#stale = true
      return false
    }
    if (this.#blank) {                  // zoom animado: el campo se repinta en el `zoomend`
      this.#stale = true
      return false
    }
    if (!this.#camera.hasView()) return false

    const view = readView(this.#camera, this.#frame)
    const w    = Math.round(view.size.x)
    const h    = Math.round(view.size.y)
    if (!(w > 0 && h > 0)) return false

    this.#stale = false
    this.#surface.resetCanvasReference()
    const placed = this.#placed
    const drift  = Math.max(Math.abs(view.center.x - placed.anchorX), Math.abs(view.center.y - placed.anchorY))
    if (this.#dirty || drift * 2 ** (view.zoom - FLOAT32_BITS) > ANCHOR_TOL_PX) this.#rebuild(view)
    this.#pending && this.#upload(gl)
    this.#aggregate(view.zoom) && this.#cellPending && this.#uploadCells(gl)

    this.#accumulate(gl, w, h, view.zoom)
    this.#colorize(gl, w)
    this.#surface.end(view)
    return true
  }

  // Pasada 1: los splats al FBO de acumulación, que se realoca sólo si cambió el tamaño de la vista.
  #accumulate(gl, w, h, zoom) {
    const format = this.#format
    gl.activeTexture(gl.TEXTURE0)
    if (!this.#accTex) {
      this.#accTex = parameterTexture(gl, gl.LINEAR)    // la rampa interpola el acumulador en px CSS: en DPR 2 no se escalona
      this.#accFbo = gl.createFramebuffer()
    }
    gl.bindTexture(gl.TEXTURE_2D, this.#accTex)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.#accFbo)
    if (w !== this.#accW || h !== this.#accH) {
      gl.texImage2D(gl.TEXTURE_2D, 0, format.internalFormat, w, h, 0, format.format, format.type, null)   // mutable: realocar no crea
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.#accTex, 0)
      this.#accW = w
      this.#accH = h
    }
    gl.viewport(0, 0, w, h)
    gl.disable(gl.DEPTH_TEST)
    gl.disable(gl.STENCIL_TEST)
    gl.disable(gl.SCISSOR_TEST)
    gl.disable(gl.CULL_FACE)
    gl.colorMask(true, true, true, true)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    if (!this.#count || !(this.#uRadius[0] > 0)) return

    const cells = this.#cellCount
    const splat = cells ? this.#cellProgram : this.#programs.splat
    this.#uSize[0] = w
    this.#uSize[1] = h
    gl.enable(gl.BLEND)
    gl.blendFunc(format.blendSrc, format.blendDst)
    gl.useProgram(splat.program)
    this.#frame.bind(gl, splat, this.#placed)
    if (cells) {                         // en las celdas el aporte ya lleva la intensidad
      this.#uPxWorld0[0] = 2 ** zoom
      gl.uniform1fv(splat.uPxPorWorld0, this.#uPxWorld0)
    } else gl.uniform1fv(splat.uIntensity, this.#uIntensity)
    gl.uniform1fv(splat.uRadius, this.#uRadius)
    gl.uniform1fv(splat.uCore, this.#uCore)
    gl.uniform2fv(splat.uAccSize, this.#uSize)
    gl.bindVertexArray(cells ? this.#cellVao : this.#vao)
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, QUAD_VERTICES, cells || this.#count)
    gl.bindVertexArray(null)
  }

  // Pasada 2: el índice acumulado → color de la paleta, con la mezcla `over` de la ranura. El alfa final se atenúa por
  // el de la rampa: una rampa que arranca transparente desvanece las densidades bajas.
  #colorize(gl, w) {
    this.#begin(gl)
    const ramp = this.#programs.ramp
    this.#uRatio[0] = gl.drawingBufferWidth ? w / gl.drawingBufferWidth : 1
    blendOver(gl)
    gl.useProgram(ramp.program)
    gl.uniform1fv(ramp.uAccPorDispositivo, this.#uRatio)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.#accTex)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, this.#palTex)
    gl.activeTexture(gl.TEXTURE0)
    gl.drawArrays(gl.TRIANGLES, 0, FULLSCREEN_VERTICES)
  }

  /* ── Paleta ── */

  // Muestrea `colorRamp` en GRAD_STEPS pasos y, con contexto, actualiza la textura de la paleta.
  #buildPalette() {
    this.#palette = samplePalette(this.#colorRamp, this.#palette ?? new Uint8ClampedArray(GRAD_STEPS * 4))
    const gl = this.#gl
    if (!gl) return

    gl.activeTexture(gl.TEXTURE1)       // la unidad de la paleta, que es la que la rampa lee
    gl.bindTexture(gl.TEXTURE_2D, this.#palTex)
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, GRAD_STEPS, 1, gl.RGBA, gl.UNSIGNED_BYTE, this.#palette)
    gl.activeTexture(gl.TEXTURE0)
  }

  /* ── Contexto: la superficie lo toma y lo suelta, y la capa rehace su parte GL desde el espejo de CPU ── */

  // Al construirse y cada vez que la superficie vuelve a tomar un contexto: formato, programas, el VAO de instancias, el
  // búfer (que se sube del espejo, sin releer los accessors) y la textura de la paleta. El FBO de acumulación nace al
  // dibujar. Pinta en el acto, porque el contexto nace en blanco.
  buildGl(gl) {
    this.#gl       = gl
    this.#format   = heatFormat(gl)
    this.#programs = heatPrograms(gl, this.#format)
    this.#vbo      = gl.createBuffer()
    this.#vao      = gl.createVertexArray()
    gl.bindVertexArray(this.#vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#vbo)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, INSTANCE_STRIDE, 0)
    gl.vertexAttribDivisor(0, 1)
    gl.enableVertexAttribArray(1)
    gl.vertexAttribPointer(1, 1, gl.FLOAT, false, INSTANCE_STRIDE, WEIGHT_OFFSET)
    gl.vertexAttribDivisor(1, 1)
    gl.bindVertexArray(null)
    this.#palTex = parameterTexture(gl, gl.NEAREST)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, GRAD_STEPS, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, this.#palette)
    this.#accW = this.#accH = 0
    this.#pending = !this.#dirty && this.#count > 0
    this.#cellPending = this.#cellCount > 0
    return this.#draw()
  }

  // Olvida lo GL sin tocar el contexto, que se perdió o que la superficie va a soltar con `loseContext`. El espejo y
  // la paleta son de CPU y siguen.
  dropGl() {
    this.#gl = this.#format = this.#programs = this.#vao = this.#vbo = null
    this.#accTex = this.#accFbo = this.#palTex = null
    this.#cellVao = this.#cellVbo = this.#cellProgram = null
    this.#accW = this.#accH = 0
  }
}
