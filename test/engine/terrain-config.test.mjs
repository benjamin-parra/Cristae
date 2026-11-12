import test from 'node:test'
import assert from 'node:assert/strict'
import { readTerrainConfig, updateTerrainConfig, DEFAULT_SLOPE_LOW, DEFAULT_SLOPE_HIGH } from '../../src/engine/terrain-config.js'
import { parseColor } from '../../src/render/color.js'
import { terrainPresets } from '../../src/geometry/terrain-presets.js'
import { MAX_SLOPE_BREAKS } from '../../src/render/terrain-shaders.js'

const base = { id: 't', dem: 'aws' }
const read = extra => readTerrainConfig({ ...base, ...extra })
const SOURCE = { url: 'https://x/{z}/{x}/{y}.png', encoding: 'mapbox', zoom: 10, maxZoom: 14, tileSize: 512 }

test('valores por defecto y objeto congelado', () => {
  const c = read()
  assert.ok(Object.isFrozen(c))
  assert.equal(c.colorBy, 'none')
  assert.equal(c.contours, 0)
  assert.equal(c.opacity, 1)
  assert.equal(c.visible, true)
  assert.equal(c.elevationRange, null)
  assert.equal(c.clipTo, undefined)
  assert.deepEqual(c.slopeBreaks, [])
  assert.equal(c.source.zoom, terrainPresets.aws.zoom)
})

test('dem: preset propio, fuente completa y rechazos', () => {
  assert.equal(read({ dem: 'mapterhorn' }).source.tileSize, 512)
  assert.equal(read({ dem: SOURCE }).source.encoding, 'mapbox')
  assert.throws(() => read({ dem: 'toString' }), /dem desconocido/)
  assert.throws(() => read({ dem: 'nada' }), TypeError)
  assert.throws(() => readTerrainConfig({ id: 't' }), /falta dem/)
  assert.throws(() => read({ dem: { ...SOURCE, url: 'https://x/{z}/{x}.png' } }), /\{z\}, \{x\} e \{y\}/)
  assert.throws(() => read({ dem: { ...SOURCE, encoding: 'png' } }), /encoding/)
  assert.throws(() => read({ dem: { ...SOURCE, zoom: 15 } }), RangeError)
  assert.throws(() => read({ dem: { ...SOURCE, zoom: 1.5 } }), /zoom/)
  assert.throws(() => read({ dem: { ...SOURCE, maxZoom: 25 } }), /maxZoom/)
  assert.throws(() => read({ dem: { ...SOURCE, tileSize: 0 } }), /tileSize/)
  assert.throws(() => read({ dem: [] }), TypeError)
})

test('hillshade: por defecto sigue a colorBy, en ambos sentidos', () => {
  assert.equal(read().hillshade, true)
  assert.equal(read({ colorBy: 'slope' }).hillshade, false)
  assert.equal(read({ colorBy: 'elevation' }).hillshade, false)
  assert.equal(read({ colorBy: 'slope', hillshade: true }).hillshade, true)
  assert.equal(read({ hillshade: false }).hillshade, false)
  assert.throws(() => read({ hillshade: 'false' }), /hillshade/)
})

test('colorBy, contours, opacity, visible, clipTo, fetch', () => {
  assert.throws(() => read({ colorBy: 'aspect' }), /colorBy/)
  for (const v of [-1, NaN, Infinity, '10']) assert.throws(() => read({ contours: v }), /contours/)
  assert.equal(read({ contours: 10 }).contours, 10)
  for (const v of [-0.1, 1.1, NaN, '1']) assert.throws(() => read({ opacity: v }), /opacity/)
  assert.equal(read({ opacity: 0 }).opacity, 0)
  assert.throws(() => read({ visible: 1 }), /visible/)
  assert.throws(() => read({ clipTo: '' }), /clipTo/)
  assert.throws(() => read({ clipTo: 3 }), /clipTo/)
  assert.equal(read({ clipTo: 'predios' }).clipTo, 'predios')
  assert.throws(() => read({ fetch: 'x' }), /fetch/)
  const f = () => {}
  assert.equal(read({ fetch: f }).fetch, f)
  assert.throws(() => readTerrainConfig(null), TypeError)
  assert.throws(() => read({ id: '' }), /id/)
})

test('slopeBreaks: finitos, >= 0, estrictamente crecientes y con tope', () => {
  assert.deepEqual(read({ slopeBreaks: [0.15, 0.3] }).slopeBreaks, [0.15, 0.3])
  assert.deepEqual(read({ slopeBreaks: [0] }).slopeBreaks, [0])
  assert.throws(() => read({ slopeBreaks: '15%' }), /array/)
  assert.throws(() => read({ slopeBreaks: [-1] }), /slopeBreaks/)
  assert.throws(() => read({ slopeBreaks: [0.3, 0.3] }), /creciente/)
  assert.throws(() => read({ slopeBreaks: [0.3, 0.1] }), /creciente/)
  assert.throws(() => read({ slopeBreaks: [NaN] }), /slopeBreaks/)
  assert.throws(() => read({ slopeBreaks: ['0.1'] }), /slopeBreaks/)
  const many = Array.from({ length: MAX_SLOPE_BREAKS + 1 }, (_, i) => i / 100)
  assert.throws(() => read({ slopeBreaks: many }), RangeError)
  assert.equal(read({ slopeBreaks: many.slice(1) }).slopeBreaks.length, MAX_SLOPE_BREAKS)
})

test('slopeColors por defecto: interpolación entre verde y rojo para 0, 1 y 2 cortes', () => {
  const lo = parseColor(DEFAULT_SLOPE_LOW)
  const hi = parseColor(DEFAULT_SLOPE_HIGH)
  const near = (a, b) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 1e-12))
  let c = read().slopeColors
  assert.equal(c.length, 2)
  near(c[0], lo); near(c[1], hi)
  c = read({ slopeBreaks: [0.2] }).slopeColors
  assert.equal(c.length, 2)
  near(c[0], lo); near(c[1], hi)
  c = read({ slopeBreaks: [0.1, 0.3] }).slopeColors
  assert.equal(c.length, 3)
  near(c[0], lo); near(c[2], hi)
  near(c[1], lo.map((v, i) => (v + hi[i]) / 2))
})

test('slopeColors dados: n + 1, parseados, y con error por color o cantidad', () => {
  const c = read({ slopeBreaks: [0.1, 0.3], slopeColors: ['#f00', 'rgb(0 255 0)', '#00f'] }).slopeColors
  assert.deepEqual(c.map(x => [...x]), [[1, 0, 0, 1], [0, 1, 0, 1], [0, 0, 1, 1]])
  assert.throws(() => read({ slopeBreaks: [0.1, 0.3], slopeColors: ['#f00', '#0f0'] }), /3 colores para 2 cortes/)
  assert.throws(() => read({ slopeBreaks: [0.1], slopeColors: ['#f00', '#0f0', '#00f'] }), TypeError)
  assert.throws(() => read({ slopeBreaks: [0.1], slopeColors: ['#f00', 'rojo'] }), /color inválido/)
  assert.throws(() => read({ slopeColors: 'red' }), /array/)
  assert.throws(() => read({ slopeColors: [] }), TypeError)
  // Sin cortes la rampa continua admite las paradas que se quiera.
  assert.equal(read({ slopeColors: ['#f00', '#0f0', '#00f'] }).slopeColors.length, 3)
})

test('elevationRange: par finito con min < max, o null', () => {
  assert.deepEqual(read({ elevationRange: [-5, 600] }).elevationRange, [-5, 600])
  assert.equal(read({ elevationRange: null }).elevationRange, null)
  for (const r of [[1, 1], [2, 1], [1], [1, 2, 3], [NaN, 3], ['1', '2'], '1 2']) assert.throws(() => read({ elevationRange: r }), /elevationRange/)
})

test('update: mezcla con previous, no lo muta y devuelve el diff', () => {
  const prev = read({ colorBy: 'slope', slopeBreaks: [0.15] })
  const snapshot = JSON.stringify(prev)
  const { config, changed } = updateTerrainConfig(prev, { contours: 10 })
  assert.equal(config.contours, 10)
  assert.deepEqual(changed, { dem: false, style: true, clip: false })
  assert.equal(JSON.stringify(prev), snapshot)
  assert.equal(prev.contours, 0)

  assert.deepEqual(updateTerrainConfig(prev, {}).changed, { dem: false, style: false, clip: false })
  assert.deepEqual(updateTerrainConfig(prev, { clipTo: 'p' }).changed, { dem: false, style: false, clip: true })
  assert.deepEqual(updateTerrainConfig(prev, { dem: 'mapterhorn' }).changed, { dem: true, style: false, clip: false })
  assert.deepEqual(updateTerrainConfig(prev, { dem: { ...terrainPresets.aws } }).changed.dem, false)
  assert.deepEqual(updateTerrainConfig(prev, { opacity: 0.5 }).changed.style, true)
  assert.deepEqual(updateTerrainConfig(prev, { slopeBreaks: [0.15] }).changed.style, false)
})

test('update: lo no declarado se resuelve de nuevo', () => {
  const prev = read()
  assert.equal(prev.hillshade, true)
  const { config } = updateTerrainConfig(prev, { colorBy: 'slope' })
  assert.equal(config.hillshade, false)
  const { config: back } = updateTerrainConfig(config, { colorBy: 'none' })
  assert.equal(back.hillshade, true)
  const fixed = updateTerrainConfig(read({ hillshade: true }), { colorBy: 'slope' }).config
  assert.equal(fixed.hillshade, true)
  const colors = updateTerrainConfig(prev, { slopeBreaks: [0.1, 0.3] }).config.slopeColors
  assert.equal(colors.length, 3)
  assert.throws(() => updateTerrainConfig(read({ slopeBreaks: [0.1], slopeColors: ['#f00', '#0f0'] }), { slopeBreaks: [0.1, 0.2] }), TypeError)
})

test('update inválido lanza y deja previous intacto', () => {
  const prev = read({ colorBy: 'elevation', clipTo: 'a' })
  const snapshot = JSON.stringify(prev)
  for (const bad of [{ opacity: 2 }, { dem: 'nada' }, { colorBy: 'x' }, { slopeBreaks: [2, 1] }, { id: 'otro' }, { fetch: () => {} }, { pane: 'otro' }, { contours: -1 }])
    assert.throws(() => updateTerrainConfig(prev, bad), TypeError)
  assert.throws(() => updateTerrainConfig(prev, { dem: { ...SOURCE, zoom: 99 } }), RangeError)
  assert.throws(() => updateTerrainConfig(prev, null), TypeError)
  assert.equal(JSON.stringify(prev), snapshot)
  assert.ok(Object.isFrozen(prev))
})

test('los argumentos no se mutan', () => {
  const cfg = { ...base, slopeBreaks: [0.1], slopeColors: ['#f00', '#0f0'], elevationRange: [0, 1] }
  const copy = structuredClone(cfg)
  readTerrainConfig(cfg)
  assert.deepEqual(cfg, copy)
})
