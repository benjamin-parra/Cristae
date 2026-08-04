// El trazo de la geometría editable: un quad por SEGMENTO, expandido en el vertex shader desde
// `gl_VertexID` + `texelFetch` sobre la textura de posiciones del arena. Sin atributos y sin buffer
// propio —el ancho vive en píxeles y el desplazamiento lo absorbe la matriz—, así que panear y hacer
// zoom no reescriben un byte, igual que los handles.
//
// El contorno lo dibuja este renderer y no `glify.Lines`: el contexto propio que el stencil del relleno
// ya exige no suma un segundo, el antialiasing queda garantizado a nivel de píxel y desaparece el
// desfase durante la animación del zoom.
//
// Un segmento sale de DOS entradas, y el arena sólo las garantiza contiguas DENTRO del run de un chunk:
// la que arranca en el último vértice del run —la costura con el chunk siguiente, o el cierre del
// anillo— se dibuja SUELTA, con los dos extremos por uniform. Es la misma pieza con la que viaja el
// vértice en arrastre, así que el arrastre tampoco escribe.
//
// Sin uniones: cada vértice lleva encima su handle (≥ 10 px), así que la cuña que deja un codo en un
// trazo de pocos píxeles queda tapada. Un disco por vértice pagaría el doble blend del AA en cada codo
// —una cuenta más oscura sobre trazo translúcido— a cambio de nada visible.
import { ROLE } from '../geometry/ChunkedPath.js'
import { toRGBA } from './color.js'
import { programaCompartido } from './gl-programs.js'

// Medio píxel de borde a cada lado: el quad se expande lo mismo para que la rampa entre entera.
const FEATHER = 0.5

// Dos triángulos por segmento y dos entradas del arena por segmento. El arranque del rango viaja por
// uniform y no en el `first` del draw: `LOCAL_CAP` es IMPAR, así que el ref de un vértice no tiene
// paridad fija y `gl_VertexID` no alcanza para reconstruir la entrada.
const ESQUINAS = 6

const UNIFORMS = ['matrix', 'positions', 'texGeom', 'pixel', 'halfWidth', 'color', 'base', 'loose', 'useLoose']

const VERTEX = paso => `#version 300 es
precision highp float;

uniform mat4      matrix;
uniform sampler2D positions;
uniform ivec2     texGeom;    // (máscara, corrimiento): índice de entrada → texel
uniform vec2      pixel;      // unidades de clip por píxel CSS
uniform float     halfWidth;
uniform int       base;       // entrada del arena donde arranca el rango
uniform vec4      loose;      // extremos del segmento suelto, en rel-ancla
uniform bool      useLoose;

out float dist;               // distancia firmada al eje, en píxeles

const float FEATHER = ${FEATHER};
const vec2  QUAD[6] = vec2[6](vec2(0.0, -1.0), vec2(1.0, -1.0), vec2(0.0, 1.0),
                              vec2(0.0,  1.0), vec2(1.0, -1.0), vec2(1.0, 1.0));

vec2 posicion(int entrada) {
  return texelFetch(positions, ivec2(entrada & texGeom.x, entrada >> texGeom.y), 0).rg;
}

void main() {
  int   entrada = base + gl_VertexID / 6 * ${paso};
  vec2  quad    = QUAD[gl_VertexID % 6];
  vec2  a       = useLoose ? loose.xy : posicion(entrada);
  vec2  b       = useLoose ? loose.zw : posicion(entrada + ${paso});
  vec2  pa      = (matrix * vec4(a, 0.0, 1.0)).xy / pixel;
  vec2  pb      = (matrix * vec4(b, 0.0, 1.0)).xy / pixel;
  vec2  eje     = pb - pa;
  float largo   = length(eje);
  vec2  normal  = largo > 0.0 ? vec2(-eje.y, eje.x) / largo : vec2(0.0);
  float lado    = quad.y * (halfWidth + FEATHER);
  dist          = lado;
  gl_Position   = vec4((mix(pa, pb, quad.x) + normal * lado) * pixel, 0.0, 1.0);
}`

// El relleno por stencil da bordes duros: el AA del contorno lo aporta esta capa, como una rampa de un
// píxel sobre la distancia al eje.
const FRAGMENT = `#version 300 es
precision highp float;

uniform float halfWidth;
uniform vec4  color;

in  float dist;
out vec4  fragColor;

const float FEATHER = ${FEATHER};

void main() {
  fragColor = vec4(color.rgb, color.a * (1.0 - smoothstep(halfWidth - FEATHER, halfWidth + FEATHER, abs(dist))));
}`

// El programa del trazo con las ubicaciones de sus uniformes, por (contexto, paso): el fuente sólo
// depende del paso, y el resto —ancho, color, matriz— viaja por draw, que es de la capa.
const programaDelTrazo = (gl, paso) => programaCompartido(gl, `trazo:${paso}`, () => {
  const program = gl.createProgram()
  ;[[gl.VERTEX_SHADER, VERTEX(paso)], [gl.FRAGMENT_SHADER, FRAGMENT]].forEach(([type, source]) => {
    const shader = gl.createShader(type)
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    gl.attachShader(program, shader)
    gl.deleteShader(shader)              // el programa las retiene hasta el link
  })
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS))
    throw new Error(`[cristae] el programa del trazo no linkea: ${gl.getProgramInfoLog(program)}`)
  return { program, uniform: Object.fromEntries(UNIFORMS.map(n => [n, gl.getUniformLocation(program, n)])) }
})

export class EditStrokeLayer {

  #gl; #arena; #path; #project; #paso; #porEntrada
  #program = null
  #uniform = null
  #vao     = null

  #width = 3
  #hex   = null
  #rgba  = null

  #promoted  = -1
  #prev      = -1
  #next      = -1
  #rev       = -1
  #holes     = new Int32Array(2)
  #holeCount = 0
  #lx        = 0                           // la posición VIVA del promovido, en rel-ancla
  #ly        = 0

  #rect = new Float64Array(4)              // viewport en rel-ancla, con el ancho como margen
  #box  = new Float64Array(4)              // salida de boxOfChunk, reusada [0-alloc]
  #xy   = new Float64Array(2)              // salida de project, reusada [0-alloc]

  constructor({ gl, arena, path, project, width = 3, color = '#2563eb', paso = 2 }) {
    const compartido = programaDelTrazo(gl, paso)
    this.#gl         = gl
    this.#paso       = paso
    this.#porEntrada = ESQUINAS / paso
    this.#arena   = arena
    this.#path    = path
    this.#project = project
    this.#program = compartido.program
    this.#uniform = compartido.uniform
    this.#vao     = gl.createVertexArray() // sin atributos: el VAO sólo aísla el estado que dejó otra capa
    this.style({ width, color })
  }

  get promoted() { return this.#promoted }

  // El ancho vive en píxeles y el color en un uniform: restilar no toca la GPU.
  style({ width = this.#width, color = this.#hex } = {}) {
    this.#width = width
    this.#hex   = color
    this.#rgba  = toRGBA(color)
    return this
  }

  // El vértice que el banco DOM arrastra (-1 = ninguno). Sus dos segmentos salen del pase estático, y la
  // posición viva arranca donde está el commit: promover sin mover ya dibuja bien.
  promote(ref) {
    if (ref === this.#promoted) return this
    this.#promoted = ref
    this.#renew()
    return ref < 0 ? this : this.#at(this.#arena.relX(ref), this.#arena.relY(ref))
  }

  // La posición viva del promovido, en coordenadas del trazo.
  live(x, y) {
    this.#project(x, y, this.#xy)
    return this.#at(this.#xy[0] - this.#arena.anchor.x, this.#xy[1] - this.#arena.anchor.y)
  }

  draw(view) {
    const gl = this.#gl
    const u  = this.#uniform
    this.#setView(view)
    this.#sync()
    gl.useProgram(this.#program)
    gl.uniformMatrix4fv(u.matrix, false, this.#arena.matrixFor(view.zoom, view.center, view.size))
    gl.uniform2f(u.pixel, 2 / view.size.x, 2 / view.size.y)
    gl.uniform1f(u.halfWidth, this.#width / 2)
    gl.uniform4fv(u.color, this.#rgba)
    gl.uniform2i(u.texGeom, this.#arena.textureWidth - 1, Math.log2(this.#arena.textureWidth))
    gl.uniform1i(u.positions, 0)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.#arena.texture)
    // El trazo no se recorta contra el stencil del relleno ni depende del giro del quad.
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    gl.disable(gl.STENCIL_TEST)
    gl.disable(gl.CULL_FACE)
    gl.bindVertexArray(this.#vao)
    gl.uniform1i(u.useLoose, 0)
    this.#arena.eachRange(this.#range)
    gl.uniform1i(u.useLoose, 1)
    this.#arena.eachRange(this.#seam)
    this.#drag()
    gl.bindVertexArray(null)
    return this
  }

  // El VAO es de esta capa; el programa es del contexto y lo comparten todos los trazos.
  destroy() {
    this.#gl.deleteVertexArray(this.#vao)
    this.#vao = this.#program = null
    return this
  }

  /* ── Rangos de draw ─────────────────────────────────────────────────────────────────────── */

  // Un draw por chunk visible: los segmentos cuyo otro extremo es contiguo en el run. El promovido abre
  // AGUJEROS en el rango, derivados por frame de la promoción vigente y no de estado residente.
  #range = (_ordinal, first, count, chunk) => {
    const end = first + count - this.#paso   // la última entrada arranca la costura, y va suelta
    if (end <= first || !this.#inView(chunk)) return
    let from = first
    for (let i = 0; i < this.#holeCount; i++) {
      const h = this.#holes[i]
      if (h < from || h >= end) continue
      this.#span(from, h)
      from = h + this.#paso
    }
    this.#span(from, end)
  }

  #span(from, to) {
    if (to <= from) return
    this.#gl.uniform1i(this.#uniform.base, from)
    this.#gl.drawArrays(this.#gl.TRIANGLES, 0, (to - from) * this.#porEntrada)
  }

  // El vértice que cierra el run no tiene al siguiente contiguo: su segmento sale suelto. Que no exista
  // es el final del trazo abierto, y que exista en el último chunk es el cierre del anillo.
  #seam = (_ordinal, first, count) => {
    if (count <= 0) return
    const a = first + count - this.#paso
    const b = this.#path.nextVertex(a)
    if (b < 0 || a === this.#promoted || a === this.#prev) return
    this.#loose(this.#arena.relX(a), this.#arena.relY(a), this.#arena.relX(b), this.#arena.relY(b))
  }

  // Los dos segmentos vivos del arrastre: el promovido viaja por uniform, sin una sola escritura.
  #drag() {
    const arena = this.#arena
    this.#prev >= 0 && this.#loose(arena.relX(this.#prev), arena.relY(this.#prev), this.#lx, this.#ly)
    this.#next >= 0 && this.#loose(this.#lx, this.#ly, arena.relX(this.#next), arena.relY(this.#next))
  }

  // Un quad con los extremos por uniform, culleado por SU caja: un chunk fuera de vista no dice nada de
  // la costura que sale de él, y el cierre del anillo une los dos extremos del arena.
  #loose(ax, ay, bx, by) {
    const r = this.#rect
    if (Math.max(ax, bx) < r[0] || Math.min(ax, bx) > r[2]) return
    if (Math.max(ay, by) < r[1] || Math.min(ay, by) > r[3]) return
    this.#gl.uniform4f(this.#uniform.loose, ax, ay, bx, by)
    this.#gl.drawArrays(this.#gl.TRIANGLES, 0, ESQUINAS)
  }

  /* ── El vecindario promovido ────────────────────────────────────────────────────────────── */

  // Cualquier escritura del trazo puede mudar de chunk al vecino o estrenarle uno —`setClosed` le da
  // anterior al primer vértice sin tocar la estructura—, así que la revisión que manda es la de escritura.
  #sync() {
    if (this.#rev !== this.#path.rev) this.#renew()
  }

  // Los dos segmentos que tocan al promovido. El vecindario sale de la LISTA, nunca de aritmética sobre
  // el ref: en un anillo el vecino vive en el chunk más lejano del arena.
  #renew() {
    const path = this.#path
    const v    = this.#promoted
    this.#rev  = path.rev
    this.#prev = this.#next = -1
    this.#holeCount = 0
    if (path.roleAt(v) !== ROLE.vertex) return
    this.#prev = path.prevVertex(v)
    this.#next = path.nextVertex(v)
    this.#prev >= 0 && this.#hole(this.#prev)
    this.#next >= 0 && this.#hole(v)
    this.#holeCount === 2 && this.#holes.sort()   // el anillo puede poner al anterior DESPUÉS del promovido
  }

  #hole(ref) { this.#holes[this.#holeCount++] = ref }

  #at(x, y) {
    this.#lx = x
    this.#ly = y
    return this
  }

  /* ── Vista ──────────────────────────────────────────────────────────────────────────────── */

  // El viewport en rel-ancla, con el semiancho del trazo como margen: un segmento que roza el recorte
  // todavía pinta su borde adentro.
  #setView(view) {
    const scale  = 2 ** view.zoom
    const margen = (this.#width / 2 + FEATHER) / scale
    const anchor = this.#arena.anchor
    const x = view.center.x - anchor.x - view.size.x / (2 * scale)
    const y = view.center.y - anchor.y - view.size.y / (2 * scale)
    const r = this.#rect
    r[0] = x - margen
    r[1] = y - margen
    r[2] = x + view.size.x / scale + margen
    r[3] = y + view.size.y / scale + margen
  }

  #inView(chunk) {
    const b = this.#arena.boxOfChunk(chunk, this.#box)
    const r = this.#rect
    return b[0] <= r[2] && b[2] >= r[0] && b[1] <= r[3] && b[3] >= r[1]
  }
}
