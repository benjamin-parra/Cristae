// Contrato de LabelLayer sobre el anfitrión: la capa no es una capa de Leaflet, cuelga su canvas sin
// puntero de un pane de la superficie, lo ancla al origen del contenedor en el marco que sigue al paneo,
// sigue el ciclo de vista de la cámara —oculta durante el zoom animado, repinta al asentar— y al
// destruirse suelta el pane y la vista.
//
// El harness (engine-stub) shimea window/document — se importa PRIMERO.
import { decorarElementos, estiloTrasladado, makeMap, oyentesDeVista } from '../../test-helpers/engine-stub.mjs'
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { LabelLayer } from '../../src/render/LabelLayer.js'
import { adoptLeafletHost } from '../../src/host/LeafletHost.js'
import { globeView } from '../../src/camera/views.js'
import { viewFacet } from '../../src/camera/facet.js'

// El canvas de la capa: se lo instrumenta al salir de la fábrica para leer dónde lo cuelga.
const espia = { canvases: [] }

after(decorarElementos((el, tag) => {
  if (tag !== 'canvas') return el
  const traslados = []
  el.style = estiloTrasladado(t => traslados.push(t))
  espia.canvases.push({ el, traslados })
  return el
}))

// El marco del paneo NO está en el origen del contenedor: así el aserto del ancla no es vacuo.
const MARCO = { x: -120, y: 35 }

const montar = () => {
  const map      = { ...makeMap(), containerPointToLayerPoint: () => MARCO }
  const host     = adoptLeafletHost(map)
  const oyentes  = oyentesDeVista(host)
  const pintados = []
  const layer    = new LabelLayer({
    host,
    pane  : 'rotulos',
    paint : (ctx, point, label) => pintados.push(label.id),
  })
  return { map, oyentes, pintados, layer, canvas: espia.canvases.at(-1) }
}

test('cuelga su canvas sin puntero de un pane de la superficie, anclado al origen del contenedor en el marco', () => {
  const { map, canvas } = montar()
  assert.equal(canvas.el.style.pointerEvents, 'none', 'el canvas cubre el mapa y no se queda con el puntero')
  assert.deepEqual(map.getPane('rotulos').style, {}, 'el pane lo configura quien lo monta, no la capa')
  assert.deepEqual(canvas.traslados.at(-1), { ...MARCO, escala: 1 })
})

test('sigue el ciclo de vista: se oculta en el zoom animado y repinta al asentar', () => {
  const { map, pintados, layer, canvas } = montar()
  layer.setLabels([{ id: 1, lat: 1, lng: 1, text: 'uno' }])
  pintados.length = 0

  map.fire('zoomstart')
  assert.equal(canvas.el.style.visibility, 'hidden', 'durante el zoom las etiquetas se deslizarían')
  map.fire('zoomend')
  assert.equal(canvas.el.style.visibility, '')
  assert.deepEqual(pintados, [1], 'y al asentar repinta con la vista nueva')

  map.fire('moveend')
  map.fire('resize')
  assert.deepEqual(pintados, [1, 1, 1])
})

test('destroy suelta el pane y la vista, y un segundo destroy no hace nada', () => {
  const { map, oyentes, layer } = montar()
  assert.equal(oyentes('zoomstart', 'moveend', 'zoomend', 'resize'), 5, 'ocultar, repintar en las tres y mostrar')

  layer.destroy()
  assert.equal(oyentes('zoomstart', 'moveend', 'zoomend', 'resize'), 0)
  assert.equal(map.getPane('rotulos'), null, 'la capa era la única que lo sostenía')
  assert.doesNotThrow(() => layer.destroy())
})

// Quitar capas según la vista —el LOD habitual— se hace desde oyentes que llegaron antes que la capa. La
// que se va ya no se llama en el reparto en curso: su canvas ya no existe.
test('destruida desde un oyente de la vista, el reparto en curso ya no la llama', () => {
  const map  = { ...makeMap(), containerPointToLayerPoint: () => MARCO }
  const host = adoptLeafletHost(map)
  let layer  = null
  host.camera.on('zoomstart zoomend', () => layer.destroy())

  for (const tipo of ['zoomstart', 'zoomend']) {
    layer = new LabelLayer({ host, pane: 'rotulos' })
    assert.doesNotThrow(() => map.fire(tipo), tipo)
  }
})

// Sobre un globo, un rótulo tras el horizonte no se pinta; uno hovered tapado tampoco, y el que se pinta
// recibe el píxel de su propio rótulo aunque el portador se reuse.
const globo = lng => viewFacet(globeView({ center: { lat: 0, lng }, zoom: 1, size: { x: 800, y: 600 } }))

const montarGlobo = () => {
  const anfitrion = adoptLeafletHost(makeMap())
  const puntos    = []
  const layer     = new LabelLayer({
    host  : { camera: globo(0), surface: anfitrion.surface },
    pane  : 'rotulos',
    paint : (ctx, point, label, hovered) => puntos.push({ id: label.id, x: point.x, y: point.y, hovered }),
  })
  return { layer, puntos }
}

test('un rótulo tapado por el horizonte no se pinta', () => {
  const { layer, puntos } = montarGlobo()
  layer.setLabels([
    { id: 'frente', lat: 0, lng: 0, text: 'frente' },
    { id: 'atras', lat: 0, lng: 175, text: 'atras' },
  ])
  assert.deepEqual(puntos.map(p => p.id), ['frente'])
  assert.deepEqual([puntos[0].x, puntos[0].y], [400, 300])
})

test('con el portador reusado, cada rótulo se pinta en su píxel y el hovered va al final', () => {
  const { layer, puntos } = montarGlobo()
  const labels = [
    { id: 'a', lat: 0, lng: 0, text: 'a' },
    { id: 'b', lat: 10, lng: 10, text: 'b' },
    { id: 'c', lat: -10, lng: -10, text: 'c' },
  ]
  layer.setLabels(labels)
  const solo = Object.fromEntries(puntos.map(p => [p.id, p]))
  puntos.length = 0

  layer.setHovered(new Set(['a']))
  assert.equal(puntos.length, 3)
  assert.equal(puntos.at(-1).id, 'a')
  assert.equal(puntos.at(-1).hovered, true)
  puntos.forEach(p => assert.deepEqual([p.x, p.y], [solo[p.id].x, solo[p.id].y], p.id))
  assert.equal(new Set(Object.values(solo).map(p => `${p.x},${p.y}`)).size, 3, 'tres píxeles distintos')
})
