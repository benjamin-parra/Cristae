// Capa de FORMAS en METROS: círculos, elipses, sectores y sectores de elipse, mezclados en un solo contexto
// WebGL. Cada forma es un anillo que sale del escritor de `ring` (geometry/shape.js) sobre el modelo del
// mapa; lo dibuja una capa de polígonos no interactiva, y el picking es punto-en-anillo sobre esas mismas
// tablas, así que lo que pica es lo que se ve. Al borde sólo lo separa de la curva la flecha de la cuerda,
// que la capa mantiene bajo una fracción de píxel eligiendo los segmentos de cada forma al zoom vigente.
//
// accessors: { idOf, positionOf, radiusOf, headingOf?, sweepOf?, styleOf? }, leídos con la regla de validez
// de `ring`. Además se descarta la forma cuyo borde alcanza un polo, que en Mercator no tiene contorno
// finito. `styleOf` devuelve el vocabulario de la capa de polígonos.
//
// Un cambio del Source rehace las tablas enteras: el store sube su textura completa de todos modos, y el
// perfil de la capa son magnitudes que cambian poco, no un feed por frame.

import { MIN_SEGMENTS } from '../geometry/density.js'
import { prepareRangeIndex, partsAtPoint } from '../geometry/polygon.js'
import { readDrawable, sizeShape, viewSegments, writeShape } from '../geometry/shape.js'
import { PolygonGpuLayer } from './PolygonGpuLayer.js'

const EMPTY = {
  xy: new Float64Array(0), vertexAt: Uint32Array.of(0), ringAt: Uint32Array.of(0), closed: new Uint8Array(0),
  ringCount: 0, partCount: 0,
}

export class ShapeLayer {

  #camera; #source; #model; #interactive
  #layer   = null
  #recs    = []       // las formas válidas de `readDrawable`, con `id`, `style` y `wanted`, los segmentos pedidos
  #seen    = null     // la `version` de la Source que leyeron los registros vigentes
  #index   = null
  #parts   = []       // partes bajo el puntero; se reusa entre consultas
  #unsub   = null
  #offZoom = null

  // `host` es el anfitrión del mapa: de él salen la cámara y el pane donde se ancla el canvas.
  constructor({ host, pane, source, model, interactive = false }) {
    this.#camera      = host.camera
    this.#source      = source
    this.#model       = model
    this.#interactive = interactive
    // Nace vacía para leer el tope de textura de su contexto antes de armar la primera geometría.
    this.#layer = new PolygonGpuLayer({
      host, pane, geometry: EMPTY,
      idOf: k => this.#recs[k].id, styleOf: k => this.#recs[k].style,
    })
    // El contexto ya está tomado: si la primera lectura lanza, se devuelve.
    try {
      this.refresh()
    } catch (e) {
      this.destroy()
      throw e
    }
    // Lo que un encuadre ya dibujó no se rehace al emitir.
    this.#unsub   = source.subscribe(() => source.version() !== this.#seen && this.refresh())
    // El zoom asentó: se rehace la geometría sólo si alguna forma pide otro número de segmentos.
    this.#offZoom = host.camera.on('zoomend', () => {
      const zoom = this.#camera.zoom()
      this.#recs.some(rec => rec.wanted !== viewSegments(rec, zoom)) && this.#draw()
    })
  }

  /* ── Lifecycle: la capa se repinta sola en la vista asentada; el motor sólo la refresca y la oculta ── */
  // Los registros y la geometría van juntos: si la capa interna rechaza los nuevos, vuelven los de antes,
  // que son los que sigue dibujando. Se copia el estilo acá mismo: `styleOf` puede devolver un objeto
  // scratch reusado, y retenerlo apuntaría todas las filas al mismo objeto mutado. `readShape` ya lee el
  // centro como escalares.
  refresh() {
    if (!this.#layer) return
    const previous = this.#recs
    const a        = this.#source.accessors
    const recs     = []
    this.#seen = this.#source.version()
    this.#source.getSnapshot().forEach(item => {
      const rec = readDrawable({
        center: a.positionOf(item), radius: a.radiusOf(item), heading: a.headingOf?.(item), sweep: a.sweepOf?.(item),
      })
      rec && recs.push(Object.assign(rec, { id: a.idOf(item), style: { ...a.styleOf?.(item) }, wanted: 0 }))
    })
    this.#recs = recs
    try {
      return this.#draw()
    } catch (e) {
      this.#recs = previous
      throw e
    }
  }

  setVisible(visible) { return this.#layer?.setVisible(visible) }

  // Caja en grados de lo que la capa dibuja: la figura entera, no sólo los centros. La Source emite en el
  // próximo frame con el snapshot ya cambiado: si su `version` avanzó, se dibuja antes, y encuadrar tras
  // `set` en el mismo tick ve lo nuevo.
  get bounds() {
    this.#layer && this.#source.version() !== this.#seen && this.refresh()
    return this.#layer?.bounds ?? null
  }

  destroy() {
    this.#unsub?.()
    this.#offZoom?.()
    this.#layer?.destroy()
    this.#layer = null
    this.#index = null
    this.#recs  = []
  }

  // Eje focus: atenúa por FEATURE, y el foco lo pliega el estilo de cada anillo. Devuelve `true` aunque la
  // capa interna no repinte, oculta: para el motor significa «atenúo por ítem», y un falso atenuaría el pane.
  applyFocus(ids, dim) {
    this.#layer?.applyFocus(ids, dim)
    return true
  }

  /* ── Picking punto-en-anillo sobre las tablas del dibujo; el registro ordena y envuelve con layerId/z/order ── */
  resolveClick(sample) { return this.#hitsAt(sample) }
  resolveHover(sample) { return this.#hitsAt(sample) }

  // El anillo se dibuja una sola vez, en la copia del mundo de su centro, y su lng no se envuelve; el latlng
  // del puntero tampoco, así que el punto-en-anillo en grados contesta sólo en la copia dibujada. La parte
  // `k` es la forma `k`, y la última se dibuja encima: el hit sale de arriba hacia abajo.
  #hitsAt({ lat, lng }) {
    return !this.#index ? [] : partsAtPoint(this.#index, lng, lat, this.#parts).sort((p, q) => q - p).map(k => {
      const id = this.#recs[k].id
      return { ref: id, id, distancePx: 0 }
    })
  }

  // Un anillo por forma, cerrado repitiendo su primer vértice; una parte por anillo, así que `ringAt` es la
  // identidad. El índice del hit se arma sobre estas mismas tablas, y recién cuando la capa interna las
  // aceptó: hasta entonces vale el de las anteriores.
  #draw() {
    const recs = this.#recs
    const zoom = this.#camera.zoom()
    const cap  = this.#layer.maxVertices
    recs.forEach(rec => { rec.wanted = viewSegments(rec, zoom) })
    // Lo que no cabe en la textura baja a la mitad los segmentos de todas, hasta el mínimo, antes de que la
    // capa interna lo rechace: un zoom cercano no puede dejar la capa sin dibujar. `wanted` queda como se
    // pidió, para que `zoomend` compare contra el pedido y no contra el recorte.
    let shift = -1, vertices
    do {
      shift++
      vertices = recs.reduce((sum, rec) => sum + sizeShape(rec, Math.max(MIN_SEGMENTS, rec.wanted >> shift)), 0)
    } while (vertices > cap && recs.some(rec => rec.n > MIN_SEGMENTS))

    const xy       = new Float64Array((vertices + recs.length) * 2)
    const vertexAt = new Uint32Array(recs.length + 1)
    const ringAt   = Uint32Array.from({ length: recs.length + 1 }, (_, k) => k)
    let at = 0
    recs.forEach((rec, k) => {
      const first = at
      at = writeShape(this.#model, rec, xy, at)
      xy[at++] = xy[first]
      xy[at++] = xy[first + 1]
      vertexAt[k + 1] = at / 2
    })
    const tables = {
      xy, vertexAt, ringAt, closed: new Uint8Array(recs.length).fill(1), ringCount: recs.length, partCount: recs.length,
    }
    const drawn = this.#layer.setGeometry(tables)
    this.#index = this.#interactive ? prepareRangeIndex(tables) : null
    return drawn
  }
}
