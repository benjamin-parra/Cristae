import { prepareIndex, nearest, toParts } from '../geometry/polyline.js'
import { toRGBA, toColorObj, DEFAULT_COLOR } from './color.js'

// Capa de LÍNEAS GL sobre glify.Lines. Hermana de PointLayer: envuelve la instancia glify (su
// rebuild `setData` y su draw `gl.LINES` intactos) y le AÑADE el color per-vértice para el gradiente
// escribiendo el buffer interleaved por bufferSubData (bypass, sin fork ni monkey-patch). Igual
// patrón que PointLayer. El grosor por brocha se normaliza a px (`brushRadius`); su costo de draw
// cuadrático es una limitación conocida.
//
// Layout glify.Lines: [x, y, r, g, b, a] (bytes=6), buffer 'vertex'. El color se guarda POR
// vértice pero glify sólo lo ASIGNA por feature (colorFn per-feature); el gradiente sobre-escribe
// los canales r,g,b,a por vértice.
//
// Multi-parte: el feature se emite como MultiLineString y glify arma una LineFeatureVertices por
// parte, contiguas y en orden. Cada parte de K puntos ocupa 2·(K−1) vértices (duplica los interiores
// para gl.LINES) y su vértice v mapea al punto ⌈v/2⌉ DE ESA parte → el mapeo buffer↔dato se guarda
// por parte (`runs`). Una parte de 1 punto daría un vértice suelto que desalinea el pairing de
// gl.LINES; `toParts` ya las descarta.
//
// Picking: CPU nearest-segment (geometry/polyline.js) — glify.Lines no tiene picking GPU y su
// color per-vértice ES el color visible (no quedan bits para un id). kind 'line', distancePx real.

const DEFAULT_WEIGHT = 3
const HIT_TOL_PX = 8
const BYTES = 6

// path point index del vértice v DE UNA PARTE: v=0→0, v=1,2→1, v=3,4→2, … (interiores duplicados).
const pathIndexOf = (v) => (v + 1) >> 1

// `styleOf.weight` es el GROSOR EN PX de pantalla — el mismo significado que en el backend Leaflet.
// glify no recibe un grosor: recibe el RADIO de una brocha que barre ±w en pasos de 0.5 sobre una
// línea de 1px, así que rinde 2w+1 px de ancho y (4w+1)² pasadas de dibujo. Sin esta conversión el
// backend GL dibuja al doble de grosor que el Leaflet con el mismo `styleOf`, y paga 4× las pasadas.
const brushRadius = (px) => Math.max((px - 1) / 2, 0)

export class LineLayer {

  #glify; #map; #pane; #source; #interactive
  #accessors
  #layer        = null
  #styleArr     = []               // por FEATURE: { weight, color:{r,g,b,a} } — glify pide color con featureIndex
  #weightByPart = []               // por PARTE: glify pide weight con el índice de parte (ver #create)
  #features     = []               // por feature (orden del buffer): { item, runs: [{ vertOffset, vertCount, from }] }
  #index        = { sorted: [] }   // índice espacial nearest-segment (picking)
  #maxWeight    = DEFAULT_WEIGHT   // grosor máximo vigente → tolerancia de hit (líneas gruesas pican más fácil)

  // Espejo del buffer GL (recapturado en cada rebuild — glify reasigna allVerticesTyped).
  #verts = null; #buf = null
  #gradient = false
  #unsub = null

  constructor({ glify, map, pane, source, interactive = false }) {
    this.#glify = glify
    this.#map = map
    this.#pane = pane
    this.#source = source
    this.#accessors = source.accessors
    this.#interactive = interactive
    this.#gradient = !!(this.#accessors.scalarOf && this.#accessors.colorRamp)
    this.#unsub = source.subscribe(() => this.#onChange())
    this.#onChange()
  }

  get count() { return this.#features.length }

  /* ── Lifecycle (el motor invoca redraw/reset en move/zoom/resize; #trackGl) ── */

  redraw() { this.#layer?.layer.redraw() }
  syncPickingSize() {}                              // sin picking GPU
  resetCanvasReference() { this.#layer?.layer._reset() }
  refresh() { if (this.#layer) this.#rebuild(this.#source.getSnapshot()) }

  destroy() {
    this.#unsub?.()
    this.#layer?.remove()
    this.#layer = null
  }

  /* ── Picking CPU (nearest-segment); el registro envuelve las partes con layerId/kind/z/order ── */

  resolveClick(baseEvent) { return this.#hitsAt(baseEvent) }
  resolveHover(baseEvent) { return this.#hitsAt(baseEvent) }

  #hitsAt(baseEvent) {
    if (!this.#interactive || !baseEvent?.latlng || !this.#index.sorted.length) return []
    const scale = 2 ** this.#map.getZoom()          // world0 px · 2^zoom = screen px
    const tolPx = HIT_TOL_PX + this.#maxWeight / 2   // el trazo grueso capta desde su borde, no su eje
    const hits = nearest(baseEvent.latlng.lat, baseEvent.latlng.lng, this.#index, tolPx / scale)
    return hits.map(h => ({
      ref: h.id, id: h.id, distancePx: h.dist * scale,
      partIndex: h.partIndex, vertexIndex: h.vertexIndex,
    }))
  }

  /* ── Reacción al Source (ya coalescida a rAF por el Emitter) ── */
  // El estilo y la geometría son ESTADO (accessors styleOf/pathOf); cambiarlos = mutar el item y
  // set/patch la Source → cae acá. Hoy siempre rebuild (correcto; el coalescing acota a ≤1/flush).
  // El fast-path incremental —cuando el set y los largos no cambian, reescribir sólo los rangos
  // sucios (dirtyIds) por bufferSubData ([0-alloc])— es una optimización INTERNA de este método,
  // que decide el motor, NO una API imperativa de restyle.
  #onChange() { this.#rebuild(this.#source.getSnapshot()) }

  /* ── Rebuild (O(n); glify.setData rehace el buffer, luego #bind re-captura y pinta el gradiente) ── */

  #rebuild(snap) {
    const a = this.#accessors
    const built = snap
      .map((item) => {
        const parts = toParts(a.pathOf(item))
        const st = a.styleOf?.(item)
        return { item, id: a.idOf(item), paths: parts.map(p => p.path), parts, st }
      })
      .filter(({ parts }) => parts.length)

    this.#styleArr = built.map(({ st }) => ({
      weight: st?.weight ?? DEFAULT_WEIGHT,
      color: toColorObj(st?.color ?? DEFAULT_COLOR, st?.opacity ?? 1),
    }))
    // glify pide el weight por PARTE (drawOnCanvas recorre `vertices`), y lo quiere como radio de
    // brocha, no como px. El `#maxWeight` de la tolerancia de hit se queda en px.
    this.#weightByPart = built.flatMap(({ parts }, f) => parts.map(() => brushRadius(this.#styleArr[f].weight)))
    this.#maxWeight = this.#styleArr.reduce((m, s) => Math.max(m, s.weight), DEFAULT_WEIGHT)

    // glify emite las partes contiguas y en orden → el offset avanza parte a parte, no feature a
    // feature; el prefijo es secuencial por naturaleza.
    let vertOffset = 0
    const runsOf = (parts) => parts.map(({ path, from }) => {
      const run = { vertOffset, vertCount: 2 * (path.length - 1), from }
      vertOffset += run.vertCount
      return run
    })
    this.#features = built.map(({ item, parts }) => ({ item, runs: runsOf(parts) }))

    const fc = {
      type: 'FeatureCollection',
      features: built.map(({ paths }) => ({
        type: 'Feature', geometry: { type: 'MultiLineString', coordinates: paths },
      })),
    }
    if (!this.#layer) this.#create(fc)
    else this.#layer.setData(fc)

    this.#bind()                                                     // re-captura el espejo + gradiente + upload
    this.#index = prepareIndex(built)
    this.#layer.layer.redraw()
  }

  #create(fc) {
    this.#layer = this.#glify.lines({
      map: this.#map,
      pane: this.#pane,
      data: fc,
      latitudeKey: 0,
      longitudeKey: 1,
      sensitivity: 0,                                                // irrelevante: sin `click`/`hover` glify NO registra su handler
      sensitivityHover: 0,
      // 🔴 Los dos callbacks NO reciben el mismo índice: `resetVertices` pide el color con el índice
      // de FEATURE, y `drawOnCanvas` pide el weight recorriendo `vertices`, que tiene una entrada por
      // PARTE. Con features de una sola parte coinciden por accidente; con MultiLineString, no.
      color: (i) => this.#styleArr[i].color,                        // per-feature; para gradiente es placeholder
      weight: (i) => this.#weightByPart[i],
    })
    if (this.#layer.bytes !== BYTES)
      throw new Error('[cristae] glify.Lines layout != 6; abortar path de color per-vértice')
  }

  // Recaptura el espejo (glify reasigna allVerticesTyped en cada render), pinta el gradiente en él y
  // re-sube el buffer con hint DYNAMIC (apto a restyle por bufferSubData). El gradiente sobrevive
  // pan/zoom: glify sólo re-compone la matriz en _reset, no re-ejecuta resetVertices.
  #bind() {
    const gl = this.#layer.gl
    this.#buf = this.#layer.getBuffer('vertex')
    this.#verts = this.#layer.allVerticesTyped
    if (this.#gradient) this.#applyGradient()
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#buf)
    gl.bufferData(gl.ARRAY_BUFFER, this.#verts, gl.DYNAMIC_DRAW)
  }

  // Color per-vértice desde scalarOf+colorRamp (genérico: el core no interpreta el escalar). O(vértices),
  // sólo en rebuild. El shader de glify interpola _color entre los vértices → gradiente por segmento.
  #applyGradient() {
    const a = this.#accessors
    const v = this.#verts
    this.#features.forEach(({ item, runs }) => runs.forEach(({ vertOffset, vertCount, from }) => {
      for (let k = 0; k < vertCount; k++) {
        const c = toRGBA(a.colorRamp(a.scalarOf(item, from + pathIndexOf(k))))
        const o = (vertOffset + k) * BYTES + 2
        v[o] = c[0]; v[o + 1] = c[1]; v[o + 2] = c[2]; v[o + 3] = c[3]
      }
    }))
  }

}
