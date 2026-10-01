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

import { MEAN_RADIUS, arcMeters } from '../geometry/geodesic.js'
import { PolygonGpuLayer } from './PolygonGpuLayer.js'

const D             = Math.PI / 180
const TAU           = 2 * Math.PI
const WORLD_PER_RAD = 256 / TAU      // píxeles world0 por radián de longitud, en el ecuador

// Cuánto se puede apartar la cuerda del arco, en píxeles de pantalla, y los límites de la teselación.
// El número de segmentos es potencia de dos para que un zoom que no cruce una potencia no re-tesele.
const SAGITTA_PX   = 0.2
const MIN_SEGMENTS = 16
const MAX_SEGMENTS = 4096

// Segmentos que mantienen la flecha de la cuerda bajo `SAGITTA_PX` a `zoom`. El radio en píxeles se
// acota con la escala de Mercator de la latitud más alta del círculo, que es la mayor de las que toca.
const segmentsFor = ({ lat, radius }, zoom) => {
  const delta  = radius / MEAN_RADIUS
  const pixels = delta * WORLD_PER_RAD * 2 ** zoom / Math.cos(Math.abs(lat) * D + delta)
  const need   = Math.PI / Math.acos(Math.max(-1, 1 - SAGITTA_PX / pixels))
  return Math.min(MAX_SEGMENTS, Math.max(MIN_SEGMENTS, 2 ** Math.ceil(Math.log2(need))))
}

export class CircleLayer {

  #camera; #source; #interactive
  #accessors
  #layer   = null
  #recs    = []       // los círculos válidos: { id, lat, lng, radius, style, n } con `n` los segmentos vigentes
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
    return !this.#interactive ? [] : this.#recs.reduce((out, rec) => {
      Math.abs(lng - rec.lng) <= 180 && arcMeters(lat, lng, rec.lat, rec.lng) <= rec.radius
        && out.push({ ref: rec.id, id: rec.id, distancePx: 0 })
      return out
    }, [])
  }

  // Se leen lat/lng como escalares y se copia el estilo acá mismo: `positionOf` y `styleOf` pueden
  // devolver un objeto scratch reusado, y retenerlo apuntaría todas las filas al mismo objeto mutado.
  #read() {
    const a    = this.#accessors
    const recs = []
    this.#source.getSnapshot().forEach(item => {
      const pos = a.positionOf(item), radius = a.radiusMetersOf(item)
      const lat = pos?.lat, lng = pos?.lng
      Number.isFinite(lat) && Number.isFinite(lng) && Number.isFinite(radius) && radius > 0
        && Math.abs(lat) * D + radius / MEAN_RADIUS < Math.PI / 2
        && recs.push({ id: a.idOf(item), lat, lng, radius, style: { ...a.styleOf?.(item) }, n: 0 })
    })
    this.#recs = recs
  }

  // Un anillo por círculo, cerrado repitiendo el primer vértice, que es el del norte: de ahí los demás
  // siguen el rumbo `i·2π/n`. Cada uno es el destino directo sobre la esfera de `arcMeters` —`radius`
  // metros desde el centro, a ese rumbo—, y su longitud sigue a la del centro sin envolverse. Una parte
  // por anillo, así que `ringAt` es la identidad y la parte `k` es el círculo `k`.
  #tables() {
    const recs = this.#recs
    const zoom = this.#camera.zoom()
    let vertices = 0
    recs.forEach(rec => { vertices += (rec.n = segmentsFor(rec, zoom)) + 1 })

    const xy       = new Float64Array(vertices * 2)
    const vertexAt = new Uint32Array(recs.length + 1)
    const ringAt   = Uint32Array.from({ length: recs.length + 1 }, (_, k) => k)
    let at = 0
    recs.forEach(({ lat, lng, radius, n }, k) => {
      const sinLat = Math.sin(lat * D), cosLat = Math.cos(lat * D)
      const sinD   = Math.sin(radius / MEAN_RADIUS), cosD = Math.cos(radius / MEAN_RADIUS)
      for (let i = 0; i <= n; i++) {
        const bearing = (i < n ? i : 0) * TAU / n
        const sinOut  = sinLat * cosD + cosLat * sinD * Math.cos(bearing)
        xy[at++] = lng + Math.atan2(Math.sin(bearing) * sinD * cosLat, cosD - sinLat * sinOut) / D
        xy[at++] = Math.asin(sinOut) / D
      }
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
    this.#recs.some(rec => rec.n !== segmentsFor(rec, zoom)) && this.#layer.setGeometry(this.#tables())
  }
}
