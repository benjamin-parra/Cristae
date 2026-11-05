// La composición de un tramo: cada miembro dibuja en la textura de su propio FBO y el tramo la copia al framebuffer por
// defecto, en orden K, con su opacidad y con la transformación de la vista con que pintó a la vista de ahora. Un miembro
// que no cambió no se redibuja: componer sólo vuelve a copiar su textura.
//
// La copia es un triángulo de pantalla por miembro que lee con `texelFetch`, sin filtrar: con la vista asentada la
// transformación es la identidad y la imagen sale igual que el dibujo directo. Escalada (zoom animado) se ve con vecino más
// cercano, y con DPR fraccional el desplazamiento redondea a px de dispositivo.

import { sharedProgram } from './gl-programs.js'

const VERTEX = `#version 300 es
void main() {
  vec2 q = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(q * 2.0 - 1.0, 0.0, 1.0);
}`

// `tr` lleva la transformación en coordenadas de framebuffer (origen abajo-izquierda): pantallaAhora = tr.z · pintada + tr.xy.
// Se lee el texel de la pintada; lo que cae fuera de la textura no aporta.
const FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D tex;
uniform float     opacity;
uniform vec3      tr;
out vec4 color;
void main() {
  ivec2 size = textureSize(tex, 0);
  ivec2 p    = ivec2(floor((gl_FragCoord.xy - tr.xy) / tr.z));
  if (p.x < 0 || p.y < 0 || p.x >= size.x || p.y >= size.y) discard;
  color = texelFetch(tex, p, 0) * opacity;
}`

// El programa es del contexto: dos compositores sobre el mismo `gl` lo comparten, y con él los uniformes, así que el último
// valor fijado vive en la entrada de la caché y no en el compositor.
const composeProgram = gl => sharedProgram(gl, 'cristae:compose', () => {
  const program = gl.createProgram()
  ;[[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, FRAGMENT]].forEach(([type, source]) => {
    const shader = gl.createShader(type)
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    gl.attachShader(program, shader)
    gl.deleteShader(shader)
  })
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost())
    throw new Error(`[cristae] el programa de composición no linkea: ${gl.getProgramInfoLog(program)}`)
  return {
    program,
    opacity : gl.getUniformLocation(program, 'opacity'),
    tr      : gl.getUniformLocation(program, 'tr'),
    last    : new Float64Array(4).fill(NaN),   // opacity, tr.x, tr.y, tr.z
  }
})

// [0-alloc] De la vista con que se pintó a la de ahora, en px de dispositivo y origen arriba-izquierda:
// pantallaAhora = s · pantallaPintada + d. Un punto de mundo w cae en xp = (w − cp)·2^zp + Wp/2 y en xn = (w − cn)·2^zn + Wn/2,
// de donde xn = s·(xp − Wp/2) + (cp − cn)·2^zn + Wn/2. Igual para y.
export const viewTransform = (painted, now, dpr, out) => {
  const k = 2 ** now.zoom
  const s = 2 ** (now.zoom - painted.zoom)
  out[0] = s
  out[1] = dpr * (now.size.x / 2 - s * painted.size.x / 2 + (painted.center.x - now.center.x) * k)
  out[2] = dpr * (now.size.y / 2 - s * painted.size.y / 2 + (painted.center.y - now.center.y) * k)
  return out
}

const TR = new Float64Array(3)

export class GlCompositor {

  #gl
  #shared
  #depth  = null   // DEPTH24_STENCIL8 común a todos los FBO: los miembros dibujan de a uno y cada uno limpia lo que usa
  #width  = 0
  #height = 0

  constructor(gl) {
    this.#gl     = gl
    this.#shared = composeProgram(gl)
  }

  // Crea o realoca la textura y el FBO del miembro, los enlaza y deja el estado base. No toca `depthFunc` ni la mezcla:
  // cada capa pone las suyas. `checkFramebufferStatus` no se consulta: es síncrono y la forma del FBO es siempre la misma.
  bind(target, width, height) {
    const gl    = this.#gl
    const fresh = !target.fbo
    gl.activeTexture(gl.TEXTURE0)
    if (fresh) {
      target.texture = gl.createTexture()
      target.fbo     = gl.createFramebuffer()
      gl.bindTexture(gl.TEXTURE_2D, target.texture)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    }
    const resized = target.width !== width || target.height !== height
    if (resized) {
      gl.bindTexture(gl.TEXTURE_2D, target.texture)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)   // mutable: realocar no crea
      target.width  = width
      target.height = height
    }
    const depth = this.#depth ??= gl.createRenderbuffer()
    if (this.#width !== width || this.#height !== height) {
      gl.bindRenderbuffer(gl.RENDERBUFFER, depth)
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH24_STENCIL8, width, height)
      this.#width  = width
      this.#height = height
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo)
    if (fresh) {
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target.texture, 0)
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, depth)
    }
    // la textura no queda en la unidad 0 mientras su FBO es el destino: un muestreo suyo sería un lazo de realimentación
    ;(fresh || resized) && gl.bindTexture(gl.TEXTURE_2D, null)
    gl.viewport(0, 0, width, height)
    gl.disable(gl.DEPTH_TEST)
    gl.disable(gl.STENCIL_TEST)
    gl.disable(gl.SCISSOR_TEST)
    gl.disable(gl.CULL_FACE)
    gl.colorMask(true, true, true, true)
    gl.depthMask(true)
    gl.stencilMask(0xff)
    gl.bindVertexArray(null)
    return target
  }

  // Sobre un contexto perdido no se llama nada: con él se fue todo. El destino queda vacío igual.
  drop(target) {
    const gl   = this.#gl
    const live = !gl.isContextLost()
    live && target.fbo && gl.deleteFramebuffer(target.fbo)
    live && target.texture && gl.deleteTexture(target.texture)
    target.fbo     = null
    target.texture = null
    target.width   = 0
    target.height  = 0
    return target
  }

  // [0-alloc] Limpia el framebuffer por defecto y dibuja en el orden dado cada entrada con textura y opacidad > 0. El
  // contenido es premultiplicado (las capas mezclan con `blendOver`): la copia compone con ONE, ONE_MINUS_SRC_ALPHA.
  compose(list, count, now, dpr) {
    const gl = this.#gl
    const u  = this.#shared
    const h  = gl.drawingBufferHeight
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, gl.drawingBufferWidth, h)
    gl.disable(gl.DEPTH_TEST)
    gl.disable(gl.STENCIL_TEST)
    gl.disable(gl.SCISSOR_TEST)
    gl.disable(gl.CULL_FACE)
    gl.colorMask(true, true, true, true)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.useProgram(u.program)
    gl.bindVertexArray(null)
    gl.activeTexture(gl.TEXTURE0)
    let drawn = 0
    for (let i = 0; i < count; i++) {
      const entry  = list[i]
      const target = entry.target
      const a      = entry.opacity
      if (!target.texture || !(a > 0)) continue

      viewTransform(entry.painted, now, dpr, TR)
      // de arriba-izquierda a las filas del framebuffer: Y = H − y en el de ahora y en el FBO pintado
      const s    = TR[0]
      const x    = TR[1]
      const y    = h - s * target.height - TR[2]
      const last = u.last
      if (last[0] !== a) gl.uniform1f(u.opacity, last[0] = a)
      if (last[1] !== x || last[2] !== y || last[3] !== s) {
        gl.uniform3f(u.tr, x, y, s)
        last[1] = x
        last[2] = y
        last[3] = s
      }
      gl.bindTexture(gl.TEXTURE_2D, target.texture)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      drawn++
    }
    return drawn
  }

  destroy() {
    this.#depth && this.#gl.deleteRenderbuffer(this.#depth)
    this.#depth  = null
    this.#width  = 0
    this.#height = 0
  }
}
