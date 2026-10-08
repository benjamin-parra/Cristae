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
// Cada trazo tiene su stack: `ChunkedPath` (el arena en CPU) → `EditArena` (su espejo GPU) → handles como
// sprites, más el banco `EditHandleDom`, que repone como nodo SÓLO el vecindario bajo el cursor. El gesto
// lo posee la capa GL: el pase de picking dice qué handle hay bajo el píxel. Lo que se DIBUJA —relleno y
// contorno— vive aparte, en el contorno de cada trazo, que comparte con él path y arena: por eso el vértice
// del arrastre le llega como uniform, sin escribir a GPU. Con curva (`setCurve`), el contorno de polygon y
// polyline se deriva de su path, con cada tramo partido sobre la geodésica, y el midpoint de sus manijas
// cae sobre ella.
//
// Almacenamiento: polygon y polyline viven en un `ChunkedPath` —el arena—, donde mover un vértice es O(1)
// e insertar o borrar toca UN chunk, no el trazo entero. `point` y `rectangle` guardan su estado en pares
// sueltos y DERIVAN el suyo (un vértice, las cuatro esquinas): así el gesto es uno solo para todos. Las
// formas —circle, ellipse y sector— guardan la forma, y de ella derivan dos trazos: sus manijas, que se
// pican, y su anillo, que es lo único que se dibuja. Las reglas de cada una viven en `editShapes.js`.
//
// `mode: 'freehand'` es el tercer valor de polygon y polyline: el dedo traza y el editor no tiene manijas.
// El trazo vive en `#mano` como muestras lat/lng, se dibuja sobre el trazo del editor mientras dura, y al
// soltar se hornea (`geometry/freehand.js`) y asienta como una edición discreta.
//
// Sistema de coordenadas: pares [lat, lng] (la entrada acepta además las otras formas de punto de
// `data/path.js`; la salida SIEMPRE es [lat, lng]). Una capa atada al mismo `value` lo lee con su
// propio contrato: la de líneas, en las mismas formas; la de polígonos, en pares. Formas por `kind`:
//   · polygon   → rings: anillo simple [[lat,lng],…] o multi-anillo [[[lat,lng],…],…] (sin cerrar: el
//                 primer punto NO se repite al final). La salida conserva la forma de la entrada.
//   · polyline  → path: [[lat,lng],…]
//   · point     → [lat,lng]  (o null mientras no se dibujó)
//   · rectangle → bounds: [[sur,oeste],[norte,este]]  (o null mientras no se dibujó)
//   · circle    → { center, radius }                  (o null mientras no se dibujó)
//   · ellipse   → { center, radius: [a, b], heading }
//   · sector    → { center, radius, heading, sweep }
import { CLICK_TOLERANCE, HANDLE_HELD, HANDLE_NONE, HANDLE_OVER } from '../events/events.js'
import { ChunkedPath, ROLE } from '../geometry/ChunkedPath.js'
import { coordOf, isNested, isPoint } from '../data/path.js'
import { at, count } from '../geometry/curve.js'
import { pixelsToMeters } from '../geometry/density.js'
import { bake } from '../geometry/freehand.js'
import { byDefault } from '../geometry/geodesic.js'
import { pairs, sizeShape, viewSegments, writeShape } from '../geometry/shape.js'
import { SHAPES } from './editShapes.js'
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
const KINDS        = new Set(['polygon', 'rectangle', 'polyline', 'point', ...Object.keys(SHAPES)])
const CERRADOS     = new Set(['polygon', 'rectangle', ...Object.keys(SHAPES)])   // el trazo cierra el anillo, y por eso se rellena
const CRECEN       = new Set(['polygon', 'polyline'])    // la cantidad de vértices la decide el usuario
const D            = Math.PI / 180
const SEPARACION   = 24   // px: lo menos que una manija de forma se acerca a otra, dos veces su diámetro
const PASO         = 4    // px entre muestras del trazo a mano alzada: supera CLICK_TOLERANCE, y un toque quieto no suma
const TEMBLOR      = 10   // px, en |dx| + |dy|, que se mueve un dedo que toca sin arrastrar

// Mismas claves que el `styleOf` de los polígonos y las líneas.
const ESTILO = { color: '#2563eb', weight: 3, fillColor: '#6366f1', fillOpacity: 0.42 }

const PANE = 'cristae-edit'

const clonePair = p => [p[0], p[1]]

// Coacción tolerante de la ENTRADA a par, o null si no es un punto (null/undefined, componentes no
// numéricos, no-finitos): garbage-in se descarta, no se propaga. Una latlng viva de Leaflet es un punto
// `{ lat, lng }`.
const toFinitePair = c => (isPoint(c) ? [coordOf(c, 0), coordOf(c, 1)] : null)

const vertexAt = (path, v, p) => v >= 0 && path.xAt(v) === p[0] && path.yAt(v) === p[1]

// Esquinas en orden [SW, NW, NE, SE] a partir de bounds [[sur,oeste],[norte,este]]. La esquina opuesta a
// `i` es (i+2)%4 — la que se mantiene fija al arrastrar `i`.
const rectCorners = ([[s, w], [n, e]]) => [[s, w], [n, w], [n, e], [s, e]]

// El bounds que cierran dos esquinas opuestas cualesquiera.
const caja = (a, p) => [[Math.min(a[0], p[0]), Math.min(a[1], p[1])], [Math.max(a[0], p[0]), Math.max(a[1], p[1])]]

// El proyector del arena: el mismo EPSG:3857 world0 que el resto del kit, sin pasar por `map.project`
// —que asigna un Point por llamada, y acá se llama por vértice—. [0-alloc]
const project = (lat, lng, out) => {
  out[0] = projX0(lng)
  out[1] = projY0(lat)
}

export class EditableGeometry {

  #host; #camera; #pane; #kind; #model; #forma; #onChange; #onCommit; #onHandleLevel; #surface; #gl; #iconSet
  #bajaVista; #bajaPausa; #bajaCuadro
  #salir                                   // la baja de la puerta del puntero
  #mode       = 'edit'
  #geom       = null                       // representación interna viva (mutada in place por el gesto)
  #simpleRing = true                       // polygon: recordar si la entrada era anillo simple (para la salida)
  #borrador   = null                       // draw: la primera esquina del rectángulo, o la forma a medio trazar
  #paso       = 0                          // draw de una forma: la manija que pone el próximo click
  #perimetro  = null                       // las formas: el anillo que se dibuja, derivado de la forma
  #anillo     = new Float64Array(0)        // ese anillo como [lng, lat, …], reusado entre frames
  #manijas    = null                       // las manijas de la forma, ídem
  #curva      = null                       // polygon y polyline: el modelo de la geodésica que dibujan, o null
  #medio      = null                       // el midpoint de sus manijas sobre esa geodésica
  #fill       = null                       // relleno: uno solo, porque el XOR entre anillos es lo que abre el hueco
  #style      = null                       // el vocabulario Leaflet del display que el editor reemplaza
  #paths      = []                         // ChunkedPath por índice de trazo, REUSADOS entre ingestas
  #trazos     = []                         // lo que se pica: { orden, path, arena, picking, handles, bank, contorno }
  #contornos  = []                         // lo que se dibuja, uno por trazo: { path, arena, stroke }

  // Testigo de lo que el pase de picking contestaría en un píxel: sube cuando cambia la geometría, el
  // encuadre o la lista de trazos —lo único que puede volver mentirosa una respuesta ya resuelta—. La
  // promoción NO lo mueve: apaga el VISUAL del vecindario, no lo que el pase contesta.
  #sello = 0

  #informado = HANDLE_NONE                 // el último nivel de handle que recibió `onHandleLevel`

  #hover    = { x: -1, y: -1, trazo: -1, ref: -1, sello: -1 }       // la última respuesta, por píxel
  #muestra  = { id: 0, x: 0, y: 0, trazo: -1, ref: -1, deben: 0 }   // la pedida, y lo que va resolviendo
  // `x`/`y` es el píxel donde se apretó y `dx`/`dy` el offset de agarre: dónde cayó ese píxel DENTRO del
  // handle. El vértice se desplaza lo que se desplaza el puntero, no salta a centrarse bajo él.
  #gesto    = { trazo: null, ref: -1, movido: false, x: 0, y: 0, dx: 0, dy: 0, devolver: null }
  // El trazo a mano alzada: `xy` son sus muestras [lat, lng, …] y `x`/`y` el píxel de la última aceptada, o
  // NaN si la próxima entra sea cual sea. `vivo` es que ya hay dos muestras y el trazo se dibuja sobre el
  // valor, que `previo` guarda para devolverlo; `pausa` es que la cámara se mueve.
  #mano     = { devolver: null, xy: [], x: NaN, y: NaN, vivo: false, previo: null, pausa: false }
  // La pulsación de un dedo que coloca en `draw`: `x`/`y` es donde se apoyó, `abrio` que ahí empezó la figura,
  // y `cortado` que un segundo dedo la pasó a mover el mapa.
  #toque    = { devolver: null, x: 0, y: 0, abrio: false, movido: false, cortado: false }
  #promo    = { trazo: -1, ref: -1 }
  #vivo     = { ring: 0, vertex: -1, x: 0, y: 0 }             // el vértice en arrastre, en world0 px
  #vista    = { zoom: 0, center: { x: 0, y: 0 }, size: { x: 0, y: 0 }, drag: null }
  #pixel    = new Int32Array(2)
  #xy       = new Float64Array(2)
  #esquinas = new Int32Array(4)            // los cuatro refs del rectángulo, capturados al tomar el gesto
  #punto    = [0, 0]                       // el píxel que la cámara convierte, reusado en cada frame
  #esquina  = [0, 0]                       // la esquina que devuelve el arrastre de rectángulo
  #curvo    = [0, 0]                       // el punto de la geodésica que el gesto escribe en el contorno

  // El pane se direcciona por NOMBRE: dos editores sobre el mismo mapa comparten el nodo, y la superficie
  // del anfitrión lo sostiene mientras quede uno. El puntero le llega por `join`, que lo suma a la puerta
  // del puntero (engine/Interaction) en su lugar del orden declarado.
  constructor({ host, join, pane, kind = 'polygon', value = null, mode = 'edit', model = byDefault, style, onChange, onCommit, onHandleLevel } = {}) {
    if (!KINDS.has(kind)) throw new Error(`EditableGeometry: kind inválido "${kind}"`)
    this.#style         = { ...ESTILO, ...style }
    this.#host          = host
    this.#camera        = host.camera
    this.#pane          = pane ?? PANE
    this.#kind          = kind
    this.#model         = model
    this.#forma         = SHAPES[kind]
    this.#perimetro     = this.#forma ? new ChunkedPath({ closed: true }) : null
    this.#manijas       = this.#forma ? new Float64Array(2 * this.#forma.handles) : null
    this.#onChange      = onChange
    this.#onCommit      = onCommit
    this.#onHandleLevel = onHandleLevel
    this.#surface       = new EditSurface({ host, pane: this.#pane })
    this.#gl            = this.#surface.attach()
    this.#iconSet       = defineEditIconSet()
    this.#fill          = CERRADOS.has(kind) ? new EditFillLayer({ gl: this.#gl, rings: this.#contornos, color: this.#style.fillColor, opacity: this.#style.fillOpacity }) : null
    this.#geom          = this.#ingest(value)
    this.#mode          = mode
    this.#bajaVista     = host.camera.on('moveend zoomend resize', this.#onView)
    this.#bajaPausa     = host.camera.on('movestart zoomstart', this.#onPausa)
    this.#bajaCuadro    = host.camera.on('zoomframe', () => this.#draw())
    this.#salir         = join(this.#participante)
    this.#rebuild()
  }

  /* ── API pública ──────────────────────────────────────────────────────────────────────── */

  // Nuevo valor externo (input controlado): NO emite onChange — es el mundo empujando estado, no una edición.
  // Corta el gesto como los demás cortes de afuera: el ref que el dedo tiene tomado es POSICIONAL, y sobre
  // el valor nuevo direcciona otro vértice.
  setValue(value) {
    this.#releaseInteraction()
    this.#borrador = null
    this.#geom     = this.#ingest(value)
    this.#rebuild()
    this.#informar()
  }

  // Fuera de `edit` nadie sigue al puntero, así que lo resuelto bajo él tampoco vale al volver. Un trazado a
  // medio hacer se descarta, y su vista previa vuelve al valor. Un trazo a mano alzada también, pero su crudo
  // ya salió por `onChange`: el valor de antes sale detrás, como en un `pointercancel`.
  setMode(mode) {
    if (mode === this.#mode) return
    const borrador = this.#borrador
    const trazo    = this.#mano.vivo
    this.#releaseInteraction()
    this.#mode     = mode
    this.#borrador = null
    borrador && this.#refigurar()
    this.#invalidar()
    this.#promover(-1, -1)
    this.#draw()
    this.#informar()
    trazo && this.#emit()
  }

  // Curva los tramos de polygon y polyline sobre la geodésica de `model`, o los vuelve rectos con `null`. Los
  // trazos se montan de nuevo, con el midpoint de las manijas sobre la curva y un contorno propio. Corta el
  // gesto como `setMode` y, como el valor no cambia, sólo emite tras cortar un trazo a mano alzada, cuyo crudo
  // ya salió. Un tramo corto o el que da más de media vuelta no se parten, y su midpoint sigue en el promedio.
  // Los dos midpoints del vértice tomado quedan bajo su vecindario mientras dura el gesto, así que se ubican
  // al soltar y el frame no paga el modelo.
  setCurve(model) {
    if (!CRECEN.has(this.#kind)) throw new Error(`EditableGeometry: el kind "${this.#kind}" no se curva`)
    const trazo = this.#mano.vivo
    this.#releaseInteraction()
    this.#curva = model
    this.#medio = model && ((lat1, lng1, lat2, lng2, out) => this.#gesto.ref < 0 &&
      count(this.#geodesica, lat1, lng1, lat2, lng2) > 1 && at(this.#geodesica, lat1, lng1, lat2, lng2, 0.5, out))
    this.#paths.length = 0
    this.#trazos.splice(0).forEach(t => this.#soltar(t))
    this.#contornos.splice(0)
    this.#geom = this.#ingest(this.#serialize())
    this.#rebuild()
    this.#informar()
    trazo && this.#emit()
  }

  // Parcial: lo que no venga en `style` queda como estaba.
  setStyle(style) {
    Object.assign(this.#style, style)
    this.#fill?.style({ color: this.#style.fillColor, opacity: this.#style.fillOpacity })
    this.#contornos.forEach(c => c.stroke.style({ width: this.#style.weight, color: this.#style.color }))
    this.#draw()
  }

  getValue() { return this.#serialize() }

  // Los trazos del arena en orden de dibujo: los anillos del polígono, o el path único de la polilínea.
  // Vacío para point, rectangle y las formas, cuyo trazo se DERIVA de su estado y no es parte de su valor.
  get paths() {
    if (this.#kind === 'polygon') return [...this.#geom.rings]
    return this.#kind === 'polyline' ? [this.#geom.path] : []
  }

  // Sub-pieza "click en mapa vacío → latlng": expuesta para que el consumidor rutee su propia captura de
  // punto (además del click del mapa que le entrega la puerta del puntero). En draw, agrega/coloca.
  handleMapClick(latlng) {
    if (this.#mode !== 'draw' || !latlng) return
    const p = toFinitePair(latlng)
    if (!p) return                                          // garbage-in en el trazado tampoco entra
    if (this.#kind === 'point') {
      this.#geom.pt = p
      this.#refigurar()
      return this.#settle()
    }
    if (this.#forma) return this.#trazarForma(p)
    if (this.#kind === 'rectangle') return this.#drawRectClick(p)
    const t    = this.#trazos[0]
    const path = t.path
    // Los dos clicks del doble click de cierre caen en el mismo píxel si el puntero no se movió:
    // deduplicarlo acá neutraliza el segundo (no se duplica el último punto ni se emite una geometría con
    // uno repetido).
    if (vertexAt(path, path.lastVertex, p)) return
    const estrenaba = !path.length
    path.append(p[0], p[1])
    this.#espejar(t, estrenaba)
    this.#settle()
  }

  destroy() {
    this.#releaseInteraction()
    this.#salir()
    this.#bajaVista()
    this.#bajaPausa()
    this.#bajaCuadro()
    this.#trazos.splice(0).forEach(t => this.#soltar(t))
    this.#contornos.splice(0)
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
      default: {
        const shape = this.#forma.read(value)
        this.#teselar(shape, this.#model)
        return { shape, path: this.#trazo(0, this.#manijasDe(shape), true) }
      }
    }
  }

  // El `ChunkedPath` del índice `i`, REUSADO entre ingestas: re-ingerirlo en su sitio deja vivo el stack
  // GPU que lo espeja —textura, VBO y programas—, que es lo caro de un `setValue`. Las coordenadas llegan
  // en cualquier iterable, como las de una parte de un path.
  #trazo(i, coords, closed) {
    const pts  = Array.from(coords, toFinitePair).filter(Boolean)
    const path = this.#paths[i]
    if (!path) return (this.#paths[i] = new ChunkedPath({ points: pts, closed, mid: this.#medio }))
    path.setClosed(closed)
    return path.reset(pts)
  }

  // El trazo derivado de una figura de tamaño fijo. Los kinds que crecen no pasan por acá: su trazo ES
  // su valor.
  #figura() {
    if (this.#forma) return this.#manijasDe(this.#geom.shape)
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
      default: return g.shape ? this.#forma.value(g.shape) : null
    }
  }

  // Las manijas de la forma como pares, ubicadas con el modelo del mapa.
  #manijasDe(shape) {
    if (!shape) return []
    this.#forma.place(this.#model, shape, this.#manijas)
    return pairs(this.#manijas, 0, this.#forma.handles)
  }

  // El anillo de la forma rehecho entero, con `model` y los segmentos que pide la vista; vacío sin forma.
  // Asigna, así que corre fuera de los frames: al ingerir, al soltar, en cada click del trazado y cuando el
  // zoom pide otros segmentos. Quien lo llame pone al día el arena del contorno.
  #teselar(shape, model) {
    const cuenta = shape ? sizeShape(shape, viewSegments(shape, this.#camera.zoom())) : 0
    if (this.#anillo.length !== cuenta * 2) this.#anillo = new Float64Array(cuenta * 2)
    shape && writeShape(model, shape, this.#anillo, 0)
    this.#perimetro.reset(pairs(this.#anillo, 0, cuenta))
  }

  // Un frame del gesto o de la vista previa: la esfera por defecto reescribe la forma sobre el mismo anillo,
  // con los segmentos y los tramos de cada parte congelados, así que sólo se mueven vértices y se suben sus
  // chunks, sin re-ingerir el arena. Una figura que se abre en sector o se cierra en 360 cambia de conteo
  // —la entera es la que no tiene arco—, y ésa se rehace; las demás reescrituras son [0-alloc].
  #reescribir(shape, arena) {
    const { arc, steps } = shape
    const path = this.#perimetro
    const xy   = this.#anillo
    if (!arc !== (shape.sweep === 360)) {
      this.#teselar(shape, byDefault)
      return arena.reset()
    }
    sizeShape(shape, shape.n)
    shape.arc   = arc
    shape.steps = steps
    writeShape(byDefault, shape, xy, 0)
    for (let i = 0, ref = path.firstVertex; i < path.length; i++, ref = path.nextVertex(ref))
      path.moveVertex(ref, xy[2 * i + 1], xy[2 * i])
    for (let k = path.firstChunk; k >= 0; k = path.chunkNext(k))
      arena.writeRange(k, path.chunkFirst(k), path.chunkFirst(k) + path.chunkUsed(k))
  }

  // El modelo con que se curva. Un trazo a mano alzada rehace la curva en cada muestra, así que mientras dura
  // se curva con la esfera, como el gesto, y el modelo entra al hornear.
  get #geodesica() { return this.#mano.vivo ? byDefault : this.#curva }

  // El contorno de un trazo curvo, rehecho entero con el modelo: cada tramo de la entrada, partido en los
  // segmentos que pide su geodésica. Anota por vértice de la entrada el ref de su punto en el contorno y los
  // segmentos del tramo que arranca en él, que el gesto congela. Asigna, así que corre al ingerir, en cada
  // edición discreta y al soltar.
  #curvar(t) {
    const { path, contorno: c } = t
    const model = this.#geodesica
    const refs  = path.chunkCount * path.entriesPerChunk
    const pts   = []
    c.desde  = new Int32Array(refs)
    c.tramos = new Int32Array(refs)
    for (let i = 0, v = path.firstVertex; i < path.length; i++, v = path.nextVertex(v)) {
      const n    = path.nextVertex(v)
      const lat1 = path.xAt(v), lng1 = path.yAt(v)
      pts.push([lat1, lng1])
      if (n < 0) continue
      const m = c.tramos[v] = count(model, lat1, lng1, path.xAt(n), path.yAt(n))
      for (let k = 1; k < m; k++) pts.push(at(model, lat1, lng1, path.xAt(n), path.yAt(n), k / m, [0, 0]))
    }
    c.path.reset(pts)
    for (let i = 0, v = path.firstVertex, r = c.path.firstVertex; i < path.length; i++, v = path.nextVertex(v)) {
      c.desde[v] = r
      for (let k = 0; k < c.tramos[v]; k++) r = c.path.nextVertex(r)
    }
    c.arena.reset()
  }

  // Los puntos intermedios del tramo `v → n` de un trazo curvo, sobre la geodésica de la esfera. Si `count`
  // ya no lo parte —más de media vuelta de longitud, extremos que se juntan o antípodas, que `at` no admite,
  // o un tramo que quedó corto— van sobre la recta de Mercator, que es lo que se dibuja al soltar. [0-alloc]
  #tramo({ path, contorno: c }, v, n) {
    const out   = this.#curvo
    const m     = c.tramos[v]
    const lat1  = path.xAt(v), lng1 = path.yAt(v)
    const lat2  = path.xAt(n), lng2 = path.yAt(n)
    const recto = m > 1 && count(byDefault, lat1, lng1, lat2, lng2) === 1
    const y1    = projY0(lat1), dy = projY0(lat2) - y1
    for (let k = 1, r = c.path.nextVertex(c.desde[v]); k < m; k++, r = c.path.nextVertex(r)) {
      if (recto) {
        out[0] = Math.atan(Math.sinh(Math.PI * (1 - (y1 + k / m * dy) / 128))) / D
        out[1] = lng1 + k / m * (lng2 - lng1)
      } else at(byDefault, lat1, lng1, lat2, lng2, k / m, out)
      c.path.moveVertex(r, out[0], out[1])
    }
  }

  // Lo menos que mide un radio, en metros a la latitud del centro, para que sus manijas no se pisen.
  #minimo(lat) { return pixelsToMeters(SEPARACION, lat * D, this.#camera.zoom()) }

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

  /* ── La puerta del puntero ─────────────────────────────────────────────────────────────── */

  // Lo que le entrega engine/Interaction, en píxeles del contenedor. La pulsación que reconoce un handle
  // (`handleAt`) es entera suya si la puerta se la da: el `down`, cada `move` de su puntero y su `up`, que
  // también llega por un `pointercancel`. Sin una pulsación suya, cada `move` es hover. El click del mapa
  // es la edición del modo draw, y el doble click sobre un handle propio (`propio`) borra el vértice; en
  // draw, cierra el trazo. Devolver `true` desde `dblclick` lo consume: el mapa no hace zoom. En `freehand`
  // reconoce todo píxel: la pulsación es el trazo, que termina en `up`, cancelado o no. Su primera muestra es
  // donde se apoyó el dedo, y un toque sin recorrido no pasa de ella. En `draw` también, si es de un dedo o un
  // lápiz: la pulsación coloca (`#apoyar`).
  #participante = {
    handleAt: (x, y, dedo) => {
      if (this.#manoAlzada || dedo && this.#trazando) return true
      const p = this.#puntoDe(x, y)
      return this.#conHandles && this.#bajoElPixel(p[0], p[1]).ref >= 0
    },
    // El dueño del midpoint es el vértice de la entrada anterior: describe el segmento que ARRANCA en él.
    // Insertar asienta ACÁ, antes de tomar el gesto: un `onCommit` que pasó a draw o destruyó el editor ya
    // no oye el `up` que devolvería el arrastre del mapa, así que el gesto no empieza.
    down: (x, y, dedo) => {
      if (dedo && this.#trazando) return this.#apoyar(x, y)
      if (this.#manoAlzada) {
        const m = this.#mano
        m.devolver  = this.#host.input.lendDrag()
        m.xy.length = 0
        m.x         = NaN
        m.y         = NaN
        return this.#muestrear(x, y)
      }
      const p   = this.#puntoDe(x, y)
      const h   = this.#bajoElPixel(p[0], p[1])
      const t   = this.#trazos[h.trazo]
      const rol = t.path.roleAt(h.ref)
      const ref = rol === ROLE.midpoint ? this.#onMidInsert(t, h.ref - 1) : rol === ROLE.vertex ? h.ref : -1
      ref >= 0 && this.#conHandles && this.#beginInteraction(t, ref, p)
    },
    move: (x, y) => {
      if (this.#mano.devolver) return this.#muestrear(x, y)
      if (this.#toque.devolver) return this.#deslizar(x, y)
      const p = this.#puntoDe(x, y)
      if (this.#gesto.ref >= 0) return this.#arrastrar(p[0], p[1])
      if (this.#mode === 'draw') return this.#previa(p)
      if (!this.#conHandles) return
      this.#cobrar()
      this.#pedir(p[0], p[1])
    },
    up: (x, y, cancelado) => this.#mano.devolver
      ? this.#soltarMano(!cancelado) && this.#emit()
      : this.#toque.devolver ? this.#levantar(x, y, cancelado)
      : this.#gesto.ref >= 0 && this.#endInteraction(this.#puntoDe(x, y)),
    // El puntero se fue del contenedor: no va a llegar otro `move` que despromueva, así que el vecindario
    // —tres nodos y el agujero que abren en el visual— se suelta acá o queda encendido con el cursor en
    // otra parte de la pantalla. Con el gesto vivo no aplica: el puntero está capturado.
    leave: () => {
      if (this.#gesto.ref >= 0) return
      this.#invalidar()
      this.#promover(-1, -1) && this.#draw()
      this.#informar()
    },
    click: muestra => this.handleMapClick(muestra),
    // Un borrado que no baja del mínimo de vértices no consume: el doble click sigue siendo del mapa. El
    // cierre del trazo colapsa el duplicado final que se haya colado, emite sólo si de verdad cambió algo y
    // consume siempre que haya un trazo que cerrar.
    dblclick: (muestra, propio) => {
      if (propio) {
        if (this.#manoAlzada) return false
        const p     = this.#puntoDe(muestra.x, muestra.y)
        const h     = this.#bajoElPixel(p[0], p[1])
        const t     = this.#trazos[h.trazo]
        const borro = t.path.roleAt(h.ref) === ROLE.vertex && this.#onVertexDelete(t, h.ref)
        this.#informar()
        return borro
      }
      if (this.#mode !== 'draw' || !CRECEN.has(this.#kind) || this.#trazos[0].path.length < 2) return false

      const t         = this.#trazos[0]
      const path      = t.path
      const p         = [muestra.lat, muestra.lng]
      const antes     = path.length
      const duplicado = v => vertexAt(path, v, p) && vertexAt(path, path.prevVertex(v), p)
      while (path.length > 1 && duplicado(path.lastVertex)) path.remove(path.lastVertex)
      if (path.length < antes) {
        this.#espejar(t, false)
        this.#settle()
      }
      return true
    },
  }

  // El encuadre cambió bajo el puntero: lo que había en un píxel ya no está ahí, y sin un `move` que lo
  // vuelva a resolver el vecindario promovido tampoco corresponde a nada. Un gesto vivo conserva el suyo:
  // su vértice es el que el dedo tiene tomado, no el que haya bajo el cursor.
  // Las formas re-teselan cuando el zoom pide otros segmentos; el borrador, con la esfera de su vista previa.
  // El trazo a mano alzada retoma, y su próxima muestra entra aunque quede cerca de la última.
  #onView = () => {
    const m = this.#mano
    m.pausa = false
    m.x     = NaN
    const shape = this.#forma && (this.#borrador ?? this.#geom.shape)
    this.#invalidar()
    this.#gesto.ref < 0 && this.#promover(-1, -1)
    if (shape && shape.n !== viewSegments(shape, this.#camera.zoom())) {
      this.#teselar(shape, shape === this.#borrador ? byDefault : this.#model)
      this.#trazos[0].contorno.arena.reset()
    }
    this.#draw()
    this.#informar()
  }

  // La cámara se mueve: el trazo a mano alzada no muestrea hasta que asiente, y retoma con una cuerda recta.
  #onPausa = () => {
    this.#mano.pausa = true
    this.#toque.cortado ||= !!this.#toque.devolver
  }

  // El dedo traza: en `freehand`, y sólo polygon y polyline. En los demás kinds el modo queda inerte.
  get #manoAlzada() { return this.#mode === 'freehand' && CRECEN.has(this.#kind) && this.#surface.attached }

  get #trazando() { return this.#mode === 'draw' && this.#surface.attached }

  // Hay handles que tomar: en `edit` y con la superficie viva. Un `onCommit` a mitad de pulsación puede
  // haber pasado a draw o destruido el editor.
  get #conHandles() { return this.#mode === 'edit' && this.#surface.attached }

  // El píxel entero del pase de picking, reusado.
  #puntoDe(x, y) {
    const p = this.#pixel
    p[0] = Math.round(x)
    p[1] = Math.round(y)
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
      t.contorno.path === t.path && t.contorno.stroke.promote(v)
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
  // hasta que se levante, y la puerta lo capturó para que siga llegando aunque salga del mapa—. El offset
  // de agarre se mide UNA vez, acá: es el único punto donde el vértice todavía está donde lo agarraron.
  #beginInteraction(t, ref, p) {
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
    g.devolver = this.#host.input.lendDrag()
    this.#kind === 'rectangle' && this.#capturarEsquinas(t.path)
    this.#forma?.grab(this.#geom.shape)
    t.bank.grab(true)
    this.#draw()
    this.#informar()
  }

  // Una muestra del puntero: se acepta si avanzó `PASO` desde la última y la cámara no se mueve. Desde la
  // segunda el trazo es el valor: el polígono lo reemplaza entero por un anillo y la polilínea lo continúa.
  // Cada muestra emite un `change` con el trazo crudo.
  #muestrear(x, y) {
    const m = this.#mano
    if (m.pausa || Math.abs(x - m.x) + Math.abs(y - m.y) < PASO) return
    const c = this.#punto
    c[0] = x
    c[1] = y
    const p = toFinitePair(this.#camera.fromContainer(c))
    if (!p) return
    m.x = x
    m.y = y
    m.xy.push(p[0], p[1])
    if (m.xy.length < 4) return
    const nuevo = !m.vivo
    if (nuevo) {
      m.vivo   = true
      m.previo = this.#serialize()
      if (this.#kind === 'polygon') {
        this.#geom = this.#ingest([])
        this.#rebuild()
      }
    }
    const t         = this.#trazos[0]
    const estrenaba = !t.path.length
    for (let i = nuevo ? 0 : m.xy.length - 2; i < m.xy.length; i += 2) t.path.append(m.xy[i], m.xy[i + 1])
    this.#espejar(t, estrenaba)
    this.#emit()
    this.#draw()
  }

  // El trazo termina y devuelve el arrastre. Con `hornear` se suaviza y asienta como una edición discreta; si
  // no, o si el anillo no llega a tres vértices, el valor vuelve al de antes. Devuelve si lo devolvió.
  #soltarMano(hornear) {
    const m = this.#mano
    const { devolver, vivo, previo, xy } = m
    m.devolver = m.previo = null
    m.vivo     = false
    devolver()
    if (!vivo) return false

    const cerrado = this.#kind === 'polygon'
    const c       = this.#punto
    const px      = new Float64Array(xy.length)
    for (let i = 0; i < xy.length; i += 2) {
      c[0] = xy[i]
      c[1] = xy[i + 1]
      const q = this.#camera.toContainer(c)
      px[i]     = q.x
      px[i + 1] = q.y
    }
    const suave = hornear ? bake(px, cerrado) : []
    if (suave.length < (cerrado ? 6 : 4)) {
      this.#geom = this.#ingest(previo)
      this.#rebuild()
      return true
    }
    const pts = cerrado ? [] : previo
    for (let i = 0; i < suave.length; i += 2) {
      c[0] = suave[i]
      c[1] = suave[i + 1]
      pts.push(toFinitePair(this.#camera.fromContainer(c)))
    }
    this.#trazo(0, pts, cerrado)
    this.#reingerir(this.#trazos[0])
    this.#settle()
    return false
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
  // día: el arrastre dejó el arena atrás y lo movido ya salió por `onChange`. Una forma se rehace entera:
  // sus manijas vuelven a donde la forma las pone y su anillo pasa de la esfera al modelo, y un contorno
  // curvo se rehace con el modelo y su cuenta. Un trazo a mano alzada vuelve al valor de antes, y sólo
  // `setMode` lo emite.
  #releaseInteraction() {
    this.#mano.devolver && this.#soltarMano(false)
    this.#toque.devolver && this.#soltarToque()
    const g = this.#gesto
    if (g.ref < 0) return null
    const tomado   = { t: g.trazo, ref: g.ref, movido: g.movido }
    const devolver = g.devolver
    g.trazo    = null
    g.ref      = -1
    g.movido   = false
    g.devolver = null
    if (tomado.movido) {
      const { t, ref } = tomado
      this.#invalidar()
      this.#curva && t.path.moveVertex(ref, t.path.xAt(ref), t.path.yAt(ref))   // sus midpoints, ya fuera del gesto
      this.#forma ? this.#refigurar() : t.arena.writeEntry(ref)
      this.#curva && this.#curvar(t)
    }
    tomado.t.bank.grab(false)
    devolver()
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
  // muestran como uniform, sin escribir a GPU. El arena queda atrás a propósito: se pone al día al soltar,
  // salvo en el rectángulo y las formas, que mueven más de un vértice por frame y los escriben al espejo.
  // Hasta que el puntero supera la tolerancia de click no hay arrastre: una pulsación quieta no edita.
  // El vértice va al puntero MÁS el offset de agarre, como `L.Draggable`: agarrarlo por el borde no lo
  // teletransporta a centrarse bajo el cursor.
  #arrastrar(x, y) {
    const g = this.#gesto
    if (!g.movido && Math.abs(x - g.x) + Math.abs(y - g.y) < CLICK_TOLERANCE) return
    const p = this.#lugar(x + g.dx, y + g.dy)
    const q = p && this.#mover(g.trazo, g.ref, p)
    if (!q) return
    g.movido = true
    this.#vivir(g.trazo, g.ref, q)
    this.#emit()
    this.#draw()
  }

  // El lugar bajo el píxel (x, y) del contenedor, como par finito, o null.
  #lugar(x, y) {
    const c = this.#punto
    c[0] = x
    c[1] = y
    return toFinitePair(this.#camera.fromContainer(c))
  }

  // La regla de arrastre de cada `kind`, con la posición que le queda al ref arrastrado (o null si no se
  // movió nada): polígono y polilínea mueven su vértice y el punto es su único vértice.
  //
  // Con curva, los dos tramos del vértice en el contorno se rehacen con la esfera y los segmentos que tenían
  // al tomarlo, y se sube sólo lo que va del punto del vértice anterior al último antes del siguiente, con
  // sus midpoints. Tras el `reset` del contorno sus refs crecen con el trazo, así que ese rango sólo da la
  // vuelta en el cierre del anillo. [0-alloc]
  #mover(t, ref, p) {
    if (this.#forma) return this.#moverManija(t, ref, p)
    if (this.#kind === 'rectangle') return this.#moverEsquina(t, ref, p)
    if (!t.path.moveVertex(ref, p[0], p[1])) return null
    this.#kind === 'point' && (this.#geom.pt = p)
    if (!this.#curva) return p

    const { path, contorno: c } = t
    const borde = c.path
    const prev  = path.prevVertex(ref)
    const next  = path.nextVertex(ref)
    borde.moveVertex(c.desde[ref], p[0], p[1])
    prev >= 0 && this.#tramo(t, prev, ref)
    next >= 0 && this.#tramo(t, ref, next)
    const a   = c.desde[prev < 0 ? ref : prev]
    const b   = next < 0 ? c.desde[ref] : borde.prevVertex(c.desde[next])
    const fin = borde.chunkOf(b)
    for (let k = borde.chunkOf(a), lo = borde.localOf(a), vuelta = a > b; ;) {
      const ultimo = k === fin && !vuelta
      c.arena.writeRange(k, lo, ultimo ? borde.localOf(b) + 2 : borde.chunkFirst(k) + borde.chunkUsed(k))
      if (ultimo) return p
      k = borde.chunkNext(k)
      if (k < 0) {
        k      = borde.firstChunk
        vuelta = false
      }
      lo = borde.chunkFirst(k)
    }
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

  // Arrastre de una manija de forma: la regla de su forma cambia la forma, las manijas se reubican desde ella y
  // el anillo se reescribe. La manija tomada sigue al puntero y al soltar vuelve a donde la pone la forma: la
  // de través y los bordes del sector, a su eje. Las manijas caben en el primer chunk, en orden, así que la
  // manija `i` es el ref 2i.
  #moverManija(t, ref, p) {
    const shape = this.#geom.shape
    const xy    = this.#manijas
    if (!this.#forma.drag(this.#model, shape, ref >> 1, p[0], p[1], this.#minimo(shape.lat))) return null
    this.#forma.place(this.#model, shape, xy)
    for (let i = 0, v = t.path.firstVertex; i < this.#forma.handles; i++, v = t.path.nextVertex(v)) {
      t.path.moveVertex(v, xy[2 * i + 1], xy[2 * i])
      t.arena.writeEntry(v)
    }
    this.#reescribir(shape, t.contorno.arena)
    return p
  }

  // La posición VIVA del vértice en las tres capas: el contorno y el banco la reciben en coordenadas del
  // trazo y el relleno en world0 px — cada uno le resta el ancla de SU arena. El relleno direcciona el
  // anillo por orden: cada trazo tiene su contorno en el mismo lugar de la lista.
  #vivir(t, ref, p) {
    const v = this.#vivo
    project(p[0], p[1], this.#xy)
    t.contorno.stroke.live(p[0], p[1])
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

  // Un dedo coloca en `draw`: el mapa no se arrastra con él, y con dos se mueve. La forma y el rectángulo
  // empiezan donde se apoya; lo que sigue —el radio, el borde, el otro eje, la otra esquina, el vértice— va en
  // la vista previa bajo el dedo y queda donde se levanta. El toque que empezó la figura —el que tiembla menos
  // que TEMBLOR— no pone nada más. Un segundo dedo corta la colocación sin poner el punto.
  #apoyar(x, y) {
    const t = this.#toque
    t.devolver = this.#host.input.lendDrag()
    t.x        = x
    t.y        = y
    t.movido   = false
    t.cortado  = false
    t.abrio    = !this.#borrador && (!!this.#forma || this.#kind === 'rectangle')
    t.abrio ? this.#colocar(x, y) : this.#previa(this.#puntoDe(x, y))
  }

  #deslizar(x, y) {
    const t = this.#toque
    t.movido ||= Math.abs(x - t.x) + Math.abs(y - t.y) > TEMBLOR
    t.cortado || this.#previa(this.#puntoDe(x, y))
  }

  #levantar(x, y, cancelado) {
    const { abrio, movido, cortado } = this.#toque
    this.#soltarToque()
    cancelado || cortado || abrio && !movido || this.#colocar(x, y)
  }

  #soltarToque() {
    const t     = this.#toque
    const listo = t.devolver
    t.devolver  = null
    listo()
  }

  #colocar(x, y) {
    const q = this.#lugar(x, y)
    q && this.handleMapClick(q)
  }

  // Trazado de rectángulo: primer click fija una esquina; el segundo cierra el bounds contra ella.
  #drawRectClick(p) {
    if (!this.#borrador) { this.#borrador = p; return }
    this.#geom.bounds = caja(this.#borrador, p)
    this.#borrador    = null
    this.#refigurar()
    this.#settle()
  }

  // Trazado de una forma: el primer click pone el centro y cada uno de los siguientes, la manija que sigue
  // —el radio; en la elipse, `b` después; en el sector, un borde después de la punta—. El último asienta.
  // El borrador nace con el radio mínimo y se dibuja con la esfera, como la vista previa.
  #trazarForma(p) {
    const forma = this.#forma
    const b     = this.#borrador
    if (!b) {
      const min = this.#minimo(p[0])
      this.#paso = 1
      return this.#esbozar(forma.read({ center: p, radius: forma.round ? min : [min, min] }))
    }
    if (!forma.drag(this.#model, b, this.#paso, p[0], p[1], this.#minimo(b.lat))) return
    if (++this.#paso < forma.clicks) return this.#esbozar(b)
    this.#geom.shape = b
    this.#borrador   = null
    this.#refigurar()
    this.#settle()
  }

  #esbozar(borrador) {
    this.#borrador = borrador
    if (!borrador) return
    this.#teselar(borrador, byDefault)
    this.#trazos[0].contorno.arena.reset()
    this.#draw()
  }

  // La vista previa elástica del trazado: el click que falta, donde está el puntero. No emite, y el valor
  // sigue siendo el de antes hasta el último click.
  #previa(p) {
    const b = this.#borrador
    const q = b && this.#lugar(p[0], p[1])
    if (!q) return
    if (this.#forma) {
      if (!this.#forma.drag(this.#model, b, this.#paso, q[0], q[1], this.#minimo(b.lat))) return
      this.#reescribir(b, this.#trazos[0].contorno.arena)
    } else {
      this.#geom.path = this.#trazo(0, rectCorners(caja(b, q)), true)
      this.#trazos[0].arena.reset()
    }
    this.#draw()
  }

  /* ── El espejo GPU ──────────────────────────────────────────────────────────────────────── */

  // El espejo tras una edición ESTRUCTURAL. Re-ingiere —y con eso vuelve a congelar el ancla— cuando el
  // trazo estrenó contenido: un ancla congelada sobre un trazo vacío no acota nada, y de ahí sale la
  // precisión de float32. Si no, sube sólo los chunks que se movieron. Un contorno curvo se rehace entero.
  #espejar(t, reingesta) {
    reingesta ? t.arena.reset() : t.arena.syncStructure()
    this.#curva && this.#curvar(t)
  }

  // point, rectangle y las formas DERIVAN su trazo de su estado y se re-ingieren enteros: en una figura de
  // tamaño fijo eso cuesta lo mismo que actualizarla, y les evita un camino de edición propio.
  #refigurar() {
    this.#geom.path = this.#trazo(0, this.#figura(), CERRADOS.has(this.#kind))
    this.#forma && this.#teselar(this.#geom.shape, this.#model)
    this.#reingerir(this.#trazos[0])
  }

  // El espejo entero de un trazo, y el de su contorno si es derivado; el curvo se rehace con el modelo.
  #reingerir(t) {
    t.arena.reset()
    this.#curva ? this.#curvar(t) : t.contorno.arena !== t.arena && t.contorno.arena.reset()
  }

  #dibujables() { return this.#kind === 'polygon' ? this.#geom.rings : [this.#geom.path] }

  // Recablea el espejo a los trazos vigentes: los que sobreviven re-ingieren su arena —el `ChunkedPath`
  // es el MISMO objeto, así que textura, VBO y programas siguen vivos—, los nuevos estrenan stack y los
  // que sobran se sueltan. `#fill` lee la MISMA lista de contornos, así que no hace falta reasignársela.
  #rebuild() {
    const paths = this.#dibujables()
    this.#invalidar()
    this.#trazos.splice(paths.length).forEach(t => this.#soltar(t))
    this.#contornos.splice(paths.length)
    paths.forEach((path, i) => this.#trazos[i] ? this.#reingerir(this.#trazos[i]) : this.#montar(path, i))
    this.#promover(-1, -1)
    this.#draw()
  }

  // Un trazo en GPU, en su lugar de las dos listas: el espejo del arena, sus handles como sprites, el banco
  // de nodos que repone el vecindario bajo el cursor y su contorno. El contorno es el mismo path con el mismo
  // arena, salvo en las formas y con curva, que dibujan su anillo o su curva con un path y un arena propios,
  // sin canales de handle. El objeto de picking es el orden + 1 —el pase descarta el 0—.
  #montar(path, orden) {
    const gl       = this.#gl
    const iconSet  = this.#iconSet
    const arena    = new EditArena({ gl, path, project, ...this.#canales() })
    const picking  = new Picking()
    const handles  = new EditHandleLayer({ gl, arena, path, picking, iconSet })
    const borde    = this.#perimetro ?? (this.#curva ? new ChunkedPath({ closed: path.closed }) : path)
    const dibujo   = borde === path ? arena : new EditArena({ gl, path: borde, project })
    const contorno = this.#contornos[orden] = {
      path   : borde,
      arena  : dibujo,
      stroke : new EditStrokeLayer({ gl, arena: dibujo, path: borde, project, width: this.#style.weight, color: this.#style.color }),
    }
    handles.pickObject  = orden + 1
    this.#trazos[orden] = {
      orden, path, arena, picking, handles, contorno,
      bank: new EditHandleDom({ host: this.#host, pane: this.#pane, path, arena, project, iconSet }),
    }
    this.#curva && this.#curvar(this.#trazos[orden])
  }

  // Cada arena se destruye una vez: el del contorno, sólo si no es el del trazo.
  #soltar(t) {
    t.bank.destroy()
    t.handles.destroy()
    t.contorno.stroke.destroy()
    t.contorno.arena !== t.arena && t.contorno.arena.destroy()
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
    // El encuadre que leen las tres capas, con el vértice que arrastra el gesto. Su `vertex` es un ref del
    // path de manijas y el relleno lo busca en el del contorno: sólo va cuando el contorno es ese path.
    const g     = this.#gesto
    const vista = readView(this.#camera, this.#vista)
    vista.drag  = g.movido && g.trazo.contorno.path === g.trazo.path ? this.#vivo : null
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT)
    this.#fill?.draw(vista)
    this.#contornos.forEach(c => c.stroke.draw(vista))
    if (this.#mode !== 'edit') return
    this.#trazos.forEach(t => {
      t.handles.draw(vista)
      t.bank.layout(vista)
    })
  }
}
