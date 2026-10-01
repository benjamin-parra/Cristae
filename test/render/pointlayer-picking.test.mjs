// La costura del picking jerárquico: la capa escribe el índice LOCAL en los canales b,a del vértice, el
// pase le suma el TAG del draw (objeto + chunk) y el decodificador tiene que devolver el id de DATO del
// punto que estaba bajo el cursor. Cada mitad testeada por separado no nota que la otra movió el reparto,
// así que acá se ejerce el camino entero: packer real → píxel compuesto como lo compone el fragment →
// `pickSync` real (el gl stub devuelve ese píxel) → partes de hit.

import '../../test-helpers/engine-stub.mjs'
import { conGlDeEdicion, makeEditGl, makeIconSet, makeLeaflet, makeMap } from '../../test-helpers/engine-stub.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { PointLayer } from '../../src/render/PointLayer.js'
import { packTag, LOCAL_BITS } from '../../src/render/Picking.js'
import { adoptLeafletHost } from '../../src/host/LeafletHost.js'

const PATCH  = 6
const HALF   = PATCH >> 1
const CENTRO = HALF * PATCH + HALF         // el cursor cae SIEMPRE en el texel central del parche
const FLOATS = 7

const accessors = { idOf: it => it.id, positionOf: it => it.pos }

// El GL del harness: el pase lee de vuelta el parche CRUDO que el test pinta (`spy.frame`), y los canales
// de cada slot salen del espejo de lo que la capa subió al VBO.
const mount = items => {
  const gl        = makeEditGl()
  const spy       = gl.spy
  const restaurar = conGlDeEdicion(() => gl)
  const source    = {
    accessors,
    getSnapshot: () => items,
    subscribe:   () => () => {},
    itemById:    id => items.find(it => it.id === id),
  }
  const layer = new PointLayer({
    host: adoptLeafletHost(makeMap(), { leaflet: makeLeaflet() }), pane: 'p', source, iconSet: makeIconSet(), interactive: true,
  })
  restaurar()
  // Pinta un texel del parche tal como lo escribe el fragment: R = local alto + nibble bajo del chunk,
  // G = local bajo, B y A = el resto del tag. La suma es exacta (ambos sumandos son múltiplos de 1/255
  // y el packer garantiza que no desbordan el byte).
  const frame  = spy.frame
  const pintar = (texel, canal, obj, chunk = 0) => {
    const tag = packTag(obj, chunk)
    const i   = texel * 4
    frame[i]     = Math.round((canal.b + tag[0]) * 255)
    frame[i + 1] = Math.round(canal.a * 255)
    frame[i + 2] = Math.round(tag[1] * 255)
    frame[i + 3] = Math.round(tag[2] * 255)
  }
  const canalDe = slot => ({ b: spy.array.datos[slot * FLOATS + 4], a: spy.array.datos[slot * FLOATS + 5] })
  return { layer, frame, pintar, log: spy, canalDe }
}

const items = ['A', 'B', 'C', 'D'].map((id, i) => ({ id, pos: { lat: i, lng: i } }))
const click = layer => layer.resolveClick({ x: 10, y: 10 }).map(p => p.id)

test('el índice local de la capa + el tag del draw vuelven al id de DATO del punto', () => {
  const { layer, pintar, canalDe } = mount(items)
  layer.pickObject = 7

  pintar(CENTRO, canalDe(2), 7)
  assert.deepEqual(click(layer), ['C'], 'el slot 2 resuelve a su id de dato')
})

test('el slot 0 no se confunde con «nada» (la convención local + 1)', () => {
  const { layer, pintar, canalDe } = mount(items)
  layer.pickObject = 7

  pintar(CENTRO, canalDe(0), 7)
  assert.deepEqual(click(layer), ['A'])
})

test('el tag sobrevive a un objeto < 64, que deja el alpha en 0', () => {
  const { layer, frame, pintar, canalDe } = mount(items)
  layer.pickObject = 7                      // 7 >> 6 === 0 ⇒ alpha 0 en un hit REAL

  pintar(CENTRO, canalDe(3), 7)
  assert.equal(frame[CENTRO * 4 + 3], 0, 'el hit real tiene alpha 0: el viejo guard lo daría por vacío')
  assert.deepEqual(click(layer), ['D'], 'pero el word completo no es 0 y el hit se entrega')
})

test('el parche limpio (word 0) es lo único que significa «nada»', () => {
  const { layer } = mount(items)
  layer.pickObject = 7

  assert.deepEqual(click(layer), [], 'sin impacto no hay partes')
})

test('«toqué el objeto pero no una entrada» (local 0) no produce parte', () => {
  const { layer, pintar } = mount(items)
  layer.pickObject = 7

  pintar(CENTRO, { b: 0, a: 0 }, 7)         // el objeto está, el índice local es 0
  assert.deepEqual(click(layer), [], 'el cuerpo del objeto no es una entrada de la capa de puntos')
})

test('el orden de las partes es por cercanía al cursor, y el sprite repetido va una sola vez', () => {
  const { layer, pintar, canalDe } = mount(items)
  layer.pickObject = 7

  pintar(0, canalDe(3), 7)                  // esquina del parche
  pintar(CENTRO - 1, canalDe(1), 7)         // pegado al cursor
  pintar(CENTRO, canalDe(1), 7)             // el mismo punto, otra vez: un sprite cubre varios texeles
  assert.deepEqual(click(layer), ['B', 'D'], 'primero el más cercano, y sin repetir el mismo id')
})

// ── El techo del índice local ───────────────────────────────────────────────────────────────────
// El índice local sólo tiene 12 bits, así que un draw único cortaría el pase en 4.095 puntos: los
// demás no se dibujarían al parche y quedarían MUDOS al picking, sin error ni aviso. Es la capa de
// flota, donde pasar de 4.095 es normal. Por eso el buffer se recorre en un draw por chunk.

const LOCAL_CAP = (1 << LOCAL_BITS) - 1

const muchos = n => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, pos: { lat: 0, lng: 0 } }))

test('el pase reparte el buffer en un draw por chunk y los cubre TODOS', () => {
  const total = LOCAL_CAP * 2 + 5
  const { layer, log } = mount(muchos(total))
  layer.pickObject = 7

  layer.resolveClick({ x: 10, y: 10 })

  assert.deepEqual(log.draws.map(({ first, count }) => ({ first, count })), [
    { first: 0,             count: LOCAL_CAP },
    { first: LOCAL_CAP,     count: LOCAL_CAP },
    { first: LOCAL_CAP * 2, count: 5 },
  ], 'dos chunks llenos y uno parcial, contiguos y sin huecos')
  assert.equal(
    log.draws.reduce((s, d) => s + d.count, 0), total,
    'la suma de los draws cubre el set entero: ningún punto queda fuera del pase',
  )
})

// Este NO guarda el techo —el stub devuelve el parche que el test pintó, se haya dibujado o no—: lo
// guarda el de arriba, espiando los draws. Éste prueba la otra mitad, el decode: que `chunk` y `local`
// se recompongan en el slot global (`chunk · LOCAL_CAP + local`) y lleguen al id de DATO correcto.
test('el decode recompone el slot global de una entrada del chunk 1', () => {
  const { layer, pintar, canalDe } = mount(muchos(LOCAL_CAP + 10))
  layer.pickObject = 7

  const slot  = LOCAL_CAP + 3
  const chunk = Math.floor(slot / LOCAL_CAP)
  pintar(CENTRO, canalDe(slot), 7, chunk)

  assert.deepEqual(
    layer.resolveClick({ x: 10, y: 10 }).map(p => p.id), [`p${slot}`],
    'el eje chunk completa la dirección que los 12 bits del local no alcanzan',
  )
})
