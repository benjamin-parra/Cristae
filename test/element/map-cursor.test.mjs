// El atributo `cursor` de <cristae-map> llega al motor por el mismo camino que `zoom-animation`: como
// opción al montar y, en vivo, por `updated()`. Sin DOM real: el elemento se construye sobre el shim del
// harness, y el `L` real que le inyecta al motor fabrica el mapa doble —`L.map` se cambia mientras dura
// el montaje—, cuyo contenedor es el que el árbitro del cursor escribe. Corre con:
//   node --test test/element/map-cursor.test.mjs
import '../../test-helpers/element-stub.mjs'   // window/document y lo que Lit toca al evaluar: PRIMERO
import { makeMap } from '../../test-helpers/engine-stub.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import L from 'leaflet'
import { CristaeMap } from '../../src/element/CristaeMap.js'

// Monta el elemento como lo haría su primer render, sin conectarlo: el render root sólo tiene que
// devolver el contenedor que se le pasa al motor.
const montar = async props => {
  const map     = makeMap()
  const fabrica = L.map
  const el      = Object.assign(new CristaeMap(), props, {
    renderRoot    : { querySelector: () => ({}) },
    dispatchEvent : () => true,
  })
  L.map = () => map
  el.firstUpdated()
  await el.ready
  L.map = fabrica
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
  el.updated(new Map([['cursor', undefined]]))
  assert.equal(cursor(), 'copy')
  el.cursor = null
  el.updated(new Map([['cursor', 'copy']]))
  assert.equal(cursor(), '')
  el.disconnectedCallback()
})
