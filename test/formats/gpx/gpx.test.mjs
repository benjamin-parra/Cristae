// Lector de GPX 1.1 — contrato: DISENO-INTEROP §3.2, con §1 y §2.6. Plan de §5: corpus a mano con
// citas contra el oráculo de jsdom, atributos, números exactos, formas de entrada y fuzz.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { readGpx } from '../../../src/formats/gpx.js'
import { compararTablas, esFormatError, fallaCon, formasTexto, fuzz, invariantes, mutante } from '../comun.mjs'
import { oraculoGpx } from '../xml/oraculo-xml.mjs'

const CORPUS = new URL('./corpus/', import.meta.url).pathname

const VEREDICTO = {
  'felices/completo.gpx'                : 'lectura',
  'especificacion/gpx10.gpx'            : 'lectura',
  'especificacion/lat-lon-espacios.gpx' : 'lectura',
  'degenerados/vacios.gpx'              : 'lectura',
  'adversarios/sin-lat.gpx'             : 'posicion',
  'adversarios/lat-texto.gpx'           : 'numero',
  'adversarios/lat-infinita.gpx'        : 'numero',
  'adversarios/ele-vacio.gpx'           : 'numero',
  'adversarios/dtd.gpx'                 : 'dtd',
  'adversarios/raiz-kml.gpx'            : 'formato',
  'adversarios/truncado.gpx'            : 'truncado',
}

const STATS_DEL_ORACULO = ['openRings', 'shortRings', 'degenerateRings', 'reversedRings', 'extraOrdinates',
  'emptyGeometries', 'foreignMembers', 'skippedGeometries']

const bytesDe  = ruta => new Uint8Array(readFileSync(join(CORPUS, ruta)))
const fixtures = readdirSync(CORPUS, { recursive: true }).filter(r => r.endsWith('.gpx')).sort()

describe('GPX: corpus', () => {
  test('cada fixture tiene veredicto y cita', () => {
    assert.deepEqual(fixtures, Object.keys(VEREDICTO).sort())
    fixtures.forEach(r => assert.match(readFileSync(join(CORPUS, r), 'utf8'), /<!--[^]*(§|gpx\.xsd)/, `${r} sin cita`))
  })

  fixtures.forEach(ruta => test(ruta, async () => {
    const veredicto = VEREDICTO[ruta]
    const bytes     = bytesDe(ruta)
    if (veredicto !== 'lectura') return fallaCon(() => readGpx(bytes), veredicto, 'gpx')
    const lectura  = readGpx(bytes)
    const esperado = oraculoGpx(new TextDecoder().decode(bytes))
    invariantes(lectura)
    compararTablas(lectura, esperado)
    assert.deepEqual(lectura.layers, esperado.layers)
    STATS_DEL_ORACULO.forEach(k => assert.equal(lectura.stats[k], esperado.stats[k], `stats.${k}`))
  }))

  test('la raíz kml da formato con hint', async () => {
    const e = await fallaCon(() => readGpx(bytesDe('adversarios/raiz-kml.gpx')), 'formato')
    assert.equal(e.hint, 'kml')
  })
})

describe('GPX: mapeo (§3.2)', () => {
  const r = readGpx(bytesDe('felices/completo.gpx'))

  test('wpt es Point, rte LineString y trk MultiLineString con una parte por trkseg', () => {
    assert.deepEqual(Array.from(r.kinds), [1, 1, 3, 4])
    assert.deepEqual(Array.from(r.partAt), [0, 1, 2, 3, 5])
    assert.deepEqual(Array.from(r.xy.subarray(0, 2)), [-72.5, -37.25])
    assert.equal(r.z[0], 310.5)
    assert.ok(Number.isNaN(r.z[1]))
  })

  test('propertiesOf: los presentes de name, cmt, desc, src, type, number y link', () => {
    assert.deepEqual(r.propertiesOf(0), {
      name: 'Mirador & torre', cmt: 'c', desc: '<i>alto</i>', src: 'GPS', type: 'torre',
      link: 'https://ejemplo.invalid/a?x=1&y=2',
    })
    assert.deepEqual(r.propertiesOf(1), {})
    assert.deepEqual(r.propertiesOf(2), { name: 'Ruta 5', number: 5 })
    assert.deepEqual(r.propertiesOf(3), { name: 'Huella' })
  })

  test('idOf es null; una sola capa; format y crs', () => {
    assert.equal(r.idOf(0), null)
    assert.deepEqual(r.layers, [{ name: null, parent: -1 }])
    assert.deepEqual(Array.from(r.layerOf), [0, 0, 0, 0])
    assert.equal(r.format, 'gpx')
    assert.equal(r.crs, 'EPSG:4326')
  })

  test('el rango de latitud no se valida (§3.2, como GeoJSON)', () => {
    assert.deepEqual(Array.from(readGpx('<gpx><wpt lat="95" lon="200"/></gpx>').xy), [200, 95])
  })

  test('un number que no es número no decodifica: properties', async () => {
    const roto = readGpx('<gpx><rte><number>cinco</number></rte></gpx>')
    await fallaCon(() => roto.propertiesOf(0), 'properties', 'gpx')
  })
})

describe('GPX: números exactos (§5-4)', () => {
  test('paridad bit a bit con Number(texto) en lat, lon y ele', () => {
    const tokens = ['0.1', '-33.123456789012345678901234567890123', '1.7976931348623157e308', '5e-324',
      '72.99999999999999999999999999999999', '+.5', '5.', '123456789012345678901234567890.5', '-0', '0.30000000000000004']
    const doc = tokens.map(t => `<wpt lat="${t}" lon="${t}"><ele>${t}</ele></wpt>`).join('')
    const r   = readGpx(`<gpx>${doc}</gpx>`)
    tokens.forEach((t, k) => {
      assert.ok(Object.is(r.xy[k * 2], Number(t)), t)
      assert.ok(Object.is(r.xy[k * 2 + 1], Number(t)), t)
      assert.ok(Object.is(r.z[k], Number(t)), t)
    })
  })
})

describe('GPX: formas de entrada (§17.3-6, §17.8)', () => {
  test('string, ArrayBuffer, Uint8Array y Buffer pooled dan la misma lectura', () => {
    const texto = '﻿' + readFileSync(join(CORPUS, 'felices/completo.gpx'), 'utf8')
    const [[, base], ...resto] = formasTexto(texto).map(([nombre, entrada]) => [nombre, readGpx(entrada)])
    resto.forEach(([nombre, r]) => {
      compararTablas(r, base)
      assert.deepEqual(r.propertiesOf(0), base.propertiesOf(0), nombre)
    })
  })

  test('opciones inválidas son entrada', async () => {
    await fallaCon(() => readGpx('<gpx/>', { maxDepth: 1.5 }), 'entrada', 'gpx')
    await fallaCon(() => readGpx({}), 'entrada', 'gpx')
  })
})

describe('GPX: fuzz de mutación (§5-6)', () => {
  const semillas = fixtures.filter(r => VEREDICTO[r] === 'lectura').map(r => [r, bytesDe(r)])

  test('sólo FormatError y la vista envenenada no cambia nada', { timeout: 120000 }, async () => {
    const { leidos, rechazados } = await fuzz(readGpx, semillas, { casos: 120, formato: 'gpx' })
    assert.ok(leidos > 0 && rechazados > 0, `${leidos} leídos, ${rechazados} rechazados`)
  })

  test('propertiesOf sobre los mutantes legibles sólo lanza FormatError', () => {
    semillas.forEach(([nombre, bytes]) => {
      for (let n = 0; n < 120; n++) {
        let leido = null
        try { leido = readGpx(mutante(bytes, 0xB0B, n)) } catch { continue }
        for (let f = 0; f < leido.featureCount; f++) {
          try { leido.propertiesOf(f) } catch (e) { assert.ok(esFormatError(e), `${nombre} #${n}: ${e?.stack ?? e}`) }
        }
      }
    })
  })
})
