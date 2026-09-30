// El atributo `cursor` de <cristae-map> llega al motor por el mismo camino que `zoom-animation`: como
// opción al montar y, en vivo, por `willUpdate()`. Sin DOM real: el elemento se monta con `montarMapa` del
// harness, sobre el mapa doble, cuyo contenedor es el que el árbitro del cursor escribe. Corre con:
//   node --test test/element/map-cursor.test.mjs
// El harness va PRIMERO: window/document y lo que Lit toca al evaluar.
import { montarMapa } from '../../test-helpers/element-stub.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { CristaeMap } from '../../src/element/CristaeMap.js'

const montar = async props => {
  const { el, map } = await montarMapa(props)
  return { el, cursor: () => map.getContainer().style.cursor }
}

test('el motor nace con el cursor del elemento, y desconectarlo lo devuelve', async () => {
  const { el, cursor } = await montar({ cursor: 'crosshair' })
  assert.equal(cursor(), 'crosshair')
  el.disconnectedCallback()
  assert.equal(cursor(), '', 'el contenedor queda como estaba para el motor del próximo montaje')
})

test('el atributo `cursor` es reactivo: cambiarlo y quitarlo llega al motor sin remontar', async () => {
  assert.ok(CristaeMap.observedAttributes.includes('cursor'), 'Lit lo observa y lo pasa a la propiedad')
  const { el, cursor } = await montar({})
  assert.equal(cursor(), undefined, 'sin cursor el motor no toca el contenedor')
  el.cursor = 'copy'
  el.willUpdate(new Map([['cursor', undefined]]))
  assert.equal(cursor(), 'copy')
  el.cursor = null
  el.willUpdate(new Map([['cursor', 'copy']]))
  assert.equal(cursor(), '')
  el.disconnectedCallback()
})
