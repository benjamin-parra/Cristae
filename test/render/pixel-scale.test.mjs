// `pixelScaleOf`: los píxeles del drawing buffer por píxel CSS del canvas. Donde no hay escala observable —sin caja
// en pantalla, o con un buffer sin tamaño, que es lo que un contexto perdido dice— vale 1: el 0 anularía todo lo que
// se multiplique por ella (el tamaño de los sprites, el origen del recorte del pase de picking).
import test from 'node:test'
import assert from 'node:assert/strict'
import { pixelScaleOf } from '../../src/render/pixel-scale.js'

const gl = (clientWidth, drawingBufferWidth) => ({ canvas: { clientWidth }, drawingBufferWidth })

test('es el cociente del buffer sobre la caja CSS', () => {
  assert.equal(pixelScaleOf(gl(800, 1600)), 2)
  assert.equal(pixelScaleOf(gl(800, 800)), 1)
  assert.equal(pixelScaleOf(gl(800, 400)), 0.5)
})

test('sin caja en pantalla vale 1', () => {
  assert.equal(pixelScaleOf(gl(0, 1600)), 1)
  assert.equal(pixelScaleOf(gl(undefined, 1600)), 1)
  assert.equal(pixelScaleOf(null), 1)
})

test('con el buffer en 0 —un contexto perdido— vale 1 y no 0', () => {
  assert.equal(pixelScaleOf(gl(800, 0)), 1)
  assert.equal(pixelScaleOf(gl(800, undefined)), 1)
})
