// `engine.surfaces()` entre el desalojo de un contexto y el evento que lo anuncia. El navegador pierde el contexto
// en el acto —`isContextLost()` ya es verdadero— y despacha `webglcontextlost` en otra tarea. La fila de la capa dice
// `lost` desde el primer momento, no cuando llega el evento: es un diagnóstico y no puede mentir en esa ventana.
// Corre con: node --test test/engine/superficies-perdida.test.mjs
import '../../test-helpers/engine-stub.mjs'
import { makeIconSet, makeLeaflet, makeMap } from '../../test-helpers/engine-stub.mjs'
import { conNavegador, crearNavegador } from '../../test-helpers/navegador-falso.mjs'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { MapEngine } from '../../src/engine/MapEngine.js'
import { adoptLeafletHost } from '../../src/host/LeafletHost.js'

const navegador = crearNavegador()
after(conNavegador(navegador))

const flush = () => new Promise(r => setTimeout(r, 5))

const puntos = { idOf: it => it.id, positionOf: it => ({ lat: it.lat, lng: it.lng }) }
const lineas = { idOf: r => r.id, pathOf: r => r.path }
const zonas  = { idOf: z => z.id, ringsOf: () => [[[0, 0], [0, 1], [1, 1]]] }

// Un motor con una capa de cada clase que dibuja con WebGL, más un editor.
const montar = async () => {
  const engine = new MapEngine({ host: adoptLeafletHost(makeMap(), { leaflet: makeLeaflet() }) })
  engine.addPointLayer({ id: 'flota', accessors: puntos, iconSet: makeIconSet(), data: [{ id: 1, lat: 0, lng: 0 }] })
  engine.addLineLayer({ id: 'rutas', accessors: lineas, data: [{ id: 'r', path: [[0, 0], [0, 1]] }] })
  engine.addPolygonLayer({ id: 'zonas', accessors: zonas, data: [{ id: 'z' }] })
  engine.addEditableLayer({ id: 'geo', kind: 'polygon', mode: 'edit' })
  await flush()
  return engine
}

// El contexto que tiene una capa hoy, para pedirle al navegador que se lo quite.
const contextoDe = (engine, id) => {
  const { layer, editor } = engine.getLayer(id)
  const gl = (layer ?? editor).surface.gl
  return navegador.contextos.find(c => c.gl === gl)
}

const estados = engine => Object.fromEntries(engine.surfaces().map(s => [s.layerId, s.state]))

for (const id of ['flota', 'rutas', 'zonas', 'geo']) {
  test(`${id}: entre el desalojo y el evento, su fila ya dice lost, y las demás siguen vivas`, async () => {
    const engine = await montar()
    const avisos = []
    engine.on('surfacechange', detail => avisos.push(detail.layerId))
    assert.deepEqual(Object.values(estados(engine)), ['live', 'live', 'live', 'live'])

    assert.equal(navegador.desalojar(contextoDe(engine, id)), true)
    assert.equal(contextoDe(engine, id).gl.isContextLost(), true, 'el navegador lo perdió en el acto')
    assert.equal(navegador.pendientes, 1, 'y el evento todavía no llegó')
    assert.deepEqual(avisos, [], 'ni la señal del motor')
    assert.deepEqual(estados(engine), { flota: 'live', rutas: 'live', zonas: 'live', geo: 'live', [id]: 'lost' })
    engine.destroy()
  })
}

test('cuando el evento llega, la señal sale una vez con la fila que surfaces() ya daba', async () => {
  const engine = await montar()
  const avisos = []
  engine.on('surfacechange', detail => avisos.push(detail))

  navegador.desalojar(contextoDe(engine, 'rutas'))
  const antes = engine.surfaces().find(s => s.layerId === 'rutas')
  navegador.vaciar()

  assert.equal(avisos.length, 1)
  assert.deepEqual(avisos[0], antes, 'el aviso confirma lo que la fila ya decía')
  assert.equal(avisos[0].state, 'lost')
  engine.destroy()
})
