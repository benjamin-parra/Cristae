// `backend` de <cristae-line-layer>: el sustrato del trazo se declara por atributo y llega al alta del
// motor; sin declararlo, el alta lo recibe ausente y el motor aplica su default.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CristaeLineLayer } from '../../src/element/CristaeLineLayer.js'

// Sin DOM: `mountLayer` sólo lee `this.*` y llama al alta (de ahí sale el getter `_placement` de la base).
const capa = props => Object.assign(Object.create(CristaeLineLayer.prototype), { visible: true, interactive: false, ...props })
const eco  = { addLineLayer: cfg => cfg }

test('`backend` llega al alta del motor', () => {
  assert.equal(capa({ id: 'ruta', backend: 'gpu' }).mountLayer(eco).backend, 'gpu')
})

test('sin declararlo, el alta lo recibe ausente', () => {
  assert.equal(capa({ id: 'ruta' }).mountLayer(eco).backend, undefined)
})
