// El atlas de cluster sobre una capa de puntos REAL (etapa 4, D2): con el IconSet por defecto —199 buckets
// declarados, una textura de 2304×2176 px— la capa sube sólo las celdas que sus puntos piden, un tile por
// subida, y una variante que aparece con los datos sube en el cuadro que la dibuja. El GL es el doble
// del harness (anota origen y tamaño de cada subida); el IconSet, el binding y la capa son los reales.
import '../../test-helpers/engine-stub.mjs'
import { NOOP_CTX, decorarElementos, makeEditGl, makeLeaflet, makeMap, makePickSpy, makeSurface } from '../../test-helpers/engine-stub.mjs'
import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { PointLayer } from '../../src/render/PointLayer.js'
import { adoptLeafletHost } from '../../src/host/LeafletHost.js'
import { defineClusterIconSet } from '../../src/atlas/IconSet.js'

const TILE  = 128                                          // el tile por defecto del IconSet
const flush = () => new Promise(r => setTimeout(r, 5))     // un cuadro del harness (rAF = setTimeout)

let ranuras = []                                           // ranuras ociosas que el test corre a mano
globalThis.requestIdleCallback = cb => ranuras.push(cb)
afterEach(() => { ranuras = [] })

const makeSource = (items, accessors) => {
  const subs = new Set()
  const sucios = new Set()
  return {
    accessors,
    getSnapshot : () => items,
    subscribe   : cb => (subs.add(cb), () => subs.delete(cb)),
    itemById    : id => items.find(it => accessors.idOf(it) === id),
    moveDirtyIds: () => new Set(),
    dirtyIds    : () => sucios,
    agregar(item) { items.push(item); sucios.add(item.id); subs.forEach(cb => cb()); sucios.clear() },
  }
}

const montar = conteos => {
  const iconSet = defineClusterIconSet({ draw: () => {} })
  const items   = conteos.map((count, i) => ({ id: i + 1, pos: { lat: i, lng: i }, count }))
  const accessors = { idOf: it => it.id, positionOf: it => it.pos, variantOf: it => iconSet.variantForCount(it.count) }
  const spy  = makePickSpy()
  const gl   = makeEditGl(spy, makeSurface())
  const restaurar = decorarElementos((el, tag) => {
    if (tag === 'canvas') el.getContext = kind => (kind === 'webgl2' ? gl : NOOP_CTX)
    return el
  })
  try {
    const host   = adoptLeafletHost(makeMap({ zoom: 5 }), { leaflet: makeLeaflet() })
    const source = makeSource(items, accessors)
    const layer  = new PointLayer({ host, pane: 'p', source, iconSet })
    return { layer, source, iconSet, spy, subido: () => spy.texSubImages.reduce((n, r) => n + r.width * r.height, 0) }
  } finally {
    restaurar()
  }
}

test('T4.1 una capa con tres burbujas distintas sube tres tiles del atlas de 199', async () => {
  const h = montar([5, 5, 12, 40, 40])
  await flush()
  assert.equal(h.iconSet.atlas.capacity, 299, 'la grilla es la de los 199 buckets: 18 × 17 celdas de 128 px')
  assert.deepEqual([h.iconSet.atlas.cols, h.iconSet.atlas.rows], [18, 17])
  assert.equal(h.spy.texImages.length, 1, 'una reserva')
  assert.deepEqual(h.spy.texImages[0], { width: 18 * TILE, height: 17 * TILE }, 'del tamaño de la grilla (la geometría no cambia)')
  assert.deepEqual(h.spy.texSubImages.map(({ x, y, width, height }) => [x, y, width, height]), [0, 1, 2].map(i => [i * TILE, 0, TILE, TILE]), 'una subida por celda pedida: las tres primeras')
  assert.equal(h.subido(), 3 * TILE * TILE, 'ni un tile de los 196 que nadie usa')
  h.layer.destroy()
})

test('T4.3 un conteo nuevo que llega con los datos sube su tile en el cuadro que lo dibuja', async () => {
  const h = montar([5, 12])
  await flush()
  const antes = h.spy.texSubImages.length

  h.source.agregar({ id: 99, pos: { lat: 9, lng: 9 }, count: 300 })   // un bucket que ninguna burbuja usaba
  await flush()
  const nuevas = h.spy.texSubImages.slice(antes)
  assert.equal(nuevas.length, 1, 'una subida, la de esa variante')
  const i = h.iconSet.atlas.indexOf(h.iconSet.variantForCount(300))
  const { cols } = h.iconSet.atlas
  assert.deepEqual(nuevas[0], { x: (i % cols) * TILE, y: Math.floor(i / cols) * TILE, width: TILE, height: TILE, srcOffset: undefined }, 'en su celda')
  assert.equal(h.spy.texImages.length, 1, 'sin reservar la textura de nuevo')
  h.layer.destroy()
})

test('el adelanto ocioso dibuja el resto de los buckets en la CPU y no sube ni uno', async () => {
  const h = montar([5, 12])
  await flush()
  const subidas = h.spy.texSubImages.length
  while (ranuras.length) ranuras.shift()({ timeRemaining: () => 50 })          // el ocio adelanta los 197 restantes
  h.layer.refresh()
  await flush()
  assert.equal(h.iconSet.atlas.count, 2, 'sólo las dos usadas tienen celda')
  assert.equal(h.spy.texSubImages.length, subidas, 'lo adelantado queda en la CPU hasta que alguien lo pide')
  h.layer.destroy()
})
