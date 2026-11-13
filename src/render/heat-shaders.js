// Los shaders del calor en GPU: el splat instanciado que acumula cada punto en un FBO y la rampa que lo vuelve color.
// Son GLSL ES 3.00; el vértice del splat pasa por `withProjection`, así que proyecta con `projectRel` y sirve a las
// demás variantes del preludio. Las constantes y la brocha son las de heat-math.js, inyectadas al fuente: el GLSL no
// lleva ningún número suelto.
//
// El acumulador tiene dos formatos, y se elige UNO por contexto (`heatFormat`):
//   · R16F, ley logarítmica. Cada splat suma t = −ln(max(1 − c·g, TERM_FLOOR)) con mezcla ONE, ONE, y la rampa lee a = 1 − e^−S. Es
//     la unión probabilística de los aportes, la misma que el `source-over` del canvas, pero sin cuantizar a 8 bits.
//   · RGBA8, `over`. Respaldo con WebGL2 básico, sin extensiones: el alfa se acumula con blendFunc(ONE,
//     ONE_MINUS_SRC_ALPHA) cuantizado a 8 bits por splat, igual que el canvas 2D. Es el camino que reproduce la
//     acumulación de 8 bits, con un error medido de hasta 8 niveles de índice contra la referencia.
// El formato sale de las extensiones y de una sonda de framebuffer, nunca del navegador: dos navegadores con las
// mismas capacidades toman el mismo camino.
//
// El splat es un quad por punto (TRIANGLE_STRIP de 4 vértices por `gl_VertexID`), con dos atributos por instancia:
// `aRel`, la posición world0 relativa al ancla, y `aWeight`, el peso normalizado. El quad se expande en px del FBO
// DESPUÉS de proyectar, así que el radio no depende del zoom. La rampa es un triángulo de pantalla completa que lee
// el índice 0..255 del acumulador y lo busca en la paleta (una textura RGBA8 de GRAD_STEPS × 1), con salida SIN
// premultiplicar para la mezcla `blendOver` del tramo.
import { withProjection, projectionKey } from './projection-prelude.js'
import { sharedProgram } from './gl-programs.js'
import { POINT_ALPHA, MIN_OPACITY, TERM_CAP, TERM_FLOOR, GRAD_STEPS, SPREAD_MIN_PX, BOX_HALF_PER_SIGMA } from './heat-math.js'

// Los uniformes de cada programa, que son sus nombres en el fuente. `u_projection_scale` lo declara el preludio.
export const SPLAT_UNIFORMS = ['uMatrix', 'uIntensity', 'uRadius', 'uCore', 'uAccSize']
export const CELL_UNIFORMS  = ['uMatrix', 'uRadius', 'uCore', 'uAccSize', 'uPxPorWorld0']
export const RAMP_UNIFORMS  = ['uAcc', 'uPaleta', 'uAccPorDispositivo']

// Las unidades de textura de la rampa, que se fijan al enlazar.
export const ACC_UNIT     = 0
export const PALETTE_UNIT = 1

const glsl = n => (Number.isInteger(n) ? n.toFixed(1) : String(n))

const HEADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
`

const CONSTANTS = `const float POINT_ALPHA = ${glsl(POINT_ALPHA)};
const float MIN_OPACITY = ${glsl(MIN_OPACITY)};
const float TERM_CAP    = ${glsl(TERM_CAP)};
const float TERM_FLOOR  = ${glsl(TERM_FLOOR)};
const int   GRAD_STEPS  = ${GRAD_STEPS};
`

export const SPLAT_VERTEX = `${HEADER}${CONSTANTS}
layout(location = 0) in vec2  aRel;      // world0 relativo al ancla (por instancia)
layout(location = 1) in float aWeight;   // peso normalizado (por instancia)
uniform mat4  uMatrix;                   // rel-ancla → clip
uniform float uIntensity;
uniform float uRadius;                   // R = radius + blur, en px del FBO
uniform vec2  uAccSize;                  // el FBO en px
flat out vec2  vCenter;                  // el centro en px del FBO
flat out float vContribution;

void main() {
  vec4 clip = projectRel(uMatrix, aRel);
  vec2 corner = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1)) * 2.0 - 1.0;
  vCenter       = (clip.xy / clip.w * 0.5 + 0.5) * uAccSize;
  vContribution = clamp(aWeight * uIntensity * POINT_ALPHA, MIN_OPACITY, 1.0);
  if (projectHidden(clip)) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);   // fuera del clip: el contrato del preludio
    return;
  }
  gl_Position = vec4(clip.xy + corner * uRadius * 2.0 / uAccSize * clip.w, clip.zw);
}`

// El splat de una celda agregada (heat-cells.js): el aporte medio ya acotado por punto, con `intensity` aplicada en la CPU,
// la multiplicidad n, que el fragmento usa para sumar lo de n puntos en una sola muestra, y la covarianza de sus puntos.
// La covarianza pasa a px del FBO con el jacobiano de la proyección en el centroide (J·Σ·Jᵀ), medido proyectando un px de
// pantalla en cada eje: vale con cualquier proyección que el preludio dé. El quad llega a R + √(3·traza), que acota la
// dispersión en cualquier dirección.
export const SPLAT_CELL_VERTEX = `${HEADER}${CONSTANTS}const float BOX_HALF_PER_SIGMA = ${glsl(BOX_HALF_PER_SIGMA)};
layout(location = 0) in vec2  aRel;      // el centroide de la celda, world0 relativo al ancla (por instancia)
layout(location = 1) in float aContribution;   // el aporte medio de sus puntos (por instancia)
layout(location = 2) in float aCount;    // cuántos puntos junta (por instancia)
layout(location = 3) in vec3  aCov;      // la covarianza de sus puntos: xx, yy, xy en px² de world0 (por instancia)
uniform mat4  uMatrix;
uniform float uRadius;
uniform vec2  uAccSize;
uniform float uPxPorWorld0;              // px de pantalla por px de world0: 2^zoom
flat out vec2  vCenter;
flat out float vContribution;
flat out float vCount;
flat out vec3  vCov;                     // la covarianza en px² del FBO

vec2 toAcc(vec4 c) { return (c.xy / c.w * 0.5 + 0.5) * uAccSize; }

void main() {
  vec4 clip = projectRel(uMatrix, aRel);
  vec2 corner = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1)) * 2.0 - 1.0;
  vCenter       = toAcc(clip);
  vContribution = aContribution;
  vCount        = aCount;
  float k = 1.0 / uPxPorWorld0;
  vec2 ex = (toAcc(projectRel(uMatrix, aRel + vec2(k, 0.0))) - vCenter) / k;
  vec2 ey = (toAcc(projectRel(uMatrix, aRel + vec2(0.0, k))) - vCenter) / k;
  vCov = vec3(aCov.x * ex.x * ex.x + aCov.y * ey.x * ey.x + 2.0 * aCov.z * ex.x * ey.x,
              aCov.x * ex.y * ex.y + aCov.y * ey.y * ey.y + 2.0 * aCov.z * ex.y * ey.y,
              aCov.x * ex.x * ex.y + aCov.y * ey.x * ey.y + aCov.z * (ex.x * ey.y + ex.y * ey.x));
  if (projectHidden(clip)) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  float reach = uRadius + BOX_HALF_PER_SIGMA * sqrt(max(vCov.x + vCov.y, 0.0));
  gl_Position = vec4(clip.xy + corner * reach * 2.0 / uAccSize * clip.w, clip.zw);
}`

// La brocha: la de `brushAt`, 1 hasta core·R y lineal a 0 en R.
const BRUSH = `${HEADER}${CONSTANTS}
uniform float uRadius;
uniform float uCore;                     // core·R
flat in vec2  vCenter;
flat in float vContribution;
float brush() {
  float d = distance(gl_FragCoord.xy, vCenter);
  return d <= uCore ? 1.0 : d >= uRadius ? 0.0 : (uRadius - d) / (uRadius - uCore);
}
`

export const SPLAT_FRAGMENT_LOGSUM = `${BRUSH}
out float outSum;
void main() {
  float g = brush();
  if (g <= 0.0) discard;
  // El argumento se acota ANTES del log: con c·g = 1, log(0) no está definido en GLSL ES 3.00 (según el driver da -inf o
  // NaN). Con TERM_FLOOR el término nunca pasa de TERM_CAP y es el mismo en todo driver.
  outSum = -log(max(1.0 - vContribution * g, TERM_FLOOR));
}`

// El aporte se cuantiza a 8 bits como en el canvas: q = round(round(c·255) · round(g·255) / 255) / 255.
export const SPLAT_FRAGMENT_OVER = `${BRUSH}
out vec4 outAlpha;
void main() {
  float g = brush();
  if (g <= 0.0) discard;
  float q = floor(floor(vContribution * 255.0 + 0.5) * floor(g * 255.0 + 0.5) / 255.0 + 0.5) / 255.0;
  outAlpha = vec4(0.0, 0.0, 0.0, q);
}`

// La brocha de la celda: la de `brushSpreadAt`, `brush()` promediada en ±s, con s = √3·σ y σ² la varianza de los puntos en
// la dirección del px (uᵀΣu). En el centro mismo no hay dirección: vale la media de las dos varianzas.
const CELL_BRUSH = `${BRUSH}const float SPREAD_MIN_PX = ${glsl(SPREAD_MIN_PX)};
const float BOX_HALF_PER_SIGMA = ${glsl(BOX_HALF_PER_SIGMA)};
flat in float vCount;
flat in vec3  vCov;
float rampIntegral(float t) {
  return t <= 0.0 ? 0.0 : t <= 1.0 ? t * t * 0.5 : t - 0.5;
}
float cellBrush() {
  float w = uRadius - uCore;
  vec2 dv = gl_FragCoord.xy - vCenter;
  float d = length(dv);
  float sigma2 = d > 0.0 ? (vCov.x * dv.x * dv.x + vCov.y * dv.y * dv.y + 2.0 * vCov.z * dv.x * dv.y) / (d * d) : 0.5 * (vCov.x + vCov.y);
  float s = BOX_HALF_PER_SIGMA * sqrt(max(sigma2, 0.0));
  if (s < SPREAD_MIN_PX || w <= 0.0) return brush();
  if (d + s <= uCore) return 1.0;
  if (d - s >= uRadius) return 0.0;
  return 1.0 - w / (2.0 * s) * (rampIntegral((d + s - uCore) / w) - rampIntegral((d - s - uCore) / w));
}
`

// n puntos iguales en el mismo sitio suman n veces el término.
export const SPLAT_CELL_FRAGMENT_LOGSUM = `${CELL_BRUSH}
out float outSum;
void main() {
  float g = cellBrush();
  if (g <= 0.0) discard;
  outSum = vCount * -log(max(1.0 - vContribution * g, TERM_FLOOR));
}`

// n mezclas `over` de q dejan 1 − (1 − q)^n. Sin la cuantización entre una y otra, que el acumulador de 8 bits sí hace.
export const SPLAT_CELL_FRAGMENT_OVER = `${CELL_BRUSH}
out vec4 outAlpha;
void main() {
  float g = cellBrush();
  if (g <= 0.0) discard;
  float q = floor(floor(vContribution * 255.0 + 0.5) * floor(g * 255.0 + 0.5) / 255.0 + 0.5) / 255.0;
  outAlpha = vec4(0.0, 0.0, 0.0, 1.0 - pow(1.0 - q, vCount));
}`

export const RAMP_VERTEX = `${HEADER}
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`

const RAMP_COMMON = `${HEADER}${CONSTANTS}
uniform sampler2D uAcc;
uniform sampler2D uPaleta;               // GRAD_STEPS × 1, RGBA8
uniform float uAccPorDispositivo;        // px del acumulador por px del dispositivo (en DPR 1, la identidad)
out vec4 outColor;
const float LEVELS = ${glsl(GRAD_STEPS - 1)};

void paint(float a) {
  int idx = clamp(int(floor(a * LEVELS + 0.5)), 0, GRAD_STEPS - 1);
  vec4 pal = texelFetch(uPaleta, ivec2(idx, 0), 0);
  outColor = vec4(pal.rgb, float(idx) / LEVELS * pal.a);
}

// El centro del píxel del dispositivo en coordenadas de textura. Con el filtro lineal, en DPR 1 cae en el centro de un
// texel (la identidad) y en DPR 2 interpola entre 2×2 px de dispositivo, sin escalonar los contornos.
vec2 acumuladoUv() {
  return gl_FragCoord.xy * uAccPorDispositivo / vec2(textureSize(uAcc, 0));
}
`

export const RAMP_FRAGMENT_LOGSUM = `${RAMP_COMMON}
void main() {
  paint(1.0 - exp(-texture(uAcc, acumuladoUv()).r));
}`

export const RAMP_FRAGMENT_OVER = `${RAMP_COMMON}
void main() {
  paint(texture(uAcc, acumuladoUv()).a);
}`

// Los fuentes de un formato. Sólo el vértice del splat proyecta, así que sólo él lleva el preludio.
export const heatSources = (name, variant = 'mercator') => ({
  splat : { vertex: withProjection(SPLAT_VERTEX, variant), fragment: name === 'r16f' ? SPLAT_FRAGMENT_LOGSUM : SPLAT_FRAGMENT_OVER },
  ramp  : { vertex: RAMP_VERTEX, fragment: name === 'r16f' ? RAMP_FRAGMENT_LOGSUM : RAMP_FRAGMENT_OVER },
})

export const heatCellSources = (name, variant = 'mercator') => ({
  vertex   : withProjection(SPLAT_CELL_VERTEX, variant),
  fragment : name === 'r16f' ? SPLAT_CELL_FRAGMENT_LOGSUM : SPLAT_CELL_FRAGMENT_OVER,
})

const compile = (gl, type, source) => {
  const shader = gl.createShader(type)
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  return shader
}

// Enlaza un programa y recoge sus uniformes. Un fallo de enlace lanza, salvo con el contexto perdido: ahí los
// estados son basura y la capa se reconstruye con el contexto nuevo. `matrix` y `scale` son los nombres con que
// `FrameView.bind` los busca.
const build = (gl, { vertex, fragment }, names, fixed) => {
  const program = gl.createProgram()
  const shaders = [compile(gl, gl.VERTEX_SHADER, vertex), compile(gl, gl.FRAGMENT_SHADER, fragment)]
  shaders.forEach(shader => gl.attachShader(program, shader))
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost())
    throw new Error(`[cristae] el programa del calor no linkea: ${gl.getProgramInfoLog(program)}`)
  shaders.forEach(shader => gl.deleteShader(shader))
  const locs = { program }
  names.forEach(name => (locs[name] = gl.getUniformLocation(program, name)))
  locs.matrix = locs.uMatrix
  locs.scale  = gl.getUniformLocation(program, 'u_projection_scale')
  gl.useProgram(program)
  fixed?.(locs)
  return locs
}

// Los dos programas del contexto para un formato, enlazados una vez por contexto, formato y variante.
export const heatPrograms = (gl, format, variant = 'mercator') =>
  sharedProgram(gl, projectionKey(`heat:${format.name}`, variant), () => {
    const sources = heatSources(format.name, variant)
    return {
      splat : build(gl, sources.splat, SPLAT_UNIFORMS),
      ramp  : build(gl, sources.ramp, RAMP_UNIFORMS, locs => {
        gl.uniform1i(locs.uAcc, ACC_UNIT)
        gl.uniform1i(locs.uPaleta, PALETTE_UNIT)
      }),
    }
  })

// El splat de celdas, aparte de `heatPrograms`: sólo lo enlaza un contexto con una capa que agrega.
export const heatCellProgram = (gl, format, variant = 'mercator') =>
  sharedProgram(gl, projectionKey(`heat-cells:${format.name}`, variant), () => build(gl, heatCellSources(format.name, variant), CELL_UNIFORMS))

const formats = new WeakMap()

// Sondea un FBO R16F de 1×1. Deja los enlaces de textura y framebuffer como estaban y borra lo que creó.
const probeR16F = gl => {
  const prevTex = gl.getParameter(gl.TEXTURE_BINDING_2D)
  const prevFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING)
  const tex = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, 1, 1, 0, gl.RED, gl.HALF_FLOAT, null)
  const fbo = gl.createFramebuffer()
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
  const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE
  gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo)
  gl.bindTexture(gl.TEXTURE_2D, prevTex)
  gl.deleteFramebuffer(fbo)
  gl.deleteTexture(tex)
  return ok
}

// El formato del acumulador de este contexto, decidido una vez. Pedir la extensión es lo que habilita renderizar a
// flotante; si no está, o el FBO no completa, queda el respaldo RGBA8. `blendSrc`/`blendDst` son los factores de
// `blendFunc` de cada ley: ONE, ONE suma los términos; ONE, ONE_MINUS_SRC_ALPHA es el `over`.
export const heatFormat = gl => {
  let format = formats.get(gl)
  if (!format) {
    const ext = gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float')
    format = ext && probeR16F(gl)
      ? { name: 'r16f',  internalFormat: gl.R16F,   format: gl.RED,  type: gl.HALF_FLOAT,     blendSrc: gl.ONE, blendDst: gl.ONE }
      : { name: 'rgba8', internalFormat: gl.RGBA8,  format: gl.RGBA, type: gl.UNSIGNED_BYTE, blendSrc: gl.ONE, blendDst: gl.ONE_MINUS_SRC_ALPHA }
    formats.set(gl, format)
  }
  return format
}
