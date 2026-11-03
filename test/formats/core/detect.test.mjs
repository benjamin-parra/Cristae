// Detección de formato (DISENO-INTEROP §2.8): bytes mágicos y primer token, sin lanzar nunca.

import test from 'node:test'
import assert from 'node:assert/strict'
import { detectFormat } from '../../../src/formats/core/detect.js'
import { mutante } from '../comun.mjs'

const enc = new TextEncoder()
const u16 = v => [v & 0xFF, v >>> 8 & 0xFF]
const u32 = v => [v & 0xFF, v >>> 8 & 0xFF, v >>> 16 & 0xFF, v >>> 24 & 0xFF]

// Un zip stored mínimo con los nombres dados, para distinguir KMZ, Shapefile en zip y zip a secas.
const zipCon = (...nombres) => {
  const locales = [], centrales = []
  nombres.forEach(n => {
    const name = enc.encode(n)
    centrales.push(...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u32(0), ...u32(0), ...u32(0), ...u32(0),
      ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(locales.length), ...name)
    locales.push(...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0), ...u32(0), ...u32(0), ...u32(0), ...u32(0),
      ...u16(name.length), ...u16(0), ...name)
  })
  return Uint8Array.from([...locales, ...centrales, ...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(nombres.length),
    ...u16(nombres.length), ...u32(centrales.length), ...u32(locales.length), ...u16(0)])
}

const wkbPunto = (le, tipo) => {
  const b = new DataView(new ArrayBuffer(21))
  b.setUint8(0, le ? 1 : 0)
  b.setUint32(1, tipo, le)
  b.setFloat64(5, -70.5, le)
  b.setFloat64(13, -33.4, le)
  return new Uint8Array(b.buffer)
}

const hex = b => Array.from(b, x => x.toString(16).padStart(2, '0')).join('')

const shp = () => {
  const b = new Uint8Array(100)
  new DataView(b.buffer).setInt32(0, 9994)
  return b
}

test('binarios por número mágico', () => {
  assert.equal(detectFormat(zipCon('doc.kml', 'files/a.png')), 'kmz')
  assert.equal(detectFormat(zipCon('capa.SHP', 'capa.dbf')), 'shapefile-zip')
  assert.equal(detectFormat(zipCon('leeme.txt')), 'zip')
  assert.equal(detectFormat(Uint8Array.of(0x50, 0x4B, 3, 4, 0, 0)), 'zip')
  assert.equal(detectFormat(Uint8Array.from([...enc.encode('fgb'), 3, ...enc.encode('fgb'), 0, 0, 0])), 'flatgeobuf')
  assert.equal(detectFormat(shp()), 'shapefile')
  assert.equal(detectFormat(wkbPunto(true, 1)), 'wkb')
  assert.equal(detectFormat(wkbPunto(false, 1001)), 'wkb')
  assert.equal(detectFormat(wkbPunto(true, 0x20000001)), 'wkb')
  assert.equal(detectFormat(wkbPunto(true, 8)), null)
})

test('WKB en hex, con el blanco final de un archivo de texto', () => {
  assert.equal(detectFormat(hex(wkbPunto(true, 3))), 'wkb')
  assert.equal(detectFormat(hex(wkbPunto(true, 3)).toUpperCase() + '\n'), 'wkb')
  assert.equal(detectFormat(hex(wkbPunto(true, 3)) + 'z'), null)
})

test('XML por la raíz, saltando prólogo, comentarios y DOCTYPE', () => {
  assert.equal(detectFormat('<?xml version="1.0"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"/>'), 'kml')
  assert.equal(detectFormat('﻿<!-- a > b --><kml:kml xmlns:kml="x"></kml:kml>'), 'kml')
  assert.equal(detectFormat('<?xml version="1.0"?><!DOCTYPE gpx><gpx version="1.1">'), 'gpx')
  assert.equal(detectFormat('<svg/>'), null)
})

test('JSON por las claves de la raíz', () => {
  assert.equal(detectFormat('{"type":"Topology","objects":{},"arcs":[]}'), 'topojson')
  assert.equal(detectFormat('{"features":[],"type":"FeatureCollection"}'), 'geojson')
  assert.equal(detectFormat('{"type":"Point","coordinates":[1,2]}'), 'geojson')
  assert.equal(detectFormat('{"geometryType":"esriGeometryPolygon","features":[]}'), 'esrijson')
  assert.equal(detectFormat('{"x":1,"y":2,"spatialReference":{"wkid":4326}}'), 'esrijson')
  assert.equal(detectFormat('{"geometry":{"x":1,"y":2},"attributes":{"type":"Point"}}'), 'esrijson')
  assert.equal(detectFormat('{"properties":{"type":"Topology"}}'), null)
  assert.equal(detectFormat('[1,2]'), null)
})

test('WKT por la palabra clave inicial, con SRID de EWKT', () => {
  assert.equal(detectFormat('POINT (1 2)'), 'wkt')
  assert.equal(detectFormat('  multipolygon empty'), 'wkt')
  assert.equal(detectFormat('SRID=4326;LINESTRING(0 0,1 1)'), 'wkt')
  assert.equal(detectFormat('CIRCULARSTRING(0 0,1 1,2 0)'), 'wkt')
  assert.equal(detectFormat('POINTS(1 2)'), null)
  assert.equal(detectFormat('SRID=x;POINT(1 2)'), null)
})

test('lo que no es nada conocido es null, y nunca lanza', () => {
  ;[null, 12, '', new Uint8Array(0), 'hola', Uint8Array.of(0xFF, 0xD8, 0xFF)].forEach(x => assert.equal(detectFormat(x), null))
  const semillas = [zipCon('doc.kml'), shp(), wkbPunto(true, 1), enc.encode('<kml/>'), enc.encode('{"type":"Topology"}')]
  semillas.forEach((s, k) => {
    for (let n = 0; n < 200; n++) {
      const r = detectFormat(mutante(s, k, n))
      assert.ok(r === null || typeof r === 'string')
    }
  })
})
