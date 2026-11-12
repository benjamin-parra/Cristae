// Los shaders del terreno en planta: sombreado, color por altura o por pendiente, y curvas de nivel,
// todo leído de la textura de altura. Son GLSL ES 3.00 que pasa por `withProjection`: el vértice
// proyecta con `projectRel`, así que el mismo fuente sirve a las demás variantes del preludio.
//
// El vértice es un quad sin atributos (6 vértices por `gl_VertexID`) sobre la caja del mosaico. La
// esquina se multiplica por el tamaño del mosaico en world0, y esa posición relativa al ancla es la que
// proyecta; `vCell` es la misma posición en celdas desde el borde de la caja. Es relativa al ancla, así
// que en float32 alcanza.
//
// Lo que el fragmento lee, por celda i = floor(vCell) + uOffset (el texel de la primera celda de la caja):
//   · `uHeights`, R32F: las alturas del mosaico, con NO_DATA donde la grilla trae NaN. El que sube la
//     textura reemplaza el NaN: GLSL ES no garantiza NaN ni `isnan`.
//   · `uRows`, RG32F de una columna: por fila absoluta, `ew` (el ancho de dos celdas) y `ns` (el alto de
//     dos), los pasos de Horn de `terrain()`.
// Las texturas flotantes no garantizan filtrado lineal sin OES_texture_float_linear, así que todo se lee
// con `texelFetch` y la bilineal de la altura es a mano. Con la unidad 0 para `uHeights` y la 1 para
// `uRows`, que se fijan al enlazar.
//
// La pendiente es la de `eachCell` de terrain.js, con la misma expresión en el mismo orden de
// operaciones, para que la clase coincida con la de `relief()` celda a celda. La salida es color sin
// premultiplicar, para la mezcla `blendOver` de las capas. El sombreado es negro con alfa `(1 - sombra) * opacidad`:
// con `blendOver` oscurece lo de abajo igual que una mezcla multiplicativa, sin tapar el mapa base, y se dibuja
// después del color para que éste no lo oculte.
import { withProjection, projectionKey } from './projection-prelude.js'
import { sharedProgram } from './gl-programs.js'

const D = Math.PI / 180

// La luz del sombreado: la de `gdaldem hillshade` por defecto, de azimut 315° (del noroeste, en sentido
// horario desde el norte) y 45° sobre el horizonte.
export const HILLSHADE_AZIMUTH  = 315
export const HILLSHADE_ALTITUDE = 45

// Cortes de pendiente que caben: 16 clases, 16 vec4 de los 224 vectores de fragmento que WebGL2
// garantiza (cada elemento de un arreglo de uniformes ocupa uno).
export const MAX_SLOPE_BREAKS = 15

// Lo que no tiene altura: bajo todo terreno, porque el mínimo de Terrarium es −32768 m. Una celda con
// alguna de sus alturas bajo la mitad no tiene pendiente.
export const NO_DATA = -1e9

// El ancho de la curva de nivel en px CSS: la línea fina de `gdal_contour`.
export const CONTOUR_PX = 1

// El color de las curvas: el marrón de las curvas de nivel de la cartografía topográfica.
export const CONTOUR_COLOR = [0.45, 0.28, 0.12]

// La rampa de altura, cinco paradas equiespaciadas de verde a blanco por la hipsometría clásica de la
// cartografía física: llanura, lomaje, cerro, roca y nieve.
export const ELEVATION_RAMP = [
  [0.17, 0.54, 0.24],
  [0.66, 0.77, 0.42],
  [0.91, 0.84, 0.56],
  [0.62, 0.45, 0.33],
  [1.00, 1.00, 1.00],
]

// Los modos de `uMode` del programa de color.
export const MODE_NONE      = 0
export const MODE_ELEVATION = 1
export const MODE_SLOPE     = 2

// Los uniformes de cada programa, que son sus nombres en el fuente. `u_projection_scale` lo declara el
// preludio, y el vértice no lo usa.
export const HILLSHADE_UNIFORMS = ['uMatrix', 'uSize', 'uCellsPerWorld', 'uOffset', 'uHeights', 'uRows', 'uOpacity']
export const COLOR_UNIFORMS     = ['uMatrix', 'uSize', 'uCellsPerWorld', 'uOffset', 'uHeights', 'uRows', 'uOpacity',
  'uMode', 'uOverview', 'uBreaks', 'uBreakCount', 'uColors', 'uColorCount', 'uRange', 'uInterval']

const glsl = n => (Number.isInteger(n) ? n.toFixed(1) : String(n))
const vec3 = ([r, g, b]) => `vec3(${glsl(r)}, ${glsl(g)}, ${glsl(b)})`

const HEADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
`

const VERTEX = `${HEADER}
uniform mat4  uMatrix;           // rel-ancla → clip
uniform vec2  uSize;             // la caja del mosaico en world0
uniform float uCellsPerWorld;    // celdas por world0
out vec2 vCell;                  // celdas desde el borde de la caja
const vec2 CORNERS[6] = vec2[6](vec2(0.0, 0.0), vec2(1.0, 0.0), vec2(0.0, 1.0), vec2(0.0, 1.0), vec2(1.0, 0.0), vec2(1.0, 1.0));
void main() {
  vec2 rel = CORNERS[gl_VertexID % 6] * uSize;
  vCell = rel * uCellsPerWorld;
  gl_Position = projectRel(uMatrix, rel);
}`

// Lo que comparten los dos fragmentos: la lectura de alturas y el gradiente de Horn.
const COMMON = `${HEADER}
const float NO_DATA = ${glsl(NO_DATA)};
uniform sampler2D uHeights;
uniform sampler2D uRows;
uniform ivec2 uOffset;           // el texel de la primera celda de la caja
uniform float uOpacity;
in vec2 vCell;
out vec4 outColor;

float heightAt(ivec2 c) {
  return texelFetch(uHeights, clamp(c, ivec2(0), textureSize(uHeights, 0) - 1), 0).r;
}

vec2 rowAt(int j) {
  return texelFetch(uRows, ivec2(0, clamp(j, 0, textureSize(uRows, 0).y - 1)), 0).rg;
}

// El gradiente de Horn de la celda i: gx hacia el este y gy hacia el sur, en m/m. Falso si alguna de las
// nueve alturas no tiene dato.
bool gradientAt(ivec2 i, out float gx, out float gy) {
  float a0 = heightAt(i + ivec2(-1, -1));
  float a1 = heightAt(i + ivec2( 0, -1));
  float a2 = heightAt(i + ivec2( 1, -1));
  float b0 = heightAt(i + ivec2(-1,  0));
  float b2 = heightAt(i + ivec2( 1,  0));
  float c0 = heightAt(i + ivec2(-1,  1));
  float c1 = heightAt(i + ivec2( 0,  1));
  float c2 = heightAt(i + ivec2( 1,  1));
  float h  = heightAt(i);
  float lo = min(min(min(a0, a1), min(a2, b0)), min(min(b2, c0), min(c1, min(c2, h))));
  gx = 0.0;
  gy = 0.0;
  if (lo < NO_DATA * 0.5) return false;
  vec2 up   = rowAt(i.y - 1);
  vec2 mid  = rowAt(i.y);
  vec2 down = rowAt(i.y + 1);
  gx = ((a2 - a0) / up.x
    + 2.0 * (b2 - b0) / mid.x
    + (c2 - c0) / down.x) / 4.0;
  gy = (c0 + 2.0 * c1 + c2 - a0 - 2.0 * a1 - a2) / (4.0 * mid.y);
  return true;
}

ivec2 cellOf() {
  return ivec2(floor(vCell)) + uOffset;
}
`

const L = [
  Math.sin(HILLSHADE_AZIMUTH * D) * Math.cos(HILLSHADE_ALTITUDE * D),
  Math.cos(HILLSHADE_AZIMUTH * D) * Math.cos(HILLSHADE_ALTITUDE * D),
  Math.sin(HILLSHADE_ALTITUDE * D),
]

// El sombreado de Horn: la normal (−dz/dx, −dz/dnorte, 1) contra la luz, como negro con alfa. Sin dato no pinta.
const HILLSHADE_FRAGMENT = `${COMMON}
const vec3 LIGHT = ${vec3(L)};
void main() {
  float gx, gy;
  if (!gradientAt(cellOf(), gx, gy)) discard;
  float shade = clamp(dot(normalize(vec3(-gx, gy, 1.0)), LIGHT), 0.0, 1.0);
  outColor = vec4(0.0, 0.0, 0.0, (1.0 - shade) * uOpacity);
}`

const COLOR_FRAGMENT = `${COMMON}
const int  MAX_BREAKS    = ${MAX_SLOPE_BREAKS};
const float CONTOUR_PX   = ${glsl(CONTOUR_PX)};
const vec3 CONTOUR_COLOR = ${vec3(CONTOUR_COLOR)};
const vec3 RAMP[${ELEVATION_RAMP.length}] = vec3[${ELEVATION_RAMP.length}](${ELEVATION_RAMP.map(vec3).join(', ')});
uniform int   uMode;             // 0 ninguno, 1 altura, 2 pendiente
uniform bool  uOverview;         // apaga la clase y las curvas
uniform float uBreaks[MAX_BREAKS];
uniform int   uBreakCount;
uniform vec4  uColors[MAX_BREAKS + 1];
uniform int   uColorCount;       // sin cortes, las paradas de la rampa continua
uniform vec2  uRange;            // metros de la rampa de altura
uniform float uInterval;         // metros entre curvas; 0 las apaga

// La altura bilineal en la posición de vCell, a mano. Falso si alguno de los cuatro vecinos no tiene dato.
bool heightHere(out float h) {
  vec2  p  = vCell + vec2(uOffset) - 0.5;
  ivec2 i  = ivec2(floor(p));
  vec2  f  = p - vec2(i);
  float h00 = heightAt(i);
  float h10 = heightAt(i + ivec2(1, 0));
  float h01 = heightAt(i + ivec2(0, 1));
  float h11 = heightAt(i + ivec2(1, 1));
  h = 0.0;
  if (min(min(h00, h10), min(h01, h11)) < NO_DATA * 0.5) return false;
  float top = h00 + (h10 - h00) * f.x;
  float bot = h01 + (h11 - h01) * f.x;
  h = top + (bot - top) * f.y;
  return true;
}

vec4 rampColor(float t) {
  float s = clamp(t, 0.0, 1.0) * float(RAMP.length() - 1);
  int   k = min(int(floor(s)), RAMP.length() - 2);
  return vec4(mix(RAMP[k], RAMP[k + 1], s - float(k)), 1.0);
}

// La clase de la pendiente p: cuántos cortes cumplen b <= p, como \`relief()\`.
vec4 slopeColor(float p) {
  if (uBreakCount == 0) {
    float s = clamp(p, 0.0, 1.0) * float(uColorCount - 1);
    int   k = min(int(floor(s)), max(uColorCount - 2, 0));
    return mix(uColors[k], uColors[min(k + 1, uColorCount - 1)], s - float(k));
  }
  int c = 0;
  for (int k = 0; k < MAX_BREAKS; k++) {
    if (k >= uBreakCount || !(uBreaks[k] <= p)) break;
    c++;
  }
  return uColors[c];
}

void main() {
  vec4  base = vec4(0.0);
  float h    = 0.0;
  bool  hasH = heightHere(h);
  if (uMode == ${MODE_ELEVATION} && hasH) {
    float span = uRange.y - uRange.x;
    base = rampColor(span > 0.0 ? (h - uRange.x) / span : 0.0);
  } else if (uMode == ${MODE_SLOPE} && !uOverview) {
    float gx, gy;
    if (gradientAt(cellOf(), gx, gy)) base = slopeColor(sqrt(gx * gx + gy * gy));
  }

  // Las derivadas van fuera de todo condicional por píxel: en flujo no uniforme son indefinidas.
  float u  = h / max(uInterval, 1e-6);
  float fw = fwidth(u);
  float f  = fract(u);
  float line = 0.0;
  if (uInterval > 0.0 && hasH && !uOverview) {
    if (fw > 0.0) line = clamp(0.5 * CONTOUR_PX + 0.5 - min(f, 1.0 - f) / fw, 0.0, 1.0);
  }

  float a = line + base.a * (1.0 - line);
  if (a <= 0.0) discard;
  vec3 rgb = (CONTOUR_COLOR * line + base.rgb * base.a * (1.0 - line)) / a;
  outColor = vec4(rgb, a * uOpacity);
}`

// Los fuentes. Sólo el vértice proyecta, así que sólo él lleva el preludio de la variante.
export const terrainSources = (variant = 'mercator') => ({
  hillshade : { vertex: withProjection(VERTEX, variant), fragment: HILLSHADE_FRAGMENT },
  color     : { vertex: withProjection(VERTEX, variant), fragment: COLOR_FRAGMENT },
})

const compile = (gl, type, source) => {
  const shader = gl.createShader(type)
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader))
  return shader
}

// Enlaza un programa y recoge las ubicaciones de sus uniformes. `matrix` y `scale` son los nombres con que
// `FrameView.bind` los busca.
const build = (gl, { vertex, fragment }, names) => {
  const program = gl.createProgram()
  const shaders = [compile(gl, gl.VERTEX_SHADER, vertex), compile(gl, gl.FRAGMENT_SHADER, fragment)]
  shaders.forEach(shader => gl.attachShader(program, shader))
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program))
  shaders.forEach(shader => gl.deleteShader(shader))
  const locs = { program }
  names.forEach(name => (locs[name] = gl.getUniformLocation(program, name)))
  locs.matrix = locs.uMatrix
  locs.scale  = gl.getUniformLocation(program, 'u_projection_scale')
  gl.useProgram(program)
  gl.uniform1i(locs.uHeights, 0)
  gl.uniform1i(locs.uRows, 1)
  return locs
}

// Los dos programas del contexto, compilados una vez por contexto y variante.
export const terrainPrograms = (gl, variant = 'mercator') =>
  sharedProgram(gl, projectionKey('terrain', variant), () => {
    const sources = terrainSources(variant)
    return {
      hillshade : build(gl, sources.hillshade, HILLSHADE_UNIFORMS),
      color     : build(gl, sources.color, COLOR_UNIFORMS),
    }
  })
