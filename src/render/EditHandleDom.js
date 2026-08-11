// El vecindario promovido como nodos DOM: a lo sumo TRES —el vértice bajo el cursor y sus dos
// adyacentes—, montados en el pane de edición con los MISMOS píxeles del sprite que la capa de handles
// apaga (`iconSet.sprite`), así el handle bajo el dedo se ve idéntico y deja de existir para la GPU.
//
// `pointer-events: none` y CERO listeners: el gesto lo posee la capa GL, y por eso la ventana de latencia
// del pick asíncrono no hay que administrarla —deja de existir—. Estos nodos son afordancia, nada más.
//
// Los dos midpoints del vecindario también salen de los draws de la capa, pero NO vuelven como nodo: su
// posición deriva del vértice que se arrastra, y ese tramo ya lo dibuja el trazo con la posición viva.
import { ROLE } from '../geometry/ChunkedPath.js'

// prev, v y next: el vecindario entero cabe en tres nodos.
const CAP = 3

// El adyacente conserva su variante de sprite; el promovido toma las dos que la GPU no dibuja.
const VECINO   = 'vertex'
const HOVER    = 'hover'
const GRABBING = 'grabbing'

const CLASE  = 'cristae-edit-handle'
const ORIGIN = [0, 0]                    // esquina del contenedor; reusada porque el reposicionado llega por frame

export class EditHandleDom {

  #L; #map; #pane; #path; #arena; #project; #iconSet; #size

  #nodos    = []                         // ranuras vivas, en orden de trazo
  #refs     = new Int32Array(CAP)
  #count    = 0
  #promoted = -1
  #grabbing = false
  #rev      = -1
  #view     = null
  #lx       = 0                          // la posición VIVA del promovido, en rel-ancla
  #ly       = 0
  #xy       = new Float64Array(2)        // salida de project, reusada [0-alloc]

  constructor({ L, map, pane, path, arena, project, iconSet, size = iconSet.defaultSize }) {
    this.#L       = L
    this.#map     = map
    this.#pane    = map.getPane(pane) ?? map.createPane(pane)
    this.#path    = path
    this.#arena   = arena
    this.#project = project
    this.#iconSet = iconSet
    this.#size    = size
  }

  get promoted() { return this.#promoted }
  get count()    { return this.#nodos.length }

  // El vértice cuyo vecindario toma el banco (-1 = ninguno, y CERO nodos). La posición viva arranca donde
  // está el commit: promover sin mover ya dibuja bien.
  promote(ref) {
    if (ref === this.#promoted) return this
    this.#promoted = ref
    if (ref >= 0) this.#at(this.#arena.relX(ref), this.#arena.relY(ref))
    return this.#renew()
  }

  // El promovido pasa de `hover` a `grabbing` mientras dura el gesto.
  grab(flag = true) {
    if (flag === this.#grabbing) return this
    this.#grabbing = flag
    return this.#renew()
  }

  // La posición viva del promovido, en coordenadas del trazo: el arrastre no escribe al arena, así que el
  // nodo la lee de acá hasta que se commitea al soltar.
  live(x, y) {
    this.#project(x, y, this.#xy)
    const anchor = this.#arena.anchor
    return this.#at(this.#xy[0] - anchor.x, this.#xy[1] - anchor.y)
  }

  // ÚNICO punto de reposicionado, y lo invoca el dueño donde ya reposiciona el resto de la edición.
  // Cualquier escritura del trazo puede mudar de chunk al vecino o estrenarle uno —`setClosed` le da
  // anterior al primer vértice sin tocar la estructura—, así que la revisión que manda es la de escritura.
  layout(view) {
    this.#view = view
    return this.#rev === this.#path.rev ? this.#place() : this.#renew()
  }

  destroy() {
    this.#nodos.forEach(nodo => nodo.el.remove())
    this.#nodos.length = 0
    this.#count        = 0
    this.#promoted     = -1
    this.#view         = null
    return this
  }

  /* ── El vecindario ────────────────────────────────────────────────────────────────────────── */

  // Sale de la LISTA del trazo, nunca de aritmética sobre el ref: en un anillo el anterior del primero es
  // el último. Un anillo de dos los hace coincidir, y ahí el banco monta DOS nodos en vez de apilar uno.
  #renew() {
    const path = this.#path
    const v    = this.#promoted
    this.#rev   = path.rev
    this.#count = 0
    if (path.roleAt(v) === ROLE.vertex) {
      const prev = path.prevVertex(v)
      const next = path.nextVertex(v)
      prev >= 0 && this.#slot(prev)
      this.#slot(v)
      next >= 0 && next !== prev && this.#slot(next)
    }
    this.#reconcile()
    return this.#place()
  }

  #slot(ref) { this.#refs[this.#count++] = ref }

  #at(x, y) {
    this.#lx = x
    this.#ly = y
    return this
  }

  #varianteDe(ref) { return ref !== this.#promoted ? VECINO : this.#grabbing ? GRABBING : HOVER }

  /* ── El banco ─────────────────────────────────────────────────────────────────────────────── */

  // El banco se estira y se encoge con el vecindario: nunca sobra un nodo apagado, así que «cuántos nodos
  // hay» y «cuántos adyacentes tiene el promovido» son el mismo número —y sin promoción, cero—.
  #reconcile() {
    const nodos = this.#nodos
    while (nodos.length > this.#count) nodos.pop().el.remove()
    while (nodos.length < this.#count) nodos.push(this.#nueva())
    for (let i = 0; i < nodos.length; i++) this.#pintar(nodos[i], this.#varianteDe(this.#refs[i]))
  }

  #nueva() {
    const el = document.createElement('canvas')
    const s  = el.style
    el.className    = CLASE
    s.position      = 'absolute'
    s.left          = '0'
    s.top           = '0'
    s.width         = `${this.#size}px`
    s.height        = `${this.#size}px`
    s.marginLeft    = `${-this.#size / 2}px`     // el sprite se centra en su punto, como el iconAnchor de Leaflet
    s.marginTop     = `${-this.#size / 2}px`
    s.pointerEvents = 'none'
    this.#pane.appendChild(el)
    return { el, ctx: el.getContext('2d'), punto: { x: 0, y: 0 }, variante: null }
  }

  // El tile del atlas dibujado 1:1: los MISMOS píxeles que el sprite que la capa apaga.
  #pintar(nodo, variante) {
    if (nodo.variante === variante) return
    nodo.variante = variante
    const tile = this.#iconSet.sprite(variante)
    nodo.el.width  = tile.width               // asignar el tamaño realoca el backing store, y lo limpia de paso
    nodo.el.height = tile.height
    nodo.ctx.drawImage(tile, 0, 0)
  }

  /* ── Vista ────────────────────────────────────────────────────────────────────────────────── */

  // rel-ancla → punto de CAPA: la misma aritmética que `matrixFor` más el origen del contenedor, que es la
  // receta de Leaflet y se resuelve una vez por reposicionado, no por nodo. El promovido lee su posición
  // viva; los adyacentes, la del arena, que es la que dibuja la GPU. Corre por frame de arrastre: [0-alloc].
  #place() {
    const view = this.#view
    const nodos = this.#nodos
    if (!view || !nodos.length) return this
    const scale  = 2 ** view.zoom
    const anchor = this.#arena.anchor
    const origen = this.#map.containerPointToLayerPoint(ORIGIN)
    const ox     = (anchor.x - view.center.x) * scale + view.size.x / 2 + origen.x
    const oy     = (anchor.y - view.center.y) * scale + view.size.y / 2 + origen.y
    for (let i = 0; i < nodos.length; i++) {
      const nodo = nodos[i]
      const ref  = this.#refs[i]
      const vivo = ref === this.#promoted
      nodo.punto.x = ox + (vivo ? this.#lx : this.#arena.relX(ref)) * scale
      nodo.punto.y = oy + (vivo ? this.#ly : this.#arena.relY(ref)) * scale
      this.#L.DomUtil.setPosition(nodo.el, nodo.punto)
    }
    return this
  }
}
