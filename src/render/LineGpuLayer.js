import { EditSurface } from './EditSurface.js'
import { RingStore } from './RingStore.js'
import { StrokePass } from './StrokePass.js'
import { projX0, projY0 } from './project.js'
import { toParts } from '../geometry/polyline.js'

// Líneas ESTÁTICAS con grosor REAL: el trazo sale del mismo `StrokePass` que el contorno de polígonos
// —un quad por segmento, expandido en el vertex shader desde una textura de posiciones— en vez de la
// brocha de glify, que barre la línea `(4w+1)²` veces por feature y por frame.
//
// El perfil es el de una geometría histórica: pocas entidades, muchos vértices, sin feed en vivo. Sin
// picking ni gradiente por vértice — eso vive en el backend glify (`LineLayer`).

const project = (lat, lng, out) => {
  out[0] = projX0(lng)
  out[1] = projY0(lat)
}

const ESTILO = { color: '#3388ff', weight: 3, opacity: 1 }

// Cada PARTE de cada feature es un rango del store. Las partes de un track con baches son tramos
// distintos de la misma entidad: comparten estilo y no se unen entre sí.
const tablasDe = (items, pathOf) => {
  const partes = items.flatMap(item => toParts(pathOf(item)).map(({ path }) => ({ item, path })))
  const total  = partes.reduce((n, { path }) => n + path.length, 0)

  const xy       = new Float64Array(total * 2)
  const vertexAt = new Uint32Array(partes.length + 1)
  let v = 0
  partes.forEach(({ path }, r) => {
    path.forEach(([lat, lng]) => {
      xy[v * 2]     = lng
      xy[v * 2 + 1] = lat
      v++
    })
    vertexAt[r + 1] = v
  })
  return { tablas: { xy, vertexAt, closed: new Uint8Array(partes.length), ringCount: partes.length }, partes }
}

export class LineGpuLayer {

  #map; #surface; #gl; #stroke
  #store   = null
  #onView  = null
  #source  = null
  #styleOf = null
  #base    = ESTILO
  #tramos  = []                       // { arena, estilo } por parte, en orden de dibujo
  #unsub   = null
  #visible = true
  #view    = { zoom: 0, center: { x: 0, y: 0 }, size: { x: 0, y: 0 } }

  constructor({ L, map, pane, source, color, weight, opacity }) {
    this.#map     = map
    this.#source  = source
    this.#styleOf = source?.accessors?.styleOf ?? null
    this.#base    = { ...ESTILO, ...(color && { color }), ...(weight != null && { weight }), ...(opacity != null && { opacity }) }
    this.#surface = new EditSurface({ L, map, pane })
    this.#gl      = this.#surface.attach()
    // La superficie ya tomó uno de los ~16 contextos: lo que siga puede tirar y nadie devuelve uno solo.
    try {
      this.#stroke = new StrokePass({ gl: this.#gl, closed: false })
      this.#ingest(source ? source.getSnapshot() : [])
      this.#onView = () => this.redraw()
      map.on('moveend zoomend resize', this.#onView)
      this.#unsub = source?.subscribe(() => this.#ingest(this.#source.getSnapshot()) || this.redraw())
    } catch (e) {
      this.destroy()
      throw e
    }
  }

  #ingest(items) {
    const { tablas, partes } = tablasDe(items, this.#source.accessors.pathOf)
    const anterior = this.#store
    this.#store = new RingStore({ gl: this.#gl, project, rings: tablas })
    anterior?.destroy()
    this.#tramos = partes.map(({ item }, r) => ({
      arena  : this.#store.viewOf(r),
      estilo : { ...this.#base, ...(this.#styleOf?.(item) ?? null) },
    }))
  }

  #viewport() {
    const c = this.#map.getCenter()
    const s = this.#map.getSize()
    const v = this.#view
    v.zoom     = this.#map.getZoom()
    v.center.x = projX0(c.lng)
    v.center.y = projY0(c.lat)
    v.size.x   = s.x
    v.size.y   = s.y
    return v
  }

  redraw() {
    if (!this.#visible || this.#surface.contextLost) return false
    const gl = this.#gl
    this.#surface.resetCanvasReference()
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT)
    const view = this.#viewport()
    let pintado = false
    for (let k = 0; k < this.#tramos.length; k++) {
      const tramo = this.#tramos[k]
      this.#stroke.style({ color: tramo.estilo.color, width: tramo.estilo.weight, opacity: tramo.estilo.opacity })
      pintado = this.#stroke.draw([tramo], view) || pintado
    }
    return pintado
  }

  resetCanvasReference() { return this.redraw() }

  setVisible(visible) {
    this.#visible = visible
    this.#surface.canvas.style.display = visible ? '' : 'none'
    return visible ? this.redraw() : false
  }

  set(items) {
    this.#ingest(items)
    return this.redraw()
  }

  destroy() {
    this.#unsub?.()
    this.#onView && this.#map.off('moveend zoomend resize', this.#onView)
    this.#stroke?.destroy()
    this.#store?.destroy()
    this.#surface.destroy()
    this.#tramos = []
  }
}
