// Contorno de polígonos ESTÁTICOS: un quad por segmento, armado en el vertex shader desde
// `gl_VertexID` + `texelFetch` sobre la misma textura de posiciones que usa el relleno. Sin atributos
// y sin buffer propio, así que panear y hacer zoom no reescriben un byte.
//
// La UNIÓN se resuelve por MITER, y el porqué importa: expandir cada segmento sólo a los lados deja
// sin cubrir la cuña exterior del codo —la muesca—. Taparla agrandando los quads hasta que se pisen
// cambia un defecto por otro: donde se pisan, con `opacity < 1`, el alfa se mezcla dos veces y el
// vértice queda más oscuro. El solape no se puede componer, así que la salida es no tenerlo: cada
// extremo se desplaza sobre la BISECTRIZ de sus dos segmentos, y los dos quads que comparten el
// vértice caen sobre las MISMAS dos esquinas. Sin hueco y sin solape, con un dibujo por segmento.
//
// Un anillo del store es UN rango contiguo con el cierre implícito —el vértice repetido se descartó al
// ingerir—, así que el segmento que cierra sale del módulo y no necesita el tramo suelto por uniform
// del trazo editable, que existe porque allá un anillo vive partido en chunks.

import { toRGBA } from './color.js'
import { blendOver } from './EditSurface.js'
import { sharedProgram } from './gl-programs.js'

// Medio píxel de borde a cada lado: el quad se expande lo mismo para que la rampa entre entera.
export const FEATHER = 0.5

const UNIFORMS = ['matrix', 'positions', 'texGeom', 'pixel', 'halfWidth', 'color', 'first', 'count']

const VERTEX = `#version 300 es
precision highp float;

uniform mat4      matrix;
uniform sampler2D positions;
uniform ivec2     texGeom;    // (máscara, corrimiento): índice de vértice → texel
uniform vec2      pixel;      // unidades de clip por píxel CSS
uniform float     halfWidth;
uniform int       first;      // primer vértice del anillo
uniform int       count;      // vértices del anillo; el último segmento cierra contra el primero

out float dist;               // distancia firmada al eje, en píxeles

const float FEATHER = ${FEATHER};
const vec2  QUAD[6] = vec2[6](vec2(0.0, -1.0), vec2(1.0, -1.0), vec2(0.0, 1.0),
                              vec2(0.0,  1.0), vec2(1.0, -1.0), vec2(1.0, 1.0));

vec2 positionAt(int entry) {
  return texelFetch(positions, ivec2(entry & texGeom.x, entry >> texGeom.y), 0).rg;
}

vec2 pixelAt(int entry) {
  return (matrix * vec4(positionAt(entry), 0.0, 1.0)).xy / pixel;
}

vec2 dirOf(vec2 v) {
  float len = length(v);
  return len > 0.0 ? v / len : vec2(1.0, 0.0);
}

// Desplazamiento del extremo sobre la bisectriz de los dos segmentos que lo comparten. El tope evita
// que un codo muy cerrado dispare el vértice al infinito; como los dos segmentos aplican el MISMO
// tope, siguen cayendo sobre la misma esquina y el codo se corta plano en vez de abrirse.
vec2 miter(vec2 d0, vec2 d1) {
  vec2  n1  = vec2(-d1.y, d1.x);
  vec2  sum = vec2(-d0.y, d0.x) + n1;
  float len = length(sum);
  if (len < 1e-4) return n1;            // giro de 180°: no hay bisectriz que valga
  vec2 m = sum / len;
  return m / max(dot(m, n1), 0.25);
}

void main() {
  int  edge = gl_VertexID / 6;
  int  next = edge + 1 == count ? 0 : edge + 1;
  int  prev = edge == 0 ? count - 1 : edge - 1;
  int  post = next + 1 == count ? 0 : next + 1;
  vec2 quad = QUAD[gl_VertexID % 6];

  // El anillo es cíclico, así que cada extremo SIEMPRE tiene vecino: no hay caso de punta suelta.
  vec2 pa = pixelAt(first + edge);
  vec2 pb = pixelAt(first + next);
  vec2 d1 = dirOf(pb - pa);

  float side = quad.y * (halfWidth + FEATHER);
  vec2  off  = mix(miter(dirOf(pa - pixelAt(first + prev)), d1),
                   miter(d1, dirOf(pixelAt(first + post) - pb)), quad.x);
  dist        = side;
  gl_Position = vec4((mix(pa, pb, quad.x) + off * side) * pixel, 0.0, 1.0);
}`

// El relleno por stencil da bordes duros: el AA lo aporta el contorno, como una rampa de un píxel
// sobre la distancia al eje.
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

const strokeProgram = gl => sharedProgram(gl, 'polygon-stroke', () => {
  const program = gl.createProgram()
  ;[[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, FRAGMENT]].forEach(([type, source]) => {
    const shader = gl.createShader(type)
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    gl.attachShader(program, shader)
    gl.deleteShader(shader)
  })
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS))
    throw new Error(`[cristae] el programa del contorno no linkea: ${gl.getProgramInfoLog(program)}`)
  return { program, uniform: Object.fromEntries(UNIFORMS.map(n => [n, gl.getUniformLocation(program, n)])) }
})

export class PolygonStrokePass {

  #gl; #program; #uniform; #vao
  #width = 3
  #hex   = null
  #rgba  = null

  constructor({ gl, color = '#3388ff', width = 3, opacity = 1 }) {
    const { program, uniform } = strokeProgram(gl)
    this.#gl      = gl
    this.#program = program
    this.#uniform = uniform
    this.#vao     = gl.createVertexArray()
    this.style({ color, width, opacity })
  }

  style({ color = this.#hex, width = this.#width, opacity = 1 } = {}) {
    this.#hex   = color
    this.#width = width
    this.#rgba  = toRGBA(color, opacity)
    return this
  }

  // `rings` son las MISMAS vistas que consume el relleno; la textura y su geometría son del store, así
  // que se fijan una vez y sólo el rango y la matriz cambian por anillo.
  draw(rings, view) {
    if (!rings.length || this.#width <= 0) return false
    const gl = this.#gl, u = this.#uniform
    const primera = rings[0].arena
    gl.useProgram(this.#program)
    gl.uniform2f(u.pixel, 2 / view.size.x, 2 / view.size.y)
    gl.uniform1f(u.halfWidth, this.#width / 2)
    gl.uniform4fv(u.color, this.#rgba)
    gl.uniform1i(u.positions, 0)
    gl.uniform2i(u.texGeom, primera.textureWidth - 1, Math.log2(primera.textureWidth))
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, primera.texture)
    blendOver(gl)
    gl.disable(gl.STENCIL_TEST)
    gl.disable(gl.CULL_FACE)
    gl.bindVertexArray(this.#vao)
    for (let k = 0; k < rings.length; k++) {
      const arena = rings[k].arena
      const first = arena.firstVertex
      const count = arena.lastVertex - first + 1
      if (count < 2) continue
      gl.uniformMatrix4fv(u.matrix, false, arena.matrixFor(view.zoom, view.center, view.size))
      gl.uniform1i(u.first, first)
      gl.uniform1i(u.count, count)
      gl.drawArrays(gl.TRIANGLES, 0, count * 6)
    }
    gl.bindVertexArray(null)
    return true
  }

  destroy() {
    this.#gl.deleteVertexArray(this.#vao)
  }
}
