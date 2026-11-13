// Los shaders del calor sobre un doble de GL que anota llamadas. Lo que se fija:
//   · los fuentes llevan el preludio de proyección, `projectRel` y `projectHidden`, y la rampa no proyecta;
//   · las constantes del GLSL son las de heat-math, leídas de sus literales;
//   · `heatFormat`: R16F con extensión y FBO completo; RGBA8 sin extensión o con el FBO incompleto; una sonda por contexto;
//   · `heatPrograms` se comparte por contexto y formato, y lanza con un LINK_STATUS falso.
// Corre con: node --test test/render/heat-shaders.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { heatFormat, heatPrograms, heatSources, SPLAT_VERTEX, SPLAT_FRAGMENT_LOGSUM, SPLAT_FRAGMENT_OVER, RAMP_FRAGMENT_LOGSUM,
  RAMP_FRAGMENT_OVER, SPLAT_UNIFORMS, RAMP_UNIFORMS, SPLAT_CELL_VERTEX, SPLAT_CELL_FRAGMENT_LOGSUM, SPLAT_CELL_FRAGMENT_OVER,
  CELL_UNIFORMS, heatCellProgram, heatCellSources } from '../../src/render/heat-shaders.js'
import { POINT_ALPHA, MIN_OPACITY, TERM_CAP, TERM_FLOOR, GRAD_STEPS, SPREAD_MIN_PX, BOX_HALF_PER_SIGMA } from '../../src/render/heat-math.js'

const CONSTANTES = ['ONE', 'ZERO', 'R16F', 'RGBA8', 'RED', 'RGBA', 'HALF_FLOAT', 'UNSIGNED_BYTE', 'TEXTURE_2D', 'FRAMEBUFFER',
  'COLOR_ATTACHMENT0', 'FRAMEBUFFER_COMPLETE', 'FRAMEBUFFER_BINDING', 'TEXTURE_BINDING_2D', 'ONE_MINUS_SRC_ALPHA',
  'VERTEX_SHADER', 'FRAGMENT_SHADER', 'LINK_STATUS']

// Un contexto que anota [nombre, ...args]. `ext` dice si hay extensión de color flotante, `completo` el estado de la sonda
// y `enlaza` el LINK_STATUS.
const glDoble = ({ ext = true, completo = true, enlaza = true, perdido = false } = {}) => {
  const calls = []
  const gl = {
    calls,
    isContextLost       : () => perdido,
    getExtension        : name => { calls.push(['getExtension', name]); return ext && name === 'EXT_color_buffer_float' ? {} : null },
    checkFramebufferStatus : () => (completo ? gl.FRAMEBUFFER_COMPLETE : 0),
    getProgramParameter : () => enlaza,
    getProgramInfoLog   : () => 'boom',
    getParameter        : () => null,
    getUniformLocation  : (_p, name) => ({ name }),
    createProgram       : () => ({}),
    createShader        : () => ({}),
    createTexture       : () => ({}),
    createFramebuffer   : () => ({}),
  }
  CONSTANTES.forEach((name, k) => (gl[name] = 0x1000 + k))
  ;['shaderSource', 'compileShader', 'attachShader', 'linkProgram', 'deleteShader', 'useProgram', 'uniform1i', 'bindTexture',
    'texImage2D', 'bindFramebuffer', 'framebufferTexture2D', 'deleteFramebuffer', 'deleteTexture'].forEach(name => {
    gl[name] = (...args) => calls.push([name, ...args])
  })
  return gl
}

const literal = (fuente, nombre) => {
  const m = fuente.match(new RegExp(`const\\s+(?:float|int)\\s+${nombre}\\s*=\\s*([-0-9.e+]+);`))
  assert.ok(m, `falta la constante ${nombre}`)
  return Number(m[1])
}

test('el vértice del splat lleva el preludio, projectRel y projectHidden; la rampa no proyecta', () => {
  const { splat, ramp } = heatSources('r16f')
  assert.match(splat.vertex, /vec4 projectRel\(/)
  assert.match(splat.vertex, /bool projectHidden\(/)
  assert.match(splat.vertex, /projectRel\(uMatrix, aRel\)/)
  assert.match(splat.vertex, /if \(projectHidden\(clip\)\)/)
  assert.ok(splat.vertex.startsWith('#version 300 es'))
  assert.doesNotMatch(ramp.vertex, /projectRel/)
  assert.doesNotMatch(ramp.fragment, /projectRel/)
  assert.match(splat.vertex, /layout\(location = 0\) in vec2\s+aRel/)
  assert.match(splat.vertex, /layout\(location = 1\) in float aWeight/)
})

test('las constantes del GLSL coinciden con heat-math', () => {
  const fuentes = [SPLAT_VERTEX, SPLAT_FRAGMENT_LOGSUM, SPLAT_FRAGMENT_OVER, RAMP_FRAGMENT_LOGSUM, RAMP_FRAGMENT_OVER,
    SPLAT_CELL_VERTEX, SPLAT_CELL_FRAGMENT_LOGSUM, SPLAT_CELL_FRAGMENT_OVER]
  fuentes.forEach(f => {
    assert.equal(literal(f, 'POINT_ALPHA'), POINT_ALPHA)
    assert.equal(literal(f, 'MIN_OPACITY'), MIN_OPACITY)
    assert.equal(literal(f, 'TERM_CAP'), TERM_CAP)
    assert.equal(literal(f, 'TERM_FLOOR'), TERM_FLOOR)
    assert.equal(literal(f, 'GRAD_STEPS'), GRAD_STEPS)
  })
  assert.equal(literal(RAMP_FRAGMENT_LOGSUM, 'LEVELS'), GRAD_STEPS - 1)
})

test('cada ruta usa su ley: logsum suma términos, over cuantiza el alfa', () => {
  assert.match(SPLAT_FRAGMENT_LOGSUM, /out float outSum/)
  assert.match(SPLAT_FRAGMENT_LOGSUM, /-log\(max\(1\.0 - vContribution \* g, TERM_FLOOR\)\)/)
  assert.match(SPLAT_FRAGMENT_OVER, /outAlpha = vec4\(0\.0, 0\.0, 0\.0, q\)/)
  assert.match(RAMP_FRAGMENT_LOGSUM, /1\.0 - exp\(-/)
  assert.match(RAMP_FRAGMENT_OVER, /\.a\)/)
  assert.match(SPLAT_FRAGMENT_LOGSUM, /if \(g <= 0\.0\) discard/)
})

test('heatFormat: con extensión y FBO completo es r16f, con su mezcla de suma', () => {
  const gl = glDoble()
  const f = heatFormat(gl)
  assert.equal(f.name, 'r16f')
  assert.equal(f.internalFormat, gl.R16F)
  assert.equal(f.format, gl.RED)
  assert.equal(f.type, gl.HALF_FLOAT)
  assert.deepEqual([f.blendSrc, f.blendDst], [gl.ONE, gl.ONE])
})

test('heatFormat: sin extensión es rgba8 con mezcla over y sin sonda', () => {
  const gl = glDoble({ ext: false })
  const f = heatFormat(gl)
  assert.equal(f.name, 'rgba8')
  assert.equal(f.internalFormat, gl.RGBA8)
  assert.equal(f.type, gl.UNSIGNED_BYTE)
  assert.deepEqual([f.blendSrc, f.blendDst], [gl.ONE, gl.ONE_MINUS_SRC_ALPHA])
  assert.equal(gl.calls.filter(c => c[0] === 'framebufferTexture2D').length, 0)
})

test('heatFormat: con extensión y FBO incompleto cae a rgba8, y la sonda no deja nada creado', () => {
  const gl = glDoble({ completo: false })
  assert.equal(heatFormat(gl).name, 'rgba8')
  assert.equal(gl.calls.filter(c => c[0] === 'deleteFramebuffer').length, 1)
  assert.equal(gl.calls.filter(c => c[0] === 'deleteTexture').length, 1)
})

test('heatFormat: una sola sonda por contexto, y otra en un contexto nuevo', () => {
  const gl = glDoble()
  const a = heatFormat(gl)
  assert.equal(heatFormat(gl), a)
  assert.equal(gl.calls.filter(c => c[0] === 'framebufferTexture2D').length, 1)
  assert.equal(gl.calls.filter(c => c[0] === 'getExtension').length, 1)
  const otro = glDoble()
  heatFormat(otro)
  assert.equal(otro.calls.filter(c => c[0] === 'framebufferTexture2D').length, 1)
})

test('heatPrograms: compartido por contexto y formato, con sus uniformes y las unidades de la rampa', () => {
  const gl = glDoble()
  const r16f = heatFormat(gl)
  const a = heatPrograms(gl, r16f)
  assert.equal(heatPrograms(gl, r16f), a)
  assert.equal(gl.calls.filter(c => c[0] === 'linkProgram').length, 2)
  SPLAT_UNIFORMS.forEach(n => assert.equal(a.splat[n].name, n))
  RAMP_UNIFORMS.forEach(n => assert.equal(a.ramp[n].name, n))
  assert.equal(a.splat.matrix, a.splat.uMatrix)
  assert.equal(a.ramp.matrix, a.ramp.uMatrix)
  assert.deepEqual(gl.calls.filter(c => c[0] === 'uniform1i').map(c => [c[1].name, c[2]]), [['uAcc', 0], ['uPaleta', 1]])
  assert.notEqual(heatPrograms(gl, { name: 'rgba8' }), a)
  assert.equal(gl.calls.filter(c => c[0] === 'linkProgram').length, 4)
  const otro = glDoble()
  assert.notEqual(heatPrograms(otro, heatFormat(otro)), a)
})

test('heatPrograms: un LINK_STATUS falso lanza, salvo con el contexto perdido', () => {
  const gl = glDoble({ enlaza: false })
  assert.throws(() => heatPrograms(gl, { name: 'r16f' }), /no linkea: boom/)
  assert.doesNotThrow(() => heatPrograms(glDoble({ enlaza: false, perdido: true }), { name: 'r16f' }))
})

test('las celdas suman n veces el término con la brocha promediada, y su quad llega a R + s', () => {
  const { vertex, fragment } = heatCellSources('r16f')
  assert.match(vertex, /projectRel\(uMatrix, aRel\)/)
  ;[['float', 'aContribution', 1], ['float', 'aCount', 2], ['vec3', 'aCov', 3]].forEach(([t, a, k]) => assert.match(vertex, new RegExp(`layout\\(location = ${k}\\) in ${t}\\s+${a}`)))
  // La covarianza pasa a px del FBO con el jacobiano de la proyección, medido con un px de pantalla por eje: J·Σ·Jᵀ.
  assert.match(vertex, /float k = 1\.0 \/ uPxPorWorld0;/)
  assert.match(vertex, /vec2 ex = \(toAcc\(projectRel\(uMatrix, aRel \+ vec2\(k, 0\.0\)\)\) - vCenter\) \/ k;/)
  assert.match(vertex, /vec2 ey = \(toAcc\(projectRel\(uMatrix, aRel \+ vec2\(0\.0, k\)\)\) - vCenter\) \/ k;/)
  assert.match(vertex, /vCov = vec3\(aCov\.x \* ex\.x \* ex\.x \+ aCov\.y \* ey\.x \* ey\.x \+ 2\.0 \* aCov\.z \* ex\.x \* ey\.x,/)
  assert.match(vertex, /aCov\.x \* ex\.y \* ex\.y \+ aCov\.y \* ey\.y \* ey\.y \+ 2\.0 \* aCov\.z \* ex\.y \* ey\.y,/)
  assert.match(vertex, /aCov\.x \* ex\.x \* ex\.y \+ aCov\.y \* ey\.x \* ey\.y \+ aCov\.z \* \(ex\.x \* ey\.y \+ ex\.y \* ey\.x\)\);/)
  assert.match(vertex, /float reach = uRadius \+ BOX_HALF_PER_SIGMA \* sqrt\(max\(vCov\.x \+ vCov\.y, 0\.0\)\)/)
  assert.match(vertex, /corner \* reach/)
  assert.equal(literal(vertex, 'BOX_HALF_PER_SIGMA'), BOX_HALF_PER_SIGMA)
  assert.equal(literal(fragment, 'BOX_HALF_PER_SIGMA'), BOX_HALF_PER_SIGMA)
  assert.match(fragment, /outSum = vCount \* -log\(max\(1\.0 - vContribution \* g, TERM_FLOOR\)\)/)
  assert.match(fragment, /float g = cellBrush\(\)/)
  assert.equal(literal(fragment, 'SPREAD_MIN_PX'), SPREAD_MIN_PX)
  assert.match(fragment, /if \(s < SPREAD_MIN_PX \|\| w <= 0\.0\) return brush\(\)/)
  assert.match(fragment, /if \(d \+ s <= uCore\) return 1\.0;/)
  assert.match(fragment, /if \(d - s >= uRadius\) return 0\.0;/)
  assert.match(fragment, /return 1\.0 - w \/ \(2\.0 \* s\) \* \(rampIntegral\(\(d \+ s - uCore\) \/ w\) - rampIntegral\(\(d - s - uCore\) \/ w\)\);/)
  assert.match(fragment, /float sigma2 = d > 0\.0 \?/)
  assert.match(fragment, /: 0\.5 \* \(vCov\.x \+ vCov\.y\)/)
  assert.match(fragment, /\(vCov\.x \* dv\.x \* dv\.x \+ vCov\.y \* dv\.y \* dv\.y \+ 2\.0 \* vCov\.z \* dv\.x \* dv\.y\) \/ \(d \* d\)/)
  assert.match(heatCellSources('rgba8').fragment, /1\.0 - pow\(1\.0 - q, vCount\)/)
})

test('heatCellProgram: aparte de heatPrograms, compartido por contexto y formato, con sus uniformes', () => {
  const gl = glDoble()
  const f = heatFormat(gl)
  heatPrograms(gl, f)
  const a = heatCellProgram(gl, f)
  assert.equal(heatCellProgram(gl, f), a)
  assert.equal(gl.calls.filter(c => c[0] === 'linkProgram').length, 3)
  CELL_UNIFORMS.forEach(n => assert.equal(a[n].name, n))
  assert.equal(a.matrix, a.uMatrix)
})
