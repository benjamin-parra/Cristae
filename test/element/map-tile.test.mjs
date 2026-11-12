// `tile` de <cristae-map> por nombre y reactivo, con `world-copies` reactivo: un solo punto de aplicación.
// Corre con: node --test test/element/map-tile.test.mjs
import { montarMapa } from '../../test-helpers/element-stub.mjs'
import { makeMap } from '../../test-helpers/engine-stub.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { MapEngine } from '../../src/engine/MapEngine.js'
import { CristaeMap } from '../../src/element/CristaeMap.js'
import { tilePresets } from '../../src/tiles/presets.js'

// Anota los proveedores que recibe el motor, y las atribuciones que dejan.
const espiar = () => {
  const dado = [], original = MapEngine.prototype.setTileProvider
  MapEngine.prototype.setTileProvider = function (tile) { dado.push(tile); return original.call(this, tile) }
  return { dado, soltar: () => { MapEngine.prototype.setTileProvider = original } }
}

const conAdd = map => Object.assign(map, { addLayer: () => map })
const convertir = CristaeMap.properties.tile.converter.fromAttribute

test('tile="osm" da el preset con noWrap, y el montaje no provee dos veces', async () => {
  const { dado, soltar } = espiar()
  try {
    const { el } = await montarMapa({ tile: 'osm' }, conAdd(makeMap()))
    el.willUpdate(new Map([['tile', undefined]]))
    assert.deepEqual(dado, [{ noWrap: true, ...tilePresets.osm }])
    assert.equal(el._attribution, tilePresets.osm.attribution)
    el.disconnectedCallback()
  } finally { soltar() }
})

test('cambiar a otro nombre re-provee una vez y actualiza la atribución; world-copies re-provee', async () => {
  const { dado, soltar } = espiar()
  try {
    const { el } = await montarMapa({ tile: 'osm' }, conAdd(makeMap()))
    el.tile = 'cartoDark'
    el.willUpdate(new Map([['tile', 'osm']]))
    el.willUpdate(new Map([['tile', 'osm']]))
    assert.equal(dado.length, 2)
    assert.equal(dado[1].url, tilePresets.cartoDark.url)
    assert.equal(el._attribution, tilePresets.cartoDark.attribution)
    el.worldCopies = true
    el.willUpdate(new Map([['worldCopies', false]]))
    assert.equal(dado.length, 3)
    assert.equal(dado[2].noWrap, false)
    el.disconnectedCallback()
  } finally { soltar() }
})

test('un nombre desconocido avisa una vez y deja el proveedor vigente', async () => {
  const { dado, soltar } = espiar()
  const avisos = [], warn = console.warn
  console.warn = m => avisos.push(m)
  try {
    const { el } = await montarMapa({ tile: 'osm' }, conAdd(makeMap()))
    el.tile = 'nope'
    el.willUpdate(new Map([['tile', 'osm']]))
    el.tile = 'nope'
    el.worldCopies = true
    el.willUpdate(new Map([['worldCopies', false]]))
    assert.equal(dado.length, 1)
    assert.equal(avisos.length, 1)
    assert.match(avisos[0], /nope.*osm, cartoLight, cartoDark, esriImagery/)
    assert.equal(el._attribution, tilePresets.osm.attribution)
    el.disconnectedCallback()
  } finally { soltar(); console.warn = warn }
})

test('un objeto sigue igual, y el conversor separa JSON de nombre', async () => {
  const { dado, soltar } = espiar()
  try {
    const tile = { url: 'https://proveedor.test/{z}/{x}/{y}.png', attribution: 'P' }
    const { el } = await montarMapa({ tile }, conAdd(makeMap()))
    assert.deepEqual(dado, [{ noWrap: true, ...tile }])
    el.disconnectedCallback()
  } finally { soltar() }
  assert.equal(convertir('osm'), 'osm')
  assert.deepEqual(convertir('{"url":"x"}'), { url: 'x' })
  assert.deepEqual(convertir(' {"url":"x"} '), { url: 'x' })
  assert.equal(convertir('{roto'), '{roto', 'un JSON inválido pasa como texto: avisa #applyTile, por elemento')
})

test('un JSON inválido avisa una vez por elemento y deja el proveedor vigente', async () => {
  const { dado, soltar } = espiar()
  const avisos = [], warn = console.warn
  console.warn = m => avisos.push(m)
  try {
    const a = await montarMapa({ tile: 'osm' }, conAdd(makeMap()))
    const b = await montarMapa({ tile: 'osm' }, conAdd(makeMap()))
    for (const { el } of [a, b]) {
      el.tile = convertir('{roto')
      el.willUpdate(new Map([['tile', 'osm']]))
      el.tile = convertir('{roto')
      el.worldCopies = true
      el.willUpdate(new Map([['worldCopies', false]]))
    }
    assert.equal(avisos.filter(m => /JSON inválido/.test(m)).length, 2, 'uno por elemento')
    assert.equal(dado.length, 2, 'sólo los dos montajes proveyeron')
    a.el.disconnectedCallback()
    b.el.disconnectedCallback()
  } finally { console.warn = warn; soltar() }
})
