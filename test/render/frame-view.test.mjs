// El portador de vista afín: `bind` sube bit a bit la matriz de `anchorMatrix` y no asigna.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createFrameView } from '../../src/render/frame-view.js'
import { anchorMatrix } from '../../src/render/anchor-matrix.js'
import { readView, projX0, projY0 } from '../../src/render/project.js'
import { bytesPorLlamada } from '../../test-helpers/asignaciones.mjs'

// Generador determinista: la prueba dorada no depende del azar de cada corrida.
const semilla = s => () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32

const glFalso = () => {
  const gl = { llamadas: [], escalas: [] }
  gl.uniformMatrix4fv = (loc, transpose, m) => { gl.loc = loc; gl.transpose = transpose; gl.m = m }
  gl.uniform1f = (loc, v) => { gl.escalas.push([loc, v]) }
  return gl
}

const camara = (zoom, lat, lng, w, h) => ({
  zoom  : () => zoom,
  center: () => ({ lat, lng }),
  size  : () => ({ x: w, y: h }),
})

test('el portador trae la forma de readView y lo constante del plano afín', () => {
  const f = createFrameView()
  assert.equal(f.pitch, 0)
  assert.equal(f.bearing, 0)
  assert.equal(f.affine, true)
  assert.deepEqual(f.projection, { name: 'mercator', variant: 'mercator', t: 0 })
  readView(camara(7, 10, 20, 300, 200), f)
  assert.equal(f.zoom, 7)
  assert.equal(f.center.x, projX0(20))
  assert.equal(f.center.y, projY0(10))
  assert.deepEqual(f.size, { x: 300, y: 200 })
})

const ORIGEN = { anchorX: 0, anchorY: 0 }

test('dorada: bind sube bit a bit anchorMatrix en 200 vistas al azar', () => {
  const rnd = semilla(42)
  const f = createFrameView()
  const gl = glFalso()
  const esperada = new Float32Array(16)
  for (let i = 0; i < 200; i++) {
    const zoom = rnd() * 20
    const lat  = (rnd() * 2 - 1) * 85
    const lng  = (rnd() * 2 - 1) * 180
    readView(camara(zoom, lat, lng, 100 + rnd() * 1900, 100 + rnd() * 1200), f)
    const ax = projX0(lng + (rnd() - 0.5)), ay = projY0(lat + (rnd() - 0.5))
    f.bind(gl, { matrix: 'm' }, { anchorX: ax, anchorY: ay })
    anchorMatrix(esperada, ax, ay, f.zoom, f.center, f.size)
    assert.equal(gl.loc, 'm')
    assert.equal(gl.transpose, false)
    for (let k = 0; k < 16; k++) assert.ok(Object.is(gl.m[k], esperada[k]), `vista ${i}, índice ${k}`)
  }
})

test('u_projection_scale sólo se sube si el programa la declara, y vale 2^zoom', () => {
  const f = createFrameView()
  f.zoom = 5.5
  const gl = glFalso()
  f.bind(gl, { matrix: 'm' }, ORIGEN)
  assert.equal(gl.escalas.length, 0)
  f.bind(gl, { matrix: 'm', scale: 's' }, ORIGEN)
  assert.deepEqual(gl.escalas, [['s', 2 ** 5.5]])
  assert.equal(f.pixelScaleAt(), 2 ** 5.5)
})

test('[0-alloc] bind y pixelAt no asignan', () => {
  const f = createFrameView()
  readView(camara(12, -33, -70, 800, 600), f)
  const gl = { uniformMatrix4fv() {}, uniform1f() {} }
  const locs = { matrix: 1, scale: 2 }
  const placed = { anchorX: 0, anchorY: 0 }
  const bytes = bytesPorLlamada(i => { placed.anchorX = placed.anchorY = i + 0.37; f.bind(gl, locs, placed); f.pixelScaleAt() }, 20_000, { calentar: 100_000 })
  assert.ok(bytes < 1, `${bytes} bytes por llamada`)
})
