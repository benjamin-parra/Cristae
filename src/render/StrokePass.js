// Contorno de anillos y polilíneas ESTÁTICOS: un quad por segmento, armado en el vertex shader desde
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
//
// `closed` distingue anillo de polilínea: un path abierto tiene un segmento menos y dos extremos sin
// vecino, donde no hay bisectriz y el quad se corta plano.
//
// El DASH es un patrón en píxeles de pantalla que corre a lo largo del anillo y no se reinicia en los
// vértices. La posición sobre el anillo sale de una segunda textura con el largo acumulado por vértice
// (la del store, en world0 px: no depende del zoom, y `scale` la baja a pantalla), más el largo del
// propio segmento, que se mide en el shader. Cada segmento lleva su coordenada LOCAL —cuánto avanzó
// desde su origen— y la fase del patrón en ese origen: restar el largo acumulado en el vertex shader
// deja en el varying sólo números chicos, y la precisión de la interpolación no se degrada con el
// largo del recorrido. El patrón vive en el fragment shader como distancia firmada: cada trazo del
// patrón es un tramo del eje con su tapa, y la unión de todos los que rozan al fragmento da el
// contorno, así la tapa redonda de un trazo cruza al período vecino sin casos aparte.
//
// El GRADIENTE (`gradient`) pinta cada segmento con una rampa entre los colores de sus dos vértices, que
// salen de una tercera textura RGBA8 con el mismo índice que la de posiciones. El color por vértice
// reemplaza al del trazo, y la opacidad del trazo —la que ya trae el foco— multiplica su alfa.
//
// La TAPA (`cap`) vale para cada trazo del patrón y, sin dash, para los dos extremos de una polilínea
// abierta: el quad se estira `halfWidth` más allá del extremo y el fragment shader la recorta.

import { toRGBA } from './color.js'
import { blendOver } from './EditSurface.js'
import { sharedProgram } from './gl-programs.js'

// Medio píxel de borde a cada lado: el quad se expande lo mismo para que la rampa entre entera.
export const FEATHER = 0.5

// Valores del patrón que caben en el uniform, ya con los impares repetidos (`[a, b, c]` es `[a, b, c,
// a, b, c]`: así lo define `stroke-dasharray`, que es el vocabulario del patrón).
const MAX_DASH = 16
const CAPS     = { butt: 0, round: 1, square: 2 }

// Un patrón que no cabe en el uniform es un error del estilo, no del dibujo: las capas lo comprueban al
// resolver el estilo, para que lance desde quien cargó los datos y nunca desde un repintado.
const dashLength = dash => {
  const n = Array.isArray(dash) ? dash.length : 0
  if (n * (n & 1 ? 2 : 1) > MAX_DASH)
    throw new RangeError(`[cristae] dash admite hasta ${MAX_DASH} valores (los impares cuentan doble) y recibió ${n}`)
  return n
}

// El patrón que guarda una capa es una COPIA: el trazo lo reconoce por identidad, y el arreglo del
// consumidor puede mutarse en sitio antes del `set` que lo publica.
export const ownDash = dash => (dashLength(dash) ? dash.slice() : null)

// «Sin límite» de un extremo que no existe; se pisa con cualquier distancia real.
const FAR = 1e9

const UNIFORMS = ['matrix', 'positions', 'arcs', 'colors', 'texGeom', 'pixel', 'scale', 'halfWidth', 'color', 'first', 'count',
                  'closed', 'dash', 'dashCount', 'period', 'cap', 'gradient']

const VERTEX = `#version 300 es
precision highp float;

uniform mat4      matrix;
uniform sampler2D positions;
uniform sampler2D arcs;       // largo acumulado por vértice, en world0 px; sólo se lee con dash
uniform sampler2D colors;     // color por vértice; sólo se lee con gradient
uniform vec4      color;      // el del trazo; con gradient, su alfa es la opacidad
uniform int       gradient;   // 1 = el color sale de la textura colors
uniform ivec2     texGeom;    // (máscara, corrimiento): índice de vértice → texel
uniform vec2      pixel;      // unidades de clip por píxel CSS
uniform float     scale;      // píxeles CSS por world0 px
uniform float     halfWidth;
uniform int       first;      // primer vértice del anillo
uniform int       count;      // vértices del rango
uniform int       closed;     // 1 = el último segmento cierra contra el primero; 0 = polilínea abierta
uniform int       dashCount;  // 0 = trazo continuo
uniform float     period;     // largo de una vuelta del patrón, en píxeles
uniform int       cap;        // 0 = butt · 1 = round · 2 = square

out vec4  tint;               // color del fragmento antes de la rampa del borde
out float dist;               // distancia firmada al eje, en píxeles
out float along;              // avance sobre el eje desde el origen del segmento, en píxeles
flat out vec4 frame;          // (fase del patrón en el origen, largo previo a esa vuelta, inicio y fin del trazo)

const float FEATHER = ${FEATHER};
const float FAR     = ${FAR.toExponential()};
const vec2  QUAD[6] = vec2[6](vec2(0.0, -1.0), vec2(1.0, -1.0), vec2(0.0, 1.0),
                              vec2(0.0,  1.0), vec2(1.0, -1.0), vec2(1.0, 1.0));

vec2 positionAt(int entry) {
  return texelFetch(positions, ivec2(entry & texGeom.x, entry >> texGeom.y), 0).rg;
}

vec4 colorAt(int entry) {
  return texelFetch(colors, ivec2(entry & texGeom.x, entry >> texGeom.y), 0);
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

  vec2 pa = pixelAt(first + edge);
  vec2 pb = pixelAt(first + next);
  vec2 d1 = dirOf(pb - pa);
  vec2 n1 = vec2(-d1.y, d1.x);

  // Cerrado: cada extremo tiene vecino y manda la bisectriz. Abierto: las dos puntas se cortan planas
  // sobre la normal del propio segmento.
  bool conPrev = closed == 1 || edge > 0;
  bool conPost = closed == 1 || next + 1 < count;

  // Una punta libre se estira lo que su tapa necesite; con dash, la rampa del borde del primer y el
  // último trazo también necesita su medio píxel.
  float reach = cap == 0 ? (dashCount > 0 ? FEATHER : 0.0) : halfWidth + FEATHER;
  vec2  tipA  = conPrev ? pa : pa - d1 * reach;
  vec2  tipB  = conPost ? pb : pb + d1 * reach;

  float side = quad.y * (halfWidth + FEATHER);
  vec2  offA = conPrev ? miter(dirOf(pa - pixelAt(first + prev)), d1) : n1;
  vec2  offB = conPost ? miter(d1, dirOf(pixelAt(first + post) - pb)) : n1;
  vec2  pos  = mix(tipA, tipB, quad.x) + mix(offA, offB, quad.x) * side;

  float arc   = dashCount > 0 ? texelFetch(arcs, ivec2((first + edge) & texGeom.x, (first + edge) >> texGeom.y), 0).r * scale : 0.0;
  float phase = dashCount > 0 ? mod(arc, period) : 0.0;
  vec4 ramp   = mix(colorAt(first + edge), colorAt(first + next), quad.x);
  tint        = gradient == 1 ? vec4(ramp.rgb, ramp.a * color.a) : color;
  dist        = side;
  along       = dot(pos - pa, d1);
  frame       = vec4(phase, arc - phase, conPrev ? -FAR : phase, conPost ? FAR : phase + length(pb - pa));
  gl_Position = vec4(pos * pixel, 0.0, 1.0);
}`

// El relleno por stencil da bordes duros: el AA lo aporta el contorno, como una rampa de un píxel
// sobre la distancia firmada al trazo.
const FRAGMENT = `#version 300 es
precision highp float;
precision highp int;

uniform float halfWidth;
uniform float dash[${MAX_DASH}];   // (trazo, hueco) alternados
uniform int   dashCount;
uniform float period;
uniform int   cap;

in      vec4  tint;
in      float dist;
in      float along;
flat in vec4  frame;
out     vec4  fragColor;

const float FEATHER = ${FEATHER};
const float FAR     = ${FAR.toExponential()};

// Distancia firmada del fragmento al trazo que cubre el tramo [lo, hi] del eje, con la tapa pedida.
float shape(float lo, float hi, float at) {
  float beyond = max(lo - at, at - hi);
  float lateral = abs(dist);
  return cap == 1 ? length(vec2(max(beyond, 0.0), lateral)) - halfWidth
                  : max(lateral - halfWidth, beyond - (cap == 2 ? halfWidth : 0.0));
}

void main() {
  float at = frame.x + along;
  float sd = FAR;
  if (dashCount == 0)
    sd = cap == 0 ? abs(dist) - halfWidth : shape(frame.z, frame.w, at);
  else {
    // El trazo de una vuelta vecina puede rozar al fragmento (la tapa redonda cruza el límite del
    // período), así que se prueban tres vueltas. Uno que arranca antes del origen del anillo, o
    // después de su fin, no existe.
    float lap = floor(at / period);
    for (int m = -1; m <= 1; m++) {
      float start = (lap + float(m)) * period;
      for (int i = 0; i < ${MAX_DASH}; i += 2) {
        if (i >= dashCount) break;
        if (frame.y + start >= 0.0 && start <= frame.w && (dash[i] > 0.0 || cap != 0))
          sd = min(sd, shape(start, min(start + dash[i], frame.w), at));
        start += dash[i] + dash[i + 1];
      }
    }
  }
  fragColor = vec4(tint.rgb, tint.a * (1.0 - smoothstep(-FEATHER, FEATHER, sd)));
}`

const strokeProgram = gl => sharedProgram(gl, 'stroke', () => {
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

export class StrokePass {

  #gl; #program; #uniform; #vao; #closed; #gradient
  #width      = 3
  #opacity    = 1
  #hex        = null
  #rgba       = null
  #capName    = 'butt'
  #dashSource = null                     // el arreglo de la capa: su identidad evita renormalizar por trazo
  #dash       = new Float32Array(MAX_DASH)
  #dashCount  = 0
  #period     = 1

  constructor({ gl, color = '#3388ff', width = 3, opacity = 1, closed = true, dash = null, cap = 'butt', gradient = false }) {
    const { program, uniform } = strokeProgram(gl)
    this.#gl      = gl
    this.#program = program
    this.#uniform = uniform
    this.#vao     = gl.createVertexArray()
    this.#closed   = closed
    this.#gradient = gradient
    this.style({ color, width, opacity, dash, cap })
  }

  // `dash` es el patrón `[trazo, hueco, …]` en píxeles de pantalla, o `null` para continuo. Uno que no
  // sea un patrón —vacío, con un valor negativo o no finito, o de suma cero— se dibuja continuo; uno
  // que no cabe en el uniform es un error, no un recorte silencioso. `cap` es 'butt' | 'round' |
  // 'square', y cualquier otro valor es 'butt'. Se llama por trazo: no asigna, y un `dash` que es el
  // mismo arreglo de la llamada anterior no se vuelve a leer.
  style({ color = this.#hex, width = this.#width, opacity = this.#opacity, dash = this.#dashSource, cap = this.#capName } = {}) {
    if (dash !== this.#dashSource) {
      const n    = dashLength(dash)
      const laps = n & 1 ? 2 : 1
      let sum = 0
      let ok  = n > 0
      for (let i = 0; i < n; i++) {
        ok  = ok && dash[i] >= 0 && dash[i] < Infinity
        sum += dash[i]
      }
      ok = ok && sum > 0
      for (let i = 0; ok && i < n * laps; i++) this.#dash[i] = dash[i % n]
      this.#dashCount  = ok ? n * laps : 0
      this.#period     = ok ? sum * laps : 1
      this.#dashSource = dash
    }
    this.#hex     = color
    this.#width   = width
    this.#opacity = opacity
    this.#capName = cap
    this.#rgba    = toRGBA(color, opacity)
    return this
  }

  // `rings` son las MISMAS vistas que consume el relleno; la textura y su geometría son del store, así
  // que se fijan una vez y sólo el rango y la matriz cambian por anillo.
  draw(rings, view) {
    if (!rings.length || this.#width <= 0) return false
    const gl = this.#gl, u = this.#uniform
    const primera = rings[0].arena
    // El store arma sus arcos al primer pedido y la textura nueva queda ligada a la unidad activa: se
    // pide ANTES de ligar las del dibujo.
    const arcs = this.#dashCount > 0 ? primera.arcTexture : null
    gl.useProgram(this.#program)
    gl.uniform2f(u.pixel, 2 / view.size.x, 2 / view.size.y)
    gl.uniform1f(u.scale, 2 ** view.zoom)
    gl.uniform1f(u.halfWidth, this.#width / 2)
    gl.uniform4fv(u.color, this.#rgba)
    gl.uniform1i(u.positions, 0)
    gl.uniform1i(u.arcs, 1)
    gl.uniform1i(u.colors, 2)
    gl.uniform1i(u.gradient, this.#gradient ? 1 : 0)
    gl.uniform1i(u.closed, this.#closed ? 1 : 0)
    gl.uniform1i(u.cap, CAPS[this.#capName] ?? 0)
    gl.uniform1i(u.dashCount, this.#dashCount)
    gl.uniform1f(u.period, this.#period)
    gl.uniform1fv(u.dash, this.#dash)
    gl.uniform2i(u.texGeom, primera.textureWidth - 1, Math.log2(primera.textureWidth))
    if (this.#gradient) {
      gl.activeTexture(gl.TEXTURE2)
      gl.bindTexture(gl.TEXTURE_2D, primera.colorTexture)
    }
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, arcs)
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
      gl.drawArrays(gl.TRIANGLES, 0, (this.#closed ? count : count - 1) * 6)
    }
    gl.bindVertexArray(null)
    return true
  }

  destroy() {
    this.#gl.deleteVertexArray(this.#vao)
  }
}
