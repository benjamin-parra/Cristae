// Referencia ideal float64 y gemelos de GPU: los gemelos quedan dentro de TOLERANCIA contra el ideal.
// Viewport chico para no gastar RAM; la escala real se mide en el escenario de navegador.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  conjunto, ideal, gemeloLogsum, gemeloOver8, f16, comparar, TOLERANCIA,
} from '../../test-helpers/calor-ideal.mjs'

const ANCHO = 256
const ALTO  = 192
// La media de TOLERANCIA se midió con 5 000 a 100 000 puntos en un viewport de ~2 M px (de 0,0025 a 0,05
// puntos por px). Acá el viewport es ~40 veces menor, así que CASOS (media y máximo) lleva la misma
// densidad por px y DENSOS (sólo máximo, de 2 000 a 8 000 puntos) la fuerza: la cuantización de 8 bits
// acumula con el solape, y sólo el máximo es independiente de la densidad.
const CASOS = [
  { n: 200, radius: 25, blur: 15, intensity: 1 },
  { n: 800, radius: 10, blur: 5,  intensity: 1 },
  { n: 300, radius: 20, blur: 0,  intensity: 1 },
]
const DENSOS = [
  { n: 2000, radius: 25, blur: 15, intensity: 1 },
  { n: 8000, radius: 10, blur: 5,  intensity: 1 },
  { n: 300,  radius: 25, blur: 15, intensity: 20 },   // c·g llega a 1 en el núcleo: el argumento del log se acota
]
const arma = caso => {
  const args = { ancho: ANCHO, alto: ALTO, puntos: conjunto({ semilla: 7, n: caso.n, ancho: ANCHO, alto: ALTO }), ...caso }
  return { args, ref: ideal(args).indice }
}

test('f16: más cercano, hacia cero, subnormales y desborde', () => {
  assert.equal(f16(1), 1)
  assert.equal(f16(1 + 2 ** -11, 'cercano'), 1, 'empate al par')
  assert.equal(f16(1 + 2 ** -11, 'cero'), 1)
  assert.equal(f16(1 + 3 * 2 ** -12, 'cercano'), 1 + 2 ** -10)
  assert.equal(f16(1 + 3 * 2 ** -12, 'cero'), 1)
  assert.equal(f16(2 ** -24, 'cero'), 2 ** -24)
  assert.equal(f16(2 ** -26, 'cero'), 0)
  assert.equal(f16(70000, 'cercano'), Infinity)
  assert.equal(f16(70000, 'cero'), 65504)
  assert.equal(f16(-1.0004, 'cero'), -1)
})

test('conjunto: determinista, peso máximo 1 y dentro de rango de pesos', () => {
  const a = conjunto({ semilla: 3, n: 500, ancho: ANCHO, alto: ALTO })
  const b = conjunto({ semilla: 3, n: 500, ancho: ANCHO, alto: ALTO })
  assert.deepEqual(a, b)
  assert.equal(Math.max(...a.map(p => p.peso)), 1)
  assert.ok(a.every(p => p.peso > 0 && p.peso <= 1))
})

test('gemelo f16 al más cercano y hacia cero: dentro de TOLERANCIA.r16f', () => {
  CASOS.forEach(caso => {
    const { args, ref } = arma(caso)
    ;['f16-cercano', 'f16-cero'].forEach(almacen => {
      const c = comparar(gemeloLogsum({ ...args, almacen }), ref)
      assert.ok(c.max <= TOLERANCIA.r16f.max, `${almacen} ${JSON.stringify(caso)} max ${c.max}`)
      assert.ok(c.media <= TOLERANCIA.r16f.media, `${almacen} ${JSON.stringify(caso)} media ${c.media}`)
    })
  })
})

test('gemelos con campo denso: el máximo sigue dentro de TOLERANCIA', () => {
  DENSOS.forEach(caso => {
    const { args, ref } = arma(caso)
    ;['f16-cercano', 'f16-cero'].forEach(almacen => {
      assert.ok(comparar(gemeloLogsum({ ...args, almacen }), ref).max <= TOLERANCIA.r16f.max, `${almacen} ${JSON.stringify(caso)}`)
    })
    assert.ok(comparar(gemeloOver8(args), ref).max <= TOLERANCIA.rgba8.max, `over8 ${JSON.stringify(caso)}`)
  })
})

test('gemelo f32: error máximo de un nivel', () => {
  CASOS.concat(DENSOS).forEach(caso => {
    const { args, ref } = arma(caso)
    assert.ok(comparar(gemeloLogsum({ ...args, almacen: 'f32' }), ref).max <= 1, JSON.stringify(caso))
  })
})

test('gemelo over8: dentro de TOLERANCIA.rgba8', () => {
  CASOS.forEach(caso => {
    const { args, ref } = arma(caso)
    const c = comparar(gemeloOver8(args), ref)
    assert.ok(c.max <= TOLERANCIA.rgba8.max, `${JSON.stringify(caso)} max ${c.max}`)
    assert.ok(c.media <= TOLERANCIA.rgba8.media, `${JSON.stringify(caso)} media ${c.media}`)
  })
})

test('ideal: 60 puntos coincidentes llegan a 255 (el canvas no lo lograba)', () => {
  const puntos = Array.from({ length: 60 }, () => ({ x: 50.5, y: 50.5, peso: 1 }))
  const { indice } = ideal({ ancho: 100, alto: 100, puntos, radius: 25, blur: 15, intensity: 1 })
  assert.equal(indice[50 * 100 + 50], 255)
  assert.equal(indice[0], 0, 'lejos del campo no hay calor')
})

test('ideal: el pico de un punto aislado es round(c·255)', () => {
  const peso   = 1
  const puntos = [{ x: 50.5, y: 50.5, peso }]
  const { indice } = ideal({ ancho: 100, alto: 100, puntos, radius: 25, blur: 15, intensity: 1 })
  assert.equal(indice[50 * 100 + 50], Math.round(0.12 * 255))
  const { indice: bajo } = ideal({ ancho: 100, alto: 100, puntos: [{ x: 50.5, y: 50.5, peso: 0.1 }], radius: 25, blur: 15, intensity: 1 })
  assert.equal(bajo[50 * 100 + 50], Math.round(0.05 * 255), 'el piso MIN_OPACITY')
})

test('ideal: blur 0 es un cono de radio `radius` y R = 0 no pinta', () => {
  const puntos = [{ x: 50.5, y: 50.5, peso: 1 }]
  const cono = ideal({ ancho: 100, alto: 100, puntos, radius: 20, blur: 0, intensity: 1 }).indice
  assert.equal(cono[50 * 100 + 50], Math.round(0.12 * 255))
  assert.ok(cono[50 * 100 + 60] < cono[50 * 100 + 50] && cono[50 * 100 + 60] > 0)
  assert.equal(cono[50 * 100 + 71], 0)
  assert.ok(ideal({ ancho: 100, alto: 100, puntos, radius: 0, blur: 0, intensity: 1 }).indice.every(v => v === 0))
})
