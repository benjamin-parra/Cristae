// El oráculo se prueba a sí mismo (DISENO-INTEROP §5-3bis): un oráculo que comparte un error con el
// lector lo vuelve invisible. Acá sus tablas se contrastan contra valores escritos a mano, derivados
// de §17.1 (tabla tipo → partes y anillos) y de §3.1 y §3.2.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { oraculoGpx, oraculoKml } from './oraculo-xml.mjs'

const tablas = r => Object.fromEntries(['geometryAt', 'partAt', 'ringAt', 'vertexAt', 'kinds', 'featureOf', 'closed', 'xy', 'layerOf']
  .map(k => [k, Array.from(r[k])]))

test('KML: Polygon con hoyo, MultiGeometry y capas, a mano', () => {
  const r = oraculoKml(`<kml><Document><name>D</name>
    <Placemark><Polygon><extrude>1</extrude>
      <outerBoundaryIs><LinearRing><coordinates>0,0 2,0 2,2 0,0</coordinates></LinearRing></outerBoundaryIs>
      <innerBoundaryIs><LinearRing><coordinates>1,0.5 1.5,1 1,1 1,0.5</coordinates></LinearRing></innerBoundaryIs>
    </Polygon></Placemark>
    <Folder><name>F</name><Placemark><MultiGeometry><Point><coordinates>5,5,1</coordinates></Point><Model/></MultiGeometry></Placemark></Folder>
  </Document></kml>`)
  assert.deepEqual(tablas(r), {
    geometryAt : [0, 1, 2],
    partAt     : [0, 1, 2],
    ringAt     : [0, 2, 3],
    vertexAt   : [0, 4, 8, 9],
    kinds      : [5, 1],
    featureOf  : [0, 1],
    closed     : [1, 1, 0],
    xy         : [0, 0, 2, 0, 2, 2, 0, 0, 1, 0.5, 1.5, 1, 1, 1, 1, 0.5, 5, 5],
    layerOf    : [0, 1],
  })
  assert.deepEqual(Array.from(r.z).map(String), ['NaN', 'NaN', 'NaN', 'NaN', 'NaN', 'NaN', 'NaN', 'NaN', '1'])
  assert.deepEqual(r.layers, [{ name: 'D', parent: -1 }, { name: 'F', parent: 0 }])
  assert.equal(r.stats.foreignMembers, 1)
  assert.equal(r.stats.skippedGeometries, 1)
  // El punto es un anillo de 1 vértice y cuenta como corto; el hoyo es antihorario.
  assert.equal(r.stats.shortRings, 1)
  assert.equal(r.stats.reversedRings, 1)
  assert.equal(r.stats.degenerateRings, 0)
})

test('KML: vacíos, a mano (§17.3-14)', () => {
  const r = oraculoKml('<kml><Placemark><Point/></Placemark><Placemark><Polygon><outerBoundaryIs><LinearRing/></outerBoundaryIs></Polygon></Placemark><Placemark/></kml>')
  assert.deepEqual(tablas(r), {
    geometryAt : [0, 1, 2, 2],
    partAt     : [0, 0, 1],
    ringAt     : [0, 1],
    vertexAt   : [0, 0],
    kinds      : [1, 5],
    featureOf  : [0, 1],
    closed     : [0],
    xy         : [],
    layerOf    : [0, 0, 0],
  })
  assert.equal(r.z, null)
  assert.equal(r.stats.emptyGeometries, 1)
})

test('GPX: wpt, rte y trk, a mano (D-15)', () => {
  const r = oraculoGpx(`<gpx><wpt lat="1" lon="2"><ele>3</ele><time>t</time></wpt>
    <rte><name>r</name><rtept lat="4" lon="5"/><rtept lat="6" lon="7"/></rte>
    <trk><trkseg><trkpt lat="8" lon="9"/></trkseg><trkseg/></trk></gpx>`)
  assert.deepEqual(tablas(r), {
    geometryAt : [0, 1, 2, 3],
    partAt     : [0, 1, 2, 4],
    ringAt     : [0, 1, 2, 3, 4],
    vertexAt   : [0, 1, 3, 4, 4],
    kinds      : [1, 3, 4],
    featureOf  : [0, 1, 2],
    closed     : [0, 0, 0, 0],
    xy         : [2, 1, 5, 4, 7, 6, 9, 8],
    layerOf    : [0, 0, 0],
  })
  assert.equal(r.stats.foreignMembers, 1)
})
