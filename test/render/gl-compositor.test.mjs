// Compositor GL del tramo sobre un doble de gl que registra cada llamada: la transformación de vista (A1), el FBO del miembro y
// el estado base que deja `bind` (A2), la composición en orden con su opacidad y su transformación (A3), y el programa por
// contexto con `drop` (A4).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GlCompositor, viewTransform } from '../../src/render/gl-compositor.js'

// Las constantes valen su nombre; `create*` devuelve un objeto con su tipo y número; los uniformes quedan en `uniforms`.
const makeGl = ({ width = 800, height = 600 } = {}) => {
  const calls    = []
  const uniforms = {}
  let n = 0
  const fns = {
    getProgramParameter : () => true,
    isContextLost       : () => false,
    getUniformLocation  : (program, name) => name,
    uniform1f           : (loc, v) => { uniforms[loc] = [v] },
    uniform3f           : (loc, x, y, z) => { uniforms[loc] = [x, y, z] },
  }
  const gl = new Proxy({ drawingBufferWidth: width, drawingBufferHeight: height, calls, uniforms }, {
    get: (t, p) => {
      if (p in t) return t[p]
      if (typeof p !== 'string') return undefined
      if (/^[A-Z0-9_]+$/.test(p)) return p
      return (...args) => {
        calls.push([p, ...args])
        if (p.startsWith('create')) return { kind: p.slice(6), id: ++n }
        return fns[p]?.(...args)
      }
    },
  })
  return gl
}

const named   = (gl, name) => gl.calls.filter(c => c[0] === name)
const creates = gl => gl.calls.filter(c => c[0].startsWith('create'))
const view    = (zoom, cx, cy, w = 800, h = 600) => ({ zoom, center: { x: cx, y: cy }, size: { x: w, y: h } })
const target  = () => ({ fbo: null, texture: null, width: 0, height: 0 })

/* ── A1 viewTransform ── */

test('A1 viewTransform: identidad, arrastre, zoom alrededor del centro, DPR 2, sin asignar', () => {
  const out = new Float64Array(3)
  const v   = view(10, 1000, 2000)

  assert.equal(viewTransform(v, v, 1, out), out)
  assert.deepEqual([...out], [1, 0, 0])

  // la vista se corrió 30 px a la derecha y 12 hacia abajo: lo pintado se ve 30 a la izquierda y 12 arriba
  viewTransform(v, view(10, 1000 + 30 / 2 ** 10, 2000 + 12 / 2 ** 10), 1, out)
  assert.deepEqual([...out], [1, -30, -12])

  // zoom +1 con el mismo centro: el centro de pantalla queda fijo
  viewTransform(v, view(11, 1000, 2000), 1, out)
  assert.deepEqual([...out], [2, -400, -300])
  assert.equal(out[0] * 400 + out[1], 400)

  viewTransform(v, view(10, 1000 + 30 / 2 ** 10, 2000), 2, out)
  assert.deepEqual([...out], [1, -60, 0])
})

/* ── A2 bind ── */

const base = fbo => [
  ['activeTexture', 'TEXTURE0'],
  ['bindFramebuffer', 'FRAMEBUFFER', fbo],
  ['viewport', 0, 0, 640, 480],
  ['disable', 'DEPTH_TEST'],
  ['disable', 'STENCIL_TEST'],
  ['disable', 'SCISSOR_TEST'],
  ['disable', 'CULL_FACE'],
  ['colorMask', true, true, true, true],
  ['depthMask', true],
  ['stencilMask', 0xff],
  ['bindVertexArray', null],
]

test('A2 bind: perezoso, realoca sólo al cambiar de tamaño, un depth-stencil adjunto a cada FBO y el estado base exacto', () => {
  const gl = makeGl()
  const c  = new GlCompositor(gl)
  const a  = target()
  const b  = target()
  const created = creates(gl).length       // el programa

  assert.equal(c.bind(a, 640, 480), a)
  assert.equal(a.fbo.kind, 'Framebuffer')
  assert.equal(a.texture.kind, 'Texture')
  assert.deepEqual([a.width, a.height], [640, 480])
  assert.deepEqual(creates(gl).slice(created).map(([n]) => n), ['createTexture', 'createFramebuffer', 'createRenderbuffer'])
  assert.deepEqual(named(gl, 'texImage2D'), [['texImage2D', 'TEXTURE_2D', 0, 'RGBA8', 640, 480, 0, 'RGBA', 'UNSIGNED_BYTE', null]])
  assert.deepEqual(named(gl, 'texParameteri').map(c => c.slice(2)),
    [['TEXTURE_MIN_FILTER', 'NEAREST'], ['TEXTURE_MAG_FILTER', 'NEAREST'], ['TEXTURE_WRAP_S', 'CLAMP_TO_EDGE'], ['TEXTURE_WRAP_T', 'CLAMP_TO_EDGE']])

  const [[, , , , depth]] = named(gl, 'framebufferRenderbuffer')
  assert.equal(depth.kind, 'Renderbuffer')

  // el mismo tamaño: sólo el estado base, sin crear ni realocar
  gl.calls.length = 0
  c.bind(a, 640, 480)
  assert.deepEqual(gl.calls, base(a.fbo))

  // otro miembro: su FBO y su textura, el mismo depth-stencil adjunto, sin realocarlo
  c.bind(b, 640, 480)
  assert.notEqual(b.fbo, a.fbo)
  assert.deepEqual(named(gl, 'framebufferRenderbuffer'), [['framebufferRenderbuffer', 'FRAMEBUFFER', 'DEPTH_STENCIL_ATTACHMENT', 'RENDERBUFFER', depth]])
  assert.deepEqual(named(gl, 'framebufferTexture2D'), [['framebufferTexture2D', 'FRAMEBUFFER', 'COLOR_ATTACHMENT0', 'TEXTURE_2D', b.texture, 0]])
  assert.equal(named(gl, 'createRenderbuffer').length, 0)
  assert.equal(named(gl, 'renderbufferStorage').length, 0)

  // cambia el tamaño: realoca textura y depth-stencil, sin crear
  gl.calls.length = 0
  c.bind(a, 800, 600)
  assert.equal(creates(gl).length, 0)
  assert.equal(named(gl, 'texImage2D').length, 1)
  assert.deepEqual(named(gl, 'renderbufferStorage'), [['renderbufferStorage', 'RENDERBUFFER', 'DEPTH24_STENCIL8', 800, 600]])
  assert.deepEqual([a.width, a.height], [800, 600])
})

/* ── A3 compose ── */

// Espejo en JS de la cuenta del shader: el texel que lee el fragmento (X, Y) en px de framebuffer (origen abajo-izquierda).
const texelOf = (u, X, Y) => [Math.floor((X - u.tr[0]) / u.tr[2]), Math.floor((Y - u.tr[1]) / u.tr[2])]

test('A3 compose: un clear, un dibujo por entrada válida en orden, con su opacidad y su transformación, 0 create*', () => {
  const gl  = makeGl({ width: 1600, height: 1200 })
  const c   = new GlCompositor(gl)
  const dpr = 2
  const painted = view(10, 1000, 2000)
  const now     = view(10.5, 1000.01, 1999.97)
  const list = [
    { target: target(), painted, opacity: 1 },
    { target: target(), painted, opacity: 0 },
    { target: target(), painted: now, opacity: 0.5 },
    { target: target(), painted, opacity: 1 },
    { target: target(), painted, opacity: 0.25 },
  ]
  ;[0, 1, 2, 4].forEach(i => c.bind(list[i].target, 1600, 1200))   // la 3 no pintó: sin textura

  // un registro por dibujo: la textura enlazada y los uniformes vigentes en ese momento
  const draws = []
  let bound = null
  const record = new Proxy(gl, {
    get: (t, p) => p === 'bindTexture' ? (k, tex) => { bound = tex; return t.bindTexture(k, tex) }
      : p === 'drawArrays' ? (...args) => { draws.push({ tex: bound, op: t.uniforms.opacity[0], tr: [...t.uniforms.tr] }); return t.drawArrays(...args) }
        : t[p],
  })
  const counted = new GlCompositor(record)
  gl.calls.length = 0
  assert.equal(counted.compose(list, list.length, now, dpr), 3)

  assert.equal(creates(gl).length, 0)
  assert.deepEqual(named(gl, 'clear'), [['clear', 'COLOR_BUFFER_BIT']])
  assert.deepEqual(gl.calls.slice(0, 2), [['bindFramebuffer', 'FRAMEBUFFER', null], ['viewport', 0, 0, 1600, 1200]])
  assert.deepEqual(named(gl, 'blendFunc'), [['blendFunc', 'ONE', 'ONE_MINUS_SRC_ALPHA']])
  assert.ok(named(gl, 'disable').some(([, k]) => k === 'DEPTH_TEST'))
  assert.ok(named(gl, 'disable').some(([, k]) => k === 'STENCIL_TEST'))
  assert.ok(named(gl, 'disable').some(([, k]) => k === 'SCISSOR_TEST'))
  assert.ok(gl.calls.findIndex(c => c[0] === 'clear') < gl.calls.findIndex(c => c[0] === 'drawArrays'))
  assert.deepEqual(draws.map(d => d.tex), [list[0].target.texture, list[2].target.texture, list[4].target.texture])
  assert.deepEqual(draws.map(d => d.op), [1, 0.5, 0.25])
  assert.deepEqual(named(gl, 'drawArrays')[0], ['drawArrays', 'TRIANGLES', 0, 3])

  // la pintada con la vista de ahora es la identidad
  assert.deepEqual(draws[1].tr, [0, 0, 1])

  // un punto de mundo: su texel en el FBO pintado y su fragmento en la pantalla de ahora, contra el espejo del shader
  const toPx = (v, wx, wy) => [((wx - v.center.x) * 2 ** v.zoom + v.size.x / 2) * dpr, ((wy - v.center.y) * 2 ** v.zoom + v.size.y / 2) * dpr]
  ;[[1000.0003, 2000.0002], [999.9, 1999.85]].forEach(([wx, wy]) => {
    const [xp, yp] = toPx(painted, wx, wy)
    const [xn, yn] = toPx(now, wx, wy)
    const texel    = [Math.floor(xp), Math.floor(1200 - yp)]   // las filas del FBO van de abajo hacia arriba
    assert.deepEqual(texelOf(draws[0], xn, 1200 - yn), texel)
  })
  assert.equal(draws[0].tr[2], 2 ** 0.5)
  assert.deepEqual(draws[2].tr, draws[0].tr)
})

/* ── A4 programa y drop ── */

test('A4 el programa se enlaza una vez por gl; drop borra y vacía', () => {
  const gl = makeGl()
  const a  = new GlCompositor(gl)
  const b  = new GlCompositor(gl)
  const other = makeGl()
  new GlCompositor(other)                   // otro contexto, otra entrada de la caché
  assert.equal(named(gl, 'linkProgram').length, 1)
  assert.equal(named(other, 'linkProgram').length, 1)

  const t = target()
  a.bind(t, 100, 50)
  const { fbo, texture } = t
  assert.deepEqual(b.drop(t), { fbo: null, texture: null, width: 0, height: 0 })
  assert.deepEqual(named(gl, 'deleteFramebuffer'), [['deleteFramebuffer', fbo]])
  assert.deepEqual(named(gl, 'deleteTexture'), [['deleteTexture', texture]])

  a.destroy()
  assert.equal(named(gl, 'deleteRenderbuffer').length, 1)
  assert.equal(named(gl, 'deleteProgram').length, 0)
})
