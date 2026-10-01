// Los handles de la geometría editable como SPRITES: un draw POINTS por chunk sobre el VBO del arena,
// con los mismos shaders y el mismo pase jerárquico que la capa de puntos. Vértice y midpoint entran en
// el MISMO draw —el arena los entrelaza y la paridad del local es el kind—, así que un trazo de N
// vértices cuesta ceil(2N/cap) draws y CERO nodos DOM.
//
// El vecindario que el banco DOM promueve se apaga abriendo AGUJEROS en el rango de cada draw VISUAL,
// derivados por frame de la promoción vigente. El agujero es sólo del VISUAL: el PASE recorre el run
// entero, porque el nodo del banco es afordancia —`pointer-events: none`, nunca pickea— y sacar al
// promovido del pase lo volvería inagarrable.
import { GpuAtlasBinding } from '../atlas/GpuAtlasBinding.js'
import { defineIconSet } from '../atlas/IconSet.js'
import { ROLE } from '../geometry/ChunkedPath.js'
import { blendOver } from './EditSurface.js'
import { CHUNK_BITS } from './Picking.js'
import { linkPointProgram } from './point-program.js'

// El pase direcciona el chunk con 6 bits: de acá en adelante el ordinal no es representable.
const ORDINAL_CAP = 1 << CHUNK_BITS

// Variante y tamaño en pantalla por ROL. El rol `free` es el midpoint inactivo del último vértice de un
// trazo abierto: el tile TRANSPARENTE lo saca del visual y del picking a la vez, sin excepción en el batch.
const ROLE_VARIANT = ['off', 'vertex', 'midpoint']
const ROLE_SIZE    = [10, 12, 10]
const MAX_SIZE     = Math.max(...ROLE_SIZE)

// prev, v y next: tres vecinos que pueden vivir en tres chunks distintos.
const HOLES     = 3
const byRef     = (a, b) => a.from - b.from
const clearHole = h => { h.chunk = -1; h.from = Infinity; h.to = Infinity }

const paint = (ctx, size, d) => {
  ctx.fillStyle = d.fill
  ctx.fill()
  ctx.lineWidth = size * 0.08
  ctx.strokeStyle = d.line
  ctx.stroke()
}

const square = (ctx, size, d) => {
  const side = size * d.radius
  ctx.beginPath()
  ctx.rect((size - side) / 2, (size - side) / 2, side, side)
  paint(ctx, size, d)
}

const disc = (ctx, size, d) => {
  ctx.beginPath()
  ctx.arc(size / 2, size / 2, size * d.radius, 0, Math.PI * 2)
  paint(ctx, size, d)
}

// UNO por configuración, memoizado por módulo: el atlas es de sólo lectura y cada contexto GL tiene su
// propio binding, así que compartirlo entre editores es seguro.
const SETS = new Map()

// `hover` y `grabbing` no los dibuja la GPU —el handle bajo el dedo ya está promovido a DOM—: el banco los
// reusa por `iconSet.sprite(variante)`, así el nodo promovido muestra los MISMOS píxeles que el sprite al
// que reemplaza.
export const defineEditIconSet = ({ color = '#2563eb', accent = '#f59e0b' } = {}) => {
  const key = `${color} ${accent}`
  if (SETS.has(key)) return SETS.get(key)
  const descriptors = {
    off      : { shape: 'none' },
    vertex   : { shape: 'square', radius: 0.44, fill: '#ffffff', line: color },
    midpoint : { shape: 'disc',   radius: 0.24, fill: '#ffffff', line: color },
    hover    : { shape: 'square', radius: 0.52, fill: accent,    line: '#ffffff' },
    grabbing : { shape: 'square', radius: 0.44, fill: color,     line: '#ffffff' },
  }
  const set = defineIconSet({
    variants  : Object.keys(descriptors),
    sizes     : { canvas: 32, default: MAX_SIZE },
    describe  : variant => descriptors[variant] ?? descriptors.off,
    renderers : { square, disc, none: () => {} },
  })
  SETS.set(key, set)
  return set
}

// Canales del arena por ROL: el tile ya normalizado por la capacidad del atlas, y el tamaño en pantalla.
// El set de edición es CERRADO (cinco variantes en una capacidad de dieciséis), así que nunca hay regrow
// y el canal de un rol no se mueve bajo los datos ya escritos.
//
// `scale` lleva el tamaño a píxeles del FRAMEBUFFER, que es la unidad de `gl_PointSize`: sobre una
// superficie a DPR el handle mediría la mitad de lo que declara, mientras el nodo que lo releva en el
// banco DOM sigue midiendo lo declarado.
export const editHandleChannels = (iconSet, scale = 1) => ({
  tiles : ROLE_VARIANT.map(v => iconSet.atlas.tileChannel(iconSet.resolve(v))),
  sizes : ROLE_SIZE.map(s => s * scale),
})

export class EditHandleLayer {

  #gl; #arena; #path; #picking; #iconSet; #binding
  #program = null
  #uMatrix = null
  #vao     = null
  #view    = null

  #promoted  = -1
  #rev       = -1
  #holes     = Array.from({ length: HOLES }, () => ({ chunk: -1, from: Infinity, to: Infinity }))
  #holeCount = 0

  #rect  = new Float64Array(4)             // viewport en rel-ancla, con margen de sprite
  #box   = new Float64Array(4)             // salida de boxOfChunk, reusada [0-alloc]
  #draws = []                              // pool de PickDraw; `#batch.length` dice cuántos valen
  #batch = { draws: this.#draws, length: 0, matrix: null }
  #hit   = { ref: -1, metadata: null }

  // La identidad que le asigna el motor. El pase descarta el objeto 0.
  pickObject = 0

  constructor({ gl, arena, path, picking, iconSet = defineEditIconSet() }) {
    this.#gl      = gl
    this.#arena   = arena
    this.#path    = path
    this.#picking = picking
    this.#iconSet = iconSet
    this.#binding = new GpuAtlasBinding(gl)

    ;({ program: this.#program, vao: this.#vao } = linkPointProgram(gl, arena.vbo))
    this.#uMatrix = gl.getUniformLocation(this.#program, 'matrix')

    this.#binding.register(this.#program)
    this.#binding.register(picking.attach(gl, this.#program))
  }

  get iconSet()  { return this.#iconSet }
  get promoted() { return this.#promoted }

  // El vértice cuyo vecindario toma el banco DOM (-1 = ninguno). Sólo abre agujeros: no escribe un byte.
  promote(ref) {
    if (ref === this.#promoted) return this
    this.#promoted = ref
    this.#rehole()
    return this
  }

  draw(view) {
    const gl     = this.#gl
    // El viewport en rel-ancla, con el sprite más grande como margen: un handle centrado justo afuera
    // del recorte todavía asoma media silueta.
    const scale  = 2 ** view.zoom
    const margin = MAX_SIZE / scale
    const anchor = this.#arena.anchor
    const x      = view.center.x - anchor.x - view.size.x / (2 * scale)
    const y      = view.center.y - anchor.y - view.size.y / (2 * scale)
    const r      = this.#rect
    r[0] = x - margin
    r[1] = y - margin
    r[2] = x + view.size.x / scale + margin
    r[3] = y + view.size.y / scale + margin
    this.#view = view
    // Cualquier escritura del trazo puede mover al vecino de chunk o cambiar quién es —`setClosed` le da
    // vecino al primer vértice sin tocar la estructura—: la revisión que manda es la de escritura.
    if (this.#rev !== this.#path.rev) {
      this.#rev = this.#path.rev
      this.#rehole()
    }
    this.#binding.sync(this.#iconSet.atlas)
    gl.useProgram(this.#program)
    gl.uniformMatrix4fv(this.#uMatrix, false, this.#matrix())
    blendOver(gl)
    gl.bindVertexArray(this.#vao)
    this.#arena.eachRange(this.#drawRange)
    gl.bindVertexArray(null)
    return this
  }

  // Un PickDraw por chunk VISIBLE, con `bind` estable y el ORDINAL como chunk. Scratch reusado: vale
  // hasta el próximo pedido. Sin vista todavía no hay nada que pickear.
  pickBatch() {
    const batch = this.#batch
    batch.length = 0
    if (!this.#view) return batch
    batch.matrix = this.#matrix()
    this.#arena.eachRange(this.#pickRange)
    return batch
  }

  // Click: la respuesta tiene que llegar dentro del mismo gesto.
  pickRef(cx, cy) { return this.#refOf(this.#picking.pickSync(cx, cy, this.pickBatch(), null)) }

  // Hover: el pase no bloquea y `metadata` vuelve con el resultado para atarlo a su muestra.
  requestPick(cx, cy, metadata) { return this.#picking.request(cx, cy, this.pickBatch(), metadata) }

  // Scratch reusado, válido hasta el próximo collect.
  collectPick() {
    const got = this.#picking.collect()
    if (!got) return null
    this.#hit.ref      = this.#refOf(got)
    this.#hit.metadata = got.metadata
    return this.#hit
  }

  destroy() {
    const gl = this.#gl
    gl.deleteVertexArray(this.#vao)
    gl.deleteProgram(this.#program)
    this.#binding.destroy()
    this.#vao = this.#program = this.#view = null
    return this
  }

  // Un draw por chunk visible, partido por los agujeros del vecindario promovido —esas entradas las
  // dibuja el banco DOM—. Las dos travesías son arrows estables: la ruta queda [0-alloc].
  #drawRange = (_ordinal, first, count, chunk) => {
    if (count <= 0 || !this.#inView(chunk)) return
    const end = first + count
    let from  = first
    for (let i = 0; i < this.#holeCount; i++) {
      const h = this.#holes[i]
      if (h.chunk !== chunk) continue
      this.#span(from, h.from)
      from = Math.max(from, h.to)
    }
    this.#span(from, end)
  }

  #span(from, to) {
    if (to > from) this.#gl.drawArrays(this.#gl.POINTS, from, to - from)
  }

  // El run ENTERO, agujeros incluidos. Un ordinal ≥ 64 no entra: el pase lo atribuiría por módulo a otro
  // chunk y el hit volvería como un ref AJENO. Fuera del batch degrada a «no pickeable», que es recuperable.
  #pickRange = (ordinal, first, count, chunk) => {
    if (count <= 0 || ordinal >= ORDINAL_CAP || !this.#inView(chunk)) return
    const n = this.#batch.length
    const d = this.#draws[n] ??= { bind: this.#bind, texture: this.#binding.texture,
      mode: this.#gl.POINTS, first: 0, count: 0, obj: 0, chunk: 0 }
    d.first = first
    d.count = count
    d.chunk = ordinal
    d.obj   = this.pickObject
    this.#batch.length = n + 1
  }

  #bind = () => this.#gl.bindVertexArray(this.#vao)

  // prev, su midpoint, v, su midpoint y next: cinco entradas vivas que el banco DOM ya dibuja. El
  // vecindario sale de la LISTA, nunca de aritmética sobre el ref: en un anillo el vecino vive en el
  // chunk más lejano del arena, y un intervalo único taparía todo lo que hay en medio.
  #rehole() {
    const path = this.#path
    const v    = this.#promoted
    this.#holes.forEach(clearHole)
    this.#holeCount = 0
    if (path.roleAt(v) !== ROLE.vertex) return
    const prev = path.prevVertex(v)
    const next = path.nextVertex(v)
    prev >= 0 && this.#hole(prev, 2)
    this.#hole(v, 2)
    next >= 0 && this.#hole(next, 1)
    this.#holes.sort(byRef)                  // el anillo puede poner al vecino ANTES del promovido
  }

  #hole(ref, entries) {
    const h = this.#holes[this.#holeCount++]
    h.chunk = this.#path.chunkOf(ref)
    h.from  = ref
    h.to    = ref + entries
  }

  #matrix() { return this.#arena.matrixFor(this.#view.zoom, this.#view.center, this.#view.size) }

  #inView(chunk) {
    const b = this.#arena.boxOfChunk(chunk, this.#box)
    const r = this.#rect
    return b[0] <= r[2] && b[2] >= r[0] && b[1] <= r[3] && b[3] >= r[1]
  }

  // (ordinal, local) → el ref del `ChunkedPath`. Un impacto sin entrada (local 0 en el pase) es el cuerpo
  // del objeto, no un handle, y no tiene ref.
  #refOf(got) {
    if (!got) return -1
    const hits = got.hits
    const i    = hits.firstOf(this.pickObject)
    return i < 0 || hits.slots[i] < 0 ? -1 : this.#arena.refAt(hits.chunks[i], hits.slots[i])
  }
}
