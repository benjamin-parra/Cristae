// Shaders genéricos de la point-layer. Las dimensiones del atlas (cols/rows/tileSize)
// y el divisor del índice (maxIndex = C-1) son UNIFORMS, no literales horneados en GLSL
// → el programa se compila UNA vez y nunca recompila al crecer iconos ni en regrow
// (esto erradica la corrupción de marcadores y el 2º-mapa-en-blanco del IconBuilder legado).
//
// Layout de vértice de glify (bytes=7): [x, y, r, g, b, a, size].
//   r = canal de tile (atlas.tileChannel)   g = ángulo normalizado (heading/360)
//   b,a = id de picking (16 bits, slot+1)    size = px en pantalla
// Siempre se rota: con g=0 la rotación es identidad → un solo programa, sin variantes.

export const POINT_VERTEX = `
precision mediump float;
uniform mat4 matrix;
attribute vec4 vertex;
attribute vec4 color;
attribute float pointSize;
varying vec4 vColor;
void main() {
  gl_PointSize = pointSize;
  gl_Position = matrix * vertex;
  vColor = color;
}
`

// Cuerpo común: decodifica tile desde uniforms, rota el UV y muestrea el atlas.
// `outColor` es la única diferencia entre el programa visual y el de picking.
const fragment = (outColor) => `
precision mediump float;
varying vec4 vColor;
uniform sampler2D uAtlas;
uniform float uCols;
uniform float uRows;
uniform float uTileSize;
uniform float uMaxIndex;

vec2 rot(vec2 p, float a) {
  float s = sin(a), c = cos(a);
  return vec2(c * p.x - s * p.y, s * p.x + c * p.y);
}

void main() {
  float tileIdx = floor(vColor.r * uMaxIndex + 0.5);
  float col = mod(tileIdx, uCols);
  float row = floor(tileIdx / uCols);
  float angle = vColor.g * 6.2831853;
  vec2 uv = gl_PointCoord.xy - vec2(0.5);
  vec2 p = rot(uv, -angle) + vec2(0.5);
  float eps = 0.5 / uTileSize;
  p = clamp(p, eps, 1.0 - eps);
  vec2 tileUV = (p + vec2(col, row)) / vec2(uCols, uRows);
  vec4 tex = texture2D(uAtlas, tileUV);
  if (tex.a < 0.01) discard;
  ${outColor}
}
`

// Visual: pinta el tile (alpha ligeramente atenuado, como el legado).
export const POINT_FRAGMENT = fragment('gl_FragColor = vec4(tex.rgb, tex.a * 0.95);')

// Picking: emite el id (vColor.b, vColor.a) en vez del color del tile. Comparte el
// MISMO buffer de vértices y atributos → un bufferSubData actualiza visual y picking a la vez.
export const POINT_PICKING_FRAGMENT = fragment('gl_FragColor = vec4(vColor.b, vColor.a, 0.0, 1.0);')
