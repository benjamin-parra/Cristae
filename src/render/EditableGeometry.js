// Editor de geometría como un <input> CONTROLADO, dibujado sobre la superficie WebGL2 propia de la
// edición: CERO nodos DOM por vértice.
//
// Contrato de "input controlado": el valor ENTRA por `value` (constructor / setValue) y las ediciones
// SALEN por `onChange` (live, cada cambio — incluye cada frame de drag) y `onCommit` (una vez, al asentar
// el gesto: al soltar / edición discreta). Aparte, `onHandleLevel(nivel)` —interno, lo cablea el motor—
// le informa al mapa el nivel de handle bajo el puntero o tomado, sólo al cambiar. La primitiva POSEE los
// handles (vértices, puntos de arista para insertar, borrado por dblclick y el trazado de uno nuevo en
// modo draw) y también el DIBUJO de la geometría: el arrastre muestra sus dos aristas vivas SIN escribir a
// GPU —el vértice viaja como uniform—. Atar además un addPolygonLayer/addLineLayer al mismo `value` es
// válido: dibuja lo mismo.
//
// Cada trazo tiene su stack: `ChunkedPath` (el arena en CPU) → `EditArena` (su espejo GPU) → relleno,
// contorno y handles como sprites, más el banco `EditHandleDom`, que repone como nodo SÓLO el vecindario
// bajo el cursor. El gesto lo posee la capa GL: el pase de picking dice qué handle hay bajo el píxel.
//
// Almacenamiento: polygon y polyline viven en un `ChunkedPath` —el arena—, donde mover un vértice es O(1)
// e insertar o borrar toca UN chunk, no el trazo entero. `point` y `rectangle` guardan su estado en pares
// sueltos y DERIVAN el suyo (un vértice, las cuatro esquinas): así el gesto es uno solo para los cuatro.
//
// Sistema de coordenadas: pares [lat, lng] (la entrada acepta además las otras formas de punto de
// `geometry/polyline.js`; la salida SIEMPRE es [lat, lng]). Una capa atada al mismo `value` lo lee con su
// propio contrato: la de líneas, en las mismas formas; la de polígonos, en pares. Formas por `kind`:
//   · polygon   → rings: anillo simple [[lat,lng],…] o multi-anillo [[[lat,lng],…],…] (sin cerrar: el
//                 primer punto NO se repite al final). La salida conserva la forma de la entrada.
//   · polyline  → path: [[lat,lng],…]
//   · point     → [lat,lng]  (o null mientras no se dibujó)
//   · rectangle → bounds: [[sur,oeste],[norte,este]]  (o null mientras no se dibujó)
import { HANDLE_HELD, HANDLE_NONE, HANDLE_OVER } from '../events/events.js'
import { ChunkedPath, ROLE } from '../geometry/ChunkedPath.js'
import { coordOf, isNested, isPoint } from '../geometry/polyline.js'
import { EditArena } from './EditArena.js'
import { EditFillLayer } from './EditFillLayer.js'
import { defineEditIconSet, editHandleChannels, EditHandleLayer } from './EditHandleLayer.js'
import { EditHandleDom } from './EditHandleDom.js'
import { EditStrokeLayer } from './EditStrokeLayer.js'
import { EditSurface } from './EditSurface.js'
import { Picking } from './Picking.js'
import { pixelScaleOf } from './pixel-scale.js'
import { projX0, projY0, readView } from './project.js'

const MIN_VERTICES = { polygon: 3, polyline: 2 }   // mínimo bajo el cual el borrado por dblclick se ignora
const KINDS        = new Set(['polygon', 'rectangle', 'polyline', 'point'])
const CERRADOS     = new Set(['polygon', 'rectangle'])   // el trazo cierra el anillo, y por eso se rellena
const CRECEN       = new Set(['polygon', 'polyline'])    // la cantidad de vértices la decide el usuario

// Mismas claves que el `styleOf` de `PolygonLayer`/`LineLayer`.
const ESTILO = { color: '#2563eb', weight: 3, fillColor: '#6366f1', fillOpacity: 0.42 }

const PANE  = 'cristae-edit'
const CAPTU = { capture: true }

// Recorrido en px por debajo del cual la pulsación no es un arrastre: la tolerancia de click de
// `L.Draggable`. Sin él el temblor de un click cuenta como edición y asienta.
const UMBRAL = 3

const clonePair = p => [p[0], p[1]]

// Coacción tolerante de la ENTRADA a par, o null si no es un punto (null/undefined, componentes no
// numéricos, no-finitos): garbage-in se descarta, no se propaga. Una latlng viva de Leaflet es un punto
// `{ lat, lng }`.
const toFinitePair = c => (isPoint(c) ? [coordOf(c, 0), coordOf(c, 1)] : null)

const vertexAt = (path, v, p) => v >= 0 && path.xAt(v) === p[0] && path.yAt(v) === p[1]

// Esquinas en orden [SW, NW, NE, SE] a partir de bounds [[sur,oeste],[norte,este]]. La esquina opuesta a
// `i` es (i+2)%4 — la que se mantiene fija al arrastrar `i`.
const rectCorners = ([[s, w], [n, e]]) => [[s, w], [n, w], [n, e], [s, e]]

// El proyector del arena: el mismo EPSG:3857 world0 que el resto del kit, sin pasar por `map.project`
// —que asigna un Point por llamada, y acá se llama por vértice—. [0-alloc]
const project = (lat, lng, out) => {
  out[0] = projX0(lng)
  out[1] = projY0(lat)
}

// El evento que reconoce un handle no sigue viaje: el gesto es NUESTRO.
const consumir = e => {
  e.preventDefault?.()
  e.stopPropagation?.()
}

export class EditableGeometry {

  #host; #camera; #pane; #kind; #onChange; #onCommit; #onHandleLevel; #container; #surface; #gl; #iconSet
  #map                                     // el mapa, para la entrada cruda: clicks, arrastre prestado y controles
  #bajaVista
  #mode       = 'edit'
  #geom       = null                       // representación interna viva (mutada in place por el gesto)
  #simpleRing = true                       // polygon: recordar si la entrada era anillo simple (para la salida)
  #drawAnchor = null                       // rectangle draw: primera esquina fijada por click
  #fill       = null                       // relleno: uno solo, porque el XOR entre anillos es lo que abre el hueco
  #style      = null                       // el vocabulario Leaflet del display que el editor reemplaza
  #paths      = []                         // ChunkedPath por índice de trazo, REUSADOS entre ingestas
  #trazos     = []                         // { orden, path, arena, picking, handles, stroke, bank }

  // Testigo de lo que el pase de picking contestaría en un píxel: sube cuando cambia la geometría, el
  // encuadre o la lista de trazos —lo único que puede volver mentirosa una respuesta ya resuelta—. La
  // promoción NO lo mueve: apaga el VISUAL del vecindario, no lo que el pase contesta.
  #sello = 0

  // El `click` que cierra una pulsación sobre un handle también es del gesto: cancelar su `pointerdown`
  // suprime los eventos de compatibilidad del mouse, no ese click. Lo arma el `pointerdown` que tomó el
  // handle, lo desarma cualquier otro y vale UN click. Sólo cuenta el de un puntero (`detail` ≥ 1), que
  // siempre viene detrás de su `pointerdown`: el de teclado o el de `el.click()` llega con `detail` 0 y
  // pasa aunque un gesto sin click —un arrastre táctil, un pointercancel— haya dejado el testigo armado.
  // Es del gesto aunque `onCommit` saque al editor de edit a mitad de la pulsación (ver `#detachPointer`).
  #clickDelGesto = false

  #informado = HANDLE_NONE                 // el último nivel de handle que recibió `onHandleLevel`

  #hover    = { x: -1, y: -1, trazo: -1, ref: -1, sello: -1 }       // la última respuesta, por píxel
  #muestra  = { id: 0, x: 0, y: 0, trazo: -1, ref: -1, deben: 0 }   // la pedida, y lo que va resolviendo
  // `x`/`y` es el píxel donde se apretó y `dx`/`dy` el offset de agarre: dónde cayó ese píxel DENTRO del
  // handle. El vértice se desplaza lo que se desplaza el puntero, no salta a centrarse bajo él. `puntero`
  // es el que lo tomó: otro que se apoye, se mueva o se levante mientras dura no es del gesto.
  #gesto    = { trazo: null, ref: -1, movido: false, x: 0, y: 0, dx: 0, dy: 0, arrastre: false, puntero: -1 }
  #promo    = { trazo: -1, ref: -1 }
  #vivo     = { ring: 0, vertex: -1, x: 0, y: 0 }             // el vértice en arrastre, en world0 px
  #vista    = { zoom: 0, center: { x: 0, y: 0 }, size: { x: 0, y: 0 }, drag: null }
  #rect     = null                         // caja del contenedor, cacheada: leerla por frame fuerza layout
  #pixel    = new Int32Array(2)
  #xy       = new Float64Array(2)
  #esquinas = new Int32Array(4)            // los cuatro refs del rectángulo, capturados al tomar el gesto
  #punto    = [0, 0]                       // el píxel del arrastre que la cámara convierte, reusado en cada frame
  #esquina  = [0, 0]                       // la esquina que devuelve el arrastre de rectángulo

  // El pane se direcciona por NOMBRE: dos editores sobre el mismo mapa comparten el nodo, y la superficie
  // del anfitrión lo sostiene mientras quede uno.
  constructor({ host, pane, kind = 'polygon', value = null, mode = 'edit', style, onChange, onCommit, onHandleLevel } = {}) {
    if (!KINDS.has(kind)) throw new Error(`EditableGeometry: kind inválido "${kind}"`)
    this.#style         = { ...ESTILO, ...style }
    this.#host          = host
    this.#camera        = host.camera
    this.#map           = host.map
    this.#pane          = pane ?? PANE
    this.#kind          = kind
    this.#onChange      = onChange
    this.#onCommit      = onCommit
    this.#onHandleLevel = onHandleLevel
    this.#container     = host.surface.container
    this.#surface       = new EditSurface({ host, pane: this.#pane })
    this.#gl            = this.#surface.attach()
    this.#iconSet       = defineEditIconSet()
    this.#fill          = CERRADOS.has(kind) ? new EditFillLayer({ gl: this.#gl, rings: this.#trazos, color: this.#style.fillColor, opacity: this.#style.fillOpacity }) : null
    this.#geom          = this.#ingest(value)
    this.#mode          = mode
    this.#bajaVista     = host.camera.on('moveend zoomend resize', this.#onView)
    mode === 'draw' && this.#attachMap()
    mode === 'edit' && this.#attachPointer()
    this.#rebuild()
  }

  /* ── API pública ──────────────────────────────────────────────────────────────────────── */

  // Nuevo valor externo (input controlado): NO emite onChange — es el mundo empujando estado, no una edición.
  // Corta el gesto como los demás cortes de afuera: el ref que el dedo tiene tomado es POSICIONAL, y sobre
  // el valor nuevo direcciona otro vértice.
  setValue(value) {
    this.#releaseInteraction()
    this.#geom = this.#ingest(value)
    this.#drawAnchor = null
    this.#rebuild()
    this.#informar()
  }

  // Fuera de `edit` nadie sigue al puntero, así que lo resuelto bajo él tampoco vale al volver.
  setMode(mode) {
    if (mode === this.#mode) return
    this.#releaseInteraction()
    this.#detachMap()
    this.#detachPointer()
    this.#mode = mode
    this.#drawAnchor = null
    mode === 'draw' && this.#attachMap()
    mode === 'edit' && this.#attachPointer()
    this.#invalidar()
    this.#promover(-1, -1)
    this.#draw()
    this.#informar()
  }

  // Parcial: lo que no venga en `style` queda como estaba.
  setStyle(style) {
    Object.assign(this.#style, style)
    this.#fill?.style({ color: this.#style.fillColor, opacity: this.#style.fillOpacity })
    this.#trazos.forEach(t => t.stroke.style({ width: this.#style.weight, color: this.#style.color }))
    this.#draw()
  }

  getValue() { return this.#serialize() }

  // Los trazos del arena en orden de dibujo: los anillos del polígono, o el path único de la polilínea.
  // Vacío para point y rectangle, cuyo trazo se DERIVA de su estado y no es parte de su valor.
  get paths() {
    if (this.#kind === 'polygon') return [...this.#geom.rings]
    return this.#kind === 'polyline' ? [this.#geom.path] : []
  }

  // Sub-pieza "click en mapa vacío → latlng": expuesta para que el consumidor rutee su propia captura de
  // punto (además de la suscripción nativa a map.on('click') que hace el modo draw). En draw, agrega/coloca.
  handleMapClick(latlng) {
    if (this.#mode !== 'draw' || !latlng) return
    const p = toFinitePair(latlng)
    if (!p) return                                          // garbage-in en el trazado tampoco entra
    if (this.#kind === 'point') {
      this.#geom.pt = p
      this.#refigurar()
      return this.#settle()
    }
    if (this.#kind === 'rectangle') return this.#drawRectClick(p)
    const t    = this.#trazos[0]
    const path = t.path
    // Leaflet dispara un `click` en la MISMA posición junto al `dblclick` de cierre: deduplicarlo acá
    // neutraliza ese click (no se duplica el último punto ni se emite una geometría con uno repetido).
    if (vertexAt(path, path.lastVertex, p)) return
    const estrenaba = !path.length
    path.append(p[0], p[1])
    this.#espejar(t, estrenaba)
    this.#settle()
  }

  destroy() {
    this.#releaseInteraction()
    this.#detachMap()
    this.#detachPointer()
    this.#bajaVista()
    this.#trazos.splice(0).forEach(t => this.#soltar(t))
    this.#fill?.destroy()
    this.#surface.destroy()
    this.#informar()
  }

  /* ── Ingesta / serialización (puras respecto a Leaflet) ─────────────────────────────────── */

  // Ingesta = coacción + saneo: cada coordenada pasa por `toFinitePair` y las inválidas se descartan
  // (garbage-in no corrompe el estado interno ni sale por onChange). point/rectangle degeneran a null si
  // les falta una coordenada finita, y llevan además el trazo que los dibuja.
  #ingest(value) {
    switch (this.#kind) {
      case 'polygon': {
        if (!value?.length) { this.#simpleRing = true; return { rings: [this.#trazo(0, [], true)] } }
        this.#simpleRing = !isNested(value)   // un multi-anillo es un path anidado
        const anillos = this.#simpleRing ? [value] : value
        return { rings: anillos.map((r, i) => this.#trazo(i, r ?? [], true)) }
      }
      case 'polyline': return { path: this.#trazo(0, value ?? [], false) }
      case 'point': {
        const pt = toFinitePair(value)
        return { pt, path: this.#trazo(0, pt ? [pt] : [], false) }
      }
      case 'rectangle': {
        const a = toFinitePair(value?.[0]), b = toFinitePair(value?.[1])
        const bounds = a && b ? [a, b] : null
        return { bounds, path: this.#trazo(0, bounds ? rectCorners(bounds) : [], true) }
      }
    }
  }

  // El `ChunkedPath` del índice `i`, REUSADO entre ingestas: re-ingerirlo en su sitio deja vivo el stack
  // GPU que lo espeja —textura, VBO y programas—, que es lo caro de un `setValue`. Las coordenadas llegan
  // en cualquier iterable, como las de una parte de un path.
  #trazo(i, coords, closed) {
    const pts  = Array.from(coords, toFinitePair).filter(Boolean)
    const path = this.#paths[i]
    if (!path) return (this.#paths[i] = new ChunkedPath({ points: pts, closed }))
    path.setClosed(closed)
    return path.reset(pts)
  }

  // El trazo derivado de una figura de tamaño fijo. Los kinds que crecen no pasan por acá: su trazo ES
  // su valor.
  #figura() {
    if (this.#kind === 'point') return this.#geom.pt ? [this.#geom.pt] : []
    return this.#geom.bounds ? rectCorners(this.#geom.bounds) : []
  }

  #serialize() {
    const g = this.#geom
    switch (this.#kind) {
      case 'polygon': {
        const rings = g.rings.map(r => r.toPairs())
        return this.#simpleRing ? rings[0] : rings
      }
      case 'polyline': return g.path.toPairs()
      case 'point': return g.pt ? clonePair(g.pt) : null
      case 'rectangle': return g.bounds ? g.bounds.map(clonePair) : null
    }
  }

  #leer = () => this.#serialize()          // lector estable: la emisión no serializa hasta que se pide

  #emit()   { this.#onChange?.(this.#leer) }
  #commit() { this.#onCommit?.(this.#leer) }

  // Edición DISCRETA (agregar / borrar / insertar / cerrar / colocar): emite, asienta y suelta la
  // promoción —los refs corrieron, y el vecindario se vuelve a resolver con el próximo hover—. El drag
  // no pasa por acá: emite live y sólo asienta al soltar.
  #settle() {
    this.#invalidar()
    this.#promover(-1, -1)
    this.#emit()
    this.#commit()
    this.#draw()
  }

  // Todo lo resuelto contra el estado anterior deja de valer: la caché por píxel y la muestra que el GPU
  // todavía no contestó. La muestra se descarta y no se corrige — el próximo movimiento del puntero la
  // vuelve a pedir.
  #invalidar() {
    this.#sello++
    this.#muestra.deben = 0
  }

  /* ── Suscripción nativa al mapa (modo draw) ─────────────────────────────────────────────── */
  // map.on/off es API de Leaflet (NO sniffing del DOM). El dblclick CIERRA el trazo (polígono/polilínea):
  // el dedup de handleMapClick ya neutraliza los `click` que Leaflet emite junto al `dblclick`, así que acá
  // sólo se colapsa el duplicado final que se haya colado y se emite SÓLO si de verdad cambió algo.
  #onMapClick    = e => this.handleMapClick(e?.latlng)
  #onMapDblClick = e => {
    if (this.#mode !== 'draw' || !CRECEN.has(this.#kind)) return
    const t    = this.#trazos[0]
    const path = t.path
    if (path.length < 2) return
    const fin = path.lastVertex
    const p   = e?.latlng ? toFinitePair(e.latlng) : [path.xAt(fin), path.yAt(fin)]
    if (!p) return
    const antes     = path.length
    const duplicado = v => vertexAt(path, v, p) && vertexAt(path, path.prevVertex(v), p)
    while (path.length > 1 && duplicado(path.lastVertex)) path.remove(path.lastVertex)
    if (path.length === antes) return
    this.#espejar(t, false)
    this.#settle()
  }
  // El encuadre cambió bajo el puntero: lo que había en un píxel ya no está ahí, y sin un `pointermove`
  // que lo vuelva a resolver el vecindario promovido tampoco corresponde a nada. Un gesto vivo conserva
  // el suyo: su vértice es el que el dedo tiene tomado, no el que haya bajo el cursor.
  #onView = () => {
    this.#rect = null
    this.#invalidar()
    this.#gesto.ref < 0 && this.#promover(-1, -1)
    this.#draw()
    this.#informar()
  }
  #attachMap() { this.#map.on('click', this.#onMapClick); this.#map.on('dblclick', this.#onMapDblClick) }
  #detachMap() { this.#map.off('click', this.#onMapClick); this.#map.off('dblclick', this.#onMapDblClick) }

  /* ── El gesto, que es de la capa GL ─────────────────────────────────────────────────────── */

  // Se escucha en CAPTURA: el evento que reconoce un handle no llega a los handlers de Leaflet —arrastre
  // del mapa, zoom por doble click, click del mapa—, que escuchan en burbuja sobre este mismo contenedor,
  // y no hace falta apagarlos. El arrastre del mapa se toma prestado ADEMÁS mientras dura el gesto, porque
  // el puntero puede salirse del contenedor sin soltarlo (ver `#beginInteraction`). Lo que cae sobre un
  // control —un subárbol que Leaflet declara fuera del mapa con `disableClickPropagation`— es del control
  // aunque tape un handle. `pointerleave` va sin captura: no se consume, y como no burbujea, en captura
  // llegaría también cuando el puntero sale de un descendiente —un control—, que no es salir del mapa.
  #cablear(metodo) {
    const c = this.#container
    c[metodo]('pointermove',   this.#onPointerMove,  CAPTU)
    c[metodo]('pointerup',     this.#onPointerUp,    CAPTU)
    c[metodo]('pointercancel', this.#onPointerUp,    CAPTU)
    c[metodo]('pointerleave',  this.#onPointerLeave)
    c[metodo]('dblclick',      this.#onDblClick,     CAPTU)
  }
  #cablearPulsacion(metodo) {
    this.#container[metodo]('pointerdown', this.#onPointerDown, CAPTU)
    this.#container[metodo]('click',       this.#onClick,       CAPTU)
  }
  #attachPointer() {
    this.#cablear('addEventListener')
    this.#cablearPulsacion('addEventListener')
  }
  // Un `onCommit` a mitad de la pulsación —al soltar un arrastre, o en el `pointerdown` que inserta por un
  // midpoint— puede sacar al editor de edit, y el click que la cierra llega igual. Con el testigo armado,
  // `pointerdown` y `click` siguen escuchando hasta ese click o hasta la próxima pulsación, que ya no lo
  // trae: el primero que llegue los retira.
  #detachPointer() {
    this.#cablear('removeEventListener')
    this.#clickDelGesto || this.#cablearPulsacion('removeEventListener')
  }

  // Hay handles que tomar: en `edit` y con la superficie viva. Un `onCommit` a mitad de pulsación puede
  // haber pasado a draw o destruido el editor.
  get #conHandles() { return this.#mode === 'edit' && this.#surface.attached }

  // Con el gesto vivo, la pulsación es de otro puntero —un segundo dedo— y no toca ni el gesto ni su
  // testigo.
  #onPointerDown = e => {
    if (this.#gesto.ref >= 0) return
    this.#clickDelGesto = false
    if (!this.#conHandles) return this.#cablearPulsacion('removeEventListener')
    if (e.button > 0 || this.#map._isClickDisabled(e.target)) return
    this.#rect = null                      // el gesto se ancla en una caja fresca: un scroll movió la vieja
    const p = this.#puntoDe(e)
    const h = this.#bajoElPixel(p[0], p[1])
    const t = this.#trazos[h.trazo]
    if (!t || h.ref < 0) return
    const rol = t.path.roleAt(h.ref)
    this.#clickDelGesto = true
    consumir(e)
    // El dueño del midpoint es el vértice de la entrada anterior: describe el segmento que ARRANCA en él.
    // Insertar asienta ACÁ, antes de tomar el gesto: un `onCommit` que pasó a draw o destruyó el editor ya
    // no oye el `pointerup` que devolvería el arrastre del mapa, así que el gesto no empieza.
    const ref = rol === ROLE.midpoint ? this.#onMidInsert(t, h.ref - 1) : rol === ROLE.vertex ? h.ref : -1
    ref >= 0 && this.#conHandles && this.#beginInteraction(t, ref, e, p)
  }

  #onPointerMove = e => {
    const p = this.#puntoDe(e)
    if (this.#gesto.ref >= 0) return e.pointerId === this.#gesto.puntero && this.#arrastrar(p[0], p[1])
    this.#cobrar()
    this.#pedir(p[0], p[1])
  }

  #onPointerUp = e => {
    if (this.#gesto.ref < 0 || e.pointerId !== this.#gesto.puntero) return
    consumir(e)
    this.#endInteraction(this.#puntoDe(e))
  }

  // El puntero se fue del contenedor: no va a llegar otro `pointermove` que despromueva, así que el
  // vecindario —tres nodos y el agujero que abren en el visual— se suelta acá o queda encendido con el
  // cursor en otra parte de la pantalla. Con el gesto vivo no aplica: el puntero está capturado.
  #onPointerLeave = () => {
    if (this.#gesto.ref >= 0) return
    this.#invalidar()
    this.#promover(-1, -1) && this.#draw()
    this.#informar()
  }

  #onClick = e => {
    if (!this.#clickDelGesto || !e.detail) return
    this.#clickDelGesto = false
    consumir(e)
    this.#conHandles || this.#cablearPulsacion('removeEventListener')
  }

  // El evento se consume sólo si de verdad borró: sobre un kind que no baja de vértices, el doble click
  // sigue siendo del mapa.
  #onDblClick = e => {
    if (this.#map._isClickDisabled(e.target)) return
    const p = this.#puntoDe(e)
    const h = this.#bajoElPixel(p[0], p[1])
    const t = this.#trazos[h.trazo]
    if (!t || t.path.roleAt(h.ref) !== ROLE.vertex) return
    this.#onVertexDelete(t, h.ref) && consumir(e)
    this.#informar()
  }

  // El píxel del contenedor. La caja se cachea: leerla por `pointermove` fuerza un layout, que es
  // justamente el costo que este remake existe para no pagar; la vista que cambia la invalida.
  #puntoDe(e) {
    const r = this.#rect ??= this.#container.getBoundingClientRect()
    const p = this.#pixel
    p[0] = Math.round(e.clientX - r.left)
    p[1] = Math.round(e.clientY - r.top)
    return p
  }

  // El handle bajo el píxel: la última respuesta si sigue valiendo —mismo píxel y mismo sello, el caso
  // común y sin stall de GPU—, y si no un pick SÍNCRONO, el único que contesta dentro del gesto (y el
  // único camino del touch, que no tiene hover previo).
  #bajoElPixel(x, y) {
    this.#cobrar()
    const h = this.#hover
    return h.x === x && h.y === y && h.sello === this.#sello ? h : this.#resolver(x, y)
  }

  // La caché por píxel, sellada con el testigo vigente. La escriben el pick síncrono, el hover ya cobrado
  // y las ediciones que SABEN qué dejaron bajo el cursor.
  #cachear(trazo, ref, x, y) {
    const h = this.#hover
    h.x     = x
    h.y     = y
    h.trazo = trazo
    h.ref   = ref
    h.sello = this.#sello
    this.#informar()
    return h
  }

  // El primer trazo que reconoce el píxel se queda con el impacto: cada anillo tiene su propio pase, y
  // el ref sale del mismo barrido.
  #resolver(x, y) {
    let ref     = -1
    const trazo = this.#trazos.findIndex(t => (ref = t.handles.pickRef(x, y)) >= 0)
    return this.#cachear(trazo, trazo < 0 ? -1 : ref, x, y)
  }

  // Hover: el pase NO bloquea. La muestra lleva un serial y queda resuelta cuando todos los trazos
  // contestaron; una respuesta vieja no lo trae y se descarta sola. [0-alloc]: corre por muestra del
  // puntero, también cuando no hay nada bajo el cursor —que es el caso común sobre el mapa—.
  #pedir(x, y) {
    const m      = this.#muestra
    const trazos = this.#trazos
    m.id++
    m.x     = x
    m.y     = y
    m.ref   = -1
    m.trazo = -1
    m.deben = 0
    for (let i = 0; i < trazos.length; i++)
      if (trazos[i].handles.requestPick(x, y, m.id)) m.deben++
  }

  // Cobra lo que el GPU ya haya contestado. Sin rAF ni polling: la próxima muestra del puntero es el
  // reloj, y una muestra que nadie llegó a cobrar sólo cuesta un pick síncrono en el `pointerdown`.
  #cobrar() {
    const m = this.#muestra
    if (!m.deben) return
    this.#trazos.forEach((t, i) => {
      const got = t.handles.collectPick()
      if (got?.metadata !== m.id) return
      m.deben--
      if (m.ref < 0 && got.ref >= 0) {
        m.ref   = got.ref
        m.trazo = i
      }
    })
    m.deben || this.#fijar(m)
  }

  // La muestra pasa a caché y su vértice al vecindario promovido. Un midpoint no promueve: el banco y la
  // capa sólo abren vecindario alrededor de un vértice.
  #fijar(m) {
    this.#cachear(m.trazo, m.ref, m.x, m.y)
    const vertice = this.#trazos[m.trazo]?.path.roleAt(m.ref) === ROLE.vertex
    this.#promover(m.trazo, vertice ? m.ref : -1) && this.#draw()
  }

  // El vecindario bajo el cursor, en UNA llamada: la capa le abre el agujero al mismo vértice al que el
  // banco le pone nodo y el contorno le saca sus dos segmentos del pase estático, así no se pueden
  // desincronizar. Devuelve si algo cambió.
  #promover(i, ref) {
    const p     = this.#promo
    const trazo = ref < 0 ? -1 : i
    if (p.trazo === trazo && p.ref === ref) return false
    p.trazo = trazo
    p.ref   = ref
    this.#trazos.forEach((t, k) => {
      const v = k === trazo ? ref : -1
      t.handles.promote(v)
      t.stroke.promote(v)
      t.bank.promote(v)
    })
    return true
  }

  // El nivel de handle que ve el mapa sale del estado mismo —el gesto, y la última respuesta bajo el
  // puntero mientras haya handles que tomar—, pero no se recalcula solo: lo llaman `#cachear` y cada
  // entrada de `edit` que mueva el gesto, el sello, el modo o la superficie. Las de draw no, porque ahí es
  // NONE por construcción. Se informa sólo al cambiar.
  #informar() {
    const h     = this.#hover
    const nivel = this.#gesto.ref >= 0 ? HANDLE_HELD
      : this.#conHandles && h.sello === this.#sello && h.ref >= 0 ? HANDLE_OVER
      : HANDLE_NONE
    if (nivel === this.#informado) return
    this.#informado = nivel
    this.#onHandleLevel?.(nivel)
  }

  // El gesto empieza: el vecindario pasa a `grabbing` y el mapa presta el arrastre —el puntero es nuestro
  // hasta que se levante, y la captura la devuelve el navegador tras despachar el `pointerup`—. Sólo se
  // toma prestado lo que estaba prendido: un mapa que el consumidor tenía fijo no se puede «devolver».
  // El offset de agarre se mide UNA vez, acá: es el único punto donde el vértice todavía está donde lo
  // agarraron.
  #beginInteraction(t, ref, e, p) {
    const g = this.#gesto
    const c = this.#camera.toContainer([t.path.xAt(ref), t.path.yAt(ref)])
    this.#promover(t.orden, ref)
    g.trazo    = t
    g.ref      = ref
    g.movido   = false
    g.x        = p[0]
    g.y        = p[1]
    g.dx       = c.x - p[0]
    g.dy       = c.y - p[1]
    g.arrastre = this.#map.dragging?.enabled?.() ?? false
    g.puntero  = e.pointerId
    this.#kind === 'rectangle' && this.#capturarEsquinas(t.path)
    t.bank.grab(true)
    g.arrastre && this.#map.dragging.disable()
    this.#container.setPointerCapture?.(e.pointerId)
    this.#draw()
    this.#informar()
  }

  // Los cuatro refs del rectángulo: son estables durante todo el gesto, y releerlos por frame arma un
  // array por vuelta en la ruta [0-alloc].
  #capturarEsquinas(path) {
    const e = this.#esquinas
    let ref = path.firstVertex
    for (let k = 0; k < 4; k++) {
      e[k] = ref
      ref  = path.nextVertex(ref)
    }
  }

  // Suelta el puntero SIN asentar y devuelve lo que el gesto tenía tomado (null si no había ninguno). Es
  // el camino de los cortes de AFUERA —`destroy` / `setMode` / `setValue`—, así que pone el espejo GPU al
  // día: el arrastre dejó el arena atrás y el valor ya salió por `onChange`.
  #releaseInteraction() {
    const g = this.#gesto
    if (g.ref < 0) return null
    const tomado = { t: g.trazo, ref: g.ref, movido: g.movido }
    const presto = g.arrastre
    g.trazo    = null
    g.ref      = -1
    g.movido   = false
    g.arrastre = false
    if (tomado.movido) {
      this.#invalidar()
      tomado.t.arena.writeEntry(tomado.ref)
    }
    tomado.t.bank.grab(false)
    presto && this.#map.dragging?.enable()
    return tomado
  }

  // El gesto termina: asienta y deja la caché apuntando al vértice soltado, que sigue bajo el cursor —y que
  // el pase sigue reconociendo, aunque el visual lo tenga apagado bajo su nodo—. Sin movimiento no hubo
  // edición: las dos pulsaciones de un doble click no pueden pasar por acá como si lo hubieran sido.
  #endInteraction(p) {
    const { t, ref, movido } = this.#releaseInteraction()
    movido && this.#commit()
    this.#cachear(t.orden, ref, p[0], p[1])
    this.#promover(-1, -1)
    this.#draw()
  }

  /* ── Ediciones ──────────────────────────────────────────────────────────────────────────── */

  // Un frame del gesto: el trazo recibe la posición nueva —cada `kind` con su regla— y las capas la
  // muestran como uniform, sin escribir a GPU. El arena queda atrás a propósito: se pone al día al soltar.
  // Hasta que el puntero supera la tolerancia de click no hay arrastre: una pulsación quieta no edita.
  // El vértice va al puntero MÁS el offset de agarre, como `L.Draggable`: agarrarlo por el borde no lo
  // teletransporta a centrarse bajo el cursor.
  #arrastrar(x, y) {
    const g = this.#gesto
    if (!g.movido && Math.abs(x - g.x) + Math.abs(y - g.y) < UMBRAL) return
    const c = this.#punto
    c[0] = x + g.dx
    c[1] = y + g.dy
    const p = toFinitePair(this.#camera.fromContainer(c))
    const q = p && this.#mover(g.trazo, g.ref, p)
    if (!q) return
    g.movido = true
    this.#vivir(g.trazo, g.ref, q)
    this.#emit()
    this.#draw()
  }

  // La regla de arrastre de cada `kind`, con la posición que le queda al ref arrastrado (o null si no se
  // movió nada): polígono y polilínea mueven su vértice y el punto es su único vértice.
  #mover(t, ref, p) {
    if (this.#kind === 'rectangle') return this.#moverEsquina(t, ref, p)
    if (!t.path.moveVertex(ref, p[0], p[1])) return null
    this.#kind === 'point' && (this.#geom.pt = p)
    return p
  }

  // Arrastre de esquina de rectángulo: la esquina opuesta queda fija y el bounds se recompone por min/max
  // (se mantiene alineado a ejes). Las otras tres se mueven con ella, así que acá SÍ se escribe al espejo:
  // el estado entero del rectángulo son cuatro entradas, y no hay uniform que valga por tres. Corre por
  // frame de arrastre: el bounds se muta en su sitio y las esquinas se leen de él —el orden [SW,NW,NE,SE]
  // toma el sur en las dos de abajo y el oeste en las dos de la izquierda—, sin rearmarlas. [0-alloc]
  #moverEsquina(t, ref, p) {
    const path = t.path
    const es   = this.#esquinas
    const b    = this.#geom.bounds
    const i    = b ? es.indexOf(ref) : -1
    if (i < 0) return null
    const o = es[(i + 2) % 4]
    b[0][0] = Math.min(p[0], path.xAt(o))
    b[0][1] = Math.min(p[1], path.yAt(o))
    b[1][0] = Math.max(p[0], path.xAt(o))
    b[1][1] = Math.max(p[1], path.yAt(o))
    const q = this.#esquina
    for (let k = 0; k < 4; k++) {
      const lat = b[k && k < 3 ? 1 : 0][0]
      const lng = b[k < 2 ? 0 : 1][1]
      path.moveVertex(es[k], lat, lng)
      t.arena.writeEntry(es[k])
      if (k !== i) continue
      q[0] = lat
      q[1] = lng
    }
    return q
  }

  // La posición VIVA del vértice en las tres capas: el contorno y el banco la reciben en coordenadas del
  // trazo y el relleno en world0 px — cada uno le resta el ancla de SU arena.
  #vivir(t, ref, p) {
    const v = this.#vivo
    project(p[0], p[1], this.#xy)
    t.stroke.live(p[0], p[1])
    t.bank.live(p[0], p[1])
    v.ring   = t.orden
    v.vertex = ref
    v.x      = this.#xy[0]
    v.y      = this.#xy[1]
  }

  // Borrar e insertar son de los kinds que CRECEN: el rectángulo tiene cuatro esquinas siempre y el punto
  // una, y esa invariante no puede depender de que su midpoint salga transparente del pase. Tampoco se
  // baja del mínimo topológico. Devuelven si editaron, que es lo que decide consumir el evento.
  #onVertexDelete(t, ref) {
    if (!CRECEN.has(this.#kind) || t.path.length <= MIN_VERTICES[this.#kind]) return false
    if (!t.path.remove(ref)) return false
    this.#espejar(t, false)
    this.#settle()
    return true
  }

  // Insertar vértice en el midpoint del segmento que ARRANCA en `ref` (promueve el punto de arista a
  // vértice real) y devolver su ref, o -1 si el kind no crece. El vértice nuevo nace donde estaba el
  // midpoint —bajo el cursor—, así que la caché pasa a apuntarlo: la pulsación siguiente sobre el mismo
  // píxel lo agarra a él y no vuelve a insertar.
  #onMidInsert(t, ref) {
    if (!CRECEN.has(this.#kind)) return -1
    const mid   = t.path.midOf(ref)
    const nuevo = t.path.insertAfter(ref, t.path.xAt(mid), t.path.yAt(mid))
    if (nuevo < 0) return -1
    this.#espejar(t, false)
    this.#settle()
    const h = this.#hover
    this.#cachear(t.orden, nuevo, h.x, h.y)
    return nuevo
  }

  // Trazado de rectángulo: primer click fija una esquina; el segundo cierra el bounds contra ella.
  #drawRectClick(p) {
    if (!this.#drawAnchor) { this.#drawAnchor = p; return }
    const a = this.#drawAnchor
    this.#geom.bounds = [
      [Math.min(a[0], p[0]), Math.min(a[1], p[1])],
      [Math.max(a[0], p[0]), Math.max(a[1], p[1])],
    ]
    this.#drawAnchor = null
    this.#refigurar()
    this.#settle()
  }

  /* ── El espejo GPU ──────────────────────────────────────────────────────────────────────── */

  // El espejo tras una edición ESTRUCTURAL. Re-ingiere —y con eso vuelve a congelar el ancla— cuando el
  // trazo estrenó contenido: un ancla congelada sobre un trazo vacío no acota nada, y de ahí sale la
  // precisión de float32. Si no, sube sólo los chunks que se movieron.
  #espejar(t, reingesta) { reingesta ? t.arena.reset() : t.arena.syncStructure() }

  // point y rectangle DERIVAN su trazo de su estado y se re-ingieren enteros: en una figura de tamaño
  // fijo eso cuesta lo mismo que actualizarla, y les evita un camino de edición propio.
  #refigurar() {
    this.#geom.path = this.#trazo(0, this.#figura(), CERRADOS.has(this.#kind))
    this.#trazos[0].arena.reset()
  }

  #dibujables() { return this.#kind === 'polygon' ? this.#geom.rings : [this.#geom.path] }

  // Recablea el espejo a los trazos vigentes: los que sobreviven re-ingieren su arena —el `ChunkedPath`
  // es el MISMO objeto, así que textura, VBO y programas siguen vivos—, los nuevos estrenan stack y los
  // que sobran se sueltan. `#fill` lee la MISMA lista, así que no hace falta reasignársela.
  #rebuild() {
    const paths = this.#dibujables()
    this.#invalidar()
    this.#trazos.splice(paths.length).forEach(t => this.#soltar(t))
    paths.forEach((path, i) => this.#trazos[i]?.arena.reset() ?? (this.#trazos[i] = this.#montar(path, i)))
    this.#promover(-1, -1)
    this.#draw()
  }

  // Un trazo en GPU: el espejo del arena, su contorno, sus handles como sprites y el banco de nodos que
  // repone el vecindario bajo el cursor. El objeto de picking es el orden + 1 — el pase descarta el 0.
  #montar(path, orden) {
    const gl      = this.#gl
    const iconSet = this.#iconSet
    const arena   = new EditArena({ gl, path, project, ...this.#canales() })
    const picking = new Picking()
    const handles = new EditHandleLayer({ gl, arena, path, picking, iconSet })
    handles.pickObject = orden + 1
    return {
      orden, path, arena, picking, handles,
      stroke : new EditStrokeLayer({ gl, arena, path, project, width: this.#style.weight, color: this.#style.color }),
      bank   : new EditHandleDom({ host: this.#host, pane: this.#pane, path, arena, project, iconSet }),
    }
  }

  #soltar(t) {
    t.bank.destroy()
    t.handles.destroy()
    t.stroke.destroy()
    t.arena.destroy()
    t.picking.detach()
  }

  // Canales del arena por rol. El kind que NO inserta vértices manda sus midpoints al tile transparente,
  // que los saca del visual y del picking a la vez — sin una excepción en el gesto.
  #canales() {
    const { tiles, sizes } = editHandleChannels(this.#iconSet, pixelScaleOf(this.#gl))
    return CRECEN.has(this.#kind) ? { tiles, sizes } : { tiles: [tiles[0], tiles[1], tiles[0]], sizes }
  }

  /* ── Frame ──────────────────────────────────────────────────────────────────────────────── */

  // Un frame de la sesión. Sin rAF: lo llama quien cambió algo —una edición, un frame del gesto o un
  // movimiento del mapa—. Los contornos van TODOS antes que los handles: si no, el trazo de un anillo
  // taparía el handle del anterior.
  #draw() {
    const gl = this.#gl
    if (!this.#surface.attached || this.#surface.contextLost) return
    this.#surface.resetCanvasReference()
    // El encuadre que leen las tres capas, con el vértice que arrastra el gesto.
    const vista = readView(this.#camera, this.#vista)
    vista.drag  = this.#gesto.movido ? this.#vivo : null
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT)
    this.#fill?.draw(vista)
    this.#trazos.forEach(t => t.stroke.draw(vista))
    if (this.#mode !== 'edit') return
    this.#trazos.forEach(t => {
      t.handles.draw(vista)
      t.bank.layout(vista)
    })
  }
}
