// Semántica del lector de EsriJSON que el oráculo no cubre (DISENO-INTEROP §3.6, §1, §2.4, §2.5):
// atributos por rango, stats, CRS, opciones, profundidad, números exactos, `areasOf` y fuzz.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { readEsriJson } from '../../../src/formats/esrijson.js'
import { areasOf } from '../../../src/geojson/geojson.js'
import { ESPERADO } from './esperado.mjs'
import { fallaCon, fuzz, invariantes } from '../comun.mjs'

const raiz    = new URL('corpus/', import.meta.url)
const fixture = nombre => readFileSync(new URL(nombre, raiz), 'utf8')
const leer    = (valor, opciones) => readEsriJson(JSON.stringify(valor), opciones)
const cerca   = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} contra ${b}`)

test('propertiesOf decodifica attributes; idOf es null (D-17)', () => {
  const r = readEsriJson(fixture('felices/featureset-poligonos.json'))
  assert.deepEqual(r.propertiesOf(0), { nombre: 'Rodal 1', superficie: 12.5 })
  assert.deepEqual(r.propertiesOf(1), { nombre: 'Rodal "2"', superficie: null }, 'attributes después de geometry')
  assert.equal(r.idOf(0), null)
  assert.equal(r.propertiesOf(2), null)
  assert.equal(readEsriJson(fixture('felices/geometria-suelta.json')).propertiesOf(0), null)
  assert.deepEqual(readEsriJson(fixture('felices/feature-suelto.json')).propertiesOf(0), { OBJECTID: 1, ciudad: 'Santiago' })
  r.release()
  assert.throws(() => r.propertiesOf(0), { code: 'liberado' })
})

test('stats: huérfanos, giro contra la convención horaria, degenerados, curvas y ordenadas descartadas', () => {
  const huerfano = readEsriJson(fixture('degenerados/huerfano.json')).stats
  assert.equal(huerfano.orphanHoles, 1)
  assert.equal(huerfano.reversedRings, huerfano.orphanHoles, '§1.3: en EsriJSON reversedRings === orphanHoles')

  const anidados = readEsriJson(fixture('degenerados/hoyos-anidados.json')).stats
  assert.equal(anidados.orphanHoles, 0)
  assert.equal(anidados.reversedRings, 0)

  assert.equal(readEsriJson(fixture('degenerados/area-cero.json')).stats.degenerateRings, 1)
  assert.equal(readEsriJson(fixture('especificacion/curvas.json')).stats.skippedGeometries, 2)
  assert.equal(readEsriJson(fixture('especificacion/hasm-sin-hasz.json')).stats.extraOrdinates, 3)
  assert.equal(readEsriJson(fixture('especificacion/hasz-y-hasm.json')).stats.extraOrdinates, 5)

  const conjunto = readEsriJson(fixture('felices/featureset-poligonos.json')).stats
  assert.equal(conjunto.foreignMembers, 4, 'displayFieldName, fieldAliases, geometryType y fields')
  assert.equal(conjunto.emptyGeometries, 0)
  assert.equal(readEsriJson(fixture('degenerados/vacios.json')).stats.emptyGeometries, 3)

  const abierto = readEsriJson(fixture('degenerados/anillo-abierto.json')).stats
  assert.equal(abierto.openRings, 2)
  assert.equal(abierto.shortRings, 1)
})

test('las curvas no se llevan los features vecinos', () => {
  const r = readEsriJson(fixture('especificacion/curvas.json'))
  assert.equal(r.featureCount, 3)
  assert.deepEqual([...r.geometryAt], [0, 0, 1, 1])
  assert.deepEqual(r.propertiesOf(2), { k: 'trazo' })
})

test('CRS: wkid 102100 y 32719 salen en grados; la opción crs sólo cuando la fuente no declara (§2.5)', async () => {
  const a = 6378137
  const merc = leer({ x: 1000000, y: -4000000, spatialReference: { wkid: 102100, latestWkid: 3857 } })
  assert.equal(merc.crs, 'EPSG:3857')
  cerca(merc.xy[0], 1000000 / a * 180 / Math.PI)
  cerca(merc.xy[1], (2 * Math.atan(Math.exp(-4000000 / a)) - Math.PI / 2) * 180 / Math.PI)

  // En el meridiano central de la zona 19 y en el falso norte del hemisferio sur: (−69°, 0°).
  const utm = leer({ points: [[500000, 10000000]], spatialReference: { wkid: 32719 } })
  assert.equal(utm.crs, 'EPSG:32719')
  cerca(utm.xy[0], -69)
  cerca(utm.xy[1], 0)

  const opcion = leer({ points: [[500000, 10000000]] }, { crs: 32719 })
  assert.equal(opcion.crs, 'EPSG:32719')
  cerca(opcion.xy[0], -69)
  assert.equal(leer({ x: -70, y: -33, spatialReference: { wkid: 4326 } }, { crs: 32719 }).crs, 'EPSG:4326')

  const wkt = 'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]'
  const desdeWkt = leer({ x: -70, y: -33, spatialReference: { wkt } })
  assert.ok(desdeWkt.crs !== null)
  assert.deepEqual([...desdeWkt.xy], [-70, -33])

  assert.equal(leer({ x: -70, y: -33 }).crs, null)
  assert.equal(leer({ x: -70, y: -33, spatialReference: {} }).crs, null, 'spatialReference sin datos es no declarar')
  await fallaCon(() => leer({ x: 0, y: 0 }, { crs: 'EPSG:2000' }), 'crs', 'esrijson')
  await fallaCon(() => leer({ x: 0, y: 0 }, { crs: [] }), 'entrada', 'esrijson')
})

test('opciones inválidas y entradas que no son bytes: entrada', async () => {
  for (const opciones of [{ maxDepth: 0 }, { maxBytes: 0 }, { capacityHint: 1.5 }])
    await fallaCon(() => leer({ x: 0, y: 0 }, opciones), 'entrada', 'esrijson')
  for (const entrada of [undefined, 1, { x: 0, y: 0 }])
    await fallaCon(() => readEsriJson(entrada), 'entrada', 'esrijson')
})

test('profundidad: un attributes anidado sin fin es profundidad, también con maxDepth alto', async () => {
  const hondo = '{"attributes":' + '['.repeat(100000) + ']'.repeat(100000) + '}'
  await fallaCon(() => readEsriJson(hondo), 'profundidad', 'esrijson')
  assert.equal(readEsriJson(hondo, { maxDepth: 1e6 }).featureCount, 1)
})

test('bounds: caja por geometría', () => {
  const r = readEsriJson(fixture('especificacion/envelope.json'), { bounds: true })
  assert.deepEqual([...r.bounds], [-71, -34, -70, -33])
})

test('números exactos: paridad bit a bit con Number(texto), incluida la frontera de 31 a 34 dígitos', () => {
  let s = 777
  const azar = n => (s = (s * 1103515245 + 12345) >>> 0) % n
  const literal = digitos => {
    let t = ''
    for (let k = 0; k < digitos; k++) t += String(azar(10))
    return `${azar(2) ? '-' : ''}${azar(90)}.${t}${azar(3) ? '' : 'E+' + azar(2)}`
  }
  const textos = []
  for (let d = 1; d <= 40; d++) for (let k = 0; k < 6; k++) textos.push(literal(d))
  textos.push('0.50000000000000011102230246251565404236316680908203125')
  const r = readEsriJson(`{"points":[${textos.map(t => `[${t},${t}]`)}]}`)
  textos.forEach((t, k) => assert.ok(Object.is(r.xy[k * 2], Number(t)), `${t}: ${r.xy[k * 2]} contra ${Number(t)}`))
})

test('areasOf sirve sin cambios sobre la lectura (§5-3ter)', () => {
  const r = readEsriJson(fixture('felices/featureset-poligonos.json'))
  const { parts, rings, owner } = areasOf(r)
  assert.deepEqual([...parts], [0, 1, 2])
  assert.deepEqual([...rings], [0, 1, 2, 3])
  assert.deepEqual([...owner], [0, 0, 1])
})

test('memoria: lo retenido es función de los conteos (§5-8)', () => {
  const r = readEsriJson(fixture('felices/featureset-poligonos.json'))
  invariantes(r)
  assert.ok(r.xy.buffer.byteLength <= 16 * Math.max(32, r.vertexCount))
})

test('fuzz de mutación: sólo FormatError, misma salida en copia justa y vista envenenada', { timeout: 120000 }, async () => {
  const semillas = Object.keys(ESPERADO)
    .filter(n => !ESPERADO[n].error)
    .map(n => [n, new Uint8Array(readFileSync(new URL(n, raiz)))])
  const { leidos, rechazados } = await fuzz(readEsriJson, semillas, { casos: 150, formato: 'esrijson' })
  assert.ok(leidos > 0 && rechazados > 0, `${leidos} leídos, ${rechazados} rechazados`)
})
