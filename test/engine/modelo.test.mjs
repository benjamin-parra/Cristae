// La opción `model` del motor: el modelo con que dibuja y pica la capa de formas, con que los editores de
// forma ubican sus manijas y con que `addGeodesic` curva. Sin ella queda la esfera por defecto, y el alias de
// círculos no la lee. Las referencias salen de la geographiclib directa y de la fórmula cerrada de la esfera,
// no de lo que dibuja el código; y el reparto del modelo, de un modelo que delega en WGS84 y cuenta los
// destinos y los rumbos que le piden.

import { conGlDeEdicion, contando, makeEditGl, makeLeaflet, makeMap } from '../../test-helpers/engine-stub.mjs'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import geographiclib from 'geographiclib-geodesic'
import { MapEngine } from '../../src/engine/MapEngine.js'
import { AREA, DESTINATION, HEADING, MODEL, RELIEF, byDefault, sphere } from '../../src/geometry/geodesic.js'
import { WGS84 } from '../../src/geometry/ellipsoid.js'
import { adoptLeafletHost } from '../../src/host/LeafletHost.js'

after(conGlDeEdicion(() => makeEditGl()))

const { Geodesic, LATITUDE, LONGITUDE, LONG_UNROLL } = geographiclib.Geodesic
const ELIPSOIDE = new Geodesic(6378137, 1 / 298.257223563)
const MEAN_R    = 6371008.8
const RAD       = Math.PI / 180

const flush = () => new Promise(r => setTimeout(r, 0))

const motor = model => {
  const map   = makeMap()
  const cajas = []
  map.fitBounds = ([sw, ne]) => { cajas.push([...sw, ...ne]); return map }
  return { engine: new MapEngine({ host: adoptLeafletHost(map, { leaflet: makeLeaflet() }), model }), cajas }
}

// El norte de la caja que encuadra `fitToLayers`.
const norte = ({ engine, cajas }) => {
  cajas.length = 0
  engine.fitToLayers()
  return cajas[0][2]
}

const zona = { idOf: f => f.id, positionOf: f => f.center, radiusOf: f => f.radius }
const circulo = (engine, radius = 1e6) =>
  engine.addShapeLayer({ id: 'zona', accessors: zona, data: [{ id: 1, center: [0, 0], radius }] })

const AL_NORTE = (metros, esfera) => esfera ? metros / MEAN_R / RAD
  : ELIPSOIDE.Direct(0, 0, 0, metros, LATITUDE | LONGITUDE | LONG_UNROLL).lat2

/* ── Quién lo recibe ── */

test('sin opción la capa de formas se coloca sobre la esfera por defecto, y con WGS84 sobre el elipsoide', () => {
  const esfera = motor()
  circulo(esfera.engine)
  assert.ok(Math.abs(norte(esfera) - AL_NORTE(1e6, true)) < 1e-9, `esfera: ${norte(esfera)}`)

  const elipsoide = motor(WGS84)
  circulo(elipsoide.engine)
  assert.ok(Math.abs(norte(elipsoide) - AL_NORTE(1e6, false)) < 1e-7, `WGS84: ${norte(elipsoide)}`)
  assert.ok(Math.abs(AL_NORTE(1e6, true) - AL_NORTE(1e6, false)) > 0.04, 'la referencia distingue los dos modelos')
  esfera.engine.destroy()
  elipsoide.engine.destroy()
})

test('una esfera de otro radio escala la capa de formas', () => {
  const t = motor(sphere(MEAN_R / 2))
  circulo(t.engine, 1e6 / 2)
  assert.ok(Math.abs(norte(t) - AL_NORTE(1e6, true)) < 1e-9, `norte ${norte(t)}`)
  t.engine.destroy()
})

// Que el modelo llegue alcanza acá: cómo ubica cada editor sus manijas con él se mide contra la geographiclib
// en test/render/editable-geometry.test.mjs.
test('los editores de forma colocan su anillo con el modelo del mapa', () => {
  ;[
    ['circle', { center: [0, 0], radius: 30000 }],
    ['ellipse', { center: [0, 0], radius: [30000, 15000], heading: 30 }],
    ['sector', { center: [0, 0], radius: 30000, heading: 30, sweep: 90 }],
  ].forEach(([kind, value]) => {
    const modelo = contando(WGS84)
    const { engine } = motor(modelo)
    engine.addEditableLayer({ id: 'zona', kind, value })
    assert.ok(modelo.destinos > 0, kind)
    engine.destroy()
  })
})

test('addGeodesic curva sobre el modelo del mapa', () => {
  const modelo = contando(WGS84)
  const t      = motor(modelo)
  t.engine.addLineLayer({
    id: 'ruta', accessors: { idOf: r => r.id, pathOf: r => r.path }, data: [{ id: 1, path: [[50, 0], [50, 10]] }],
  })
  assert.equal(modelo.rumbos, 0, 'recta, el modelo no se usa')
  t.engine.addGeodesic({ hostId: 'ruta' })
  assert.ok(modelo.rumbos > 0 && modelo.destinos > 0, `rumbos ${modelo.rumbos}, destinos ${modelo.destinos}`)

  // El vértice de la geodésica de WGS84 entre dos puntos de igual latitud es su punto medio.
  const { s12, azi1 } = ELIPSOIDE.Inverse(50, 0, 50, 10)
  const cumbre        = ELIPSOIDE.Line(50, 0, azi1).Position(s12 / 2, LATITUDE).lat2
  const esfera = Math.atan(Math.tan(50 * RAD) / Math.cos(5 * RAD)) / RAD
  assert.ok(Math.abs(norte(t) - cumbre) < 5e-5, `norte ${norte(t)}, cumbre ${cumbre}`)
  assert.ok(Math.abs(esfera - cumbre) > 2e-4, 'la referencia distingue la esfera del elipsoide')
  t.engine.destroy()
})

test('el alias de círculos sigue en la esfera aunque el mapa traiga WGS84', async () => {
  const modelo = contando(WGS84)
  const { engine } = motor(modelo)
  engine.addCircleLayer({
    id: 'alias', accessors: { idOf: f => f.id, positionOf: f => f.center, radiusMetersOf: f => f.radius },
    data: [{ id: 1, center: { lat: 0, lng: 0 }, radius: 1e6 }],
  })
  await flush()
  assert.equal(modelo.destinos, 0, 'no ubica destinos con el modelo del mapa')

  // A 1,003 r sobre la esfera el punto cae fuera del círculo; sobre WGS84 (el meridiano mide menos a la
  // latitud 0) la misma distancia ya está dentro, así que un pick que cayera en WGS84 lo acertaría.
  const afuera = { lat: AL_NORTE(1.003e6, true), lng: 0 }
  assert.deepEqual(engine.getLayer('alias').layer.resolveClick(afuera), [])
  assert.equal(engine.getLayer('alias').layer.resolveClick({ lat: AL_NORTE(0.997e6, true), lng: 0 }).length, 1)

  circulo(engine)
  await flush()
  assert.equal(engine.getLayer('zona').layer.resolveClick(afuera).length, 1, 'la capa de formas, en cambio, sí lo pica')
  assert.ok(modelo.destinos > 0)
  engine.destroy()
})

/* ── Lo que no es un modelo que sepa colocar ── */

const sinMarca = marca => {
  const modelo = { [MODEL]: WGS84[MODEL], [AREA]: WGS84[AREA], [DESTINATION]: WGS84[DESTINATION], [HEADING]: WGS84[HEADING] }
  delete modelo[marca]
  return modelo
}

test('un modelo que no sirve lanza TypeError en el alta, antes de armar el mapa', () => {
  const casos = [
    ['un terreno', { [MODEL]: WGS84[MODEL], [AREA]: WGS84[AREA], [RELIEF]: () => 0 }, /terreno/],
    ['sin destino', sinMarca(DESTINATION), /no ubica destinos/],
    ['sin rumbo', sinMarca(HEADING), /no ubica rumbos/],
    ['un objeto cualquiera', {}, /sphere\(\)/],
    ['null', null, /sphere\(\)/],
    ['una cadena', 'WGS84', /sphere\(\)/],
  ]
  casos.forEach(([nombre, model, mensaje]) =>
    // Sin host ni contenedor: si el mapa se armara antes, lanzaría otra cosa.
    assert.throws(() => new MapEngine({ model }), error => error instanceof TypeError && mensaje.test(error.message), nombre))
})

test('el modelo por defecto y los de la fábrica entran', () => {
  ;[byDefault, sphere(), WGS84].forEach(model => motor(model).engine.destroy())
})
