// Lo que se retira en v0.40.0 avisa por consola una vez por página, con el reemplazo (DEPRECADOS-0.40). Acá van
// las puertas del motor que antes no avisaban y la clave que comparten <cristae-label-layer> y `addLabelLayer`:
// el elemento monta por el método, y quien usa uno no ve también el aviso del otro.
// Corre con: node --test test/engine/retiro-avisos.test.mjs
import '../../test-helpers/element-stub.mjs'
import { conGlDeEdicion, makeEditGl, makeLeaflet, makeMap, makePickSpy } from '../../test-helpers/engine-stub.mjs'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { MapEngine } from '../../src/engine/MapEngine.js'
import { adoptLeafletHost } from '../../src/host/LeafletHost.js'
import { CristaeLabelLayer } from '../../src/element/CristaeLabelLayer.js'

after(conGlDeEdicion(() => makeEditGl(makePickSpy())))

const nuevo = () => new MapEngine({ host: adoptLeafletHost(makeMap(), { leaflet: makeLeaflet() }) })

// Los avisos que deja `alta` en dos motores: el segundo ya no avisa.
const avisos = (t, alta) => {
  const warn = t.mock.method(console, 'warn', () => {})
  const a    = nuevo()
  const b    = nuevo()
  alta(a)
  alta(a, 'otra')
  alta(b)
  a.destroy()
  b.destroy()
  return warn.mock.calls.map(c => c.arguments[0])
}

// El alias sólo delega en `addPolygonLayer`: con un receptor que la devuelve, no hace falta GL.
test('addPolygonGpuLayer avisa una vez por página y nombra addPolygonLayer', t => {
  const warn  = t.mock.method(console, 'warn', () => {})
  const motor = { addPolygonLayer: cfg => cfg }
  const alta  = id => MapEngine.prototype.addPolygonGpuLayer.call(motor, { id, geometry: {} })
  assert.equal(alta('areas').pane, 'cristae-polygon-gpu-areas', 'sigue delegando igual')
  alta('otras')
  assert.equal(warn.mock.callCount(), 1)
  assert.match(warn.mock.calls[0].arguments[0], /^\[cristae\] addPolygonGpuLayer\(\) se retira en v0\.40\.0: la reemplaza addPolygonLayer\(\{ geometry \}\)\.$/)
})

test('addCircleLayer avisa una vez por página y nombra addShapeLayer con radiusOf', t => {
  const accessors = { idOf: d => d.id, positionOf: d => d, radiusMetersOf: () => 100 }
  const vistos    = avisos(t, (engine, id = 'radios') => engine.addCircleLayer({ id, accessors, data: [] }))
  assert.equal(vistos.length, 1)
  assert.match(vistos[0], /addCircleLayer\(\) se retira en v0\.40\.0: la reemplaza addShapeLayer, con radiusOf .*<cristae-shape-layer>/)
})

test('addLabelLayer y <cristae-label-layer> comparten un solo aviso por página', t => {
  const vistos = avisos(t, (engine, id = 'rotulos') => {
    const capa = Object.assign(Object.create(CristaeLabelLayer.prototype), { bindTo: 'flota', visible: true, layerId: () => `${id}-el` })
    capa.mountLayer(engine)
    engine.addLabelLayer({ id })
  })
  assert.equal(vistos.length, 1, 'el elemento monta por addLabelLayer y no se avisa dos veces')
  assert.match(vistos[0], /^\[cristae-label-layer\] se retira en v0\.40\.0: con bind-to .*<cristae-labeled>.*<cristae-text-layer>/)
})
