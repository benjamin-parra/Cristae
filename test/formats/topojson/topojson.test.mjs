// Semántica del lector de TopoJSON que el oráculo no cubre (DISENO-INTEROP §3.5, §1): atributos por
// rango, stats, opciones, amplificación, profundidad, números exactos, `areasOf` y fuzz.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { readTopoJson } from '../../../src/formats/topojson.js'
import { areasOf } from '../../../src/geojson/geojson.js'
import { oraculo } from './oraculo.mjs'
import { ESPERADO } from './esperado.mjs'
import { compararTablas, fallaCon, fuzz, invariantes } from '../comun.mjs'

const raiz    = new URL('corpus/', import.meta.url)
const fixture = nombre => readFileSync(new URL(nombre, raiz), 'utf8')
const topo    = (objects, arcs = [], extra = {}) => JSON.stringify({ type: 'Topology', ...extra, objects, arcs })

test('propertiesOf e idOf decodifican el rango del objeto que es feature (§1.2)', () => {
  const r = readTopoJson(fixture('felices/capas.json'))
  assert.deepEqual(r.propertiesOf(0), { nombre: 'Ñuble' })
  assert.equal(r.idOf(0), 7)
  assert.equal(r.propertiesOf(1), null, 'sin miembro: par vacío')
  assert.equal(r.propertiesOf(2), null, '`properties: null`')
  assert.equal(r.idOf(3), 'lim')
  assert.equal(r.propertiesOf(99), null, 'fuera de rango')

  const anidada = readTopoJson(fixture('degenerados/coleccion-anidada.json'))
  assert.deepEqual(anidada.propertiesOf(0), { nivel: 1 }, 'las properties de una hoja anidada no son del feature')

  r.release()
  assert.throws(() => r.propertiesOf(0), { code: 'liberado' })
})

test('un rango de properties que no decodifica es properties', () => {
  // Un string con un sustituto suelto es JSON válido y válido para el escáner; un rango corrido no.
  const r = readTopoJson(topo({ a: { type: 'Point', coordinates: [0, 0], properties: { a: 1 } } }))
  r.propAt[1] -= 2
  assert.throws(() => r.propertiesOf(0), { name: 'FormatError', code: 'properties' })
})

test('stats: lo que se cuenta sin corregir', () => {
  const abierto = readTopoJson(fixture('degenerados/anillo-abierto.json')).stats
  assert.equal(abierto.openRings, 1)
  assert.equal(abierto.shortRings, 2)

  assert.equal(readTopoJson(fixture('degenerados/con-z.json')).stats.extraOrdinates, 2)
  assert.equal(readTopoJson(fixture('degenerados/vacios.json')).stats.emptyGeometries, 4)

  // Exterior horario: viola la convención antihoraria de RFC 7946 (§1.3).
  const horario = readTopoJson(topo({ a: { type: 'Polygon', arcs: [[0]] } }, [[[0, 0], [0, 1], [1, 1], [0, 0]]]))
  assert.equal(horario.stats.reversedRings, 1)

  const ajenos = readTopoJson(topo({ a: { type: 'Point', coordinates: [0, 0], estilo: { color: 1 } } }, [], {
    nombre: 'x', bbox: Array.from({ length: 40 }, (_, k) => k + 0.123456),
  })).stats
  assert.equal(ajenos.foreignMembers, 2)
  assert.equal(ajenos.bboxSkipped, 1)
  assert.equal(ajenos.roots, 1)

  // 17 dígitos: la mantisa pasa de 2^53 y el número sale del camino de Clinger (SPECS §17.5).
  const lento = '{"type":"Topology","objects":{"a":{"type":"Point","coordinates":[0.12345678901234567,0]}},"arcs":[]}'
  assert.equal(readTopoJson(lento).stats.slowNumbers, 1)
})

test('opción object: lee sólo esa capa', async () => {
  const texto = fixture('felices/capas.json')
  const r = readTopoJson(texto, { object: 'limites' })
  compararTablas(r, oraculo(texto, { object: 'limites' }))
  assert.deepEqual(r.layers, [{ name: 'limites', parent: -1 }])
  assert.equal(r.idOf(0), 'lim')
  await fallaCon(() => readTopoJson(texto, { object: 'otro' }), 'formato', 'topojson')
  await fallaCon(() => readTopoJson(texto, { object: 3 }), 'entrada', 'topojson')
})

test('sin opción crs se asume lon/lat WGS84 y se declara; fuera de rango avisa y no falla (§20.5)', async () => {
  const r = readTopoJson(topo({ p: { type: 'Point', coordinates: [-72.5, -36.5] } }))
  assert.equal(r.crs, 'EPSG:4326')
  assert.deepEqual(Array.from(r.xy), [-72.5, -36.5])
  assert.deepEqual(r.warnings, [])
  const fuera = readTopoJson(topo({ p: { type: 'Point', coordinates: [500000, 6000000] } }))
  assert.equal(fuera.crs, 'EPSG:4326')
  assert.deepEqual(Array.from(fuera.xy), [500000, 6000000])
  assert.equal(fuera.warnings.length, 1)
  assert.equal(fuera.warnings[0].code, 'crs')
  assert.match(fuera.warnings[0].detail, /no parecen grados; declare options\.crs/)
  // Un `options.crs` inválido sigue siendo error.
  await fallaCon(() => readTopoJson(topo({ p: { type: 'Point', coordinates: [500000, 6000000] } }), { crs: 'EPSG:99999' }), 'crs', 'topojson')
  // Declararlo explícito es la misma lectura: la fuente sigue en grados.
  assert.equal(readTopoJson(topo({ p: { type: 'Point', coordinates: [-72.5, -36.5] } }), { crs: 4326 }).crs, 'EPSG:4326')
})

test('opción crs: una topología en UTM 19S sale en grados y declara su CRS', () => {
  const r = readTopoJson(topo({ p: { type: 'Point', coordinates: [500000, 10000000] } }), { crs: 32719 })
  assert.equal(r.crs, 'EPSG:32719')
  assert.ok(Math.abs(r.xy[0] + 69) < 1e-9 && Math.abs(r.xy[1]) < 1e-9, String(Array.from(r.xy)))
})

test('opción crs: una topología proyectada en 3857 sale en grados (§1.5, §2.5)', async () => {
  const a = 6378137, x = 1000000, y = -4000000
  const r = readTopoJson(topo({ p: { type: 'Point', coordinates: [x, y] } }), { crs: 'EPSG:3857' })
  assert.equal(r.crs, 'EPSG:3857')
  assert.ok(Math.abs(r.xy[0] - x / a * 180 / Math.PI) < 1e-9)
  assert.ok(Math.abs(r.xy[1] - (2 * Math.atan(Math.exp(y / a)) - Math.PI / 2) * 180 / Math.PI) < 1e-9)
  await fallaCon(() => readTopoJson(topo({}), { crs: 2000 }), 'crs', 'topojson')
  await fallaCon(() => readTopoJson(topo({}), { crs: {} }), 'entrada', 'topojson')
})

test('opciones inválidas y entradas que no son bytes: entrada', async () => {
  for (const opciones of [{ maxDepth: 0 }, { maxDepth: 1.5 }, { maxBytes: -1 }, { capacityHint: -1 }])
    await fallaCon(() => readTopoJson(topo({}), opciones), 'entrada', 'topojson')
  for (const entrada of [null, 3, {}, [1]])
    await fallaCon(() => readTopoJson(entrada), 'entrada', 'topojson')
})

test('bounds: caja por geometría', () => {
  const r = readTopoJson(fixture('felices/poligonos-compartidos.json'), { bounds: true })
  assert.deepEqual([...r.bounds], [10, 20, 11, 24, 11, 20, 12, 24])
})

test('amplificación: un arco referido muchas veces es tope antes de reservar (§1.6-3)', async () => {
  const arco  = [Array.from({ length: 1000 }, (_, k) => [k % 2, 0])]
  const refs  = Array.from({ length: 2000 }, () => 0)
  const texto = topo({ a: { type: 'LineString', arcs: refs } }, arco)
  await fallaCon(() => readTopoJson(texto, { maxBytes: 1 << 20 }), 'tope', 'topojson')

  // Con el tope por defecto (256 MiB): 2·10⁹ posiciones desde unos 400 KB de índices.
  const largo = [Array.from({ length: 10000 }, () => [0, 0])]
  const bomba = topo({ a: { type: 'LineString', arcs: Array.from({ length: 200000 }, () => 0) } }, largo)
  await fallaCon(() => readTopoJson(bomba), 'tope', 'topojson')

  // La misma forma bajo el tope se lee: el tope es una cota, no una acusación.
  assert.equal(readTopoJson(texto).vertexCount, 1000 + 1999 * 999)
})

test('profundidad: colecciones anidadas 100 mil niveles son profundidad, también con maxDepth alto', async () => {
  const n = 100000
  const texto = '{"type":"Topology","arcs":[],"objects":{"a":' +
    '{"type":"GeometryCollection","geometries":['.repeat(n) + ']}'.repeat(n) + '}}'
  await fallaCon(() => readTopoJson(texto), 'profundidad', 'topojson')
  await fallaCon(() => readTopoJson(texto, { maxDepth: 1e7 }), 'profundidad', 'topojson')
  // Un miembro ajeno anidado también se mide.
  await fallaCon(() => readTopoJson(topo({}, [], { x: JSON.parse('['.repeat(600) + ']'.repeat(600)) })), 'profundidad', 'topojson')
})

test('números exactos: paridad bit a bit con Number(texto), incluida la frontera de 31 a 34 dígitos', () => {
  let s = 12345
  const azar = n => (s = (s * 1103515245 + 12345) >>> 0) % n
  const literal = digitos => {
    let t = ''
    for (let k = 0; k < digitos; k++) t += String(azar(10))
    return `${azar(2) ? '-' : ''}${azar(90)}.${t}${azar(3) ? '' : 'e-' + azar(5)}`
  }
  const textos = []
  for (let d = 1; d <= 40; d++) for (let k = 0; k < 6; k++) textos.push(literal(d))
  // Empates exactos: el redondeo correcto exige la delegación en Number (SPECS §17.5).
  textos.push('0.50000000000000011102230246251565404236316680908203125', '89.999999999999999999999999999999999')

  const posiciones = textos.map((t, k) => `[${t},${textos[(k + 1) % textos.length]}]`)
  const texto = `{"type":"Topology","objects":{"a":{"type":"MultiPoint","coordinates":[${posiciones}]}},"arcs":[[${posiciones}]]}`
  const r = readTopoJson(texto)
  textos.forEach((t, k) => {
    assert.ok(Object.is(r.xy[k * 2], Number(t)), `${t}: ${r.xy[k * 2]} contra ${Number(t)}`)
    assert.ok(Object.is(r.xy[k * 2 + 1], Number(textos[(k + 1) % textos.length])))
  })
})

test('areasOf sirve sin cambios sobre la lectura (§5-3ter)', () => {
  const r = readTopoJson(fixture('felices/capas.json'))
  const { parts, rings, owner } = areasOf(r)
  assert.deepEqual([...parts], [3, 4])
  assert.deepEqual([...rings], [3, 4, 5])
  assert.equal(owner[3], 3)
  assert.equal(owner[4], 3)
})

test('memoria: lo retenido es función de los conteos, no del documento (§5-8)', () => {
  const texto = fixture('felices/capas.json')
  const r = readTopoJson(texto)
  invariantes(r)
  // `xy` se dimensiona con el total de posiciones que la fase 2 suma antes de reservar.
  assert.ok(r.xy.buffer.byteLength <= 16 * Math.max(32, r.vertexCount))
  assert.equal(r.bytes.length, new TextEncoder().encode(texto).length)
})

test('fuzz de mutación: sólo FormatError, misma salida en copia justa y vista envenenada', { timeout: 120000 }, async () => {
  const semillas = Object.keys(ESPERADO)
    .filter(n => !ESPERADO[n].error)
    .map(n => [n, new Uint8Array(readFileSync(new URL(n, raiz)))])
  const { leidos, rechazados } = await fuzz(readTopoJson, semillas, { casos: 150, formato: 'topojson' })
  assert.ok(leidos > 0 && rechazados > 0, `${leidos} leídos, ${rechazados} rechazados`)
})

