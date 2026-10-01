// fitToLayers: `pathOf` se lee con el contrato de path de las líneas, así que el encuadre cubre lo que la
// capa dibuja —cualquier forma de punto, sin lo que la regla de corte deja fuera—, y lo que no es punto
// en un anillo no lo rompe. El harness presta un WebGL2 de edición para el sustrato GPU. La
// cámara le entrega a Leaflet la caja como par de esquinas, que se aplana para asertarla.

import '../../test-helpers/engine-stub.mjs'
import { conGlDeEdicion, makeEditGl, makeGlify, makeMap, makeLeaflet } from '../../test-helpers/engine-stub.mjs'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { MapEngine } from '../../src/engine/MapEngine.js'
import { adoptLeafletHost } from '../../src/host/LeafletHost.js'

after(conGlDeEdicion(() => makeEditGl()))

const encuadre = alta => {
  const map   = makeMap()
  const cajas = []
  map.fitBounds = ([sw, ne]) => { cajas.push([...sw, ...ne]); return map }

  const engine = new MapEngine({ host: adoptLeafletHost(map, { leaflet: makeLeaflet() }), glify: makeGlify() })
  alta(engine)
  engine.fitToLayers()
  engine.destroy()
  return cajas
}

const deLinea = path => encuadre(engine => engine.addLineLayer({
  id: 'ruta', backend: 'gpu', accessors: { idOf: r => r.id, pathOf: r => r.path }, data: [{ id: 1, path }],
}))

test('encuadra una línea en cualquiera de las formas de punto', () => {
  const formas = {
    par      : ([lat, lng]) => [lat, lng],
    tipado   : ([lat, lng]) => Float64Array.of(lat, lng, 500),
    latLng   : ([lat, lng]) => ({ lat, lng }),
    latLon   : ([lat, lon]) => ({ lat, lon }),
    latitude : ([latitude, longitude]) => ({ latitude, longitude }),
  }
  for (const [nombre, forma] of Object.entries(formas))
    assert.deepEqual(deLinea([[10, 20], [11, 21]].map(forma)), [[10, 20, 11, 21]], nombre)
})

test('el tope de maxZoom va en el mismo encuadre, sin un zoom aparte', () => {
  const map     = makeMap({ zoom: 12 })
  const pedidos = []
  map.fitBounds = (corners, { maxZoom }) => { pedidos.push(maxZoom); return map }
  map.setZoom   = zoom => { pedidos.push(`setZoom ${zoom}`); return map }

  const engine = new MapEngine({ host: adoptLeafletHost(map, { leaflet: makeLeaflet() }), glify: makeGlify() })
  engine.addLineLayer({
    id: 'ruta', backend: 'gpu', accessors: { idOf: r => r.id, pathOf: r => r.path }, data: [{ id: 1, path: [[10, 20], [11, 21]] }],
  })
  engine.fitToLayers(null, { maxZoom: 9 })
  engine.destroy()
  assert.deepEqual(pedidos, [9])
})

test('lo que la regla de corte deja fuera no entra al encuadre', () => {
  const cruzada = [[10, 20], [11, 21], [-122.4, 37.8], [12, 22], [13, 23]]
  assert.deepEqual(deLinea(cruzada), [[10, 20, 13, 23]], 'una latitud fuera de rango corta')
  assert.deepEqual(deLinea([[10, 20], [11, 21], [NaN, 0], [50, 50]]), [[10, 20, 11, 21]],
    'un vértice suelto tras un corte no se dibuja')
  assert.deepEqual(deLinea([[[10, 20], [11, 21]], [[30, 40], [31, 41]]]), [[10, 20, 31, 41]], 'anidado')
  assert.deepEqual(deLinea([[10, 20]]), [], 'una línea sin tramo no encuadra nada')
})

// Un string también se recorre, pero no es un iterable de coordenadas: abrirlo da otro string, sin fondo.
test('un vértice string en un anillo no rompe el encuadre del polígono', () => {
  const rings = [[[10, 20], 'N/A', [11, 21], [12, 20]]]
  const cajas = encuadre(engine => engine.addPolygonLayer({
    id: 'zona', accessors: { idOf: z => z.id, ringsOf: z => z.rings }, data: [{ id: 1, rings }],
  }))
  assert.deepEqual(cajas, [[10, 20, 12, 21]])
})

// Una latitud fuera de [-90, 90] no es un lugar: encuadrarla sería encuadrar el borde del mundo.
test('un vértice sin lugar en un anillo no entra al encuadre del polígono', () => {
  const rings = [[[10, 20], [95, 21], [11, 21], [12, 20]]]
  const cajas = encuadre(engine => engine.addPolygonLayer({
    id: 'zona', accessors: { idOf: z => z.id, ringsOf: z => z.rings }, data: [{ id: 1, rings }],
  }))
  assert.deepEqual(cajas, [[10, 20, 12, 21]])
})
