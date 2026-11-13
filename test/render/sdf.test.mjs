// El campo de un disco de radio 8 con borde antialiasado: lejos del borde la distancia es la euclídea, con error de
// menos de medio px, en todo el rango que guarda el atlas (RADIO y CORTE de los rótulos `gl`).
import test from 'node:test'
import assert from 'node:assert/strict'
import { createScratch, distanceField, fitScratch } from '../../src/render/sdf.js'
import { CORTE, RADIO } from '../../src/render/labelGlyphs.js'

const W = 40, H = 40, R = 8, CX = 20, CY = 20
const SUB = 16                                   // submuestras por eje para la cobertura de un píxel

const disco = () => {
  const img = new Uint8ClampedArray(W * H * 4)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let dentro = 0
    for (let j = 0; j < SUB; j++) for (let i = 0; i < SUB; i++)
      Math.hypot(x + (i + 0.5) / SUB - CX, y + (j + 0.5) / SUB - CY) <= R && dentro++
    img[4 * (y * W + x) + 3] = Math.round(255 * dentro / (SUB * SUB))
  }
  return img
}

test('la distancia del campo de un disco coincide con la euclídea a menos de medio px', () => {
  const out = new Uint8Array(W * H)
  distanceField(disco(), W, H, RADIO, CORTE, createScratch(64), out, 0, W)
  let peor = 0, medidos = 0
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const real = Math.hypot(x + 0.5 - CX, y + 0.5 - CY) - R
    if (real < -RADIO * CORTE + 0.5 || real > RADIO * (1 - CORTE) - 0.5) continue   // fuera del rango que guarda
    const leida = (1 - CORTE - out[y * W + x] / 255) * RADIO
    peor = Math.max(peor, Math.abs(leida - real))
    medidos++
  }
  assert.ok(medidos > 500, `${medidos} px en el rango`)
  assert.ok(peor < 0.5, `error máximo ${peor.toFixed(3)} px`)
})

test('escribe en su celda con el paso de la página, sin tocar lo de al lado', () => {
  const paso = W + 10
  const out  = new Uint8Array(paso * (H + 2)).fill(7)
  distanceField(disco(), W, H, RADIO, CORTE, createScratch(64), out, paso + 5, paso)
  assert.equal(out[0], 7)
  assert.equal(out[paso + 4], 7, 'el margen izquierdo de la fila')
  assert.equal(out[paso + 5 + W], 7, 'el derecho')
  assert.equal(out[(H + 1) * paso + 5], 7, 'la fila de abajo')
  assert.equal(out[(1 + CY) * paso + 5 + CX], 255, 'el centro del disco, adentro de todo')
})

test('fitScratch reusa el que alcanza y agranda el que no', () => {
  const s = createScratch(64)
  assert.equal(fitScratch(s, 64, 40), s)
  const t = fitScratch(s, 90, 20)
  assert.ok(t !== s && t.side >= 90 && t.area >= 90 * 20)
})
