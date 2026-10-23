// El elemento reenvía `surfacechange` del motor como `cristae:surfacechange`, con la fila de
// `engine.surfaces()` en el detail. Sin DOM: el mapa se monta con `montarMapa`, que recoge lo que el
// elemento despacha, y la pérdida del contexto la dispara el doble. Corre con:
//   node --test test/element/map-superficies.test.mjs
// El harness va PRIMERO: window/document y lo que Lit toca al evaluar.
import { montarMapa } from '../../test-helpers/element-stub.mjs'
import { decorarElementos } from '../../test-helpers/engine-stub.mjs'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'

// Cada <canvas> guarda los oyentes que se le registran, por donde el navegador avisa `webglcontextlost`.
const sinOyentes = decorarElementos((el, tag) => {
  tag === 'canvas' && Object.assign(el, {
    oyentes          : {},
    addEventListener : (tipo, fn) => (el.oyentes[tipo] ??= []).push(fn),
  })
  return el
})
after(sinOyentes)

const lineas = { idOf: r => r.id, pathOf: r => r.path }

// Un mapa con una capa de líneas, y los eventos `cristae:surfacechange` que despacha, en orden.
const montar = async () => {
  const eventos = []
  const { el }  = await montarMapa({
    noZoomControl : true,
    dispatchEvent : e => (e.type === 'cristae:surfacechange' && eventos.push(e), true),
  })
  el.engine.addLineLayer({ id: 'rutas', accessors: lineas, z: 380 })
  const canvas = el.engine.getLayer('rutas').layer.surface.canvas
  return { el, eventos, perder: () => canvas.oyentes.webglcontextlost.forEach(fn => fn()) }
}

test('al perderse el contexto de una capa sale cristae:surfacechange con su fila', async () => {
  const { el, eventos, perder } = await montar()
  assert.deepEqual(eventos, [], 'mientras el contexto vive no hay aviso')

  perder()
  assert.equal(eventos.length, 1)
  const [evento] = eventos
  assert.deepEqual(evento.detail, el.engine.surfaces()[0], 'el detail es la fila de surfaces()')
  assert.deepEqual(evento.detail, {
    layerId: 'rutas', kind: 'line', pane: 'cristae-line-rutas', z: 380, cssZoom: true, state: 'lost', hasContent: false, visible: true,
  })
  assert.equal(evento.bubbles, true, 'como los demás cristae:*, sube y cruza el shadow root')
  assert.equal(evento.composed, true)
  el.disconnectedCallback()
})

test('desconectar el mapa no avisa pérdidas: sus superficies se devuelven, no se pierden', async () => {
  const { el, eventos, perder } = await montar()
  el.disconnectedCallback()
  perder()                                              // el evento que el `loseContext` del destroy deja en camino
  assert.deepEqual(eventos, [])
})
