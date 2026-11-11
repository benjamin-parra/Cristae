// cristae/geometry es una hoja: no importa render, motor, anfitrión ni cámara, y la fórmula de Mercator
// que comparte con ellos vive en una hoja sin imports. Corre con: node --test test/geometry/hoja.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { MAXLAT, WORLD0, projX0, projY0, unprojX0, unprojY0 } from '../../src/projection/mercator.js'

const dirGeometria = fileURLToPath(new URL('../../src/geometry/', import.meta.url))
const mercator     = fileURLToPath(new URL('../../src/projection/mercator.js', import.meta.url))

const PROHIBIDOS = ['../render/', '../engine/', '../host/', '../camera/']

test('ningún módulo de src/geometry importa render, motor, anfitrión ni cámara', () => {
  for (const f of readdirSync(dirGeometria).filter(n => n.endsWith('.js'))) {
    const texto = readFileSync(dirGeometria + f, 'utf8')
    for (const p of PROHIBIDOS) assert.ok(!texto.includes(p), `${f} importa ${p}`)
  }
})

test('la hoja de Mercator no tiene ningún import', () => {
  const texto = readFileSync(mercator, 'utf8')
  assert.ok(!/^\s*import\s/m.test(texto) && !/\bimport\s*\(/.test(texto))
})

// Copia literal de la fórmula de SPECS §13.
const D = Math.PI / 180
const x0Spec = lng => 256 * (lng / 360 + 0.5)
const y0Spec = lat => {
  const c = lat > 85.0511287798 ? 85.0511287798 : lat < -85.0511287798 ? -85.0511287798 : lat
  const s = Math.sin(c * D)
  return 256 * (0.5 - 0.25 / Math.PI * Math.log((1 + s) / (1 - s)))
}

const LATS = [-95, -90, -85.0511287798, -60, -33.45, -1e-9, 0, 1e-9, 12.5, 45, 70, 85.0511287798, 90, 95]
const LNGS = [-540, -180, -123.4, -1, 0, 0.5, 90, 179.999, 180, 190, 360]

test('projX0 y projY0 son idénticas bit a bit a la fórmula de SPECS §13', () => {
  for (const lng of LNGS) assert.ok(Object.is(projX0(lng), x0Spec(lng)), `x ${lng}`)
  for (const lat of LATS) assert.ok(Object.is(projY0(lat), y0Spec(lat)), `y ${lat}`)
})

test('unprojX0 y unprojY0 invierten a 1e-9 grados dentro de ±MAXLAT', () => {
  assert.equal(WORLD0, 256)
  for (const lng of LNGS) assert.ok(Math.abs(unprojX0(projX0(lng)) - lng) <= 1e-9, `lng ${lng}`)
  for (const lat of LATS.filter(l => Math.abs(l) <= MAXLAT))
    assert.ok(Math.abs(unprojY0(projY0(lat)) - lat) <= 1e-9, `lat ${lat}`)
})
