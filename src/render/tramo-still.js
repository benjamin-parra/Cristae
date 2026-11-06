// La imagen fija de un tramo (K3). Cuando el tramo suelta su contexto por decisión propia —la política lo desaloja por
// cupo o lo deja sin superficie por saturación—, antes de soltarlo compone una vez más y copia esa imagen a un canvas 2D,
// que queda en el lugar del suyo mientras espera: lo GL del tramo no queda en blanco. La copia es síncrona
// (`drawImage` del canvas WebGL en la tarea en que se compuso), porque con `preserveDrawingBuffer: false` el drawing
// buffer ya no vale en otra tarea; `createImageBitmap` es asíncrono y perdería ese cuadro. Una pérdida involuntaria
// (`webglcontextlost`) no copia: con el contexto se fue la imagen.
//
// Mientras espera, la copia sigue a la vista como el reasiento de un canvas: en cada `move` (y `resize`) se traslada lo
// que se movió la vista desde la copia. Un zoom, un cambio de tamaño o un traslado de más de `STILL_MAX_SHIFT` de la vista en un eje
// la quitan: la imagen ya no corresponde. Al volver el contexto, el canvas nuevo del tramo queda oculto bajo la copia
// hasta que el tramo compone con todos sus miembros armados; ahí la copia se quita en esa misma tarea, sin un cuadro
// en blanco ni la mitad del tramo dos veces.

import { frameTransform } from './frame.js'
import { viewTransform } from './gl-compositor.js'
import { readView } from './project.js'

// Cuánto puede trasladarse la vista desde la copia antes de quitarla, como fracción del lado de la vista en cada eje: a
// un cuarto, tres cuartos de la vista siguen cubiertos por lo que se veía.
export const STILL_MAX_SHIFT = 0.25

export const STILL_CLASS = 'cristae-tramo-still'

const SHIFT  = new Float64Array(3)
const newView = () => ({ zoom: 0, center: { x: 0, y: 0 }, size: { x: 0, y: 0 } })

export class TramoStill {

  #camera
  #canvas  = null              // la copia, en el DOM justo después del canvas del tramo
  #covered = null              // el canvas nuevo del tramo, oculto mientras la copia sigue
  #offMove = null
  #offZoom = null
  #view    = newView()         // la vista con que se compuso la copia
  #now     = newView()

  // [0-alloc] salvo las lecturas de la cámara (`frameOrigin`) y el `transform`, como el reasiento del canvas.
  #follow = () => {
    const now  = readView(this.#camera, this.#now)
    const snap = this.#view
    viewTransform(snap, now, 1, SHIFT)
    if (SHIFT[0] !== 1 || now.size.x !== snap.size.x || now.size.y !== snap.size.y
      || Math.abs(SHIFT[1]) > STILL_MAX_SHIFT * now.size.x || Math.abs(SHIFT[2]) > STILL_MAX_SHIFT * now.size.y) return this.clear()
    const p = this.#camera.frameOrigin()
    this.#canvas.style.transform = frameTransform(p.x + SHIFT[1], p.y + SHIFT[2])
  }

  #drop = () => this.clear()

  constructor(camera) {
    this.#camera = camera
  }

  get canvas() { return this.#canvas }

  // Copia `source`, recién compuesto con `view` en esta tarea, y la pone justo después de él, con su tamaño y su ancla.
  // Devuelve si quedó una copia. Corre dentro de `release` de la superficie: si copiar falla (sin 2D, o `drawImage` que
  // lanza), no queda copia y el tramo espera en blanco como sin K3, pero el contexto se suelta igual.
  capture(source, view) {
    this.clear()
    const w = source?.width
    const h = source?.height
    if (!w || !h || !source.parentNode) return false
    const still = source.ownerDocument.createElement('canvas')
    still.width  = w
    still.height = h
    try {
      still.getContext('2d').drawImage(source, 0, 0)
    } catch {
      still.width = still.height = 0
      return false
    }

    still.className           = STILL_CLASS
    still.style.position      = 'absolute'
    still.style.pointerEvents = 'none'
    still.style.width         = source.style.width
    still.style.height        = source.style.height
    still.style.transform     = source.style.transform
    source.after(still)

    const v = this.#view
    v.zoom     = view.zoom
    v.center.x = view.center.x
    v.center.y = view.center.y
    v.size.x   = view.size.x
    v.size.y   = view.size.y
    this.#canvas  = still
    this.#offMove = this.#camera.on('move moveend resize', this.#follow)
    this.#offZoom = this.#camera.on('zoomstart zoomanim', this.#drop)
    return true
  }

  // El tramo volvió a tener contexto en `canvas`, uno nuevo: queda oculto bajo la copia hasta `clear`.
  cover(canvas) {
    if (!this.#canvas || !canvas) return
    this.#covered && this.#covered !== canvas && (this.#covered.style.visibility = '')
    canvas.style.visibility = 'hidden'
    this.#covered = canvas
    this.place(canvas)
  }

  // La copia va justo después del canvas del tramo, que un tramo solo puede mover dentro del pane de su miembro.
  place(canvas) {
    const still = this.#canvas
    still && canvas?.parentNode && canvas.nextSibling !== still && canvas.after(still)
  }

  // Quita la copia —y libera su memoria— y muestra el canvas del tramo que tapaba.
  clear() {
    if (this.#covered) {
      this.#covered.style.visibility = ''
      this.#covered = null
    }
    const still = this.#canvas
    if (!still) return
    this.#canvas = null
    this.#offMove()
    this.#offZoom()
    this.#offMove = this.#offZoom = null
    still.remove()
    still.width = still.height = 0
  }

}
