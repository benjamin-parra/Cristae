// fitToLayers: `pathOf` se lee con el contrato de path de las líneas, así que el encuadre cubre lo que la
// capa dibuja —cualquier forma de punto, sin lo que la regla de corte deja fuera—, y lo que no es punto
// en un anillo no lo rompe. El harness no abre contextos WebGL: se declara el backend de Leaflet, y
// `latLngBounds` devuelve las esquinas tal cual llegan, para asertar la caja sin la aritmética de Leaflet.

import '../../test-helpers/engine-stub.mjs'
import { makeGlify, makeMap, makeLeaflet } from '../../test-helpers/engine-stub.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MapEngine } from '../../src/engine/MapEngine.js'

const encuadre = alta => {
  const map   = makeMap()
  const L     = makeLeaflet()
  const cajas = []
  L.latLngBounds = (sw, ne) => [...sw, ...ne]
  map.fitBounds  = caja => { cajas.push(caja); return map }

  const engine = new MapEngine({ leaflet: L, glify: makeGlify(), map })
  alta(engine)
  engine.fitToLayers()
  engine.destroy()
  return cajas
}

const deLinea = path => encuadre(engine => engine.addLineLayer({
  id: 'ruta', backend: 'leaflet', accessors: { idOf: r => r.id, pathOf: r => r.path }, data: [{ id: 1, path }],
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
    id: 'zona', backend: 'leaflet', accessors: { idOf: z => z.id, ringsOf: z => z.rings }, data: [{ id: 1, rings }],
  }))
  assert.deepEqual(cajas, [[10, 20, 12, 21]])
})
