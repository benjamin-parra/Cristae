// `addGeodesic`: curva los tramos del host sobre la geodésica del modelo del mapa, y su baja vuelve a rectas.
// Sin registro, id ni rama en `removeLayer`: la curva es estado del host (`setCurve`) y muere con él. Se ve con
// lo que el host dibuja de verdad: la caja de una línea (`fitToLayers`) y el midpoint de las manijas de un
// editor, contra el vértice del círculo máximo entre dos puntos de igual latitud, `tan φv = tan φ / cos(Δλ/2)`.
// Los polígonos no exponen lo que dibujan, así que ahí se mide el cableado: qué modelo recibe `setCurve`.

import '../../test-helpers/engine-stub.mjs'
import { conGlDeEdicion, makeEditGl, makeIconSet, makeLeaflet, makeMap } from '../../test-helpers/engine-stub.mjs'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { MapEngine } from '../../src/engine/MapEngine.js'
import { byDefault } from '../../src/geometry/geodesic.js'
import { adoptLeafletHost } from '../../src/host/LeafletHost.js'
import { tablesFromRings } from '../../src/render/PolygonGpuLayer.js'

after(conGlDeEdicion(() => makeEditGl()))

const RAD = Math.PI / 180

const motor = () => {
  const map   = makeMap()
  const cajas = []
  map.fitBounds = ([sw, ne]) => { cajas.push([...sw, ...ne]); return map }
  return { engine: new MapEngine({ host: adoptLeafletHost(map, { leaflet: makeLeaflet() }) }), cajas }
}

// El norte de la caja que encuadra `fitToLayers`: 50 sin curva, y con ella la cumbre del círculo máximo.
const norte = ({ engine, cajas }) => {
  cajas.length = 0
  engine.fitToLayers()
  return cajas[0][2]
}
const CUMBRE = Math.atan(Math.tan(50 * RAD) / Math.cos(5 * RAD)) / RAD
const linea  = engine => engine.addLineLayer({
  id: 'ruta', accessors: { idOf: r => r.id, pathOf: r => r.path }, data: [{ id: 1, path: [[50, 0], [50, 10]] }],
})
const curva = (t, esperado, nombre) => {
  const real = norte(t)
  assert.ok(Math.abs(real - esperado) < 1e-4, `${nombre}: norte ${real}, esperado ${esperado}`)
}

test('curva una línea sobre la geodésica, y la baja vuelve a rectas', () => {
  const t = motor()
  linea(t.engine)
  curva(t, 50, 'sin curva')

  const off = t.engine.addGeodesic({ hostId: 'ruta' })
  assert.equal(typeof off, 'function')
  curva(t, CUMBRE, 'curvada')

  off()
  curva(t, 50, 'vuelta a rectas')
  assert.doesNotThrow(off, 'la baja es idempotente')
  t.engine.destroy()
})

test('un segundo alta sobre el mismo host reemplaza la curva y deja inerte a la baja anterior', () => {
  const t = motor()
  linea(t.engine)
  const primera = t.engine.addGeodesic({ hostId: 'ruta' })
  const segunda = t.engine.addGeodesic({ hostId: 'ruta' })

  primera()
  curva(t, CUMBRE, 'la baja vieja no limpia la curva de la nueva')
  segunda()
  curva(t, 50, 'la vigente sí')

  const tercera = t.engine.addGeodesic({ hostId: 'ruta' })
  segunda()
  curva(t, CUMBRE, 'una baja ya usada no limpia la curva que vino después')
  tercera()
  t.engine.destroy()
})

// Anota los modelos que recibe el `setCurve` de la capa.
const espiar = (engine, id) => {
  const capa     = engine.getLayer(id).layer
  const llamadas = []
  const setCurve = capa.setCurve.bind(capa)
  capa.setCurve  = model => { llamadas.push(model); return setCurve(model) }
  return llamadas
}

test('la baja tras quitar el host no hace nada, y no toca a otro host con el mismo id', () => {
  const t = motor()
  linea(t.engine)
  const vieja    = t.engine.addGeodesic({ hostId: 'ruta' })
  const llamadas = espiar(t.engine, 'ruta')

  t.engine.removeLayer('ruta')
  vieja()
  assert.deepEqual(llamadas, [], 'la capa destruida no recibe nada')

  linea(t.engine)
  t.engine.addGeodesic({ hostId: 'ruta' })
  vieja()
  curva(t, CUMBRE, 'la capa nueva con el mismo id conserva su curva')
  t.engine.destroy()
})

test('un host que no se curva da null', () => {
  const { engine } = motor()
  engine.addPointLayer({
    id: 'flota', iconSet: makeIconSet(), data: [{ id: 1, lat: 0, lng: 0, size: 24 }],
    accessors: { idOf: p => p.id, positionOf: p => ({ lat: p.lat, lng: p.lng }), sizeOf: p => p.size },
  })
  engine.addShapeLayer({ id: 'zona', accessors: { idOf: f => f.id, positionOf: f => ({ lat: f.center[0], lng: f.center[1] }), radiusOf: () => 100 }, data: [{ id: 1, center: [0, 0] }] })
  engine.addEditableLayer({ id: 'rect', kind: 'rectangle' })
  engine.addEditableLayer({ id: 'punto', kind: 'point' })
  engine.addEditableLayer({ id: 'circ', kind: 'circle' })
  engine.addPolygonLayer({ id: 'tipado', geometry: tablesFromRings([{ id: 1 }], () => [[0, 0], [0, 1], [1, 1]]), interactive: false })

  ;['nadie', 'flota', 'zona', 'rect', 'punto', 'circ', 'tipado'].forEach(hostId =>
    assert.equal(engine.addGeodesic({ hostId }), null, hostId))
  engine.destroy()
})

// Una capa de polígonos no expone lo que dibuja: se mide que reciba el modelo del mapa y que la baja la rectifique.
// Con Source se curva aunque no sea interactiva, porque relee sus anillos.
test('una capa de polígonos con Source, o tipada e interactiva, se curva con el modelo del mapa', () => {
  const { engine } = motor()
  const anillos = { idOf: g => g.id, ringsOf: () => [[0, 0], [0, 10], [10, 10]] }
  engine.addPolygonLayer({ id: 'zonas', accessors: anillos, data: [{ id: 1 }] })
  engine.addPolygonLayer({ id: 'quietas', accessors: anillos, data: [{ id: 1 }], interactive: false })
  engine.addPolygonLayer({ id: 'tipada', geometry: tablesFromRings([{ id: 1 }], anillos.ringsOf) })

  ;['zonas', 'quietas', 'tipada'].forEach(id => {
    const llamadas = espiar(engine, id)
    const off      = engine.addGeodesic({ hostId: id })
    assert.equal(typeof off, 'function', id)
    assert.deepEqual(llamadas, [byDefault], id)
    off()
    assert.deepEqual(llamadas, [byDefault, null], id)
  })
  engine.destroy()
})

// El midpoint de la primera manija de un editor: lat y lng del punto medio de su primer tramo.
const medio = (engine, id) => {
  const path = engine.getLayer(id).editor.paths[0]
  const v    = path.firstVertex
  return [path.xAt(path.midOf(v)), path.yAt(path.midOf(v))]
}

test('un editor de polilínea o de polígono curva su contorno, y el midpoint de la manija cae sobre la curva', () => {
  const { engine } = motor()
  engine.addEditableLayer({ id: 'ruta', kind: 'polyline', value: [[50, 0], [50, 10]] })
  engine.addEditableLayer({ id: 'zona', kind: 'polygon', value: [[50, 0], [50, 10], [60, 5]] })

  ;['ruta', 'zona'].forEach(id => {
    assert.deepEqual(medio(engine, id), [50, 5], `${id}: el midpoint recto es el promedio`)
    const off = engine.addGeodesic({ hostId: id })
    const [lat, lng] = medio(engine, id)
    assert.ok(Math.abs(lat - CUMBRE) < 1e-4 && Math.abs(lng - 5) < 1e-9, `${id}: midpoint ${lat}, ${lng}; esperado ${CUMBRE}, 5`)
    off()
    assert.deepEqual(medio(engine, id), [50, 5], `${id}: la baja vuelve a rectas`)
  })
  engine.destroy()
})
