// El preludio GLSL mercator: su lugar en el fuente y su equivalencia con el `pixelAt` de hoy.
import test from 'node:test'
import assert from 'node:assert/strict'
import { withProjection, projectionKey } from '../../src/render/projection-prelude.js'
import { createFrameView } from '../../src/render/frame-view.js'
import { readView, projX0, projY0 } from '../../src/render/project.js'

const FRAGMENTO = `#version 300 es
precision highp float;
precision mediump int;
out vec4 color;
void main() { color = vec4(1.0); }`

const FUNCIONES = ['projectRel', 'projectScreen', 'projectScale', 'projectHidden']

test('el preludio va después de #version y de las líneas precision', () => {
  const src = withProjection(FRAGMENTO)
  const lineas = src.split('\n')
  assert.equal(lineas[0], '#version 300 es')
  assert.equal(lineas[1], 'precision highp float;')
  assert.equal(lineas[2], 'precision mediump int;')
  assert.ok(src.indexOf('projectRel') > src.indexOf('precision mediump int;'))
  assert.ok(src.indexOf('projectRel') < src.indexOf('void main'))
})

test('declara cada función y el uniforme una sola vez, sin la palabra reservada flat', () => {
  const src = withProjection(FRAGMENTO, 'mercator')
  for (const nombre of FUNCIONES) {
    assert.equal(src.match(new RegExp(`\\b\\w+\\s+${nombre}\\(`, 'g')).length, 1, nombre)
  }
  assert.equal(src.match(/uniform float u_projection_scale/g).length, 1)
  assert.ok(!/\bflat\b/.test(src))
})

test('una variante desconocida lanza', () => {
  assert.throws(() => withProjection(FRAGMENTO, 'sphere'), /desconocida/)
})

test('projectionKey compone base y variante', () => {
  assert.equal(projectionKey('terreno', 'mercator'), 'terreno:mercator')
})

test('un gemelo con Math.fround de fm * vec4(rel, 0, 1) reproduce el pixelAt de hoy', () => {
  const f = createFrameView()
  readView({ zoom: () => 13, center: () => ({ lat: -33.4, lng: -70.6 }), size: () => ({ x: 900, y: 700 }) }, f)
  const gl = { uniformMatrix4fv(_l, _t, m) { gl.m = m }, uniform1f() {} }
  const ax = projX0(-70.61), ay = projY0(-33.41)
  f.bind(gl, { matrix: 0 }, { anchorX: ax, anchorY: ay })
  const fm = gl.m
  const px = { x: f.size.x / 2, y: f.size.y / 2 }
  const r = Math.fround
  for (const [rx, ry] of [[0, 0], [12.5, -7.25], [-300, 410], [1e-3, 2e-3]]) {
    const vx = r(rx), vy = r(ry)
    // columna a columna, como la GPU: sumas en float32 en el orden x, y, z, w
    const cx = r(r(r(r(fm[0] * vx) + r(fm[4] * vy)) + r(fm[8] * 0)) + fm[12])
    const cy = r(r(r(r(fm[1] * vx) + r(fm[5] * vy)) + r(fm[9] * 0)) + fm[13])
    const hoy = [r(cx / px.x), r(cy / px.y)]
    // el preludio devuelve `fm * vec4(rel, 0, 1)`: con z = 0 y w = 1 la xy es la misma cuenta
    const prelu = [r(r(r(fm[0] * vx) + r(fm[4] * vy)) + fm[12]), r(r(r(fm[1] * vx) + r(fm[5] * vy)) + fm[13])]
    assert.ok(Object.is(r(prelu[0] / px.x), hoy[0]))
    assert.ok(Object.is(r(prelu[1] / px.y), hoy[1]))
  }
})
