// `model` de <cristae-map>: el modelo de la Tierra del motor, una propiedad (un modelo es un objeto, no un
// atributo) que se lee al montar. Sin DOM real: el elemento se monta con `montarMapa` del harness. Corre con:
//   node --test test/element/map-model.test.mjs
// El harness va PRIMERO: window/document y lo que Lit toca al evaluar.
import { montarMapa } from '../../test-helpers/element-stub.mjs'
import { conGlDeEdicion, contando, makeEditGl } from '../../test-helpers/engine-stub.mjs'
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { CristaeMap } from '../../src/element/CristaeMap.js'
import { AREA, MODEL, RELIEF } from '../../src/geometry/geodesic.js'
import { WGS84 } from '../../src/geometry/ellipsoid.js'

after(conGlDeEdicion(() => makeEditGl()))

// Dibuja un círculo en la capa de formas del motor del elemento: lo que `bounds` lee fuerza el teselado.
const dibujar = engine => {
  engine.addShapeLayer({
    id: 'zona', accessors: { idOf: f => f.id, positionOf: f => f.center, radiusOf: f => f.radius },
    data: [{ id: 1, center: [0, 0], radius: 1e5 }],
  })
  return engine.getLayer('zona').layer.bounds
}

test('model es una propiedad y no un atributo', () => {
  assert.ok(!CristaeMap.observedAttributes.includes('model'))
  assert.equal(CristaeMap.elementProperties.get('model').attribute, false)
})

test('el motor nace con el modelo del elemento', async () => {
  const modelo = contando(WGS84)
  const { el } = await montarMapa({ model: modelo })
  dibujar(el.engine)
  assert.ok(modelo.destinos > 0)
  el.disconnectedCallback()
})

test('cambiarlo después de montar no cambia el motor', async () => {
  const montado = contando(WGS84)
  const { el }  = await montarMapa({ model: montado })
  const otro    = contando(WGS84)
  el.model = otro
  el.willUpdate(new Map([['model', montado]]))
  dibujar(el.engine)
  assert.ok(montado.destinos > 0 && otro.destinos === 0)
  el.disconnectedCallback()
})

test('sin model el motor dibuja con la esfera por defecto', async () => {
  const { el } = await montarMapa()
  const caja   = dibujar(el.engine)
  assert.ok(Math.abs(caja.north - 1e5 / 6371008.8 * 180 / Math.PI) < 1e-9, `norte ${caja.north}`)
  el.disconnectedCallback()
})

test('un model que no sirve lanza TypeError al montar', async () => {
  const terreno = { [MODEL]: WGS84[MODEL], [AREA]: WGS84[AREA], [RELIEF]: () => 0 }
  await assert.rejects(montarMapa({ model: terreno }), error => error instanceof TypeError && /terreno/.test(error.message))
})
