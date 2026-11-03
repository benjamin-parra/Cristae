// Equivalencia entre formatos (DISENO-INTEROP §5-3, SPECS §19.17): la misma geometría escrita en cada
// formato da las mismas tablas que `readGeoJson` sobre esa geometría. Es el test más fuerte contra los
// errores de nivel CSR, porque cada lector arma las tablas por un camino distinto.
//
// Diferencias declaradas, que el test respeta en lugar de esconder:
// - Shapefile y EsriJSON agrupan los anillos por orientación (§19.4): los exteriores van horarios y los
//   hoyos antihorarios, y así GeoJSON los lee igual (sólo cambia `reversedRings`, que no se compara).
// - GPX no tiene polígonos ni multi: entra con el punto y la línea.
// - KML aplana `MultiGeometry` en geometrías sueltas: entra sin el MultiPolygon.
// - Las coordenadas son decimales cuyo texto y cuyo double coinciden, para que los formatos de texto y
//   los binarios lean el mismo número.

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  readKml, readKmz, readGpx, readWkt, readWkb, readTopoJson, readEsriJson, readShapefile, readShapefileZip,
  readFlatGeobuf,
} from '../../src/formats/index.js'
import { readGeoJson, areasOf } from '../../src/geojson/index.js'
import { compararTablas, invariantes, TABLAS } from './comun.mjs'
import { escribirWkb } from './wkb/generador.mjs'
import { escribirShp, escribirZip } from './shapefile/escritor.mjs'
import { escribirFgb } from './flatgeobuf/escritor.mjs'
import { zip } from './kml/zip-de-prueba.mjs'

// Exteriores horarios y hoyos antihorarios (la convención de Shapefile y EsriJSON).
const EXTERIOR = [[-71.5, -33.25], [-71.5, -33], [-71, -33], [-71, -33.25], [-71.5, -33.25]]
const HOYO     = [[-71.375, -33.1875], [-71.125, -33.1875], [-71.125, -33.0625], [-71.375, -33.0625], [-71.375, -33.1875]]
const OTRO     = [[-70.25, -34.5], [-70.25, -34.125], [-70.125, -34.125], [-70.125, -34.5], [-70.25, -34.5]]

const GEOMETRIAS = {
  Point        : { type: 'Point', coordinates: [-70.65625, -33.4375] },
  LineString   : { type: 'LineString', coordinates: [[-70.5, -33.5], [-70.25, -33.375], [-70.0625, -33.125]] },
  Polygon      : { type: 'Polygon', coordinates: [EXTERIOR, HOYO] },
  MultiPolygon : { type: 'MultiPolygon', coordinates: [[EXTERIOR, HOYO], [OTRO]] },
}

// ── Escritores de texto, ingenuos y a la vista ──────────────────────────────────────────────────────

const par   = p => `${p[0]} ${p[1]}`
const lista = ps => `(${ps.map(par).join(', ')})`
const wkt = g =>
  g.type === 'Point' ? `POINT (${par(g.coordinates)})`
  : g.type === 'LineString' ? `LINESTRING ${lista(g.coordinates)}`
  : g.type === 'Polygon' ? `POLYGON (${g.coordinates.map(lista).join(', ')})`
  : `MULTIPOLYGON (${g.coordinates.map(p => `(${p.map(lista).join(', ')})`).join(', ')})`

const coords = ps => `<coordinates>${ps.map(p => p.join(',')).join(' ')}</coordinates>`
const kml = g => {
  const cuerpo =
    g.type === 'Point' ? `<Point>${coords([g.coordinates])}</Point>`
    : g.type === 'LineString' ? `<LineString>${coords(g.coordinates)}</LineString>`
    : `<Polygon><outerBoundaryIs><LinearRing>${coords(g.coordinates[0])}</LinearRing></outerBoundaryIs>` +
      g.coordinates.slice(1).map(h => `<innerBoundaryIs><LinearRing>${coords(h)}</LinearRing></innerBoundaryIs>`).join('') +
      '</Polygon>'
  return `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Placemark>${cuerpo}</Placemark></kml>`
}

const gpx = g => {
  const pt = (tag, p) => `<${tag} lat="${p[1]}" lon="${p[0]}"/>`
  const cuerpo = g.type === 'Point' ? pt('wpt', g.coordinates) : `<rte>${g.coordinates.map(p => pt('rtept', p)).join('')}</rte>`
  return `<?xml version="1.0"?><gpx version="1.1" creator="t" xmlns="http://www.topografix.com/GPX/1/1">${cuerpo}</gpx>`
}

// Un arco por línea o anillo, sin `transform`: los índices son la única indirección.
const topojson = g => {
  const arcs = []
  const arco = ps => (arcs.push(ps), arcs.length - 1)
  const geometria =
    g.type === 'Point' ? { type: 'Point', coordinates: g.coordinates }
    : g.type === 'LineString' ? { type: 'LineString', arcs: [arco(g.coordinates)] }
    : g.type === 'Polygon' ? { type: 'Polygon', arcs: g.coordinates.map(r => [arco(r)]) }
    : { type: 'MultiPolygon', arcs: g.coordinates.map(p => p.map(r => [arco(r)])) }
  return JSON.stringify({ type: 'Topology', objects: { capa: geometria }, arcs })
}

const esrijson = g => {
  const geometria =
    g.type === 'Point' ? { x: g.coordinates[0], y: g.coordinates[1] }
    : g.type === 'LineString' ? { paths: [g.coordinates] }
    : g.type === 'Polygon' ? { rings: g.coordinates }
    : { rings: g.coordinates.flat() }
  return JSON.stringify({ features: [{ geometry: geometria, attributes: {} }] })
}

const coleccion = g => ({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: g, properties: null }] })

// Formato → lector sobre la geometría, y los tipos que entran.
const FORMATOS = {
  wkt        : { tipos: 'Point LineString Polygon MultiPolygon', leer: g => readWkt(wkt(g)) },
  wkb        : { tipos: 'Point LineString Polygon MultiPolygon', leer: g => readWkb(escribirWkb(g)) },
  kml        : { tipos: 'Point LineString Polygon', leer: g => readKml(kml(g)) },
  kmz        : { tipos: 'Polygon', leer: async g => readKmz(await zip([['doc.kml', new TextEncoder().encode(kml(g)), 8]])) },
  gpx        : { tipos: 'Point LineString', leer: g => readGpx(gpx(g)) },
  topojson   : { tipos: 'Point LineString Polygon MultiPolygon', leer: g => readTopoJson(topojson(g)) },
  esrijson   : { tipos: 'Point LineString Polygon MultiPolygon', leer: g => readEsriJson(esrijson(g)) },
  shapefile  : { tipos: 'Point LineString Polygon MultiPolygon', leer: g => readShapefile({ shp: escribirShp(coleccion(g)) }) },
  'shp.zip'  : { tipos: 'MultiPolygon', leer: async g => readShapefileZip(await escribirZip([{ nombre: 'capa.shp', bytes: escribirShp(coleccion(g)) }])) },
  flatgeobuf : { tipos: 'Point LineString Polygon MultiPolygon', leer: g => readFlatGeobuf(escribirFgb(coleccion(g))) },
}

const CAMPOS = TABLAS.filter(k => k !== 'layerOf')

Object.entries(GEOMETRIAS).forEach(([tipo, g]) => {
  const esperado = readGeoJson(JSON.stringify(coleccion(g)))

  test(`${tipo}: cada formato que lo expresa da las tablas de GeoJSON`, async () => {
    const formatos = Object.entries(FORMATOS).filter(([, { tipos }]) => tipos.split(' ').includes(tipo))
    assert.ok(formatos.length >= 4, `${tipo} en sólo ${formatos.length} formatos`)
    for (const [nombre, { leer }] of formatos) {
      const leido = await leer(g)
      invariantes(leido)
      try {
        compararTablas(leido, esperado, { campos: CAMPOS, z: false })
      } catch (e) {
        e.message = `${nombre}: ${e.message}`
        throw e
      }
      assert.deepEqual(leido.layerOf, new Uint32Array([0]), nombre)
      assert.deepEqual(areasOf(leido).rings, areasOf(esperado).rings, `${nombre}: areasOf`)
    }
  })
})
