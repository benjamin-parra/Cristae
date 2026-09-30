// Los límites de la cámara de <cristae-map> llegan al motor como `zoom-animation` y `cursor`: como
// opciones al montar y, en vivo, por `updated()`, los cuatro juntos. Sin DOM real: el elemento se monta
// con `montarMapa` del harness, y lo que se mira es lo que recibe el mapa doble. Corre con:
//   node --test test/element/map-limits.test.mjs
// El harness va PRIMERO: window/document y lo que Lit toca al evaluar.
import { montarMapa } from '../../test-helpers/element-stub.mjs'
import { makeMap } from '../../test-helpers/engine-stub.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { CristaeMap } from '../../src/element/CristaeMap.js'

// El doble con los setters de límites de Leaflet, que los guarda en `options` como él.
const conLimites = map => Object.assign(map, {
  setMinZoom   : zoom => { map.options.minZoom = zoom },
  setMaxZoom   : zoom => { map.options.maxZoom = zoom },
  setMaxBounds : corners => { map.options.maxBounds = corners },
})

const limitesDe = ({ options: { minZoom, maxZoom, maxBounds, maxBoundsViscosity } }) =>
  ({ minZoom, maxZoom, maxBounds, maxBoundsViscosity })

test('el mapa nace con los límites del elemento, y un zoom que no es un número no limita', async () => {
  const { el, map } = await montarMapa({
    minZoom            : 3,
    maxZoom            : NaN,                // lo que Lit deja de un atributo que no es un número
    maxBounds          : { south: -10, west: -20, north: 10, east: 20 },
    maxBoundsViscosity : 1,
  })
  assert.deepEqual(limitesDe(map), { minZoom: 3, maxZoom: undefined, maxBounds: [[-10, -20], [10, 20]], maxBoundsViscosity: 1 })
  el.disconnectedCallback()
})

test('los límites son reactivos: cambiar uno los vuelve a fijar todos, y quitarlo deja de limitar', async () => {
  const observados = CristaeMap.observedAttributes
  assert.ok(['min-zoom', 'max-zoom', 'max-bounds', 'max-bounds-viscosity'].every(a => observados.includes(a)), 'Lit los observa')

  const { el, map } = await montarMapa({ minZoom: 3, maxBoundsViscosity: 1 }, conLimites(makeMap()))
  el.maxZoom = 12
  el.updated(new Map([['maxZoom', undefined]]))
  assert.deepEqual(limitesDe(map), { minZoom: 3, maxZoom: 12, maxBounds: null, maxBoundsViscosity: 1 })

  el.minZoom   = null
  el.maxBounds = [[-1, -1], [1, 1]]
  el.updated(new Map([['minZoom', 3], ['maxBounds', undefined]]))
  assert.deepEqual(limitesDe(map), { minZoom: undefined, maxZoom: 12, maxBounds: [[-1, -1], [1, 1]], maxBoundsViscosity: 1 })
  el.disconnectedCallback()
})

test('max-bounds es JSON, como viewport-insets: una caja o un par de esquinas', async () => {
  const { el, map } = await montarMapa({}, conLimites(makeMap()))
  el.attributeChangedCallback('max-bounds', null, '{"south":-10,"west":-20,"north":10,"east":20}')
  el.updated(new Map([['maxBounds', undefined]]))
  assert.deepEqual(map.options.maxBounds, [[-10, -20], [10, 20]])

  el.attributeChangedCallback('max-bounds', null, '[[-1,-1],[1,1]]')
  el.updated(new Map([['maxBounds', undefined]]))
  assert.deepEqual(map.options.maxBounds, [[-1, -1], [1, 1]])
  el.disconnectedCallback()
})
