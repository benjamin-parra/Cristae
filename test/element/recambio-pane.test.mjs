// El recambio de `source` sobre un DOM de verdad: la capa nueva ocupa el lugar de la vieja en su pane. Dos capas que
// comparten pane (`pane: 'comun'`) se apilan por el orden de sus canvases —el z-index es el mismo—, y si la reemplazada
// pasara al final del pane quedaría por encima de la que estaba arriba, sin que ningún z cambie.
//
// Corre con: node --test test/element/recambio-pane.test.mjs
//
// El harness va PRIMERO: window, customElements y lo que Lit toca al evaluar.
import { window } from '../../test-helpers/jsdom-elementos.mjs'
import { instalarNavegador } from '../../test-helpers/navegador-falso.mjs'
import { makeIconSet } from '../../test-helpers/engine-stub.mjs'
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import '../../src/index.js'
import { createSource } from '../../src/data/index.js'

const ACC     = { idOf: v => v.id, positionOf: v => ({ lat: v.lat, lng: v.lng }) }
const iconSet = makeIconSet()
const esperar = ms => new Promise(r => setTimeout(r, ms))
const fuente  = () => {
  const source = createSource(ACC)
  source.set([{ id: 1, lat: 0, lng: 0 }])
  return source
}

const navegador = instalarNavegador(window)
after(() => {
  navegador.desinstalar()
  document.body.replaceChildren()
})

// Un mapa montado con tres capas de puntos en el pane `comun` y una en el suyo.
const armar = async () => {
  document.body.replaceChildren()
  const map = document.createElement('cristae-map')
  map.style.cssText = 'display:block;width:800px;height:600px'
  document.body.appendChild(map)
  await esperar(40)
  const { engine } = map
  ;['a', 'b', 'c'].forEach(id => engine.addPointLayer({ id, source: fuente(), iconSet, pane: 'comun' }))
  engine.addPointLayer({ id: 'sola', source: fuente(), iconSet })
  await esperar(20)
  return { map, engine }
}

const canvasDe = (engine, id) => engine.getLayer(id).layer.surface.canvas

// Las capas del pane compartido, de la primera a la última por el lugar de su canvas.
const ordenDe = engine => {
  const hijos = [...canvasDe(engine, 'a').parentNode.children]
  return ['a', 'b', 'c'].sort((p, q) => hijos.indexOf(canvasDe(engine, p)) - hijos.indexOf(canvasDe(engine, q)))
}

for (const [cual, antes] of [['la de abajo', 'a'], ['la del medio', 'b'], ['la de arriba', 'c']]) {
  test(`el recambio de source de ${cual} deja su canvas en su lugar del pane compartido`, async () => {
    const { map, engine } = await armar()
    assert.deepEqual(ordenDe(engine), ['a', 'b', 'c'])
    const pane  = canvasDe(engine, antes).parentNode
    const viejo = canvasDe(engine, antes)
    assert.equal(canvasDe(engine, 'a').parentNode, canvasDe(engine, 'c').parentNode, 'comparten el pane')

    engine.attachSource(antes, fuente())
    const nuevo = canvasDe(engine, antes)

    assert.notEqual(nuevo, viejo, 'es la capa nueva, con su superficie')
    assert.equal(viejo.isConnected, false, 'el canvas viejo se fue del DOM')
    assert.equal(nuevo.parentNode, pane, 'sigue en el mismo pane')
    assert.deepEqual(ordenDe(engine), ['a', 'b', 'c'], 'y las demás no cambian de lugar respecto de ella')
    map.remove()
  })
}

test('el recambio dos veces seguidas tampoco la corre', async () => {
  const { map, engine } = await armar()
  engine.attachSource('a', fuente())
  engine.attachSource('a', fuente())
  engine.attachSource('b', fuente())
  assert.deepEqual(ordenDe(engine), ['a', 'b', 'c'])
  map.remove()
})

test('lo que el pane tiene además de canvases también queda en su lugar: el nuevo ocupa el hueco del viejo', async () => {
  const { map, engine } = await armar()
  const pane = canvasDe(engine, 'a').parentNode
  const marca = document.createElement('div')
  pane.insertBefore(marca, canvasDe(engine, 'b'))                 // [a, marca, b, c]
  const lugar = () => [...pane.children].map(el => (el === marca ? 'marca' : ['a', 'b', 'c'].find(id => canvasDe(engine, id) === el)))
  assert.deepEqual(lugar(), ['a', 'marca', 'b', 'c'])

  engine.attachSource('b', fuente())
  assert.deepEqual(lugar(), ['a', 'marca', 'b', 'c'])
  engine.attachSource('a', fuente())
  assert.deepEqual(lugar(), ['a', 'marca', 'b', 'c'])
  map.remove()
})

test('un overlay ligado conserva su pane tras el recambio de su host', async () => {
  const { map, engine } = await armar()
  const badge = engine.addOverlay({ id: 'badge', hostId: 'sola', iconSet })
  await esperar(20)
  const pane  = canvasDe(engine, 'badge').parentNode
  const viejo = canvasDe(engine, 'badge')

  engine.attachSource('sola', fuente())
  assert.notEqual(canvasDe(engine, 'badge'), viejo)
  assert.equal(canvasDe(engine, 'badge').parentNode, pane, 'el overlay sigue en su pane')
  assert.equal(badge.layer, engine.getLayer('badge').layer)
  map.remove()
})
