import { EditFillLayer } from './EditFillLayer.js'
import { FEATHER, StrokePass, ownDash } from './StrokePass.js'
import { EditSurface } from './EditSurface.js'
import { RingStore, maxTextureOf } from './RingStore.js'
import { projX0, projY0, readView } from './project.js'
import { prepareRangeIndex, partsAtPoint } from '../geometry/polygon.js'
import { focusedStyle } from './focus.js'
import { growBoxOfRange } from '../geometry/bbox.js'

// Relleno GPU de polígonos ESTÁTICOS sobre geometría tipada: un `RingStore` sube todos los anillos a UNA
// textura y un `EditFillLayer` compone su paridad por stencil.
//
// La geometría llega en las tablas del lector (`xy` en [lng, lat, …], `vertexAt` anillo → vértice,
// `ringAt` parte → anillo) y no se copia a objetos. `rings` y `parts`, cuando vienen, acotan la capa a
// las geometrías de ÁREA de un documento mixto.
//
// Las tablas en grados son la autoridad: de ahí salen el picking y el encuadre. El espejo GPU (float32,
// relativo al ancla) es derivado. El índice de hit sólo se arma con `interactive`; sin él la capa no
// retiene `geometry`.
//
// El XOR del stencil es GLOBAL a la capa: dos anillos superpuestos se cancelan en la intersección. Las
// figuras que se pisan van en instancias separadas.

const project = (lat, lng, out) => {
  out[0] = projX0(lng)
  out[1] = projY0(lat)
}

/* ── Puente desde un Source: anillos en arrays → las tablas que dibuja la capa ── */

// `ringsOf` entrega un anillo `[[lat,lng],…]`, un polígono con sus agujeros, o un multipolígono. Cada
// POLÍGONO es una parte —sus anillos componen entre sí y abren el agujero—, y las piezas de un
// multipolígono son partes distintas de la misma entidad, para que se apilen en vez de restarse. Las
// tablas van en [lng, lat]; los anillos vienen al revés.
const polygonsOf = rings =>
  !Array.isArray(rings[0]?.[0])   ? [[rings]]
  : Array.isArray(rings[0][0][0]) ? rings
  : [rings]

export const tablesFromRings = (items, ringsOf) => {
  const grupos = items.map(item => polygonsOf(ringsOf(item)))
  let anillos = 0, vertices = 0, partes = 0
  grupos.forEach(poligonos => poligonos.forEach(poligono => {
    partes++
    poligono.forEach(anillo => { anillos++; vertices += anillo.length })
  }))

  const xy       = new Float64Array(vertices * 2)
  const vertexAt = new Uint32Array(anillos + 1)
  const ringAt   = new Uint32Array(partes + 1)
  const closed   = new Uint8Array(anillos)
  const owner    = new Uint32Array(partes)      // parte → índice de la entidad en el snapshot
  let v = 0, r = 0, p = 0

  grupos.forEach((poligonos, item) => poligonos.forEach(poligono => {
    owner[p] = item
    poligono.forEach(anillo => {
      const primero = anillo[0], ultimo = anillo[anillo.length - 1]
      closed[r] = anillo.length > 1 && primero[0] === ultimo[0] && primero[1] === ultimo[1] ? 1 : 0
      anillo.forEach(([lat, lng]) => { xy[v * 2] = lng; xy[v * 2 + 1] = lat; v++ })
      vertexAt[++r] = v
    })
    ringAt[++p] = r
  }))

  return { xy, vertexAt, ringAt, closed, ringCount: anillos, partCount: partes, owner }
}

export class PolygonGpuLayer {

  #camera; #surface; #gl; #store; #fill
  #index   = null
  #idOf    = null
  #offView = null                     // baja del repintado en vista asentada
  #box     = new Float64Array(4)      // [minLng, minLat, maxLng, maxLat] en grados
  #ringBox = new Float64Array(4)      // caja del anillo en world0, reusada por el descarte
  #parts   = null                     // una entrada por POLÍGONO: sus anillos y su estilo resuelto
  #partBox = null                     // caja de cada parte en world0, para el descarte
  #onScreenParts = []                 // las que tocan el viewport; se reusa entre repintados
  #halfWidth     = 0                  // medio trazo MÁXIMO en px: el descarte se expande con él
  #styleOf = null
  #base    = null                     // el estilo de la capa, cuando no hay `styleOf`
  #source  = null
  #items   = null                     // snapshot vigente, cuando la geometría viene de un Source
  #owner   = null                     // parte → índice de su entidad en el snapshot
  #unsub   = null
  #interactive = false
  #hits    = []                       // partes bajo el cursor; se reusa entre consultas
  #focus   = { ids: null, dim: 0.3 }
  #stroke  = null
  #visible = true
  #view    = { zoom: 0, center: { x: 0, y: 0 }, size: { x: 0, y: 0 } }

  // Las opciones de trazo y relleno (`color`, `weight`, `opacity`, `fillColor`, `fillOpacity`) son las de
  // la gramática de la librería; `styleOf` las pisa por entidad.
  constructor({
    host, pane, geometry = null, source = null, interactive = false, idOf = null,
    color = '#3388ff', weight = 3, opacity = 1,
    fill = true, fillColor, fillOpacity = 0.2, stroke = true, styleOf = null,
  }) {
    this.#camera      = host.camera
    this.#source      = source
    this.#interactive = interactive
    // Con Source, los accessors mandan: el consumidor declara `idOf`/`styleOf` en un solo lugar.
    this.#idOf    = idOf ?? source?.accessors?.idOf ?? null
    this.#styleOf = styleOf ?? source?.accessors?.styleOf ?? null
    this.#base    = { color, weight, opacity, fillColor, fillOpacity }
    this.#surface = new EditSurface({ host, pane })
    this.#gl      = this.#surface.attach()
    // La superficie ya tomó uno de los ~16 contextos del navegador. Lo que siga puede tirar —el store
    // rechaza una geometría que no entra en la textura, y el estilo llama a `styleOf` e `idOf`, que son
    // código del consumidor—, y un contexto que nadie devuelve no vuelve en toda la vida de la página.
    try {
      const items = source ? source.getSnapshot() : null
      this.#ingest(geometry ?? tablesFromRings(items, source.accessors.ringsOf), items)
      this.#fill   = fill ? new EditFillLayer({ gl: this.#gl, rings: [], step: 1, color: fillColor ?? color, opacity: fillOpacity }) : null
      this.#stroke = stroke ? new StrokePass({ gl: this.#gl, color, width: weight, opacity }) : null
      // El canvas se ancla en coordenadas de CAPA, así que el pane lo traslada durante el arrastre y
      // los píxeles siguen alineados: sólo una vista ya asentada necesita repintar.
      this.#offView = host.camera.on('moveend zoomend resize', () => this.redraw())
      this.#unsub   = source?.subscribe(() => this.#onChange())
      this.redraw()
    } catch (e) {
      this.destroy()
      throw e
    }
  }

  // Toda la geometría entra por acá, venga de tablas o de un Source: el store se rehace entero, que es
  // el perfil de estas capas —pocas entidades, baja frecuencia de cambio—. Lo nuevo se arma y se estila
  // aparte y reemplaza a lo anterior sólo si resolvió entero: si algo lanza, la capa queda como estaba.
  #ingest(geometry, items = this.#items) {
    // `rings` acota lo que se sube a la textura y `parts` lo que entra al índice: con una sola de las
    // dos, el relleno y el picking miran conjuntos distintos y la capa contesta por figuras que no
    // dibujó. Además la pertenencia anillo→polígono se reconstruye de `parts`.
    if ((geometry.rings === undefined) !== (geometry.parts === undefined))
      throw new Error('[cristae] la selección necesita `rings` y `parts` juntas, o ninguna')
    const store = new RingStore({ gl: this.#gl, project, rings: { ...geometry, ringIds: geometry.rings } })
    const owner = geometry.owner ?? null
    try {
      const { parts, partBox } = this.#agrupar(store, geometry)
      this.#resolveStyles(parts, owner, items)
      this.#partBox = partBox
    } catch (e) {
      store.destroy()
      throw e
    }
    this.#store?.destroy()
    this.#store = store
    this.#owner = owner
    this.#items = items
    this.#measure(geometry)
    this.#index = this.#interactive ? prepareRangeIndex(geometry) : null
  }

  #onChange() {
    const items = this.#source.getSnapshot()
    this.setGeometry(tablesFromRings(items, this.#source.accessors.ringsOf), items)
  }

  // Reemplaza la geometría completa y reestila. Es la vía de quien arma las tablas por su cuenta, como
  // las capas que derivan sus anillos de otra cosa: el contexto WebGL queda, sólo se rehace el store.
  setGeometry(geometry, items = this.#items) {
    this.#ingest(geometry, items)
    return this.redraw()
  }

  // El estilo se resuelve por parte y se guarda: `styleOf` puede depender de la selección o de un
  // filtro, y reevaluarlo por frame lo llamaría una vez por polígono en cada repintado.
  // Con Source, `styleOf` e `idOf` reciben la ENTIDAD, que es lo que el consumidor conoce.
  #subject(parteId, owner = this.#owner, items = this.#items) {
    if (!owner) return parteId
    // Con Source el dueño es la ENTIDAD; con tablas del lector, el índice de la FEATURE. En los dos
    // casos el sujeto es "de quién es esta parte", que es lo que hace que un multipolígono conteste
    // una sola vez y lo que recibe `idOf`.
    return items ? items[owner[parteId]] : owner[parteId]
  }

  restyle() {
    this.#resolveStyles(this.#parts)
    return this.redraw()
  }

  // Se resuelve entero en partes nuevas y recién ahí se publica: un `styleOf` que lanza, o un patrón
  // que no cabe, deja las partes y el medio trazo como estaban.
  #resolveStyles(parts, owner = this.#owner, items = this.#items) {
    const base = this.#base
    // El trazo se expande en píxeles de PANTALLA, así que una figura con la caja justo afuera todavía
    // pinta borde adentro. El descarte necesita el medio ancho máximo para no comérselo.
    let halfWidth = 0
    const styled = parts.map(parte => {
      const sujeto = this.#subject(parte.id, owner, items)
      const id     = this.#idOf ? this.#idOf(sujeto) : sujeto
      // El foco se pliega acá, no en el dibujo: es un multiplicador de opacidad por entidad y esta es
      // la única pasada que ya recorre las partes.
      const s = focusedStyle({ ...base, ...(this.#styleOf?.(sujeto) ?? null) }, this.#focus, id)
      halfWidth = Math.max(halfWidth, s.weight / 2)
      return {
        ...parte,
        fill   : { color: s.fillColor ?? s.color, opacity: s.fillOpacity },
        stroke : { color: s.color, width: s.weight, opacity: s.opacity, dash: ownDash(s.dash ?? null) },
      }
    })
    this.#parts     = styled
    this.#halfWidth = halfWidth
  }

  // Los anillos del store salen agrupados por parte y en su orden, así que la pertenencia se
  // reconstruye con un corrimiento — sin volver a mirar la geometría.
  #agrupar(store, { ringAt, parts, partCount }) {
    const ids     = parts ?? Uint32Array.from({ length: partCount ?? 0 }, (_, p) => p)
    const box     = new Float64Array(4)
    const partBox = new Float64Array(ids.length * 4)
    let r = 0
    const partes = Array.from(ids, (id, k) => {
      const n = ringAt[id + 1] - ringAt[id]
      box[0] = box[1] = Infinity
      box[2] = box[3] = -Infinity
      const rings = Array.from({ length: n }, () => {
        store.worldBoxOf(r, this.#ringBox)
        box[0] = Math.min(box[0], this.#ringBox[0]); box[1] = Math.min(box[1], this.#ringBox[1])
        box[2] = Math.max(box[2], this.#ringBox[2]); box[3] = Math.max(box[3], this.#ringBox[3])
        return { arena: store.viewOf(r++) }
      })
      partBox.set(box, k * 4)
      return { id, rings }
    })
    return { parts: partes, partBox }
  }

  // Caja en grados de lo que la capa dibuja, en la forma de toda caja en grados (geometry/bounds.js), o
  // `null` mientras no haya vértices.
  get bounds() {
    const b = this.#box
    return Number.isFinite(b[0]) ? { south: b[1], west: b[0], north: b[3], east: b[2] } : null
  }

  #measure({ xy, vertexAt, ringCount, rings }) {
    const box = this.#box
    box[0] = box[1] = Infinity
    box[2] = box[3] = -Infinity
    const total = rings ? rings.length : ringCount
    for (let k = 0; k < total; k++) {
      const r = rings ? rings[k] : k
      growBoxOfRange(xy, vertexAt[r], vertexAt[r + 1] - vertexAt[r], box)
    }
  }

  // Los vértices que caben en la textura de este contexto: lo que pase de ahí `setGeometry` lo rechaza.
  get maxVertices() { return maxTextureOf(this.#gl) ** 2 }

  get ringCount()      { return this.#store.ringCount }
  get drawnPartCount() { return this.#onScreenParts.length }
  get drawnRingCount() { return this.#onScreenParts.reduce((n, p) => n + p.rings.length, 0) }
  get vertexCount() { return this.#store.vertexCount }
  get canvas()      { return this.#surface.canvas }

  // Mismos nombres que el alta: relleno y contorno se ajustan por separado.
  style(options = {}) {
    Object.entries(options).forEach(([k, v]) => v !== undefined && (this.#base[k] = v))
    return this.restyle()
  }

  // Contrato de toda capa del motor: la llama al rehabilitarla, para que se ponga al día.
  refresh() { return this.restyle() }

  applyFocus(ids, dim = this.#focus.dim) {
    this.#focus = { ids, dim }
    return this.restyle()
  }

  // Cambia el accessor y reevalúa: es la vía cuando la selección o el filtro mueven el estilo.
  setStyleOf(styleOf) {
    this.#styleOf = styleOf
    return this.restyle()
  }

  setVisible(visible) {
    this.#visible = visible
    this.#surface.canvas.style.display = visible ? '' : 'none'
    return visible ? this.redraw() : false
  }

  // El motor la llama en move/zoom/resize: el stencil vive en el framebuffer y no sobrevive al
  // reencuadre, así que el relleno se rehace entero.
  resetCanvasReference() { return this.redraw() }

  redraw() {
    if (!this.#visible || this.#surface.contextLost) return false
    const gl = this.#gl
    this.#surface.resetCanvasReference()
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT)
    const view  = readView(this.#camera, this.#view)
    const partes = this.#onScreen(view)
    // Cada polígono se cubre POR SEPARADO. Su cobertura deja el bit del stencil en cero, así que el
    // siguiente apila en vez de restarse: con una sola cobertura al final, dos polígonos superpuestos
    // se cancelan y el solape se ve como agujero. Los anillos de UNA parte sí componen entre sí —ese
    // XOR es el que abre los agujeros de verdad— porque comparten cobertura.
    let pintado = false
    for (let k = 0; k < partes.length; k++) {
      const parte = partes[k]
      if (this.#fill) {
        this.#fill.rings = parte.rings
        this.#fill.style(parte.fill)
        pintado = this.#fill.draw(view) || pintado
      }
      if (this.#stroke) {
        this.#stroke.style(parte.stroke)
        pintado = this.#stroke.draw(parte.rings, view) || pintado
      }
    }
    // El contorno sale con el stencil deshabilitado, así que no arrastra estado al pase siguiente.
    return pintado
  }

  // Al pase sólo entran los polígonos cuya caja toca el viewport: el resto no aporta un píxel y sí
  // varios draws. La lista se reusa entre repintados.
  #onScreen({ zoom, center, size }) {
    const scale = 2 ** zoom
    // El trazo vive en píxeles y la caja en mundo: a este zoom, un píxel son 1/scale unidades.
    const m     = this.#stroke ? (this.#halfWidth + FEATHER) / scale : 0
    const hx    = size.x / (2 * scale) + m
    const hy    = size.y / (2 * scale) + m
    const minX  = center.x - hx, maxX = center.x + hx
    const minY  = center.y - hy, maxY = center.y + hy
    const cajas = this.#partBox
    const out   = this.#onScreenParts
    let n = 0
    for (let k = 0, total = this.#parts.length; k < total; k++) {
      const b = k * 4
      if (cajas[b] > maxX || cajas[b + 2] < minX || cajas[b + 1] > maxY || cajas[b + 3] < minY) continue
      out[n++] = this.#parts[k]
    }
    out.length = n
    return out
  }

  /* ── Picking point-in-poly sobre las tablas tipadas: kind 'polygon', sin distancia ── */
  resolveClick(sample) { return this.#hitsAt(sample) }
  resolveHover(sample) { return this.#hitsAt(sample) }

  #hitsAt(sample) {
    if (!this.#index) return []
    // Todas las que contienen el punto: con polígonos superpuestos, quedarse con la primera esconde la
    // de abajo.
    const partes = partsAtPoint(this.#index, sample.lng, sample.lat, this.#hits)
    // Una entidad con varias piezas —un multipolígono— aporta una parte por pieza: se responde UNA vez
    // por entidad.
    const vistos = new Set()
    return partes.reduce((out, parte) => {
      const sujeto = this.#subject(parte)
      const id     = this.#idOf ? this.#idOf(sujeto) : sujeto
      vistos.has(id) || (vistos.add(id), out.push({ ref: parte, id, distancePx: 0 }))
      return out
    }, [])
  }

  // Seguro a medio construir: el alta puede fallar en cualquier paso y esto corre igual.
  destroy() {
    this.#unsub?.()
    this.#offView?.()
    this.#fill?.destroy()
    this.#stroke?.destroy()
    this.#store?.destroy()
    this.#surface.destroy()
    this.#index = null
  }
}
