// Capa de CÍRCULOS en METROS, dibujada en la GPU por el relleno de polígonos: cada círculo es un anillo
// de vértices que se sube a una textura, y el stencil y el trazo los componen. El radio se declara en
// METROS y el círculo CRECE al acercar y ENCOGE al alejar —a diferencia de un sprite de tamaño fijo en
// px, que es el nicho del point-layer—. Su uso: coberturas, radios de acción, tolerancias geográficas;
// cosas cuyo tamaño es una MAGNITUD del mundo, no un adorno de pantalla.
//
// accessors: { idOf, positionOf(item)->{lat,lng}, radiusMetersOf(item)->number, styleOf?(item)->opts }.
// `styleOf` devuelve el vocabulario de la capa de polígonos: color, weight, opacity, fillColor,
// fillOpacity y dash. El estado (posición, radio, estilo) se muta en el ítem y se publica con set/patch
// en la Source; no hay API imperativa de restyle.
//
// El anillo se coloca sobre la MISMA esfera con la que el picking mide: cada vértice está a `radius`
// metros del centro según `arcMeters`, así que el borde dibujado y el hit coinciden por construcción, a
// cualquier latitud. Lo único que los separa es la flecha de la cuerda entre vértices, y la capa elige
// cuántos usa por círculo para que no pase de una fracción de píxel al zoom vigente. Una vista que
// asienta en otro zoom re-tesela sólo si a algún círculo le cambia ese número.
//
// Un cambio del Source rehace las tablas enteras. El store sube su textura completa de todos modos —no
// hay subida parcial—, así que un camino por ids sucios sólo ahorraría la teselación, que con mil
// círculos ronda un frame; y el perfil de la capa son magnitudes que cambian poco, no un feed por frame.
//
// Picking: CPU point-in-circle, kind 'circle', hit de ÁREA (distancePx 0, como polygon). El punto está
// DENTRO si su distancia al centro no pasa del radio. Un círculo que abarca un polo no tiene contorno
// finito en Mercator: se descarta, igual que el de centro o radio no finitos, y no pica.

import { arcMeters, byDefault } from '../geometry/geodesic.js'
import { segmentsFor, viewTolerance } from '../geometry/density.js'
import { reachesPole, readShape, sizeShape, writeShape } from '../geometry/shape.js'
import { PolygonGpuLayer } from './PolygonGpuLayer.js'

// Los segmentos de un círculo a `zoom`: los que mantienen la cuerda a una fracción de píxel del arco.
const segments = ({ lat, a }, zoom) => segmentsFor(a, viewTolerance(lat, a, zoom))

export class CircleLayer {

  #camera; #source; #interactive
  #accessors
  #layer   = null
  #recs    = []       // los círculos válidos: { id, shape, style }, con `shape.n` los segmentos vigentes
  #unsub   = null
  #offZoom = null

  // `host` es el anfitrión del mapa: de él salen la cámara y el pane donde se ancla el canvas.
  constructor({ host, pane, source, interactive = false }) {
    this.#camera      = host.camera
    this.#source      = source
    this.#accessors   = source.accessors
    this.#interactive = interactive
    this.#read()
    this.#layer = new PolygonGpuLayer({
      host, pane, geometry: this.#tables(),
      idOf: k => this.#recs[k].id, styleOf: k => this.#recs[k].style,
    })
    this.#unsub   = source.subscribe(() => this.refresh())
    this.#offZoom = host.camera.on('zoomend', () => this.#retessellate())
  }

  /* ── Lifecycle: la capa se repinta sola en la vista asentada; el motor sólo la refresca y la oculta ── */
  // Los registros y la geometría van juntos: si la capa interna rechaza los nuevos —un patrón que no
  // cabe—, vuelven los de antes, que son los que sigue dibujando.
  refresh() {
    if (!this.#layer) return
    const anterior = this.#recs
    this.#read()
    try {
      this.#layer.setGeometry(this.#tables())
    } catch (e) {
      this.#recs = anterior
      throw e
    }
  }

  setVisible(visible) { this.#layer?.setVisible(visible) }

  destroy() {
    this.#unsub?.()
    this.#offZoom?.()
    this.#layer?.destroy()
    this.#layer = null
    this.#recs  = []
  }

  // Eje focus: atenúa por FEATURE, y el foco lo pliega el estilo de cada anillo.
  applyFocus(ids, dim) {
    this.#layer?.applyFocus(ids, dim)
    return true
  }

  /* ── Picking CPU point-in-circle (kind 'circle'); el registro ordena y envuelve con layerId/z/order ── */
  resolveClick(sample) { return this.#hitsAt(sample) }
  resolveHover(sample) { return this.#hitsAt(sample) }

  // El círculo se dibuja una sola vez, en la copia del mundo de su centro, y el latlng del puntero no se
  // envuelve. La haversine sí es periódica en longitud: sin el corte a media vuelta del centro, el
  // círculo se picaría en las copias vecinas, donde no hay nada dibujado.
  #hitsAt({ lat, lng }) {
    return !this.#interactive ? [] : this.#recs.reduce((out, { id, shape }) => {
      Math.abs(lng - shape.lng) <= 180 && arcMeters(lat, lng, shape.lat, shape.lng) <= shape.a
        && out.push({ ref: id, id, distancePx: 0 })
      return out
    }, [])
  }

  // `readShape` lee la posición como escalares y el estilo se copia acá mismo: `positionOf` y `styleOf`
  // pueden devolver un objeto scratch reusado, y retenerlo apuntaría todas las filas al mismo objeto mutado.
  // El radio tiene que ser un número: `readShape` leería un par como elipse, que esta capa no tesela ni pica.
  #read() {
    const a    = this.#accessors
    const recs = []
    this.#source.getSnapshot().forEach(item => {
      const center = a.positionOf(item), radius = a.radiusMetersOf(item)
      const shape  = typeof radius === 'number' && readShape({ center, radius })
      shape && !reachesPole(shape) && recs.push({ id: a.idOf(item), shape, style: { ...a.styleOf?.(item) } })
    })
    this.#recs = recs
  }

  // Un anillo por círculo, el del escritor de formas sobre la esfera por defecto, que es la de `arcMeters`:
  // parte del norte, sigue el rumbo `i·2π/n` y se cierra repitiendo el primer vértice. Una parte por
  // anillo, así que `ringAt` es la identidad y la parte `k` es el círculo `k`.
  #tables() {
    const recs = this.#recs
    const zoom = this.#camera.zoom()
    let vertices = 0
    recs.forEach(({ shape }) => { vertices += sizeShape(shape, segments(shape, zoom)) + 1 })

    const xy       = new Float64Array(vertices * 2)
    const vertexAt = new Uint32Array(recs.length + 1)
    const ringAt   = Uint32Array.from({ length: recs.length + 1 }, (_, k) => k)
    let at = 0
    recs.forEach(({ shape }, k) => {
      const from = at
      at = writeShape(byDefault, shape, xy, at)
      xy[at++] = xy[from]
      xy[at++] = xy[from + 1]
      vertexAt[k + 1] = at / 2
    })
    return {
      xy, vertexAt, ringAt, closed: new Uint8Array(recs.length).fill(1),
      ringCount: recs.length, partCount: recs.length, owner: ringAt.subarray(0, recs.length),
    }
  }

  // El zoom asentó: se rehace la geometría sólo si algún círculo pide otro número de segmentos.
  #retessellate() {
    const zoom = this.#camera.zoom()
    this.#recs.some(({ shape }) => shape.n !== segments(shape, zoom)) && this.#layer.setGeometry(this.#tables())
  }
}
